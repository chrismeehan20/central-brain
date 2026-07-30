#!/usr/bin/env node
import {
  codexHooksPath,
  uninstallCodexHooks,
  CodexHooksConfigError,
} from "../src/server/hooks/codexHooks.js";

function main() {
  try {
    uninstallCodexHooks({ hooksPath: codexHooksPath() });
  } catch (err) {
    if (err instanceof CodexHooksConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

main();
