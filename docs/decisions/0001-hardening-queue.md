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

Consequence: **Loop 6 adds hook-event spooling** — the hook script appends to
`~/.central-brain/spool/*.jsonl` *and* attempts the POST; the server drains the
spool on startup. Hook events become durable regardless of whether the server
is up. This was added specifically to make D1 safe, and is one of the two loops
the queue grew beyond the 9 originally scoped.

OTel gaps are accepted: metrics are for trends, not alerts, and the same facts
are derivable from transcripts + ccusage.

### D2 — Scope: everything in one queue

All loops run in this one queue (reliability first, then features), rather than
stopping after the reliability set for re-approval. Scoped at 9 when ratified;
now 12, having grown by the hook-spooling loop that D1 requires, the test
harness (Loop 2), and the `shell-quote` advisories found during Loop 1.

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

Updated by Loop 2 — the gate is now `npm ci` + `npm run typecheck` + `npm test` +
`npm run build`, and the test floor is **12**. The harness was mutation-checked
before landing (breaking `toUtcIso`'s fallback produced exit 1 / 1 failure, then
restored to a clean diff), so a green `npm test` means something.

---

## Queue

One loop in flight, ever. Each item is independently shippable and revertible.
Ordered easiest → hardest, with practical value pulled early (Loop 5 gets the
app reliably running before the big storage surgery in Loop 7).

Model tiers per the build-loop policy: `simple` = Sonnet maker,
`ordinary` = Opus maker, `hard` = orchestrator implements directly, plan first,
ask before risky calls.

| # | Loop | Tier | Status | PR |
|---|---|---|---|---|
| 1 | CI gate: workflow (typecheck + build), `dependabot.yml` with `update-types: [minor, patch]`, gitignore `.vscode/` | simple | **merged** | [#1](https://github.com/chrismeehan20/central-brain/pull/1) |
| 2 | Test harness: `node:test` via `tsx` (no new deps), `npm test` in CI, first tests for `paths.ts` + `markdown.ts` | simple | **merged** | [#10](https://github.com/chrismeehan20/central-brain/pull/10) |
| 3 | Fix Claude scanner: drop dead `sessions-index.json` path, bounded reads instead of whole-file `readFileSync`, stop dropping sessions with no `cwd` on the first user line, filter sidechains | ordinary | queued | — |
| 4 | Wire Codex hooks (append to `~/.codex/hooks.json`, must not clobber Better Peacock); read `state_5.sqlite` `threads`; **delete `codexStaleness.ts`** | ordinary | queued | — |
| 5 | Tauri sidecar: bundle server as `externalBin`, spawn from `lib.rs` setup, probe-then-attach health check, `tauri-plugin-autostart`, remove launchd + `install-service`/`uninstall-service` | hard | queued | — |
| 6 | Hook-event spooling + drain on startup (closes the D1 gap) | ordinary | queued | — |
| 7 | lowdb → SQLite/WAL, event-sourced (derive status by query, delete the decay/orphan state machine); fresh DB per D3 | hard | queued | — |
| 8 | ccusage integration: token + cost per project for both CLIs (subprocess, like `gh`) | simple | queued | — |
| 9 | OTel ingest — **must not use port 4317**, that is the dashboard's port and the OTLP gRPC default | ordinary | queued | — |
| 10 | Remote approve/deny via `PreToolUse` hold + dashboard decision | ordinary | queued | — |
| 11 | Session replay + full-text search over the event store | ordinary | queued | — |
| 12 | Resolve remaining high-severity advisories: `brace-expansion`, `fast-uri`, `find-my-way`, `postcss` — all have non-major fixes | simple | **promoted, see Stage 0** | — |

Loop 2 was inserted after Loop 1 opened: the gate was typecheck + build over 4,622
lines with **zero tests**, which is too weak to protect the storage replacement in
Loop 7. Everything below it shifted down by one.

## Stage 0 — Dependabot hygiene

Recorded as **N/A** when the queue opened (no `dependabot.yml`, zero open PRs).
Landing the config in Loop 1 immediately produced **8 PRs**, so Stage 0 became
live mid-run and was worked before Loop 3.

The config proved itself: 2 PRs arrived as grouped minor/patch and **6 majors
arrived individually**. Had they been grouped the old way, TypeScript 7 alone
would have held back every safe bump in the same group.

All 8 were opened against pre-Loop-2 main, so their green checks were **stale** —
they had never run `npm test`. Caught by running the full gate locally on #4,
which failed with `Missing script: "test"`. Each was rebased before merging so
CI ran the real gate; step lists were checked to confirm `npm test` actually
executed rather than assuming it from a green tick.

| ID | PR | Change | Tier | Status |
|---|---|---|---|---|
| S0-4 | [#4](https://github.com/chrismeehan20/central-brain/pull/4) | npm minor/patch group: `@anthropic-ai/sdk` 0.32.1→0.115.0, `tsx` 4.19.2→4.23.1 | simple | **merged** |
| S0-7 | [#7](https://github.com/chrismeehan20/central-brain/pull/7) | cargo minor/patch group in `/src-tauri` (`Cargo.lock` only, transitive patches) | simple | **merged** |
| S0-6 | [#6](https://github.com/chrismeehan20/central-brain/pull/6) | `typescript` 5.9.3→**7.0.2** | hard | **deferred, closed** |
| S0-9 | [#9](https://github.com/chrismeehan20/central-brain/pull/9) | `concurrently` 9.2.3→10.0.4 — clears the `shell-quote` advisories (7 high → 5) | simple | **merged** |
| S0-3 | [#3](https://github.com/chrismeehan20/central-brain/pull/3) | `actions/checkout` 4→7 | simple | queued |
| S0-2 | [#2](https://github.com/chrismeehan20/central-brain/pull/2) | `actions/setup-node` 4→7 | simple | queued |
| S0-5 | [#5](https://github.com/chrismeehan20/central-brain/pull/5) | `@fastify/static` 8.3.0→10.1.2 — **security fix, 4 high advisories** | ordinary | **promoted to next** |
| S0-8 | [#8](https://github.com/chrismeehan20/central-brain/pull/8) | `react` + `@types/react` major | ordinary | queued — **after** Loop 7 |

### Two things Stage 0 surfaced that a green tick would have hidden

1. **#4 carried a de-facto major.** `@anthropic-ai/sdk` **0.32.1 → 0.115.0** is
   83 releases, classified "minor" only because 0.x semver permits breaking
   changes in minors. It landed in the safe group by that technicality. Merged
   after confirming the only call sites are `new Anthropic({ apiKey })` and
   `messages.create({ model, … })` (`ai/summarize.ts`, `ai/detail.ts`,
   `ai/digest.ts`), which are stable across that range, and that all three
   tsconfig projects still typecheck against it.
2. **CI cannot validate Cargo changes.** `ci.yml` deliberately excludes the
   Rust build, so #7's green tick said nothing about `src-tauri`. Verified
   separately with `cargo check --locked` (exit 0) before merging. **Any future
   cargo PR needs the same local step** — a green CI on a `Cargo.lock`-only
   diff is meaningless.

### D4 — TypeScript 7 deferred

TypeScript 7 is the native (Go) compiler rewrite, not an ordinary major. This
repo puts its whole toolchain on TypeScript: four tsconfig projects, a Vite
React plugin, and the `tsx` loader the test runner depends on. A 12-test floor
is thin cover for a compiler swap, and nothing in this queue requires TS 7.

`#6` closed, and `dependabot.yml` now ignores the `typescript` major so it does
not reopen weekly. Revisit deliberately after Loop 7 (storage) lands; remove the
ignore entry at that point. Deferral with documented rationale is an explicit
valid outcome for a hard-tier item.

### D5 — Remaining majors folded in by risk

`concurrently` (S0-9) and the two GitHub Actions majors (S0-3, S0-2) run now as
simple loops. `@fastify/static` (S0-5) and React (S0-8) wait until after the
reliability work, because Loops 3–7 rewrite the server routes and storage those
two touch — bumping them first would only mean rebasing them under later loops.

#### D5a — amended: `@fastify/static` promoted to next

D5 parked S0-5 on the assumption it was a routine library major. It is not.
Running `npm audit` after merging S0-9 showed `@fastify/static` **≤10.1.1**
carrying **four high advisories**:

- path traversal in directory listing
- route guard bypass via encoded path separators
- authorization bypass via non-canonical URL paths
- route guard bypass via path traversal

This is a **runtime** dependency — it serves the dashboard client and is the
component that decides which files on disk a request can reach. `10.1.2` is the
fix, and it is exactly what S0-5 bumps to. Deferring a path-traversal fix behind
five loops of unrelated refactoring was the wrong call on the wrong premise, so
S0-5 is promoted ahead of Loop 3.

Scope is genuinely limited — the server binds `127.0.0.1` (`server/index.ts`)
and `fastifyStatic` is registered with a single root and `wildcard: false` — so
this is local-only exposure, not internet-facing. Promoted rather than treated as
an emergency.

React (S0-8) stays parked per the original D5 reasoning; it carries no advisories.

---

### Parked work

- `git stash` entry `loop-4 sidecar: serve dist/client in dev` (belongs to Loop 5 after renumbering) — the
  uncommitted `src/server/index.ts` change that makes Fastify serve
  `dist/client` outside prod. Belongs to Loop 4; unstash there.

### Stop conditions

- CI fails twice on the same error → stop, report diagnosis.
- A `hard`-tier loop (5, 7) reaches a risky decision point → ask before
  acting. Deferral with documented rationale is a valid completion.

---

## Log

- **2026-07-29** — Queue opened. Stage 0 (Dependabot hygiene) **N/A at open**: no
  `.github/dependabot.yml`, zero open PRs, nothing to triage. Loop 1 adds the
  config so future majors arrive as individual PRs. *(Superseded the same day —
  that config produced 8 PRs and Stage 0 became live; see the Stage 0 section.)*
- **2026-07-29** — `npm audit` during Loop 1 verification reported **7 high**
  severity advisories, all `shell-quote` reached via `concurrently`. That is a
  devDependency used only by `npm run dev`, so the shipped app is unaffected —
  logged as Loop 11 rather than treated as urgent. The `dependabot.yml` landing
  in Loop 1 will also start proposing these bumps weekly.
