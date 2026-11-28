# Waitlist funnel — normal-customer early access

## Purpose

The waitlist is the normal-customer entry point. It is an **early-access request**, not a full product site and not open self-serve signup.

- Prospect: `/waitlist`
- Existing customer: `/login`
- Invited customer: private `/connect?token=...` link from the admin approval email (configure MCP after password setup using the **welcome email** link — setup rotates the token)
- Operator: `/admin`

## Positioning

Sell the result, not the lowest price:

- “One post. A week of showing up.”
- “I post consistently without living in six apps.”
- “Affordable by design: pay only for posts that publish, not per seat or per month.”
- Manual scheduling is complete. ChatGPT/Claude through MCP is optional.
- Content first: the customer brings or approves the caption, photo, video or link. Relay does not invent the offer.

Do not use “cheapest”, “cheap”, invented customer counts, or revenue/testimonial claims.

## Page structure

1. Hero: H1, subhead, two-field form, no-card note, four proof points.
2. Two ways: “Do it yourself” and “Or ask your AI”; note that AI is optional.
3. Three steps: bring content, choose the hand, show up on time.
4. Result: three outcome statements and one affordability line linking to `/pricing`.
5. FAQ: AI optional, content first, price, platforms, access timing.
6. Minimal footer.

Removed from the old page: product bento, audience section, price-stat band, final CTA, fake queue card and scroll-reveal sections.

## Competitor notes

Public pages checked 14 Nov 2026; verify limits/prices before using them in ads.

| Product | Public entry | Lesson |
|---|---|---|
| [Buffer](https://buffer.com/pricing) | Direct free signup; free plan for 3 channels, 10 queued posts per channel | Low-friction start; outcome-first homepage |
| [Publer](https://publer.com/help/en/article/what-is-included-in-publer-free-dliovh/) | Direct signup; free plan with 3 social accounts and 10 queued posts per account | Clear limits, immediate utility |
| [Later](https://later.com/influencer-creator-program/) | Free Later account; creator-focused | One audience and one visual use case |
| [Typefully](https://typefully.com/) | Direct signup/free tier; AI-powered scheduler; “a social workspace for humans and agents” | Closest agent-native positioning; Relay must own six-platform publishing plus manual fallback |

Most competitors reduce time-to-value to signup → connect → first post. Relay remains invite-only, so the page must show a concrete next step and keep collecting demand after the founding batch fills.

## API change

`GET /api/waitlist` adds:

```json
{
  "acceptingRequests": true,
  "batch": "founding"
}
```

`batch` is `"founding"` while accepted invites are below `RELAY_WAITLIST_LIMIT` (default 100), otherwise `"next"`.

`POST /api/waitlist`:

- no longer returns `409 waitlist_full` at the invite cap;
- still creates the pending entry;
- returns `batch` alongside `position`, `duplicate`, `status` and `emailSent`.

The 100 cap still limits **admin-approved invitations**. The waitlist itself stays open for the next batch. No database migration.

## Email

`waitlistConfirmationEmail` now accepts `batch` and says:

- which list the person joined;
- that requests are reviewed personally;
- what to prepare while waiting (caption, photo, video or link);
- that manual scheduling is complete and AI is optional.

## Measurement

Before judging the redesign, record:

- `/waitlist` requests from Cloudflare analytics;
- unique waitlist entries from the cloud DB;
- visit-to-submit rate;
- mobile share and duplicate rate.

Target after two weeks: **+20% relative visit-to-submit lift** with no increase in duplicate or spam entries. If it misses, test the hero promise first, then form placement — not more sections.

No third-party analytics SDK is added.

## Verification

- `npm run build`
- `npm test`
- local screenshots at 390×844 and 1440×900
- confirm the submit button and privacy note are visible before the 844 px fold
- confirm HTML + CSS stays under 24 KiB raw
- production smoke: `/waitlist` 200, assets 200, API status has `acceptingRequests`
- purge `/waitlist.css` and `/waitlist.js` after deploy; HTML is `no-store`

## Rollback

Revert the release commit and redeploy. No DB migration is involved. The API is additive for readers; the only behavior change is accepting overflow requests instead of returning 409.

## Out of scope

Open self-serve signup, referral scheme, social login, Turnstile on the waitlist, pricing changes, Facebook Pages launch, analytics SDK and A/B testing framework.

## Production verification — 14 Nov 2026

- Deployed commit `0e2b8c8` with label `waitlist`.
- `GET /waitlist` returns **200** and the new title `Early access · Relay Cloud`.
- `GET /api/waitlist` returns `open:true`, `acceptingRequests:true`, `batch:"founding"` in production.
- `waitlist.css` and `waitlist.js` return 200 at the versioned URLs; both are immutable.
- HTML is **10,414 bytes**, CSS is **14,000 bytes**; combined **24,414 bytes**, under 24 KiB.
- Targeted waitlist/email/accessibility tests pass, and the full suite remains **263 passing, 0 failing**.
- Desktop and 390×844 screenshots were reviewed; the form and its button are above the 844 px mobile fold.
