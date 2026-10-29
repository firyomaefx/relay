#!/usr/bin/env node
import { loadCloudConfig } from "./config.js";
import { CloudStore } from "./db.js";
import { CloudLedger } from "./ledger.js";
import { cleanupMedia } from "./retention.js";

function usage(): void {
  process.stderr.write(`Relay Cloud admin

Usage:
  relay-cloud-admin create-customer <name> [--owner]
  relay-cloud-admin create-key <customerId> [label]
  relay-cloud-admin revoke-key <keyId>
  relay-cloud-admin credit <customerId> <amount> [reference] [note]
  relay-cloud-admin payments <customerId>
  relay-cloud-admin cleanup-media [days] [--apply] [--include-owner]
  relay-cloud-admin list-customers
  relay-cloud-admin list-keys [customerId]

Requires RELAY_CLOUD_ENABLED=1 and RELAY_CLOUD_TOKEN_KEY.
`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(command ? 0 : 1);
  }
  const config = loadCloudConfig();
  if (!config.enabled) {
    process.stderr.write("Cloud mode is disabled. Set RELAY_CLOUD_ENABLED=1.\n");
    process.exit(1);
  }
  const store = CloudStore.open(config.dbPath);
  const ledger = new CloudLedger(config.dbPath);
  try {
    switch (command) {
      case "create-customer": {
        const name = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();
        const owner = args.includes("--owner");
        if (!name) throw new Error("Customer name is required.");
        const customer = store.createCustomer({ displayName: name, owner });
        process.stdout.write(`${JSON.stringify(customer, null, 2)}\n`);
        return;
      }
      case "create-key": {
        const customerId = args[0];
        if (!customerId) throw new Error("customerId is required.");
        const label = args.slice(1).join(" ").trim();
        const key = store.createApiKey(customerId, label || undefined);
        process.stdout.write(`API key created. Copy it now; it will not be shown again.\n\n${key.key}\n\n${JSON.stringify({ ...key, key: "[redacted]" }, null, 2)}\n`);
        return;
      }
      case "revoke-key": {
        const keyId = args[0];
        if (!keyId) throw new Error("keyId is required.");
        process.stdout.write(`${JSON.stringify(store.revokeApiKey(keyId), null, 2)}\n`);
        return;
      }
      case "list-customers": {
        process.stdout.write(`${JSON.stringify(store.listCustomers(), null, 2)}\n`);
        return;
      }
      case "list-keys": {
        process.stdout.write(`${JSON.stringify(store.listApiKeys(args[0]), null, 2)}\n`);
        return;
      }
      case "credit": {
        const customerId = args[0];
        const amount = Number(args[1]);
        if (!customerId || !store.getCustomer(customerId)) throw new Error("A valid customerId is required.");
        if (!Number.isInteger(amount) || amount <= 0) throw new Error("Amount must be a positive whole number.");
        const reference = args[2]?.trim() || `manual:${Date.now()}`;
        const note = args.slice(3).join(" ").trim() || "manual top-up";
        const result = ledger.recordTopup({ customerId, amount, reference, note, currency: "MYR", provider: "manual" });
        process.stdout.write(`${JSON.stringify({ ...result, balance: ledger.balanceWithHold(customerId) }, null, 2)}\n`);
        return;
      }
      case "payments": {
        const customerId = args[0];
        if (!customerId || !store.getCustomer(customerId)) throw new Error("A valid customerId is required.");
        process.stdout.write(`${JSON.stringify(ledger.listPayments(customerId, 50), null, 2)}\n`);
        return;
      }
      case "cleanup-media": {
        const days = Number(args.find((arg) => !arg.startsWith("--")) ?? "30");
        if (!Number.isInteger(days) || days < 1) throw new Error("Days must be a positive whole number.");
        const apply = args.includes("--apply");
        const includeOwner = args.includes("--include-owner");
        const results = await cleanupMedia(store, config, { days, apply, includeOwner });
        process.stdout.write(`${JSON.stringify({ dryRun: !apply, days, results }, null, 2)}\n`);
        return;
      }
      default:
        usage();
        process.exit(1);
    }
  } finally {
    ledger.close();
    store.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Cloud admin error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
