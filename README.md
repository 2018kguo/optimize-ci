<h1 align="center">optimize-ci</h1>
<p align="center">A practical playbook for faster, cheaper CI.</p>
<p align="center">
  <a href="#use-it">Use the skill</a> ·
  <a href="#what-we-changed">The approach</a> ·
  <a href="#whats-in-it">What is included</a>
</p>

A playbook for making CI on a busy repository faster and cheaper without
letting more bugs through. It comes from a TypeScript monorepo where coding
agents open a lot of the PRs and CI runs thousands of jobs a day. CI now
costs about a tenth of what it did, and a typical PR is checked in a couple
of minutes. Runner spend alone went from a few tens of dollars a day to a few
dollars. It includes the order the work paid off in, the checks that keep
each change from undoing itself, the defaults agents still reach for
that cost the most, and the runner autoscaler we moved to when we left
Blacksmith for [Boat](https://docs.boat.dev).

Our stack was Bun, Node, TypeScript, Turbo, Vitest, node:test, bun test,
Playwright, Postgres and GitHub Actions. If yours is different, most of it
still applies: measuring, profiling the tests, picking tests per diff, git
and cache fixes and the guardrails don't depend on the language or the
runner provider. The skill starts by measuring your CI and working out
which of its steps your setup needs.

## Use it

```bash
npx skills add 2018kguo/optimize-ci
```

It never loads on its own. Start it when you want it:

```
/optimize-ci
```

A good first request keeps everything read-only until you've seen the plan:

```
/optimize-ci measure where our CI time and money went over the last week
and suggest the first three changes. Don't change anything yet.
```

Narrower requests work too:

```
/optimize-ci profile our backend test lane and tell me what the CPU is
spent on.
```

## What we changed

Most of it is ordinary, and easy to skip when you're busy: run a job only
when its inputs changed, cancel superseded PR runs, cache between runs, shard
by measured test time, run the cheap static checks first, catch format and
lint failures in pre-commit and pre-push hooks, and put a timeout on every
job.

The changes that made the real difference:

- **We stopped running every test on every PR.** Static checks always run.
  For tests, we walk the import graph from the diff and ask a decision model
  (a fast classifier like Jev, on OpenRouter's Decisions API, that answers
  yes/no questions with a probability) which tests actually execute the changed code, folders first
  and then single tests. A replay of real past failures checks that we still
  catch them, and the full suite runs on a schedule.
- **We profiled the tests and cut what didn't earn its keep.** TS loaders and
  a fresh process per test file cost more than the tests did. Then we deleted
  tests that re-checked what others covered and replaced real sleeps with
  fake clocks.
- **We kept main honest.** Main runs never get cancelled, someone hears when
  main goes red, and a required check can't pass while running zero tests.
- **We moved to current tools:** oxlint, oxfmt, oxc loaders and native
  typecheckers instead of ESLint, Prettier, tsx and `tsc --noEmit`.
- **We fixed git and caches.** Forcing git onto HTTP/1.1 fixed checkouts that
  sometimes took ten minutes.
- **We moved from Blacksmith to Boat.** Its machines are roughly an order of
  magnitude cheaper per minute, and our runners stay up between jobs, so a
  warm job spends a second or two on checkout and install.

## Reading it yourself

To get the whole picture in about ten minutes, read "What moved the needle"
and "Stop and ask before" in `SKILL.md`, the table in `stale-defaults.md`,
and the first two sections of `boat-runners.md`. Everything else is detail
for when you reach that step.

## What's in it

`skills/optimize-ci/SKILL.md` is the entry point: the order of the work,
what to find out before changing anything, where an agent should stop and
ask, and the checks we'd keep no matter what.

The `references` folder holds the detail for each step:

- `measure.md` covers per-job CPU and memory sampling, a timing report over
  recent runs, and how to read noisy runner numbers
- `test-cpu.md` covers profiling the exact command CI runs, where a
  TypeScript suite's CPU goes (loaders, process boot, harness setup, real
  sleeps), deleting duplicate tests, and why most flakes are the runner
- `test-selection.md` covers skipping lanes a diff can't reach, picking tests
  with an import graph and a decision model, the replay that pins recall, the
  scheduled full run, and red-main alerts
- `git-and-caching.md` covers git over HTTP/1.1, checkout depth per job,
  keeping the dependency tree warm, cache keys that never hit, Turbo, the
  local hooks and Docker layer caching
- `runners.md` covers how billing changes the math, sizing a lane, balancing
  shards and running setup steps in parallel
- `tool-choices.md` covers the linter, formatter, TS loader, typechecker and
  test runner swaps, each with the parity check to run first
- `stale-defaults.md` is one table of the defaults agents still reach for,
  why each one costs you now, and what to do instead
- `guardrails.md` covers the tests that keep all of this from being undone:
  zero-test lanes, test files nothing runs, main cancellation, recall, drift
  ledgers
- `boat-runners.md` covers running GitHub Actions on Boat: why it's cheaper
  than a managed provider, the lazy disk, keeping the workspace between jobs,
  fresh machines for deploy jobs, what breaks when you move over, and what it
  costs

The `scripts/boat-runners` folder is the autoscaler we run, with tests:

- `index.mjs` is one Lambda function that takes GitHub's `workflow_job`
  webhook, starts Boat sandboxes that register as runners, and on a schedule
  keeps a small warm pool in working hours, replaces old runners, re-queues
  jobs whose webhook never arrived, refreshes every runner's auto-stop, and
  stops machines that lost their runner
- `index.test.mjs` runs the real boot script against a stub runner, so the
  idle watchdog, the hydration wait and the token handling are tested end to
  end
- `main.tf` is the OpenTofu stack: secret, queues, function URL, schedule and
  a dead-letter alarm
- `build-runner-snapshot.sh` builds the snapshot runners start from
- `README.md` is how to stand it up, tune it and check that it works

The test selector itself isn't included. It is tied to one repository's
layout, lanes and history, and `test-selection.md` describes it in enough
detail to build your own, which goes better than adapting someone else's.

## License

MIT
