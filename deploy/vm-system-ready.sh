#!/usr/bin/env bash
# Run on the prod VM as a user with sudo (see docs/operations/system-ready-checklist.md).
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/relay}"
cd "$APP_DIR"

echo "== git pull main =="
git fetch origin main
git checkout main
git pull origin main

echo "== cloudflared ingress (read-only check) =="
node tools/check-cloudflared-sleep-mode.mjs || {
  echo "Fix /etc/cloudflared/config.yml: cloud-mcp.duitpoket.fun -> http://127.0.0.1:4321" >&2
  echo "See deploy/cloudflared-config.yml.example" >&2
  exit 1
}

echo "== deploy (local sleep verify strict; public verify when DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY=1) =="
sudo DEPLOY_STRICT_SLEEP_VERIFY=1 DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY="${DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY:-1}" \
  -u relay bash deploy/deploy.sh

echo "== go-live gate =="
npm run go-live:cloud

echo "== system-ready (from VM; also run from laptop after public URLs green) =="
npm run verify:system-ready