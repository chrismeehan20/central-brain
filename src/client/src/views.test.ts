import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttentionItem, Project } from "@shared/types";
import { flattenOpenPrs, prNeedsAttention, repoSlugFromPrUrl, visibleProjects } from "./views";

const NOW = new Date("2026-08-03T12:00:00.000Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function mk(partial: Partial<Project> = {}): Project {
  return {
    path: partial.path ?? "/Users/someone/code/widget",
    displayName: partial.displayName ?? "widget",
    discovered: false,
    hidden: false,
    pinned: false,
    missing: false,
    lastActivity: minutesAgo(10),
    sessions: [],
    markdown: [],
    ...partial,
  };
}

function pr(partial: Partial<NonNullable<NonNullable<Project["github"]>["openPrs"]>[number]> = {}) {
  return {
    number: 7,
    title: "Fix the thing",
    state: "open",
    isDraft: false,
    url: "https://github.com/acme/widget/pull/7",
    updatedAt: minutesAgo(30),
    ...partial,
  };
}

function attention(partial: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "sess-1:waiting",
    sessionId: "sess-1",
    projectPath: "/Users/someone/code/widget",
    tool: "claude",
    type: "waiting",
    priority: "medium",
    createdAt: minutesAgo(5),
    updatedAt: minutesAgo(5),
    ...partial,
  };
}

test("visibleProjects drops hidden and missing", () => {
  const projects = [
    mk({ path: "/a" }),
    mk({ path: "/b", hidden: true }),
    mk({ path: "/c", missing: true }),
  ];
  assert.deepEqual(
    visibleProjects(projects).map((p) => p.path),
    ["/a"]
  );
});

test("repoSlugFromPrUrl parses github PR urls and rejects everything else", () => {
  assert.equal(repoSlugFromPrUrl("https://github.com/acme/widget/pull/7"), "acme/widget");
  assert.equal(repoSlugFromPrUrl("https://example.com/acme/widget/pull/7"), null);
  assert.equal(repoSlugFromPrUrl("https://github.com/acme/widget"), null);
  assert.equal(repoSlugFromPrUrl("not a url"), null);
  assert.equal(repoSlugFromPrUrl(undefined), null);
});

test("flattenOpenPrs excludes hidden and missing projects", () => {
  const projects = [
    mk({ path: "/a", github: { openPrs: [pr({ url: "https://github.com/acme/a/pull/1", number: 1 })] } }),
    mk({
      path: "/b",
      hidden: true,
      github: { openPrs: [pr({ url: "https://github.com/acme/b/pull/2", number: 2 })] },
    }),
    mk({
      path: "/c",
      missing: true,
      github: { openPrs: [pr({ url: "https://github.com/acme/c/pull/3", number: 3 })] },
    }),
  ];
  const rows = flattenOpenPrs(projects, [], NOW);
  assert.deepEqual(rows.map((r) => r.number), [1]);
});

test("flattenOpenPrs dedupes the same PR reached from two cards", () => {
  const shared = pr({ url: "https://github.com/acme/widget/pull/7" });
  const projects = [
    mk({ path: "/a", github: { openPrs: [shared] } }),
    mk({ path: "/b", github: { openPrs: [{ ...shared }] } }),
  ];
  assert.equal(flattenOpenPrs(projects, [], NOW).length, 1);
});

test("flattenOpenPrs sorts attention/red-check rows first, then recency; missing updatedAt last", () => {
  const projects = [
    mk({
      path: "/a",
      github: {
        openPrs: [
          pr({ number: 1, url: "https://github.com/acme/a/pull/1", updatedAt: minutesAgo(60) }),
          pr({ number: 2, url: "https://github.com/acme/a/pull/2", updatedAt: minutesAgo(5) }),
          pr({ number: 3, url: "https://github.com/acme/a/pull/3", updatedAt: undefined }),
          pr({
            number: 4,
            url: "https://github.com/acme/a/pull/4",
            updatedAt: minutesAgo(240),
            ciStatus: "failure",
          }),
        ],
      },
    }),
  ];
  const rows = flattenOpenPrs(projects, [], NOW);
  assert.deepEqual(rows.map((r) => r.number), [4, 2, 1, 3]);
});

test("a red draft PR is not sorted to the front", () => {
  const projects = [
    mk({
      path: "/a",
      github: {
        openPrs: [
          pr({ number: 1, url: "https://github.com/acme/a/pull/1", updatedAt: minutesAgo(5) }),
          pr({
            number: 2,
            url: "https://github.com/acme/a/pull/2",
            updatedAt: minutesAgo(60),
            isDraft: true,
            ciStatus: "failure",
          }),
        ],
      },
    }),
  ];
  const rows = flattenOpenPrs(projects, [], NOW);
  assert.deepEqual(rows.map((r) => r.number), [1, 2]);
  assert.equal(rows.filter(prNeedsAttention).length, 0);
});

test("flattenOpenPrs attaches the matching unsnoozed attention row", () => {
  const projects = [mk({ path: "/a", github: { openPrs: [pr()] } })];
  const item = attention({
    id: "pr:acme/widget#7",
    sessionId: "pr:acme/widget#7",
    tool: "github",
    type: "pr-ci-failed",
    pr: {
      repo: "acme/widget",
      number: 7,
      title: "Fix the thing",
      url: "https://github.com/acme/widget/pull/7",
      isDraft: false,
    },
  });
  const rows = flattenOpenPrs(projects, [item], NOW);
  assert.equal(rows[0].attention?.type, "pr-ci-failed");
  assert.equal(rows.filter(prNeedsAttention).length, 1);
  const snoozed = { ...item, snoozedUntil: new Date(NOW.getTime() + 60_000).toISOString() };
  assert.equal(flattenOpenPrs(projects, [snoozed], NOW)[0].attention, undefined);
});

test("a cached PR without a url still gets a row, keyed by project path", () => {
  const projects = [mk({ path: "/a", github: { openPrs: [pr({ url: undefined })] } })];
  const rows = flattenOpenPrs(projects, [], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repoSlug, undefined);
  assert.equal(rows[0].url, undefined);
});
