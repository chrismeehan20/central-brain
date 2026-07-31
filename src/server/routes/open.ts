import type { FastifyInstance } from "fastify";
import { runScan, getCachedProjects, getLastScanAt } from "../scan/index.js";
import { getAttentionItems } from "../alert/attention.js";
import { launch, resolveOpenAction } from "../open/launch.js";
import { getPreferences } from "../store/db.js";
import { EDITORS } from "@shared/types.js";

interface OpenBody {
  projectPath: string;
  /** When present, open the specific chat (routed by tool/entrypoint) instead of just the folder. */
  sessionId?: string;
}

export async function openRoutes(app: FastifyInstance) {
  app.post<{ Body: OpenBody }>("/api/open", async (req, reply) => {
    if (!getLastScanAt()) runScan();
    const editor = getPreferences().editor;
    const action = resolveOpenAction(getCachedProjects(), getAttentionItems(), req.body, { editor });
    if ("error" in action) {
      reply.code(action.error.status);
      return { error: action.error.message };
    }

    try {
      await launch(action);
    } catch (err) {
      app.log.error({ err }, "open failed");
      reply.code(500);
      return {
        error:
          action.kind === "terminal-resume"
            ? "Couldn't open Terminal to resume the chat."
            : `Couldn't launch ${EDITORS[editor].label} — is it installed?`,
      };
    }
    return { ok: true, kind: action.kind, ...(action.note ? { note: action.note } : {}) };
  });
}
