# optimize-ci

A playbook for making a busy CI pipeline faster and cheaper without letting
regressions through. It comes from months of work on a large TypeScript
monorepo with a busy main branch and many agent-written PRs a day, where CI
went from several hundred dollars a day to around ten. It covers what
actually moved the numbers:

- measuring first, and reading noisy runner numbers correctly
- cutting test CPU at the source (loader and process boot, duplicate tests,
  real sleeps)
- selecting tests per diff with a fail-closed lane selector and an import
  graph filtered by a cheap classifier model, guarded by a replay of real
  historical catches, with a scheduled full run and red-main alerts as the
  backstop
- git transport and checkout fixes, keeping dependency trees warm, and cache
  keys that silently never hit
- current tool choices (oxlint, oxfmt, oxc-based TS loaders, native
  typecheckers) and a list of stale defaults agents still reach for
- sizing runners by billed minutes, and running jobs on reused
  [Boat](https://docs.boat.dev) sandbox runners: a daily runner bill of
  around ten dollars instead of a few tens, with warm jobs spending seconds
  on setup instead of minutes

```bash
npx skills add 2018kguo/optimize-ci
```

It never loads on its own. Start it when you want it:

```
/optimize-ci
```

A good first request keeps everything read-only until you've seen the plan:

```
/optimize-ci measure where our CI time and money go over the last week of
runs and propose the first three changes. Don't change anything yet.
```

## Reading it yourself

For the quickest value, read `references/stale-defaults.md` (one table) and
the lever list and checks in `SKILL.md`. Then read the reference for whichever
lever your measurements point to.

## What's in it

`skills/optimize-ci/SKILL.md` is the entry point: the order of the work,
where an agent should stop and ask, and the checks that matter most.

The `references` folder:

- `measure.md`: per-job CPU, memory and pressure; per-run timing reports;
  reading noise
- `test-cpu.md`: profiling the CI command's process tree and where TypeScript
  suites spend CPU; flakes
- `test-selection.md`: fail-closed lane selection, graph plus classifier test
  selection, recall replays, failure modes, main and scheduled runs,
  cancellation, alerts, debounces and merge queues
- `git-and-caching.md`: HTTP/1.1 for git, checkout depth and filters, warm
  dependency trees, cache writers and trust, keys that never hit, task
  runner and Docker caches
- `tool-choices.md`: lint, format, TS execution, typecheckers, package
  manager, test runners
- `stale-defaults.md`: defaults that look reasonable and cost the most
- `runners.md`: billing math, sizing, sharding, parallel setup steps
- `boat-runners.md`: reused sandbox runners on Boat, before and after,
  architecture, single-use runners for privileged jobs, gotchas, moving
  workflows over
- `guardrails.md`: tests that keep each win from quietly undoing itself

`scripts/boat-runners/` is a working runner autoscaler for Boat on AWS (a
Lambda function, SQS and a schedule, as an OpenTofu stack), with tests and a
setup guide.

## License

MIT
