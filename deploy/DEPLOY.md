# Deploying Relay to a Google Cloud e2-micro

Free tier: e2-micro, 30 GB standard disk, us-central1 / us-west1 / us-east1. Ubuntu 24.04. Node >= 22.18 (24 LTS recommended).

1. `sudo useradd -r -m -d /opt/relay relay`; install Node 24, git, curl, cloudflared.
2. `sudo -u relay git clone https://github.com/firyomaefx/relay.git /opt/relay`
3. `sudo mkdir -p /etc/relay && sudo cp deploy/.env.example /etc/relay/relay.env && sudo chmod 600 /etc/relay/relay.env`; fill it in.
   Set `RELAY_CONSOLE_URL` and `RELAY_PUBLIC_MEDIA_BASE_URL` to `https://relay.duitpoket.fun` (OAuth callbacks are built from it), `RELAY_HOST=127.0.0.1`, `RELAY_DATA_DIR=/opt/relay/.data`, `RELAY_NO_BROWSER=1`.
4. Copy `.data/` from the laptop (accounts/tokens/queue live in `.data`); `chown -R relay`.
5. `sudo cp deploy/*.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now relay-console relay-mcp`
6. Tunnel: copy tunnel credentials JSON to `/etc/cloudflared/`, use `deploy/cloudflared-config.yml.example` as `/etc/cloudflared/config.yml`, `sudo cloudflared service install`. Stop the laptop tunnel first.
7. Updates: `sudo -u relay bash deploy/deploy.sh` (relay user needs sudo for `systemctl restart relay-console relay-mcp` only).

MCP: `https://mcp.duitpoket.fun/mcp`, header `Authorization: Bearer $RELAY_MCP_HTTP_TOKEN` (falls back to `.data/mcp-http-token`).

