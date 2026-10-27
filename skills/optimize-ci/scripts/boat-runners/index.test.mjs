import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  baselineToRetire,
  boatLabel,
  burstIdleSeconds,
  idleRunners,
  inHourWindow,
  jobLabel,
  missedJobs,
  rateLimited,
  orphanSandboxes,
  safetyTtl,
  nextStep,
  parseSandboxName,
  runnerScript,
  runnerSource,
  sandboxName,
  staleRunner,
  trustedSnapshotRun,
  untrustedSnapshotJobs,
  verifySignature,
} from "./index.mjs";

test("only boat-* labels are claimed", () => {
  assert.equal(boatLabel(["self-hosted", "boat-8vcpu"]), "boat-8vcpu");
  assert.equal(boatLabel(["boat-4vcpu-once"]), "boat-4vcpu-once");
  assert.equal(boatLabel(["ubuntu-latest"]), null);
  assert.equal(boatLabel(["self-hosted", "linux"]), null);
});

test("webhook signatures are checked against the raw body", () => {
  const body = '{"action":"queued"}';
  const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  assert.equal(verifySignature("s3cret", body, good), true);
  assert.equal(verifySignature("s3cret", `${body} `, good), false);
  assert.equal(verifySignature("other", body, good), false);
  assert.equal(verifySignature("s3cret", body), false);
});

test("sandbox names round-trip label and kind", () => {
  const name = sandboxName("boat-16vcpu", "base", "bx_abc");
  assert.deepEqual(parseSandboxName(name), {
    label: "boat-16vcpu",
    kind: "base",
  });
  assert.deepEqual(
    parseSandboxName(sandboxName("boat-2vcpu-once", "burst", "bx_abc")),
    {
      label: "boat-2vcpu-once",
      kind: "burst",
    }
  );
  assert.equal(parseSandboxName("some-other-name"), null);
  assert.equal(parseSandboxName(), null);
});

const label = (name) => ({ name });

test("an idle runner is online, not busy, and has the job's label", () => {
  const runners = [
    { name: "a", status: "online", busy: false, labels: [label("boat-8vcpu")] },
    { name: "b", status: "online", busy: true, labels: [label("boat-8vcpu")] },
    {
      name: "c",
      status: "offline",
      busy: false,
      labels: [label("boat-8vcpu")],
    },
    { name: "d", status: "online", busy: false, labels: [label("boat-4vcpu")] },
  ];
  assert.deepEqual(
    idleRunners(runners, "boat-8vcpu").map((r) => r.name),
    ["a"]
  );
});

test("cleanup removes only offline registrations of ours whose sandbox is gone", () => {
  const live = new Set(["bx_live"]);
  const ours = [label("boat-2vcpu")];
  assert.equal(
    staleRunner({ name: "bx_gone", status: "offline", labels: ours }, live),
    true
  );
  assert.equal(
    staleRunner({ name: "bx_live", status: "offline", labels: ours }, live),
    false
  );
  assert.equal(
    staleRunner({ name: "bx_gone", status: "online", labels: ours }, live),
    false
  );
  assert.equal(
    staleRunner(
      {
        name: "bx_gone",
        status: "offline",
        labels: [label("some-other-runner")],
      },
      live
    ),
    false
  );
});

test("only old baseline sandboxes with an idle online runner are retired", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const old = "2026-10-23T05:00:00Z";
  const baseline = [
    { id: "bx_idle_old", createdAt: old },
    { id: "bx_busy_old", createdAt: old },
    { id: "bx_idle_new", createdAt: "2026-10-23T11:00:00Z" },
    { id: "bx_booting_old", createdAt: old },
  ];
  const runners = [
    { name: "bx_idle_old", status: "online", busy: false },
    { name: "bx_busy_old", status: "online", busy: true },
    { name: "bx_idle_new", status: "online", busy: false },
  ];
  assert.deepEqual(
    baselineToRetire(baseline, runners, { now }).map((s) => s.id),
    ["bx_idle_old"]
  );
});

// Runs the real boot script with a stub runner and a stub `boat`. The stub
// runs one "job" (a process named Runner.Worker) jobAt seconds in, for
// jobSeconds, then waits for a signal like a real listener.
function boot({
  idle,
  jobAt = null,
  jobSeconds = 2,
  runsOn = "boat-4vcpu",
  jobPasses = false,
  maxAge = undefined,
}) {
  const home = mkdtempSync(path.join(tmpdir(), "boat-runner-"));
  const runner = path.join(home, "actions-runner");
  mkdirSync(runner);
  // What a registered runner leaves on disk.
  writeFileSync(path.join(runner, ".credentials"), "secret");
  mkdirSync(path.join(runner, "_diag"));
  mkdirSync(path.join(home, ".ascii"));
  writeFileSync(
    path.join(runner, "config.sh"),
    '#!/usr/bin/env bash\necho "$*" > ~/args; echo configured >> ~/events\n',
    { mode: 0o755 }
  );
  const job =
    jobAt === null
      ? ""
      : `sleep ${jobAt}; bash -c 'exec -a \"$HOME/actions-runner/bin/Runner.Worker\" sleep ${jobSeconds}'; ${jobPasses ? "touch ~/snapshot-ready; " : ""}echo job-done >> ~/events`;
  writeFileSync(
    path.join(runner, "run.sh"),
    `#!/usr/bin/env bash
trap 'echo listener-stopped >> ~/events; exit 0' TERM
[ -n "\${GH_REG:-}" ] && echo listener-has-token >> ~/events
${job}
# An ephemeral runner exits after its job; a reusable one waits for the next.
case " $(cat ~/args 2>/dev/null) " in *--ephemeral*) exit 0 ;; esac
while true; do sleep 0.2; done
`,
    { mode: 0o755 }
  );
  writeFileSync(
    path.join(home, ".ascii", "boat"),
    '#!/usr/bin/env bash\ncase "$1" in info) echo \'{"sandbox":{"hydrated":true}}\' ;; stop) echo "stop $2" >> ~/events ;; snapshot) [ -e ~/actions-runner/.credentials ] && echo creds-in-snapshot >> ~/events; echo "snapshot $2 $3" >> ~/events ;; esac\n',
    { mode: 0o755 }
  );
  const started = Date.now();
  execFileSync(
    "bash",
    ["-c", runnerScript("acme/app", runsOn, idle, "gh-runner", maxAge)],
    {
      env: {
        HOME: home,
        PATH: process.env.PATH,
        GH_REG: "reg",
        BOAT_ID: "bx_test",
      },
      timeout: 30_000,
    }
  );
  return {
    events: readFileSync(path.join(home, "events"), "utf8").trim().split("\n"),
    seconds: (Date.now() - started) / 1000,
  };
}

test("a burst runner with no job stops its sandbox after the idle window", () => {
  const { events, seconds } = boot({ idle: 3 });
  assert.deepEqual(events, ["configured", "listener-stopped", "stop bx_test"]);
  // The watchdog counts whole seconds, so a 3 s window can close after 2.x s.
  assert.ok(seconds >= 2 && seconds < 10, `stopped after ${seconds}s`);
});

test("the idle window restarts when a job ends", () => {
  // Job from ~1s to ~5s. The 3s idle window must not fire during the job and
  // must count from its end. The watchdog polls every 2 s in whole seconds,
  // so the stop lands somewhere past 5 s; one counted from boot lands by ~3 s.
  const { events, seconds } = boot({ idle: 3, jobAt: 1, jobSeconds: 4 });
  assert.deepEqual(events, [
    "configured",
    "job-done",
    "listener-stopped",
    "stop bx_test",
  ]);
  assert.ok(
    seconds >= 5,
    `stopped after ${seconds}s, before the job's idle window ended`
  );
});

test("a runner past its age stops at its next idle moment, never mid-job", () => {
  // Age limit 3 s, job from ~1s to ~5s, idle window far away: the stop must
  // wait for the job to end, then come from the age limit.
  const { events, seconds } = boot({
    idle: 60,
    maxAge: 3,
    jobAt: 1,
    jobSeconds: 4,
  });
  assert.deepEqual(events, [
    "configured",
    "job-done",
    "listener-stopped",
    "stop bx_test",
  ]);
  assert.ok(seconds >= 5 && seconds < 20, `stopped after ${seconds}s`);
});

test("a -once runner takes one job, then its sandbox stops", () => {
  // The idle window is far away: the stop must come from the job ending.
  const { events, seconds } = boot({
    idle: 60,
    jobAt: 1,
    jobSeconds: 1,
    runsOn: "boat-4vcpu-once",
  });
  assert.deepEqual(events, ["configured", "job-done", "stop bx_test"]);
  assert.ok(seconds < 10, `stopped after ${seconds}s`);
});

const git = (...args) =>
  execFileSync("git", args, {
    // Inherited GIT_* variables (from a git hook, or a test runner that sets
    // them) would point these calls at another repository.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
    ),
  });

test("before each job the hook clears the last job's files, containers and temp outputs, but keeps node_modules and .turbo", () => {
  const home = mkdtempSync(path.join(tmpdir(), "boat-hook-"));
  const runner = path.join(home, "actions-runner");
  const ws = path.join(home, "ws");
  const tmp = path.join(home, "tmp");
  const bin = path.join(home, "bin");
  mkdirSync(runner);
  mkdirSync(path.join(tmp, "ci-backend"), { recursive: true });
  mkdirSync(path.join(tmp, "other"));
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "docker"),
    '#!/usr/bin/env bash\ncase "$1" in ps) echo c1 ;; rm) echo "$*" >> ~/docker ;; esac\n',
    { mode: 0o755 }
  );
  mkdirSync(path.join(home, ".ascii"));
  mkdirSync(path.join(ws, "node_modules", "pkg"), { recursive: true });
  mkdirSync(path.join(ws, ".turbo"));
  mkdirSync(path.join(ws, "dist"));
  git("init", "-q", ws);
  writeFileSync(path.join(ws, ".gitignore"), "node_modules\n.turbo\ndist\n");
  writeFileSync(path.join(ws, "tracked.txt"), "kept\n");
  git("-C", ws, "add", ".");
  git(
    "-C",
    ws,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init"
  );
  writeFileSync(path.join(ws, "node_modules", "pkg", "index.js"), "");
  writeFileSync(path.join(ws, ".turbo", "cache"), "");
  writeFileSync(path.join(ws, "dist", "stale.js"), "");
  writeFileSync(path.join(ws, "leftover.log"), "");
  writeFileSync(path.join(runner, "config.sh"), "#!/usr/bin/env bash\n", {
    mode: 0o755,
  });
  // The stub runner fires the job-started hook the way the real runner does.
  writeFileSync(
    path.join(runner, "run.sh"),
    `#!/usr/bin/env bash\ntrap 'exit 0' TERM\nGITHUB_WORKSPACE='${ws}' "$ACTIONS_RUNNER_HOOK_JOB_STARTED"\nwhile true; do sleep 0.2; done\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    path.join(home, ".ascii", "boat"),
    `#!/usr/bin/env bash\n[ "$1" = info ] && echo '{"sandbox":{"hydrated":true}}'\nexit 0\n`,
    {
      mode: 0o755,
    }
  );
  execFileSync("bash", ["-c", runnerScript("acme/app", "boat-4vcpu", 2)], {
    env: {
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: tmp,
      GH_REG: "reg",
      BOAT_ID: "bx_test",
    },
    timeout: 30_000,
  });
  assert.equal(readFileSync(path.join(home, "docker"), "utf8"), "rm -f c1\n");
  assert.deepEqual(readdirSync(tmp), ["other"]);
  const exists = (p) => {
    try {
      readFileSync(path.join(ws, p));
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(exists("tracked.txt"), true);
  assert.equal(
    exists("node_modules/pkg/index.js"),
    true,
    "node_modules survives"
  );
  assert.equal(exists(".turbo/cache"), true, "turbo cache survives");
  assert.equal(exists("dist/stale.js"), false, "stale build output is removed");
  assert.equal(exists("leftover.log"), false, "untracked files are removed");
});

test("outside its window the baseline drains idle runners, oldest first, never busy ones", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const baseline = [
    { id: "bx_a", createdAt: "2026-10-23T11:00:00Z" },
    { id: "bx_b", createdAt: "2026-10-23T10:00:00Z" },
    { id: "bx_c", createdAt: "2026-10-23T09:00:00Z" },
  ];
  const runners = [
    { name: "bx_a", status: "online", busy: false },
    { name: "bx_b", status: "online", busy: false },
    { name: "bx_c", status: "online", busy: true },
  ];
  const ids = (target) =>
    baselineToRetire(baseline, runners, { now, target })
      .map((s) => s.id)
      .sort();
  assert.deepEqual(
    ids(0),
    ["bx_a", "bx_b"],
    "drain all idle; the busy one stays"
  );
  assert.deepEqual(ids(2), ["bx_b"], "one over target: the oldest idle goes");
  assert.deepEqual(ids(3), []);
});

test("hour windows wrap midnight", () => {
  const at = (h) => new Date(Date.UTC(2026, 9, 23, h));
  assert.equal(inHourWindow("22-6", at(22)), true);
  assert.equal(inHourWindow("22-6", at(23)), true);
  assert.equal(inHourWindow("22-6", at(2)), true);
  assert.equal(inHourWindow("22-6", at(6)), false);
  assert.equal(inHourWindow("22-6", at(12)), false);
  assert.equal(inHourWindow("9-17", at(12)), true);
  assert.equal(inHourWindow("9-17", at(17)), false);
  assert.equal(inHourWindow("", at(4)), true);
});

test("a queued job is watched until it leaves the queue, restarting a runner another job took", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const step = (state) => nextStep({ now, ...state });
  assert.equal(step({ queued: false, idle: 0 }), "done");
  assert.equal(step({ queued: true, idle: 1 }), "recheck");
  assert.equal(step({ queued: true, idle: 0 }), "start");
  // Its runner is still booting.
  assert.equal(
    step({ queued: true, idle: 0, startedAt: now - 30_000, starts: 1 }),
    "recheck"
  );
  // Booted, and taken by another job with the same label: start another.
  assert.equal(
    step({ queued: true, idle: 0, startedAt: now - 300_000, starts: 1 }),
    "start"
  );
  // Out of starts: left for the DLQ alarm.
  assert.equal(
    step({ queued: true, idle: 0, startedAt: now - 300_000, starts: 3 }),
    "recheck"
  );
});

test("burst runners stay warm longer in working hours", () => {
  const env = {
    BASELINE_HOURS_UTC: "22-6",
    IDLE_SECONDS: "1800",
    IDLE_SECONDS_OFF_HOURS: "300",
  };
  const at = (h) => new Date(Date.UTC(2026, 9, 23, h));
  assert.equal(burstIdleSeconds(env, at(23)), 1800);
  assert.equal(burstIdleSeconds(env, at(12)), 300);
});

test("the safety TTL keeps a deadline a margin ahead of now, counted from creation", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  assert.equal(safetyTtl("2026-10-23T11:00:00Z", now, 1800), 3600 + 1800);
  assert.equal(safetyTtl("2026-10-23T12:00:00Z", now, 1800), 1800);
});

test("only boat jobs queued past the grace count as missed webhooks", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const job = (status, labels, minutesAgo) => ({
    status,
    labels,
    created_at: new Date(now - minutesAgo * 60_000).toISOString(),
  });
  const ids = missedJobs(
    [
      job("queued", ["boat-4vcpu"], 6),
      job("queued", ["boat-4vcpu"], 2),
      job("in_progress", ["boat-4vcpu"], 9),
      job("queued", ["macos-15"], 9),
    ],
    now
  ).map((j) => j.labels[0] + ":" + j.status);
  assert.deepEqual(ids, ["boat-4vcpu:queued"]);
});

test("a job still queued is requeued once per message lifetime, not every pass", () => {
  const created = Date.parse("2026-01-05T12:00:00Z");
  const job = {
    status: "queued",
    labels: ["boat-4vcpu"],
    created_at: "2026-01-05T12:00:00Z",
  };
  // One schedule pass every 2 minutes for 3 hours.
  let requeues = 0;
  for (let minute = 0; minute <= 180; minute += 2) {
    requeues += missedJobs([job], created + minute * 60_000 + 30_000).length;
  }
  assert.equal(requeues, 6);
});

test("only rate-limit errors back off", () => {
  for (const message of [
    "GitHub GET /repos/a/b/actions/runners?per_page=100&page=1: HTTP 403",
    "GitHub installation token: HTTP 429",
    "Boat POST /sandboxes: HTTP 429 rate_limited",
  ]) {
    assert.ok(rateLimited(new Error(message)), message);
  }
  for (const message of [
    "Boat POST /sandboxes: HTTP 403 forbidden",
    "GitHub GET /repos/a/b/actions/jobs/1: HTTP 404",
    "fetch failed",
  ]) {
    assert.ok(!rateLimited(new Error(message)), message);
  }
});

test("the runner registers only after the sandbox reports hydrated", () => {
  const home = mkdtempSync(path.join(tmpdir(), "boat-hydrate-"));
  const runner = path.join(home, "actions-runner");
  mkdirSync(runner);
  mkdirSync(path.join(home, ".ascii"));
  writeFileSync(
    path.join(runner, "config.sh"),
    "#!/usr/bin/env bash\necho configured >> ~/events\n",
    { mode: 0o755 }
  );
  writeFileSync(path.join(runner, "run.sh"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  // Not hydrated on the first check, hydrated on the second.
  writeFileSync(
    path.join(home, ".ascii", "boat"),
    `#!/usr/bin/env bash
if [ "$1" = info ]; then
  n=$(cat ~/checks 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ~/checks
  echo "check $n" >> ~/events
  [ $n -ge 2 ] && echo '{"sandbox":{"hydrated":true}}' || echo '{"sandbox":{"hydrated":false}}'
fi
exit 0
`,
    { mode: 0o755 }
  );
  execFileSync("bash", ["-c", runnerScript("acme/app", "boat-4vcpu", 1)], {
    env: {
      HOME: home,
      PATH: process.env.PATH,
      GH_REG: "reg",
      BOAT_ID: "bx_test",
    },
    timeout: 30_000,
  });
  const events = readFileSync(path.join(home, "events"), "utf8")
    .trim()
    .split("\n");
  assert.deepEqual(events, ["check 1", "check 2", "configured"]);
  assert.match(
    readFileSync(path.join(runner, ".env"), "utf8"),
    /LC_ALL=C\.UTF-8/
  );
});

test("a runner sandbox with no registration after boot is an orphan", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const sb = (id, minutesAgo, name = `gh-boat-4vcpu-burst-${id}`) => ({
    id,
    name,
    createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
  });
  const live = [
    sb("bx_ok", 30),
    sb("bx_gone", 30),
    sb("bx_booting", 3),
    sb("bx_mine", 30, "dev-box"),
  ];
  const runners = [{ name: "bx_ok" }];
  assert.deepEqual(
    orphanSandboxes(live, runners, now).map((s) => s.id),
    ["bx_gone"]
  );
});

test("the snapshot build saves its disk only after a passing job, without the runner's credentials", () => {
  const build = { idle: 0, jobAt: 1, jobSeconds: 1, runsOn: "boat-snapshot" };
  assert.deepEqual(boot({ ...build, jobPasses: true }).events, [
    "configured",
    "job-done",
    "snapshot bx_test gh-runner-warm",
    "stop bx_test",
  ]);
  assert.deepEqual(boot(build).events, [
    "configured",
    "job-done",
    "stop bx_test",
  ]);
});

test("only default-branch runs claim the snapshot build, and -once runners never start from it", () => {
  const job = (head_branch, labels = ["boat-snapshot"]) => ({
    status: "queued",
    labels,
    head_branch,
  });
  assert.equal(jobLabel(job("main")), "boat-snapshot");
  assert.equal(jobLabel(job("feature/poison")), null);
  assert.equal(jobLabel(job("x", ["boat-8vcpu"])), "boat-8vcpu");
  assert.equal(
    untrustedSnapshotJobs([
      job("main"),
      job("feature/poison"),
      job("x", ["boat-8vcpu"]),
    ]).length,
    1
  );
  const env = { SNAPSHOT: "gh-runner", WARM_SNAPSHOT: "gh-runner-warm" };
  assert.equal(runnerSource("boat-8vcpu", env), "gh-runner-warm");
  assert.equal(runnerSource("boat-8vcpu-once", env), "gh-runner");
  assert.equal(runnerSource("boat-snapshot", env), "gh-runner");
  assert.equal(
    runnerSource("boat-8vcpu", { ...env, WARM_SNAPSHOT: "" }),
    "gh-runner"
  );
});

// The job-started hook exactly as runnerScript writes it.
function hookExit(label, env) {
  const script = runnerScript("acme/app", label, 0, "gh-runner");
  const hook = script.split("<<'HOOK'\n")[1].split("\nHOOK\n")[0];
  const home = mkdtempSync(path.join(tmpdir(), "boat-hook-"));
  const file = path.join(home, "hook.sh");
  writeFileSync(file, hook, { mode: 0o755 });
  try {
    execFileSync("bash", [file], {
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, ...env },
      stdio: "pipe",
    });
    return 0;
  } catch (error) {
    return error.status;
  }
}

test("the build runner's hook fails every job but main's own snapshot workflow before a step runs", () => {
  const main = {
    GITHUB_REPOSITORY: "acme/app",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_WORKFLOW_REF:
      "acme/app/.github/workflows/runner-snapshot.yml@refs/heads/main",
  };
  assert.equal(hookExit("boat-snapshot", main), 0);
  assert.equal(
    hookExit("boat-snapshot", {
      ...main,
      GITHUB_EVENT_NAME: "workflow_dispatch",
    }),
    0
  );
  for (const untrusted of [
    { GITHUB_EVENT_NAME: "pull_request" },
    {
      GITHUB_WORKFLOW_REF:
        "acme/app/.github/workflows/poison.yml@refs/heads/main",
    },
    {
      GITHUB_WORKFLOW_REF:
        "acme/app/.github/workflows/runner-snapshot.yml@refs/heads/feature",
    },
    { GITHUB_REPOSITORY: "fork/app" },
    { GITHUB_WORKFLOW_REF: "" },
  ]) {
    assert.notEqual(
      hookExit("boat-snapshot", { ...main, ...untrusted }),
      0,
      JSON.stringify(untrusted)
    );
  }
  // Reused runners take any job; their hook only cleans up.
  assert.equal(
    hookExit("boat-8vcpu", { GITHUB_EVENT_NAME: "pull_request" }),
    0
  );
  assert.match(
    runnerScript("acme/app", "boat-snapshot", 0),
    /--labels boat-snapshot --no-default-labels /
  );
});

test("a snapshot job's run must be main's schedule or dispatch of the workflow in this repo", () => {
  const run = {
    event: "schedule",
    path: ".github/workflows/runner-snapshot.yml",
    head_branch: "main",
    head_repository: { full_name: "acme/app" },
  };
  assert.equal(trustedSnapshotRun(run, "acme/app"), true);
  for (const change of [
    { event: "pull_request" },
    { path: ".github/workflows/poison.yml" },
    { head_branch: "feature" },
    // A fork's own main branch.
    { head_repository: { full_name: "someone/app" } },
  ]) {
    assert.equal(
      trustedSnapshotRun({ ...run, ...change }, "acme/app"),
      false,
      JSON.stringify(change)
    );
  }
});

test("missed snapshot jobs are requeued and their stale registrations removed", () => {
  // Inside the first requeue slot (5-7 minutes queued).
  const old = new Date(Date.now() - 6 * 60_000).toISOString();
  const jobs = [
    {
      status: "queued",
      labels: ["boat-snapshot"],
      head_branch: "main",
      created_at: old,
    },
    {
      status: "queued",
      labels: ["boat-snapshot"],
      head_branch: "feature",
      created_at: old,
    },
  ];
  assert.equal(missedJobs(jobs).length, 1);
  assert.equal(
    staleRunner(
      {
        status: "offline",
        name: "bx_gone",
        labels: [{ name: "boat-snapshot" }],
      },
      new Set()
    ),
    true
  );
});
