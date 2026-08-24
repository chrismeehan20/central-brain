import type { FastifyInstance } from "fastify";
import { runScan, getCachedProjects, getLastScanAt } from "../scan/index.js";
import { getAttentionItems } from "../alert/attention.js";
import { buildBrowserOpen, launch, resolveOpenAction } from "../open/launch.js";
import { getPreferences } from "../store/db.js";
import { EDITORS } from "@shared/types.js";

interface OpenBody {
  projectPath: string;
  /** When present, open the specific chat (routed by tool/entrypoint) instead of just the folder. */
  sessionId?: string;
}

export async function openRoutes(app: FastifyInstance) {
  /**
   * Open a pull request in the browser. Separate from `/api/open` because the
   * `pr-*` attention rows have no session and no local folder to land in — the
   * work happened in a container that no longer exists, and the PR is the only
   * thing left to point at.
   */
  app.post<{ Body: { url?: unknown } }>("/api/open/url", async (req, reply) => {
    const url = typeof req.body?.url === "string" ? req.body.url : "";
    const step = buildBrowserOpen(url);
    if (!step) {
      reply.code(400);
      return { error: "only https://github.com URLs can be opened" };
    }
    try {
      await launch({ kind: "browser", steps: [step] });
    } catch (err) {
      app.log.error({ err }, "open url failed");
      reply.code(500);
      return { error: "Couldn't open that link." };
    }
    return { ok: true };
  });


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
