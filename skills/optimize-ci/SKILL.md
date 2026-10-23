---
name: optimize-ci
description: How we made CI on a busy TypeScript monorepo faster and about 10x cheaper without letting more bugs through. Covers measuring, cutting test CPU, picking tests per diff, git and cache fixes, newer tools, and moving from Blacksmith to reused Boat sandbox runners.
disable-model-invocation: true
---

# Optimize CI

We run a TypeScript monorepo with a lot of agent-written PRs and thousands of
CI jobs a day. CI was slow and expensive, and with agents opening PRs all day
it only got worse. This is what we changed, in roughly the order it paid off.
CI ended up about 10x cheaper, and a typical PR is checked in a couple of
minutes.

Our stack, so you can tell how much of this applies to you: Bun and Node 24,
TypeScript, Turbo, Vitest, node:test and bun test, Playwright, Postgres in
the backend tests, GitHub Actions, and Boat sandboxes as runners (before
that, Blacksmith). The runner autoscaler runs on AWS Lambda with OpenTofu.

A **lane** below means one suite a workflow can run or skip (backend tests,
web tests, end-to-end). [Boat](https://docs.boat.dev) rents Linux sandboxes
by the second; we register them as GitHub Actions runners.

## Table stakes first

These are cheap, most fast pipelines already do them, and they're easy to
miss. Check each one before the bigger work below.

- **Only run a job when its inputs changed.** Path filters on workflows, and
  your task runner's affected-only mode (`turbo run --affected`, `nx affected`)
  for monorepos. Make it run everything when it can't tell
  (`references/test-selection.md`).
- **Cancel superseded PR runs.** A new push to a PR cancels the run in
  progress. Never do this on main (`references/test-selection.md`).
- **Cache between runs.** The package manager's store, task outputs through a
  remote cache (Turbo, Nx), and build artifacts. One job writes each cache;
  the rest only read (`references/git-and-caching.md`).
- **Shard by measured test time,** not by file count, so shards finish
  together. Refresh the timings from recent green runs (`references/runners.md`).
- **Run independent jobs in parallel,** with the cheap static checks (format,
  lint, typecheck) failing fast instead of waiting behind the slow suites.
- **Catch cheap failures before they reach CI.** A pre-commit hook that formats
  and lints staged files, and a short pre-push check (format, lint, typecheck
  of changed files). With agents pushing all day, a lot of red CI is exactly
  these (`references/guardrails.md`).
- **Set a timeout on every job,** so a hung test costs minutes, not the
  provider's six-hour default.
- **Keep light jobs on small runners,** and size heavy ones from their CPU
  use (`references/runners.md`).
- **Pin tool and runtime versions** to what production runs.

## What moved the needle

1. **Measuring first.** Most of our guesses about where the time went were
   wrong. See `references/measure.md`.
2. **Profiling tests and deleting the low-value ones.** We profiled the
   exact commands CI runs. TS loaders and starting a process per test file
   cost more than the tests did. Then we deleted tests that re-checked what
   another test covered, swapped real sleeps for fake clocks, and fixed slow
   helpers. Counting what each suite actually caught on PRs showed most of
   the heavy suites' red was flakes. See `references/test-cpu.md` and
   `references/measure.md`.
3. **Running only what the diff can affect.** We walk the import graph from
   the diff, then a decision model (a fast classifier that returns a
   probability per yes/no question, like Jev) picks the tests that actually
   run the changed code, asking about folders first and then single tests. A replay of real past failures checks that we still catch them, and
   the full suite runs every few hours. See `references/test-selection.md`.
4. **Git and caches.** Forcing git onto HTTP/1.1 fixed checkouts that
   sometimes took over ten minutes. Keeping `node_modules` warm made installs
   take seconds. See `references/git-and-caching.md`.
5. **Keeping main honest.** A later merge never cancels a main run, a
   message goes out when main goes red, a required check can't pass with zero
   tests, and a pre-push check catches the cheap failures. See
   `references/guardrails.md`.
6. **Newer tools.** oxlint, oxfmt, oxc-based TS loaders, and native
   typecheckers in place of ESLint, Prettier, tsx and `tsc --noEmit`. See
   `references/tool-choices.md`, and `references/stale-defaults.md` for the
   defaults agents still reach for.
7. **Moving from Blacksmith to Boat.** Reused sandbox runners keep the
   workspace between jobs, so setup takes a second or two, and runner time
   costs roughly a tenth as much. See `references/boat-runners.md` and the
   autoscaler in `scripts/boat-runners/`.

`references/runners.md` covers runner sizing and sharding, and
`references/guardrails.md` covers the tests that keep each of these from
getting undone later.

## Before you start

Find out, or ask for:

- How the runner provider bills: per minute rounded up, per second, per
  vCPU. That decides whether splitting a job across runners saves money or
  only time.
- Whether the goal is cost, latency, or both. Some of the advice in
  `references/runners.md` flips depending on which.
- Read access to recent runs (`gh run list`, `gh run view --log`) and the
  billing page.
- Who watches main. Running less on PRs means some failures show up on main
  first, so someone has to get pinged when it goes red.

## How to run it

Write down every change with its before and after numbers and the run IDs
they came from. Runner noise is big enough that one run against one run
tells you nothing.

1. Add per-job CPU, memory and pressure sampling and a per-run timing report
   (`references/measure.md`). For each slow lane, work out whether it's
   CPU-bound, waiting on something, or paying for setup.
2. Profile the exact command CI runs, the whole process tree, ranked by
   CPU-seconds, and fix what's on top (`references/test-cpu.md`).
3. Add lane selection that runs everything when unsure, then per-test
   selection, then the replay check (`references/test-selection.md`). Set up
   the scheduled full run and the red-main alert before any of it goes live.
4. Fix git transport, checkout depth, the dependency cache and cache keys
   (`references/git-and-caching.md`).
5. Swap tools, checking on your own repo that the output matches before you
   switch (`references/tool-choices.md`).
6. Size runners by what you're billed, then try reused sandbox runners
   (`references/runners.md`, `references/boat-runners.md`).
7. Add the guardrail tests (`references/guardrails.md`).

## Stop and ask before

- Turning off any suite on PRs, or changing what runs when selection fails
- Changing branch protection or required checks
- Changing cancellation or concurrency on main or deploy workflows
- Adding a paid service (a model, a runner provider) or something that costs
  money while idle, like an always-on runner pool
- Letting a runner that PR jobs use hold deploy credentials
- Deleting tests. Show what each one checked and which other test covers it.

## The checks we'd keep no matter what

| Check | How | Passing means |
|---|---|---|
| A required lane can't pass while running nothing | A wrapper on every required test command that reads the runner's summary | Zero tests run fails the job |
| A later merge never cancels a main run | A test over the workflow files | Only PR runs cancel in progress |
| A crashed selector runs more, not less | Kill the selector in a test run | Its lanes still run (or a fixed smoke set does), with a warning |
| Selection still catches real failures | Replay recorded past failures | Recall at or above its floor |
| The full suite still runs | The scheduled run's history | A full run on main every few hours |
| Someone hears when main goes red | When the alert last fired | A message when main goes red, repeated until it's green |
| No PR job writes something a trusted job runs later | Cache write rules, runner labels | Only main writes shared caches; deploy jobs get fresh machines |
| Timing claims hold | Medians over several runs | The same result on different runners |
