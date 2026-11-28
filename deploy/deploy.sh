#!/usr/bin/env bash
# Pull, build, restart, health-check; roll back to previous commit on failure.
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/relay}"
BRANCH="${BRANCH:-main}"
HEALTH="${HEALTH:-http://127.0.0.1:4317/api/health}"
SERVICES="relay-console relay-mcp"
if systemctl is-enabled relay-cloud-mcp.service >/dev/null 2>&1; then
  SERVICES="$SERVICES relay-cloud-mcp"
fi
cd "$APP_DIR"
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
echo "origin: ${ORIGIN_URL:-unknown}"
if [[ -n "${RELAY_DEPLOY_EXPECT_ORIGIN:-}" ]] && [[ "$ORIGIN_URL" != *"${RELAY_DEPLOY_EXPECT_ORIGIN}"* ]]; then
  echo "ERROR git origin mismatch — set RELAY_DEPLOY_EXPECT_ORIGIN only when enforcing ttrg/relay" >&2
  echo "  expected fragment: ${RELAY_DEPLOY_EXPECT_ORIGIN}" >&2
  echo "  actual origin: ${ORIGIN_URL}" >&2
  exit 1
fi
PREV=$(git rev-parse HEAD)

build_and_restart() {
  npm ci --no-audit --no-fund
  npm run build
  # shellcheck disable=SC2086
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
stamp_git_sha() {
  local sha="$1"
  local envf="${RELAY_ENV_FILE:-/etc/relay/relay.env}"
  [[ -f "$envf" ]] || return 0
  run_stamp() {
    if grep -q '^RELAY_GIT_SHA=' "$envf" 2>/dev/null; then
      sed -i "s/^RELAY_GIT_SHA=.*/RELAY_GIT_SHA=$sha/" "$envf"
    else
      printf '\nRELAY_GIT_SHA=%s\n' "$sha" >>"$envf"
    fi
  }
  if [[ -w "$envf" ]]; then
    run_stamp
  elif command -v sudo >/dev/null; then
    if sudo grep -q '^RELAY_GIT_SHA=' "$envf" 2>/dev/null; then
      sudo sed -i "s/^RELAY_GIT_SHA=.*/RELAY_GIT_SHA=$sha/" "$envf"
    else
      echo "RELAY_GIT_SHA=$sha" | sudo tee -a "$envf" >/dev/null
    fi
  fi
}
stamp_git_sha "$NEW"
if build_and_restart && healthy; then
  if command -v node >/dev/null 2>&1 && [[ -f tools/verify-sleep-mode-local.mjs ]]; then
    if node tools/verify-sleep-mode-local.mjs; then
      echo "sleep-mode local verify OK"
    else
      echo "WARN sleep-mode local verify failed — fix relay.env / relay-cloud-mcp before public URLs" >&2
      if [[ "${DEPLOY_STRICT_SLEEP_VERIFY:-0}" == "1" ]]; then exit 1; fi
    fi
  fi
  if command -v node >/dev/null 2>&1 && [[ -f tools/check-cloudflared-sleep-mode.mjs ]]; then
    node tools/check-cloudflared-sleep-mode.mjs || {
      echo "WARN cloudflared may not route cloud-mcp to 4321 — fix /etc/cloudflared/config.yml" >&2
      if [[ "${DEPLOY_STRICT_SLEEP_VERIFY:-0}" == "1" ]]; then exit 1; fi
    }
  fi
  if command -v node >/dev/null 2>&1 && [[ -f tools/verify-sleep-mode.mjs ]]; then
    STRICT_PUBLIC="${DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY:-0}"
    VERIFY_URL="${RELAY_PUBLIC_URL:-https://relay.duitpoket.fun}"
    if RELAY_PUBLIC_URL="$VERIFY_URL" node tools/verify-sleep-mode.mjs; then
      echo "sleep-mode public verify OK"
    else
      echo "WARN sleep-mode public verify failed — tunnel or DNS (cloud-mcp → 4321)" >&2
      if [[ "$STRICT_PUBLIC" == "1" ]]; then
        exit 1
      fi
    fi
  fi
  echo "OK $NEW healthy"; exit 0
fi
echo "FAILED, rolling back to $PREV" >&2
git reset --hard "$PREV"
build_and_restart || true
healthy && echo "rolled back to $PREV" >&2
exit 1