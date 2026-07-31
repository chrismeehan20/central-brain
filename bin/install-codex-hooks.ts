#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  codexHooksPath,
  installCodexHooks,
  CodexHooksConfigError,
} from "../src/server/hooks/codexHooks.js";

// Logic lives in src/server/hooks/codexHooks.ts so it can be exercised against
// a temp fixture in tests; this script is the thin CLI wrapper.
function main() {
  const hooksPath = codexHooksPath();
  // No Codex home means Codex has never run here — a Claude-only user runs
  // this from the README's setup block, so skip politely rather than creating
  // config for a tool they don't have.
  if (!fs.existsSync(path.dirname(hooksPath))) {
    console.log(
      `No ${path.dirname(hooksPath)} found — is Codex installed? ` +
        "Skipping Codex hooks; run this again after your first Codex session."
    );
    return;
  }
  try {
    installCodexHooks({ hooksPath });
  } catch (err) {
    if (err instanceof CodexHooksConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

main();
