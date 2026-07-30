import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { resolveClientDir } from "./appPaths.js";
import { dataDir } from "./store/db.js";
import { runScan } from "./scan/index.js";
import { projectsRoutes } from "./routes/projects.js";
import { detailsRoutes } from "./routes/details.js";
import { hookRoutes } from "./routes/hook.js";
import { streamRoutes } from "./routes/stream.js";
import { startWatcher } from "./watch/watcher.js";
import { startCodexStalenessPoll } from "./poll/codexStaleness.js";
import { startGithubPoller } from "./poll/githubPoller.js";
import { startSummaryPoller } from "./poll/summaryPoller.js";
import { startDetailPoller } from "./poll/detailPoller.js";

const PORT = Number(process.env.PORT ?? 4317);
const SCAN_INTERVAL_MS = 3 * 60 * 1000;

const app = Fastify({ logger: true });

app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));
await app.register(projectsRoutes);
await app.register(detailsRoutes);
await app.register(hookRoutes);
await app.register(streamRoutes);

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

app
  .listen({ port: PORT, host: "127.0.0.1" })
  .then(() => {
    app.log.info(`central-brain listening on http://localhost:${PORT}`);
    // The only diagnostic anyone gets when a packaged app resolves these wrong.
    app.log.info(`central-brain data dir: ${dataDir}`);
    app.log.info(`central-brain client dir: ${clientDist}`);
    runScan();
    setInterval(runScan, SCAN_INTERVAL_MS);
    startWatcher();
    startCodexStalenessPoll();
    startGithubPoller();
    startSummaryPoller();
    startDetailPoller();
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
