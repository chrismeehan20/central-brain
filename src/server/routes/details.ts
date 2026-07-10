import type { FastifyInstance } from "fastify";
import type { DetailItemKind } from "@shared/types.js";
import { getCachedProjects } from "../scan/index.js";
import {
  addUserItem,
  ensureDetail,
  getCachedDetail,
  getOrGenerateDetail,
  setNotes,
  updateItem,
} from "../ai/detail.js";

const KINDS: DetailItemKind[] = ["todo", "decision", "pending"];

function findProject(projectPath?: string) {
  if (!projectPath) return undefined;
  return getCachedProjects().find((p) => p.path === projectPath);
}

interface PathBody {
  path: string;
}
interface RefreshBody extends PathBody {
  force?: boolean;
}
interface AddItemBody extends PathBody {
  kind: DetailItemKind;
  text: string;
}
interface UpdateItemBody extends PathBody {
  id: string;
  status?: "open" | "done" | "dismissed";
  text?: string;
  note?: string;
}
interface NotesBody extends PathBody {
  notes: string;
}

export async function detailsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { path?: string } }>("/api/projects/detail", async (req, reply) => {
    const project = findProject(req.query?.path);
    if (!project) {
      reply.code(404);
      return { error: "project not found" };
    }
    return { detail: getCachedDetail(project.path) ?? ensureDetail(project.path) };
  });

  app.post<{ Body: RefreshBody }>("/api/projects/detail/refresh", async (req, reply) => {
    const project = findProject(req.body?.path);
    if (!project) {
      reply.code(404);
      return { error: "project not found" };
    }
    // Manual refresh forces (subject to debounce + daily cap inside the generator).
    const detail = await getOrGenerateDetail(project, req.body?.force !== false);
    return { detail };
  });

  app.post<{ Body: AddItemBody }>("/api/projects/detail/item", async (req, reply) => {
    const { path: projectPath, kind, text } = req.body ?? {};
    if (!findProject(projectPath)) {
      reply.code(404);
      return { error: "project not found" };
    }
    if (!text?.trim() || !KINDS.includes(kind)) {
      reply.code(400);
      return { error: "kind (todo|decision|pending) and text are required" };
    }
    return { detail: await addUserItem(projectPath, kind, text) };
  });

  app.patch<{ Body: UpdateItemBody }>("/api/projects/detail/item", async (req, reply) => {
    const { path: projectPath, id, status, text, note } = req.body ?? {};
    if (!findProject(projectPath)) {
      reply.code(404);
      return { error: "project not found" };
    }
    if (!id) {
      reply.code(400);
      return { error: "id is required" };
    }
    const detail = await updateItem(projectPath, id, { status, text, note });
    if (!detail) {
      reply.code(404);
      return { error: "item not found" };
    }
    return { detail };
  });

  app.put<{ Body: NotesBody }>("/api/projects/detail/notes", async (req, reply) => {
    const { path: projectPath, notes } = req.body ?? {};
    if (!findProject(projectPath)) {
      reply.code(404);
      return { error: "project not found" };
    }
    return { detail: await setNotes(projectPath, notes ?? "") };
  });
}
