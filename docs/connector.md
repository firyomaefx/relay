# Relay Connector

One local Connector for Relay MCP clients. It opens a `relay://` deep link, fetches a short-lived scoped session, and configures only the clients you approve.

## Requirements

- Windows 10 or 11
- A Relay account with cloud connections enabled
- Claude Desktop, Cursor, or Claude Code for the Auto path
- No Node.js install is required for the packaged Connector

## Install

1. Run `RelayConnectorSetup.exe`.
2. The installer is per-user and does not require admin.
3. It registers `relay://` under `HKCU\Software\Classes\relay`.
4. It installs to `%LOCALAPPDATA%\Relay\Connector`.

Uninstall through **Settings → Apps → Relay Connector**. The uninstaller removes the Relay keys and installed files. Client config backups are kept under `%LOCALAPPDATA%\Relay\backups`.

## Connect

1. In Relay, open **Accounts → Connect Relay**.
2. Approve the local Connector prompt.
3. The Connector detects installed Auto clients, writes only `mcpServers.relay`, and keeps a backup.
4. Restart the client when prompted.
5. For Guided/Manual clients, use **Copy setup** and follow the generated artifact.

## Client tiers

| Tier | Clients | What happens |
|---|---|---|
| Auto | Claude Desktop, Cursor, Claude Code | Connector writes the Relay entry after approval |
| Guided | Codex, VS Code, DeepSeek Harness, Grok CLI | One copyable config or command |
| Manual | Grok Bot, ChatGPT, n8n, Other | Steps or a connector prompt; availability depends on the client/plan |

No client is marked Auto unless a real adapter exists. The client matrix is the single source of truth.

## Disconnect / repair

- **Disconnect** opens `relay://manage?action=disconnect&client=...` and asks for confirmation.
- Only the `relay` entry is removed; other servers and preferences are preserved.
- **Repair** is supported by the manage server (`action=repair`); the web button is not wired yet.
- Backups stay under `%LOCALAPPDATA%\Relay\backups`.

## Security

- Connector binds only to `127.0.0.1` and rejects non-loopback Host headers.
- The scoped connect token stays in memory; the page never renders it.
- Config writes are atomic and backed up; malformed JSON fails closed.
- No admin or machine-wide registry writes.
- Logs redact `rcs_`, `rlc_`, `rly_`, Bearer and `token=/code=/secret=/password=` values.
- The Connector has no access to the Relay owner token.

## Troubleshooting

| Symptom | Action |
|---|---|
| `relay://` does not open | Reinstall or run `relay-connector.exe --register-protocol`; check HKCU relay key |
| Connector says session expired | Return to Relay and click **Connect Relay** again |
| Client does not show Relay | Restart that client; verify the `mcpServers.relay` entry |
| Malformed config | Connector refuses to overwrite; fix the JSON or restore from backups |
| Installer blocked by SmartScreen | The build is unsigned; choose **More info → Run anyway** only if you trust the source |

## Build

```
npm run build -w @relay/connector -w @relay/connector-app
npm run bundle -w @relay/connector-app   # SEA exe
npm run package -w @relay/connector-app  # + installer
```

## Known limits

- Windows only.
- No code-signing certificate yet.
- Clean-VM install/uninstall and the installer runtime are not yet proven; see WP-09 acceptance.
