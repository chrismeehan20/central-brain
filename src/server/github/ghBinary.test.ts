import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  GH_CANDIDATES,
  findGhBinary,
  inspectGhCli,
} from "./ghBinary.js";

/** An `isExecutableFile` that says yes to exactly the paths given. */
function only(...paths: string[]) {
  const set = new Set(paths);
  return (p: string) => set.has(p);
}

test("prefers an absolute candidate over anything on PATH", () => {
  const found = findGhBinary({
    isExecutableFile: only("/opt/homebrew/bin/gh", "/somewhere/else/gh"),
    home: "/Users/test",
    pathVar: "/somewhere/else",
  });
  assert.equal(found, "/opt/homebrew/bin/gh");
});

test("candidate order is install popularity, Apple Silicon Homebrew first", () => {
  assert.equal(GH_CANDIDATES[0], "/opt/homebrew/bin/gh");
  // Intel Homebrew must still beat a system package manager's copy.
  assert.ok(GH_CANDIDATES.indexOf("/usr/local/bin/gh") < GH_CANDIDATES.indexOf("/usr/bin/gh"));
});

test("falls back to a $HOME install when no absolute candidate exists", () => {
  const found = findGhBinary({
    isExecutableFile: only("/Users/test/.local/bin/gh"),
    home: "/Users/test",
    pathVar: "",
  });
  assert.equal(found, "/Users/test/.local/bin/gh");
});

test("falls back to PATH last, which is what makes `npm run dev` work", () => {
  const found = findGhBinary({
    isExecutableFile: only("/opt/custom/bin/gh"),
    home: "/Users/test",
    pathVar: `/nope${path.delimiter}/opt/custom/bin`,
  });
  assert.equal(found, "/opt/custom/bin/gh");
});

test("returns null when gh is nowhere — the packaged-app case this module exists for", () => {
  const found = findGhBinary({
    isExecutableFile: () => false,
    home: "/Users/test",
    // The stub PATH a Finder-launched .app actually gets.
    pathVar: "/usr/bin:/bin:/usr/sbin:/sbin",
  });
  assert.equal(found, null);
});

test("empty PATH segments never produce a bare relative lookup", () => {
  const probed: string[] = [];
  findGhBinary({
    isExecutableFile: (p) => {
      probed.push(p);
      return false;
    },
    home: "/Users/test",
    pathVar: `${path.delimiter}${path.delimiter}`,
  });
  assert.ok(probed.every((p) => path.isAbsolute(p)), `probed a relative path: ${probed.join(", ")}`);
});

test("missing gh reports missing, and never runs anything", async () => {
  let ran = false;
  const status = await inspectGhCli({
    resolve: () => null,
    run: async () => {
      ran = true;
      return "";
    },
  });
  assert.equal(status.state, "missing");
  assert.equal(ran, false);
  assert.match(status.detail ?? "", /isn't installed/);
});

test("a non-zero `gh auth status` is signed-out, not broken", async () => {
  const status = await inspectGhCli({
    resolve: () => "/opt/homebrew/bin/gh",
    run: async (_bin, args) => {
      if (args[0] === "auth") throw Object.assign(new Error("exit 1"), { code: 1 });
      return "";
    },
  });
  assert.equal(status.state, "unauthenticated");
  assert.equal(status.path, "/opt/homebrew/bin/gh");
  assert.match(status.detail ?? "", /gh auth login/);
});

test("a binary that resolves but cannot be executed is missing, not signed-out", async () => {
  const status = await inspectGhCli({
    resolve: () => "/opt/homebrew/bin/gh",
    run: async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(status.state, "missing");
  assert.match(status.detail ?? "", /ENOENT/);
});

test("connected carries the account name", async () => {
  const status = await inspectGhCli({
    resolve: () => "/usr/local/bin/gh",
    run: async (_bin, args) => (args[0] === "api" ? "octocat\n" : ""),
  });
  assert.equal(status.state, "connected");
  assert.equal(status.login, "octocat");
  assert.ok(status.checkedAt);
});

test("a gh too old for `--jq`, or an offline one, is still connected", async () => {
  const status = await inspectGhCli({
    resolve: () => "/usr/local/bin/gh",
    run: async (_bin, args) => {
      if (args[0] === "api") throw new Error("unknown flag: --jq");
      return "";
    },
  });
  assert.equal(status.state, "connected");
  assert.equal(status.login, undefined);
});
