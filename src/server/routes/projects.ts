import type { FastifyInstance } from "fastify";
import type { Override, Project } from "@shared/types.js";
import { runScan, getCachedProjects, getLastScanAt } from "../scan/index.js";
import { overridesDb } from "../store/db.js";
import { getGithubStatus } from "../poll/githubPoller.js";
import { getCachedSummary, getOrGenerateSummary } from "../ai/summarize.js";
import { getCachedDetail } from "../ai/detail.js";
import { getCachedDigest, getOrGenerateDigest } from "../ai/digest.js";

interface OverrideBody {
  path: string;
  override: Partial<Override>;
}

interface SummarizeBody {
  path: string;
}

function withExtras(projects: Project[]): Project[] {
  return projects.map((p) => ({
    ...p,
    github: getGithubStatus(p.path),
    summary: getCachedSummary(p.path),
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

    const projects = runScan();
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
      return { error: "AI summaries unavailable — set ANTHROPIC_API_KEY to enable." };
    }
    if (summary.lastError && !summary.text) {
      // Nothing usable to show — surface the real failure instead of a silent stale cache.
      reply.code(502);
      return { error: summary.lastError };
    }
    return { summary };
  });

  app.get("/api/digest", async () => ({ digest: getCachedDigest() }));

  app.post("/api/digest/refresh", async (_req, reply) => {
    const digest = await getOrGenerateDigest(true);
    if (!digest) {
      reply.code(503);
      return { error: "Digest unavailable — set ANTHROPIC_API_KEY, or wait for some activity." };
    }
    return { digest };
  });
}
