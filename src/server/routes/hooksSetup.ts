import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { HooksSetupStatus } from "@shared/types.js";
import {
  ClaudeHooksConfigError,
  claudeHooksInstalled,
  claudeSettingsPath,
  installClaudeHooks,
} from "../hooks/claudeHooks.js";
import {
  buildCodexHookCommand,
  CodexHooksConfigError,
  codexHooksInstalled,
  codexHooksTrusted,
  codexHooksPath,
  installCodexHooks,
} from "../hooks/codexHooks.js";
import { inspectCodexHooks } from "../hooks/codexHooksStatus.js";
import { codexForwarderPath, ForwarderInstallError } from "../hooks/forwarder.js";
import { getHookLiveness } from "../alert/hookLiveness.js";
import { settingsDb, writeSettings } from "../store/db.js";

/**
 * The dashboard-driven hook install. A Releases user has no checkout to run
 * `npm run install-hooks` from, so the app must be able to wire itself into
 * ~/.claude/settings.json and $CODEX_HOME/hooks.json — same shared logic, same
 * append-only guarantees, driven by a button instead of a terminal.
 */

/** Read `$CODEX_HOME/config.toml`, if there is one — used only to spot hooks being switched off. */
function readCodexConfigToml(codexHome: string): string | undefined {
  try {
    return fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
}

export function buildHooksStatus(): HooksSetupStatus {
  const claudePath = claudeSettingsPath();
  const codexPath = codexHooksPath();
  const codexHome = path.dirname(codexPath);
  const claudeLiveness = getHookLiveness("claude");
  const codexLiveness = getHookLiveness("codex");
  const codexDirExists = fs.existsSync(codexHome);
  const diagnosis = inspectCodexHooks({
    codexDirExists,
    codexHome,
    hooksPath: codexPath,
    forwarderPath: codexForwarderPath(),
    command: buildCodexHookCommand(),
    liveness: codexLiveness,
    ...(codexDirExists ? { configToml: readCodexConfigToml(codexHome) } : {}),
  });
  return {
    claude: {
      dirExists: fs.existsSync(path.dirname(claudePath)),
      installed: claudeHooksInstalled(claudePath),
      live: claudeLiveness.live,
      ...(claudeLiveness.lastEventAt ? { lastEventAt: claudeLiveness.lastEventAt } : {}),
    },
    codex: {
      dirExists: codexDirExists,
      installed: codexHooksInstalled(codexPath),
      trusted: codexHooksTrusted(codexPath),
      live: codexLiveness.live,
      ...(codexLiveness.lastEventAt ? { lastEventAt: codexLiveness.lastEventAt } : {}),
      diagnosis,
    },
    setupDismissed: settingsDb.data.hooksSetupDismissed ?? false,
  };
}

export async function hooksSetupRoutes(app: FastifyInstance) {
  app.get("/api/hooks/status", async () => buildHooksStatus());

  app.post<{ Body: { tool?: unknown } }>("/api/hooks/install", async (req, reply) => {
    const tool = req.body?.tool;
    if (tool !== "claude" && tool !== "codex") {
      reply.code(400);
      return { error: 'tool must be "claude" or "codex"' };
    }

    const targetPath = tool === "claude" ? claudeSettingsPath() : codexHooksPath();
    if (!fs.existsSync(path.dirname(targetPath))) {
      reply.code(409);
      return {
        error:
          tool === "claude"
            ? "No ~/.claude directory found — install Claude Code (or run it once) first."
            : "No Codex directory found — install Codex (or run it once) first.",
      };
    }

    try {
      if (tool === "claude") {
        installClaudeHooks({ settingsPath: targetPath, log: (m) => app.log.info(m) });
      } else {
        installCodexHooks({ hooksPath: targetPath, log: (m) => app.log.info(m) });
      }
    } catch (err) {
      if (
        err instanceof ClaudeHooksConfigError ||
        err instanceof CodexHooksConfigError ||
        err instanceof ForwarderInstallError
      ) {
        // The message explains exactly which file is unparseable and why we
        // refused to touch it — that's the actionable part, pass it through.
        reply.code(409);
        return { error: err.message };
      }
      throw err;
    }

    return { status: buildHooksStatus() };
  });

  /** "Later" on the onboarding card — everything works without hooks except push alerts. */
  app.post("/api/hooks/dismiss-setup", async () => {
    settingsDb.data.hooksSetupDismissed = true;
    await writeSettings();
    return { status: buildHooksStatus() };
  });
}
