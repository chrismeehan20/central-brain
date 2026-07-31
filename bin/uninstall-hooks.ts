#!/usr/bin/env node
import {
  claudeSettingsPath,
  uninstallClaudeHooks,
  ClaudeHooksConfigError,
} from "../src/server/hooks/claudeHooks.js";

// Thin CLI wrapper — see bin/install-hooks.ts.
function main() {
  try {
    uninstallClaudeHooks({ settingsPath: claudeSettingsPath() });
  } catch (err) {
    if (err instanceof ClaudeHooksConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

main();
