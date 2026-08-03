import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Project, SessionRef } from "@shared/types.js";
import { groupProjectsByRepo } from "./resolveProject.js";
import type { RepoIdentity } from "./repoIdentity.js";

function session(id: string, lastActivity: string): SessionRef {
  return { tool: "claude", sessionId: id, lastActivity };
}

function project(path: string, overrides: Partial<Project> = {}): Project {
  const sessions = overrides.sessions ?? [session(`${path}-s1`, "2026-08-01T00:00:00Z")];
  return {
    path,
    displayName: path.split("/").pop() ?? path,
    discovered: true,
    hidden: false,
    pinned: false,
    missing: false,
    sessions,
    lastActivity: sessions[0]?.lastActivity,
    markdown: [],
    ...overrides,
  };
}

function identities(map: Record<string, Partial<RepoIdentity>>): (p: string) => RepoIdentity {
  return (p) => ({ repoKey: null, isMainWorktree: false, ...map[p] });
}

test("checkouts of one repo fold into a single card with merged sessions", () => {
  const main = project("/code/app", {
    sessions: [session("a", "2026-07-01T00:00:00Z")],
  });
  const wt = project("/code/app-v2", {
    sessions: [session("b", "2026-08-02T00:00:00Z")],
  });
  const result = groupProjectsByRepo(
    [main, wt],
    identities({
      "/code/app": { repoKey: "remote:github.com/u/app", isMainWorktree: true, branch: "main" },
      "/code/app-v2": { repoKey: "remote:github.com/u/app", branch: "redesign" },
    })
  );

  assert.equal(result.length, 1);
  const card = result[0];
  // Main worktree is primary even though the worktree is more recent.
  assert.equal(card.path, "/code/app");
  assert.equal(card.sessions.length, 2);
  assert.equal(card.lastActivity, "2026-08-02T00:00:00Z"); // covers the whole set
  assert.equal(card.sessions[0].sessionId, "b"); // merged, most recent first
  assert.equal(card.checkouts?.length, 2);
  assert.equal(card.checkouts?.[0].path, "/code/app"); // primary first
  assert.equal(card.checkouts?.[0].primary, true);
  assert.equal(card.checkouts?.[1].branch, "redesign");
  assert.equal(card.checkouts?.[1].sessionCount, 1);
});

test("without a main worktree, the most recently active member is primary", () => {
  const older = project("/code/clone-a", { sessions: [session("a", "2026-07-01T00:00:00Z")] });
  const newer = project("/code/clone-b", { sessions: [session("b", "2026-08-01T00:00:00Z")] });
  const result = groupProjectsByRepo(
    [older, newer],
    identities({
      "/code/clone-a": { repoKey: "remote:github.com/u/x" },
      "/code/clone-b": { repoKey: "remote:github.com/u/x" },
    })
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "/code/clone-b");
});

test("solo projects pass through untouched, with no checkouts field", () => {
  const solo = project("/code/solo");
  const [result] = groupProjectsByRepo([solo], identities({ "/code/solo": { repoKey: "remote:github.com/u/solo" } }));
  assert.equal(result, solo);
  assert.equal(result.checkouts, undefined);
});

test("missing projects are never probed and never grouped", () => {
  const gone = project("/old/app", { missing: true });
  const live = project("/code/app");
  let probedMissing = false;
  const result = groupProjectsByRepo([gone, live], (p) => {
    if (p === "/old/app") probedMissing = true;
    return { repoKey: "remote:github.com/u/app", isMainWorktree: p === "/code/app" };
  });
  assert.equal(probedMissing, false);
  // The missing card stays separate for the relocation flow.
  assert.equal(result.length, 2);
});

test("projects without a repo identity stay separate even with equal keys elsewhere", () => {
  const a = project("/code/a");
  const b = project("/code/b");
  const result = groupProjectsByRepo([a, b], identities({}));
  assert.equal(result.length, 2);
});

test("the primary's name, overrides and docs win; its identity fields survive the merge", () => {
  const main = project("/code/app", {
    displayName: "My App",
    pinned: true,
    sessions: [session("a", "2026-07-01T00:00:00Z")],
  });
  const wt = project("/code/app-old", {
    displayName: "app-old",
    sessions: [session("b", "2026-06-01T00:00:00Z")],
  });
  const [card] = groupProjectsByRepo(
    [main, wt],
    identities({
      "/code/app": { repoKey: "main:/code/app", isMainWorktree: true },
      "/code/app-old": { repoKey: "main:/code/app" },
    })
  );
  assert.equal(card.displayName, "My App");
  assert.equal(card.pinned, true);
});

test("sibling checkouts' sessions are stamped with their source path; the primary's are not", () => {
  const main = project("/code/app", { sessions: [session("a", "2026-07-01T00:00:00Z")] });
  const wt = project("/code/app-v2", { sessions: [session("b", "2026-08-02T00:00:00Z")] });
  const [card] = groupProjectsByRepo(
    [main, wt],
    identities({
      "/code/app": { repoKey: "remote:github.com/u/app", isMainWorktree: true },
      "/code/app-v2": { repoKey: "remote:github.com/u/app" },
    })
  );
  const fromWt = card.sessions.find((s) => s.sessionId === "b");
  const fromMain = card.sessions.find((s) => s.sessionId === "a");
  assert.equal(fromWt?.checkoutPath, "/code/app-v2");
  assert.equal(fromMain?.checkoutPath, undefined);
});

test("among several standalone clones (all main worktrees), the most recent wins", () => {
  const older = project("/code/clone-old", { sessions: [session("a", "2026-07-01T00:00:00Z")] });
  const newer = project("/code/clone-new", { sessions: [session("b", "2026-08-01T00:00:00Z")] });
  const result = groupProjectsByRepo(
    [older, newer], // scan order puts the older one first
    identities({
      "/code/clone-old": { repoKey: "remote:github.com/u/x", isMainWorktree: true },
      "/code/clone-new": { repoKey: "remote:github.com/u/x", isMainWorktree: true },
    })
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "/code/clone-new");
});
