# Relay Plus — marketing plan (planned, not launched)

Status: planning only. Nothing on the public site should claim Relay Plus exists until billing, entitlements and the page are implemented.

## Positioning

Relay Plus is for operators, small agencies and builders who publish every week and want a predictable monthly allowance instead of topping up manually.

One-line:

> **Relay Plus — one API, every network, a predictable monthly publishing budget.**

It is not a “cheaper” plan and should not be marketed as the cheapest option. The value is convenience, included credit, priority scheduling and operator support.

## Proposed tiers

| Plan | Monthly | Included credit | Target |
|---|---:|---:|---|
| Pay as you go | $0 | None | Trial and occasional publishing |
| **Plus** | **$19** | **$20 credit** | Solo operator / 2–3 brands |
| **Studio** | **$49** | **$55 credit** | Small agency / 5–10 brands |

Mechanics:

- Included credit is granted monthly and expires at the end of the billing month.
- Usage beyond the included credit is billed from the prepaid balance at the standard post rates.
- Unused paid top-up credit does not expire.
- Cancel anytime; access continues until the end of the paid period.
- Failed or cancelled posts are not charged.

These numbers are hypotheses for validation. Do not publish them until the live payment provider and monthly entitlement logic exist.

## Planned Plus benefits

Only include benefits that are actually built at launch:

- $20 included monthly credit.
- Priority cloud scheduler.
- Up to 3 team members (Studio: 10).
- Monthly usage export CSV.
- Priority support by email.
- Shared brand workspaces (Studio).

Do not promise analytics, auto-reply, approval workflows or agency white-label unless they are implemented.

## Pricing page plan (later)

Add a fourth card to `/pricing` after the existing free / pay-as-you-go cards:

- Label: **Relay Plus**
- Tag: **Most popular**
- Price: **$19/mo**
- Sub: “$20 credit included · cancel anytime”
- Three proof bullets:
  - “$20 monthly credit at standard post rates”
  - “Priority scheduler”
  - “3 team seats”
- CTA: **Start Plus** → checkout (live provider required)
- Secondary link: “Compare plans” → comparison table.

Add a comparison table below the cards:

| | Free | Pay as you go | Plus | Studio |
|---|---|---|---|---|
| Free starter credit | $0.50 | — | — | — |
| Included monthly credit | — | — | $20 | $55 |
| Team seats | 1 | 1 | 3 | 10 |
| Priority scheduler | — | — | ✓ | ✓ |
| Usage export | — | — | ✓ | ✓ |

Add FAQ entries:

- “What happens when my included credit runs out?” → Paid balance is used at standard rates; no surprise subscription overage.
- “Can I keep my top-up credit?” → Yes, paid top-ups do not expire.
- “Can I cancel?” → Yes, at the end of the billing period.
- “Is X included?” → X is paid-only on the free starter credit; it is included from paid balance and Plus credit.

## Marketing copy

Hero:

> **Publish on every network without watching a prepaid meter.**
> Relay Plus bundles a monthly credit, priority scheduling and team access into one predictable plan.

Subhead:

> Built for operators who ship content every week. Start on pay-as-you-go, upgrade when the manual top-ups become the bottleneck.

CTA: **Start with $0.50 free credit** → signup/trial.
Secondary CTA: **Talk to us** → `/contact`.

## Launch gates

Do not ship the Plus page until all of these are true:

- [ ] Live payment provider configured (Polar live or Stripe live).
- [ ] Monthly subscription products and webhook events implemented.
- [ ] Entitlement checks for seats and priority scheduling implemented.
- [ ] Upgrade/downgrade and cancellation flow tested.
- [ ] Trial abuse controls and email verification implemented.
- [ ] Legal copy for recurring billing, taxes and refunds reviewed.
- [ ] Public pricing reconciled with the actual entitlement code.

Until then, the page can exist only as a private preview behind the admin session.
