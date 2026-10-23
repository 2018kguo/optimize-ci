# Guardrails that keep CI honest

Every optimization in this playbook has a way to undo itself or to
make CI pass while proving less. These checks catch that. Write them as
tests that assert behavior, not spelling: a test that greps the YAML for an
exact string passes when someone rewrites the line into something that
behaves differently.

## A required lane can't pass while running nothing

Required lanes go green while executing nothing in many ways: an empty
shard after a selection change, an empty lane after a glob change, skipped
tests counted as run, a browser suite where most tests "did not run", a
leaked handle that force-exits green.

One gate fixes the whole class: wrap every required test command in a small
script that parses the runner's summary (node:test, bun test, Vitest,
Playwright, pytest, `go test`) and fails unless at least one test executed
(not skipped, todo or cancelled) and no collected test went unrun. Then add a
linter over the workflow files that resolves each required job's `run:`
lines (through `bun run`, `--filter`, `cd`, `bash -c`) and rejects test
commands that don't go through the gate. Exemptions carry a reason and an
expiry date.

Known gap: node:test reports a file with zero tests as one passing test.

## Every test file runs somewhere

Test files die in four ways: the package has no `test` script, the file
belongs to no package, a hand-maintained list of files drifts, or a script
exists that nothing invokes. A check that walks every test file and proves
each is collected by a glob in a command some workflow runs catches all four.
Unquoted `**` globs expand only one directory level in bash and some
runners; quote them.

## Skipped means passing only when the selector said so

When lanes are skipped by selection, an aggregate required check must accept
a skipped lane only if a successful selection turned it off. A lane skipped
because its job was interrupted is a failure. Without this, an interrupted
lane reads as a branch-protection success.

## Workflow behavior

One test file over all workflows that asserts:

- A main run is never cancelled by a later merge.
- Scheduled and manual full runs use their own concurrency groups.
- Shard groups don't cancel other shards of the same run.
- Quiet periods (if any) run before expensive runner allocation, not after.
- Every trigger has a shape GitHub accepts. An invalid trigger makes GitHub
  skip the whole workflow silently.
- Every-PR jobs run on your runner labels, not GitHub-hosted ones.
- Jobs holding deploy credentials run on fresh single-use runners.
- Cache and disk writers are main-only.

Prove each one fails: break the property in a scratch copy and watch the
test go red.

## Selection recall

A replay of recorded real catches with a floor, named must-catch revisions
and a rule that the classifier selects fewer files than the graph
(`test-selection.md`). Re-record when the prompt or graph code changes.

## Deterministic ratchets, never timing gates

Timing gates are noisy enough to flag innocent files run after run. Keep
anything timed report-only. Gate on deterministic quantities that only move
down: gzip bytes on each page's critical path, typecheck diagnostic counts
per file, audit findings, allowlist entries, env-gated skips. Let the update
command record reductions and never raise a ceiling on its own. Skip an
expensive ratchet build when the diff can't reach its inputs, using a list of
inputs main publishes.

## Drift ledgers

- Env-gated skips need a baseline entry naming the variable and the files it
  gates. A gate whose variable CI never sets means those tests never run.
- Conditional skips must sit in a lane whose capabilities satisfy them.
- Allowlist checks run the linter twice, once ignoring allowlists, to find
  waivers that no longer silence anything.
- Ban raw sleeps in tests with a lint rule; use stubbed clocks.

## Prove fixes

A `fix:` PR's changed test must fail with the non-test changes reverted, and
every guardrail keeps a case it must fail on. Decide these inside an existing
job rather than starting a runner per push.

## Static analysis of shell inside YAML is an arms race

A guardrail that parses workflow YAML and shell to prove some producer runs
will be bypassed by heredocs, numeric comparisons, dynamic paths and gated
steps, one after another. Prefer runtime evidence (the executed-test gate,
artifacts a step writes) wherever possible, and keep static checks
conservative.

## Catch cheap failures before push

A large share of CI minutes can go to runs that fail on static checks
(format, lint, typecheck of changed files) that take seconds locally. A short
pre-push profile catches most of them. Keep it fast enough that nobody skips
it.
