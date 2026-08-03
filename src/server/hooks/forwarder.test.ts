import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_FORWARDER_NAME,
  codexForwarderPath,
  ForwarderInstallError,
  installCodexForwarder,
  readRuntimeEndpoint,
  runtimeEndpointPath,
  shellQuote,
  writeRuntimeEndpoint,
} from "./forwarder.js";
import { buildCodexHookCommand } from "./codexHooks.js";

/**
 * Every test gets its own mkdtemp data dir, so the developer's real
 * ~/Library/Application Support/central-brain is never read or written — the
 * same isolation rule codexHooks.test.ts follows for ~/.codex.
 */
const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function sourceFixture(contents = "#!/bin/sh\nexit 0\n"): string {
  const dir = tempDir("cb-forwarder-src-");
  const file = path.join(dir, CODEX_FORWARDER_NAME);
  fs.writeFileSync(file, contents);
  return file;
}

test("shellQuote survives every character a home directory can legally hold", () => {
  // The double-quoted form this replaced broke on all four of these.
  assert.equal(shellQuote("/Users/me/hooks.sh"), "'/Users/me/hooks.sh'");
  assert.equal(shellQuote("/Users/Ann O'Neill/x.sh"), `'/Users/Ann O'\\''Neill/x.sh'`);
  assert.equal(shellQuote("/Users/$USER/x.sh"), "'/Users/$USER/x.sh'");
  assert.equal(shellQuote('/Users/a "b"/x.sh'), `'/Users/a "b"/x.sh'`);
  assert.equal(shellQuote("/Users/a`whoami`/x.sh"), "'/Users/a`whoami`/x.sh'");
  assert.equal(shellQuote("/Users/josé/日本/x.sh"), "'/Users/josé/日本/x.sh'");
});

test("the built hook command runs /bin/sh on a properly quoted path", () => {
  assert.equal(
    buildCodexHookCommand("/Users/Ann O'Neill/Library/Application Support/central-brain/hooks/notify-codex.sh"),
    `/bin/sh '/Users/Ann O'\\''Neill/Library/Application Support/central-brain/hooks/notify-codex.sh'`
  );
});

test("installing copies the shipped script into the data dir and makes it executable", () => {
  const dataDir = tempDir("cb-forwarder-data-");
  const sourcePath = sourceFixture("#!/bin/sh\necho v1\n");

  const result = installCodexForwarder({ dataDir, sourcePath });

  assert.equal(result.updated, true);
  assert.equal(result.path, codexForwarderPath(dataDir));
  assert.equal(fs.readFileSync(result.path, "utf8"), "#!/bin/sh\necho v1\n");
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o755);
});

test("installing again with an unchanged source writes nothing", () => {
  const dataDir = tempDir("cb-forwarder-data-");
  const sourcePath = sourceFixture();

  const first = installCodexForwarder({ dataDir, sourcePath });
  const before = fs.statSync(first.path).mtimeMs;
  const second = installCodexForwarder({ dataDir, sourcePath });

  assert.equal(second.updated, false);
  assert.equal(fs.statSync(second.path).mtimeMs, before);
});

test("a new app version's script replaces the installed copy in place", () => {
  const dataDir = tempDir("cb-forwarder-data-");
  const sourcePath = sourceFixture("#!/bin/sh\necho v1\n");
  installCodexForwarder({ dataDir, sourcePath });

  fs.writeFileSync(sourcePath, "#!/bin/sh\necho v2\n");
  const result = installCodexForwarder({ dataDir, sourcePath });

  assert.equal(result.updated, true);
  assert.equal(fs.readFileSync(result.path, "utf8"), "#!/bin/sh\necho v2\n");
  // Same path as before, which is the entire point: hooks.json is untouched,
  // so the user's approval of that definition still stands.
  assert.equal(result.path, codexForwarderPath(dataDir));
});

test("a missing source leaves a working installed copy alone", () => {
  const dataDir = tempDir("cb-forwarder-data-");
  const sourcePath = sourceFixture("#!/bin/sh\necho installed\n");
  const installed = installCodexForwarder({ dataDir, sourcePath }).path;
  fs.rmSync(sourcePath);

  const result = installCodexForwarder({ dataDir, sourcePath });

  assert.equal(result.updated, false);
  assert.equal(fs.readFileSync(installed, "utf8"), "#!/bin/sh\necho installed\n");
});

test("a missing source with nothing installed is a named, actionable error", () => {
  const dataDir = tempDir("cb-forwarder-data-");
  const sourcePath = path.join(tempDir("cb-forwarder-src-"), CODEX_FORWARDER_NAME);

  assert.throws(
    () => installCodexForwarder({ dataDir, sourcePath }),
    (err: unknown) => err instanceof ForwarderInstallError && /CENTRAL_BRAIN_HOOKS_DIR/.test((err as Error).message)
  );
});

test("the endpoint is published as a bare origin the script can read", () => {
  const dataDir = tempDir("cb-forwarder-data-");

  const written = writeRuntimeEndpoint("http://127.0.0.1:5555", { dataDir });

  assert.equal(written, runtimeEndpointPath(dataDir));
  assert.equal(fs.readFileSync(written, "utf8"), "http://127.0.0.1:5555\n");
  assert.equal(readRuntimeEndpoint({ dataDir }), "http://127.0.0.1:5555");
  assert.equal(fs.statSync(written).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(written)).mode & 0o777, 0o700);
});

test("a trailing slash never becomes a double slash in the posted URL", () => {
  const dataDir = tempDir("cb-forwarder-data-");
  writeRuntimeEndpoint("http://127.0.0.1:5555/", { dataDir });
  assert.equal(readRuntimeEndpoint({ dataDir }), "http://127.0.0.1:5555");
});

test("republishing on a new port overwrites rather than appends", () => {
  const dataDir = tempDir("cb-forwarder-data-");
  writeRuntimeEndpoint("http://127.0.0.1:4317", { dataDir });
  writeRuntimeEndpoint("http://127.0.0.1:9999", { dataDir });
  assert.equal(readRuntimeEndpoint({ dataDir }), "http://127.0.0.1:9999");
});

test("no published endpoint reads as undefined rather than an empty string", () => {
  const dataDir = tempDir("cb-forwarder-data-");
  assert.equal(readRuntimeEndpoint({ dataDir }), undefined);

  fs.mkdirSync(path.dirname(runtimeEndpointPath(dataDir)), { recursive: true });
  fs.writeFileSync(runtimeEndpointPath(dataDir), "  \n");
  assert.equal(readRuntimeEndpoint({ dataDir }), undefined);
});

test("no leftover temp files survive a write", () => {
  const dataDir = tempDir("cb-forwarder-data-");
  installCodexForwarder({ dataDir, sourcePath: sourceFixture() });
  writeRuntimeEndpoint("http://127.0.0.1:4317", { dataDir });

  for (const dir of [path.join(dataDir, "hooks"), path.join(dataDir, "runtime")]) {
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".tmp")),
      []
    );
  }
});
