import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project } from "@shared/types.js";
import { AI_ACTIVITY_WINDOW_MS, isAiEligible } from "./aiEligibility.js";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW - days * 86_400_000).toISOString();
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    path: "/Users/someone/code/widget",
    displayName: "widget",
    discovered: false,
    hidden: false,
    pinned: false,
    missing: false,
    sessions: [],
    markdown: [],
    lastActivity: daysAgo(1),
    ...overrides,
  };
}

test("hidden projects are ineligible even when recently active", () => {
  assert.equal(isAiEligible(makeProject({ hidden: true }), NOW), false);
});

test("missing projects are ineligible", () => {
  assert.equal(isAiEligible(makeProject({ missing: true }), NOW), false);
});

test("recent activity qualifies regardless of discovered state", () => {
  assert.equal(isAiEligible(makeProject({ discovered: true }), NOW), true);
  assert.equal(isAiEligible(makeProject({ discovered: false }), NOW), true);
});

test("the activity window is 30 days", () => {
  assert.equal(isAiEligible(makeProject({ lastActivity: daysAgo(31) }), NOW), false);
  assert.equal(isAiEligible(makeProject({ lastActivity: daysAgo(29) }), NOW), true);
  assert.equal(AI_ACTIVITY_WINDOW_MS, 30 * 86_400_000);
});

test("a project with no recorded activity is ineligible", () => {
  assert.equal(isAiEligible(makeProject({ lastActivity: undefined }), NOW), false);
});
