# WP-09 — Clean-VM Acceptance Record

**Status:** PARTIAL PASS — clean Windows Server 2022 run passed; exact Windows 10/11 + one Auto client still open  
**Date:** 8 November 2026

## Clean VM run (GCP)

- VM: `relay-win-acceptance`, `windows-2022`, `asia-southeast1-a`
- Installer downloaded from a temporary GCS object and run with `/VERYSILENT`
- Installer exit code: **0**
- Installed file exists: `%LOCALAPPDATA%\Relay\Connector\relay-connector.exe`
- Registry:
  `HKCU\Software\Classes\relay\shell\open\command`
  `"C:\Users\relaytest\AppData\Local\Relay\Connector\relay-connector.exe" "%1"`
- `relay-connector.exe --help` prints the expected commands
- Uninstaller exit code: **0**
- Installed exe removed: **True**
- Relay registry key removed: **True**
- VM and temporary GCS bucket deleted after the test

This proves the installer, per-user registration, packaged executable and uninstaller on a clean Windows machine.

## Clean VM client run (GCP)

Second clean VM (`relay-win-client`, Windows Server 2022, same project):

- Node `24.13.1` installed from the official Windows zip.
- Claude Code `2.1.319` installed with `npm install -g @anthropic-ai/claude-code`.
- The adapter command ran successfully:
  `claude mcp add --transport http --scope user relay https://mcp.duitpoket.fun/mcp`
- Result: `Added HTTP MCP server relay ... to user config` and `C:\Users\relaytest\.claude.json` was modified.
- `claude mcp list` shows `relay: https://mcp.duitpoket.fun/mcp (HTTP) - ! Needs authentication`.
- VM deleted after the run.

This proves the Claude Code Auto adapter command and config path. It does **not** prove the final Connected state or the 60-second target because no Relay session/account was authenticated in the VM.

## Requirements

| REQ | Check | Result |
|---|---|---|
| REQ-021 | Installer registers `relay://`; uninstaller removes it | **PASS** on clean Windows Server 2022 |
| REQ-025 | Auto connection under 60s on a clean VM | **NOT RUN** — no MCP client installed in this run |
| REQ-026 | Windows 10/11 + Chrome/Edge | **NOT RUN** — image was Windows Server 2022, not desktop 10/11 |
| REQ-028 | Keyboard/text status | **PARTIAL** — static contract passes; no manual keyboard run |
| REQ-029 | Docs | **PASS** — [connector.md](connector.md) |

## Still open

1. Exact Windows 10/11 desktop run (Server 2022 is close but not the required client OS).
2. One Auto client end-to-end under 60 seconds (Claude Desktop/Cursor/Claude Code installed in the VM).
3. Manual keyboard-only pass.
4. SEA `--register-protocol` helper still failed on the host; the installer path is proven, helper remains unproven.
5. No code-signing certificate.

## Decision

Installer/uninstaller blocker is resolved. WP-09 remains **partial**, not fully accepted for G4 until the exact OS and one-client timing checks pass.
