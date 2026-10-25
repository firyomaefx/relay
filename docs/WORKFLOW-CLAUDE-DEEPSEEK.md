# Claude plans, DeepSeek operates, Relay publishes

This workflow keeps expensive Claude tokens for **research and SEO copywriting** while
DeepSeek (or a cron job) handles **posting, scheduling, retries, and reporting**.

```
Claude Opus / Sonnet          DeepSeek (or cron / you)              Relay (local)
research, SEO copy   ──►   node tools/relay-batch.mjs plan.json  ──►  validate → queue → publish
content pack JSON            social ops, retries, summaries          encrypted credentials, scheduler
```

No model runs at publish time. The Relay scheduler posts scheduled items even when no
agent is running.

## Roles

| Layer | Model / tool | What it does | Token cost |
| --- | --- | --- | --- |
| Strategy + SEO copy | Claude (Opus 5.5 for final polish, cheaper Claude for drafts) | research, angle, keyword intent, final copy, content calendar | high — keep it bounded |
| Social operations | DeepSeek (or `relay-batch.mjs`, cron) | format per platform, attach media, validate, queue, retry, report | low |
| Execution | Relay | OAuth, encrypted token storage, scheduler, publish | zero |

## The content pack (Claude's only output)

Claude writes one JSON file per campaign to `content/plans/`. Strict JSON, no prose —
this alone cuts a large share of output tokens.

```json
{
  "name": "week-2026-10-27",
  "items": [
    {
      "platforms": ["threads"],
      "text": "Hook line + value + CTA",
      "thread": ["optional extra thread part"],
      "media": [{ "path": "C:/Users/User/Videos/clip.mp4", "kind": "video" }],
      "options": { "tiktok": { "tiktokMode": "draft" } },
      "scheduleAt": "2026-10-27T09:00:00+08:00"
    }
  ]
}
```

Fields:
- `platforms` — one or more of `x`, `threads`, `tiktok`.
- `text` — single post copy. `thread` — optional array for multi-part threads.
- `media` — local files. TikTok video: `kind: "video"`. Threads/X images: `kind: "image"`.
- `options` — per-platform. TikTok: `tiktokMode: "draft"` (inbox upload, works while
  unaudited) or `"direct"` (public Direct Post, requires an approved app);
  `tiktokPrivacy: "SELF_ONLY"` for private.
- `scheduleAt` — ISO-8601 with offset. Omit to publish immediately.

## Run it

```powershell
# validate everything, publish nothing
node tools/relay-batch.mjs content/plans/example-week.json --dry-run

# publish or queue everything in one process (zero LLM tokens)
node tools/relay-batch.mjs content/plans/example-week.json
```

Exit code is `1` if any item failed, so DeepSeek can react to failures only.

## Saving Claude tokens

1. **One Opus session per campaign, not per post.** Research and write 5–20 posts in a
   single conversation, output the JSON pack.
2. **Prompt caching** for brand voice, audience, keyword rules, and examples. Put the
   stable block first and reuse it; cached input is far cheaper than fresh input.
3. **Batch API** for research and first drafts when nothing is urgent (typically 50% off).
4. **Route by task:** Opus only for final SEO polish and research judgment; Sonnet/Haiku
   or DeepSeek for variants, repurposing, hashtags, and platform formatting.
5. **Strict JSON output + `max_tokens`** — no commentary, no markdown fences.
6. **Don't send analytics to Opus.** DeepSeek reads `relay_history` and writes a one-page
   summary; Opus gets only the summary when planning next week.
7. **Use `--dry-run` locally** instead of asking Claude to check platform rules; Relay's
   validator is deterministic and free.
8. **Hand off with one file**, not a chat transcript. Claude never needs the social
   history or the credentials.

## Direct-from-Claude option

Claude Desktop/Code already has the `relay` MCP server. For a single post, Claude can call
`relay_queue` (with `schedule_at`) or `relay_post` directly. Use `relay-batch.mjs` when
there are several items: one shell command replaces many MCP tool calls.

## Adding Grok (xAI) as a research/copy provider

Grok has live X context, which makes it a strong **research and trend** layer. But keep the
credentials separate:

| Credential | What it unlocks | Where it lives |
| --- | --- | --- |
| `XAI_API_KEY` (xAI) | Grok inference only | user env var or `.env`; never in content packs |
| X Developer app (OAuth) | posting to X | Relay encrypted store |
| X API credits | paid X API calls | X developer console billing |
| TikTok/Threads OAuth | posting | Relay encrypted store |

An xAI API key **cannot post to X**. Grok is the brain; Relay is the hands.

Research command:

```powershell
setx XAI_API_KEY "xai-..."          # once; reopen the terminal
node tools/grok-research.mjs --topic "Malaysian personal finance trends Q4" `
  --out content/research/2026-10-27-finance.json
```

Then feed that brief to Claude for SEO copy, or straight to DeepSeek for a first draft:

```
Grok (research JSON)  →  Claude Opus (SEO copy, content pack)  →  relay-batch  →  Relay
```

Optional environment:
- `XAI_BASE_URL` — default `https://api.x.ai/v1` (OpenAI-compatible).
- `XAI_MODEL` — default `grok-4`; pick whatever model your xAI plan exposes.

Rules:
- Do not give Grok the Relay tokens; it only needs the research brief role.
- If Grok must trigger posts, host it in an agent that can call Relay's local API/MCP —
  the key alone is stateless and cannot call tools.
- If `grokbot` is a separate X account, Relay currently supports one account per platform;
  multi-account support is a code change, not a credential change.


## Security

- TikTok/Threads/X tokens never leave Relay's encrypted store; neither Claude,
  DeepSeek nor Grok should ever see them.
- `XAI_API_KEY` lives in your user environment (or `.env`), never in a content pack,
  prompt, or the repo.
- Keep content packs free of API keys and personal data.
- TikTok public Direct Post requires the approved audit; until then use
  `tiktokMode: "draft"` and post the draft from the TikTok app.
- Threads OAuth uses an HTTPS callback. The current connection works, but reconnects need
  the tunnel (or a stable `relay.duitpoket.fun` subdomain) running.
