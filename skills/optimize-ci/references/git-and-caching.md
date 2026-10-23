# Git, checkout and caches

Once selection removes the work a diff can't affect, most of what's left in
a PR run is setup: checkout, install, services. This is where the plumbing
pays.

## Git transport: force HTTP/1.1 if checkout time is bimodal

Symptom: the same commit checks out in seconds on some jobs and in many
minutes on others, in the same minute. The logs show:

```
error: RPC failed; curl 92 HTTP/2 stream 3 was not closed cleanly: CANCEL
fatal: early EOF
fatal: fetch-pack: invalid index-pack output
```

and `actions/checkout` retries the whole transfer from scratch. Forcing git
onto HTTP/1.1 fixes it, and can cut the wall time of affected lanes
substantially.

```yaml
env:
  GIT_CONFIG_COUNT: "1"
  GIT_CONFIG_KEY_0: http.version
  GIT_CONFIG_VALUE_0: HTTP/1.1
```

Put it at workflow level. `actions/checkout` runs git under a temporary
HOME (seeded from the runner's existing global config), and these
environment variables reach every git process, inside checkout or not,
without depending on the runner's config files.

Don't respond to this with a partial clone (`filter: blob:none`) for jobs
that need the whole tree. It fetches the same blobs a moment later over more
round trips. The problem is transport reliability, not bytes. Background
fetches you run yourself should retry a few times.

If a job's timeout has to budget for a bad checkout, make sure inner
timeouts (a test runner's global timeout) fire first, so the job reports
what it was doing.

## Give each job the least git it needs

`actions/checkout` defaults to `fetch-depth: 1`, no filter, full tree. That
is wrong in both directions for different jobs.

| Job needs | Checkout |
|---|---|
| The merge commit's diff against main | `fetch-depth: 2`, diff `HEAD^1..HEAD` |
| A few paths (a selector, a ledger, a lint of manifests) | `fetch-depth: 2` (or 1) and `sparse-checkout` of exactly those paths. `actions/checkout` fetches blobless when sparse checkout is set without a filter; with other tools, add `--filter=blob:none` yourself |
| The whole tree, every run | A warm local copy: a reused runner keeps `.git` between jobs (`runners.md`), or a mirror on a persistent disk checked out through alternates |
| History back to the merge base | Fetch it in the background while setup runs, and join before the step that needs it. Never fetch all branches (`fetch-depth: 0`) |

For PR jobs whose tools resolve `origin/<base>`, you often don't need to
fetch history at all: bind the ref to the tested parent locally.

```bash
git update-ref "refs/remotes/origin/$BASE_REF" HEAD^1
```

Push runs that cover several commits need the `before` commit:
`git fetch --depth=1 --filter=blob:none origin "$BEFORE_SHA"`.

On a fresh machine, much of a full-tree checkout's time is materializing
files, not fetching. A runner that keeps its workspace makes checkout a
small incremental update.

Two local traps when simulating CI checkouts:

- A blobless clone from a local repository that has stale shallow entries
  can recurse into nested lazy fetches and exhaust memory. Simulate with
  `git worktree add --no-checkout` plus sparse-checkout instead.
- Any `git fetch --depth` in any worktree re-shallows the shared repository.

Run every git command in CI tooling through a helper that clears inherited
git environment variables (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_WORK_TREE`,
`GIT_CONFIG_*` pairs). Tools invoked from a git hook inherit them, and
`git ls-files` then reads a different index.

## Never let the dependency tree go cold

A cold install of a large monorepo is slow on any disk: local SSD, tmpfs or
a network volume all landed in the same ballpark. A warm tree reconciles in
seconds. The fix is not a faster cold install; it is never being cold.

Ways to keep it warm, best first:

1. **A reused runner** that keeps `node_modules` and the package store on its
   own disk between jobs (`runners.md`, `boat-runners.md`).
2. **A persistent disk** mounted per job (several runner providers offer one).
3. **A cache tarball** (`actions/cache`). Restoring a multi-gigabyte
   `node_modules` tarball takes tens of seconds every job. Better than
   nothing, not much better than a fast cold install.

Whatever holds the tree:

- **Key it on the toolchain and a time bucket, not the lockfile.** A
  lockfile key goes cold every time the lockfile changes, which on a busy
  repo is several times a day. Keying on every workspace `package.json` is
  worse.
  Key on the package manager version, the runtime version, the package
  manager's config and an ISO week.
- **Reconcile on every run.** Always run the frozen install (`bun ci`,
  `npm ci`, `pnpm install --frozen-lockfile`) after mounting. It fails on
  drift and installs what changed.
- **Prune what the lockfile no longer places.** Some package managers leave
  packages a lockfile dropped. A short script that compares the tree with the
  lockfile and deletes strays keeps the tree identical to a fresh install
  (check that with an oracle: the path-and-version list after pruning must
  equal a fresh install's).
- **Dropped patches stay applied.** Package managers re-apply changed or
  added patches but may leave a removed patch in place. Delete packages
  tagged as patched that are no longer in the patch list.
- **Check for partial extraction.** Concurrent cold installs into a shared
  store occasionally left a package without its `package.json`. A quick walk
  over every package directory after install catches it; on a miss, warn and
  reinstall with `--force`.
- **No install hooks.** A warm tree skips workspace `postinstall` scripts, so
  forbid them or run their work as explicit steps.
- **Remove dangling `.bin` links with `unlink`.** Some `rm` implementations
  skip dangling symlinks.
- **Bound the life of in-place writes.** A same-version package that a job
  modified on disk stays modified. The weekly bucket (or recycling reused
  runners) bounds how long that survives.

## Cache writers and trust

- **One writer per shared key.** Let one trusted job (main's verify) write
  each shared cache, and have everything else restore only. Concurrent
  writers stampede and roll each other back.
- **PR jobs never write what a trusted job executes.** A PR job that can
  commit a dependency tree, a browser binary or a tool cache that a later
  push or deploy job runs can plant code in that job. Shared disks and caches
  written by PRs must never be read by deploy jobs. On reused runners, give
  deploy jobs fresh machines (`boat-runners.md`).
- **Restores are best effort.** `continue-on-error: true` on restore steps;
  a cache service outage should cost time, not a red run.

## Cache keys that silently never hit

Read the setup action's logs once. Defaults often disable caching:

- `actions/setup-go` looks for `go.sum` at the repository root. In a monorepo
  it finds none, logs "Dependencies file is not found", and never caches. Set
  `cache-dependency-path`.
- `astral-sh/setup-uv` with `enable-cache: auto` turns caching off on
  runners that aren't GitHub-hosted. Set `enable-cache: true`.
- Build output caches keyed on a whole directory bust on every test or doc
  edit. Hash only build inputs.
- Bounded caches for derived data (an import-graph parse cache, classifier
  answers, a list of client bundle modules, typecheck build info): key on
  the commit, restore by prefix, write from main only.

## Task runner caches (Turbo and similar)

- Strict environment mode drops variables that aren't declared. A
  concurrency knob passed as an env var then never reaches the script: tasks
  run one at a time, and the knob looks like it doesn't help. Declare
  runtime knobs as pass-through (they stay out of task hashes).
- A per-run value in global env inputs (a random port, a URL with a run ID)
  makes every hash unique, and nothing ever hits.
- Hash the checker's version and wrapper into typecheck tasks, or switching
  checkers replays cached passes.
- Keep snapshots compact (current task hashes only) and let main publish
  them. A PR's own snapshot mostly serves only its own later pushes.
- Never let PR-written incremental state replay on main: PRs read the
  remote cache but don't write it.
- `--affected` scoping is safe only when every changed file is attributable
  to a package; a root config change otherwise scopes the step to nothing.
- Positive `**` input globs walk gitignored trees, including nested agent
  worktrees. Hash from the git index.
- A task graph query (`--graph`) is much cheaper than a dry run that hashes
  every input, if edges are all you need.

## The local loop

- **Pre-commit formats and lints only staged files.** Running the full check
  suite on commit trains people (and agents) to skip it.
- **Exclude nested worktrees and agent directories from every tool's file
  walk.** Agents create worktrees inside the repo, and globs that walk them
  made local formatting and task hashing take far longer, and changed task
  hashes from gitignored files alone.
- **Run a short pre-push profile** (format, lint and typecheck of changed
  files) so the cheap failures never reach CI (`guardrails.md`).

## Preview deploys

Build previews only for apps the diff touches. Building every app on every
push filled the runner queue for everyone else.

## Docker and image builds

- **Per-deploy values in an early layer's cache key disable layer reuse.** A
  build config that exposed every variable (deploy ID, commit SHA) to the
  install step made every release reinstall from scratch. Expose only what
  the step needs.
- Keep the build context small with `.dockerignore`: `.git`, local
  worktrees, agent directories, `node_modules`.
- Install only the service's own dependency tree (a filtered install), and
  don't re-run checks in the image build that required CI already proved.
- Pin CI's runtime (Node, Bun) to production's exact version. A floating
  minor version behaves differently in ways tests won't catch.
- CI installs the whole workspace; production images often install a
  filtered subset. A tool that only works because a root devDependency is
  hoisted passes CI and fails in the image. Smoke-build every service whose
  install differs from CI's.
