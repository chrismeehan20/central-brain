#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const LABEL = "com.chrismeehan.centralbrain";
const PLIST_DEST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function main() {
  if (!fs.existsSync(PLIST_DEST)) {
    console.log("central-brain isn't installed as a background service — nothing to do.");
    return;
  }

  try {
    execFileSync("launchctl", ["unload", PLIST_DEST], { stdio: "inherit" });
  } catch {
    // may already be unloaded
  }
  fs.unlinkSync(PLIST_DEST);
  console.log("central-brain background service removed.");
}

main();
