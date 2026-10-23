# Tool choices

The JavaScript and TypeScript toolchain changed fast. Rust and Go ports of
the linter, formatter, transformer and typechecker are now several times to
an order of magnitude faster than the tools most tutorials, templates and
agents still default to. Swapping them was some of the cheapest CI time
recovered, but each swap needs a parity check on your own tree.

Check this list again before relying on it. These tools change quickly, and
several entries below have already changed more than once.

## Lint: oxlint

oxlint replaces ESLint and Biome for linting. It runs the common
`@typescript-eslint`, React, import and a11y rule sets natively and has a JS
plugin API, so a repo-specific rule pack, or a heavier lint wrapper, can
become a few custom rules.

Gotchas:

- Turning on a plugin category in the root config turns on every rule in
  it. Keep noisy categories in a separate config.
- Suppression comments for the previous linter (`biome-ignore`,
  `eslint-disable` for rules oxlint names differently) silently do nothing.
  Search for them after switching.
- oxlint's diagnostic offsets are UTF-8 bytes; oxc-parser spans are UTF-16.
  Convert before mapping one to the other.
- Batch fixture lints into one call instead of one process per fixture.

## Format: oxfmt

oxfmt replaces Prettier. Prettier-compatible output, much faster.

- It formats Markdown too, so a format check starts failing on unformatted
  docs.
- With import sorting on, inserted imports move lines around.
- Make the local format command and the CI check cover the same file set.
  A per-package format script and a repo-wide check drift apart.
- Ignore generated and unpacked files explicitly.

## Running TypeScript: oxc-node, an in-thread transform, or native stripping

The TS loader the test runner uses is often the largest single CPU item in
a TypeScript CI. tsx (off-thread hooks over esbuild) and ts-node were the
defaults; both cost far more than the alternatives:

- `node --import @oxc-node/core/register` for services and scripts.
- An in-thread loader built on an oxc transform (`oxc-transform`, or
  `rolldown/utils` `transformSync`) for test runners that start many
  processes.
- Node's native type stripping (`node --test file.ts` on recent Node) for
  packages that use explicit `.ts` import extensions and no enums, path
  aliases or other syntax that needs transforming.

Prove parity by comparing pass, fail and skip counts across every suite, and
the import and export surface of every compiled module, before deleting the
old loader. Then add a scanner that fails CI if the old loader comes back.

Gotchas:

- Worker threads inherit the parent's `--import`. Strip it where threads
  don't need it.
- oxc can't emit CommonJS. Route `.cts` files through Node's
  `stripTypeScriptTypes`.
- Rolldown reads the root tsconfig's `jsx` setting unless told not to, and
  has no CSS pipeline.
- Babel for the React Compiler can move to oxc's React transform; compare
  the count of compiled functions before and after.
- For scripts that walk ASTs, oxc-parser replaces the TypeScript compiler
  API at a fraction of the cost. Reading oxc's module record instead of
  deserializing the AST is cheaper still for import-only checks.

## Typecheck: not `tsc --noEmit`

The ladder, fastest last:

1. `tsc --noEmit`: the reference, and slowest by a wide margin on a large
   repo. Nothing in CI should still run it for plain checking.
2. tsgo (`@typescript/native-preview`): the official Go port. Several times
   faster than tsc. Still the right tool for declaration emit and for
   anything that needs the compiler API.
3. `bun check`: can be several times faster again than tsgo, with much
   lower peak memory; compare diagnostics on every config before switching. No
   incremental mode. A bare `bun check` runs the package's `check` script if
   one exists, so call it with `--no-script` or from a wrapper.
4. tsrs (tsc-rs): incremental, so warm runs with cached build info are near
   instant. Check diagnostic parity with your pinned TS version on each
   release (early releases reported extra errors), peak memory on cold runs,
   and platform binaries for every developer machine.

How to choose: diagnostics parity with your pinned TypeScript version first
(compare the full set of file, line, column and code, not just counts), then
incremental support, then memory. Native checkers lag new TS versions and
can differ in edge cases.

Typecheck traps independent of the checker:

- `declaration: true` in a root tsconfig makes `noEmit` checks run
  declaration analysis over every file. Turn it off for check-only configs.
- Incremental seeds can be pathological: when a diff reaches a global type
  (a generated route registry, a module augmentation), a seeded run can
  recheck almost everything single-threaded and take far longer than a cold
  run. Measure seeded against cold on real PRs.
- Run large typecheck programs through a pool sized to memory, so parallel
  checks don't run the runner out of memory.
- `import type` everywhere and narrow wrapper types around huge generic
  client types cut typecheck time measurably (find them with
  `--generateTrace`).

## Packages: bun

With a modern package manager, the install itself is fast; link time across
filesystems and cold trees dominate. Invest in keeping the tree warm
(`git-and-caching.md`) more than in the package manager.

Bun specifics: it doesn't prune packages a lockfile dropped, keeps
same-version package contents as they are on disk, can leave a removed
patch applied, and needs one pinned version everywhere (CI, local, images).
Add retries around its installer on hosts that fetch it.

## Test runners

- **Match the production runtime.** Running Node tests under a different
  engine (Bun's JSC as a Vitest runner) can be much faster and diverge on
  binary, encoding, archive and mocking behavior.
- **Make the runner reuse processes** (`test-cpu.md`). That mattered more
  than which runner.
- **Vitest major upgrades** gave real speedups on unit lanes. Check config
  keys after upgrading: some moved, and an unknown key is ignored silently,
  so a "speedup" can turn out to be a different file mix. Check where your
  version expects options such as `fsModuleCache`.
- **node:test** with `--test-isolation=none` per package is fast. A file with
  zero tests reports as one passing test, so count executed tests some other
  way (`guardrails.md`).
- **bun test** with `--bail` worked well for mutation-testing loops, where
  each mutant only needs to know whether anything fails.

## Other swaps worth checking

- Spawning a CLI per call inside a loop (a validator, a formatter, `git`)
  versus calling a built binary or an in-process API once.
- A heavy XML or HTML parser in a hot path versus a lean one with an
  identical tree.
- Icon libraries imported through a barrel file in browser tests.

## Runners

Managed runner providers beat GitHub-hosted runners on speed and price, and
persistent disks and checkout mirrors make them better still. Reused sandbox runners beat both on cost, and on setup
time once warm. See `runners.md` and `boat-runners.md`.

ARM runners are usually cheaper per minute; whether they are cheaper per job
depends on your workload, so measure before porting.
