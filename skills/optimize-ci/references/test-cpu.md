# Cut test CPU at the source

The cheapest CI minute is work that no longer happens. Before adding runners
or shards, find what the suite does that nobody needs.

## Method

1. Start from one complete green CI run with per-file timings and the
   per-job resource line (`measure.md`).
2. Classify before profiling. High CPU and a long file: profile it. Low CPU
   and a long file: trace waits (database, workflow engine, timers, network).
   The same loader or boot cost repeated across many files: reduce boots.
   Memory pressure: shrink working sets.
3. Profile the narrowest production-shaped command, the exact one CI runs,
   with a profiler that follows the whole process tree (V8 CPU profiles per
   process, or `perf`). Read OS-accounted CPU-seconds first, then self time.
4. Fix the top self-time at the seam that owns it.
5. Rerun without the profiler under `/usr/bin/time -p` and compare
   CPU-seconds and wall time on the CI shape.

Rules that kept this honest:

- No win from more runners, smaller fixtures, looser timeouts or disabled
  assertions. Those move cost or hide it.
- Prove the suite still proves the same thing: same test count, same
  assertions, same pass/fail/skip totals before and after.
- `NODE_OPTIONS` set in package scripts must append to the inherited value,
  or profiler flags vanish from child processes.
- V8 non-idle samples include threads blocked in `Atomics.wait`. Those are on
  the stack, not on a core.
- A helper imported from an executable script must guard its CLI body, or
  importing it runs the whole script.

## Where the CPU usually goes in a TypeScript suite

**Loader and process boot, not test bodies.** Often the largest single item.

- Per-file process isolation (node:test's default, Vitest's `isolate: true`,
  jest's model) starts a new process, a new TS loader and a new module graph
  for every file. Running a package's files in one process (`node --test
  --test-isolation=none --test-concurrency=1`, Vitest `vmForks` or a small
  fixed pool) cut test CPU by most of its total in the packages where it
  applied, with identical assertion counts.
- Off-thread TS loaders (tsx's hooks over esbuild) were most of import time.
  An in-thread Rust transform (oxc) or Node's native type stripping replaced
  them. See `tool-choices.md`.
- Worker threads inherit the parent's `--import` flags, so every worker
  thread rescans and retransforms. Strip loader flags from threads that don't
  need them (a workflow engine's worker threads, for example).
- Node re-parses large `package.json` `exports` maps per file in some loader
  setups. Caching resolution helped.
- `NODE_COMPILE_CACHE` helps suites that start many short Node processes and
  does little for long-lived ones. Measure it per lane.

**Repeated harness setup.** Tests that each boot the same expensive thing (a
workflow engine, a dev server, a bundler) should share one boot per file or
per lane. Consolidating journeys that each cold-booted a dev server into a
few domain journeys cut those files by most of their time, with every
assertion kept.

**Real waiting.**

- Expected-failure tests that wait out a success-polling budget. Disable the
  success polling when the test expects failure.
- Retry and pacing code with real sleeps. Inject the clock, the sleep and the
  scheduler, then drive them from the test.
- Timers that hold the process open after the last test (an object-URL
  revoke timer, a reconnect loop). Find them by comparing each file's wall
  time to the sum of its test durations.
- Don't reach for `--test-force-exit` blindly: with module-level `await`, it
  can make the runner abandon module evaluation and silently drop tests
  registered after the await.

**Quadratic helpers and oversized fixtures.** A large-fixture test that took
a long time was a quadratic rescan in a helper. Fixing the helper kept the
fixture and the coverage.

**Duplicate journeys.** A suite accumulates tests that re-prove what a
higher-level oracle already owns. For each slow test, name the invariant it
pins and which other test also pins it. Delete the duplicate, keep the
distinct cases. Ask before deleting (`SKILL.md`).

**Checkers and guardrails.** Scripts that spawn a process per file (a grep
per pattern, a formatter per directory) add up. One `git grep` in process,
one batched lint call or one git diff replaced dozens of spawns each.

## Harness waste

Some of the biggest wins came from what the test harness did around the
tests:

- **Serve route tests from a production build.** Booting the framework's dev
  server for each suite took tens of seconds per origin. Building once per
  job in the background and starting the built server took about a second.
  Bundle the development build of your UI library if tests rely on its dev
  behavior.
- **A teardown that closes shared clients hangs everything after it.** One
  helper closed every database client the process had registered, so after
  the first file every later file sat until its timeout. The job looked slow;
  it was walking file after file at the full timeout.
- **Browser suites set up a lot they don't need.** Check for debug features
  left on (a worker writing heap dumps every few seconds), warm-up requests
  that redirect to a login page and warm nothing, and the same warm-up
  repeated per test.
- **Share one service stack across browser workers** instead of starting a
  stack per worker. It cut CPU a lot for a little more wall time and half the
  runners. Going further (one stack, more workers) made contention worse.
- **Record traces only on retry.** Recording on every run costs time on runs
  that pass.
- **Bound waits by progress, not elapsed time.** A dev-server harness whose
  timeout kept getting raised was slow because a cold dependency optimizer
  pre-bundled things no test needed. Removing that work fixed it; the bigger
  timeouts never did.

## Things that didn't help

- More concurrency inside a file on a CPU-bound runner. On a saturated box
  only cutting work helps.
- Disabling test isolation where tests share global state (a DOM library
  binding the first document, module-level caches). It saved a lot of CPU
  and failed shuffled runs. Fix the leaks first or leave isolation on.
- Switching the test runner to a different JS engine than production runs.
  Faster, and wrong: binary, encoding and archive tests diverged.
- More process slots than cores minus a couple. Gains were marginal at
  near-full CPU, and noise grew.

## Flakes are usually the runner, not the code

CI runners sit near full CPU with deep run queues. Most flakes on them are
tests bounded by wall clock: a deadline missed by a few milliseconds, a race
pinned to a fixed gap. Raising the timeout repeatedly never fixed them;
removing unneeded work and bounding by progress did.

- Ban raw sleeps in tests with a lint rule, and use a stubbed clock.
- Wait for the exact predicate the assertion needs, not for "something
  rendered".
- Two different unrelated failures on consecutive runs of the same commit
  point at the runner.
- Dead or failing tests each burn their full timeout, which inflates wall
  time a lot. A suite that is red for weeks is also slow.
- Retrying a test that hangs is pure cost. Retry with traces for real flakes,
  and fix hangs.
