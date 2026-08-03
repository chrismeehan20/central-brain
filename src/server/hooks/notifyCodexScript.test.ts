import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import {
  CODEX_FORWARDER_NAME,
  FORWARDER_REVISION,
  installCodexForwarder,
  rotateInstallId,
  writeRuntimeEndpoint,
} from "./forwarder.js";
import { resolveNotifyScript } from "../appPaths.js";

/**
 * Runs the REAL hooks/notify-codex.sh against a throwaway HTTP server.
 *
 * The unit tests above it prove what Node writes; only executing the actual
 * shell can prove the script reads it back. Every failure mode this covers —
 * a custom port, a moved data dir, a dead server — previously showed up as
 * "Codex hooks just don't work" with nothing in any log.
 */
const tmpDirs: string[] = [];
const servers: http.Server[] = [];

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

interface Received {
  url: string;
  body: string;
  contentType: string | undefined;
  installId: string | undefined;
  forwarderRevision: string | undefined;
}

/** An ephemeral-port server so concurrent runs (and a real one on 4317) don't collide. */
async function receiver(): Promise<{ origin: string; received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({
        url: req.url ?? "",
        body,
        contentType: req.headers["content-type"],
        installId: req.headers["x-central-brain-install-id"] as string | undefined,
        forwarderRevision: req.headers["x-central-brain-forwarder-revision"] as string | undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, received };
}

const PAYLOAD = JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" });

/** Run the script with `payload` on stdin, and a deliberately bare environment. */
async function runScript(scriptPath: string, env: Record<string, string>): Promise<number> {
  const child = spawn("/bin/sh", [scriptPath], {
    // HOME is always set so the script's last-resort probe has somewhere to
    // look; pointing it at a temp dir keeps that probe off the real one.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tempDir("cb-fake-home-"), ...env },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end(PAYLOAD);
  const [code] = (await once(child, "close")) as [number | null];
  return code ?? -1;
}

test("the installed script posts to the endpoint the server published", async () => {
  const dataDir = tempDir("cb-script-data-");
  const { origin, received } = await receiver();
  writeRuntimeEndpoint(origin, { dataDir });
  const script = installCodexForwarder({
    dataDir,
    sourcePath: resolveNotifyScript({ name: CODEX_FORWARDER_NAME, env: {} }),
  }).path;

  assert.equal(await runScript(script, {}), 0);

  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/api/hook/codex");
  assert.equal(received[0].body, PAYLOAD);
  assert.equal(received[0].contentType, "application/json");
});

test("a port change needs no reinstall — the same script follows the new endpoint", async () => {
  const dataDir = tempDir("cb-script-data-");
  const first = await receiver();
  writeRuntimeEndpoint(first.origin, { dataDir });
  const script = installCodexForwarder({
    dataDir,
    sourcePath: resolveNotifyScript({ name: CODEX_FORWARDER_NAME, env: {} }),
  }).path;
  await runScript(script, {});

  // Restart on a different port, exactly as CENTRAL_BRAIN_PORT would.
  const second = await receiver();
  writeRuntimeEndpoint(second.origin, { dataDir });
  assert.equal(await runScript(script, {}), 0);

  assert.equal(first.received.length, 1);
  assert.equal(second.received.length, 1);
});

test("a data dir full of shell metacharacters still delivers", async () => {
  const parent = tempDir("cb-script-data-");
  // Every character that broke the old double-quoted command.
  const dataDir = path.join(parent, `a b's $HOME \`x\` "q" josé`);
  fs.mkdirSync(dataDir, { recursive: true });
  const { origin, received } = await receiver();
  writeRuntimeEndpoint(origin, { dataDir });
  const script = installCodexForwarder({
    dataDir,
    sourcePath: resolveNotifyScript({ name: CODEX_FORWARDER_NAME, env: {} }),
  }).path;

  assert.equal(await runScript(script, {}), 0);
  assert.equal(received.length, 1);
});

test("CENTRAL_BRAIN_CODEX_HOOK_URL still wins over the published endpoint", async () => {
  const dataDir = tempDir("cb-script-data-");
  const published = await receiver();
  const override = await receiver();
  writeRuntimeEndpoint(published.origin, { dataDir });
  const script = installCodexForwarder({
    dataDir,
    sourcePath: resolveNotifyScript({ name: CODEX_FORWARDER_NAME, env: {} }),
  }).path;

  await runScript(script, { CENTRAL_BRAIN_CODEX_HOOK_URL: `${override.origin}/api/hook/codex` });

  assert.equal(published.received.length, 0);
  assert.equal(override.received.length, 1);
});

test("CENTRAL_BRAIN_RUNTIME_DIR points a checkout copy at a running server", async () => {
  const dataDir = tempDir("cb-script-data-");
  const { origin, received } = await receiver();
  writeRuntimeEndpoint(origin, { dataDir });
  // The shipped script, run where it sits, with no installed copy anywhere.
  const script = resolveNotifyScript({ name: CODEX_FORWARDER_NAME, env: {} });

  assert.equal(await runScript(script, { CENTRAL_BRAIN_RUNTIME_DIR: path.join(dataDir, "runtime") }), 0);

  assert.equal(received.length, 1);
});

test("a dead server exits 0 rather than failing the Codex turn", async () => {
  const dataDir = tempDir("cb-script-data-");
  const { origin } = await receiver();
  // Publish a port nothing is listening on: close the receiver we just opened.
  await new Promise((resolve) => servers[servers.length - 1].close(resolve));
  writeRuntimeEndpoint(origin, { dataDir });
  const script = installCodexForwarder({
    dataDir,
    sourcePath: resolveNotifyScript({ name: CODEX_FORWARDER_NAME, env: {} }),
  }).path;

  assert.equal(await runScript(script, {}), 0);
});

test("no published endpoint at all still exits 0", async () => {
  const dataDir = tempDir("cb-script-data-");
  const script = installCodexForwarder({
    dataDir,
    sourcePath: resolveNotifyScript({ name: CODEX_FORWARDER_NAME, env: {} }),
  }).path;

  assert.equal(await runScript(script, {}), 0);
});

test("delivery finishes well inside Codex's 3s SessionEnd budget", async () => {
  const dataDir = tempDir("cb-script-data-");
  const { origin } = await receiver();
  writeRuntimeEndpoint(origin, { dataDir });
  const script = installCodexForwarder({
    dataDir,
    sourcePath: resolveNotifyScript({ name: CODEX_FORWARDER_NAME, env: {} }),
  }).path;

  const started = Date.now();
  await runScript(script, {});
  assert.ok(Date.now() - started < 2000, `forwarder took ${Date.now() - started}ms`);
});

test("every delivery carries the install id and the forwarder revision", async () => {
  const dataDir = tempDir("cb-script-data-");
  const { origin, received } = await receiver();
  writeRuntimeEndpoint(origin, { dataDir });
  const installId = rotateInstallId({ dataDir });
  const script = installCodexForwarder({
    dataDir,
    sourcePath: resolveNotifyScript({ name: CODEX_FORWARDER_NAME, env: {} }),
  }).path;

  await runScript(script, {});

  assert.equal(received[0].installId, installId);
  assert.equal(received[0].forwarderRevision, FORWARDER_REVISION);
});

test("a rotated id reaches the server without touching hooks.json", async () => {
  const dataDir = tempDir("cb-script-data-");
  const { origin, received } = await receiver();
  writeRuntimeEndpoint(origin, { dataDir });
  rotateInstallId({ dataDir });
  const script = installCodexForwarder({
    dataDir,
    sourcePath: resolveNotifyScript({ name: CODEX_FORWARDER_NAME, env: {} }),
  }).path;
  await runScript(script, {});

  const rotated = rotateInstallId({ dataDir });
  await runScript(script, {});

  assert.equal(received.length, 2);
  assert.notEqual(received[0].installId, received[1].installId);
  assert.equal(received[1].installId, rotated);
});

test("no install id yet still delivers, simply without the id header", async () => {
  const dataDir = tempDir("cb-script-data-");
  const { origin, received } = await receiver();
  writeRuntimeEndpoint(origin, { dataDir });
  const script = installCodexForwarder({
    dataDir,
    sourcePath: resolveNotifyScript({ name: CODEX_FORWARDER_NAME, env: {} }),
  }).path;

  assert.equal(await runScript(script, {}), 0);

  assert.equal(received.length, 1);
  // curl drops a header given no value, so the server sees it as absent —
  // which is exactly how an unqualifiable event should read.
  assert.equal(received[0].installId, undefined);
  assert.equal(received[0].forwarderRevision, FORWARDER_REVISION);
});
