# Manus AI + Relay Cloud (sleep mode)

Manus is **not** integrated into the Relay repository. Use it as an external daily-credits worker alongside Relay's always-on schedulers.

## Evaluation (≈300 credits/day)

| Question | Answer |
|----------|--------|
| Can Manus run sleep mode, webhooks, or billing? | **No** — needs Relay on the VM. |
| Best use of credits? | **Yes** — caption batches, promo email HTML, Threads reply tone, landing copy tests (see [manus-daily-prompts.md](./manus-daily-prompts.md)). |
| Replaces operator deploy? | **No** — merge, tunnel `cloud-mcp` → 4321, `go-live:cloud` stay manual until green. |
| Required for system ready? | **No** — copy for email library only. |

**Conclusion:** Keep Manus in the loop for **content research and drafts**; do not budget credits for infra or publishing automation Relay already implements on PR #61.

**Operator note (Nov 2026):** Manus connected on the operator PC is sufficient — run prompts from [manus-daily-prompts.md](./manus-daily-prompts.md) and paste results into Relay. No API key or repo change is required.

## Split of work

| Manus (≈300 credits/day) | Relay Cloud (24/7 on server) |
|--------------------------|-------------------------------|
| Research audiences, competitors, captions | Publish X, Threads, TikTok, YouTube, Instagram |
| Draft posts, email copy, campaign ideas | Brevo Email tab: library, schedule, inbound promo replies |
| Outreach lists, landing copy variants | Threads comment auto-reply (customer DeepSeek key) |
| Browser-style exploration you do not want in prod | Stripe/Polar top-up, ledger, queue, MCP tools |

Copy-paste prompts: [manus-daily-prompts.md](./manus-daily-prompts.md).

## Suggested daily loop (minimal supervision)

1. **Manus:** produce a batch of captions + one promo email HTML snippet + optional Threads reply tone notes.
2. **You or MCP:** paste into Relay composer, Email library, or `relay_post` with `schedule_at`.
3. **Relay:** `RELAY_CLOUD_TENANT_SCHEDULER_MS` keeps tenant schedulers alive on console + cloud MCP — no browser required.
4. **Operator:** with `RELAY_WAITLIST_AUTO_APPROVE=1`, signups auto-invite (pulse clears backlog). Email to `RELAY_OPERATOR_ALERT_EMAIL` on automation drift (and optional weekly revenue digest if you set a goal).
5. **Customers:** low-balance and top-up receipt emails fire automatically when `RELAY_EMAIL_*` is configured.

## Optional revenue tracking

Prepaid top-ups are tracked in USD (milliUSD). Use `GET /api/cloud/admin/revenue-summary` or the admin Revenue goal card if you set `RELAY_REVENUE_GOAL_MYR`. Manus does not replace sales — it accelerates content you feed into Relay.

## When not to use Manus for Relay

- OAuth connect flows (use Relay console `/connect` or customer Settings).
- Brevo inbound webhook registration (Relay registers when Brevo is live).
- Ledger, refunds, or customer invites (Relay admin only).