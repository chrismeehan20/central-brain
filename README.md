# Central Brain

A local, always-on mission-control dashboard for tracking many AI-agent-driven
projects at once. It auto-discovers your projects from Claude Code and Codex
session activity, links to the real markdown files in each repo, tracks
GitHub status via the `gh` CLI, and — the main point — tells you the moment
an agent is blocked waiting on your review or a permission decision, via a
desktop notification and a pinned panel in the dashboard.

Runs entirely on your machine. No SaaS, no external server. Everything is
plain JSON files under `data/`.

## What it does

- **Auto-discovers projects** from `~/.claude/projects` and `~/.codex/sessions`
  (both the CLI and VS Code extension write to these same shared stores).
- **Links real markdown files** — README/TODO/STATUS/PLAN/CLAUDE.md and
  anything in `/docs` — so the dashboard points at your actual source of
  truth, not just chat metadata.
- **"Needs attention" alerts** — a Claude Code hook posts to this app the
  moment a session hits a permission prompt or goes idle waiting on you.
  You get a desktop notification (via `terminal-notifier` if installed, or
  `osascript` otherwise — no extra setup required) and a pinned panel in
  the dashboard, live via server-sent events.
- **Codex staleness heuristic** — Codex has no hook system, so a rollout
  file that stops growing mid-session is flagged as "maybe waiting,"
  clearly labeled as a heuristic, not a hard signal.
- **GitHub status** — branch, dirty state, ahead/behind, open PRs, and CI
  status per project, via your existing `gh` CLI auth. No new tokens.
- **AI "what's left" summaries** — an optional one-line summary per project
  generated from its docs + recent session activity (Claude Haiku, cached
  and hash-gated so it doesn't re-run until something actually changes).
- **Rename / hide / pin** — auto-discovered folders land in a "needs triage"
  section; keep, rename to a clean product name, hide, or pin any project.
  These decisions persist across rescans.

## Setup

```bash
npm install
npm run build
npm run install-hooks    # wires Claude Code hook events into ~/.claude/settings.json
npm run install-service  # runs it always-on via launchd (macOS)
```

Open **http://localhost:4317**.

`install-hooks` backs up your existing `~/.claude/settings.json` first and
only *appends* new hook entries — it never touches hooks you already have
configured (e.g. your own `terminal-notifier` setup). Safe to run more than
once; it's idempotent. To remove them: `npm run uninstall-hooks`.

`install-service` registers a `launchd` agent so the dashboard survives
reboots and restarts on crash. To remove it: `npm run uninstall-service`.

### Optional: AI summaries

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` to enable the
one-line "what's left" summaries. Everything else works without it.

## Development

```bash
npm run dev
```

Runs the Fastify API (`:4317`) and the Vite dev server (`:5173`, proxying
`/api` to the backend) with hot reload on both sides.

## How it works

- **Read pipeline** (`src/server/scan/`) — reads Claude Code's
  `sessions-index.json` (falls back to raw `.jsonl` transcripts) and Codex's
  rollout files, resolves them into per-project session lists keyed by
  canonical filesystem path, and reads each project's markdown docs.
- **Alerting** (`src/server/alert/`, `src/server/routes/hook.ts`) — Claude
  Code posts hook events to `POST /api/hook`; `PermissionRequest` and
  `Notification` raise "needs attention" items (with a desktop notification
  on the first occurrence, not on every repeat), `Stop`/`SubagentStop` clear
  them silently, `UserPromptSubmit`/`SessionStart`/`SessionEnd` clear them
  because you're back at the keyboard. Pushed live to the dashboard over SSE
  (`GET /api/stream`).
- **GitHub** (`src/server/github/ghClient.ts`) — shells out to `git` and
  `gh` per project, degrading silently when either is unavailable.
- **AI summaries** (`src/server/ai/summarize.ts`) — hash-gated: only calls
  the API when a project's docs/sessions actually changed since the last
  summary.
- **Persistence** (`src/server/store/db.ts`) — plain JSON files via
  `lowdb`: `overrides.json` (your rename/hide/pin decisions — the durable
  layer merged on top of every rescan), `attention.json`, `github.json`,
  `summaries.json`.

## Known limitations

- Codex alerting is heuristic (staleness-based), not a real push signal —
  Codex has no hook system today.
- The `Notification` Claude Code hook event conflates "truly blocked" with
  "idle for ~60s"; both surface as "waiting" in the panel.
- Project identity is the canonical filesystem path — if you move a repo,
  it'll show up as a new "discovered" project and your old rename/hide
  decisions for the old path won't carry over.
