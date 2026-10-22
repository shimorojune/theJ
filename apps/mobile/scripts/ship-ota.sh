#!/usr/bin/env bash
# JavaScript changes to phones already running a build: published to the preview channel,
# picked up the next time the app opens. Native changes need ship-apk.sh and a version bump.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
eas update --channel preview --message "${1:-$(git log -1 --pretty=%s)}" --non-interactive
