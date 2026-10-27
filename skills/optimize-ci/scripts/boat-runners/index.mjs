// GitHub Actions runners on Boat sandboxes. One function, three entry points:
//   - function URL: the GitHub App's workflow_job webhook. A queued job on a
//     boat-* label goes to SQS after a short grace, so an idle runner gets
//     first claim on it.
//   - SQS: a job still queued with no idle runner of its size starts one
//     reusable runner. A job that sees an idle runner is rechecked later, and
//     a Boat start-limit or capacity error is retried, both through SQS.
//   - schedule: keep each size's always-on baseline, replace old idle
//     baseline runners (rolls out snapshot changes), and drop registrations
//     whose sandbox is gone.
// Runners are reused across jobs, so a sandbox's disk, git objects and
// package caches stay warm; burst runners stop themselves after IDLE seconds
// without a job. Same shape as philips-labs/terraform-aws-github-runner's
// reusable-runner mode, with Boat in place of EC2.
import { createHmac, createSign, timingSafeEqual } from "node:crypto";

// The AWS SDK ships in the Lambda runtime, not in this repo; import it lazily
// so the pure functions are testable without it.
const sdk = (name) => import(`@aws-sdk/${name}`);

const BOAT_API = "https://boat.dev/api/v1";
const GITHUB_API = "https://api.github.com";

// Runner label -> Boat machine type. Each size also has a `-once` label: a
// fresh sandbox that runs one job and is erased. Jobs holding deploy
// credentials use it, so they never run on a machine a PR job has touched.
export const SIZES = Object.fromEntries(
  Object.entries({
    "boat-2vcpu": "small",
    "boat-4vcpu": "default",
    "boat-8vcpu": "large",
    "boat-16vcpu": "xlarge",
  }).flatMap(([label, type]) => [
    [label, type],
    [`${label}-once`, type],
  ])
);
const PREFIX = "gh-";

// The scheduled runner-snapshot workflow (runner-snapshot.yml) runs on this
// label: one sandbox from the clean snapshot does the heavy jobs' setup
// (toolchains, dependencies, docker images), then saves itself as
// `<SNAPSHOT>-warm`, which reused runners start from. Every runner starts
// from that disk, so only a run on the default branch can claim it; -once
// labels keep the clean snapshot.
export const SNAPSHOT_LABEL = "boat-snapshot";
export const DEFAULT_BRANCH = "main";
export const SNAPSHOT_WORKFLOW = ".github/workflows/runner-snapshot.yml";
export const warmSnapshotName = (snapshot) => `${snapshot}-warm`;

export function boatLabel(labels) {
  return labels.find((label) => label in SIZES) ?? null;
}

// The label the controller serves a job on, or null.
export function jobLabel(job) {
  const labels = job?.labels ?? [];
  if (labels.includes(SNAPSHOT_LABEL)) {
    return job.head_branch === DEFAULT_BRANCH ? SNAPSHOT_LABEL : null;
  }
  return boatLabel(labels);
}

// GitHub gives a runner any queued job with its label, so a PR workflow that
// asks for SNAPSHOT_LABEL could take the build runner and save its own disk
// for every runner. The build starts only while no such job waits.
export function untrustedSnapshotJobs(jobs) {
  return jobs.filter(
    (job) =>
      job.status === "queued" &&
      (job.labels ?? []).includes(SNAPSHOT_LABEL) &&
      jobLabel(job) === null
  );
}

// The run a snapshot job belongs to must be the default branch's own
// schedule or dispatch of SNAPSHOT_WORKFLOW in this repository: head_branch
// alone matches a fork's branch of the same name. The build runner's
// job-started hook checks the same.
export function trustedSnapshotRun(run, repo) {
  return (
    ["schedule", "workflow_dispatch"].includes(run?.event) &&
    run.path === SNAPSHOT_WORKFLOW &&
    run.head_branch === DEFAULT_BRANCH &&
    run.head_repository?.full_name === repo
  );
}

// Which snapshot a new runner starts from.
export function runnerSource(label, env) {
  if (label === SNAPSHOT_LABEL || label.endsWith("-once")) return env.SNAPSHOT;
  return env.WARM_SNAPSHOT || env.SNAPSHOT;
}

export function verifySignature(secret, rawBody, header) {
  if (!header?.startsWith("sha256=")) {
    return false;
  }
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`
  );
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Sandbox names carry the label and whether the runner is part of the
// always-on baseline: gh-boat-8vcpu-base-bx_… or gh-boat-8vcpu-burst-bx_….
export function sandboxName(label, kind, id) {
  return `${PREFIX}${label}-${kind}-${id}`;
}

export function parseSandboxName(name) {
  const match = /^gh-(boat-\d+vcpu(?:-once)?)-(base|burst)-/.exec(name ?? "");
  return match ? { label: match[1], kind: match[2] } : null;
}

export function idleRunners(runners, label) {
  return runners.filter(
    (runner) =>
      runner.status === "online" &&
      !runner.busy &&
      runner.labels.some((l) => l.name === label)
  );
}

// Offline registrations of ours whose sandbox no longer runs. A runner only
// registers once its sandbox is up, so a booting runner is never offline.
export function staleRunner(runner, liveSandboxIds) {
  return (
    runner.status === "offline" &&
    runner.name.startsWith("bx_") &&
    runner.labels.some((l) => l.name in SIZES || l.name === SNAPSHOT_LABEL) &&
    !liveSandboxIds.has(runner.name)
  );
}

// Whether `now` falls in a UTC hour window such as "22-6" (22:00 through
// 05:59, wrapping midnight). An empty window means always.
export function inHourWindow(window, now = new Date()) {
  if (!window) {
    return true;
  }
  const [start, end] = window.split("-").map(Number);
  const hour = now.getUTCHours();
  return start <= end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

// How long a burst runner waits for its next job. In working hours a runner
// that has seen work stays warm through gaps between pushes, which is cheaper
// than an always-on pool; off hours it stops soon after its last job.
export function burstIdleSeconds(env, now = new Date()) {
  return inHourWindow(env.BASELINE_HOURS_UTC, now)
    ? Number(env.IDLE_SECONDS ?? 1800)
    : Number(env.IDLE_SECONDS_OFF_HOURS ?? 300);
}

// Boat's auto-stop counts from creation, so the safety TTL is the machine's
// age plus a margin, refreshed every schedule tick.
export const SAFETY_TTL_SECONDS = 1800;
export function safetyTtl(
  createdAt,
  now = Date.now(),
  margin = SAFETY_TTL_SECONDS
) {
  return Math.ceil((now - Date.parse(createdAt)) / 1000) + margin;
}

// Runner sandboxes with no registered runner after boot: the runner died, or
// Boat restored the machine onto a new host (processes gone, setup script not
// rerun). The safety TTL would keep them alive, so they're stopped instead.
export const ORPHAN_AFTER_MS = 10 * 60_000;
export function orphanSandboxes(live, runners, now = Date.now()) {
  const registered = new Set(runners.map((runner) => runner.name));
  return live.filter(
    (sandbox) =>
      parseSandboxName(sandbox.name) &&
      !registered.has(sandbox.id) &&
      now - Date.parse(sandbox.createdAt) > ORPHAN_AFTER_MS
  );
}

// Queued jobs on our labels whose webhook we probably missed: GitHub drops
// some and never redelivers one that got an error. A job's message lives
// about 30 minutes (90 receives, 20 s apart), so a job still queued gets a
// new one once per 30 minutes, in one 2-minute schedule slot. Requeueing on
// every pass gave each waiting job a fresh start budget every 2 minutes and
// kept GitHub's rate limit pinned while Boat's daily starts ran out.
export const MISSED_AFTER_MS = 5 * 60_000;
export const REQUEUE_EVERY_MS = 30 * 60_000;
const SCHEDULE_MS = 2 * 60_000;
export function missedJobs(jobs, now = Date.now()) {
  return jobs.filter((job) => {
    const waited = now - Date.parse(job.created_at) - MISSED_AFTER_MS;
    return (
      job.status === "queued" &&
      jobLabel(job) &&
      waited > 0 &&
      waited % REQUEUE_EVERY_MS < SCHEDULE_MS
    );
  });
}

// A reused runner that has run this long exits at its next idle moment, so
// a job that breaks the machine (system packages, disk) cannot fail the jobs
// after it for days.
export const MAX_RUNNER_AGE_SECONDS = 6 * 3600;

// Baseline sandboxes to stop: idle ones past their age (rolls out snapshot
// and boot-script changes) and idle ones beyond the current target (the
// baseline drains outside its hour window). A busy runner is never chosen.
export function baselineToRetire(
  baseline,
  runners,
  { now = Date.now(), maxAgeMs = 6 * 3_600_000, target = Infinity } = {}
) {
  const byName = new Map(runners.map((runner) => [runner.name, runner]));
  const idle = baseline
    .filter((sandbox) => {
      const runner = byName.get(sandbox.id);
      return runner?.status === "online" && !runner.busy;
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const old = idle.filter((s) => now - Date.parse(s.createdAt) > maxAgeMs);
  const excess = idle.slice(0, Math.max(0, baseline.length - target));
  return [...new Set([...old, ...excess])];
}

// What a sandbox runs when it is ready: register a reusable runner and take
// jobs (a `-once` label registers an ephemeral runner, which exits after its
// first job). With idleSeconds > 0 the runner shuts down after that long without a
// job, and the sandbox stops itself (created without snapshots, a stopped
// sandbox is erased). The controller then deletes the offline registration.
export function runnerScript(
  repo,
  label,
  idleSeconds,
  snapshot = "",
  maxAgeSeconds = MAX_RUNNER_AGE_SECONDS
) {
  const build = label === SNAPSHOT_LABEL;
  const ephemeral = label.endsWith("-once") || build ? " --ephemeral" : "";
  // GitHub hands a runner any queued job its labels match, and every reused
  // runner boots from the build's disk. So the build runner has no default
  // labels (self-hosted, Linux, X64), and its hook fails any job that is not
  // the default branch's schedule or dispatch of SNAPSHOT_WORKFLOW before a
  // step runs, so such a job can never write the marker.
  const labels = build ? `${label} --no-default-labels` : label;
  const trust = build
    ? `case "\${GITHUB_EVENT_NAME:-}" in schedule|workflow_dispatch) ;; *) echo "snapshot build: refusing event \${GITHUB_EVENT_NAME:-}" >&2; exit 1 ;; esac
[ "\${GITHUB_REPOSITORY:-}" = "${repo}" ] && [ "\${GITHUB_WORKFLOW_REF:-}" = "${repo}/${SNAPSHOT_WORKFLOW}@refs/heads/${DEFAULT_BRANCH}" ] || { echo "snapshot build: refusing \${GITHUB_WORKFLOW_REF:-unknown}" >&2; exit 1; }
`
    : "";
  // The snapshot build saves its disk only after its job wrote the success
  // marker, without this runner's registration, logs or job temp files.
  const finish = build
    ? `if [ -f ~/snapshot-ready ]; then
  rm -rf ~/snapshot-ready ~/runner.log .runner .credentials .credentials_rsaparams _diag _work/_temp
  ~/.ascii/boat snapshot "$BOAT_ID" ${warmSnapshotName(snapshot)}
fi
~/.ascii/boat stop "$BOAT_ID"`
    : `~/.ascii/boat stop "$BOAT_ID"`;
  return `set -u
# oxlint (and other mmap-pool allocators) reserve more virtual memory than
# RAM + swap on the small sizes, which the default heuristic refuses.
sudo -n sysctl -q -w vm.overcommit_memory=1 2>/dev/null || true
# Before each job, clear the last job's untracked files but keep its
# node_modules and turbo cache: jobs check out with clean: false, so a reused
# runner's install is a quick reconcile instead of a cold install.
cat > ~/job-started.sh <<'HOOK'
#!/usr/bin/env bash
${trust}ws="\${GITHUB_WORKSPACE:-}"
[ -d "$ws/.git" ] && git -C "$ws" clean -ffdxq -e node_modules -e .turbo || true
# The last job's containers and temp outputs (one job runs at a time, and
# nothing else runs on the machine). Jobs write temp outputs under $TMPDIR/ci-*.
docker ps -aq | xargs -r docker rm -f >/dev/null 2>&1 || true
rm -rf "\${TMPDIR:-/tmp}"/ci-* 2>/dev/null || true
HOOK
chmod +x ~/job-started.sh
export ACTIONS_RUNNER_HOOK_JOB_STARTED=~/job-started.sh
cd ~/actions-runner
# Jobs get the locale GitHub-hosted runners use (Boat's default sorts differently).
printf 'LANG=C.UTF-8\nLC_ALL=C.UTF-8\n' >> .env
# The snapshot's disk arrives lazily; a job started before it is local runs
# slower. Register only once the sandbox reports hydrated (bounded wait).
for _ in $(seq 1 150); do
  [ "$(~/.ascii/boat info "$BOAT_ID" --json 2>/dev/null | jq -r '.sandbox.hydrated // empty' 2>/dev/null)" = true ] && break
  sleep 2
done
./config.sh --unattended --url "https://github.com/${repo}" --token "$GH_REG" \\
  --name "$BOAT_ID" --labels ${labels} --replace${ephemeral} > ~/runner.log 2>&1
# The registration token can register a runner with any label, including a
# -once one that deploy jobs trust. Boat puts it in this process's
# environment, so replace this process with one that never had it: the
# listener and every job descend from that one.
cat > ~/runner-loop.sh <<'LOOP'
cd ~/actions-runner
./run.sh >> ~/runner.log 2>&1 &
runner=$!
born=$(date +%s)
last=$born
while kill -0 $runner 2>/dev/null; do
  # This runner's worker only: a runner can itself run inside a CI job.
  busy=0
  pgrep -f "$HOME/actions-runner/bin/Runner.Worker" >/dev/null && { busy=1; last=$(date +%s); }
  if [ ${idleSeconds} -gt 0 ] && [ $(( $(date +%s) - last )) -ge ${idleSeconds} ]; then
    kill -TERM $runner; wait $runner; break
  fi
  if [ $busy = 0 ] && [ $(( $(date +%s) - born )) -ge ${maxAgeSeconds} ]; then
    kill -TERM $runner; wait $runner; break
  fi
  sleep 2
done
${finish}
LOOP
exec env -u GH_REG bash ~/runner-loop.sh
`;
}

// ---- clients ---------------------------------------------------------------

let secrets;
async function loadSecrets() {
  if (!secrets) {
    const { GetSecretValueCommand, SecretsManagerClient } = await sdk(
      "client-secrets-manager"
    );
    const value = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: process.env.SECRET_ARN })
    );
    secrets = JSON.parse(value.SecretString);
  }
  return secrets;
}

function appJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

let installationToken = { value: "", expires: 0 };
async function github(path, init = {}) {
  const { APP_PRIVATE_KEY } = await loadSecrets();
  if (Date.now() > installationToken.expires - 300_000) {
    const response = await fetch(
      `${GITHUB_API}/app/installations/${process.env.INSTALLATION_ID}/access_tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${appJwt(process.env.APP_ID, APP_PRIVATE_KEY)}`,
          accept: "application/vnd.github+json",
        },
      }
    );
    if (!response.ok) {
      throw new Error(`GitHub installation token: HTTP ${response.status}`);
    }
    const body = await response.json();
    installationToken = {
      value: body.token,
      expires: Date.parse(body.expires_at),
    };
  }
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${installationToken.value}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub ${init.method ?? "GET"} ${path}: HTTP ${response.status}`
    );
  }
  return response.status === 204 ? null : response.json();
}

async function boat(path, init = {}) {
  const { BOAT_API_KEY } = await loadSecrets();
  const response = await fetch(`${BOAT_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${BOAT_API_KEY}`,
      "content-type": "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  // Codes only; keep logs terse.
  if (!response.ok) {
    throw new Error(
      `Boat ${init.method ?? "GET"} ${path}: HTTP ${response.status} ${body.error?.code ?? body.code ?? ""}`
    );
  }
  return body;
}

async function listRunners(repo) {
  const runners = [];
  for (let page = 1; ; page += 1) {
    const batch = (
      await github(`/repos/${repo}/actions/runners?per_page=100&page=${page}`)
    ).runners;
    runners.push(...batch);
    if (batch.length < 100) {
      return runners;
    }
  }
}

async function startRunner(label, kind) {
  const build = label === SNAPSHOT_LABEL;
  const repo = process.env.REPOSITORY;
  const { token } = await github(
    `/repos/${repo}/actions/runners/registration-token`,
    {
      method: "POST",
    }
  );
  const idle = kind === "base" || build ? 0 : burstIdleSeconds(process.env);
  const body = await boat("/sandboxes", {
    method: "POST",
    body: JSON.stringify({
      from: runnerSource(label, process.env),
      type: build ? "xlarge" : SIZES[label],
      // Only the build saves a snapshot; a stopped build sandbox keeps its
      // disk for Boat's retention window, then Boat deletes it.
      snapshots: build,
      // A deadline from creation; the schedule pushes it forward every tick, so
      // machines stop by themselves if the controller dies. The build's name
      // is not a runner name, so its hour is a hard cap.
      ttlSeconds: build ? 3600 : SAFETY_TTL_SECONDS,
      setupScript: runnerScript(repo, label, idle, process.env.SNAPSHOT),
      env: { GH_REG: token },
    }),
  });
  const id = body.sandbox.id;
  await boat(`/sandboxes/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: sandboxName(label, kind, id) }),
  });
  console.log(
    JSON.stringify({ event: "runner.started", label, kind, sandbox: id })
  );
  return id;
}

// ---- handlers --------------------------------------------------------------

async function onWebhook(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : (event.body ?? "");
  const { WEBHOOK_SECRET } = await loadSecrets();
  if (
    !verifySignature(
      WEBHOOK_SECRET,
      raw,
      event.headers?.["x-hub-signature-256"]
    )
  ) {
    return { statusCode: 401, body: "bad signature" };
  }
  if (event.headers?.["x-github-event"] !== "workflow_job") {
    return { statusCode: 204 };
  }
  const payload = JSON.parse(raw);
  const label = jobLabel(payload.workflow_job);
  if (
    payload.action !== "queued" ||
    !label ||
    payload.repository?.full_name !== process.env.REPOSITORY
  ) {
    return { statusCode: 204 };
  }
  await sendJob(
    { jobId: payload.workflow_job.id, label },
    Number(process.env.GRACE_SECONDS ?? 10)
  );
  return { statusCode: 202 };
}

// What to do with a queued job. A runner started for it can be taken by
// another job with the same label (a -once runner takes exactly one), so the
// job is watched until it leaves the queue: once its runner has had
// bootSeconds to register, another starts, up to maxStarts; after that it
// stays on the queue until SQS moves it to the DLQ, which alarms.
export function nextStep(
  { queued, idle, startedAt = 0, starts = 0, now = Date.now() },
  { bootSeconds = 120, maxStarts = 3 } = {}
) {
  if (!queued) return "done";
  if (idle > 0) return "recheck";
  if (startedAt && now - startedAt < bootSeconds * 1000) return "recheck";
  if (starts >= maxStarts) return "recheck";
  return "start";
}

async function sendJob(message, delaySeconds) {
  const { SendMessageCommand, SQSClient } = await sdk("client-sqs");
  await new SQSClient({}).send(
    new SendMessageCommand({
      QueueUrl: process.env.QUEUE_URL,
      MessageBody: JSON.stringify(message),
      DelaySeconds: delaySeconds,
    })
  );
}

// Returns true when the job should be looked at again: the message then stays
// on the queue, and SQS hands it back after the visibility timeout.
async function queuedJobs(repo) {
  const runs =
    (await github(`/repos/${repo}/actions/runs?status=queued&per_page=50`))
      .workflow_runs ?? [];
  const jobs = [];
  for (const run of runs) {
    const page = await github(
      `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
    );
    jobs.push(...(page.jobs ?? []));
  }
  return jobs;
}

async function onQueuedJob({ jobId, label, startedAt, starts = 0 }) {
  const repo = process.env.REPOSITORY;
  const job = await github(`/repos/${repo}/actions/jobs/${jobId}`);
  if (label === SNAPSHOT_LABEL && job.status === "queued") {
    const run = await github(`/repos/${repo}/actions/runs/${job.run_id}`);
    if (!trustedSnapshotRun(run, repo)) {
      console.log(JSON.stringify({ event: "snapshot.untrusted", job: jobId }));
      return false;
    }
    // Wait (recheck) while another job could take the build runner.
    if (untrustedSnapshotJobs(await queuedJobs(repo)).length > 0) {
      console.log(JSON.stringify({ event: "snapshot.waiting", job: jobId }));
      return true;
    }
  }
  const step = nextStep(
    {
      queued: job.status === "queued",
      idle: idleRunners(await listRunners(repo), label).length,
      startedAt,
      starts,
    },
    {
      maxStarts: label === SNAPSHOT_LABEL ? 1 : 3,
      // A warm sandbox hydrates longer before its runner registers.
      bootSeconds:
        runnerSource(label, process.env) === process.env.SNAPSHOT ? 120 : 240,
    }
  );
  if (step !== "start") {
    return step === "recheck";
  }
  await startRunner(label, "burst");
  // A fresh message carries the start, so the job keeps being watched.
  await sendJob(
    { jobId, label, startedAt: Date.now(), starts: starts + 1 },
    20
  );
  return false;
}

export const RATE_LIMIT_DELAY_SECONDS = 300;
export const rateLimited = (error) =>
  /^(GitHub .*HTTP (403|429)|Boat .*HTTP 429)\b/.test(String(error?.message));

async function onQueue(event) {
  const failures = [];
  for (const record of event.Records) {
    try {
      if (await onQueuedJob(JSON.parse(record.body))) {
        failures.push({ itemIdentifier: record.messageId });
      }
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "runner.retry",
          message: String(error.message),
        })
      );
      // Rate limited (GitHub 403/429, Boat 429): retrying every 20 s only
      // keeps the limit pinned, so look again in 5 minutes.
      if (rateLimited(error)) {
        await sendJob(JSON.parse(record.body), RATE_LIMIT_DELAY_SECONDS);
        continue;
      }
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

async function onSchedule() {
  const repo = process.env.REPOSITORY;
  const baselineSizes = JSON.parse(process.env.BASELINE ?? "{}");
  const live =
    (
      await boat(
        "/sandboxes?limit=200&state=provisioning,provisioned,cloning,ready,idle,running"
      )
    ).sandboxes ?? [];
  const runners = await listRunners(repo);
  const maxAgeMs = Number(process.env.MAX_AGE_HOURS ?? 6) * 3_600_000;
  const active = inHourWindow(process.env.BASELINE_HOURS_UTC);

  for (const label of Object.keys(SIZES)) {
    let baseline = live.filter((sandbox) => {
      const parsed = parseSandboxName(sandbox.name);
      return parsed?.label === label && parsed.kind === "base";
    });
    // Deregister first: GitHub refuses to delete a runner that just took a
    // job, and then that sandbox stays.
    const target = active ? (baselineSizes[label] ?? 0) : 0;
    for (const sandbox of baselineToRetire(baseline, runners, {
      maxAgeMs,
      target,
    })) {
      const runner = runners.find((r) => r.name === sandbox.id);
      try {
        await github(`/repos/${repo}/actions/runners/${runner.id}`, {
          method: "DELETE",
        });
      } catch {
        continue;
      }
      await boat(`/sandboxes/${sandbox.id}/stop`, { method: "POST" });
      baseline = baseline.filter((s) => s.id !== sandbox.id);
      console.log(
        JSON.stringify({ event: "runner.retired", sandbox: sandbox.id })
      );
    }
    for (let count = baseline.length; count < target; count += 1) {
      await startRunner(label, "base");
    }
  }

  // Stop runner sandboxes whose runner is gone, before refreshing deadlines.
  const orphans = new Set(
    orphanSandboxes(live, runners).map((sandbox) => sandbox.id)
  );
  for (const id of orphans) {
    await boat(`/sandboxes/${id}/stop`, { method: "POST" });
    console.log(
      JSON.stringify({ event: "runner.orphan_stopped", sandbox: id })
    );
  }

  // Safety net: keep every runner sandbox's deadline a margin ahead of now.
  for (const sandbox of live) {
    if (orphans.has(sandbox.id)) continue;
    if (!parseSandboxName(sandbox.name)) continue;
    try {
      await boat(`/sandboxes/${sandbox.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ttlSeconds: safetyTtl(sandbox.createdAt) }),
      });
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "ttl.refresh_failed",
          sandbox: sandbox.id,
          message: String(error.message),
        })
      );
    }
  }

  // Missed webhooks: re-enqueue jobs that have sat queued too long.
  for (const job of missedJobs(await queuedJobs(repo))) {
    await sendJob({ jobId: job.id, label: jobLabel(job) }, 0);
    console.log(JSON.stringify({ event: "job.requeued_missed", job: job.id }));
  }

  const liveIds = new Set(live.map((sandbox) => sandbox.id));
  for (const runner of runners) {
    if (staleRunner(runner, liveIds)) {
      await github(`/repos/${repo}/actions/runners/${runner.id}`, {
        method: "DELETE",
      });
    }
  }
}

export async function handler(event) {
  if (event.requestContext?.http) {
    return onWebhook(event);
  }
  if (event.Records) {
    return onQueue(event);
  }
  return onSchedule();
}
