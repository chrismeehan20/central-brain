import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type { Project } from "@shared/types.js";
import { runScan, getCachedProjects, getLastScanAt } from "../scan/index.js";

const execFileAsync = promisify(execFile);

interface OpenBody {
  projectPath: string;
}

export type OpenResolution = { error: { status: number; message: string } } | { path: string };

/**
 * The client may only open paths the scanner already knows about — the exact
 * cached path, never the raw request string, is what reaches `open`.
 */
export function resolveOpenTarget(projects: Project[], body: unknown): OpenResolution {
  const projectPath = (body as Partial<OpenBody> | null | undefined)?.projectPath;
  if (!projectPath || typeof projectPath !== "string") {
    return { error: { status: 400, message: "projectPath is required" } };
  }
  const project = projects.find((p) => p.path === projectPath);
  if (!project) {
    return { error: { status: 404, message: "project not found" } };
  }
  if (project.missing) {
    return { error: { status: 409, message: "This folder no longer exists on disk." } };
  }
  return { path: project.path };
}

export async function openRoutes(app: FastifyInstance) {
  app.post<{ Body: OpenBody }>("/api/open", async (req, reply) => {
    if (!getLastScanAt()) runScan();
    const resolved = resolveOpenTarget(getCachedProjects(), req.body);
    if ("error" in resolved) {
      reply.code(resolved.error.status);
      return { error: resolved.error.message };
    }

    try {
      await execFileAsync("open", ["-a", "Visual Studio Code", resolved.path]);
    } catch (err) {
      app.log.error({ err }, "open in VS Code failed");
      reply.code(500);
      return { error: "Couldn't launch Visual Studio Code — is it installed?" };
    }
    return { ok: true };
  });
}
