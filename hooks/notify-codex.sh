#!/bin/sh
# Codex hook forwarder. Codex only supports "command" hooks (no native "http"
# type like Claude Code), so the event JSON arrives on stdin and is POSTed to
# central-brain's Codex endpoint by curl.
#
# The endpoint is discovered per delivery instead of being baked into the hook
# command in hooks.json, because Codex keys hook approval to the exact hook
# definition: a port in that command would cost the user a fresh /hooks
# approval every time CENTRAL_BRAIN_PORT changed. The server publishes its live
# origin to <data dir>/runtime/endpoint on boot, and the installed copy of this
# script lives in <data dir>/hooks/, so it can find that file relative to
# itself whatever the data dir is.
#
# Each delivery also carries the install id and this script's revision, so the
# server can tell an event produced by the CURRENT wiring from one left over
# from a previous install — the difference between "Codex is talking to us"
# and "Codex talked to us once, before this broke".
#
# Deliberately fail-soft: a dead server, a hung socket or a missing curl must
# never fail or stall a Codex turn, so the request is capped with --max-time
# and the script always exits 0.

# Bump when this script's contract with the server changes; the server keeps a
# set of revisions whose receipts it still accepts as proof.
FORWARDER_REVISION=2

# `dirname "$0"` is relative to Codex's cwd, not ours; resolve it once. CDPATH
# is cleared because a user's exported CDPATH can make `cd` land elsewhere and
# print the wrong directory.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || script_dir=

# Most explicit first: an override (tests, unusual deployments), then the data
# dir this script was installed into, then the macOS default for a copy still
# being run out of a checkout. Endpoint and install id are read from the SAME
# directory, so they always describe one generation of the wiring.
endpoint=
install_id=
for candidate in \
  "${CENTRAL_BRAIN_RUNTIME_DIR:-}" \
  "${script_dir:+$script_dir/../runtime}" \
  "$HOME/Library/Application Support/central-brain/runtime"
do
  [ -n "$candidate" ] || continue
  [ -r "$candidate/endpoint" ] || continue
  endpoint=$(cat "$candidate/endpoint" 2>/dev/null) || endpoint=
  if [ -n "$endpoint" ]; then
    [ -r "$candidate/install-id" ] && install_id=$(cat "$candidate/install-id" 2>/dev/null)
    break
  fi
done

# 4317 is the historical default, and still right for the overwhelmingly common
# case of a server that simply has not booted since this script was installed.
curl -s --max-time 2 -X POST -H "Content-Type: application/json" \
  -H "X-Central-Brain-Install-Id: ${install_id}" \
  -H "X-Central-Brain-Forwarder-Revision: ${FORWARDER_REVISION}" \
  -d @- "${CENTRAL_BRAIN_CODEX_HOOK_URL:-${endpoint:-http://127.0.0.1:4317}/api/hook/codex}" \
  >/dev/null 2>&1
exit 0
