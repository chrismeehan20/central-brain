import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardCard, Project } from "@shared/types.js";
import {
  appleScriptQuote,
  buildTerminalScript,
  composeDispatchPrompt,
  resolveDispatch,
  shellQuote,
  slugify,
} from "./dispatch.js";

function card(partial: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "c1",
    title: "Fix the retry logic",
    column: "next",
    createdAt: "",
    updatedAt: "",
    projectPath: "/dev/atlas",
    ...partial,
  };
}

function project(partial: Partial<Project> = {}): Project {
  return {
    path: "/dev/atlas",
    displayName: "atlas",
    discovered: false,
    hidden: false,
    pinned: false,
    missing: false,
    sessions: [],
    markdown: [],
    ...partial,
  };
}

test("slugify kebabs, bounds, and never returns empty", () => {
  assert.equal(slugify("Fix the retry logic!"), "fix-the-retry-logic");
  assert.equal(slugify("Ünïcode — & symbols"), "unicode-symbols");
  assert.equal(slugify("!!!"), "card");
  assert.ok(slugify("x".repeat(100)).length <= 40);
});

test("the prompt carries title, note, and the land-your-work trailer", () => {
  const prompt = composeDispatchPrompt(card({ note: "See docs/retry.md" }));
  assert.match(prompt, /Fix the retry logic/);
  assert.match(prompt, /See docs\/retry\.md/);
  assert.match(prompt, /commit your work/);
  assert.match(prompt, /brain_board_move/);
});

test("resolveDispatch refuses cards without a scanner-known project", () => {
  const noLink = resolveDispatch({ card: card({ projectPath: undefined }), projects: [project()], freshWorktree: false });
  assert.match((noLink as { error: string }).error, /Link this card/);

  const unknown = resolveDispatch({ card: card({ projectPath: "/tmp/evil" }), projects: [project()], freshWorktree: false });
  assert.match((unknown as { error: string }).error, /isn't one the scanner knows/);

  const missing = resolveDispatch({ card: card(), projects: [project({ missing: true })], freshWorktree: false });
  assert.match((missing as { error: string }).error, /missing from disk/);
});

test("resolveDispatch accepts a checkout path folded into a project card", () => {
  const res = resolveDispatch({
    card: card({ projectPath: "/dev/atlas-agents/other" }),
    projects: [
      project({ checkouts: [{ path: "/dev/atlas", primary: true, sessionCount: 1 }, { path: "/dev/atlas-agents/other", primary: false, sessionCount: 1 }] }),
    ],
    freshWorktree: false,
  });
  assert.ok("plan" in res);
});

test("fresh worktree plans a sibling agents dir with an agent/ branch, uniqued on collision", () => {
  const taken = new Set(["/dev/atlas-agents/fix-the-retry-logic"]);
  const res = resolveDispatch({
    card: card(),
    projects: [project()],
    freshWorktree: true,
    exists: (dir) => taken.has(dir),
  });
  assert.ok("plan" in res);
  const plan = (res as { plan: { cwd: string; worktree: { branch: string; repoDir: string } } }).plan;
  assert.equal(plan.cwd, "/dev/atlas-agents/fix-the-retry-logic-2");
  assert.equal(plan.worktree.branch, "agent/fix-the-retry-logic-2");
  assert.equal(plan.worktree.repoDir, "/dev/atlas");
});

test("quoting survives hostile strings at both layers", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(appleScriptQuote('say "hi" \\ there'), '"say \\"hi\\" \\\\ there"');
  // A path with quotes of both kinds still produces one balanced script.
  const script = buildTerminalScript(`/dev/it's "weird"`, "/data/p.md");
  assert.match(script, /tell application "Terminal"/);
  assert.match(script, /claude /);
  // The AppleScript literal must keep its quotes balanced (even count).
  const quoteCount = (script.match(/(?<!\\)"/g) ?? []).length;
  assert.equal(quoteCount % 2, 0);
});

test("performDispatch (simulated mac) cuts the worktree, launches Terminal, stamps the card", async (t) => {
  // The real module-level board store points at the test data dir; seed it.
  const { boardDb } = await import("../store/db.js");
  const { performDispatch } = await import("./dispatch.js");
  boardDb.data.cards = [card({ id: "d1", column: "next" })];
  await boardDb.write();
  t.after(async () => {
    boardDb.data.cards = [];
    await boardDb.write();
  });

  const calls: Array<[string, string[]]> = [];
  const cards = await performDispatch(
    "d1",
    {
      cwd: "/dev/atlas-agents/fix",
      worktree: { repoDir: "/dev/atlas", path: "/dev/atlas-agents/fix", branch: "agent/fix" },
      prompt: "the brief",
    },
    {
      platform: "darwin",
      now: Date.parse("2026-08-21T12:00:00Z"),
      writePrompt: () => "/data/dispatch/d1.md",
      mkdir: () => {},
      run: async (file, args) => {
        calls.push([file, args]);
      },
    },
  );

  assert.deepEqual(calls[0], ["git", ["-C", "/dev/atlas", "worktree", "add", "/dev/atlas-agents/fix", "-b", "agent/fix"]]);
  assert.equal(calls[1][0], "osascript");
  assert.match(calls[1][1][1], /Terminal/);
  assert.match(calls[1][1][1], /claude /);
  const stamped = cards.find((c) => c.id === "d1")!;
  assert.equal(stamped.column, "doing");
  assert.equal(stamped.dispatch?.branch, "agent/fix");
  assert.equal(cards[0].id, "d1"); // top of the board
});

test("performDispatch worktree failure surfaces before any card stamp", async () => {
  const { boardDb } = await import("../store/db.js");
  const { performDispatch } = await import("./dispatch.js");
  boardDb.data.cards = [card({ id: "d2" })];
  await boardDb.write();
  await assert.rejects(
    performDispatch(
      "d2",
      { cwd: "/w", worktree: { repoDir: "/r", path: "/w", branch: "agent/x" }, prompt: "p" },
      { platform: "darwin", writePrompt: () => "/p.md", mkdir: () => {}, run: async () => { throw new Error("boom"); } },
    ),
    /git worktree add failed: boom/,
  );
  assert.equal(boardDb.data.cards.find((c) => c.id === "d2")!.dispatch, undefined);
  boardDb.data.cards = [];
  await boardDb.write();
});
