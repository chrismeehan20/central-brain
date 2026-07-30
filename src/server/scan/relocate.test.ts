import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveSearchRoots, findRelocations } from "./relocate.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Creates each relative directory under `root` and returns the root. */
function tree(root: string, dirs: string[]): string {
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("a folder moved to a new parent is found with high confidence", () => {
  const root = tree(tempDir("relocate-"), ["code/my-app"]);
  const moved = path.join(root, "Documents/Repos/my-app");

  const found = findRelocations({ missingPaths: [moved], roots: [root] });

  assert.equal(found[moved][0].path, path.join(root, "code/my-app"));
  assert.equal(found[moved][0].confidence, "high");
});

test("a name with no match anywhere yields no candidates", () => {
  const root = tree(tempDir("relocate-"), ["code/something-else"]);
  const moved = path.join(root, "code/deleted-project");

  assert.deepEqual(findRelocations({ missingPaths: [moved], roots: [root] })[moved], []);
});

test("matching parent folders outrank a bare name match", () => {
  const root = tree(tempDir("relocate-"), ["code/Web/Redesign/Second Bell", "elsewhere/Second Bell"]);
  const moved = path.join(root, "Documents/Web/Redesign/Second Bell");

  const [best, runnerUp] = findRelocations({ missingPaths: [moved], roots: [root] })[moved];

  assert.equal(best.path, path.join(root, "code/Web/Redesign/Second Bell"));
  assert.ok(best.score > runnerUp.score, "the deeper path match should score higher");
  assert.match(best.reason, /matching parent folders/);
});

test("an archived copy never wins outright", () => {
  const root = tree(tempDir("relocate-"), ["code/ARCHIVE 2024/pencilmark"]);
  const moved = path.join(root, "Documents/Pencilmark/pencilmark");

  const [best] = findRelocations({ missingPaths: [moved], roots: [root] })[moved];

  assert.notEqual(best.confidence, "high");
  assert.match(best.reason, /looks archived/);
});

test("a generic folder name is never a confident answer on its own", () => {
  const root = tree(tempDir("relocate-"), ["code/one/backend", "code/two/backend"]);
  const moved = path.join(root, "Documents/three/backend");

  const [best] = findRelocations({ missingPaths: [moved], roots: [root] })[moved];

  assert.notEqual(best.confidence, "high");
  assert.match(best.reason, /common folder name/);
});

test("a git repo scores above an otherwise identical plain folder", () => {
  const root = tree(tempDir("relocate-"), ["a/thing/.git", "b/thing"]);
  const moved = path.join(root, "gone/thing");

  const [best] = findRelocations({ missingPaths: [moved], roots: [root] })[moved];

  assert.equal(best.path, path.join(root, "a/thing"));
  assert.match(best.reason, /git repo/);
});

test("the still-missing path itself is never offered as its own destination", () => {
  const root = tree(tempDir("relocate-"), ["code/ghost"]);
  const ghost = path.join(root, "code/ghost");

  assert.deepEqual(findRelocations({ missingPaths: [ghost], roots: [root] })[ghost], []);
});

test("directories deeper than maxDepth are not searched", () => {
  const root = tree(tempDir("relocate-"), ["a/b/c/d/e/buried"]);
  const moved = path.join(root, "gone/buried");

  assert.deepEqual(findRelocations({ missingPaths: [moved], roots: [root], maxDepth: 3 })[moved], []);
  assert.equal(findRelocations({ missingPaths: [moved], roots: [root], maxDepth: 6 })[moved].length, 1);
});

test("node_modules is skipped so a vendored copy is never proposed", () => {
  const root = tree(tempDir("relocate-"), ["code/node_modules/my-app"]);
  const moved = path.join(root, "Documents/my-app");

  assert.deepEqual(findRelocations({ missingPaths: [moved], roots: [root] })[moved], []);
});

test("search roots come from where live projects already are", () => {
  const home = tree(tempDir("roots-"), ["code/live-one", "Documents"]);

  const roots = deriveSearchRoots({
    livePaths: [path.join(home, "code/live-one")],
    env: {},
    homedir: home,
  });

  // Truncated to one level below home, so siblings of the live project are searched too.
  assert.ok(roots.includes(path.join(home, "code")), "expected ~/code among the roots");
  assert.ok(!roots.includes(path.join(home, "code/live-one")), "roots should not be the project itself");
});

test("agent worktree dirs never become search roots", () => {
  const home = tree(tempDir("roots-"), [".codex/worktrees/abc/thing", "code"]);

  const roots = deriveSearchRoots({
    livePaths: [path.join(home, ".codex/worktrees/abc/thing")],
    env: {},
    homedir: home,
  });

  assert.ok(!roots.some((r) => path.basename(r).startsWith(".")), `dotted root in ${roots}`);
});

test("CENTRAL_BRAIN_SEARCH_ROOTS replaces the derived roots", () => {
  const home = tree(tempDir("roots-"), ["code", "custom"]);
  const custom = path.join(home, "custom");

  const roots = deriveSearchRoots({
    livePaths: [path.join(home, "code/whatever")],
    env: { CENTRAL_BRAIN_SEARCH_ROOTS: custom },
    homedir: home,
  });

  assert.deepEqual(roots, [custom]);
});

test("a root nested inside another root is dropped", () => {
  const home = tree(tempDir("roots-"), ["code/inner"]);

  const roots = deriveSearchRoots({
    env: { CENTRAL_BRAIN_SEARCH_ROOTS: `${path.join(home, "code")}:${path.join(home, "code/inner")}` },
    homedir: home,
  });

  assert.deepEqual(roots, [path.join(home, "code")]);
});
