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
# Each delivery carries the install id and this script's revision, so the
# server can tell an event produced by the CURRENT wiring from one left over
# from a previous install.
#
# An event that cannot be delivered is kept in <data dir>/spool/pending and
# drained when the server comes back, so an app restart, an upgrade or a crash
# no longer silently eats the events that fired during it.
#
# Deliberately fail-soft throughout: a dead server, a hung socket, a full disk
# or a missing curl must never fail or stall a Codex turn, so the request is
# capped with --max-time and the script always exits 0.

# Bump when this script's contract with the server changes; the server keeps a
# set of revisions whose receipts it still accepts as proof.
FORWARDER_REVISION=3

# A hook payload is a few KB. Anything past this is pathological, and spooling
# it would be a way to fill someone's disk one event at a time.
MAX_PAYLOAD_BYTES=262144

# Matches SPOOL_MAX_FILES in src/server/hooks/spool.ts. Bounds the queue while
# the server is down, which is the only time it can grow.
MAX_SPOOL_FILES=500

# `dirname "$0"` is relative to Codex's cwd, not ours; resolve it once. CDPATH
# is cleared because a user's exported CDPATH can make `cd` land elsewhere and
# print the wrong directory.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || script_dir=

# Most explicit first: an override (tests, unusual deployments), then the data
# dir this script was installed into, then the macOS default for a copy still
# being run out of a checkout. Endpoint, install id and spool all come from the
# SAME directory, so they always describe one generation of the wiring.
endpoint=
install_id=
data_dir=
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
    data_dir=$(dirname -- "$candidate")
    break
  fi
done
[ -n "$data_dir" ] || data_dir="${script_dir:+$script_dir/..}"

spool_dir="$data_dir/spool"
# 077 so the directories and the payload files inside them are ours alone:
# hook payloads can carry tool arguments.
(umask 077 && mkdir -p "$spool_dir/pending") 2>/dev/null

# Buffer stdin before attempting delivery, so the same bytes can be retried
# later. Staged in the spool root rather than pending/, so the server never
# sees a file that is still being written. `head -c` one past the limit is how
# an oversized payload is detected without reading it all into a variable.
payload=$(umask 077 && mktemp "$spool_dir/tmp.XXXXXXXX" 2>/dev/null) || payload=
if [ -z "$payload" ]; then
  # No spool available (read-only disk, no HOME): fall back to streaming
  # straight through, which is exactly the old behaviour.
  curl -s --max-time 2 -X POST -H "Content-Type: application/json" \
    -H "X-Central-Brain-Install-Id: ${install_id}" \
    -H "X-Central-Brain-Forwarder-Revision: ${FORWARDER_REVISION}" \
    --data-binary @- "${CENTRAL_BRAIN_CODEX_HOOK_URL:-${endpoint:-http://127.0.0.1:4317}/api/hook/codex}" \
    >/dev/null 2>&1
  exit 0
fi

head -c $((MAX_PAYLOAD_BYTES + 1)) > "$payload" 2>/dev/null
size=$(wc -c < "$payload" 2>/dev/null | tr -d ' ')
if [ -z "$size" ] || [ "$size" -gt "$MAX_PAYLOAD_BYTES" ] || [ "$size" -eq 0 ]; then
  rm -f "$payload"
  exit 0
fi

# `--fail` turns a 4xx/5xx into a non-zero exit, so "the server answered
# angrily" spools alongside "the server never answered".
if curl -sf --max-time 2 -X POST -H "Content-Type: application/json" \
  -H "X-Central-Brain-Install-Id: ${install_id}" \
  -H "X-Central-Brain-Forwarder-Revision: ${FORWARDER_REVISION}" \
  --data-binary @"$payload" \
  "${CENTRAL_BRAIN_CODEX_HOOK_URL:-${endpoint:-http://127.0.0.1:4317}/api/hook/codex}" \
  >/dev/null 2>&1
then
  rm -f "$payload"
  exit 0
fi

# Delivery failed. Keep it — unless the queue is already long, which means the
# server has been gone a while and the newest events are the ones worth having.
pending=$(ls -1 "$spool_dir/pending" 2>/dev/null | wc -l | tr -d ' ')
if [ -n "$pending" ] && [ "$pending" -ge "$MAX_SPOOL_FILES" ]; then
  rm -f "$payload"
  exit 0
fi

# Rename rather than copy, so the server can never read a half-written file.
# Named with an epoch prefix so the queue is legible in date order; the server
# sorts by mtime regardless, which is the authoritative answer.
mv "$payload" "$spool_dir/pending/event-$(date +%s)-${payload##*.}.json" 2>/dev/null \
  || rm -f "$payload"
exit 0
