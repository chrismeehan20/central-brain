import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardCard } from "@shared/types.js";
import {
  createCard,
  deleteCard,
  isBoardColumn,
  moveCard,
  updateCard,
  type BoardStoreLike,
} from "./board.js";

const NOW = Date.parse("2026-08-21T12:00:00Z");

function memStore(cards: BoardCard[] = []): BoardStoreLike & { writes: number } {
  const store = {
    data: { cards },
    writes: 0,
    async write() {
      store.writes += 1;
    },
  };
  return store;
}

function mk(id: string, column: BoardCard["column"], title = id): BoardCard {
  return {
    id,
    title,
    column,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

/** Deterministic ids for tests: c1, c2, … */
function seq() {
  let n = 0;
  return () => `c${++n}`;
}

test("isBoardColumn accepts the four lanes and nothing else", () => {
  assert.ok(isBoardColumn("inbox"));
  assert.ok(isBoardColumn("done"));
  assert.ok(!isBoardColumn("backlog"));
  assert.ok(!isBoardColumn(undefined));
  assert.ok(!isBoardColumn(3));
});

test("createCard lands at the top of its column and defaults to inbox", async () => {
  const store = memStore([mk("a", "inbox")]);
  const cards = await createCard({ title: "new" }, { store, now: NOW, id: seq() });
  assert.equal(cards[0].title, "new");
  assert.equal(cards[0].column, "inbox");
  assert.equal(cards[1].id, "a");
  assert.equal(store.writes, 1);
});

test("createCard straight into done stamps doneAt", async () => {
  const store = memStore();
  const cards = await createCard({ title: "x", column: "done" }, { store, now: NOW, id: seq() });
  assert.equal(cards[0].doneAt, new Date(NOW).toISOString());
});

test("createCard drops empty optional fields rather than storing them", async () => {
  const store = memStore();
  const cards = await createCard({ title: "x", note: "", projectPath: "" }, { store, now: NOW, id: seq() });
  assert.ok(!("note" in cards[0]));
  assert.ok(!("projectPath" in cards[0]));
});

test("updateCard patches fields; empty note and null projectPath clear them", async () => {
  const store = memStore([{ ...mk("a", "inbox"), note: "old", projectPath: "/p" }]);
  const cards = await updateCard("a", { title: "renamed", note: "", projectPath: null }, { store, now: NOW });
  assert.ok(cards);
  assert.equal(cards[0].title, "renamed");
  assert.ok(!("note" in cards[0]));
  assert.ok(!("projectPath" in cards[0]));
});

test("updateCard on a missing id returns null and writes nothing", async () => {
  const store = memStore([mk("a", "inbox")]);
  assert.equal(await updateCard("ghost", { title: "x" }, { store, now: NOW }), null);
  assert.equal(store.writes, 0);
});

test("moveCard reorders within a column", async () => {
  const store = memStore([mk("a", "inbox"), mk("b", "inbox"), mk("c", "inbox")]);
  // Drop "c" at rank 0: the index counts the column without the moving card.
  const cards = await moveCard("c", "inbox", 0, { store, now: NOW });
  assert.deepEqual(cards!.map((c) => c.id), ["c", "a", "b"]);
});

test("moveCard across columns inserts among the target column's siblings", async () => {
  const store = memStore([mk("a", "inbox"), mk("x", "next"), mk("y", "next"), mk("b", "inbox")]);
  const cards = await moveCard("a", "next", 1, { store, now: NOW });
  assert.equal(cards![1].id, "a");
  assert.equal(cards![1].column, "next");
  // Column order reads x, a, y; the flat array keeps b where it was.
  const next = cards!.filter((c) => c.column === "next").map((c) => c.id);
  assert.deepEqual(next, ["x", "a", "y"]);
});

test("moveCard past the end appends beside the column's last card, not the array tail", async () => {
  const store = memStore([mk("x", "next"), mk("b", "inbox")]);
  const cards = await moveCard("b", "next", 99, { store, now: NOW });
  // "b" must sit directly after "x", its only sibling.
  assert.deepEqual(cards!.map((c) => c.id), ["x", "b"]);
});

test("moveCard into an empty column still works", async () => {
  const store = memStore([mk("a", "inbox")]);
  const cards = await moveCard("a", "doing", 0, { store, now: NOW });
  assert.equal(cards![0].column, "doing");
});

test("moveCard stamps doneAt on entry, keeps it on reorder, clears it on exit", async () => {
  const store = memStore([mk("a", "doing"), { ...mk("b", "done"), doneAt: "2026-01-01T00:00:00.000Z" }]);
  const entered = await moveCard("a", "done", 0, { store, now: NOW });
  const a = entered!.find((c) => c.id === "a")!;
  assert.equal(a.doneAt, new Date(NOW).toISOString());

  const reordered = await moveCard("b", "done", 0, { store, now: NOW + 1000 });
  assert.equal(reordered!.find((c) => c.id === "b")!.doneAt, "2026-01-01T00:00:00.000Z");

  const exited = await moveCard("a", "doing", 0, { store, now: NOW + 2000 });
  assert.ok(!("doneAt" in exited!.find((c) => c.id === "a")!));
});

test("moveCard on a missing id returns null", async () => {
  const store = memStore();
  assert.equal(await moveCard("ghost", "inbox", 0, { store, now: NOW }), null);
});

test("deleteCard removes; a second delete returns null", async () => {
  const store = memStore([mk("a", "inbox")]);
  const cards = await deleteCard("a", { store });
  assert.deepEqual(cards, []);
  assert.equal(await deleteCard("a", { store }), null);
});
