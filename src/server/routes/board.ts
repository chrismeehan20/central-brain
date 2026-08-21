import type { FastifyInstance } from "fastify";
import {
  createCard,
  deleteCard,
  getBoardCards,
  isBoardColumn,
  moveCard,
  updateCard,
} from "../board/board.js";

/** Card titles and notes are user text shown back to the user only; the one hard rule is "not empty, not absurd". */
const MAX_TITLE = 300;
const MAX_NOTE = 5000;

interface CreateBody {
  title?: unknown;
  note?: unknown;
  projectPath?: unknown;
  column?: unknown;
}

interface PatchBody {
  id?: unknown;
  title?: unknown;
  note?: unknown;
  projectPath?: unknown;
}

interface MoveBody {
  id?: unknown;
  column?: unknown;
  index?: unknown;
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TITLE) return null;
  return trimmed;
}

export async function boardRoutes(app: FastifyInstance) {
  app.get("/api/board", async () => ({ cards: getBoardCards() }));

  app.post<{ Body: CreateBody }>("/api/board/card", async (req, reply) => {
    const title = cleanTitle(req.body?.title);
    if (!title) {
      reply.code(400);
      return { error: "title is required" };
    }
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, MAX_NOTE) : undefined;
    const projectPath = typeof req.body?.projectPath === "string" ? req.body.projectPath : undefined;
    const column = isBoardColumn(req.body?.column) ? req.body.column : undefined;
    const cards = await createCard({
      title,
      ...(note ? { note } : {}),
      ...(projectPath ? { projectPath } : {}),
      ...(column ? { column } : {}),
    });
    return { cards };
  });

  app.patch<{ Body: PatchBody }>("/api/board/card", async (req, reply) => {
    const id = req.body?.id;
    if (typeof id !== "string" || !id) {
      reply.code(400);
      return { error: "id is required" };
    }
    const patch: Parameters<typeof updateCard>[1] = {};
    if (req.body?.title !== undefined) {
      const title = cleanTitle(req.body.title);
      if (!title) {
        reply.code(400);
        return { error: "title cannot be empty" };
      }
      patch.title = title;
    }
    if (req.body?.note !== undefined) {
      if (typeof req.body.note !== "string") {
        reply.code(400);
        return { error: "note must be a string" };
      }
      patch.note = req.body.note.slice(0, MAX_NOTE);
    }
    // `projectPath: null` unlinks; a string relinks. Anything else is a shape error.
    if (req.body?.projectPath !== undefined) {
      if (req.body.projectPath !== null && typeof req.body.projectPath !== "string") {
        reply.code(400);
        return { error: "projectPath must be a string or null" };
      }
      patch.projectPath = req.body.projectPath;
    }
    const cards = await updateCard(id, patch);
    if (!cards) {
      reply.code(404);
      return { error: "no card with that id" };
    }
    return { cards };
  });

  app.post<{ Body: MoveBody }>("/api/board/move", async (req, reply) => {
    const id = req.body?.id;
    if (typeof id !== "string" || !id) {
      reply.code(400);
      return { error: "id is required" };
    }
    const column = req.body?.column;
    if (!isBoardColumn(column)) {
      reply.code(400);
      return { error: "unknown column" };
    }
    const index = Number(req.body?.index);
    if (!Number.isFinite(index)) {
      reply.code(400);
      return { error: "index is required" };
    }
    const cards = await moveCard(id, column, index);
    if (!cards) {
      reply.code(404);
      return { error: "no card with that id" };
    }
    return { cards };
  });

  // Id in the body, matching the attention mutations: uniform client code, and
  // no URL-encoding questions for ids in path segments.
  app.post<{ Body: { id?: unknown } }>("/api/board/delete", async (req, reply) => {
    const id = req.body?.id;
    if (typeof id !== "string" || !id) {
      reply.code(400);
      return { error: "id is required" };
    }
    const cards = await deleteCard(id);
    if (!cards) {
      reply.code(404);
      return { error: "no card with that id" };
    }
    return { cards };
  });
}
