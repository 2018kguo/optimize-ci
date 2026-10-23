---
name: optimize-ci
description: Playbook for making a busy CI pipeline faster and cheaper without letting regressions through - measuring first, cutting test CPU at the source, selecting tests per diff with a fail-closed selector, fixing git and cache setup, choosing current tools, and running jobs on reused sandbox runners. Built from months of work on a large TypeScript monorepo.
disable-model-invocation: true
---

# Optimize CI

This playbook makes a CI pipeline faster and cheaper while keeping what it
proves. It comes from a large TypeScript monorepo with a busy main branch,
many agent-written PRs a day and thousands of CI jobs a day. CI there went
from several hundred dollars a day to around ten, and typical PR runs from
many minutes to a couple.

Terms used throughout: a **lane** is one suite or group of jobs a workflow
can run or skip (backend tests, web tests, end-to-end); an **oracle** is a
test that pins one invariant; **Boat** ([docs.boat.dev](https://docs.boat.dev))
is a sandbox provider used here for self-hosted runners.

The levers, roughly in the order they paid off:

1. Measure. Most early guesses about where the time went were wrong.
2. Cut the work itself: process and loader boot, duplicate tests, real sleeps.
3. Stop running work the diff can't affect, with a selector that fails closed,
   and run the full suite on a schedule instead.
4. Fix the plumbing: git transport, checkout depth, dependency caches, cache
   keys.
5. Use current tools. Many defaults an agent or a tutorial reaches for are
   several times slower than what replaced them.
6. Put jobs on cheaper, warmer machines. Reused sandbox runners turned a
   job that spent minutes on setup into one that spends seconds, and cut the
   daily runner bill from a few tens of dollars to around ten.

Each lever has a reference with the detail. `references/stale-defaults.md` is
the quickest read: the defaults that look reasonable and cost the most.

## Before you start

Check what you are working with, and ask for what's missing:

- The CI system and runner provider, and how they bill: per minute rounded,
  per second, per vCPU, or per machine-hour. Billing shape decides whether a
  parallel split saves money or only time.
- Whether there is a cost or a latency target, or both. Several decisions
  below reverse depending on which one matters (`references/runners.md`).
- Read access to recent runs (`gh run list`, `gh run view --log`, or the
  equivalent) and to the billing page if one exists.
- Who owns the main branch's health. Thinning PR CI moves some failures to
  main, so someone has to hear when main goes red.

## How to run it

Keep a log of every change with the before and after measurement and the
run IDs it came from. Runner noise is large enough that a change without a
before-and-after comparison across several runs is a guess.

1. Measure (`references/measure.md`). Add per-job CPU, memory and pressure
   sampling and a per-run timing report: queue time, setup, each step, the
   critical path. Decide for each slow lane whether it is CPU-bound, waiting
   on something, or paying setup. Don't change anything until this exists.
2. Cut test CPU at the source (`references/test-cpu.md`). Profile the exact
   CI command's whole process tree, rank by CPU-seconds, and fix the owning
   seam. In TypeScript suites this is usually loader and process boot.
3. Select per diff (`references/test-selection.md`). A fail-closed lane
   selector first, then per-test selection from an import graph filtered by
   a cheap classifier model, guarded by a replay of real historical catches.
   This needs the scheduled full run and red-main alerting from the same
   reference before it goes live.
4. Fix git and caches (`references/git-and-caching.md`). Transport,
   checkout depth and filters, a warm dependency tree, cache keys and cache
   writers.
5. Replace stale tools (`references/tool-choices.md`,
   `references/stale-defaults.md`). Prove parity on your own tree before
   switching.
6. Move runners (`references/runners.md`, `references/boat-runners.md`).
   Size runners by billed minutes, then consider reused sandbox runners.
   `scripts/boat-runners/` holds a working autoscaler for Boat sandboxes.
7. Lock it in (`references/guardrails.md`). Each win above has a way to
   quietly undo itself. A test that asserts the behavior keeps it.

## Where to stop and ask the person you're working with

- Turning off any suite on PRs, or changing what a failed selection runs
- Changing branch protection or which checks are required
- Changing cancellation or concurrency for main or deploy workflows
- Adding a paid service (a classifier model, a runner provider) or a
  standing cost such as an always-on runner pool
- Giving any runner that PR jobs use access to deploy credentials
- Deleting tests. Show what each one proved and which other test proves it
  now.

## The checks that matter most

| Check | How | Good looks like |
|---|---|---|
| A required lane can't pass while running nothing | A wrapper that parses the runner's summary on every required test command | Zero executed tests fails the job |
| Main runs are never cancelled by a later merge | A test over the workflow files | Only PR runs cancel in progress |
| A crashed or skipped selector runs more, never less | Kill the selector in a test run | The lanes it gates still run (or a declared smoke set does), with a loud warning |
| Selection still catches real failures | A replay of recorded historical catches | Recall stays at or above its floor |
| The full suite still runs | The scheduled run's history | A full run on main within each cadence window |
| Someone hears when main goes red | The alert's last firing | A message on each green-to-red transition, repeating while red |
| No PR job writes something a trusted job later runs | Cache and disk write rules, runner labels | Only main writes shared caches; deploy jobs use fresh machines |
| Timing claims hold | Medians across several runs | Same direction on independent runners |
