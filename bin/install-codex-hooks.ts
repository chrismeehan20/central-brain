#!/usr/bin/env node
import {
  codexHooksPath,
  installCodexHooks,
  CodexHooksConfigError,
} from "../src/server/hooks/codexHooks.js";

// Logic lives in src/server/hooks/codexHooks.ts so it can be exercised against
// a temp fixture in tests; this script is the thin CLI wrapper.
function main() {
  try {
    installCodexHooks({ hooksPath: codexHooksPath() });
  } catch (err) {
    if (err instanceof CodexHooksConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

main();
