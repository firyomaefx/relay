export interface WaitlistWebhookConfig {
  url: string;
  key?: string;
  keyHeader?: string;
}

export interface WaitlistCreatedPayload {
  event: "waitlist.created";
  waitlist_id: string;
  created_at: string;
  pending_total: number;
}

const WEBHOOK_TIMEOUT_MS = 5000;

/** No-op when RELAY_WAITLIST_WEBHOOK_URL is unset. */
export function loadWaitlistWebhookConfig(env: NodeJS.ProcessEnv = process.env): WaitlistWebhookConfig | null {
  const url = env.RELAY_WAITLIST_WEBHOOK_URL?.trim();
  if (!url) return null;
  const key = env.RELAY_WAITLIST_WEBHOOK_KEY?.trim();
  const keyHeader = env.RELAY_WAITLIST_WEBHOOK_KEY_HEADER?.trim();
  return {
    url,
    key: key || undefined,
    keyHeader: keyHeader || undefined,
  };
}

export function waitlistWebhookHeaders(config: WaitlistWebhookConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!config.key || !config.keyHeader) return headers;
  const value = /^authorization$/i.test(config.keyHeader) ? `Bearer ${config.key}` : config.key;
  headers[config.keyHeader] = value;
  return headers;
}

export function buildWaitlistCreatedPayload(
  entry: { id: string; createdAt: string },
  pendingTotal: number,
): WaitlistCreatedPayload {
  return {
    event: "waitlist.created",
    waitlist_id: entry.id,
    created_at: entry.createdAt,
    pending_total: pendingTotal,
  };
}

async function postWaitlistWebhook(
  config: WaitlistWebhookConfig,
  body: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: waitlistWebhookHeaders(config),
    body,
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

/** Fire-and-forget: does not throw; one retry after failure; never logs the webhook key. */
export function notifyWaitlistCreated(
  config: WaitlistWebhookConfig | null,
  payload: WaitlistCreatedPayload,
  log: (message: string) => void = console.error,
): void {
  if (!config) return;
  const body = JSON.stringify(payload);
  void (async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await postWaitlistWebhook(config, body, AbortSignal.timeout(WEBHOOK_TIMEOUT_MS));
        return;
      } catch (error) {
        lastError = error;
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    log(`waitlist webhook failed: ${detail}`);
  })();
}