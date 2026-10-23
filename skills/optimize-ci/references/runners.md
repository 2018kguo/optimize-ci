# Runner sizing, sharding and parallelism

Decide first whether you are optimizing cost or latency. Several choices
below reverse depending on which one you pick: a change that is right for
latency can be wrong once cost is the target.

## How billing changes the math

Most managed runners bill cores times minutes, often rounding each job up to
a whole minute. Under that model:

- A small job on a big runner wastes most of what it pays for. For example,
  a short selected subset on a large runner can cost what a job twice as long
  costs on a runner half the size.
- Splitting a job across N runners pays N copies of setup and N rounded
  minutes. A split that saves a little wall time can cost a multiple of the
  compute.
- Choose the shard count by billed (rounded) minutes under a wall-time cap,
  not "the fewest shards that keep each under a minute".

Sandbox and VM providers that bill per second of machine time change this:
rounding disappears, but an idle machine still bills until it stops. There,
the levers are how quickly idle machines stop and how warm the next job
finds them (`boat-runners.md`).

## Sizing a lane

1. Read the lane's resource line (`measure.md`). CPU-bound and long: bigger
   helps. Waiting: bigger doesn't.
2. Model a shard's wall time as fixed setup plus process-seconds divided by
   slots. Early "slowness" in a shard is often admission queueing, not
   work: the log line that matters is when the process actually started.
3. Leave headroom: slots at cores minus two worked; more slots added little
   at near-full CPU and added noise.
4. Size selected subsets separately from full runs. A PR that selected a few
   dozen test files doesn't need the runner the full suite needs, and a lane
   the selection turned off should take no runner at all.
5. A smaller runner can cost less with no latency cost when the lane isn't
   on the critical path. A slower dev-server end-to-end lane on a smaller
   runner finished well before the longest lane anyway.

Doubling cores and slots for a lane that is slot-throughput bound cuts its
step a lot for about the same compute. Doubling them for a lane that
waited on a database did nothing.

**Starvation looks like a crash.** A runner that "loses communication with
the server" mid-job, or a dev server killed with exit code 137, is out of
memory or CPU. More shards didn't fix it; a bigger runner did.

## Concurrency inside a job exposes isolation bugs

Running test phases concurrently on one database produced lock timeouts and
serialization failures. Give each phase its own copy of a migrated, seeded
template database (cloning a template is fast). Regrouping test files into
shared processes exposed cross-file state leaks; bisect by halving the list
of files that ran before the victim and running each half plus the victim in
one process.

## Balance shards from measured timings

Weight shards by measured per-file seconds from recent green runs, refreshed
by a script, not by hand-assigned units. Hand-assigned weights drifted far
from reality, and a timing reporter that credited a shared helper instead of
the calling test file made some files look nearly free while they were among
the slowest. A file is the unit of sharding, so no shard can finish faster
than its largest file; split giant files.

## Parallel setup steps

After selection, most of a short run is setup. Run independent setup in
parallel:

- GitHub Actions runners from 2.337 support background steps
  (`background: true` on a step, then `wait: [...]`; check the runner
  release notes for your version) (not inside composite
  actions; a wait on a step skipped by `if` is fine). Databases, service
  containers, builds and cache restores can all start together.
- Where that isn't available, start the work with `nohup ... &`, write its
  exit code to a file, and join in a later step.
- Fetch git history, install browsers and migrate the test database while
  the selector runs, and join before the steps that need them.

"Start lanes before selection finishes" saves wall time but bills a large
runner on every run, selected or not. When cost matters, make lanes `need`
the selector, so an off lane takes no runner.

## Light jobs

Every-PR helper jobs (selectors, ledgers, alerts) belong on the smallest
runner you have, with short timeouts. Keep them off GitHub-hosted runners if
your plan's hosted capacity can saturate: a required light job queued past
its wait turns every PR red.

Fold tiny jobs into the job that needs their result where you can; each
separate job pays checkout, setup and a rounded minute.

## Choosing a provider

| Option | Speed | Cost | Notes |
|---|---|---|---|
| GitHub-hosted | Baseline | Highest per core | Shared capacity limits on smaller plans |
| Managed runner providers | Faster hardware | Cheaper than GitHub-hosted | Persistent disks and checkout mirrors keep installs and checkouts warm |
| Reused sandbox runners (`boat-runners.md`) | Warm jobs spend seconds on setup | Job compute roughly an order of magnitude below managed runners; a warm pool adds a fixed daily cost | You run the autoscaler; reused machines carry state between jobs |

ARM runners cost less per minute; whether they cost less per job depends on
the workload. Measure before porting, and don't port just to hit a number.
