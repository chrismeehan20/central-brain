# 0002 — v1.3: Codex review feedback queue

Status: **in progress**
Date opened: 2026-08-03
Driver: `/loop-queue` (one gated build-loop at a time, merged green before the next starts)

---

## Why this exists

An external Codex review of the live dashboard (59 records: 40 visible, 19
missing) endorsed the core "attention router" idea and flagged five priorities
plus a handful of smaller wins. Chris ratified the whole set with "implement as
you see fit", so product decisions below are the orchestrator's, recorded here
rather than asked one-by-one.

The review's three headline picks, verified against the code before queueing:

1. **Project identity is path-based, not repository-aware.**
   `resolveProject.ts` groups by canonical path only, so three
   `secondbell-school-apps` worktrees and two `Moki Law` checkouts render as
   five unrelated cards. Confirmed: `groupSessions()` keys on path with only
   case-insensitivity and `movedTo` merging.
2. **GitHub CI signals can lie.** Confirmed both claims in `ghClient.ts`:
   PR status reads `statusCheckRollup[0].conclusion` only (a passing first
   check hides a failing second one), and repo CI reads `gh run list -L 1`
   across the *whole repository* — a Dependabot branch's failure shows up as
   the project's CI state.
3. **40 visible cards is inventory, not mission control.** No Active/dormant
   split; pin/hide exist but the live data has zero pinned and zero hidden,
   i.e. the curation tools aren't earning their keep on their own.

Also confirmed before queueing:

- `digest.ts:53` returns the stale cached digest forever when no 24 h context
  exists (`if (!context) return cached`).
- First-run onboarding renders the optional API-key card above hook setup
  (`App.tsx` — ApiKeyPanel block precedes HooksPanel).
- `ProjectCard.tsx:324` hardcodes the "VS Code" button label while
  `Preferences.editor` supports Cursor/VSCodium/Windsurf; `AttentionPanel.tsx`
  tooltips do the same.
- `App.tsx:159` replaces the entire dashboard with the error screen on any
  poll failure, even with good data already on screen.
- `index.html` loads Satoshi from `api.fontshare.com` — the local dashboard
  phones home on every load.
- Test suite (153 tests) is entirely server-side.

## Ratified decisions

### D1 — Repository grouping via cheap fs reads, no subprocesses in the scanner

Worktrees are detected by reading the `.git` *file* (worktree checkouts carry
`gitdir: <main>/.git/worktrees/<name>` — one `readFileSync`, no `git`
subprocess in the sync scan path). Alternate checkouts of the same repo are
detected by the normalized `remote.origin.url` parsed from `.git/config`.
One card per repository; sibling checkouts/worktrees render as expandable rows
under it, each keeping its own sessions and open actions. The primary checkout
is the main worktree when present, else the most recently active path.

### D2 — "Active" means activity in the last 14 days

Dashboard sections become: needs-attention + pinned first, then **Active**
(last activity ≤ 14 days) as the default open section, then dormant projects
collapsed under **All projects**. Missing paths stay their own collapsible
inbox. 14 days rather than 7 because this is a many-side-projects workflow —
a project untouched for 10 days is paused, not dead.

### D3 — A digest that can't cite activity says so, deterministically

When `buildContext()` is empty the server stops returning the old cached
digest; the client shows a deterministic "No recorded activity in the last
24 hours" state (no AI call, no card space for prose). A cached digest older
than 48 h is treated the same as absent. Same policy for per-project
summaries: the model is instructed to return a sentinel when evidence is
insufficient, and the sentinel renders as the quiet empty state instead of
"I don't have enough evidence…" prose. Full structured output
(`currentState`/`nextAction`/`confidence`) is deferred — the sentinel gets the
trust win at a fraction of the surface area.

### D4 — Onboarding order: hooks first, key second

The hooks panel (the product's core "agent needs me" moment) renders before
the Anthropic-key card, and the key card waits until hooks are installed or
dismissed. No new multi-step wizard — reorder + gate only.

### D5 — Client tests without a new framework

The repo's testing convention (node:test via tsx, zero new dependencies,
decision recorded in 0001 Loop 2) extends to the client: pure logic is
extracted into plain modules (`sections.ts`, formatters, status aggregation)
and tested with node:test. No vitest/jsdom/testing-library; component-render
coverage is deliberately out of scope for this queue.

### D6 — Dependabot majors: split pairs land as single loops, at the end

- `react`/`react-dom` majors (#8, #13) each fail `npm ci` with ERESOLVE
  because react 19 and its types must move together — Dependabot can't author
  that PR shape. Both closed; one loop bumps all four packages.
- `vite` 8 (#14) fails the same way against `@vitejs/plugin-react` 4.x; closed
  and folded into one loop with the plugin major.
- Majors run **after** the feature loops: the feature work rewrites the exact
  files (App.tsx, ProjectCard.tsx, vite toolchain) those bumps would sit
  under, and none of the majors carries a security advisory (checked:
  `npm audit` reports 0 high/critical on main today).
- `chokidar` 5 (#12) is green and touches only `watch/watcher.ts` usage that
  the changelog lists as compatible; it merges first after a rebase so its
  checks run against current main (stale-green lesson from 0001 Stage 0).

## Gate

Unchanged from 0001: `npm ci` + `npm run typecheck` + `npm test` +
`npm run build`, all exit 0. Test floor at queue open: **153**. Loops that
touch logic add tests for what they touch; the floor ratchets up as they land.

## Queue

One loop in flight, ever. Ordered easiest → hardest, majors last.
Model tiers per the build-loop policy: `simple` = Sonnet maker,
`ordinary` = Opus maker, `hard` = orchestrator implements directly.

| # | Loop | Tier | Status | PR |
|---|---|---|---|---|
| 1 | Stage 0: rebase + merge chokidar 5 (#12); close #8/#13/#14 with fold-in notes | simple | **merged** | [#12](https://github.com/chrismeehan20/central-brain/pull/12) |
| 2 | Bundle Satoshi locally (woff2 + `@font-face`), drop the Fontshare fetch | simple | **merged** | [#27](https://github.com/chrismeehan20/central-brain/pull/27) |
| 3 | Editor buttons/tooltips honor `Preferences.editor` (ProjectCard, AttentionPanel, detail page) | simple | **merged** | [#28](https://github.com/chrismeehan20/central-brain/pull/28) |
| 4 | Keep the last good dashboard through a transient poll failure; error becomes a banner when data exists | simple | queued | — |
| 5 | Onboarding: hooks panel before the API-key card; key card gated on hooks done/dismissed (D4) | simple | queued | — |
| 6 | GitHub signal accuracy: aggregate all `statusCheckRollup` entries (worst-of), branch-scoped `gh run list --branch`, distinguish "branch failing" from "open PR failing" (+tests) | ordinary | queued | — |
| 7 | AI trustworthiness: digest no-activity/48 h-expiry state, summary insufficient-evidence sentinel (D3) (+tests) | ordinary | queued | — |
| 8 | Attention rows lead with display name + tool + requested action; dismiss/snooze for heuristic alerts | ordinary | queued | — |
| 9 | Active-vs-All split (D2): sections + filter chips (Attention/Dirty/CI/New), partition logic extracted + node:test'd (D5) | ordinary | queued | — |
| 10 | Repository-aware grouping (D1): worktree + remote-URL detection, one card per repo with expandable checkouts | hard | queued | — |
| 11 | React 19: `react` + `react-dom` + both `@types` in one PR (closes what #8/#13 attempted) | ordinary | queued | — |
| 12 | Vite 8 + `@vitejs/plugin-react` major (what #14 attempted) | hard | queued | — |

## Stop conditions

- CI fails twice on the same error → stop, report diagnosis.
- A `hard`-tier loop (10, 12) reaches a risky decision point → deferral with
  documented rationale is a valid completion.

## Log

- **2026-08-03** — Queue opened from the Codex review. Stage 0 findings: 4
  open Dependabot PRs, all majors. #12 green-but-stale (rebase requested);
  #8/#13/#14 structurally unable to pass alone (ERESOLVE peer conflicts) —
  folded into Loops 11–12 per D6. `dependabot.yml` already correct from 0001.
- **2026-08-03** — Note on 0001: its Loops 3–5c all merged (PRs #17–#23) but
  the table still said "in progress"; statuses corrected there. 0001's
  remaining queued items (spooling, SQLite, ccusage, OTel, replay) stay parked
  behind this queue.
