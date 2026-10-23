# GitHub Actions runners on Boat sandboxes (README.md). Keep its state apart
# from your production stack, so CI capacity never depends on a prod apply.
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
  }
  # Partial config: tofu init -backend-config="bucket=<your state bucket>" \
  #   -backend-config="key=ci-runners/terraform.tfstate" -backend-config="region=<region>"
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { managedBy = "opentofu", stack = "ci-runners" }
  }
}

variable "repository" {
  description = "owner/repo whose jobs these runners take"
  type        = string
}
variable "app_id" {
  description = "The runner GitHub App's id"
  type        = string
}
variable "installation_id" {
  description = "The App's installation id on the repository's owner"
  type        = string
}
variable "alarm_topic_name" {
  description = "Existing SNS topic for the dead-letter alarm"
  type        = string
}
variable "snapshot" {
  description = "Named Boat snapshot with the runner at ~/actions-runner"
  type        = string
  default     = "gh-runner"
}
variable "baseline" {
  description = "Always-on reusable runners per label; bursts above it start on demand and stop when idle"
  type        = map(number)
  # Set each size below its measured p95 concurrency: bursts cover the rest,
  # and stay warm for idle_seconds.
  default = { "boat-2vcpu" = 2, "boat-4vcpu" = 2 }
}
variable "baseline_hours_utc" {
  description = "UTC hours the baseline is kept up, e.g. \"8-20\" or \"22-6\" (wraps midnight); it drains to 0 outside. Empty = always"
  type        = string
  default     = ""
}
variable "idle_seconds" {
  description = "A burst runner started inside baseline_hours_utc stops after this long without a job"
  type        = number
  default     = 1800
}
variable "idle_seconds_off_hours" {
  description = "A burst runner started outside baseline_hours_utc stops after this long without a job"
  type        = number
  default     = 300
}
variable "baseline_max_age_hours" {
  description = "Idle baseline runners older than this are replaced, which rolls out a new snapshot"
  type        = number
  default     = 6
}
variable "max_concurrent_starts" {
  description = "Concurrent sandbox starts; keeps under Boat's per-minute start limit"
  type        = number
  default     = 5
}

locals { name = "ci-runners" }

# Values are written out of band (README "Secrets"), so they never enter state.
resource "aws_secretsmanager_secret" "this" {
  name        = "${local.name}/config"
  description = "APP_PRIVATE_KEY, WEBHOOK_SECRET and BOAT_API_KEY for the Boat runner controller"
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${local.name}-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "jobs" {
  name = "${local.name}-jobs"
  # A job that saw an idle runner, or whose start failed (Boat start limit,
  # no machine), is handed back after 20 s; after 90 tries (~30 min) it goes
  # to the DLQ and alarms.
  # Shorter than the function timeout on purpose: worker invocations take a
  # few seconds, and a short visibility keeps rechecks quick. A worker that
  # ran past it could start one extra runner, which idles out.
  visibility_timeout_seconds = 20
  message_retention_seconds  = 3600
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 90 })
}

data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/index.mjs"
  output_path = "${path.module}/.build/lambda.zip"
}

resource "aws_iam_role" "lambda" {
  name = local.name
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.lambda.arn}:*" },
      { Effect = "Allow", Action = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.jobs.arn },
      { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = aws_secretsmanager_secret.this.arn },
    ]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 30
}

resource "aws_lambda_function" "this" {
  function_name    = local.name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 60
  memory_size      = 256
  environment {
    variables = {
      REPOSITORY             = var.repository
      APP_ID                 = var.app_id
      INSTALLATION_ID        = var.installation_id
      SNAPSHOT               = var.snapshot
      BASELINE               = jsonencode(var.baseline)
      IDLE_SECONDS           = tostring(var.idle_seconds)
      IDLE_SECONDS_OFF_HOURS = tostring(var.idle_seconds_off_hours)
      MAX_AGE_HOURS          = tostring(var.baseline_max_age_hours)
      BASELINE_HOURS_UTC     = var.baseline_hours_utc
      QUEUE_URL              = aws_sqs_queue.jobs.url
      SECRET_ARN             = aws_secretsmanager_secret.this.arn
    }
  }
  depends_on = [aws_cloudwatch_log_group.lambda]
}

# GitHub's webhook target. The payload signature is the authentication.
resource "aws_lambda_function_url" "webhook" {
  function_name      = aws_lambda_function.this.function_name
  authorization_type = "NONE"
}

# A NONE-auth function URL still needs a resource policy allowing public
# invokes; without it, every webhook gets a 403.
resource "aws_lambda_permission" "url" {
  statement_id           = "function-url-public"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.this.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "url_invoke" {
  statement_id             = "function-url-invoke"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.this.function_name
  principal                = "*"
  invoked_via_function_url = true
}

resource "aws_lambda_event_source_mapping" "jobs" {
  event_source_arn        = aws_sqs_queue.jobs.arn
  function_name           = aws_lambda_function.this.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = max(2, var.max_concurrent_starts)
  }
}

resource "aws_cloudwatch_event_rule" "pool" {
  name                = "${local.name}-pool"
  schedule_expression = "rate(2 minutes)"
}

resource "aws_cloudwatch_event_target" "pool" {
  rule = aws_cloudwatch_event_rule.pool.name
  arn  = aws_lambda_function.this.arn
}

resource "aws_lambda_permission" "pool" {
  statement_id  = "pool-schedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.pool.arn
}

# A job that never got a runner.
resource "aws_cloudwatch_metric_alarm" "dlq" {
  alarm_name          = "${local.name}-dlq"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [data.aws_sns_topic.alerts.arn]
}

data "aws_sns_topic" "alerts" {
  name = var.alarm_topic_name
}

output "webhook_url" {
  value = aws_lambda_function_url.webhook.function_url
}
output "secret_arn" {
  value = aws_secretsmanager_secret.this.arn
}
