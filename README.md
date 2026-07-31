# Central Brain

A local, always-on mission-control dashboard for tracking many AI-agent-driven
projects at once. It auto-discovers your projects from Claude Code and Codex
session activity, links to the real markdown files in each repo, tracks
GitHub status via the `gh` CLI, and — the main point — tells you the moment
an agent is blocked waiting on your review or a permission decision, via a
desktop notification and a pinned panel in the dashboard.

Runs entirely on your machine. No SaaS, no external server. Everything is
plain JSON files in the platform user-data directory
(`~/Library/Application Support/central-brain/` on macOS).

**macOS only.** The menubar app, desktop notifications, and install flow are
all Mac-specific. (The server itself is portable Node, so a determined
Linux/Windows user could run `node dist/server-bundle.mjs` and use the browser
dashboard, but that path is neither packaged nor supported.)

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
- **Codex alerts, with a fallback** — Codex has a hook system too, but its
  hooks only fire once you approve them interactively inside Codex, so until
  that happens a rollout file that stops growing mid-session is flagged as
  "maybe waiting," clearly labeled as a heuristic. Once real Codex hook
  events start arriving, the heuristic stands down and clears its guesses.
- **GitHub status** — branch, dirty state, ahead/behind, open PRs, and CI
  status per project, via your existing `gh` CLI auth. No new tokens.
- **AI "what's left" summaries** — an optional one-line summary per project
  generated from its docs + recent session activity (Claude Haiku, cached
  and hash-gated so it doesn't re-run until something actually changes).
  Only projects active in the last 30 days are summarized automatically;
  a card's manual Refresh always works.
- **Rename / hide / pin** — auto-discovered folders appear straight in the
  Projects grid with a "New" badge (click it to dismiss; renaming, pinning,
  or hiding also dismisses it). Rename to a clean product name, hide junk
  with the eye button, or pin what matters. These decisions persist across
  rescans.
- **Settings, not assumptions** — the ⚙ panel can mute desktop notifications
  (the attention panel keeps updating silently) and pick which editor doc
  links and "Open" buttons target: VS Code, Cursor, VSCodium, or Windsurf.
  "Launch at login" lives in the tray menu.

## Install

**Prerequisites:** macOS with [Node.js](https://nodejs.org) ≥ 22.5 (any
install method — Homebrew, nvm, volta, fnm, asdf, and mise are all found
automatically). Optional: the [`gh` CLI](https://cli.github.com) for GitHub
status, `terminal-notifier` for nicer notifications.

1. Download the `.dmg` (or `.app` zip) from the
   [latest release](https://github.com/chrismeehan20/central-brain/releases)
   and drag **Central Brain.app** to `/Applications`.
2. The app is not code-signed, so macOS will quarantine it on first launch.
   Clear that once:

   ```bash
   xattr -dc "/Applications/Central Brain.app"
   ```

   (or launch it, then approve it under **System Settings → Privacy &
   Security → Open Anyway**.)
3. Launch it and install the hooks that push "agent is waiting on you" events
   (each installer skips politely if you don't use that tool):

   ```bash
   git clone https://github.com/chrismeehan20/central-brain.git && cd central-brain
   npm install
   npm run install-hooks        # wires Claude Code hook events into ~/.claude/settings.json
   npm run install-codex-hooks  # wires Codex hook events into $CODEX_HOME/hooks.json
   ```

The app runs the server itself — there is no separate service to install and
nothing to start by hand. Without the hooks everything still works except the
push alerts; sessions are discovered by scanning either way.

### Building from source instead

Additional prerequisites: a [Rust toolchain](https://rustup.rs) and the Xcode
Command Line Tools (`xcode-select --install`).

```bash
npm install
npm run build
npm run install-hooks
npm run install-codex-hooks
npm run menubar:build        # builds the menubar app that runs the server
```

Then move `src-tauri/target/release/bundle/macos/Central Brain.app` to
`/Applications` and launch it.

The dashboard is at **http://localhost:4317** (also the tray menu's "Open in
browser"), but you don't need a browser: clicking the tray icon opens it as a
popover. If something else already owns 4317 (it's also the OTLP gRPC
default), the app honors `CENTRAL_BRAIN_PORT` — see `.env.example` for that
and every other knob (`CENTRAL_BRAIN_NODE`, `CENTRAL_BRAIN_DATA_DIR`, hook
URLs, AI cost controls).

`install-hooks` backs up your existing `~/.claude/settings.json` first and
only *appends* new hook entries — it never touches hooks you already have
configured (e.g. your own `terminal-notifier` setup). Safe to run more than
once; it's idempotent. To remove them: `npm run uninstall-hooks`.

`install-codex-hooks` does the same for Codex's separate `hooks.json`
(`$CODEX_HOME/hooks.json`, else `~/.codex/hooks.json`), appending a `command`
handler that curls each event to `POST /api/hook/codex` — Codex has no `http`
hook type. **Codex will not run any hook until you approve the hook config
once, interactively, inside Codex.** Approval is keyed to a hash of the whole
file, so installing these invalidates any approval you'd already granted, for
every handler in it; until you re-approve, no Codex hooks run at all and Codex
does not say so. `~/.codex/hooks.state` appearing is how you know it worked.
Until then the staleness heuristic keeps covering for it. To remove them:
`npm run uninstall-codex-hooks`.

### How the app runs the server

The menubar app owns the server's lifetime. On launch it probes port 4317: if
something is already listening (say `npm run dev`) it **attaches** rather than
starting a second copy; otherwise it spawns `dist/server-bundle.mjs` — a single
self-contained file built by `npm run build` — as a child process.

Three details exist because of specific failures:

- **The interpreter is resolved by absolute path**, not from `PATH`. A `.app`
  launched from Finder or at login gets roughly `/usr/bin:/bin:/usr/sbin:/sbin`,
  so spawning bare `node` works under `tauri dev` and fails *only* in the
  packaged app. Homebrew/MacPorts locations are tried first, then
  nvm/volta/fnm/asdf/mise installs (newest version wins); `CENTRAL_BRAIN_NODE`
  overrides the search entirely.
- **The child gets a stdin pipe it never reads.** When the app dies for any
  reason — quit, SIGTERM, SIGKILL, crash — the OS closes the write end, the
  server sees EOF and exits. Without this, killing the app left the server
  orphaned and still holding the port, which the next launch would then attach
  to, silently talking to a stale build.
- **A dead server shows up in the tray**, in the tooltip and a status menu item,
  instead of the popover rendering blank. A status dashboard that can't report
  its own status was the original complaint.

There is no `launchd` service any more. The previous one baked an absolute path
into a plist at install time, so moving the repo broke it permanently and
silently — it had been crash-looping with `MODULE_NOT_FOUND` for weeks while the
app showed an empty popover. Start-at-login is handled by the app itself via
`tauri-plugin-autostart`, which points at the installed `.app` rather than a
path inside a checkout.

### Optional: AI summaries

The one-line "what's left" summaries and the daily digest need an Anthropic API
key ([console.anthropic.com](https://console.anthropic.com/settings/keys)).
Everything else — projects, alerting, GitHub status — works without one.

Two ways to provide it:

1. **In the app.** First launch shows a "Turn on AI summaries" card; paste the
   key there, or reach the same panel any time from the ⚙ button in the header.
   The key is verified against the API before it's saved (a free `models.list`
   call, so it costs nothing and doesn't touch the daily cap), then stored
   owner-only (`0600`) in `settings.json` inside the platform user-data dir —
   `~/Library/Application Support/central-brain/` on macOS. It survives app
   updates, is never sent back to the browser, and never enters the repo or the
   `.app` bundle.
2. **Via the environment.** Copy `.env.example` to `.env` and set
   `ANTHROPIC_API_KEY`. Convenient for `npm run dev`.

`ANTHROPIC_API_KEY` wins when both are present, and the settings panel says so
rather than pretending to accept a value it would ignore. Note that a packaged
`.app` never sees a `.env` at all: the sidecar is spawned with cwd `/`, so
`dotenv` finds nothing — which is exactly why option 1 exists.

To stop using AI, click **Remove key** (or **Skip for now** on first run —
the dashboard is fully usable without it).

## Development

```bash
npm run dev
```

Runs the Fastify API (`:4317`) and the Vite dev server (`:5173`, proxying
`/api` to the backend) with hot reload on both sides.

Releases are cut by pushing a `v*` tag (after bumping the version in
`package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`);
`.github/workflows/release.yml` builds the app on a macOS runner and attaches
it to a GitHub Release.

`docs/decisions/` is the project's internal engineering log — findings and
machine-specific measurements from building this, kept as history rather than
as user documentation.

## How it works

- **Read pipeline** (`src/server/scan/`) — reads Claude Code's
  `sessions-index.json` (falls back to raw `.jsonl` transcripts) and Codex's
  rollout files, resolves them into per-project session lists keyed by
  canonical filesystem path, and reads each project's markdown docs.
- **Alerting** (`src/server/alert/`, `src/server/routes/hook.ts`) — Claude
  Code posts hook events to `POST /api/hook` and Codex to
  `POST /api/hook/codex` (the tool comes from the route, because both send
  identical field names); `PermissionRequest` and `Notification` raise "needs
  attention" items (with a desktop notification on the first occurrence, not
  on every repeat), `Stop`/`SubagentStop` clear them silently,
  `UserPromptSubmit`/`SessionStart`/`SessionEnd` clear them because you're
  back at the keyboard. Pushed live to the dashboard over SSE
  (`GET /api/stream`).
- **Hook liveness** (`src/server/alert/hookLiveness.ts`) — every hook event
  stamps `hook-liveness.json`. If a Codex hook event has landed within
  the last 7 days (`CODEX_HOOK_LIVE_MS`), the staleness heuristic stands down
  entirely and drops its guesses, because hooks are authoritative. Reported at
  `GET /api/attention` as `hooks.codex`.
- **GitHub** (`src/server/github/ghClient.ts`) — shells out to `git` and
  `gh` per project, degrading silently when either is unavailable.
- **AI summaries** (`src/server/ai/summarize.ts`) — hash-gated: only calls
  the API when a project's docs/sessions actually changed since the last
  summary.
- **Persistence** (`src/server/store/db.ts`) — plain JSON files via
  `lowdb`: `overrides.json` (your rename/hide/pin decisions — the durable
  layer merged on top of every rescan), `attention.json`, `github.json`,
  `summaries.json`, `hook-liveness.json`.

## Known limitations

- Codex alerting falls back to a staleness heuristic, not a real push signal,
  whenever Codex's hooks have not been approved (or have gone quiet for over a
  week) — see `install-codex-hooks` above.
- The `Notification` Claude Code hook event conflates "truly blocked" with
  "idle for ~60s"; both surface as "waiting" in the panel.
- Project identity is the canonical filesystem path — if you move a repo,
  it'll show up as a new project with a "New" badge and your old rename/hide
  decisions for the old path won't carry over.
