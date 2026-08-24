# 0005 — Cloud sessions, seen through their pull requests

Status: **complete**
Date opened: 2026-08-24
Driver: Chris asked whether Claude web/app work updates Central Brain, and — since it doesn't — for the reliable way to integrate it.

---

## The gap

Every input this app has is local to the Mac, by construction:

- **Discovery** watches `~/.claude/projects` and `~/.codex/sessions`
  (`watch/watcher.ts`) and reads transcripts off disk (`scan/claude.ts`).
  A project exists here *because* a session transcript named its `cwd`; there
  is no repo-walking discovery.
- **Alerts** arrive at `http://127.0.0.1:<port>/api/hook`, installed into
  `~/.claude/settings.json` (`hooks/claudeHooks.ts`), and the server binds
  loopback only (`index.ts`).
- **GitHub status** runs `git` and `gh` *inside a local checkout*
  (`github/ghClient.ts`).

A Claude Code session running in the cloud — claude.ai/code, or the desktop
app's Code tab driving a remote container — satisfies none of these. Its
transcript lives in a container that is reclaimed when the session ends, and
that container cannot reach a loopback port on this machine. So it never
becomes a `SessionRef`, never raises an attention row, and never feeds a
summary. Sessions the desktop app runs *locally* are unaffected: those write
to `~/.claude/projects` like any other, with `entrypoint: "claude-desktop"`.

Worth stating plainly, because it bounds everything below: **the local half of
this app is not fixable from here.** Nothing short of an inbound network path
would let a container push an event to this process, and the README's promise
("runs entirely on your machine, no SaaS") is worth more than event parity.

## What was rejected

- **A tunnel to `/api/hook`** (Tailscale/Cloudflare + a bearer token). True
  real-time parity, and the only option that surfaces a *live* cloud session.
  Rejected: it breaks the local-only promise, the hook route is unauthenticated
  precisely because it is loopback-bound, and a tunnel URL baked into a hook
  definition is exactly the volatility 0004 spent itself eliminating.
- **A repo-checked-in hook that self-reports to a GitHub inbox.** Richer
  events, but it needs a hook committed to every repo, depends on
  project-settings hooks executing un-approved in a remote container, and
  writes status noise somewhere. Reconsider if PR state proves too coarse.

## What was built

Poll your own open pull requests. A PR is the one artifact that crosses back
from a container to here, it carries the state that actually matters
(conflicted, red, reviewed, finished), and reading it needs no new token, no
new daemon and no inbound path — `gh` is already a dependency.

- `github/remotePrs.ts` — `gh pr list --repo <slug> --author @me --state open`
  per watched repo, plus the pure classifier that decides what needs the user.
- `poll/remoteWorkPoller.ts` — reconciles those verdicts into attention rows
  every 10 minutes.
- Watched repos are derived from each project's `origin` remote, so the common
  case is zero-config. `preferences.remoteRepos` covers the case discovery
  structurally cannot: a repo that only exists in the cloud.

### Three decisions inside that, recorded because they are not obvious

1. **The quiet window (`QUIET_MS`, 15 min) is load-bearing, not tuning.**
   Cloud sessions run under a harness that drives their own PR to green — it
   re-pushes on red CI and on merge conflicts by itself. Alerting on a failure
   the agent is already fixing would put this app in a shouting match with it
   and train the user to ignore the panel. A row appears only once the agent
   has stopped pushing. `MAX_AGE_MS` (7 days) closes the other end: past that a
   PR is backlog, and backlog in an alert panel is noise.

2. **Drafts are the main case, not an edge case.** Sessions on the web open
   PRs as drafts by default. Skipping drafts would skip nearly everything this
   exists to surface, so a finished draft is a first-class "over to you".

3. **These rows are polled, and polled rows are a different animal.** A hook
   row is edge-triggered: only a later event clears it, and dismissing it
   sticks. A PR row is re-derived every pass, so the poller owns it — it
   deletes rows the world no longer justifies (a merged PR's row vanishes on
   its own), and dismissal has to *snooze* rather than delete or the next pass
   resurrects it. That is why `POLLED_TYPES` in `alert/attention.ts` now names
   four types instead of one. The matching trap is on the other side: a repo
   whose `gh` call *failed* must keep its rows, because no answer is not the
   same answer as "resolved" — offline would otherwise look exactly like
   merged.

## What this still does not do

It says nothing about a cloud session that is *running* — only about what it
left behind. A session blocked on a question mid-run is invisible here, and
still reaches you the way it always did: Claude's own push notification. If
that gap starts to hurt, the rejected inbox option above is the next step, not
a wider poll.
