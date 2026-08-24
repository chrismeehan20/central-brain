# 0006 — Find `gh` the way we find `node`, and say so when it isn't there

## Context

`ghClient.ts` and `remotePrs.ts` both ran `execFile("gh", …)`, trusting PATH to
resolve it.

PATH is exactly what a packaged `.app` does not have. `src-tauri/src/sidecar.rs`
documents this in its own comments and builds an elaborate answer for one
binary: a `.app` launched from Finder or at login inherits roughly
`/usr/bin:/bin:/usr/sbin:/sbin`, so the sidecar probes absolute candidates and
then nvm/asdf/mise/fnm layouts to find `node`. Having found it, the sidecar
spawns the server setting `NODE_ENV`, `PORT`, `CENTRAL_BRAIN_WATCH_PARENT` and
two resource dirs — and no PATH. The server inherits the stub.

Homebrew installs `gh` to `/opt/homebrew/bin/gh` on Apple Silicon. That is not
in the stub. So every `gh` call in the packaged app raised ENOENT, every call
site caught it and moved on, and the GitHub panels stayed empty — on precisely
the installs that were not developer machines. Under `npm run dev` it all
worked, because that inherits the developer's shell. The mode the sidecar
comments call "invisible, packaged-path-only", one layer up.

0005 made this worse rather than exposing it: the PR attention rows are
entirely `gh`-dependent, so a feature whose whole point is to tell you when
something needs you had a silent no-op as its failure mode.

## Decision

**Resolve `gh` by absolute path before trusting PATH,** in `github/ghBinary.ts`,
mirroring the sidecar's candidate-list approach: Homebrew (both architectures),
`/usr/bin`, MacPorts, then `$HOME`-relative installs, then PATH last. PATH stays
in the list because it is the only thing that finds an install nobody predicted,
and it is authoritative whenever the server was started from a shell.

**Report the state instead of degrading to silence.** `inspectGhCli()` returns
`missing` / `unauthenticated` / `connected`, surfaced at `GET /api/settings` and
rendered in ⚙ next to the hook rows. This is 0004's lesson applied to the other
integration: "installed", "trusted" and "live" were three booleans that could
contradict each other, and the fix was one diagnosis with a cause attached.
Here the three states had been collapsed the other way — into one empty panel
that meant "install gh", "run gh auth login" or "nothing needs you" with no way
to tell which.

`gh auth status`'s **exit code** is the signal. Its human-readable output has
changed shape across releases and moved between stdout and stderr; none of that
affects whether it exited 0. The account name is a separate best-effort
`gh api user --jq .login`, so a `gh` too old for that flag, or an offline one,
reports connected without a name rather than reporting nothing.

## Rejected

- **Setting PATH on the sidecar spawn.** Fixes `gh` and nothing else, in Rust,
  where the failure is invisible to the tests. It also hardcodes a guess about
  the user's PATH into the app launcher — the resolution belongs next to the
  code that actually runs the binary.
- **A PATH-shaped env var for users to set.** A knob that exists because we
  would not do the lookup. `CENTRAL_BRAIN_NODE` earns its keep as a last-resort
  override for a genuinely exotic install; a required one is a support burden.
- **Our own OAuth flow and token storage.** Removes the `gh` dependency
  entirely, and takes on a stored credential, a refresh path, and a scopes
  decision in exchange. "No new tokens" is a feature — `gh` already solved
  this, in the keychain, with a revocation story.
- **Probing on every request.** The resolved path is cached for the process,
  because it is read on every poll of every project and changes only when the
  user installs something. `POST /api/settings/github/recheck` is the explicit
  reconsideration, so acting on the panel's advice costs a click, not a
  relaunch.

## Consequences

An install where `gh` is missing or signed out now says so, once, in the place
the user already goes to connect their tools. Per-project failures below that
still degrade quietly on purpose: one unreachable repo must not blank the rest.

The candidate list is a maintenance surface. A new install location for `gh`
means a new entry — the same standing cost `NODE_CANDIDATES` already carries,
and the same reason both lists are absolute: a relative entry would reintroduce
the PATH dependence this exists to remove.
