#!/usr/bin/env node
import { loadCloudConfig } from "./config.js";
import { CloudStore } from "./db.js";

function usage(): void {
  process.stderr.write(`Relay Cloud admin

Usage:
  relay-cloud-admin create-customer <name> [--owner]
  relay-cloud-admin create-key <customerId> [label]
  relay-cloud-admin revoke-key <keyId>
  relay-cloud-admin list-customers
  relay-cloud-admin list-keys [customerId]

Requires RELAY_CLOUD_ENABLED=1 and RELAY_CLOUD_TOKEN_KEY.
`);
}

function main(): void {
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
      default:
        usage();
        process.exit(1);
    }
  } finally {
    store.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`Cloud admin error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
