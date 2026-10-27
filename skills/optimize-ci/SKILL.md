---
name: optimize-ci
description: How we made CI on a busy TypeScript monorepo faster and about 10x cheaper without letting more bugs through. Covers the basics, measuring, cutting test CPU, picking tests per diff, git and cache fixes, newer tools, and moving from Blacksmith to reused Boat sandbox runners.
disable-model-invocation: true
---

# Optimize CI

We run a TypeScript monorepo where agents open a lot of the PRs, and CI runs
thousands of jobs a day. Every one of those PRs ran the whole pipeline, so CI
got slow and expensive at the same time. This skill is what we changed,
roughly in the order it paid off. In the end CI cost about a tenth of what it
had, and a typical PR is checked in a couple of minutes.

Our stack, so you can tell how much carries over: Bun and Node 24,
TypeScript, Turbo, Vitest, node:test and bun test, Playwright, Postgres in the
backend tests, and GitHub Actions. Runners were Blacksmith and are now
[Boat](https://docs.boat.dev) sandboxes, started by a small autoscaler on AWS
Lambda.

Not all of it will fit your repo. A small repo that runs its whole suite in
a few minutes doesn't need per-test selection; a team on GitHub-hosted
runners may not want to run an autoscaler. Measure first, then pick the
steps whose problem actually shows up in the numbers.

Two words used throughout: a **lane** is one suite a workflow can run or
skip (backend tests, web tests, end-to-end), and a **decision model** is a
fast classifier that answers a batch of yes/no questions with a probability
each.

## Start with the table stakes

Most fast pipelines already do these, and they're cheap, but they're easy to
skip when you're busy. Check them before anything else.

- **Only run a job when its inputs changed:** path filters on workflows, and
  your task runner's affected-only mode (`turbo run --affected`,
  `nx affected`). When it can't tell, it should run everything.
- **Cancel superseded PR runs,** but never on main.
- **Cache between runs:** the package store, task outputs through a remote
  cache, build artifacts. One job writes each cache and the rest only read.
- **Shard by measured test time** so shards finish together, and refresh the
  timings from recent green runs.
- **Run the cheap static checks first** (format, lint, typecheck) so they
  fail in seconds instead of waiting behind the slow suites.
- **Catch those failures before CI at all,** with a pre-commit hook that
  formats and lints staged files and a short pre-push check. With agents
  pushing all day, a lot of red CI is exactly this.
- **Put a timeout on every job,** so a hung test costs minutes instead of
  the provider's six-hour default.
- **Keep light jobs on small runners,** and pin tool and runtime versions to
  what production runs.

## What moved the needle

**We measured first.** Most of our guesses about where the time went were
wrong: a lane that looked slow was waiting in a queue, and a concurrency
setting that "didn't help" never reached the process. Per-job CPU and memory
sampling and a per-run timing report come before any change
(`references/measure.md`).

**We profiled the tests and cut what didn't earn its keep.** Profiling the
exact commands CI runs showed that TS loaders and a fresh process per test
file cost more than the tests themselves. After fixing that, we deleted tests
that re-checked what another test already covered, replaced real sleeps with
fake clocks, and fixed slow helpers instead of shrinking fixtures. Counting
what each heavy suite actually caught on PRs showed most of its red was
flakes and infrastructure (`references/test-cpu.md`).

**We stopped running everything on every PR.** Static checks always run. For
tests, we walk the import graph from the diff, then a decision model picks
the tests that actually execute the changed code, asking about folders first
and then single tests inside the folders it keeps. A replay of real past
failures checks that selection still catches them, main alarms if the model
stops answering, and the full suite runs
on main every few hours. This is the one to get right: it needs the scheduled
full run and a red-main alert in place before it goes live
(`references/test-selection.md`).

**We fixed git and caches.** Forcing git onto HTTP/1.1 fixed checkouts that
sometimes took over ten minutes, and keeping `node_modules` warm turned
installs into a quick reconcile (`references/git-and-caching.md`).

**We kept main honest.** A later merge never cancels a main run, someone
hears about it when main goes red, and a required check can't pass while
running zero tests (`references/guardrails.md`).

**We moved to current tools.** oxlint, oxfmt, oxc-based TS loaders and native
typecheckers instead of ESLint, Prettier, tsx and `tsc --noEmit`. Check that
the output matches on your own repo before you switch
(`references/tool-choices.md`; `references/stale-defaults.md` lists the
defaults agents still reach for).

**We moved from Blacksmith to Boat.** Boat's machines cost roughly a tenth
as much per minute, and because our runners stay up between jobs, a warm job
spends a second or two on setup instead of tens of seconds. Most of what's
left on the bill is machines waiting for work, so the warm pool follows
working hours. What's left of the slow tail is a runner's first job, so a
nightly job on main builds a warm snapshot with the dependencies and
toolchains already installed (`references/boat-runners.md`, with the
autoscaler in `scripts/boat-runners/`). Runner sizing and sharding are in
`references/runners.md`.

## Before you change anything

Find out how the runner provider bills (per minute rounded up, per second,
per vCPU), because that decides whether splitting a job across runners saves
money or only time. Ask whether the goal is cost, latency or both; some
advice flips depending on which. Get read access to recent runs (`gh run
list`, `gh run view --log`) and the billing page. And find out who watches
main: once PRs run less, some failures show up on main first.

Keep a log of every change with its before and after numbers and the run IDs
they came from. Runner noise is large, so one run against one run tells you
nothing.

## How to run it

1. Add per-job resource sampling and a timing report, and decide for each
   slow lane whether it's CPU-bound, waiting, or paying for setup.
2. Profile the exact command CI runs, ranked by CPU-seconds, and fix what's
   on top.
3. Add lane selection that runs everything when unsure, then per-test
   selection and the replay check. Set up the scheduled full run and the
   red-main alert first.
4. Fix git transport, checkout depth, the dependency cache and cache keys.
5. Swap tools after checking the output matches.
6. Size runners by what you're billed, then try reused sandbox runners.
7. Add the guardrail tests, so none of this gets undone later.

## Stop and ask before

- turning off any suite on PRs, or changing what runs when selection fails
- changing branch protection or required checks
- changing cancellation or concurrency on main or deploy workflows
- adding a paid service, or anything that costs money while idle, like an
  always-on runner pool
- letting a runner that PR jobs use hold deploy credentials
- deleting tests (show what each one checked and which test covers it now)

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
