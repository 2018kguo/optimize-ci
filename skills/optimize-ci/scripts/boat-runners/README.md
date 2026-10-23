# Boat runner autoscaler

A GitHub Actions runner autoscaler for [Boat](https://docs.boat.dev)
sandboxes on AWS: a GitHub App webhook, one Lambda function, an SQS queue
and a schedule. `references/boat-runners.md` explains the design; this file
is how to stand it up.

| File | What it is |
|---|---|
| `index.mjs` | The Lambda handler: webhook, queue worker and schedule, plus the boot script each sandbox runs |
| `index.test.mjs` | Unit tests, and tests that run the real boot script against a stub runner (`node --test index.test.mjs`) |
| `main.tf` | OpenTofu stack: secret, queues, function, function URL, schedule, dead-letter alarm |
| `build-runner-snapshot.sh` | Builds the named snapshot runners start from |

Labels: `boat-2vcpu`, `boat-4vcpu`, `boat-8vcpu`, `boat-16vcpu` for reused
runners, and the same names with `-once` for single-use runners. One
controller serves one repository.

Only use reused runners where everyone who can trigger workflows is trusted:
a private repository, or a public one that requires approval before
workflows run on fork PRs. Put jobs with deploy credentials on `-once`
labels. The job-started hook removes every docker container on the machine,
so run nothing else on these sandboxes.

## Setup

1. **Snapshot.** With a `boat` CLI signed in to the account that will pay for
   CI, run `./build-runner-snapshot.sh gh-runner`. Add any tools your jobs
   install on every run.
2. **Boat API key.** Create a key in the Boat dashboard for the controller.
   It needs to create, rename, list and stop sandboxes.
3. **GitHub App.** Create an App (owned by the org) with repository
   permissions Administration: read and write, Actions: read, Metadata:
   read, and the `workflow_job` webhook event. Leave the webhook URL as a
   placeholder for now and set a random webhook secret. Generate a private
   key. Install the App on the repository and note the App id and the
   installation id.
4. **Stack.** Copy this folder into your infrastructure repo, then:

   ```bash
   tofu init -backend-config="bucket=<state bucket>" \
     -backend-config="key=ci-runners/terraform.tfstate" -backend-config="region=<region>"
   tofu apply -var repository=<owner/repo> -var app_id=<id> \
     -var installation_id=<id> -var alarm_topic_name=<sns topic>
   ```

5. **Secrets.** Write the three values into the secret the stack created,
   straight from where they live, never through Tofu (so they stay out of
   state) and never echoed:

   ```bash
   jq -n --rawfile key app.pem --arg wh "$WEBHOOK_SECRET" --arg boat "$BOAT_API_KEY" \
     '{APP_PRIVATE_KEY: $key, WEBHOOK_SECRET: $wh, BOAT_API_KEY: $boat}' |
     aws secretsmanager put-secret-value --secret-id ci-runners/config --secret-string file:///dev/stdin
   ```

   Confirm the write before deleting the local key file.
6. **Webhook URL.** Set the App's webhook URL to the `webhook_url` output.
7. **Pilot.** Add a workflow with one job on `boat-4vcpu` and the same job on
   your current runner, run it a few times, and compare. Then move labels
   (`references/boat-runners.md`, "Moving workflows over").

## Tuning

| Variable | Meaning |
|---|---|
| `baseline` | Warm reused runners per label while the window is open |
| `baseline_hours_utc` | UTC hours the baseline stays up, such as `8-20` or `22-6` (wraps midnight); empty means always |
| `idle_seconds` | A burst runner stops after this long without a job |
| `baseline_max_age_hours` | Idle baseline runners older than this are replaced, which rolls out a new snapshot |
| `max_concurrent_starts` | Concurrent queue workers, which bounds concurrent sandbox starts under Boat's per-minute start limit |
| `snapshot` | Named snapshot runners start from |
| `region` | AWS region for the stack |

The webhook's grace before a job is considered (`GRACE_SECONDS`, default 10)
and the sandbox listing (first 200 live sandboxes) are constants in
`index.mjs`; change them there if you need to.

Size the baseline from measured concurrency: count, per label, how many jobs
ran at once over a busy day, and set the baseline below the p95.

## When jobs sit queued

- `aws logs tail /aws/lambda/ci-runners --since 15m`: one `runner.started`
  line per start, `runner.retry` with the Boat or GitHub error.
- `gh api repos/<owner>/<repo>/actions/runners`: runners are named after
  their sandbox id; sandboxes are named `gh-<label>-base|burst-<id>`.
- A runner online but never taking jobs: the job asks for a label the runner
  doesn't have.
- Boat's start limits: `curl -s https://boat.dev/api/v1/limits -H "Authorization: Bearer $KEY"`.
- The App's recent webhook deliveries: App settings, Advanced.
