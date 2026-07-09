import chokidar from "chokidar";
import os from "node:os";
import path from "node:path";
import { runScan } from "../scan/index.js";

const WATCH_PATHS = [
  path.join(os.homedir(), ".claude", "projects"),
  path.join(os.homedir(), ".codex", "sessions"),
  path.join(os.homedir(), ".codex", "session_index.jsonl"),
];

const DEBOUNCE_MS = 2000;
let debounceTimer: NodeJS.Timeout | null = null;

function scheduleRescan() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runScan, DEBOUNCE_MS);
}

export function startWatcher(): void {
  chokidar
    .watch(WATCH_PATHS, { ignoreInitial: true, depth: 5 })
    .on("add", scheduleRescan)
    .on("change", scheduleRescan)
    .on("unlink", scheduleRescan);
}
