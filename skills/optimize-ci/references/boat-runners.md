# Reused sandbox runners on Boat

[Boat](https://docs.boat.dev) rents fast Linux sandboxes by the second through
an API, with named snapshots to start from. Registered as GitHub Actions
self-hosted runners and reused across jobs, they can take every Linux x64
job off a managed runner provider.

Reused self-hosted runners are only safe for repositories where everyone who
can open a PR that runs workflows is trusted: private repositories, or public
ones that require approval before workflows run on fork PRs. A PR job can
leave anything behind on a reused machine.

## Before and after

Ballparks for the same workflows at a few thousand jobs a day, with a warm
pool during working hours (described below):

| | Managed runner provider | Reused Boat runners |
|---|---|---|
| Runner cost per day | A few tens of dollars | Around ten dollars, most of it the warm pool and the plan fee; job compute alone is roughly an order of magnitude cheaper |
| Checkout plus install on a warm job | Several seconds to tens of seconds (disk mounts, mirror checkout, install reconcile) | A second or two each |
| Same job on a fresh machine | About a minute or two of setup | Similar or worse (a fresh sandbox's snapshot hydrates lazily); avoid it |
| Queue wait for a job | Seconds | Near zero on an idle runner; tens of seconds when a new runner has to start |
| Heavy test lanes | Baseline | Comparable per core; the win is setup and price, not test bodies |

Where the savings come from: per-second billing on cheap fast hardware, and
runners that keep their workspace, git objects, `node_modules` and package
store on local disk between jobs, so most of setup disappears. Where they
don't: a job on a freshly started sandbox pays full setup and then some,
which is why the design reuses runners and keeps a warm baseline.

## Don't use a GitHub-hosted job to drive the sandbox

The obvious recipe runs a small job on `ubuntu-latest` that creates a
sandbox and runs the real work inside it. That pays for two machines per job:
at thousands of jobs a day the GitHub-hosted minutes cost about what the
sandboxes save. A "dispatcher" job per real job has the same problem. Register
sandboxes as self-hosted runners instead, started by a webhook.

## Architecture

The shape of [philips-labs/terraform-aws-github-runner](https://github.com/philips-labs/terraform-aws-github-runner)'s
reusable-runner mode, with Boat sandboxes in place of EC2.
`scripts/boat-runners/` has a working implementation: one Lambda function,
an SQS queue, a schedule and an OpenTofu stack.

```
GitHub App (workflow_job webhook)
   │  queued job with a boat-* label
   ▼
Lambda function URL ── verify signature ──▶ SQS (short delay)
                                              │
                                              ▼
                          job still queued? idle runner with its label?
                             yes: put the message back, recheck later
                             no:  create a sandbox that registers a runner
                                              │
schedule (every couple of minutes) ───────────┤
   keep a warm baseline per label in working hours, drain it outside,
   replace old idle baseline runners, delete stale registrations
```

- **Labels** map to sizes: `boat-2vcpu`, `boat-4vcpu`, `boat-8vcpu`,
  `boat-16vcpu`. Workflows use `runs-on: boat-4vcpu`.
- **A GitHub App** with Administration write (to mint runner registration
  tokens and delete stale runners) and Actions read, subscribed to
  `workflow_job`, installed on the one repository the controller serves (it
  ignores jobs from others; run one controller per repository).
- **The webhook** queues each `queued` job with a `boat-*` label on SQS with
  a short delay, so an idle runner gets the first chance to claim it.
- **The worker** reads each message. If the job is no longer queued, done.
  If an idle runner with that label exists, the message goes back to the
  queue and is checked again shortly; a burst of N queued jobs with no idle
  runners starts N. Otherwise it creates a sandbox from the runner snapshot
  whose setup script registers a reusable runner. Errors (start limits, no
  capacity) also put the message back, and after enough tries it lands in a
  dead-letter queue that alarms.
- **Burst runners** stop themselves after a stretch without a job: long in
  working hours (half an hour), short off hours (a few minutes). Created
  with snapshots disabled, a stopped sandbox is erased, so nothing lingers or
  bills.
- **A baseline** of warm runners per label runs during working hours and
  drains outside them, idle runners first and never a busy one. Keep it
  small: one warm runner per busy size covers the start of the day, and
  bursts that idle long in working hours keep warmth in step with traffic.
  At per-second prices nearly all of the bill is idle time, so a large
  always-on pool is the most expensive way to stay warm. Idle baseline runners older than a few hours are
  replaced, which rolls out snapshot and boot-script changes on its own.
- **Its own state.** Keep the controller's infrastructure apart from the
  production stack, so a production outage or a production apply never
  blocks CI capacity.

Use the webhook, not polling. Polling the GitHub API for queued jobs costs
too many requests once dozens of runs are in flight.

## Keep the workspace between jobs

A reused runner keeps its workspace. With `actions/checkout`'s default
`clean: true`, checkout runs `git clean -ffdx` and deletes `node_modules`
every job, and installs stay slow. Do this instead:

- Check out with `clean: false`.
- Install a job-started hook on the runner (`ACTIONS_RUNNER_HOOK_JOB_STARTED`)
  that runs `git clean -ffdxq -e node_modules -e .turbo` in the workspace
  (exclude whatever your build keeps warm), removes every docker container on
  the machine, and clears the temp outputs your jobs write (the example
  clears `$TMPDIR/ci-*`). This assumes the machine runs nothing but this
  runner. Stale build output and leftover files can't mask a failure,
  and the dependency tree stays warm.
- Keep the frozen install and the prune step on every job
  (`git-and-caching.md`): the tree rolls across lockfiles.

With that, a warm job's checkout and install take a second or two each.

## Reused runners carry state: privileged jobs get fresh machines

A reused runner keeps whatever earlier jobs left: `node_modules`, the tool
cache, anything written with passwordless sudo under `/usr/local`. PR jobs
run arbitrary code. A deploy job that later runs on the same machine runs
whatever a PR job planted.

Give each size a `-once` label (`boat-4vcpu-once`): a fresh sandbox that
registers an ephemeral runner (`config.sh --ephemeral`), runs one job and is
erased. Put every job that holds credentials a PR can't otherwise reach on a
`-once` label: deploys, migrations against production databases, image
publishing, environment-protected jobs, and `pull_request_target` jobs that
use a privileged token. Add a test that every job with an `environment:`
runs on a `-once` label.

PR-triggered jobs that read ordinary repository secrets gain little from
isolation, because a PR can already read those by editing a workflow. The
boundary that matters is environment-scoped and deploy-only credentials.

`-once` jobs pay the cold start every time. Deploys are rare enough that
this is fine.

## The runner snapshot

Build a named snapshot with the Actions runner unpacked at
`~/actions-runner`, its dependencies installed, and the tools your jobs would
otherwise install per run (a database client, a cloud CLI). Keep it lean: a
large snapshot pre-filled with a package cache made fresh sandboxes slower,
because a named snapshot reaches a new machine lazily. Let each reused runner
warm its own cache on local disk. Saving under the same name replaces the
snapshot, and the baseline's age-based replacement picks it up.

`scripts/boat-runners/build-runner-snapshot.sh` builds one.

## Start limits shape the design

Boat limits sandbox creation per minute, per hour and per day by plan
(`GET /api/v1/limits`). One sandbox per job is impossible at thousands of
jobs a day, most of them short. Reused runners start sandboxes per burst,
not per job, which keeps starts well inside the limits. Cap concurrent
starts in the worker so a burst can't exceed the per-minute limit.

## Gotchas

- **Just-in-time runner configs carry only the labels you pass.** Add
  `self-hosted` explicitly, or jobs that ask for `[self-hosted, boat-4vcpu]`
  never match and the runner sits idle. `config.sh` adds `self-hosted`,
  `Linux` and `X64` by itself unless told not to.
- **Keep the registration token away from jobs.** Boat puts the sandbox's
  `env` into the setup process's environment, and everything it starts
  inherits it. A registration token there lets a job register its own
  runner with any label, including a `-once` one. Register, then `exec` the
  runner loop under `env -u` so no long-lived process ever had the token.
- **A runner can be taken by a different job.** A runner started for one
  queued job goes to whichever job with that label GitHub assigns. Keep
  watching the job that triggered the start, and start another runner if
  it is still queued after a boot grace period.
- **`boat new --json` streams one JSON line per state change.** Take the
  sandbox id from the `ready` event.
- **The setup script runs in the background as the sandbox user after the
  sandbox is ready.** A good place to configure and start the runner.
- **A sandbox can stop itself** with the in-sandbox CLI and its own id; it
  can't delete itself. Created with snapshots disabled, stopping is enough.
- **Stop the runner listener with TERM.** Background processes in a
  non-interactive shell ignore SIGINT.
- **The idle watchdog must treat a running job as busy** and recheck after
  its loop, or a job that starts at the end of the idle window gets killed
  mid-run.
- **Match only your own runner's worker process.** A pattern like
  `pgrep -f Runner.Worker` also matches the worker of a CI job running on the
  same machine (your controller's own tests, if CI runs on these runners).
  Match the runner's full install path.
- **Count idle time in whole seconds and poll every couple of seconds.**
  Tests of the watchdog need bounds that allow for both.
- **Clean up registrations carefully.** A booting runner isn't registered
  yet; delete only offline registrations whose sandbox is gone. Deregister a
  baseline runner before stopping its sandbox, since GitHub refuses to delete
  a runner that just took a job.
- **Memory overcommit.** Linters with mmap-based allocator pools (oxlint)
  reserve more virtual memory than RAM plus swap on small sizes, and the
  default heuristic refuses. Set `vm.overcommit_memory=1` at boot.
- **The base image differs from managed runner images** (a newer Ubuntu, no
  preinstalled language toolchains beyond the basics). Expect a few missing
  tools on the first runs.
- **x64 Linux only.** macOS and arm64 jobs stay on another provider.
- **Keep a heartbeat job on runners you don't operate**, so it can still
  report when your runners are down. A guard job that checks the integrity
  of other CI jobs belongs on a machine those jobs can't touch.
- **GitHub App setup in a browser**: the manifest flow asks for sudo-mode
  re-authentication, and the private key download can be blocked by the
  browser's multiple-download guard. Write each secret to its store and
  confirm the write before deleting the local copy.

## Moving workflows over

Start with a pilot workflow that runs the same small job on both providers
and compare a few dozen runs, fresh and warm. Then move labels in one change
and fix what the first runs surface. Typical fixes:

| Symptom | Fix |
|---|---|
| Installs slow every job | `clean: false` on checkout plus the job-started hook |
| `setup-dotnet` (or similar) can't write to `/usr/share/...` | Install into the runner's tool cache directory |
| A sparse checkout hides files from the next job on that runner | Check sparse jobs out into their own subdirectory |
| A `pip install` changes a later job's Python | A virtualenv per job; never install into the shared tool-cache interpreter |
| Database readiness probes missing (`pg_isready`) | Probe the port over TCP, or add the client to the snapshot |
| Test reporters append to files in `/tmp` and a later job reads the stale lines | Clear job outputs in the hook, or write under the workspace |
| Service containers left running | Remove containers in the hook |
| Image builds need buildx | Add the setup step explicitly |
| A large dependency cache restore step | Delete it; the runner already has the tree |
| A dev server killed with exit 137 | A bigger size |

Then lock it in with tests over the workflow files: every PR job uses a
`boat-*` label, every checkout uses `clean: false`, no steps from the
previous provider remain, every `environment:` job uses `-once`, sparse
checkouts use their own directory, and `pip install` runs in a virtualenv.
