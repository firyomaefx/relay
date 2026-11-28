import type { CloudLedger } from "./ledger.js";
import type { CloudStore } from "./db.js";
import type { TenantManager } from "./tenants.js";
import { assessThreadsAutoReply } from "./threads-autoreply-eligibility.js";

export interface TenantAutomationHealthRow {
  customerId: string;
  displayName: string;
  brevoConnected: boolean;
  deepSeek: boolean;
  libraryCount: number;
  webhookRegistered: boolean;
  lastWebhookAt: string | null;
  automationEnabled: boolean;
  schedulerOwned: boolean;
  schedulerRunning: boolean;
  queuePending: number;
  balance: number;
  threadsConnected: boolean;
  threadsAutoreplyActive: boolean;
  issues: string[];
}

export interface AutomationHealthSummary {
  tenantSchedulerPulseMs: number;
  customers: TenantAutomationHealthRow[];
  issueCount: number;
}

function staleWebhook(lastAt: string | null, staleMs: number): boolean {
  if (!lastAt) return true;
  const elapsed = Date.now() - Date.parse(lastAt);
  return !Number.isFinite(elapsed) || elapsed > staleMs;
}

export async function summarizeAutomationHealth(
  store: CloudStore,
  ledger: CloudLedger,
  tenants: TenantManager,
  options: { staleWebhookMs?: number } = {},
): Promise<AutomationHealthSummary> {
  const staleMs = options.staleWebhookMs ?? 48 * 60 * 60 * 1000;
  const pulseMs = Number(process.env.RELAY_CLOUD_TENANT_SCHEDULER_MS ?? "60000");
  const customers: TenantAutomationHealthRow[] = [];
  let issueCount = 0;
  for (const customer of store.listCustomers()) {
    if (customer.owner || customer.status !== "active") continue;
    const issues: string[] = [];
    try {
      const relay = await tenants.get(customer);
      const [program, scheduler, queue, accounts] = await Promise.all([
        relay.getEmailProgram(),
        relay.schedulerStatus(),
        relay.listQueue(),
        relay.accounts(),
      ]);
      const pending = queue.filter((job) => job.status === "pending").length;
      const brevo = accounts.some((entry) => entry.platform === "brevo");
      const threads = await assessThreadsAutoReply(customer, relay, ledger);
      const row: TenantAutomationHealthRow = {
        customerId: customer.id,
        displayName: customer.displayName,
        brevoConnected: brevo,
        deepSeek: program.health?.deepSeekConfigured ?? Boolean(relay.getDeepSeekApiKey()),
        libraryCount: program.libraryCount,
        webhookRegistered: program.health?.webhookRegistered ?? false,
        lastWebhookAt: program.program.lastWebhookAt ?? null,
        automationEnabled: program.health?.automationEnabled ?? false,
        schedulerOwned: scheduler.ownedByThisProcess,
        schedulerRunning: scheduler.running,
        queuePending: pending,
        balance: ledger.balanceWithHold(customer.id).available,
        threadsConnected: threads.threadsConnected,
        threadsAutoreplyActive: threads.active,
        issues,
      };
      if (pulseMs > 0 && pending > 0 && !scheduler.running) {
        issues.push("Queue has pending jobs but scheduler is not running");
      }
      if (brevo && program.libraryCount > 0 && !row.webhookRegistered) {
        issues.push("Brevo connected but inbound webhook is not registered");
      }
      if (program.health?.automationEnabled && brevo && staleWebhook(program.program.lastWebhookAt ?? null, staleMs)) {
        issues.push("No recent inbound webhook activity (check RELAY_PUBLIC_BASE_URL)");
      }
      if (threads.threadsConnected && threads.eligible && !threads.enabled) {
        issues.push(threads.reason ?? "Threads auto-reply eligible but disabled");
      } else if (threads.threadsConnected && threads.enabled && !threads.threadsReady) {
        issues.push(threads.reason ?? "Threads auto-reply enabled but account lacks reply scopes");
      } else if (threads.threadsConnected && !threads.keyConfigured) {
        issues.push("Threads connected but DeepSeek key missing (auto-reply idle)");
      } else if (threads.threadsConnected && threads.paidTopupMilliUsd < threads.minimumTopupMilliUsd) {
        issues.push(threads.reason ?? "Threads connected but top-up below auto-reply minimum");
      }
      issueCount += issues.length;
      customers.push(row);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      issueCount += 1;
      customers.push({
        customerId: customer.id,
        displayName: customer.displayName,
        brevoConnected: false,
        deepSeek: false,
        libraryCount: 0,
        webhookRegistered: false,
        lastWebhookAt: null,
        automationEnabled: false,
        schedulerOwned: false,
        schedulerRunning: false,
        queuePending: 0,
        balance: ledger.balanceWithHold(customer.id).available,
        threadsConnected: false,
        threadsAutoreplyActive: false,
        issues,
      });
    }
  }
  return { tenantSchedulerPulseMs: pulseMs, customers, issueCount };
}