#!/bin/sh
# Codex hook forwarder. Codex only supports "command" hooks (no native "http"
# type like Claude Code), so the event JSON arrives on stdin and is POSTed to
# central-brain's Codex endpoint by curl.
#
# Deliberately fail-soft: a dead server, a hung socket or a missing curl must
# never fail or stall a Codex turn, so the request is capped with --max-time
# and the script always exits 0.
curl -s --max-time 2 -X POST -H "Content-Type: application/json" \
  -d @- "${CENTRAL_BRAIN_CODEX_HOOK_URL:-http://127.0.0.1:4317/api/hook/codex}" \
  >/dev/null 2>&1
exit 0
