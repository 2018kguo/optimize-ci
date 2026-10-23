# Run what the diff can affect, and the rest on a schedule

Running every suite on every PR spends most of its compute on work that
can't fail. Count real regressions caught per lane over a long stretch of
PRs: heavy product lanes often catch only a handful, and most of their red is
flakes and infrastructure. Per-diff selection can cut a typical PR's compute
and wall time to a fraction, with recall pinned by a replay of real
failures.

Selection is only safe with its backstops: a scheduled full run on main, an
alert when main goes red, and a selector that fails closed. Build those
first.

## Layer 1: lanes, failing closed

A lane selector decides per diff which suites run at all. Its rule is one
sentence: skip a lane only when every changed file is proven unable to reach
it. Running an extra suite is a cost; skipping a needed one is the failure
this exists to prevent.

- A file is skip-safe for a lane only if it is owned by checks that always
  run (lint, typecheck, static guardrails), is in a declared inert set
  (docs, plans), or sits in a package whose dependents can't reach the lane.
- Anything unclassified, a missing diff base, or an unreadable dependency
  graph turns every lane on.
- Narrow what forces "everything" over time, one category at a time, with a
  test for each: a workflow edit that only touches one job, a lockfile-only
  change, a formatter-only edit. Each of those used to force the full suite
  and later ran a smoke selection instead.

**Diff against the commit CI actually tests.** On a pull request, CI usually
checks out the merge commit (`refs/pull/N/merge`). The event's
`pull_request.base.sha` is the base when the PR was last pushed, and lags
whenever main moves. Diffing against it makes every global file that landed
on main since then look like the PR's own change, and forces every lane. The
right base is the merge commit's first parent, `HEAD^1`, which is exactly the
main being tested. Check out with `fetch-depth: 2` so it exists. This mistake
is easy to make and expensive: it can make most PRs run everything.

**Gate downstream jobs so an empty output runs the lane.** Write every lane
condition as `steps.select.outputs.backend != 'false'`, not `== 'true'`. If
the selector dies before writing outputs, the lane runs. Mark these
conditions as load-bearing in comments, because they look like a typo.

## Layer 2: tests, from a graph filtered by a decision model

Within a lane, select test files.

**Retrieve with a static import graph.** Parse every source file (oxc-parser
is fast enough to do this on every run, with a parse cache keyed by blob id),
follow imports across workspace packages including package `exports` maps,
and walk from changed files to the tests that reach them. Count non-import
edges too: tests that read a sibling file by literal path, or spawn a helper
script. A typical PR in a monorepo reaches a large share of all tests through
hub modules, so the graph alone selects too much.

**Filter with a decision model.** A decision model takes a batch of yes/no
questions plus some shared context and returns a probability for each one,
fast and cheap. OpenRouter's Decisions API serves several, including Jev and
GPT Luna Decisions. Each question names one candidate test and carries its
case titles and the import chain from the change to the test. The shared
context carries the changed hunks, budgeted and split across files.

Route it like a tree rather than asking about every file:

```
diff ─▶ import graph ─▶ candidate tests
                            │
             group by folder + filename prefix
                            │
          ┌─────────┬───────┴───┬──────────┐
       grid/*    chat/*     billing/*   auth/*      one question per area
       p 0.81    p 0.06     p 0.64      p 0.03      keep areas above a low bar
          │                    │
   ┌──────┼──────┐          ┌──┴───┐
 sort   paste  theme      total  limits             one question per test
 0.97   0.93   0.41       0.95   0.22               run tests above a high bar
```

Two round trips cover a large fan-out: all area questions at once, then all
file questions for the kept areas at once. Keep the area bar low (an area
only needs one test that runs the change) and the test bar high.

- Ask whether the test's cases execute the changed code, not whether the
  change could make the test fail. Models assume the diff is correct, so the
  second framing scored real failing tests as unlikely. The execution framing
  raised their scores a lot.
- Keep batches small (accuracy drops as batches grow), send them in parallel,
  give the whole step a short deadline, and cap the number of questions.
- Always run changed tests. Run direct importers of a changed file unless
  there are too many of them, in which case the model filters those too.
- Treat a refused or malformed answer as "relevant", salvage the rest of the
  batch, and split repeated refusals into smaller requests.
- Cache answers per PR keyed by the tested commit, so a re-push only asks
  about tests whose changed hunks moved.

A model asked to skip a whole lane barely beat a path rule. A model asked to
filter a retrieved candidate list worked. "Is this lane needed?" isn't
visible in diff text; "does this test run this code?" mostly is.

**Fill wall-clock ceilings, not budgets.** Estimate each selected test's cost
from measured per-file timings, model a shard as fixed setup plus per-unit
work (fit the model on real shards; a model without the fixed cost
underestimates small selections badly), and cap each lane's selected wall
time. Lowering the cap too far cost recall, because selected-shard wall time
was bound by per-file boot, not test bodies.

## Pin recall with a replay of real catches

Record a set of real historical revisions where a test caught a real bug:
the commit, the diff, the failing tests, the original run. A test replays the
selector against them and fails CI if recall drops below a floor, if named
must-catch revisions stop being caught, or if the decision model stops selecting
fewer files than the graph alone. Changing the prompt or the graph code
forces re-recording, so the floor is always measured against the current
selector.

When you evaluate selection policies on mined history, apply CI's real time
caps and don't double-count changed tests, or the replay overstates recall.

## Decide what a selector failure means

Pick one, write it down, and test it:

- **Smoke set:** a small fixed list of tests across the core surfaces, plus a
  loud warning. Usually the right choice: cheap, catches the obvious
  breakage, and the scheduled full run catches the rest.
- **Everything:** safest, but if refusal paths fire often, a large share of
  PRs end up running everything, which undoes the selection.

Check the selector's own PR log by hand. A PR that changes the selector is
usually forced onto the wide path, so it never exercises the narrow path it
changed. A selector step marked `continue-on-error` that crashes writes no
outputs; if any gate reads a missing output as "off", lanes stop running and
nothing complains.

Selectors that run in a sparse checkout without installed dependencies must
not import packages statically. Fetch pinned packages explicitly and import
them dynamically, and add a test that walks the selector's static imports.
Don't probe for a package with `require.resolve` before it is unpacked; a
failed resolution can poison the later import. Probe the filesystem instead.

## Main and the schedule

- Main pushes run the same per-diff selection as PRs, diffed from `HEAD^1`.
- A scheduled run every few hours runs every lane and the full verify
  profile, in its own concurrency group so it never cancels or gets cancelled
  by per-diff runs.
- A scheduled run may skip only if a full run already succeeded on the
  identical commit, branch and workflow file. Record execution evidence
  explicitly (a step with a fixed name) and never let a reuse certify another
  reuse. Manual dispatch always executes.
- Slow, infrastructure-heavy suites (browser end-to-end, dev-server
  end-to-end) move to the schedule, with a label PRs can add to opt in.
  Listen for the `labeled` event too, or adding the label runs nothing.

**Never cancel main.** With merges every few minutes and runs longer than
that, `cancel-in-progress: true` on main cancels nearly every run, and main
goes unverified. Cancel only PR runs:

```yaml
concurrency:
  group: verify-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Without cancellation, GitHub lets the running run finish and keeps only the
newest pending one, so main gets a verdict at least once per run length, on
the latest tree. Test this property with a test over the workflow files, not
by reading the YAML: one quoting mistake can turn the expression into the
string `"false"`, which Actions treats as truthy.

**Alert on red main, and on silence.** Post on every green-to-red transition
on main, with the failing jobs and the commits since the last green, and
repeat while it stays red. Alert on the age of the last green for each lane
too, with a threshold well above its healthy interval, so a lane that stopped
running gets noticed. Once PRs stop running a suite, main can go days without
a green run before anyone looks.

**A green per-diff run after a red one proves nothing.** The later run may
simply not have selected the broken suites. Only the next full run says main
is fixed.

## Debounces and merge queues

- A debounce before allocating runners (wait N seconds for another push) is a
  guess about push cadence. Measure how many follow-up pushes land inside the
  window; if few do, every run pays the wait for nothing. Removing
  cancellation on main made the main quiet period pointless too.
- A merge queue multiplies the cost of your slowest suite: every batch pays
  it, batches run serially, and a flaky suite makes the queue bisect and
  invalidate itself. If the problem is deploy fan-out on every merge, fix it on the deploy side by
  coalescing deploys to the tip of main.
