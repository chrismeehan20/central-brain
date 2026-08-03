import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { MissingProjectTriage, Override, Project } from "@shared/types.js";
import { runScan, getCachedProjects, getLastScanAt, applyOverrideToCache } from "../scan/index.js";
import { deriveSearchRoots, findRelocations } from "../scan/relocate.js";
import { relocateProject, undoRelocation } from "../store/relocation.js";
import { overridesDb } from "../store/db.js";
import { getGithubStatus } from "../poll/githubPoller.js";
import { getCachedSummary, getOrGenerateSummary } from "../ai/summarize.js";
import { getCachedDetail } from "../ai/detail.js";
import { digestQuietState, getCachedDigest, getOrGenerateDigest } from "../ai/digest.js";

interface OverrideBody {
  path: string;
  override: Partial<Override>;
}

interface SummarizeBody {
  path: string;
}

interface RelocateBody {
  from: string;
  /** Absolute path the project moved to, or null to undo a relocation. */
  to: string | null;
}

function withExtras(projects: Project[]): Project[] {
  return projects.map((p) => ({
    ...p,
    github: getGithubStatus(p.path),
    summary: getCachedSummary(p.path),
    // Each folded checkout carries its own git facts — the poller polls
    // sibling paths precisely so the card can't claim health it doesn't have.
    ...(p.checkouts
      ? {
          checkouts: p.checkouts.map((c) => {
            const gh = getGithubStatus(c.path);
            return {
              ...c,
              ...(gh?.dirty !== undefined ? { dirty: gh.dirty } : {}),
              ...(gh?.ciStatus ? { ciStatus: gh.ciStatus } : {}),
              ...(!c.branch && gh?.branch ? { branch: gh.branch } : {}),
            };
          }),
        }
      : {}),
    // Open detail-item texts ride along so dashboard search can match todos.
    openItems: (getCachedDetail(p.path)?.items ?? [])
      .filter((i) => i.status === "open")
      .map((i) => i.text),
  }));
}

export async function projectsRoutes(app: FastifyInstance) {
  app.get("/api/projects", async () => {
    if (!getLastScanAt()) runScan();
    return { projects: withExtras(getCachedProjects()), lastScanAt: getLastScanAt() };
  });

  app.post("/api/scan", async () => {
    const projects = runScan();
    return { projects: withExtras(projects), lastScanAt: getLastScanAt() };
  });

  app.put<{ Body: OverrideBody }>("/api/overrides", async (req, reply) => {
    const { path: projectPath, override } = req.body ?? {};
    if (!projectPath || typeof projectPath !== "string") {
      reply.code(400);
      return { error: "path is required" };
    }

    const existing = overridesDb.data[projectPath] ?? {};
    overridesDb.data[projectPath] = { ...existing, ...override };
    await overridesDb.write();

    // Patch the cache in place — a full rescan here made Hide/Unhide/Pin
    // feel stalled for seconds.
    const projects = applyOverrideToCache(projectPath, overridesDb.data[projectPath]);
    return { projects: withExtras(projects) };
  });

  app.post<{ Body: SummarizeBody }>("/api/projects/summarize", async (req, reply) => {
    const { path: projectPath } = req.body ?? {};
    const project = getCachedProjects().find((p) => p.path === projectPath);
    if (!project) {
      reply.code(404);
      return { error: "project not found" };
    }

    const summary = await getOrGenerateSummary(project, true);
    if (!summary) {
      reply.code(503);
      return { error: "AI summaries unavailable — add your Anthropic API key in Settings to enable them." };
    }
    if (summary.lastError && !summary.text) {
      // Nothing usable to show — surface the real failure instead of a silent stale cache.
      reply.code(502);
      return { error: summary.lastError };
    }
    return { summary };
  });

  /**
   * Relocation candidates for every project whose folder has gone missing.
   *
   * Kept off `/api/projects` because it walks the filesystem: the dashboard
   * polls projects every 30s, and this only matters when something is missing.
   */
  app.get("/api/projects/relocations", async () => {
    const projects = getCachedProjects().filter((p) => !p.hidden);
    const missing = projects.filter((p) => p.missing);
    const roots = deriveSearchRoots({ livePaths: projects.filter((p) => !p.missing).map((p) => p.path) });
    const candidates = findRelocations({ missingPaths: missing.map((p) => p.path), roots });

    const triage: MissingProjectTriage[] = missing.map((p) => ({
      path: p.path,
      displayName: p.displayName,
      candidates: candidates[p.path] ?? [],
    }));
    return { missing: triage, searchedRoots: roots };
  });

  app.post<{ Body: RelocateBody }>("/api/projects/relocate", async (req, reply) => {
    const { from, to } = req.body ?? {};
    if (!from || typeof from !== "string") {
      reply.code(400);
      return { error: "from is required" };
    }

    if (to === null) {
      await undoRelocation(from);
    } else {
      if (typeof to !== "string" || !to) {
        reply.code(400);
        return { error: "to must be an absolute path, or null to undo" };
      }
      if (to === from) {
        reply.code(400);
        return { error: "a project cannot be relocated to itself" };
      }
      if (!fs.existsSync(to)) {
        reply.code(400);
        return { error: `${to} does not exist` };
      }
      await relocateProject(from, to);
    }

    // Full rescan: relocating re-keys sessions and merges two cards into one,
    // which the in-place cache patch used by overrides cannot express.
    return { projects: withExtras(runScan()), lastScanAt: getLastScanAt() };
  });

  /**
   * `noActivity` is the deterministic quiet state: no digest *and* nothing to
   * digest. The client renders a fixed line for it rather than leaving a stale
   * paragraph — or an AI apology — on screen.
   */
  app.get("/api/digest", async () => {
    const digest = getCachedDigest();
    return digest ? { digest } : { digest: null, noActivity: digestQuietState() };
  });

  app.post("/api/digest/refresh", async (_req, reply) => {
    const digest = await getOrGenerateDigest(true);
    if (digest) return { digest };
    if (digestQuietState()) return { digest: null, noActivity: true };
    reply.code(503);
    return { error: "Digest unavailable — add your Anthropic API key in Settings, or wait for some activity." };
  });
}
