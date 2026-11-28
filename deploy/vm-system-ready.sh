#!/usr/bin/env bash
# Run on the prod VM as a user with sudo (see docs/operations/system-ready-checklist.md).
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/relay}"
cd "$APP_DIR"

echo "== git pull main (relay user) =="
sudo -u relay git -C "$APP_DIR" fetch origin main
sudo -u relay git -C "$APP_DIR" checkout main
sudo -u relay git -C "$APP_DIR" pull origin main

echo "== cloudflared ingress (read-only check) =="
node tools/check-cloudflared-sleep-mode.mjs || {
  echo "Fix /etc/cloudflared/config.yml: cloud-mcp.duitpoket.fun -> http://127.0.0.1:4321" >&2
  echo "See deploy/cloudflared-config.yml.example" >&2
  exit 1
}

if ! systemctl is-enabled relay-cloud-mcp.service >/dev/null 2>&1; then
  echo "relay-cloud-mcp.service not enabled — install and start it:" >&2
  echo "  sudo cp $APP_DIR/deploy/relay-cloud-mcp.service /etc/systemd/system/" >&2
  echo "  sudo systemctl daemon-reload && sudo systemctl enable --now relay-cloud-mcp" >&2
  exit 1
fi

echo "== deploy (local sleep verify strict; public verify when DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY=1) =="
sudo DEPLOY_STRICT_SLEEP_VERIFY=1 DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY="${DEPLOY_STRICT_PUBLIC_SLEEP_VERIFY:-1}" \
  -u relay bash deploy/deploy.sh

echo "== go-live gate =="
sudo -u relay bash -c "cd \"$APP_DIR\" && npm run go-live:cloud"

echo "== system-ready (from VM; also run from laptop after public URLs green) =="
sudo -u relay bash -c "cd \"$APP_DIR\" && npm run verify:system-ready"