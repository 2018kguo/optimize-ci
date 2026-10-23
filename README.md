# optimize-ci

How we made CI on a busy TypeScript monorepo about 10x cheaper and a lot
faster, written up as a skill an agent can follow on your repo.

CI is on a lot of engineers' minds right now. Agents open far more PRs than
people did, and every one of them runs the pipeline. Ours got slow and
expensive, so we went after it. What made the difference:

- **Running only what the diff can affect.** Walk the import graph from the
  diff, then ask a decision model (a fast classifier that returns a
  probability per yes/no question, like Jev) which tests actually run the
  changed code: folders first, then single tests inside the folders it
  keeps. A replay of real past failures checks recall, and the full suite
  still runs every few hours.
- **Profiling the tests and cutting what didn't earn its keep.** We profiled
  the exact commands CI runs and fixed whatever sat on top: TS loaders and a
  process per test file cost more than the tests themselves. Then we deleted
  tests that re-checked what another test already covered, replaced real
  sleeps with fake clocks, and fixed slow helpers instead of shrinking
  fixtures.
- **Counting what each suite actually caught.** Most of the red on PRs from
  the heavy suites was flakes and infrastructure, which is what made it safe
  to stop running them on every PR.
- **Keeping main honest.** Main runs never get cancelled by a later merge, a
  message goes out when main goes red, a required check can't pass while
  running zero tests, and a quick pre-push check catches the cheap failures
  before they use a runner.
- **Newer tools.** oxlint, oxfmt, oxc-based loaders and native typecheckers
  instead of ESLint, Prettier, tsx and `tsc --noEmit`.
- **Git and caches.** HTTP/1.1 for git fixed checkouts that sometimes took
  ten minutes, and a warm `node_modules` made installs take seconds.
- **Moving from Blacksmith to [Boat](https://docs.boat.dev).** Reused sandbox
  runners keep the workspace between jobs, so setup takes a second or two,
  and runner time costs about a tenth as much. The autoscaler we use is in
  the repo.

Our stack: Bun, Node 24, TypeScript, Turbo, Vitest, node:test, bun test,
Playwright, Postgres, GitHub Actions, Boat runners, and AWS Lambda plus
OpenTofu for the runner autoscaler. If yours looks similar, most of this
carries over as is.

```bash
npx skills add 2018kguo/optimize-ci
```

It only runs when you ask for it:

```
/optimize-ci
```

A good first request keeps it read-only until you've seen the plan:

```
/optimize-ci measure where our CI time and money went over the last week
and suggest the first three changes. Don't change anything yet.
```

## What's in it

`skills/optimize-ci/SKILL.md` is the entry point: the order we did things
in, when the agent should stop and ask, and the checks we'd keep.

The references:

- `measure.md`: per-job CPU and memory sampling, timing reports, reading
  noisy numbers
- `test-cpu.md`: profiling what CI actually runs, where TypeScript test
  suites spend their CPU, deleting duplicate and low-value tests, flakes
- `test-selection.md`: lane selection, picking tests with an import graph and
  a model, the replay check, scheduled full runs, never cancelling main,
  red-main alerts
- `git-and-caching.md`: HTTP/1.1 for git, checkout depth and sparse
  checkouts, keeping dependencies warm, cache keys that never hit, Turbo and
  Docker caches
- `tool-choices.md`: lint, format, running TS, typecheckers, test runners
- `stale-defaults.md`: one table of defaults that cost the most
- `runners.md`: billing math, sizing, sharding, running setup in parallel
- `boat-runners.md`: the Boat setup, before and after, single-use runners
  for deploy jobs, gotchas, moving workflows over
- `guardrails.md`: tests that keep all of the above from getting undone

`scripts/boat-runners/` is the runner autoscaler: a Lambda function, SQS and
a schedule, as an OpenTofu stack, with tests and a setup guide.

## License

MIT
