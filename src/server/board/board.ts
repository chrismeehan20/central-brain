import { randomUUID } from "node:crypto";
import type { BoardCard, BoardColumnId } from "@shared/types.js";
import { BOARD_COLUMNS } from "@shared/types.js";
import { boardDb } from "../store/db.js";

/** The slice of a lowdb `Low` this module needs — lets tests pass a throwaway store. */
export interface BoardStoreLike {
  data: { cards: BoardCard[] };
  write(): Promise<void>;
}

/**
 * Injection seam, same shape as the attention module's: production passes
 * nothing and gets the module-level lowdb store; tests pass in-memory stubs
 * (and a fixed clock/id) so they never touch data/*.json.
 */
export interface BoardDeps {
  store?: BoardStoreLike;
  now?: number;
  id?: () => string;
}

function resolve(deps: BoardDeps) {
  return {
    store: deps.store ?? boardDb,
    now: deps.now ?? Date.now(),
    id: deps.id ?? randomUUID,
  };
}

export function isBoardColumn(value: unknown): value is BoardColumnId {
  return BOARD_COLUMNS.some((c) => c.id === value);
}

export interface NewCardInput {
  title: string;
  note?: string;
  projectPath?: string;
  column?: BoardColumnId;
}

export async function createCard(input: NewCardInput, deps: BoardDeps = {}): Promise<BoardCard[]> {
  const { store, now, id } = resolve(deps);
  const nowIso = new Date(now).toISOString();
  const column = input.column ?? "inbox";
  const card: BoardCard = {
    id: id(),
    title: input.title,
    ...(input.note ? { note: input.note } : {}),
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
    column,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(column === "done" ? { doneAt: nowIso } : {}),
  };
  // New cards land at the top of their column, not the bottom: the thing you
  // just captured is the thing you're thinking about right now.
  store.data.cards.unshift(card);
  await store.write();
  return store.data.cards;
}

export interface CardPatch {
  title?: string;
  /** Empty string clears the note (the field is dropped, not stored empty). */
  note?: string;
  /** null unlinks the card from its project. */
  projectPath?: string | null;
}

/** Returns null (writing nothing) when the id is gone — a stale tab may edit a deleted card. */
export async function updateCard(
  id: string,
  patch: CardPatch,
  deps: BoardDeps = {},
): Promise<BoardCard[] | null> {
  const { store, now } = resolve(deps);
  const card = store.data.cards.find((c) => c.id === id);
  if (!card) return null;

  if (patch.title !== undefined) card.title = patch.title;
  if (patch.note !== undefined) {
    if (patch.note) card.note = patch.note;
    else delete card.note;
  }
  if (patch.projectPath !== undefined) {
    if (patch.projectPath) card.projectPath = patch.projectPath;
    else delete card.projectPath;
  }
  card.updatedAt = new Date(now).toISOString();

  await store.write();
  return store.data.cards;
}

/**
 * Move a card to `column`, ranked `index` among that column's cards (clamped;
 * past-the-end appends). Pure array surgery on the flat list: remove the card,
 * then splice it back in front of whichever card currently holds the target
 * rank — or after the column's last card, so a card appended to a column sits
 * with its siblings rather than at the tail of the whole array.
 *
 * `index` counts the column WITHOUT the moving card, which is also exactly
 * what a drag-and-drop sees: the drop position among the cards still in place.
 */
export async function moveCard(
  id: string,
  column: BoardColumnId,
  index: number,
  deps: BoardDeps = {},
): Promise<BoardCard[] | null> {
  const { store, now } = resolve(deps);
  const from = store.data.cards.findIndex((c) => c.id === id);
  if (from < 0) return null;

  const nowIso = new Date(now).toISOString();
  const [card] = store.data.cards.splice(from, 1);
  const moved: BoardCard = { ...card, column, updatedAt: nowIso };
  // `doneAt` stamps the transition *into* done — a reorder within done keeps
  // the original stamp so it keeps meaning "when it finished" — and clears on
  // the way out: a card dragged back to "doing" is not done, and a stale stamp
  // would resurface the moment it returned.
  if (column === "done") moved.doneAt = card.doneAt ?? nowIso;
  else delete moved.doneAt;

  const siblings = store.data.cards
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.column === column);
  const clamped = Math.max(0, Math.min(Math.round(index), siblings.length));
  const insertAt =
    clamped < siblings.length
      ? siblings[clamped].i
      : siblings.length > 0
        ? siblings[siblings.length - 1].i + 1
        : store.data.cards.length;
  store.data.cards.splice(insertAt, 0, moved);

  await store.write();
  return store.data.cards;
}

/** Returns null when the id is gone; deleting twice is not an error worth surfacing, but the route 404s it. */
export async function deleteCard(id: string, deps: BoardDeps = {}): Promise<BoardCard[] | null> {
  const { store } = resolve(deps);
  const before = store.data.cards.length;
  store.data.cards = store.data.cards.filter((c) => c.id !== id);
  if (store.data.cards.length === before) return null;
  await store.write();
  return store.data.cards;
}

export function getBoardCards(): BoardCard[] {
  return boardDb.data.cards;
}
