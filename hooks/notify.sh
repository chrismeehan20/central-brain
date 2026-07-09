#!/bin/sh
# Fallback for Claude Code versions without native "http" hooks: forwards
# the hook event JSON (delivered on stdin) to central-brain via curl.
curl -s -X POST -H "Content-Type: application/json" \
  -d @- "${CENTRAL_BRAIN_HOOK_URL:-http://127.0.0.1:4317/api/hook}" \
  >/dev/null 2>&1 || true
