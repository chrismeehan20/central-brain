# 0001 — Central Brain hardening & feature queue

Status: **in progress**
Date opened: 2026-07-29
Driver: `/loop-queue` (one gated build-loop at a time, merged green before the next starts)

---

## Why this exists

Central Brain felt "quirky and unreliable." Investigation found the cause was
not architectural — it was that **the app was usually not running**, plus two
upstream assumptions that had gone stale.

### Root cause: the launchd service has been dead

```
$ launchctl list | grep centralbrain
-    78    com.chrismeehan.centralbrain      # no PID, exit 78
$ curl localhost:4317  ->  000               # nothing listening
```

`~/Library/LaunchAgents/com.chrismeehan.centralbrain.plist` points at
`/Users/chrismeehan/Documents/Chris Code Repository/central-brain/dist/server/index.js`.
That directory no longer exists — the repo moved to `~/code/central-brain` and
`install-service` was never re-run. The live log shows `MODULE_NOT_FOUND`, and
`KeepAlive: true` means launchd has been crash-looping silently ever since.

Cause in code: `bin/install-service.ts:8-9` resolves `PROJECT_DIR` **once at
install time** and bakes it into the plist as an absolute string. Moving or
renaming the folder breaks the service permanently, and the failure is visible
nowhere in the product.

### Stale upstream assumptions

1. **`codexStaleness.ts:20` claims "Codex has no hook system."** No longer
   true. Codex ships `PreToolUse`, `PostToolUse`, `PermissionRequest`,
   `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, `PreCompact`,
   `PostCompact`, `SubagentStart`, `SubagentStop` via `~/.codex/hooks.json`.
   That file **already exists on this machine** (wired to Better Peacock's
   `agent-beacon.cjs`) — Central Brain simply isn't using it. The entire
   154-line mtime-growth heuristic is obsolete.
2. **`scan/claude.ts:94` prefers `sessions-index.json`.** That file no longer
   exists anywhere under `~/.claude`, so every scan falls through to
   `claude.ts:125-151`, which `readFileSync`s every transcript in full and
   silently drops any session whose first user line lacks `cwd`
   (`claude.ts:138`) — the "projects randomly missing" bug.

### Two more findings

- **Storage loses writes.** lowdb rewrites the whole JSON file per
  `write()`, with four concurrent writers (hook route + 3 pollers). Evidence:
  `data/attention 2.json` (2107 B) and `data/attention 3.json` (17 B) are
  conflict copies.
- **Nothing owns the lifecycle.** launchd runs the server; Tauri runs a
  popover hardcoded to `http://localhost:4317`. They know nothing about each
  other, so when the server is down the popover is a silently-blank webview.
  A status dashboard that cannot report its own status.

### Newly available upstream capability (unused)

- `~/.codex/state_5.sqlite` `threads` table: `cwd`, `title`,
  `first_user_message`, `preview`, `tokens_used`, `git_branch`, `git_sha`,
  `git_origin_url`, `model`, `approval_mode`, `source`, `updated_at_ms`.
- Claude Code OpenTelemetry: `cost.usage`, `token.usage`,
  `lines_of_code.count`, `commit.count`, `pull_request.count`,
  `active_time.total`, plus a `claude_code.tool.blocked_on_user` trace span.
- Claude Code **Agent View** (native, v2.1.139+; this machine runs 2.1.212)
  already covers per-session "who is blocked" for Claude. Central Brain should
  not compete there — its defensible ground is *project-level* state across
  **both** tools, fused with docs + git + PRs + CI.

---

## Ratified decisions

### D1 — Lifecycle: Tauri owns the server

The menubar app spawns the Node server as a bundled sidecar child process;
autostart at login via `tauri-plugin-autostart`. launchd job is removed.
One process tree, no absolute paths that can go stale.

Asked whether a quit app would "catch up on what it missed." Answer:
everything derived from disk rebuilds on next scan — Claude transcripts, Codex
`state_5.sqlite`, git/PR state, docs, and ccusage token history are all
written by other processes and re-read fresh. The only losses are **pushed**
signals: hook POSTs to a dead port, and OTel (a push protocol).

Consequence: **Loop 5 adds hook-event spooling** — the hook script appends to
`~/.central-brain/spool/*.jsonl` *and* attempts the POST; the server drains the
spool on startup. Hook events become durable regardless of whether the server
is up. This was added specifically to make D1 safe, and is why the queue is 10
loops rather than 9.

OTel gaps are accepted: metrics are for trends, not alerts, and the same facts
are derivable from transcripts + ccusage.

### D2 — Scope: everything in one queue

All 10 loops run in this queue (reliability first, then features), rather than
stopping after the reliability set for re-approval.

### D3 — Data: fresh start

New SQLite DB starts empty; all projects return to "needs triage" and
rename/hide/pin decisions are redone by hand.

Safety qualifier applied by the orchestrator: the migration **deletes nothing**.
Existing `data/*.json` is left in place (already gitignored) so the old
`overrides.json` curation can be recovered if this choice is regretted.

---

## Gate

No CI existed when this queue opened, so "merge on green CI" had nothing to
gate on. **Loop 1 creates the gate.** From Loop 2 onward the gate is the CI
workflow on the PR head.

Baseline recorded 2026-07-29 before any changes, on Node v22.18.0:

| Check | Command | Baseline |
|---|---|---|
| Typecheck | `npm run typecheck` (3 tsc projects) | **exit 0** |
| Build | `npm run build` (vite + tsc) | **exit 0** |
| Tests | — | **0 (none exist)** |

Test count must never fall below baseline. Where a loop can add cheap
regression coverage for a bug it fixes, it should.

---

## Queue

One loop in flight, ever. Each item is independently shippable and revertible.
Ordered easiest → hardest, with practical value pulled early (Loop 4 gets the
app reliably running before the big storage surgery in Loop 6).

Model tiers per the build-loop policy: `simple` = Sonnet maker,
`ordinary` = Opus maker, `hard` = orchestrator implements directly, plan first,
ask before risky calls.

| # | Loop | Tier | Status | PR |
|---|---|---|---|---|
| 1 | CI gate: workflow (typecheck + build), `dependabot.yml` with `update-types: [minor, patch]`, gitignore `.vscode/` | simple | **in progress** | — |
| 2 | Fix Claude scanner: drop dead `sessions-index.json` path, stream transcripts line-by-line, stop dropping sessions with no `cwd` on the first user line | ordinary | queued | — |
| 3 | Wire Codex hooks (append to `~/.codex/hooks.json`, must not clobber Better Peacock); read `state_5.sqlite` `threads`; **delete `codexStaleness.ts`** | ordinary | queued | — |
| 4 | Tauri sidecar: bundle server as `externalBin`, spawn from `lib.rs` setup, probe-then-attach health check, `tauri-plugin-autostart`, remove launchd + `install-service`/`uninstall-service` | hard | queued | — |
| 5 | Hook-event spooling + drain on startup (closes the D1 gap) | ordinary | queued | — |
| 6 | lowdb → SQLite/WAL, event-sourced (derive status by query, delete the decay/orphan state machine); fresh DB per D3 | hard | queued | — |
| 7 | ccusage integration: token + cost per project for both CLIs (subprocess, like `gh`) | simple | queued | — |
| 8 | OTel ingest — **must not use port 4317**, that is the dashboard's port and the OTLP gRPC default | ordinary | queued | — |
| 9 | Remote approve/deny via `PreToolUse` hold + dashboard decision | ordinary | queued | — |
| 10 | Session replay + full-text search over the event store | ordinary | queued | — |
| 11 | Resolve 7 high-severity advisories: `shell-quote` via `concurrently` (devDependency — `npm run dev` only, not in the shipped app) | simple | queued | — |

### Parked work

- `git stash` entry `loop-4 sidecar: serve dist/client in dev` — the
  uncommitted `src/server/index.ts` change that makes Fastify serve
  `dist/client` outside prod. Belongs to Loop 4; unstash there.

### Stop conditions

- CI fails twice on the same error → stop, report diagnosis.
- A `hard`-tier loop (4, 6) reaches a risky decision point → ask before
  acting. Deferral with documented rationale is a valid completion.

---

## Log

- **2026-07-29** — Queue opened. Stage 0 (Dependabot hygiene) **N/A**: no
  `.github/dependabot.yml`, zero open PRs, nothing to triage. Loop 1 adds the
  config so future majors arrive as individual PRs.
- **2026-07-29** — `npm audit` during Loop 1 verification reported **7 high**
  severity advisories, all `shell-quote` reached via `concurrently`. That is a
  devDependency used only by `npm run dev`, so the shipped app is unaffected —
  logged as Loop 11 rather than treated as urgent. The `dependabot.yml` landing
  in Loop 1 will also start proposing these bumps weekly.
