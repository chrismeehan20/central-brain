import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanMarkdown } from "./markdown.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-markdown-test-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scanMarkdown finds recognized top-level files and parses frontmatter/heading", () => {
  const dir = makeTmpDir();
  fs.writeFileSync(
    path.join(dir, "README.md"),
    ["---", "status: in-progress", "---", "", "# My Project", "", "Some body text."].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "TODO.md"), "# TODO List\n\n- [ ] thing");
  // Not a recognized candidate filename - must not be picked up.
  fs.writeFileSync(path.join(dir, "NOTES.md"), "# Notes\n");

  const docs = scanMarkdown(dir);

  const readme = docs.find((d) => d.relativePath === "README.md");
  assert.ok(readme, "expected README.md to be found");
  assert.equal(readme?.status, "in-progress");
  assert.equal(readme?.firstHeading, "My Project");
  assert.equal(readme?.file, path.join(dir, "README.md"));
  assert.equal(readme?.mtime, fs.statSync(path.join(dir, "README.md")).mtime.toISOString());

  const todo = docs.find((d) => d.relativePath === "TODO.md");
  assert.ok(todo, "expected TODO.md to be found");
  assert.equal(todo?.firstHeading, "TODO List");
  assert.equal(todo?.status, undefined);

  assert.equal(
    docs.find((d) => d.relativePath === "NOTES.md"),
    undefined,
    "non-candidate filenames must not be included",
  );
  assert.equal(docs.length, 2);
});

test("scanMarkdown returns an empty array without throwing for a project with no matching files", () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, "index.ts"), "export {};\n");

  const docs = scanMarkdown(dir);

  assert.deepEqual(docs, []);
});

test("scanMarkdown returns an empty array without throwing for a nonexistent project path", () => {
  const dir = makeTmpDir();
  const doesNotExist = path.join(dir, "does-not-exist");

  const docs = scanMarkdown(doesNotExist);

  assert.deepEqual(docs, []);
});

test("scanMarkdown recurses into docs/ up to the documented depth limit", () => {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, "docs", "a", "b", "c"), { recursive: true });
  // docs(1)/a(2)/b(3) - within the documented max depth of 3, must be included.
  fs.writeFileSync(path.join(dir, "docs", "a", "b", "in-range.md"), "# In Range\n");
  // docs(1)/a(2)/b(3)/c(4) - one level past the documented max depth, must be excluded.
  fs.writeFileSync(path.join(dir, "docs", "a", "b", "c", "too-deep.md"), "# Too Deep\n");

  const docs = scanMarkdown(dir);
  const relativePaths = docs.map((d) => d.relativePath);

  assert.ok(relativePaths.includes(path.join("docs", "a", "b", "in-range.md")));
  assert.ok(!relativePaths.includes(path.join("docs", "a", "b", "c", "too-deep.md")));
});

test("scanMarkdown skips dotfile/build directories inside docs/", () => {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, "docs", ".hidden"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", ".hidden", "secret.md"), "# Secret\n");
  fs.writeFileSync(path.join(dir, "docs", "node_modules", "dep.md"), "# Dep\n");
  fs.writeFileSync(path.join(dir, "docs", "kept.md"), "# Kept\n");

  const docs = scanMarkdown(dir);
  const relativePaths = docs.map((d) => d.relativePath);

  assert.ok(relativePaths.includes(path.join("docs", "kept.md")));
  assert.equal(relativePaths.length, 1);
});
