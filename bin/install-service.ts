#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename_dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__filename_dir, "..");
const LABEL = "com.chrismeehan.centralbrain";
const PLIST_DEST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const TEMPLATE_PATH = path.join(PROJECT_DIR, "launchd", `${LABEL}.plist.template`);

function main() {
  if (!fs.existsSync(path.join(PROJECT_DIR, "dist", "server", "index.js"))) {
    console.error("dist/server/index.js not found — run `npm run build` first.");
    process.exit(1);
  }

  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const plist = template.replace(/{{NODE_PATH}}/g, process.execPath).replace(/{{PROJECT_DIR}}/g, PROJECT_DIR);

  fs.mkdirSync(path.dirname(PLIST_DEST), { recursive: true });
  fs.writeFileSync(PLIST_DEST, plist);
  console.log(`Wrote ${PLIST_DEST}`);

  try {
    execFileSync("launchctl", ["unload", PLIST_DEST], { stdio: "ignore" });
  } catch {
    // wasn't loaded yet — fine
  }
  execFileSync("launchctl", ["load", "-w", PLIST_DEST], { stdio: "inherit" });

  console.log(`central-brain is now running as a background service (${LABEL}).`);
  console.log("It will start automatically on login and restart if it crashes.");
  console.log("Open http://localhost:4317 any time.");
  console.log(`To remove it later: npm run uninstall-service`);
}

main();
