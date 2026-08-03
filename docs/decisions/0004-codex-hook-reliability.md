# 0004 — Codex hook reliability queue

Status: **in progress**
Date opened: 2026-08-03
Driver: `/loop-queue` (one gated build-loop at a time, merged green before the next starts)

---

## Why this exists

An external Codex review of the Codex hook integration argued that
central-brain treats `trusted_hash` as the definition of "working", and that
the three booleans the API exposes (`installed`, `trusted`, `live`) can
contradict each other. Chris ratified the set with "verify and implement as
you see fit", so the product decisions below are the orchestrator's, recorded
here rather than asked one-by-one — the same convention as 0002.

Every claim was checked against the code before queueing. What follows is the
verdict on each, because roughly a third of the review is either already
handled or not worth building.

### Confirmed, and worth fixing

1. **A stale hook entry makes install a permanent no-op.**
   `installCodexHooks` treats any group containing one of ours as
   `alreadyPresent` (`codexHooks.ts:241`), and `entryIsOurs` matches on "the
   command string contains `notify-codex.sh`" (`codexHooks.ts:100`). So an
   entry pointing at a checkout that has since moved, or at a `.app` that has
   been replaced, still reads as installed. The dashboard hides the Install
   button (`HooksPanel.tsx:121` renders it only when `!installed`), and
   re-running install writes nothing. There is no path back short of hand-
   editing `hooks.json`. **This is the most severe item in the queue.**

2. **The hook command embeds a volatile path.**
   `codexNotifyScriptPath()` resolves through `appPaths.resolveNotifyScript`,
   which lands on the checkout under `tsx`/`dist`, or on
   `…/Central Brain.app/Contents/Resources/hooks/…` when packaged. Moving,
   renaming, or replacing the app breaks every installed hook, and — because
   Codex keys approval to the exact hook definition — even a *correct* rewrite
   costs the user a re-approval.

3. **The forwarder ignores the server's port.**
   `hooks/notify-codex.sh:10` defaults to `http://127.0.0.1:4317/api/hook/codex`
   with only a `CENTRAL_BRAIN_CODEX_HOOK_URL` env override, which a
   Codex-spawned process will not reliably have. The Claude installer already
   solves this by baking `env.PORT` into the URL at install time
   (`claudeHooks.ts:56`); the Codex path never got the equivalent. Anyone
   running under `CENTRAL_BRAIN_PORT` gets zero Codex events and a dashboard
   that blames Codex.

4. **Liveness cannot tell "arriving now" from "arrived once, six days ago".**
   `getHookLiveness` compares one unqualified timestamp against a seven-day
   window (`hookLiveness.ts:82`). A single event, followed by the install
   breaking for any of the reasons above, still reads `live: true` for a week
   — and `HooksPanel.describe()` renders that as "Connected — events are
   arriving." The review's own example (removal) is wrong, because `describe`
   checks `!installed` first; the real path to a lying "Connected" is a
   *stale* install, which stays `installed: true`. Same defect, worse cause.

5. **Offline events are dropped.** 0001's D1 ratified hook-event spooling as
   the thing that makes "Tauri owns the server's lifetime" safe
   (`0001-hardening-queue.md:209`). It was never built: nothing in `src/`,
   `hooks/`, `bin/`, or `src-tauri/` mentions a spool. Every event fired while
   the server is down is lost.

6. **The docs describe a trust model Codex no longer uses.** `README.md:119`
   still says approval is "keyed to a hash of the whole file" and that
   "`~/.codex/hooks.state` appearing is how you know it worked". Commit
   773f588 already established that current Codex stamps a per-group
   `trusted_hash` instead. The stale claim also survives in comments at
   `codexHooks.ts:15` and `hookLiveness.ts:19`.

7. **Config writes are neither atomic nor safely backed up.** `write()` is a
   bare `writeFileSync` and `backup()` overwrites a single `.bak` every time,
   so a second install destroys the only copy of the pre-install state.

### Rejected, with reasons

- **D-A — No enterprise/MDM path.** The review's PR 6 proposes `requirements.toml`
  managed hooks, MDM-installed forwarders, and policy-trusted definitions.
  Central Brain is a single-user macOS menubar app with no fleet story; this
  would be a feature built for a user who does not exist. Dropped as a
  non-goal, consistent with the README already scoping the product to macOS.

  Amended in Loop 4: *detecting* a Codex that has hooks switched off is kept,
  because `[features] hooks = false` is ordinary user config, not enterprise
  policy — and without it a correctly installed, correctly approved setup would
  be told to run `/hooks` forever, to no effect. Detection only; nothing writes
  to `config.toml`.

- **D-B — No per-server auth token on hook posts.** The review wants a random
  token in the runtime manifest, checked on delivery. Nothing else on this
  server authenticates — it binds loopback and serves the whole dashboard API
  unauthenticated. Adding a token to one endpoint buys no real defence and
  makes the forwarder's failure modes harder to diagnose. The *endpoint
  discovery* half of that proposal is kept (Loop 1); the token is not.

- **D-C — The status model ships reduced.** The proposed enum has 6 config
  states × 4 approval states × 3 delivery states × 9 overall states. Several
  are unreachable in this product (`policy_blocked` has no producer once D-A
  is dropped) and several collapse to the same UI copy. Loop 4 ships the
  states that have a distinct cause *and* a distinct user action, and no more.

- **D-D — No Codex-home directory picker.** A Finder-launched app genuinely
  cannot see a shell's `CODEX_HOME`, but the recovery the review proposes (a
  settings-persisted path plus a validating folder picker) is a lot of surface
  for an edge case. Loop 4's diagnostics report the resolved Codex home and
  say when it looks wrong, which makes the problem legible; a picker can
  follow if it ever actually bites.

## Ratified decisions

### D1 — The installed hook command must be stable across app moves and upgrades

The forwarder is copied to `~/Library/Application Support/central-brain/hooks/`
(the existing `resolveDataDir()` root) and the Codex hook command points
*there*, never at a checkout or a `.app` resource. The copy is refreshed on
server boot and at install time, so upgrading the app upgrades the forwarder
without touching `hooks.json` — and therefore without spending a re-approval.

### D2 — The port is discovered at delivery time, not baked in at install time

The server writes a runtime manifest into the data dir on boot; the forwarder
reads the endpoint from it per delivery. Changing `CENTRAL_BRAIN_PORT` then
requires no reinstall and no re-approval. This is deliberately *not* the
Claude approach of baking `env.PORT` into the entry: Claude's hook config has
no approval step to spend, Codex's does.

### D3 — Install becomes reconciliation against one canonical spec

A single spec object (events, handler fields, timeouts, ownership marker,
revision) is the desired state. Install compares and converges: exact match is
a no-op, missing is appended, a *known previous* central-brain definition is
replaced in place, duplicates collapse to one. Foreign entries — and their
`trusted_hash` values — are preserved untouched in every path. Any write that
changes one of our definitions must tell the user it costs a re-approval.

### D4 — Liveness is qualified by installation identity

A receipt proves the pipeline only if it came from the *current* install: the
forwarder sends an install id and a forwarder revision with every delivery,
and liveness requires a recent receipt whose id matches the one on disk and
whose revision we still support. An unqualified timestamp is no longer
sufficient evidence for "Connected".

**Accepted consequence of D4:** existing users re-verify once. Their stored
`lastEventAt` carries no receipt, so it stops counting the moment they upgrade,
and Codex reads as "waiting for verification" until the next event arrives —
which for anyone actually using Codex is one prompt away, since `SessionStart`
and `UserPromptSubmit` both fire. Meanwhile the staleness heuristic covers, and
a spurious low-priority flag is the failure we prefer. The alternative — trust
a receipt-less timestamp — is precisely the false "Connected" this loop exists
to remove.

### D5 — `trusted_hash` is an approval *hint*, not the definition of working

Its location inside hook groups is current-Codex behaviour, not a documented
contract. Precedence: a matching live receipt proves execution outright; a
missing hash suggests review is needed; a present hash with no receipt is
"approved, waiting for verification". No state may render "Connected" while
the desired config is absent or stale.

### D6 — Events survive a server outage

The forwarder writes each event to a `0600` file in a `0700` spool directory,
attempts delivery, and deletes on 2xx only. The server drains on boot and
periodically, deduplicating by delivery id and quarantining what it cannot
parse. The forwarder always exits 0 and stays well inside Codex's 3s
`SessionEnd` budget. This closes 0001's D1.

## Queue

| Loop | Item | Tier | Status |
|---|---|---|---|
| 1 | Stable forwarder location + runtime endpoint discovery (D1, D2) | ordinary | **merged** (#45) |
| 2 | Desired-state reconciliation + atomic writes & timestamped backups (D3) | ordinary | **merged** (#47) |
| 3 | Installation identity + receipt-qualified liveness (D4) | ordinary | **merged** (#49) |
| 4 | `inspectCodexHooks()` diagnostic status model (D5, D-C) | ordinary | **in review** |
| 5 | Durable event delivery: spool + drain (D6) | hard | pending |
| 6 | HooksPanel renders the status model, repair vs install | ordinary | pending |
| 7 | Docs reconciliation: README + stale trust comments, close this record | simple | pending |

Gate for every loop: `npm run typecheck && npm test && npm run build`, all
exit 0, test count not below the previous loop's. Baseline at open: **250
tests**.

Tests use isolated `mkdtemp` Codex homes and never read, write, or resolve the
developer's real `~/.codex` — the convention `codexHooks.test.ts` already
established.
