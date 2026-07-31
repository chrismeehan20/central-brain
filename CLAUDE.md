# central-brain

## Tuning knobs / gotchas

- **`CHAT_DEEP_LINK_DELAY_MS` in `src/server/open/launch.ts` (currently 2000ms)** — the pause between opening a project window in VS Code and firing the `vscode://anthropic.claude-code/open?session=<id>` deep link that reopens a specific chat. If a cold VS Code start ever opens a *fresh* chat instead of the old one, the extension wasn't ready yet: bump this delay.
- The client is served from files enumerated at server boot (`@fastify/static` with `wildcard: false`) — after `vite build`, restart the server or new asset hashes 404 into the SPA fallback.
