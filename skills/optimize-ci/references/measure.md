# Measure before changing anything

Guesses about where CI time goes are usually wrong. A lane that looks slow
is waiting in a queue; a "slow test" is a timer nobody cleared; a concurrency
setting that "doesn't help" never reaches the process. Build the instruments
first.

## What to collect

**Per job: CPU, memory and pressure.** Wrap each lane command in a small
sampler that reads `/proc/stat`, `/proc/meminfo`, `/proc/loadavg` and
`/proc/pressure/{cpu,memory,io}` every second or two and prints one summary
line at the end: average and p95 CPU, peak memory, and the share of time
under pressure. This one line answers the first question for every lane:

- High CPU the whole way: the lane is CPU-bound. Cut work or add cores.
- Low CPU and long: it is waiting. Look for sleeps, timeouts, a database,
  a queue, network, or a serial setup step.
- Memory pressure: working sets are too large for the box, and adding
  parallelism will make it slower.

**Per run: a timing report.** A script over the last N completed runs that
prints queue time, each job's duration, each job's slowest steps, the
critical path (the longest chain of `needs`), and medians and p90 across
runs. Split runs by what they did (a narrow selection vs everything), or the
medians mix two populations.

**Per unit: queue wait separate from run time.** Anything that runs through
a pool (typecheck tasks, test files, shards) should log when it was
requested, when it started and when it finished. Build tools often report a
task's duration including the time it waited for a slot, which makes small
packages look slow.

**Billing.** If the provider exposes billed minutes or cost per job, pull
them. If it doesn't, say "avoided work" in PR descriptions rather than
claiming dollars.

## Reading the numbers

- Runner noise is large. The same job on the same commit varies a lot run
  to run. Compare medians across several runs, never one run against one run.
- A single slow job can make an innocent file look like a regression. When a
  timing gate flags something, confirm it on a different runner before
  believing it, and prefer report-only for anything timed.
- Measure CPU-seconds as well as wall time. A change can cut wall time by
  spreading the same work over more cores, or by rebuilding module graphs
  several times over, and cost more.
- Local numbers lie in a specific way: a laptop with many cores runs a
  per-file pool faster than CI's few cores will. Judge changes by the CI
  shape (same core count, same concurrency) and by CPU-seconds.
- "Boot time" measured as spawn-to-first-output includes the first test's
  body. Measure boot with a test that does nothing.
- Job teardown has a tail that the provider controls. Don't optimize what
  you can't change.

## Questions to answer before choosing a lever

1. What is the critical path of a typical PR run, and what share of it is
   setup (queue, checkout, install, services) versus real work?
2. Which lanes run on most PRs, and how often do they catch something real?
   Count real regressions caught versus flakes and infrastructure failures
   over the last hundred or so PRs.
3. Which runs got cancelled after burning most of their minutes?
4. How many runs does one PR branch accumulate? Agent-driven branches can
   push many times.
5. Which lanes are CPU-bound, and which wait?

The answers usually point to a short list: setup on every job, a handful of
lanes that run everywhere but rarely catch anything, and a few test files
that pay the same boot cost over and over.
