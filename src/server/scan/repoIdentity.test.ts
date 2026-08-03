import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectRepoIdentity, normalizeRemoteUrl, originUrlFromConfig } from "./repoIdentity.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cb-repoid-"));
}

/** Minimal main checkout: .git dir with HEAD and optional [remote "origin"]. */
function makeMainCheckout(root: string, name: string, opts: { remote?: string; head?: string } = {}): string {
  const checkout = path.join(root, name);
  const gitDir = path.join(checkout, ".git");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), opts.head ?? "ref: refs/heads/main\n");
  if (opts.remote) {
    fs.writeFileSync(
      path.join(gitDir, "config"),
      `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${opts.remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    );
  }
  return checkout;
}

/** Linked worktree of `mainCheckout`: .git FILE pointing into its worktrees dir. */
function makeWorktree(root: string, name: string, mainCheckout: string, branch = "feature"): string {
  const checkout = path.join(root, name);
  fs.mkdirSync(checkout, { recursive: true });
  const wtGitDir = path.join(mainCheckout, ".git", "worktrees", name);
  fs.mkdirSync(wtGitDir, { recursive: true });
  fs.writeFileSync(path.join(wtGitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${wtGitDir}\n`);
  return checkout;
}

test("normalizeRemoteUrl treats SSH, HTTPS, .git and case as the same repo", () => {
  const expected = "github.com/user/repo";
  assert.equal(normalizeRemoteUrl("git@github.com:User/Repo.git"), expected);
  assert.equal(normalizeRemoteUrl("https://github.com/user/repo"), expected);
  assert.equal(normalizeRemoteUrl("https://github.com/user/repo.git"), expected);
  assert.equal(normalizeRemoteUrl("ssh://git@github.com/user/repo.git"), expected);
  assert.equal(normalizeRemoteUrl("https://token@github.com/USER/REPO.git/"), expected);
});

test("normalizeRemoteUrl rejects junk", () => {
  assert.equal(normalizeRemoteUrl(""), null);
  assert.equal(normalizeRemoteUrl("   "), null);
});

test("originUrlFromConfig reads only the origin remote", () => {
  const config = `[remote "upstream"]\n\turl = https://github.com/other/repo.git\n[remote "origin"]\n\turl = git@github.com:me/mine.git\n`;
  assert.equal(originUrlFromConfig(config), "git@github.com:me/mine.git");
  assert.equal(originUrlFromConfig(`[core]\n\tbare = false\n`), null);
});

test("main checkout with a remote keys by normalized remote and reports its branch", () => {
  const root = tmpDir();
  const main = makeMainCheckout(root, "app", { remote: "git@github.com:User/App.git" });
  const id = detectRepoIdentity(main);
  assert.equal(id.repoKey, "remote:github.com/user/app");
  assert.equal(id.isMainWorktree, true);
  assert.equal(id.branch, "main");
});

test("two clones of the same remote share a key", () => {
  const root = tmpDir();
  const a = makeMainCheckout(root, "app", { remote: "git@github.com:u/app.git" });
  const b = makeMainCheckout(root, "app-copy", { remote: "https://github.com/u/app" });
  assert.equal(detectRepoIdentity(a).repoKey, detectRepoIdentity(b).repoKey);
});

test("a linked worktree groups with its main checkout", () => {
  const root = tmpDir();
  const main = makeMainCheckout(root, "app", { remote: "https://github.com/u/app.git" });
  const wt = makeWorktree(root, "app-v2", main, "redesign");
  const wtId = detectRepoIdentity(wt);
  assert.equal(wtId.repoKey, detectRepoIdentity(main).repoKey);
  assert.equal(wtId.isMainWorktree, false);
  assert.equal(wtId.branch, "redesign");
});

test("a remoteless main and its worktree still share a key", () => {
  const root = tmpDir();
  const main = makeMainCheckout(root, "local-only");
  const wt = makeWorktree(root, "local-only-wt", main);
  assert.equal(detectRepoIdentity(main).repoKey, `main:${main}`);
  assert.equal(detectRepoIdentity(wt).repoKey, `main:${main}`);
});

test("a dangling worktree (main deleted) degrades to a main:<path> key, no throw", () => {
  const root = tmpDir();
  const main = makeMainCheckout(root, "doomed", { remote: "https://github.com/u/doomed.git" });
  const wt = makeWorktree(root, "doomed-wt", main);
  fs.rmSync(main, { recursive: true, force: true });
  const id = detectRepoIdentity(wt);
  assert.equal(id.repoKey, `main:${main}`);
  assert.equal(id.branch, undefined); // its HEAD lived inside the deleted main
});

test("detached HEAD yields no branch", () => {
  const root = tmpDir();
  const main = makeMainCheckout(root, "detached", {
    head: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\n",
  });
  assert.equal(detectRepoIdentity(main).branch, undefined);
});

test("a plain directory is not a repo", () => {
  const root = tmpDir();
  const dir = path.join(root, "not-a-repo");
  fs.mkdirSync(dir);
  assert.deepEqual(detectRepoIdentity(dir), { repoKey: null, isMainWorktree: false });
});

test("a submodule-style gitdir (no worktrees segment) is not grouped", () => {
  const root = tmpDir();
  const dir = path.join(root, "submodule");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(root, "parent", ".git", "modules", "submodule")}\n`);
  assert.equal(detectRepoIdentity(dir).repoKey, null);
});
