# Relay health Worker

Cloudflare Cron Trigger Worker that checks `https://relay.duitpoket.fun/api/health`
every five minutes. It is a secondary check; the production `relay-health.timer`
and GCP uptime alert remain the primary alert path.

```powershell
cd workers/relay-health
npm install
cf deploy
```

Set an optional `ALERT_WEBHOOK_URL` secret to receive failures. Without it the
Worker logs the failure only.
