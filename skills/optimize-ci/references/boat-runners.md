# Reused sandbox runners on Boat

[Boat](https://docs.boat.dev) rents full root Ubuntu machines that are ready in
seconds, billed per second, with named snapshots to start new machines from.
We moved every Linux x64 job from Blacksmith to Boat sandboxes registered as
GitHub Actions runners.

Reused self-hosted runners are only safe where everyone who can trigger a
workflow is trusted: a private repository, or a public one that requires
approval before workflows run on fork PRs. A PR job can leave anything
behind on a reused machine.

## 1. Before and after

Ballparks for the same workflows at a few thousand jobs a day:

| | Blacksmith | Reused Boat runners |
|---|---|---|
| Runner cost per day (machine time) | A few tens of dollars | A few dollars: a small warm pool plus job time, which alone is roughly an order of magnitude cheaper |
| Checkout plus install on a warm job | Several seconds to tens of seconds | A second or two each |
| Same job on a fresh machine | A minute or two of setup | Similar or worse, because the disk arrives lazily (section 3) |
| Queue wait | Seconds | Near zero on an idle runner; tens of seconds when a new one has to start |
| Heavy test lanes | Baseline | About the same per core |

Costs are machine time. Boat's plan fee comes back as sandbox time.

### Why not run CI on any machine?

You can, and that's most of the point. Nothing here depends on a shared
drive. Three things made Boat worth it for us.

The first is price. Per vCPU-minute, Boat's machines cost roughly an order of
magnitude less than Blacksmith's, billed per second with no rounding up to
the minute.

The second is that the runner keeps its own disk. A managed provider starts a
fresh VM for every job and mounts a cached copy of your dependencies, which
is fast, but every job still pays to check out, mount and reconcile. Our
runners stay up and take job after job on the same local disk, so a warm job
finds the repo, `node_modules` and build caches already there.

The third is that machines come from an API in seconds, from a snapshot. The
autoscaler is one small Lambda function, and there is no fleet to patch or
keep warm overnight. If you already run your own always-on boxes, you get
most of the first two there; the trade is that you manage capacity and pay
for idle machines. Boat is the same idea with machines you rent by the second.

A job on a freshly started sandbox gets none of the second benefit, which is
why the design below reuses runners.

## 2. Two ways to run CI on Boat

**One sandbox per job.** Boat documents a CI recipe: install your toolchain
once and save it as a named snapshot, then in your workflow create a sandbox
from it, copy the code in, run the tests with `boat exec` (it returns their
exit code), copy reports out, and delete the sandbox in a step that always
runs. `boat run --from <snapshot> --push . -- <command>` does all of it in one
line. Start here: it takes minutes to set up, and the sandbox can be much
bigger than your usual runner.

It has two costs at scale. Every job still occupies a GitHub-hosted runner
while it waits on the sandbox, so you pay for two machines. And every job
starts a sandbox, which runs into Boat's start limits on a busy day.

**Sandboxes as GitHub runners.** The whole job runs on the sandbox, started
by a webhook. This is what the rest of this file covers, and what
`scripts/boat-runners/` implements: one Lambda function, an SQS queue, a
schedule and an OpenTofu stack, in the shape of
[philips-labs/terraform-aws-github-runner](https://github.com/philips-labs/terraform-aws-github-runner)'s
reusable-runner mode.

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

- **Labels** map to sizes: `boat-2vcpu` to `boat-16vcpu`, plus a `-once`
  form of each (section 5).
- **A GitHub App** with Administration write (registration tokens, removing
  stale runners) and Actions read, subscribed to `workflow_job`, installed on
  the one repository the controller serves.
- **The worker** checks each queued job. If an idle runner with its label
  exists, it checks again shortly. If not, it starts a sandbox whose setup
  script registers a runner, and keeps watching the job until it starts.
  Errors put the message back; after enough tries it lands in a dead-letter
  queue that alarms.
- **Burst runners** stop themselves after a stretch without a job: half an
  hour in working hours, a few minutes outside them. A sandbox created
  without snapshots is erased when it stops.
- **A small baseline** (one warm runner per busy size) covers the start of
  the day and drains at night. Nearly all of the bill is idle time, so a big
  always-on pool is the most expensive way to stay warm. Idle baseline
  runners older than a few hours are replaced, which rolls out a new snapshot
  on its own.
- **Its own state.** Keep the controller apart from your production stack,
  so a production outage or apply never blocks CI.

## 3. Understand the lazy disk

This is the one thing to understand about Boat before designing anything.

A create from a named snapshot, a fork and a resume all land on a new host,
and the disk is restored lazily. The sandbox is ready in seconds and every
file is visible, but the content streams in behind it, and a file you read is
fetched first. `hydrated` turns true on the sandbox once everything is local
(`GET /sandboxes/{id}`, or the `sandbox.hydrated` webhook). Files from Boat's
base image are already on every host; only your differences are restored.

What it means for CI:

- **A job started before `hydrated` runs slower.** Register the runner (or
  start heavy work) after hydration, not on "ready". Waiting costs nothing
  end to end, because the job then runs at full speed.
- **Don't write a lot before `hydrated`.** A heavy writer during the restore
  makes it take much longer.
- **Keep the snapshot small.** Restore time follows the size of your changes
  from the base image. A snapshot pre-filled with a big package cache made our
  fresh sandboxes slower, not faster. Keep work directories out of snapshots
  with `.boatignore` (gitignore syntax).
- **Prefetching over the network doesn't help.** Once hydrated, reading your
  hot files once warms the page cache in seconds, but reading ahead during
  the restore just competes with it.
- **Reused runners skip all of this.** A runner that stays up takes job after
  job on a disk that is already local. That's the main reason to reuse them.
- **A restore behaves like a reboot.** `/tmp` is empty and enabled systemd
  units start again.

## 4. Keep the workspace between jobs

With `actions/checkout`'s default `clean: true`, checkout runs
`git clean -ffdx` and deletes `node_modules` every job. Instead:

- Check out with `clean: false`.
- Install a job-started hook (`ACTIONS_RUNNER_HOOK_JOB_STARTED`) that runs
  `git clean -ffdxq -e node_modules -e .turbo` in the workspace (exclude
  whatever your build keeps warm), removes every docker container on the
  machine, and clears your jobs' temp outputs. This assumes the machine runs
  nothing but this runner.
- Keep the frozen install and the prune step on every job
  (`git-and-caching.md`): the tree rolls across lockfiles.

A warm job's checkout and install then take a second or two each.

## 5. Reused runners carry state: privileged jobs get fresh machines

A reused runner keeps whatever earlier jobs left: `node_modules`, the tool
cache, anything written with sudo. A deploy job that later runs on the same
machine runs whatever a PR job planted.

Give each size a `-once` label: a fresh sandbox that registers an ephemeral
runner (`config.sh --ephemeral`), runs one job and is erased. Put every job
that holds credentials a PR can't otherwise reach on it: deploys, production
migrations, image publishing, environment-protected jobs, and
`pull_request_target` jobs with a privileged token. Add a test that every job
with an `environment:` uses a `-once` label.

PR jobs that read ordinary repository secrets gain little from this, since a
PR can read those by editing a workflow. `-once` jobs pay the cold start
every time; deploys are rare enough that this is fine.

## 6. Mistakes to avoid

### Differences from GitHub-hosted runners

- **Locale.** Boat uses `en_US.UTF-8`, GitHub `C.UTF-8`, and `sort` orders
  differently between them. Set `LC_ALL=C.UTF-8` in your jobs.
- **git.** Install a recent git in the snapshot; Ubuntu's can break sparse
  partial clones.
- **apt.** GitHub's image answers yes by itself. Set
  `DEBIAN_FRONTEND=noninteractive` and an assume-yes apt config.
- **Tools.** The base image has fewer preinstalled toolchains (no `psql`, no
  AWS CLI, no .NET). Put what every job needs in the snapshot.
- **Writable tool paths.** Actions that install into `/usr/share/...`
  (`setup-dotnet`) need a directory the runner user can write.
- **Memory overcommit.** Linters with mmap-based allocator pools (oxlint)
  reserve more virtual memory than the small sizes allow by default. Set
  `vm.overcommit_memory=1` at boot.
- **CPU count.** If you limit a job to some CPUs, Node's `os.cpus()` and
  Python's `os.cpu_count()` still see the whole machine. Set worker counts
  explicitly.
- **systemd units don't read `/etc/environment`.** A runner started as a unit
  needs its full `PATH`.
- **Docker images in snapshots.** A named snapshot keeps only images that a
  container uses.
- **x64 Linux only.** macOS and arm64 jobs stay elsewhere.

### State between jobs on one machine

- **Sparse checkouts stay sparse.** A job that sparse-checks-out the shared
  workspace hides files from the next job. Check sparse jobs out into their
  own directory, or reset it in the job-started hook.
- **`pip install` changes the shared interpreter.** Use a virtualenv per job.
- **Reporters append to `/tmp`.** Clear job outputs in the hook, or write
  under the workspace.
- **Keep the same paths for every job.** Caches keyed on paths, and compiler
  caches holding absolute paths, miss when the checkout moves.
- **One job per machine.** If you ever run several, give each its own `HOME`;
  two package installs into one shared cache can corrupt it.

### Caches and network

- **Boat runs in Europe; GitHub's cache service is in the US.** `actions/cache`
  is slow from Boat machines. Keep caches on the runner's disk (which reuse
  gives you), or in an object store near Boat.
- **A single connection gets much less than the machine's bandwidth.**
  Download big files with parallel ranges.
- **`tar` of a directory that is still hydrating fails** ("file changed as we
  read it"), and `actions/cache` reports a failed save. Another reason to
  wait for `hydrated`.

### Runner supervision

- **Keep the registration token away from jobs.** Boat puts the sandbox's
  `env` into the setup process, and everything it starts inherits it. With
  the token, a job can register its own runner with a `-once` label and take
  deploy jobs. Register, then `exec` the runner loop under `env -u`.
- **A runner can be taken by a different job.** Keep watching the job that
  triggered a start, and start another runner if it is still queued after a
  boot grace period.
- **GitHub may drop a webhook,** and never redelivers one that got an error.
  Also list queued runs on the schedule and treat each as if its webhook had
  arrived. One list call every couple of minutes is cheap; polling every job
  instead of using webhooks is not.
- **A sandbox can lose its runner.** We had a runner machine restored onto a
  new host, which drops running processes and doesn't rerun the setup script:
  the machine kept billing with no runner on it. Stop any runner sandbox that
  has no registered runner a few minutes after it was created.
- **A runner that dies must be replaced and deregistered,** or its job waits
  forever. When a runner's machine disappears, GitHub fails the job only
  after several minutes ("lost communication with the server"). Detect it
  yourself and re-run the job, but never re-run a real test failure.
- **Stop idle machines yourself, and keep a safety net.** Boat's auto-stop
  counts from create or resume, not from the last job. Stop idle runners from
  inside, and on every schedule tick refresh `ttlSeconds` on each live
  runner (`PATCH /sandboxes/{id}`), so machines still stop if the controller
  dies.
- **The idle watchdog must treat a running job as busy,** and match only its
  own runner's worker process (its full install path): a pattern like
  `pgrep -f Runner.Worker` also matches a CI job's runner on the same machine.
- **Clean up registrations carefully.** A booting runner isn't registered
  yet; remove only offline registrations whose sandbox is gone. Deregister a
  baseline runner before stopping it, since GitHub refuses to remove a runner
  that just took a job.
- **Stop the runner listener with TERM.** Background processes in a
  non-interactive shell ignore SIGINT.
- **Just-in-time runner configs carry only the labels you pass.** Add
  `self-hosted` yourself. `config.sh` adds it by default.
- **Keep a heartbeat job on runners you don't operate,** so it can report
  when yours are down.

### Limits

- **Starts are counted per account:** create, fork and resume each count,
  with per-minute, per-hour and per-day budgets by plan (`GET /limits`). One
  sandbox per job uses them up on a busy day; reused runners start per
  burst. Cap concurrent starts in the worker.
- **Hosts vary.** The same build can be slower on one host than another, and
  you can't pick. Compare medians of several runs.

## 7. The runner snapshot

Build it from a fresh `boat new`: the Actions runner at `~/actions-runner`
with its dependencies, a recent git, and the tools every job would otherwise
install. Keep it lean (section 3). Rebuild from a fresh box rather than one
that has lived through many resumes. Saving under the same name replaces the
snapshot, and the baseline's age-based replacement rolls it out.
`scripts/boat-runners/build-runner-snapshot.sh` builds one.

## 8. Moving workflows over

Run the same small job on both providers in a pilot workflow, and compare a
few dozen runs, fresh and warm. Then move the labels in one change and fix
what the first runs surface:

| Symptom | Fix |
|---|---|
| Installs slow every job | `clean: false` on checkout plus the job-started hook |
| An action can't write to `/usr/share/...` | Install into the runner's tool cache directory |
| Files missing after another job's sparse checkout | Sparse jobs check out into their own directory |
| A later job's Python has extra packages | A virtualenv per job |
| `pg_isready` missing | Probe the port over TCP, or add the client to the snapshot |
| Tests read stale lines from `/tmp` | Clear job outputs in the hook |
| Service containers left running | Remove containers in the hook |
| Image builds need buildx | Add the setup step explicitly |
| A large dependency cache restore step | Delete it; the runner already has the tree |
| A process killed with exit 137 | A bigger size |
| A test's sort order differs | `LC_ALL=C.UTF-8` |

Then lock it in with tests over the workflow files: every PR job uses a
`boat-*` label, every checkout uses `clean: false`, no steps from the old
provider remain, every `environment:` job uses `-once`, sparse checkouts use
their own directory, and `pip install` runs in a virtualenv.
