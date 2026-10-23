# Stale defaults

Defaults that look reasonable, show up in templates, tutorials and agent
output, and cost the most. Agents trained on older material reach for these
first; check a proposed CI change against this list.

| Default | Why it's wrong now | Do this instead |
|---|---|---|
| ESLint for lint, Prettier for format | Rust ports run the same rules several times to an order of magnitude faster | oxlint and oxfmt (`tool-choices.md`) |
| `tsc --noEmit` to typecheck | Native checkers are several times to an order of magnitude faster | tsgo, `bun check` or tsrs, chosen on diagnostics parity (`tool-choices.md`) |
| Run TS tests through tsx, ts-node or esbuild-register | The loader is often the largest CPU item in the suite | oxc-node, an in-thread oxc loader, or native type stripping |
| One process per test file | Every file pays boot and module-graph cost again | One process per package or file group |
| `npm ci` with no cache, or a cache keyed on the lockfile | Cold installs are slow on any disk; a lockfile key goes cold several times a day | Keep the tree warm and reconcile on every run (`git-and-caching.md`) |
| Setup actions cache by default | Some disable caching off GitHub-hosted runners or look for a root lockfile you don't have | Read each setup step's log and set cache paths explicitly |
| A small helper job on `ubuntu-latest` in front of the real work | GitHub-hosted capacity on smaller plans saturates; a required light job can queue past its timeout and turn green PRs red. Each extra job also pays checkout and a rounded minute | Run light every-PR jobs on your own small runners, or fold them into the job that needs them |
| `actions/checkout` with defaults | Depth 1 is too shallow to diff a merge commit, a full tree is too much for a job that reads a few paths, and `fetch-depth: 0` fetches every branch | Pick depth, filter and sparse paths per job; keep the workspace on reused runners |
| Diff a PR against `github.event.pull_request.base.sha` | It lags main, so main's own changes read as the PR's | Diff against `HEAD^1` of the merge commit |
| git over HTTP/2 always works | Stream resets make some checkouts take many minutes and restart from scratch | `GIT_CONFIG_*` env to force HTTP/1.1 |
| Run every test on every PR | Most heavy-lane red on PRs is flake and infrastructure; real catches are rare | Fail-closed selection plus a scheduled full run (`test-selection.md`) |
| `cancel-in-progress: true` everywhere | On a busy main it cancels nearly every main run | Cancel PR runs only; test the property |
| Jest's per-file isolation model | Per-file processes are the cost | Process reuse; measure CPU-seconds |
| A bigger runner is faster, so it's better | Billing is cores times rounded minutes; small selected subsets on large runners waste most of the minute | Size per lane by billed minutes (`runners.md`) |
| Split a job across more parallel runners | Each runner pays setup and a rounded minute | Split only when latency is the goal and the work dwarfs setup |
| Raise the timeout when a test flakes | Flakes on saturated runners are wall-clock bounds; bigger budgets don't fix them | Stub clocks, wait for exact predicates, cut needless work |
| Retry and quarantine flaky tests | Hanging tests burn their whole timeout on every retry; quarantined tests rot | Fix hangs; retry only with traces, and expire quarantines |
| A merge queue fixes main stability | Every batch pays the slowest suite, serially, and flaky suites make it bisect | Scheduled full runs, red-main alerts, deploy coalescing |
| Cache TypeScript incremental state between runs | Depends on the checker: some seeds are slower than cold when a global type changes | Measure seeded against cold; never replay PR state on main |
| Green CI means production builds | CI installs everything; images install a filtered subset | Smoke-build each image whose install differs |
| Docker layer caching just works | Per-deploy values in an early layer's key disable reuse | Expose only what each step needs |
| Judge a change by one run's wall time | Runner noise is large | Medians over several runs, CPU-seconds, confirmation on another runner |
| A runner provider's own CI recipe is the cheapest way to use it | Recipes that drive the sandbox from a GitHub-hosted job pay for both machines | Register sandboxes as self-hosted runners via a webhook autoscaler (`boat-runners.md`) |
| One fresh VM per job is the safe default for self-hosted runners | Fresh machines pay full setup every job; start limits cap jobs per day | Reuse runners for PR jobs, fresh single-use runners for privileged jobs (`boat-runners.md`) |
