// Traceability: REQ-016
import { readFile, writeFile } from "node:fs/promises";
import { RelayError } from "./errors.js";
import { SecretBox } from "./secret-box.js";
import type { CredentialInfo, PlatformCredentials, PlatformId } from "./types.js";
import { PLATFORM_IDS } from "./types.js";
import path from "node:path";

interface CredentialsDocument {
  version: 1;
  platforms: Partial<Record<PlatformId, PlatformCredentials>>;
}

const ENV_KEYS: Record<PlatformId, { id: string[]; secret: string[] }> = {
  x: { id: ["X_CLIENT_ID", "TWITTER_CLIENT_ID"], secret: ["X_CLIENT_SECRET", "TWITTER_CLIENT_SECRET"] },
  threads: { id: ["THREADS_CLIENT_ID", "THREADS_APP_ID"], secret: ["THREADS_CLIENT_SECRET", "THREADS_APP_SECRET"] },
  tiktok: { id: ["TIKTOK_CLIENT_KEY"], secret: ["TIKTOK_CLIENT_SECRET"] },
  youtube: {
    id: ["YOUTUBE_CLIENT_ID", "GOOGLE_CLIENT_ID"],
    secret: ["YOUTUBE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"],
  },
  instagram: {
    id: ["INSTAGRAM_CLIENT_ID", "INSTAGRAM_APP_ID"],
    secret: ["INSTAGRAM_CLIENT_SECRET", "INSTAGRAM_APP_SECRET"],
  },
  linkedin: {
    id: ["LINKEDIN_CLIENT_ID"],
    secret: ["LINKEDIN_CLIENT_SECRET"],
  },
  facebook: {
    id: ["FACEBOOK_CLIENT_ID", "INSTAGRAM_CLIENT_ID", "INSTAGRAM_APP_ID"],
    secret: ["FACEBOOK_CLIENT_SECRET", "INSTAGRAM_CLIENT_SECRET", "INSTAGRAM_APP_SECRET"],
  },
  brevo: {
    id: [],
    secret: ["BREVO_API_KEY", "RELAY_BREVO_API_KEY"],
  },
};

function firstEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Client credentials come from environment variables or from credentials saved
 * in the console's Settings screen. Saved credentials are encrypted at rest.
 */
export class CredentialStore {
  private saved: Partial<Record<PlatformId, PlatformCredentials>> = {};

  private constructor(
    private readonly file: string,
    private readonly box: SecretBox,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  static async open(file: string, box: SecretBox, env: NodeJS.ProcessEnv): Promise<CredentialStore> {
    const store = new CredentialStore(file, box, env);
    try {
      const raw = await readFile(file, "utf8");
      const blob = JSON.parse(raw) as unknown;
      const doc = box.decrypt<CredentialsDocument>(blob as never);
      store.saved = doc.platforms ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RelayError(`Unable to read saved credentials at ${file}`, "credentials_unreadable");
      }
    }
    return store;
  }

  get(platform: PlatformId): PlatformCredentials {
    const keys = ENV_KEYS[platform];
    const fromEnv: PlatformCredentials = {
      clientId: firstEnv(this.env, keys.id),
      clientSecret: firstEnv(this.env, keys.secret),
    };
    const saved = this.saved[platform] ?? {};
    return {
      clientId: saved.clientId ?? fromEnv.clientId,
      clientSecret: saved.clientSecret ?? fromEnv.clientSecret,
      extra: { ...fromEnv.extra, ...saved.extra },
    };
  }

  isConfigured(platform: PlatformId): boolean {
    const creds = this.get(platform);
    if (platform === "brevo") return Boolean(creds.clientSecret?.trim());
    return Boolean(creds.clientId && creds.clientSecret);
  }

  info(platform: PlatformId): CredentialInfo {
    const creds = this.get(platform);
    const configured = platform === "brevo" ? Boolean(creds.clientSecret) : Boolean(creds.clientId && creds.clientSecret);
    if (!configured) return { platform, configured: false, source: "none" };
    const saved = this.saved[platform];
    const fromSettings = Boolean(saved?.clientId || saved?.clientSecret);
    return { platform, configured: true, source: fromSettings ? "settings" : "env" };
  }

  /** Installation-wide client credentials, used to bootstrap isolated tenants. */
  values(): Partial<Record<PlatformId, PlatformCredentials>> {
    const values: Partial<Record<PlatformId, PlatformCredentials>> = {};
    for (const platform of PLATFORM_IDS) {
      const credentials = this.get(platform);
      if (platform === "brevo") {
        if (credentials.clientSecret) values[platform] = credentials;
      } else if (credentials.clientId && credentials.clientSecret) {
        values[platform] = credentials;
      }
    }
    return values;
  }

  list(): CredentialInfo[] {
    return PLATFORM_IDS.map((platform) => this.info(platform));
  }

  async save(platform: PlatformId, credentials: PlatformCredentials): Promise<void> {
    const secret = credentials.clientSecret?.trim() ?? "";
    const clientId = credentials.clientId?.trim() ?? "";
    if (platform === "brevo") {
      if (!secret) {
        throw new RelayError("A Brevo API key is required", "credentials_incomplete");
      }
      this.saved[platform] = {
        clientId: clientId || "api-key",
        clientSecret: secret,
        extra: credentials.extra,
      };
    } else {
      if (!clientId || !secret) {
        throw new RelayError(
          `Both a client id and client secret are required for ${platform}`,
          "credentials_incomplete",
        );
      }
      this.saved[platform] = {
        clientId,
        clientSecret: secret,
        extra: credentials.extra,
      };
    }
    await this.persist();
  }

  async remove(platform: PlatformId): Promise<void> {
    delete this.saved[platform];
    await this.persist();
  }

  private async persist(): Promise<void> {
    const doc: CredentialsDocument = { version: 1, platforms: this.saved };
    const blob = this.box.encrypt(doc);
    await writeFile(this.file, JSON.stringify(blob, null, 2), "utf8");
    // Best effort: keep the credentials file readable only by the current user.
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(this.file, 0o600);
    } catch {
      // Not supported on every platform; the contents are encrypted anyway.
    }
  }
}

export function credentialsFilePath(dataDir: string): string {
  return path.join(dataDir, "credentials.enc.json");
}

