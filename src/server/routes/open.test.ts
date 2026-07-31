import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project } from "@shared/types.js";
import { resolveOpenTarget } from "./open.js";

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
    ...overrides,
  };
}

test("a missing or non-string projectPath is a 400", () => {
  for (const body of [undefined, null, {}, { projectPath: 42 }, { projectPath: "" }]) {
    const res = resolveOpenTarget([makeProject()], body);
    assert.ok("error" in res);
    assert.equal(res.error.status, 400);
  }
});

test("a path the scanner does not know about is a 404 — arbitrary paths never resolve", () => {
  const res = resolveOpenTarget([makeProject()], { projectPath: "/etc" });
  assert.ok("error" in res);
  assert.equal(res.error.status, 404);
});

test("a project whose folder is gone from disk is a 409", () => {
  const res = resolveOpenTarget([makeProject({ missing: true })], {
    projectPath: "/Users/someone/code/widget",
  });
  assert.ok("error" in res);
  assert.equal(res.error.status, 409);
});

test("a known project resolves to the cached path", () => {
  const res = resolveOpenTarget([makeProject()], { projectPath: "/Users/someone/code/widget" });
  assert.deepEqual(res, { path: "/Users/someone/code/widget" });
});
