# Relay Cloud — waitlist landing page

Live: https://relay.duitpoket.fun/waitlist

## One-sentence job

Make a seller, creator or small team understand the product in one screen and join the first 100 with **name + email only**.

## Structure

1. **Floating navigation** — Product, How it works, Pricing, FAQ, Log in, Join.
2. **Hero** — "Write once. Show up everywhere." + one-sentence offer + primary CTA + proof strip (6 platforms, $0.02, $0 monthly, free failed posts).
3. **Product preview** — a CSS-only composer, platform chips and a queued-week card. It shows the product without shipping a heavy screenshot or hero video.
4. **Registration** — name + email, no card, no phone, no qualifying questions. Inline success state with queue position.
5. **Product information** — bento of one composer, automatic sizing/threads, per-platform previews, queue/retry, optional agent/MCP, prepaid billing.
6. **How it works** — join → connect via OAuth → write/publish.
7. **Who it's for** — sellers, creators, small teams.
8. **Pricing** — $0.02 text part, $0.04 video part, $0.50 starter credit, $0 monthly.
9. **FAQ** — agent optional, platforms, pricing, no auto-posting, OAuth/security, access timing.
10. **Final CTA** — repeats the first-100 promise and returns to the form.
11. **Footer** — pricing, docs, about, contact, privacy, terms, login.

## Conversion UX

- Primary CTA appears in the nav and hero; both jump to `#join`.
- Form asks only **name + email**; phone is optional in the API and not requested.
- Honeypot field catches bots without adding friction.
- Button shows "Reserving…", then the form is replaced by a focused confirmation card with the queue position.
- Duplicate email shows a friendly "already on the list" state instead of an error.
- If the batch is full, the form is replaced by a batch-full panel.
- Privacy sentence sits directly under the submit button.

## Responsive rules

- Desktop: two-column hero, bento grid, three-step row.
- ≤980px: single-column hero, form and sections; mobile menu with full-screen glass overlay.
- ≤720px: 18px side gutters, 50px+ touch targets, 16px inputs, no fixed-height sections.
- ≤390px: compact logo, stacked CTAs, no horizontal overflow.
- Reduced-motion users get static content (no reveal transforms).

## Performance budget

- Self-contained `waitlist.css` (~25 KB raw / ~7 KB compressed).
- `waitlist.js` (~5 KB raw / ~2 KB compressed).
- No external fonts, frameworks or icon libraries.
- Two small brand images (~21 KB total); no hero raster.
- Hero copy is not hidden behind JavaScript, so it paints immediately.
- Scroll reveals use one `IntersectionObserver`, never a scroll listener.
- Measured on production: ~31 KB transferred resources, DOMContentLoaded ~210 ms.

## Accessibility

- Skip link, semantic sections, one H1.
- Every input has a visible label; errors use `role="status"`.
- Mobile menu is a labelled dialog with `aria-expanded`, `aria-hidden`, Escape-to-close and focus restoration.
- FAQ uses native `<details>`/`<summary>`.
- Focus-visible styles, 44px+ touch targets and reduced-motion support.
