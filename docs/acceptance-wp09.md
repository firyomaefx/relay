# WP-09 — Acceptance Record

**Status:** PASS on exact Windows 10 host for the authenticated Auto flow; Windows 11 and code signing remain open  
**Date:** 8 November 2026

## Clean VM installer run (GCP)

- VM: `relay-win-acceptance`, `windows-2022`, `asia-southeast1-a`
- Silent installer exit **0**
- Installed: `%LOCALAPPDATA%\Relay\Connector\relay-connector.exe`
- Registry: `HKCU\Software\Classes\relay\shell\open\command` points at the installed exe
- `relay-connector.exe --help` passes
- Uninstaller exit **0**; exe and registry key removed
- VM and temporary GCS bucket deleted

This proves the installer, per-user registration, packaged executable and uninstaller on a clean Windows machine.

## Clean VM Claude Code run (GCP)

Second clean VM (`relay-win-client`, Windows Server 2022):

- Node `24.13.1`, Claude Code `2.1.319`
- `claude mcp add --transport http --scope user relay …` succeeded and modified `.claude.json`
- `claude mcp list` showed Relay as “Needs authentication”
- VM deleted after the run

## Authenticated Auto flow — exact Windows 10 host

Run on the host’s **Windows 10** with the real production Relay session:

- Production session created via the real console login (scoped token only; no owner token on the Connector page)
- Connector detected all three Auto clients
- Claude Code install: **2.0 s**, result `connected`
- Production MCP verification: **0.4 s**, result `connected`, **28 tools** via `initialize` + `tools/list`
- Production Home showed **1/1 client(s) verified** and a **Connected** badge on Claude Code
- Total consent-to-Connected: **2.4 s** (target <60 s)
- Host `.claude.json` restored from backup after the test

Evidence: [production-connected.png](screenshots/production-connected.png)

## Manual keyboard pass

Production Home, keyboard-only Tab traversal:

- 55 Tab presses, 18 unique stops
- Reachable: **Connect Relay**, **Repair**, **Disconnect**, **Copy setup**
- `#connectRelayStatus` has `role="status"` and `aria-live="polite"`
- Connected state is rendered as text, not color alone

## Requirements

| REQ | Check | Result |
|---|---|---|
| REQ-021 | Installer registers `relay://`; uninstaller removes it | **PASS** on clean Windows Server 2022 |
| REQ-025 | Auto connection under 60s | **PASS on Windows 10 host** — 2.4 s |
| REQ-026 | Windows 10/11 + Chrome/Edge | **PARTIAL** — Windows 10 passes; Windows 11 not tested |
| REQ-028 | Keyboard/text status | **PASS** — keyboard-only production pass |
| REQ-029 | Docs | **PASS** — [connector.md](connector.md) |

## Still open

1. Exact **Windows 11** run.
2. Publicly trusted **code-signing certificate**. `signtool` is available, but no issued certificate is installed. A self-signed cert would not remove SmartScreen warnings.
3. SEA `--register-protocol` helper still returns `Access is denied` on the host; the installer registration path is proven.

## Decision

The two acceptance gaps — exact Windows 10 authenticated flow and manual keyboard pass — are closed. Windows 11 and a publicly trusted code-signing certificate remain external blockers.
