# Relay
## AI-native social publishing for Malaysian SMEs

**Grant application draft — Cradle CIP Spark / Cradle ecosystem**
**Applicant:** [LEGAL COMPANY NAME]
**Registration No.:** [SSM NO.]
**Founder(s):** [NAMES / EQUITY]
**Date:** [DATE]
**Website:** https://relay.duitpoket.fun
**Contact:** [EMAIL] · [PHONE]

> This is a working grant draft. Items in [brackets] must be confirmed by the applicant before submission. No revenue, customer or traction figures are invented here.

---

## 1. Executive summary

Relay is a self-hosted, AI-native publishing platform that lets a small Malaysian business run X, Threads, TikTok, YouTube and Instagram from one console. It combines scheduling, platform-native validation, approval workflows, media handling, auto-reply and an MCP server that lets AI agents publish and schedule through the same system.

The problem is not “another social media scheduler”. Malaysian SMEs and solo founders are being pushed into AI workflows, but the social platforms are fragmented, APIs differ, and most scheduling tools are foreign, seat-priced and not designed for agentic workflows or Malaysian operating realities.

Relay’s wedge is **distribution through AI agents**: one MCP endpoint exposes the same publishing capabilities to Claude, Cursor, Grok and other agents, while a human-friendly cloud console remains in control. The long-term opportunity is to become the **publishing and engagement layer for AI-run businesses** in Malaysia and ASEAN.

Current build status: live cloud console, five connected platforms, 19 Relay MCP tools plus a local TikTok Web bridge, 128 automated tests passing, and a deployed production service at relay.duitpoket.fun. We are seeking CIP Spark to turn the working prototype into a commercially launched, compliance-ready product with paying Malaysian SME customers.

---

## 2. Problem

1. **Fragmentation.** A Malaysian SME posts to TikTok, Instagram, Facebook, X and YouTube with different formats, limits and APIs. A single campaign becomes five manual jobs.
2. **AI agents cannot publish safely.** Claude, Cursor and other agents can draft content, but there is no controlled, auditable way for them to publish through a business’s actual accounts.
3. **Foreign tools are expensive and rigid.** Metricool, Buffer and Hootsuite are strong but not built around local support, Malaysian payment/ops realities, agent workflows or self-hosting.
4. **TikTok is a wall for small developers.** TikTok’s Content Posting API restricts unaudited apps to private-account posts; a carousel workflow is blocked even when the content and account are legitimate.
5. **Comments are left unanswered.** SMEs lose leads because replies depend on someone watching five inboxes.

---

## 3. Solution

Relay combines three layers:

### A. Human console
A cloud console for composing, validating, scheduling, previewing and publishing across five platforms, with platform-specific limits and media rules.

### B. MCP distribution layer
A token-protected MCP server exposes Relay to AI agents. An agent can call:
- `relay_post` — publish or schedule
- `relay_validate` — catch platform issues before publishing
- `relay_preview` — see exactly how the post will look
- `relay_queue`, `relay_history`, `relay_accounts`
- `relay_reply` / comment tools
- and the rest of the 19-tool Relay MCP surface

### C. TikTok Web bridge
Because TikTok’s official API blocks public carousels for unaudited apps, Relay includes a local browser worker that uses the already logged-in TikTok Studio session to post carousels as a human would. It records every job and does not copy TikTok cookies out of Chrome. This keeps TikTok carousel publishing possible while the app audit is pending.

### D. Auto-reply
Threads comments can be answered by a DeepSeek-backed reply engine with safety rules and a 30-minute window. Instagram comment permission is already granted; X and TikTok require additional provider access.

---

## 4. What is already working

| Area | Status |
|---|---|
| Cloud console | Live at relay.duitpoket.fun |
| Platforms | X, Threads, TikTok, YouTube, Instagram |
| Publishing | Text, images, video, Threads chains, Instagram carousels, TikTok photo carousels via web bridge |
| AI integration | Relay MCP server, 19 tools, stdio + Streamable HTTP |
| TikTok Web worker | Local MCP bridge, job logs, tested status tool |
| Auto-reply | Threads live with DeepSeek; Instagram scope ready; X/TikTok provider access still needed |
| Security | Password-protected console, signed HttpOnly session, encrypted OAuth tokens, AES-256-GCM secret store |
| Quality | 128 automated tests passing; production version deployed |
| TikTok proof | A real 3-slide public carousel was published through TikTok Studio and is visible on @duitpoket26 |

This is real working software, not a concept deck.

---

## 5. Market and opportunity

**Beachhead:** Malaysian SME owners, solo founders, agency operators and finance/education creators who publish daily but cannot afford a social team.

**Why now:**
- AI agents are becoming the default content workflow for founders.
- Malaysian SMEs are adopting TikTok and Instagram as primary discovery channels.
- Platform APIs are becoming stricter, increasing the value of a compliant, multi-platform layer.
- Local-language and local-payment support is underserved by global schedulers.

**Market sizing:** [INSERT TAM/SAM/SOM with a cited source and method. Do not submit unsourced numbers.]

**Initial customer profile:**
- 1–20 person Malaysian SME
- 2–5 active social accounts
- RM50k–RM5m annual revenue
- Owner or one marketer handles content

---

## 6. Business model

Indicative subscription tiers:

| Plan | Price | Included |
|---|---|---|
| Solo | RM49/month | 3 accounts, scheduling, basic analytics |
| Business | RM149/month | 5 accounts, approvals, auto-reply, MCP |
| Agency | RM399/month | Client workspaces, team seats, priority support |

Plus optional setup/automation services. Pricing must be validated with design partners before the grant submission.

**Unit economics to validate:** CAC, monthly churn, gross margin after AI/API costs, expansion revenue.

---

## 7. Go-to-market

1. **Design partners (0–3 months).** 10 Malaysian SMEs; free onboarding in exchange for weekly feedback and case studies.
2. **Creator/SME communities (3–6 months).** Partner with finance, education and small-business creators; publish proof-of-work content.
3. **Agency channel (6–12 months).** White-label client workspaces for Malaysian digital agencies.
4. **Agent ecosystem.** Publish Relay MCP integration guides for Claude, Cursor and Grok communities.
5. **Local moat.** Malaysian support, local invoicing, Bahasa Malaysia content templates and local payment methods.

---

## 8. Technology and architecture

- Node.js 24 + TypeScript monorepo
- `packages/core` — types, validation, scheduler, encrypted secret store, auto-reply engine
- `packages/platforms` — X, Threads, TikTok, YouTube and Instagram adapters
- `apps/mcp` — 19-tool MCP server, stdio and Streamable HTTP with OAuth
- `apps/web` — cloud console and API
- `apps/tiktok-web` — local CUA/Chrome TikTok Studio worker
- Tencent Cloud Singapore deployment; systemd services; Cloudflare tunnel
- OAuth tokens and settings encrypted at rest; no secrets in the repository

**Security posture:** password-protected console, HttpOnly signed session cookies, token-protected MCP HTTP endpoint, least-privilege provider scopes, full job records for the TikTok Web bridge.

---

## 9. Roadmap and grant milestones

### Months 1–3
- Harden onboarding and billing
- Recruit 10 design partners
- Complete Instagram auto-reply
- Move TikTok Web worker from laptop to cloud with encrypted session storage
- Publish security and data-retention documentation

### Months 4–6
- Launch paid plans
- 50 paying Malaysian SMEs
- Add approval workflows and team roles
- Add analytics and content performance feedback

### Months 7–9
- 150 paying customers
- Agency/white-label workspace
- Regional expansion (Singapore/Indonesia)
- SOC2-ready controls and incident response

### Months 10–12
- 300 paying customers
- RM[X] ARR
- Strategic partnerships with Malaysian SME/creator communities
- Series of published case studies with measurable time savings

---

## 10. Use of funds (CIP Spark)

Indicative allocation:

| Category | % | Purpose |
|---|---|---|
| Product & engineering | 45% | Cloud TikTok worker, Instagram auto-reply, billing, reliability |
| Cloud, AI and security | 20% | Infrastructure, model usage, audits, monitoring |
| Go-to-market | 20% | Design-partner acquisition, content, community partnerships |
| Compliance & operations | 10% | Legal, privacy, accounting, provider reviews |
| Contingency | 5% | Platform API changes and incident buffer |

Exact amounts: [INSERT GRANT AMOUNT AND BUDGET].

---

## 11. Team

- **[FOUNDER NAME]** — CEO/Product. [BIO]
- **[CO-FOUNDER NAME]** — CTO/Engineering. [BIO]
- Advisors: [NAMES]
- Hiring plan: [ROLES]

Equity split, full-time status and Malaysian ownership must be confirmed for eligibility.

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| TikTok API audit delays | Web bridge now; submit audit; keep human-in-loop fallback |
| Platform API changes | Adapter isolation, contract tests, rapid rollback |
| AI replies damage brand | Human approval option, classification rules, reply logging |
| Security breach | Encrypted secrets, least privilege, token rotation, audit logs |
| Customer concentration | Design partners across finance, education and retail |
| Cloud cost | Usage-based AI budget, caching, model routing |

---

## 13. Why Cradle / CIP Spark

Relay is a Malaysian-built, exportable software product with a working prototype and a clear distribution wedge through AI agents. CIP Spark would fund the transition from a capable prototype to a commercially validated Malaysian SaaS with paying SME customers, local support and a defensible agent-native workflow.

The grant would specifically de-risk:
1. Cloud migration of the TikTok Web bridge
2. Commercial launch and billing
3. Security/compliance documentation
4. 10 design partners → 50 paying customers

---

## 14. Application checklist

- [ ] Company incorporated in Malaysia; SSM number
- [ ] Malaysian ownership threshold confirmed
- [ ] Founders’ CVs and equity split
- [ ] 12-month budget and milestone plan
- [ ] Product demo video
- [ ] 3–5 customer discovery interviews
- [ ] Pricing validation notes
- [ ] Data privacy/security one-pager
- [ ] Grant-specific forms and declarations
- [ ] Financial statements / bank statements as required

---

## Appendix A — Verified product evidence

- Live console: https://relay.duitpoket.fun
- MCP endpoint: https://mcp.duitpoket.fun/mcp
- Deployed version: `d02b2ef` (TikTok Web worker merge) / latest production at time of writing
- Automated tests: 128 passing
- Public TikTok carousel proof: three-slide carousel on @duitpoket26, sound “Bukan Milik Aku”
- TikTok Web worker records: `.data/tiktok-web/jobs/*.json`

## Appendix B — Honest limitations

- TikTok public carousel currently uses the browser bridge; official API access awaits TikTok audit.
- X and TikTok auto-reply still require provider access or additional API work.
- Cloud TikTok login via QR did not reliably persist; local worker is the current production path.
- Revenue and customer numbers must be filled with actual data before submission.

---

*Prepared for Cradle CIP Spark / Cradle grant discussion. All unverified company, team and financial fields must be completed by the applicant.*
