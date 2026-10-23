#!/usr/bin/env bash
# Builds the named Boat snapshot the controller starts runners from: the
# GitHub Actions runner unpacked at ~/actions-runner with its dependencies,
# plus a Postgres client and AWS CLI v2 (the base image already has gh, jq,
# docker, node and git). Add the tools your jobs would otherwise install on
# every run, and nothing else: a large snapshot reaches a new machine lazily,
# so pre-filled package caches make fresh sandboxes slower, not faster.
# Reused runners warm their own caches on local disk.
#
# Saving under an existing name replaces the snapshot; the controller's
# age-based baseline replacement rolls it out. Needs a `boat` CLI signed in to
# the account that runs CI, and jq.
#
#   build-runner-snapshot.sh [name] [runner-version]
set -euo pipefail
name=${1:-gh-runner}
version=${2:-2.338.1}
export BOAT_NO_UPDATE=1

# `boat new --json` streams one JSON line per state; the id is on "ready".
id=$(boat new --type default --json | jq -r 'select(.event == "ready") | .sandbox.id // .id')
trap 'boat delete "$id" --yes >/dev/null 2>&1 || true' EXIT
echo "building $name (runner $version) in $id"

boat exec "$id" --timeout 600 -- bash -lc "
  set -euo pipefail
  mkdir -p ~/actions-runner && cd ~/actions-runner
  curl -fsSL https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-x64-$version.tar.gz | tar xz
  sudo ./bin/installdependencies.sh >/dev/null 2>&1
  ./config.sh --version
  sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-client >/dev/null
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip
  (cd /tmp && unzip -q awscli.zip && sudo ./aws/install --update >/dev/null && rm -rf aws awscli.zip)
  psql --version && aws --version
" | jq -r '.stdout // empty'

boat stop "$id" >/dev/null
until [ "$(boat info "$id" --json | jq -r '.sandbox.state')" = stopped ]; do sleep 3; done
boat snapshot "$id" "$name"
echo "saved $name"
