#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  claudeSettingsPath,
  installClaudeHooks,
  ClaudeHooksConfigError,
} from "../src/server/hooks/claudeHooks.js";

// Logic lives in src/server/hooks/claudeHooks.ts so the dashboard can drive
// the same install (a Releases user has no checkout to run this script from);
// this is the thin CLI wrapper for dev setups.
function main() {
  const settingsPath = claudeSettingsPath();
  // No ~/.claude means Claude Code has never run here. Creating the directory
  // ourselves would leave a stray config for a tool the user doesn't have —
  // a Codex-only user runs this from the README's setup block, so skip politely.
  if (!fs.existsSync(path.dirname(settingsPath))) {
    console.log(
      `No ${path.dirname(settingsPath)} found — is Claude Code installed? ` +
        "Skipping Claude Code hooks; run this again after your first Claude Code session."
    );
    return;
  }
  try {
    installClaudeHooks({ settingsPath });
  } catch (err) {
    if (err instanceof ClaudeHooksConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

main();
