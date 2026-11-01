#!/usr/bin/env bash
# Pull, build, restart, health-check; roll back to previous commit on failure.
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/relay}"
BRANCH="${BRANCH:-main}"
HEALTH="${HEALTH:-http://127.0.0.1:4317/api/health}"
SERVICES="relay-console relay-mcp"
cd "$APP_DIR"
PREV=$(git rev-parse HEAD)

build_and_restart() {
  npm ci --no-audit --no-fund
  npm run build
  sudo systemctl restart $SERVICES
}
healthy() {
  for i in $(seq 1 20); do
    curl -fsS "$HEALTH" >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"
NEW=$(git rev-parse HEAD)
echo "deploy $PREV -> $NEW"
if build_and_restart && healthy; then
  echo "OK $NEW healthy"; exit 0
fi
echo "FAILED, rolling back to $PREV" >&2
git reset --hard "$PREV"
build_and_restart || true
healthy && echo "rolled back to $PREV" >&2
exit 1