# Relay Cloud
## The trusted publishing layer for Malaysia's AI-agent economy

**Cradle CIP Spark grant application — final pitch**
**Applicant:** [LEGAL COMPANY NAME] · **SSM:** [NO.] · **Date:** [DATE]
**Founder(s):** [NAME(S)] · **Equity:** [SPLIT] · **Contact:** [EMAIL / PHONE]
**Live product:** https://relay.duitpoket.fun · **MCP:** https://mcp.duitpoket.fun/mcp

> **Submission note:** Bracketed items are applicant facts to confirm. All forward-looking customer, revenue and market figures are explicitly labelled targets or projections, not claims of achieved traction.

---

## 1. The one-line thesis

**Every Malaysian SME will soon have an AI agent drafting its content. Relay is the trusted layer that lets those agents publish, engage and stay accountable across X, Threads, TikTok, YouTube and Instagram — from one Malaysian-built cloud console.**

Relay is not another scheduler. It is **publishing infrastructure for the agent economy**, with a human console for control and an MCP interface for AI agents.

---

## 2. Why this matters to Malaysia now

Three shifts are happening at the same time:

1. **AI agents are becoming the content team.** Founders already use Claude, Cursor and Grok to write captions, plan campaigns and answer customers. These agents cannot safely publish to a business's real accounts.
2. **Social platforms are the SME storefront.** For Malaysian SMEs, TikTok and Instagram are discovery engines, not optional marketing channels. Yet each platform has different limits, APIs and failure modes.
3. **Global SaaS does not fit local operating reality.** Foreign schedulers are seat-priced, English-first, API-limited and not designed for agent workflows, local support or Malaysian payment/ops needs.

The result: Malaysian SMEs either hire an agency they cannot afford, or post inconsistently and lose leads. Relay closes that gap with a **Malaysian-owned, agent-native publishing layer**.

**Why Cradle should care:** this is not a local services business. It is exportable software infrastructure with a defensible data/workflow moat, built by a Malaysian team, addressing a regional SME market.

---

## 3. Problem, in the customer's words

- “I have five tabs open and still forget to post.”
- “My AI writes the content, but I still copy-paste it everywhere.”
- “TikTok blocks my carousel because my developer app is not audited.”
- “Comments sit unanswered for days.”
- “I cannot afford a social media hire, let alone an agency.”

Relay removes the copy-paste, the platform-specific mistakes and the comment backlog.

---

## 4. The product — already built, already live

### 4.1 One console, five platforms
Compose once, validate per platform, preview natively, schedule or publish to X, Threads, TikTok, YouTube and Instagram. Platform-specific rules — character limits, carousel counts, video constraints, TikTok privacy, thread chaining — are enforced before publishing.

### 4.2 MCP: the agent distribution wedge
Relay exposes **19 MCP tools** to Claude, Cursor, Grok and other agents:
- `relay_post`, `relay_validate`, `relay_preview`
- `relay_queue`, `relay_history`, `relay_accounts`
- comment tools, reply tools and scheduling tools

This means an AI agent can do the work while the business keeps a human console, approvals and a full audit trail. **The MCP interface is the distribution channel; the console is the control plane.**

### 4.3 TikTok Web bridge
TikTok's Content Posting API blocks public carousels for unaudited apps. Relay's browser bridge posts carousels through the logged-in TikTok Studio session, exactly like a human, and records every job. This turns a hard platform limitation into a working product capability while the official audit is pursued.

### 4.4 Auto-reply
Threads comments can be answered by a DeepSeek-powered reply engine with classification, safety rules and a 30-minute window. Instagram comment permission is already granted. X and TikTok require additional provider access or implementation.

### 4.5 Security and control
Password-protected console, signed HttpOnly session, encrypted OAuth tokens, AES-256-GCM secret storage, token-protected MCP endpoint, least-privilege scopes. Built for businesses that cannot hand over raw credentials to an AI.

---

## 5. Verified progress (not a concept)

| Evidence | Status |
|---|---|
| Cloud console | Live at relay.duitpoket.fun |
| Platform coverage | X, Threads, TikTok, YouTube, Instagram |
| AI interface | Relay MCP, 19 tools, stdio + Streamable HTTP |
| TikTok carousel proof | Real 3-slide public carousel posted on @duitpoket26 |
| TikTok Web worker | Local MCP bridge, job records, status verified |
| Auto-reply | Threads live with DeepSeek; Instagram permission ready |
| Quality | 128 automated tests passing |
| Deployment | Tencent Cloud + Cloudflare, systemd services |
| Security | Encrypted secrets, signed sessions, token-protected MCP |

**Honest limits:** TikTok public carousels currently use the browser bridge; X/TikTok auto-reply still need provider access; cloud TikTok QR login did not reliably persist, so the local worker is the current path. We disclose these rather than overclaim.

---

## 6. Market and wedge

**Beachhead:** Malaysian SME owners and solo founders in finance, education and services who publish daily across 2–5 accounts and cannot justify a full-time social hire.

**Expansion:** Malaysian agencies managing multiple SME clients → Southeast Asian SMEs → global AI-agent users who need a trusted publishing endpoint.

**Why the wedge is defensible:**
- Agent-native MCP interface creates switching costs for AI workflows.
- Platform-specific validation and recovery logic is hard to replicate.
- Local support, local payment and Bahasa Malaysia content templates.
- Data on what works per platform compounds into better recommendations.
- Browser bridge capability for platforms that under-serve small developers.

**Market sizing:** [INSERT TAM/SAM/SOM with source, method and date. Do not submit unsourced numbers.]

---

## 7. Business model and path to revenue

| Plan | Indicative price | Target customer |
|---|---|---|
| Solo | RM49/month | 1 founder, 3 accounts |
| Business | RM149/month | 2–5 accounts, approvals, auto-reply, MCP |
| Agency | RM399/month | Multi-client workspaces, seats, priority support |

**Revenue logic:** recurring subscription + onboarding/automation services. AI and platform API costs are usage-managed; gross margin target [X]% validated during the grant period.

**Illustrative 12-month target (not a promise):**
- 10 design partners in months 1–3
- 50 paying customers by month 6
- 150 paying customers by month 9
- RM[X] MRR by month 12

All targets will be revised with actual cohort data.

---

## 8. Go-to-market that fits Malaysian SMEs

1. **Design partners:** 10 SMEs; free onboarding for weekly feedback and case studies.
2. **Creator-led proof:** finance/education creators publish real results; TikTok/Instagram native content.
3. **Agency channel:** white-label workspaces for agencies that already manage SME clients.
4. **Agent ecosystem:** integration guides for Claude/Cursor/Grok; MCP directories; “post from your agent” demos.
5. **Local trust:** Malaysian support, local invoicing, Bahasa Malaysia templates and community workshops.

---

## 9. Why Relay wins

| Alternative | Limitation | Relay advantage |
|---|---|---|
| Metricool / Buffer / Hootsuite | Strong schedulers, not agent-native; foreign support | MCP-first, Malaysian support, self-host option |
| Hiring an agency | Expensive, slow, opaque | Software cost, instant, auditable |
| Platform-native schedulers | One platform at a time | Five platforms, one workflow |
| Generic AI chat | Cannot publish safely | Controlled tools, approvals, audit trail |

**Moat over time:** workflow data, platform-specific edge-case handling, agent integrations, local distribution and trust.

---

## 10. Use of CIP Spark funds

| Category | % | What it buys |
|---|---|---|
| Product & engineering | 45% | Cloud TikTok worker, Instagram auto-reply, billing, reliability |
| Cloud, AI & security | 20% | Infrastructure, model usage, monitoring, security review |
| Go-to-market | 20% | Design partners, creator content, agency partnerships |
| Compliance & operations | 10% | Legal, privacy, accounting, platform reviews |
| Contingency | 5% | API changes and incident buffer |

**Grant amount:** [RM AMOUNT]. **Runway:** [MONTHS]. **Milestones tied to disbursement:** [DETAILS].

---

## 11. 12-month milestones and KPIs

| Quarter | Product | Commercial | KPI |
|---|---|---|---|
| Q1 | Cloud TikTok worker, Instagram auto-reply | 10 design partners | Activation, weekly active accounts |
| Q2 | Billing, approvals, team roles | First paying customers | 50 paying, churn < [X]% |
| Q3 | Analytics, agency workspace | Agency partnerships | 150 paying, NPS > [X] |
| Q4 | Regional readiness, security review | Expansion | RM[X] MRR, 300 paying |

---

## 12. Impact

- **SME productivity:** hours saved per week on publishing and comment handling.
- **Digital inclusion:** affordable alternative to agencies for micro-SMEs.
- **Malaysian IP:** locally built infrastructure exported to ASEAN.
- **AI safety:** controlled agent publishing instead of unchecked automation.
- **Job creation:** engineering, support and partnership roles in Malaysia.

Impact metrics will be measured per design partner: hours saved, posts published, response time, leads generated.

---

## 13. Risks and de-risking

| Risk | Mitigation |
|---|---|
| TikTok audit delay | Web bridge now; audit submitted; human fallback |
| Platform API changes | Adapter isolation, contract tests, fast rollback |
| AI reply brand risk | Approval mode, classification, logging |
| Security breach | Encryption, least privilege, rotation, audits |
| Low willingness to pay | Design-partner pricing tests before scale |
| Founder concentration | Documented runbooks, contractor bench |

---

## 14. Why this application should be selected

1. **Working product, not a slide deck.** Live console, five platforms, MCP, public TikTok carousel proof, 128 tests.
2. **Category creation, not a clone.** Agent-native publishing infrastructure is a new layer; Relay is early.
3. **Malaysian advantage.** Local support, local payment, Bahasa content and a regional SME wedge.
4. **Clear commercialization.** Subscription tiers, design-partner pipeline, agency channel.
5. **Grant-specific de-risking.** Funds convert a capable prototype into a paid, secure, cloud-ready product.
6. **Honest execution.** We disclose limitations and have a plan for each.

CIP Spark would not be funding an idea. It would be funding the **last mile from working prototype to repeatable Malaysian SaaS revenue**.

---

## 15. Application checklist

- [ ] SSM incorporation and Malaysian ownership confirmed
- [ ] Founder CVs and equity split
- [ ] 12-month budget and milestone schedule
- [ ] Product demo video
- [ ] 3–5 customer discovery interviews
- [ ] Pricing validation notes
- [ ] Data privacy/security one-pager
- [ ] Financial statements / bank statements
- [ ] Grant-specific forms and declarations

---

*Prepared for Cradle CIP Spark. All bracketed company, team, market and financial fields must be completed and verified by the applicant before submission.*
