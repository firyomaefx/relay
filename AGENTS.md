# Workspace rules

## Jev first, Jev last — mandatory

Every task in this workspace starts and ends with TypeSafe AI Jev.

1. **Start of task:** call one Jev tool to frame the work:
   - `jev_decide` — choose between approaches
   - `jev_find` / `jev_rerank` — choose the right files or notes
   - `jev_classify` / `jev_screen` — triage input
   - `jev_noul` — calibrate a proposition
2. **End of task, before reporting:** verify:
   - `jev_verify` — claims against evidence
   - `jev_gate` — patch + completion claims
   - `jev_review` — patch only
3. If Jev is down or unavailable, say so plainly and continue; never pretend it ran.
4. MCP tools are exposed as `mcp__jev__jev_*`. Shell fallback:
   `C:\Users\User\bin\jev.cmd` (`jev.cmd list`, then `jev.cmd jev_verify @args.json`).
5. This rule applies to small tasks too.

## Relay

Relay is the local social publishing server (X, Threads, TikTok, YouTube, Instagram).
Use Relay MCP tools for posting; do not substitute shell or browser automation.

## Safety

- Never publish to a real account without explicit content and instruction.
- Ask before destructive actions.
