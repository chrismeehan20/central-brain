import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { resolveClientDir } from "./appPaths.js";
import { watchParent } from "./parentWatch.js";
import { dataDir } from "./store/db.js";
import { runScan } from "./scan/index.js";
import { projectsRoutes } from "./routes/projects.js";
import { detailsRoutes } from "./routes/details.js";
import { hookRoutes } from "./routes/hook.js";
import { settingsRoutes } from "./routes/settings.js";
import { streamRoutes } from "./routes/stream.js";
import { openRoutes } from "./routes/open.js";
import { hooksSetupRoutes } from "./routes/hooksSetup.js";
import { startWatcher } from "./watch/watcher.js";
import { startCodexStalenessPoll } from "./poll/codexStaleness.js";
import { startGithubPoller } from "./poll/githubPoller.js";
import { startSummaryPoller } from "./poll/summaryPoller.js";
import { startDetailPoller } from "./poll/detailPoller.js";
import { ensureInstallId, installCodexForwarder, writeRuntimeEndpoint } from "./hooks/forwarder.js";
import { startSpoolDrain } from "./poll/spoolDrain.js";

const PORT = Number(process.env.PORT ?? 4317);
const SCAN_INTERVAL_MS = 3 * 60 * 1000;

const app = Fastify({ logger: true });

app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));
await app.register(projectsRoutes);
await app.register(detailsRoutes);
await app.register(hookRoutes);
await app.register(settingsRoutes);
await app.register(streamRoutes);
await app.register(openRoutes);
await app.register(hooksSetupRoutes);

// Registered in every mode: dev serves the same built client, and the Tauri
// sidecar points CENTRAL_BRAIN_CLIENT_DIR at its bundled resources.
const clientDist = resolveClientDir();
await app.register(fastifyStatic, {
  root: clientDist,
  wildcard: false,
});
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url?.startsWith("/api")) {
    reply.code(404).send({ error: "not found" });
    return;
  }
  reply.sendFile("index.html");
});

// Die with our parent when spawned as the Tauri sidecar, so a killed app
// cannot leave an orphan holding this port.
const watchingParent = watchParent();

/**
 * Refresh the two files the Codex hook forwarder depends on: the forwarder
 * script itself (so an app upgrade upgrades it without rewriting hooks.json,
 * which would cost the user a re-approval) and the endpoint it POSTs to (so a
 * changed PORT needs no reinstall at all).
 *
 * Best-effort by design. Neither file is required for the dashboard to work,
 * and a read-only or missing data dir must degrade to "hooks stop arriving",
 * never to "the server won't start".
 */
function publishHookRuntime(): void {
  try {
    const endpointPath = writeRuntimeEndpoint(`http://127.0.0.1:${PORT}`);
    // Created on first run and left alone afterwards — only install, repair
    // and uninstall rotate it, because only those change what is wired up.
    ensureInstallId();
    app.log.info(`central-brain hook endpoint published: ${endpointPath}`);
  } catch (err) {
    app.log.warn({ err }, "could not publish the hook endpoint — Codex events may go to a stale port");
  }
  try {
    const { path: forwarderPath, updated } = installCodexForwarder();
    if (updated) app.log.info(`central-brain Codex hook forwarder updated: ${forwarderPath}`);
  } catch (err) {
    app.log.warn({ err }, "could not install the Codex hook forwarder");
  }
}

app
  .listen({ port: PORT, host: "127.0.0.1" })
  .then(() => {
    app.log.info(`central-brain listening on http://localhost:${PORT}`);
    // The only diagnostic anyone gets when a packaged app resolves these wrong.
    app.log.info(`central-brain data dir: ${dataDir}`);
    app.log.info(`central-brain client dir: ${clientDist}`);
    app.log.info(`central-brain parent watchdog: ${watchingParent ? "armed" : "off"}`);
    publishHookRuntime();
    runScan();
    setInterval(runScan, SCAN_INTERVAL_MS);
    startWatcher();
    startCodexStalenessPoll();
    startGithubPoller();
    startSummaryPoller();
    startDetailPoller();
    startSpoolDrain((m) => app.log.info(m));
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
