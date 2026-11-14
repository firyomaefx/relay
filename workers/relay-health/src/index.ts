export default {
  async scheduled(_controller: ScheduledController, env: { ALERT_WEBHOOK_URL?: string }, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const response = await fetch("https://relay.duitpoket.fun/api/health", {
        headers: { "User-Agent": "relay-health-worker/1" },
      });
      if (response.ok) return;
      const text = `Relay health check failed: HTTP ${response.status}`;
      console.error(text);
      if (env.ALERT_WEBHOOK_URL) {
        await fetch(env.ALERT_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        }).catch(() => undefined);
      }
    })());
  },
} satisfies ExportedHandler<{ ALERT_WEBHOOK_URL?: string }>;
