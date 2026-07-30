import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_DIR_NAME, resolveClientDir, resolveDataDir, resolveNotifyScript } from "./appPaths.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const PLATFORMS = ["darwin", "win32", "linux", "freebsd"] as const;

test("CENTRAL_BRAIN_DATA_DIR overrides the platform default on every platform", () => {
  for (const platform of PLATFORMS) {
    const resolved = resolveDataDir({
      env: {
        CENTRAL_BRAIN_DATA_DIR: "/explicit/data",
        // Set the per-platform sources too, so a bug that prefers them is caught.
        APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
        XDG_DATA_HOME: "/xdg/share",
      },
      platform,
      homedir: "/home/someone",
    });
    assert.equal(resolved, "/explicit/data", `platform ${platform} ignored the override`);
  }
});

test("CENTRAL_BRAIN_DATA_DIR is trimmed", () => {
  const resolved = resolveDataDir({
    env: { CENTRAL_BRAIN_DATA_DIR: "  /explicit/data  " },
    platform: "darwin",
    homedir: "/Users/someone",
  });
  assert.equal(resolved, "/explicit/data");
});

test("darwin defaults to ~/Library/Application Support/central-brain", () => {
  const resolved = resolveDataDir({ env: {}, platform: "darwin", homedir: "/Users/someone" });
  assert.equal(resolved, "/Users/someone/Library/Application Support/central-brain");
});

test("darwin ignores XDG_DATA_HOME and APPDATA", () => {
  const resolved = resolveDataDir({
    env: { XDG_DATA_HOME: "/xdg/share", APPDATA: "C:\\Roaming" },
    platform: "darwin",
    homedir: "/Users/someone",
  });
  assert.equal(resolved, "/Users/someone/Library/Application Support/central-brain");
});

test("win32 uses APPDATA when set", () => {
  const appData = "C:\\Users\\someone\\AppData\\Roaming";
  const resolved = resolveDataDir({
    env: { APPDATA: appData },
    platform: "win32",
    homedir: "C:\\Users\\someone",
  });
  assert.equal(resolved, path.join(appData, APP_DIR_NAME));
});

test("win32 falls back to <home>/AppData/Roaming when APPDATA is unset", () => {
  const resolved = resolveDataDir({ env: {}, platform: "win32", homedir: "/home/someone" });
  assert.equal(resolved, path.join("/home/someone", "AppData", "Roaming", APP_DIR_NAME));
});

test("win32 treats a whitespace-only APPDATA as unset", () => {
  const resolved = resolveDataDir({ env: { APPDATA: "   " }, platform: "win32", homedir: "/home/someone" });
  assert.equal(resolved, path.join("/home/someone", "AppData", "Roaming", APP_DIR_NAME));
});

test("linux uses XDG_DATA_HOME when set", () => {
  const resolved = resolveDataDir({
    env: { XDG_DATA_HOME: "/xdg/share" },
    platform: "linux",
    homedir: "/home/someone",
  });
  assert.equal(resolved, "/xdg/share/central-brain");
});

test("linux falls back to ~/.local/share/central-brain", () => {
  const resolved = resolveDataDir({ env: {}, platform: "linux", homedir: "/home/someone" });
  assert.equal(resolved, "/home/someone/.local/share/central-brain");
});

test("an unrecognised platform gets the XDG layout", () => {
  const resolved = resolveDataDir({ env: {}, platform: "freebsd", homedir: "/home/someone" });
  assert.equal(resolved, "/home/someone/.local/share/central-brain");
});

test("an empty-string data dir env var is treated as unset, not as a path", () => {
  const empty = resolveDataDir({ env: { CENTRAL_BRAIN_DATA_DIR: "" }, platform: "darwin", homedir: "/Users/someone" });
  assert.equal(empty, "/Users/someone/Library/Application Support/central-brain");

  const blank = resolveDataDir({
    env: { CENTRAL_BRAIN_DATA_DIR: "   \t " },
    platform: "linux",
    homedir: "/home/someone",
  });
  assert.equal(blank, "/home/someone/.local/share/central-brain");
});

test("an empty XDG_DATA_HOME is treated as unset", () => {
  const resolved = resolveDataDir({ env: { XDG_DATA_HOME: "" }, platform: "linux", homedir: "/home/someone" });
  assert.equal(resolved, "/home/someone/.local/share/central-brain");
});

test("resolveClientDir honours CENTRAL_BRAIN_CLIENT_DIR", () => {
  const resolved = resolveClientDir({
    env: { CENTRAL_BRAIN_CLIENT_DIR: "  /Applications/central-brain.app/Resources/client  " },
    moduleDir: "/somewhere/else",
  });
  assert.equal(resolved, "/Applications/central-brain.app/Resources/client");
});

test("resolveClientDir finds the candidate that actually holds index.html", () => {
  // Mirrors the built layout: <root>/dist/server is the module dir, the client
  // sits at <root>/dist/client.
  const root = tempDir("cb-client-");
  const moduleDir = path.join(root, "dist", "server");
  const clientDir = path.join(root, "dist", "client");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.mkdirSync(clientDir, { recursive: true });
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html>");

  assert.equal(resolveClientDir({ env: {}, moduleDir }), clientDir);
});

test("resolveClientDir works from the dev layout too (src/server -> dist/client)", () => {
  const root = tempDir("cb-client-dev-");
  const moduleDir = path.join(root, "src", "server");
  const clientDir = path.join(root, "dist", "client");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.mkdirSync(clientDir, { recursive: true });
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html>");

  assert.equal(resolveClientDir({ env: {}, moduleDir }), clientDir);
});

test("resolveClientDir returns a candidate instead of throwing when nothing is built", () => {
  const root = tempDir("cb-client-missing-");
  const moduleDir = path.join(root, "dist", "server");
  fs.mkdirSync(moduleDir, { recursive: true });

  const resolved = resolveClientDir({ env: {}, moduleDir });
  assert.equal(typeof resolved, "string");
  assert.ok(path.isAbsolute(resolved), `expected an absolute path, got ${resolved}`);
  assert.equal(fs.existsSync(path.join(resolved, "index.html")), false);
});

test("resolveNotifyScript honours CENTRAL_BRAIN_HOOKS_DIR", () => {
  const resolved = resolveNotifyScript({
    name: "notify-codex.sh",
    env: { CENTRAL_BRAIN_HOOKS_DIR: "  /Applications/central-brain.app/Resources/hooks  " },
    moduleDir: "/somewhere/else",
  });
  assert.equal(resolved, "/Applications/central-brain.app/Resources/hooks/notify-codex.sh");
});

test("resolveNotifyScript finds a real script relative to the module dir", () => {
  const root = tempDir("cb-hooks-");
  const moduleDir = path.join(root, "dist", "server");
  const hooksDir = path.join(root, "hooks");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "notify-codex.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(hooksDir, "notify.sh"), "#!/bin/sh\n");

  assert.equal(
    resolveNotifyScript({ name: "notify-codex.sh", env: {}, moduleDir }),
    path.join(hooksDir, "notify-codex.sh"),
  );
  assert.equal(resolveNotifyScript({ name: "notify.sh", env: {}, moduleDir }), path.join(hooksDir, "notify.sh"));
});

test("resolveNotifyScript returns a candidate path when the script is missing", () => {
  const root = tempDir("cb-hooks-missing-");
  const moduleDir = path.join(root, "dist", "server");
  fs.mkdirSync(moduleDir, { recursive: true });

  const resolved = resolveNotifyScript({ name: "notify-codex.sh", env: {}, moduleDir });
  assert.ok(path.isAbsolute(resolved), `expected an absolute path, got ${resolved}`);
  assert.equal(path.basename(resolved), "notify-codex.sh");
  assert.equal(fs.existsSync(resolved), false);
});

test("an empty hooks/client env var is treated as unset", () => {
  const root = tempDir("cb-empty-env-");
  const moduleDir = path.join(root, "dist", "server");
  const hooksDir = path.join(root, "hooks");
  const clientDir = path.join(root, "dist", "client");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(clientDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "notify.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html>");

  assert.equal(resolveClientDir({ env: { CENTRAL_BRAIN_CLIENT_DIR: "  " }, moduleDir }), clientDir);
  assert.equal(
    resolveNotifyScript({ name: "notify.sh", env: { CENTRAL_BRAIN_HOOKS_DIR: "" }, moduleDir }),
    path.join(hooksDir, "notify.sh"),
  );
});

test("the real repo layout resolves the shipped hook scripts", () => {
  // Guards the wiring the resolvers exist for: from src/server (tsx) and from
  // dist/server (built) the hooks dir is at the same depth.
  for (const name of ["notify.sh", "notify-codex.sh"]) {
    const resolved = resolveNotifyScript({ name, env: {} });
    assert.equal(fs.existsSync(resolved), true, `${name} not found at ${resolved}`);
  }
});
