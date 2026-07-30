import { test } from "node:test";
import assert from "node:assert/strict";
import type { Override } from "@shared/types.js";
import { resolveAlias } from "./resolveProject.js";

const overrides = (data: Record<string, Override>) => data;

test("a path with no relocation resolves to itself", () => {
  assert.equal(resolveAlias("/a/project", overrides({})), "/a/project");
});

test("a relocated path resolves to its new home", () => {
  const data = overrides({ "/old/project": { movedTo: "/new/project" } });
  assert.equal(resolveAlias("/old/project", data), "/new/project");
});

test("a folder moved twice resolves all the way to the end of the chain", () => {
  const data = overrides({
    "/first/project": { movedTo: "/second/project" },
    "/second/project": { movedTo: "/third/project" },
  });
  assert.equal(resolveAlias("/first/project", data), "/third/project");
});

test("a relocation cycle terminates instead of hanging the scan", () => {
  const data = overrides({
    "/a": { movedTo: "/b" },
    "/b": { movedTo: "/a" },
  });
  assert.equal(resolveAlias("/a", data), "/b");
});

test("other override fields do not create a relocation", () => {
  const data = overrides({ "/a/project": { hidden: true, pinned: true, displayName: "Thing" } });
  assert.equal(resolveAlias("/a/project", data), "/a/project");
});
