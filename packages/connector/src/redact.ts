/** REQ-020: diagnosable logs without token or secret values. */
const PATTERNS: Array<[RegExp, string]> = [
  [/\brcs_[A-Za-z0-9_-]+/g, "rcs_[redacted]"],
  [/\brlc_[A-Za-z0-9_-]+/g, "rlc_[redacted]"],
  [/\brly_[A-Za-z0-9_-]+/g, "rly_[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"],
  [/(^|[\s?&#])((?:token|code|secret|password)=)[^&\s]+/gi, "$1$2[redacted]"],
];

export function redact(value: string): string {
  return PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

export interface ConnectorLogEvent {
  clientId: string;
  state: string;
  detail: string;
}

export function logConnectorEvent(logger: (line: string) => void, event: ConnectorLogEvent): void {
  logger(JSON.stringify({
    ts: new Date().toISOString(),
    client: event.clientId,
    state: event.state,
    detail: redact(event.detail),
  }));
}
