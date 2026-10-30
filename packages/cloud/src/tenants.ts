import { createHmac } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRelay } from "@relay/platforms";
import { PLATFORM_IDS, type RelayService } from "@relay/core";
import type { CloudConfig } from "./config.js";
import type { CloudStore, Customer } from "./db.js";

export interface TenantManagerOptions {
  store: CloudStore;
  config: CloudConfig;
  env?: NodeJS.ProcessEnv;
  forceMock?: boolean;
  consoleUrl?: string;
  logger?: (message: string) => void;
}

/**
 * Per-customer RelayService backed by an isolated data directory. The owner
 * customer points at the existing RELAY_DATA_DIR, so the current setup remains
 * exactly where it is. No tenant starts the scheduler here.
 */
export class TenantManager {
  private readonly services = new Map<string, Promise<RelayService>>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly forceMock: boolean;
  private readonly consoleUrl: string;
  private readonly logger: (message: string) => void;

  constructor(private readonly options: TenantManagerOptions) {
    this.env = options.env ?? process.env;
    this.forceMock = options.forceMock ?? /^(1|true|yes)$/i.test(this.env.RELAY_MOCK?.trim() ?? "");
    this.consoleUrl = options.consoleUrl ?? this.env.RELAY_CONSOLE_URL?.trim() ?? "http://127.0.0.1:4317";
    this.logger = options.logger ?? (() => undefined);
  }

  async get(customer: Customer): Promise<RelayService> {
    const existing = this.services.get(customer.id);
    if (existing) return existing;
    const pending = this.open(customer);
    this.services.set(customer.id, pending);
    try {
      return await pending;
    } catch (error) {
      this.services.delete(customer.id);
      throw error;
    }
  }

  private async open(customer: Customer): Promise<RelayService> {
    const fallback = customer.owner
      ? this.options.config.ownerDataDir
      : path.join(this.options.config.tenantDataRoot, customer.id);
    const stored = this.options.store.getCustomerData(customer.id);
    const dataDir = stored ?? fallback;
    if (!stored) this.options.store.getOrCreateCustomerData(customer.id, dataDir);
    await mkdir(dataDir, { recursive: true });
    if (!customer.owner) await this.ensureTenantSecret(dataDir, customer.id);
    const tenantEnv = { ...this.env };
    // A platform-wide owner key must never satisfy a tenant's own API-key gate.
    if (!customer.owner) delete tenantEnv.DEEPSEEK_API_KEY;
    const relay = await createRelay({
      dataDir,
      forceMock: this.forceMock,
      consoleUrl: this.consoleUrl,
      // Cloud tenants get the engine capability; the cloud scheduler and the
      // autoreply tool enforce the paid-top-up and API-key gate per customer.
      env: customer.owner ? this.env : { ...tenantEnv, THREADS_AUTOREPLY_ENABLED: "true" },
      logger: (message) => this.logger(`[tenant ${customer.id}] ${message}`),
    });
    await this.recordMappings(customer, relay);
    return relay;
  }

  /** Customer tokens use a per-tenant key derived from RELAY_CLOUD_TOKEN_KEY. */
  private async ensureTenantSecret(dataDir: string, customerId: string): Promise<void> {
    const file = path.join(dataDir, "secret.key");
    try {
      await readFile(file);
      return;
    } catch {
      // Create below.
    }
    const root = this.options.config.tokenKey;
    if (!root) throw new Error("RELAY_CLOUD_TOKEN_KEY is not configured.");
    const key = createHmac("sha256", root).update(`relay-cloud-tenant:${customerId}`).digest();
    await writeFile(file, key, { mode: 0o600 });
    try {
      await chmod(file, 0o600);
    } catch {
      // Windows ACLs are host-managed.
    }
  }

  /** Mapping tables are additive audit metadata; tenant isolation itself is the data directory. */
  async recordMappings(customer: Customer, relay: RelayService): Promise<void> {
    const accounts = await relay.accounts();
    const prior = new Map(this.options.store.listCustomerAccounts(customer.id).map((entry) => [entry.platform, entry.status]));
    for (const account of accounts) {
      this.options.store.recordAccountOwner(customer.id, account.platform, account.handle || account.platform, customer.owner ? "owner" : "cloud");
    }
    for (const platform of PLATFORM_IDS) {
      const account = accounts.find((entry) => entry.platform === platform);
      const status = account ? "ready" : prior.get(platform) === "needs_reconnect" ? "needs_reconnect" : "not_connected";
      this.options.store.setCustomerAccount(
        customer.id,
        platform,
        status,
        account ? (account as unknown as Record<string, unknown>) : null,
      );
    }
    const queue = await relay.listQueue();
    for (const job of queue) this.options.store.recordJobOwner(customer.id, job.id, customer.owner ? "owner" : "cloud");
    const history = await relay.history(1000);
    for (const record of history) this.options.store.recordPostOwner(customer.id, record.id, customer.owner ? "owner" : "cloud");
  }

  async close(): Promise<void> {
    const services = [...this.services.values()];
    this.services.clear();
    for (const pending of services) {
      try {
        const relay = await pending;
        await relay.close();
      } catch {
        // Closing is best effort; one tenant must not block shutdown.
      }
    }
  }
}
