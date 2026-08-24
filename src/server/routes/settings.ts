import type { FastifyInstance } from "fastify";
import { apiKeyStatus, clearApiKey, dismissSetup, saveApiKey } from "../ai/apiKey.js";
import { AI_MODEL, callsRemaining, dailyCap } from "../ai/budget.js";
import { getPreferences, updatePreferences } from "../store/db.js";
import { getGhStatus, refreshGhStatus } from "../github/ghBinary.js";
import { DASHBOARD_VIEWS, EDITORS, REPO_SLUG_RE } from "@shared/types.js";
import type { DashboardView } from "@shared/types.js";

interface ApiKeyBody {
  apiKey?: string;
}

interface PreferencesBody {
  notifications?: unknown;
  editor?: unknown;
  remoteRepos?: unknown;
  dashboardView?: unknown;
}

/**
 * Every entry has to be a plain `owner/repo`. This is not cosmetic: the values
 * end up as `gh --repo` arguments, so the check that rejects junk is the same
 * check that keeps anything shell-shaped out of an argv.
 */
function parseRemoteRepos(value: unknown): { repos: string[] } | { error: string } {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    return { error: "remoteRepos must be an array of strings" };
  }
  const repos: string[] = [];
  for (const raw of value as string[]) {
    const slug = raw.trim();
    if (!slug) continue;
    if (!REPO_SLUG_RE.test(slug)) return { error: `not a valid owner/repo: ${slug}` };
    if (!repos.includes(slug)) repos.push(slug);
  }
  return { repos };
}

/**
 * Settings the user can change without a terminal — currently just the
 * Anthropic API key, which is the one thing a packaged app genuinely cannot
 * obtain any other way.
 *
 * The key itself is never sent back to the client: every response carries an
 * `ApiKeyStatus` with a last-4 hint instead. Localhost-only binding is not a
 * reason to hand a live credential to a webview that also renders project text.
 */
export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async () => ({
    apiKey: apiKeyStatus(),
    ai: { model: AI_MODEL, dailyCap: dailyCap(), callsRemaining: callsRemaining() },
    preferences: getPreferences(),
    // Read from the boot-time cache rather than probed per request: this is
    // polled by the panel, and shelling out to `gh auth status` on every poll
    // would be a subprocess per second for an answer that changes when the
    // user installs something.
    github: getGhStatus(),
  }));

  /**
   * Re-resolve `gh` and re-check its login.
   *
   * Exists so installing `gh` or running `gh auth login` costs a button press
   * instead of an app restart — the resolved path is cached for the life of the
   * process, so without this the fix would not take effect until relaunch.
   */
  app.post("/api/settings/github/recheck", async () => ({ github: await refreshGhStatus() }));

  app.put<{ Body: PreferencesBody }>("/api/settings/preferences", async (req, reply) => {
    const { notifications, editor, remoteRepos, dashboardView } = req.body ?? {};
    if (notifications !== undefined && typeof notifications !== "boolean") {
      reply.code(400);
      return { error: "notifications must be a boolean" };
    }
    if (editor !== undefined && (typeof editor !== "string" || !(editor in EDITORS))) {
      reply.code(400);
      return { error: `editor must be one of: ${Object.keys(EDITORS).join(", ")}` };
    }
    let parsedRepos: string[] | undefined;
    if (remoteRepos !== undefined) {
      const parsed = parseRemoteRepos(remoteRepos);
      if ("error" in parsed) {
        reply.code(400);
        return { error: parsed.error };
      }
      parsedRepos = parsed.repos;
    }
    if (
      dashboardView !== undefined &&
      !DASHBOARD_VIEWS.includes(dashboardView as DashboardView)
    ) {
      reply.code(400);
      return { error: `dashboardView must be one of: ${DASHBOARD_VIEWS.join(", ")}` };
    }
    const preferences = await updatePreferences({
      ...(notifications !== undefined ? { notifications } : {}),
      ...(editor !== undefined ? { editor: editor as keyof typeof EDITORS } : {}),
      ...(parsedRepos !== undefined ? { remoteRepos: parsedRepos } : {}),
      ...(dashboardView !== undefined ? { dashboardView: dashboardView as DashboardView } : {}),
    });
    return { preferences };
  });

  app.put<{ Body: ApiKeyBody }>("/api/settings/api-key", async (req, reply) => {
    const apiKey = req.body?.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      reply.code(400);
      return { error: "apiKey is required" };
    }

    const result = await saveApiKey(apiKey);
    if (!result.ok) {
      // 400, not 502: the actionable problem is almost always the pasted value,
      // and the message says so when it was a network failure instead.
      reply.code(400);
      return { error: result.error };
    }
    return { apiKey: result.status };
  });

  app.delete("/api/settings/api-key", async () => ({ apiKey: await clearApiKey() }));

  /** "Skip for now" — the dashboard is fully usable without a key. */
  app.post("/api/settings/dismiss-setup", async () => ({ apiKey: await dismissSetup() }));
}
