export class RelayError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly statusCode: number;

  constructor(message: string, code = "relay_error", details?: unknown, statusCode = 400) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

export class AuthError extends RelayError {
  constructor(message: string, details?: unknown) {
    super(message, "auth_error", details, 401);
    this.name = "AuthError";
  }
}

export class ConfigurationError extends RelayError {
  constructor(message: string, details?: unknown) {
    super(message, "configuration_error", details, 400);
    this.name = "ConfigurationError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
