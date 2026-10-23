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
  idleRunners,
  inHourWindow,
  nextStep,
  parseSandboxName,
  runnerScript,
  sandboxName,
  staleRunner,
  verifySignature,
} from "./index.mjs";

test("only boat-* labels are claimed", () => {
  assert.equal(boatLabel(["self-hosted", "boat-8vcpu"]), "boat-8vcpu");
  assert.equal(boatLabel(["boat-4vcpu-once"]), "boat-4vcpu-once");
  assert.equal(boatLabel(["ubuntu-latest"]), null);
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
    { label: "boat-2vcpu-once", kind: "burst" }
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
      { name: "bx_gone", status: "offline", labels: [label("some-other-runner")] },
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
function boot({ idle, jobAt = null, jobSeconds = 2, runsOn = "boat-4vcpu" }) {
  const home = mkdtempSync(path.join(tmpdir(), "boat-runner-"));
  const runner = path.join(home, "actions-runner");
  mkdirSync(runner);
  mkdirSync(path.join(home, ".ascii"));
  writeFileSync(
    path.join(runner, "config.sh"),
    '#!/usr/bin/env bash\necho "$*" > ~/args; echo configured >> ~/events\n',
    { mode: 0o755 }
  );
  const job =
    jobAt === null
      ? ""
      : `sleep ${jobAt}; bash -c 'exec -a \"$HOME/actions-runner/bin/Runner.Worker\" sleep ${jobSeconds}'; echo job-done >> ~/events`;
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
    '#!/usr/bin/env bash\necho "stop $2" >> ~/events\n',
    { mode: 0o755 }
  );
  const started = Date.now();
  execFileSync("bash", ["-c", runnerScript("acme/app", runsOn, idle)], {
    env: {
      HOME: home,
      PATH: process.env.PATH,
      GH_REG: "reg",
      BOAT_ID: "bx_test",
    },
    timeout: 30_000,
  });
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
  writeFileSync(path.join(home, ".ascii", "boat"), "#!/usr/bin/env bash\n", {
    mode: 0o755,
  });
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
