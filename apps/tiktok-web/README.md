# Relay TikTok Web Worker

Local browser worker for public TikTok photo carousels while the TikTok app is
unaudited. It drives the already logged-in **TikTok Studio** Chrome session with
the CUA driver — no TikTok API, no QR login.

## Requirements

- Windows laptop awake
- Chrome open and logged into TikTok Studio
- CUA driver installed (default path below, override with `CUA_DRIVER`)

## Run as MCP (stdio)

```json
{
  "mcpServers": {
    "relay-tiktok-web": {
      "command": "node",
      "args": [
        "C:\\Users\\User\\Documents\\deepseek-harness\\default-workspace\\apps\\tiktok-web\\dist\\index.js"
      ],
      "cwd": "C:\\Users\\User\\Documents\\deepseek-harness\\default-workspace"
    }
  }
}
```

## Tools

- `tiktok_web_status` — shows the Chrome window and worker data directory.
- `tiktok_web_post_carousel` — uploads 2–35 local images with a caption; optional
  first recommended sound; returns a recorded job id.

## Records

Every attempt is written to:

- `.data/tiktok-web/jobs/<jobId>.json`
- `.data/tiktok-web/jobs.jsonl`

The Chrome session itself stays in the browser profile; the worker does not copy
TikTok cookies out of Chrome.

## Later: cloud migration

The same flow can run on the Tencent server after a cloud TikTok login. The
worker interface stays the same; only the browser session and tunnel change.
