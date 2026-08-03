import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project } from "@shared/types";
import {
  ACTIVE_WINDOW_DAYS,
  CHIPS,
  type ChipId,
  compareDashboard,
  isActive,
  matchesChips,
  needsAttention,
  partitionDashboard,
} from "./sections";

const NOW = new Date("2026-08-03T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function mk(partial: Partial<Project> = {}): Project {
  return {
    path: partial.path ?? "/Users/someone/code/widget",
    displayName: "widget",
    discovered: false,
    hidden: false,
    pinned: false,
    missing: false,
    lastActivity: daysAgo(1),
    sessions: [],
    markdown: [],
    ...partial,
  };
}

function pr(overrides: Partial<{ isDraft: boolean; ciStatus: string }> = {}) {
  return {
    number: 7,
    title: "Fix the thing",
    state: "open",
    isDraft: overrides.isDraft ?? false,
    ...(overrides.ciStatus === undefined ? {} : { ciStatus: overrides.ciStatus }),
  };
}

function paths(projects: Project[]): string[] {
  return projects.map((p) => p.path);
}

test("the active window is 14 days", () => {
  assert.equal(ACTIVE_WINDOW_DAYS, 14);
});

test("needsAttention: red branch CI", () => {
  assert.equal(needsAttention(mk({ github: { ciStatus: "failure" } })), true);
  assert.equal(needsAttention(mk({ github: { ciStatus: "success" } })), false);
  assert.equal(needsAttention(mk({ github: { ciStatus: "pending" } })), false);
  assert.equal(needsAttention(mk()), false);
});

test("needsAttention: legacy uppercase FAILURE is still detected", () => {
  assert.equal(needsAttention(mk({ github: { ciStatus: "FAILURE" } })), true);
  assert.equal(
    needsAttention(mk({ github: { openPrs: [pr({ ciStatus: "FAILURE" })] } })),
    true
  );
});

test("needsAttention: a failing draft PR does not count, a failing real PR does", () => {
  assert.equal(
    needsAttention(mk({ github: { openPrs: [pr({ isDraft: true, ciStatus: "failure" })] } })),
    false
  );
  assert.equal(
    needsAttention(mk({ github: { openPrs: [pr({ isDraft: false, ciStatus: "failure" })] } })),
    true
  );
});

test("needsAttention: green and check-less PRs are quiet", () => {
  assert.equal(needsAttention(mk({ github: { openPrs: [pr({ ciStatus: "success" })] } })), false);
  assert.equal(needsAttention(mk({ github: { openPrs: [pr()] } })), false);
  assert.equal(needsAttention(mk({ github: { openPrs: [] } })), false);
});

test("isActive: a pinned project stays active however ancient", () => {
  assert.equal(isActive(mk({ pinned: true, lastActivity: daysAgo(900) }), NOW), true);
  assert.equal(isActive(mk({ pinned: true, lastActivity: undefined }), NOW), true);
});

test("isActive: red CI drags a date-dormant project back into Active", () => {
  const stale = mk({ lastActivity: daysAgo(120), github: { ciStatus: "failure" } });
  assert.equal(isActive(stale, NOW), true);
  const stalePr = mk({ lastActivity: daysAgo(120), github: { openPrs: [pr({ ciStatus: "failure" })] } });
  assert.equal(isActive(stalePr, NOW), true);
});

test("isActive: the boundary sits between 13 and 15 days", () => {
  assert.equal(isActive(mk({ lastActivity: daysAgo(13) }), NOW), true);
  assert.equal(isActive(mk({ lastActivity: daysAgo(15) }), NOW), false);
});

test("isActive: no recorded activity is dormant unless pinned or broken", () => {
  assert.equal(isActive(mk({ lastActivity: undefined }), NOW), false);
  assert.equal(isActive(mk({ lastActivity: "not a date" }), NOW), false);
});

test("partitionDashboard: missing wins over active, even when pinned", () => {
  const gone = mk({ path: "/gone", missing: true, pinned: true, lastActivity: daysAgo(0) });
  const { active, dormant, missing, hidden } = partitionDashboard([gone], NOW);
  assert.deepEqual(paths(missing), ["/gone"]);
  assert.deepEqual(paths(active), []);
  assert.deepEqual(paths(dormant), []);
  assert.deepEqual(paths(hidden), []);
});

test("partitionDashboard: hidden beats missing", () => {
  const both = mk({ path: "/both", hidden: true, missing: true });
  const { missing, hidden } = partitionDashboard([both], NOW);
  assert.deepEqual(paths(hidden), ["/both"]);
  assert.deepEqual(paths(missing), []);
});

test("partitionDashboard: splits visible projects by activity", () => {
  const fresh = mk({ path: "/fresh", lastActivity: daysAgo(2) });
  const stale = mk({ path: "/stale", lastActivity: daysAgo(60) });
  const { active, dormant } = partitionDashboard([stale, fresh], NOW);
  assert.deepEqual(paths(active), ["/fresh"]);
  assert.deepEqual(paths(dormant), ["/stale"]);
});

test("partitionDashboard: every bucket comes out sorted", () => {
  const projects = [
    mk({ path: "/dormant-old", lastActivity: daysAgo(400) }),
    mk({ path: "/dormant-newer", lastActivity: daysAgo(20) }),
    mk({ path: "/active-old", lastActivity: daysAgo(10) }),
    mk({ path: "/active-pinned", lastActivity: daysAgo(300), pinned: true }),
    mk({ path: "/active-new", lastActivity: daysAgo(1) }),
    mk({ path: "/missing-old", missing: true, lastActivity: daysAgo(50) }),
    mk({ path: "/missing-new", missing: true, lastActivity: daysAgo(3) }),
    mk({ path: "/hidden-old", hidden: true, lastActivity: daysAgo(70) }),
    mk({ path: "/hidden-new", hidden: true, lastActivity: daysAgo(4) }),
  ];
  const { active, dormant, missing, hidden } = partitionDashboard(projects, NOW);
  assert.deepEqual(paths(active), ["/active-pinned", "/active-new", "/active-old"]);
  assert.deepEqual(paths(dormant), ["/dormant-newer", "/dormant-old"]);
  assert.deepEqual(paths(missing), ["/missing-new", "/missing-old"]);
  assert.deepEqual(paths(hidden), ["/hidden-new", "/hidden-old"]);
});

test("compareDashboard: pinned outranks attention outranks recency", () => {
  const pinnedAncient = mk({ path: "/pinned", pinned: true, lastActivity: daysAgo(500) });
  const broken = mk({ path: "/broken", lastActivity: daysAgo(90), github: { ciStatus: "failure" } });
  const newest = mk({ path: "/newest", lastActivity: daysAgo(0) });
  const older = mk({ path: "/older", lastActivity: daysAgo(5) });
  const sorted = [older, newest, broken, pinnedAncient].sort(compareDashboard);
  assert.deepEqual(paths(sorted), ["/pinned", "/broken", "/newest", "/older"]);
});

test("compareDashboard: pairwise sign is symmetric", () => {
  const a = mk({ path: "/a", lastActivity: daysAgo(1) });
  const b = mk({ path: "/b", lastActivity: daysAgo(2) });
  assert.ok(compareDashboard(a, b) < 0);
  assert.ok(compareDashboard(b, a) > 0);
  assert.equal(compareDashboard(a, a), 0);
});

test("matchesChips: an empty set matches everything", () => {
  const none = new Set<ChipId>();
  assert.equal(matchesChips(mk(), none), true);
  assert.equal(matchesChips(mk({ discovered: true, github: { dirty: true } }), none), true);
});

test("matchesChips: each chip on its own", () => {
  assert.equal(matchesChips(mk({ github: { ciStatus: "failure" } }), new Set<ChipId>(["attention"])), true);
  assert.equal(matchesChips(mk(), new Set<ChipId>(["attention"])), false);
  assert.equal(matchesChips(mk({ github: { dirty: true } }), new Set<ChipId>(["dirty"])), true);
  assert.equal(matchesChips(mk({ github: { dirty: false } }), new Set<ChipId>(["dirty"])), false);
  assert.equal(matchesChips(mk(), new Set<ChipId>(["dirty"])), false);
  assert.equal(matchesChips(mk({ github: { ciStatus: "FAILURE" } }), new Set<ChipId>(["ci"])), true);
  assert.equal(matchesChips(mk({ github: { ciStatus: "pending" } }), new Set<ChipId>(["ci"])), false);
});

test("matchesChips: the new chip tracks `discovered`", () => {
  assert.equal(matchesChips(mk({ discovered: true }), new Set<ChipId>(["new"])), true);
  assert.equal(matchesChips(mk({ discovered: false }), new Set<ChipId>(["new"])), false);
});

test("matchesChips: two chips AND together", () => {
  const chips = new Set<ChipId>(["dirty", "new"]);
  assert.equal(matchesChips(mk({ discovered: true, github: { dirty: true } }), chips), true);
  // Matches only one of the two — AND means it's out.
  assert.equal(matchesChips(mk({ discovered: true, github: { dirty: false } }), chips), false);
  assert.equal(matchesChips(mk({ discovered: false, github: { dirty: true } }), chips), false);
});

test("matchesChips: a PR-only failure satisfies attention but not the branch-CI chip", () => {
  const prRed = mk({ github: { openPrs: [pr({ ciStatus: "failure" })] } });
  assert.equal(matchesChips(prRed, new Set<ChipId>(["attention"])), true);
  assert.equal(matchesChips(prRed, new Set<ChipId>(["ci"])), false);
});

test("CHIPS covers every ChipId exactly once, with a label and a title", () => {
  const ids = CHIPS.map((c) => c.id);
  assert.deepEqual(ids, ["attention", "dirty", "ci", "new"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    CHIPS.map((c) => c.label),
    ["Attention", "Dirty", "CI red", "New"]
  );
  for (const chip of CHIPS) assert.ok(chip.title.length > 0, `${chip.id} needs a title`);
});

test("a red sibling checkout makes the card need attention", () => {
  const p = mk({
    checkouts: [
      { path: "/a", primary: true, sessionCount: 1 },
      { path: "/b", primary: false, sessionCount: 1, ciStatus: "failure" },
    ],
  });
  assert.equal(needsAttention(p), true);
});

test("a clean sibling checkout does not", () => {
  const p = mk({
    checkouts: [
      { path: "/a", primary: true, sessionCount: 1 },
      { path: "/b", primary: false, sessionCount: 1, ciStatus: "success", dirty: true },
    ],
  });
  assert.equal(needsAttention(p), false);
});
