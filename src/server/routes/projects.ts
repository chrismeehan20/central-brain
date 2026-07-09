import type { FastifyInstance } from "fastify";
import type { Override, Project } from "@shared/types.js";
import { runScan, getCachedProjects, getLastScanAt } from "../scan/index.js";
import { overridesDb } from "../store/db.js";
import { getGithubStatus } from "../poll/githubPoller.js";
import { getCachedSummary, getOrGenerateSummary } from "../ai/summarize.js";

interface OverrideBody {
  path: string;
  override: Partial<Override>;
}

interface SummarizeBody {
  path: string;
}

function withExtras(projects: Project[]): Project[] {
  return projects.map((p) => ({ ...p, github: getGithubStatus(p.path), summary: getCachedSummary(p.path) }));
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
    return { summary };
  });
}
