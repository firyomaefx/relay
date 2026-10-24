# treg + Monid MCP connections

Configuration-only DSH bundle that inserts two `@deepseek-ai/dsh-mcp-client`
rows into the `desktop` profile:

| Row id      | serverName | Endpoint                     | Tools surface as |
| ----------- | ---------- | ---------------------------- | ---------------- |
| `mcp-treg`  | `treg`     | `https://treg.to/mcp/`       | `mcp__treg__*`   |
| `mcp-monid` | `monid`    | `https://mcp.monid.ai/v1`    | `mcp__monid__*`  |

## Install / reinstall

```
plugin_manager { action: "install_bundle", target: "C:\\Users\\User\\Documents\\deepseek-harness\\default-workspace\\tools\\mcp-treg-monid" }
```

Repair this bundle in place instead of creating a second copy: the row ids
`mcp-treg` and `mcp-monid` must stay unique in the profile.

## Status (2026-10-22, desktop profile)

- Installed via `plugin_manager install_bundle`: `application: applied`, bundle enabled.
- treg: connected — 10 tools registered (`mcp__treg__balance` … `mcp__treg__call_media`);
  `balance` returns team **ttrg** (TTRG), identity firyomaefx@gmail.com.
- monid: connected — 13 tools registered (`mcp__monid__discover` … `mcp__monid__run`);
  `monid_balance` returns a USD wallet balance (works without a full OAuth session; the
  Clerk `signed-out` notice in the handshake is expected for a `monid_live_*` key).

If either row reports `server is disconnected`, the usual cause seen here was a transient
DNS failure for `monid.ai` at the moment the profile mounted the rows. The client retries
with backoff, so re-checking a minute later is normally enough; otherwise reinstall the
bundle (row ids are stable, so this repairs rather than duplicates).

## Credentials

The bearer tokens in `cordis.patch.yml` are the same tokens already present in
`C:\Users\User\.claude.json` (`mcpServers.treg` for the global entry, and the
`C:/Users/User` project entry for `monid`). They live in this local bundle so
rotating them is a one-file edit:

- treg: per-org agent/identity token (`X-Treg-Token` is sent as a bearer for MCP)
- monid: `monid_live_*` API key

Rotate by editing the two `Authorization` headers and re-running the install
command above.
