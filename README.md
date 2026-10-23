# optimize-ci

Coding agents open a lot of PRs, and every one of them runs CI. On our
TypeScript monorepo that made CI both slow and expensive, so we spent some
time on it. CI now costs about a tenth of what it did, and a typical PR is
checked in a couple of minutes. This repo is everything we learned, written
as a skill an agent can follow on your own repo.

```bash
npx skills add 2018kguo/optimize-ci
```

## What it covers

It starts with the table stakes, because they're cheap and easy to skip:
only running jobs whose inputs changed, cancelling superseded PR runs,
caching between runs, sharding by measured test time, running the static
checks first, pre-commit and pre-push hooks, and a timeout on every job.

Then the changes that made the real difference for us:

- **We stopped running every test on every PR.** Static checks always run.
  For tests, we walk the import graph from the diff and ask a decision model
  (a fast classifier like Jev that answers yes/no questions with a
  probability) which tests actually execute the changed code, folders first
  and then single tests. A replay of real past failures checks we still catch
  them, and the full suite runs on a schedule.
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
- **We moved from Blacksmith to [Boat](https://docs.boat.dev).** Machine time
  costs roughly a tenth as much, and our runners stay up between jobs, so a
  warm job spends a second or two on setup. The autoscaler we run is in this
  repo.

Our stack is Bun, Node 24, TypeScript, Turbo, Vitest, node:test, bun test,
Playwright, Postgres and GitHub Actions. If yours looks similar, most of this
carries over as is; the rest is general enough to adapt.

## Using it

The skill only runs when you ask for it (`/optimize-ci`). A good first request
keeps it read-only until you've seen the plan:

```
/optimize-ci measure where our CI time and money went over the last week
and suggest the first three changes. Don't change anything yet.
```

## What's in it

`skills/optimize-ci/SKILL.md` is the entry point: the order we did things
in, when the agent should stop and ask, and the checks we'd keep. The details
live in `references/`:

- `measure.md` covers per-job CPU and memory sampling, timing reports, and
  reading noisy numbers.
- `test-cpu.md` covers profiling what CI actually runs, where TypeScript
  suites spend their CPU, deleting duplicate tests, and flakes.
- `test-selection.md` covers lane selection, picking tests with an import
  graph and a decision model, the replay check, scheduled full runs, and
  red-main alerts.
- `git-and-caching.md` covers git over HTTP/1.1, checkout depth, keeping
  dependencies warm, and cache keys that never hit.
- `tool-choices.md` and `stale-defaults.md` cover the tools, and the defaults
  agents still reach for.
- `runners.md` covers billing math, sizing and sharding.
- `boat-runners.md` covers running GitHub Actions on Boat: why it's cheaper,
  the lazy disk, fresh machines for deploy jobs, and the mistakes to avoid.
- `guardrails.md` covers the tests that keep all of this from getting undone.

`scripts/boat-runners/` is the runner autoscaler we use: a Lambda function, a
queue and a schedule, as an OpenTofu stack, with tests and a setup guide.

## License

MIT
