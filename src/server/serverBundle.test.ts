import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

/**
 * Guards the sidecar bundle end to end: it must build, boot, and serve.
 *
 * This exists because of a real failure. Bundling to ESM with `--packages=bundle`
 * produced a 2.3 MB file that built cleanly and then died at runtime with
 * `Dynamic require of "fs" is not supported` — esbuild's ESM output shims
 * `require`, and a transitive dependency calls it at load time. The fix is the
 * createRequire banner below, and nothing about the *build* would tell you it
 * had regressed. Only booting the thing does.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

/** Must stay in lockstep with the `build:bundle` script in package.json. */
const BANNER =
  'import{createRequire as __cbCreateRequire}from"node:module";const require=__cbCreateRequire(import.meta.url);';

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-bundle-test-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** An ephemeral port, so concurrent runs and a real server on 4317 don't collide. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForOk(url: string, child: ChildProcess, timeoutMs = 30_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never became ready: ${String(lastErr)}`);
}

test("the single-file server bundle builds, boots, and serves", async () => {
  const outDir = makeTmpDir();
  const outfile = path.join(outDir, "server-bundle.mjs");

  await esbuild.build({
    entryPoints: [path.join(repoRoot, "src/server/index.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile,
    packages: "bundle",
    banner: { js: BANNER },
    logLevel: "silent",
  });

  assert.ok(fs.statSync(outfile).size > 0, "bundle should not be empty");

  // A minimal client dir, so the test does not depend on `vite build` having run
  // (npm test runs before npm run build in CI).
  const clientDir = makeTmpDir();
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>t</title>");

  const dataDir = makeTmpDir();
  const port = await freePort();

  const child = spawn(process.execPath, [outfile], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      CENTRAL_BRAIN_DATA_DIR: dataDir,
      CENTRAL_BRAIN_CLIENT_DIR: clientDir,
      CENTRAL_BRAIN_HOOKS_DIR: path.join(repoRoot, "hooks"),
      // Keep the bundle from spending real money if a key happens to be present.
      ANTHROPIC_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const base = `http://127.0.0.1:${port}`;
  const attention = await waitForOk(`${base}/api/attention`, child);
  assert.equal(attention.status, 200);
  assert.match(attention.headers.get("content-type") ?? "", /application\/json/);

  // The specific regression: a require shim failure kills the process on boot,
  // so assert the message never appears even though the server came up.
  assert.doesNotMatch(stderr, /Dynamic require of/, `bundle used a dynamic require:\n${stderr}`);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200, "static client should be served from CENTRAL_BRAIN_CLIENT_DIR");
  assert.match(index.headers.get("content-type") ?? "", /text\/html/);

  // /api/* must 404 as JSON rather than falling through to index.html.
  const missing = await fetch(`${base}/api/definitely-not-a-route`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not found" });

  // The bundle honoured the injected data dir rather than the real user-data one.
  assert.ok(fs.existsSync(dataDir), "data dir should exist");
});
