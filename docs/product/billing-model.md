# Relay billing model

Status: implemented in cloud mode; public copy should say **starting at** until the live provider is configured.

## The billable unit

One billable unit is:

> one post part on one platform.

A plain post is one part. A 3-part thread is three parts. Publishing to two platforms doubles the units.

```text
units = sum over platforms (number of thread parts)
price = sum over platforms and parts (price for that part's kind on that platform)
```

Examples at current prices:

| Draft | Units | Total |
|---|---:|---:|
| 1 text post on X | 1 | $0.02 |
| 1 text post on X + Threads | 2 | $0.04 |
| 3-part text thread on X + Threads | 6 | $0.12 |
| 1 video post on all five networks | 5 | $0.20 |
| 3-part thread, each part a video, X + Threads | 6 | $0.24 |

`price` is the starting rate. Actual settlement depends on which platforms accept the post and which parts succeed.

## Quote, reserve, settle

1. **Quote** — price every platform-part before publishing.
2. **Reserve** — hold the paid portion; free credit is applied first on eligible platforms.
3. **Settle** — charge only successful platforms, for their successful parts.
4. **Release** — failed platforms and cancelled jobs release the unused hold.

Free starter credit:

- `$0.50`, spent at the real unit price.
- X is excluded from free credit.
- $0.50 is approximately 25 X-eligible text units, 12 video units, or 5 five-platform text posts.

## API / MCP output

`relay_validate` now returns a quote in structured content:

```json
{
  "quote": {
    "currency": "USD",
    "unit": "milliUSD",
    "total": 120,
    "freeCreditApplied": 60,
    "paidTotal": 60,
    "lines": [
      { "platform": "x", "parts": 3, "amount": 60, "paidAmount": 60 },
      { "platform": "threads", "parts": 3, "amount": 60, "freeAmount": 60, "paidAmount": 0 }
    ]
  }
}
```

The text response also includes an `Estimated cost` block. `relay_post` includes the same quote as an estimate; actual settlement remains per successful platform.

## Why this resembles a usage marketplace

Monid prices a route with a matrix: the same endpoint can cost $0.0006 on the cheapest route and $0.0036 on a premium route. Relay's equivalent variables are:

- number of platforms
- number of thread parts
- content kind per part (text, link, image, carousel, video)
- platform-specific price
- free-credit eligibility

A “starting price” is therefore a floor, not a bill. The UI must show the quote and examples so the difference is not a surprise.

## Guardrails

- Never charge a failed platform.
- Never charge a part that did not publish.
- Do not let a quote silently exceed the available balance; reservation fails with the exact required amount.
- Do not advertise Plus or a flat monthly price until the live payment provider and monthly entitlements exist.



