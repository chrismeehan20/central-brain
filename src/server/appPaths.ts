import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the server's *own* files live: the lowdb JSON stores, the built client,
 * the hook forwarder scripts.
 *
 * This is deliberately separate from scan/paths.ts, which canonicalises the
 * paths of the *projects* we watch — a different concern entirely.
 *
 * Every resolver here takes its inputs (env, platform, home dir, module dir) as
 * parameters so the logic is testable on any platform without mocking globals;
 * the defaults make them zero-arg for production callers.
 *
 * The `CENTRAL_BRAIN_*_DIR` env vars exist because the next step bundles this
 * server into a single JS file that the Tauri menubar app spawns as a sidecar.
 * A bundle has one `__dirname` for what used to be three modules at three
 * different depths, and inside a `.app` it isn't even in the repo — so it cannot
 * infer any of these. The Tauri app sets the env vars to point at its own
 * resource and app-data directories, and those always win.
 */

/** Directory name we own inside the platform's user-data dir. */
export const APP_DIR_NAME = "central-brain";

/** This module's directory: `src/server` under tsx, `dist/server` when built, the bundle's dir when bundled. */
const thisModuleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * An env var set to "" or "   " is unset, not a path to the filesystem root or
 * to the cwd. Launchd plists, Tauri sidecar configs and shell wrappers all
 * produce empty values by accident; honouring one would put the data dir
 * somewhere catastrophic.
 */
function envPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** First candidate that contains `marker`, or undefined. Candidates are already absolute. */
function firstContaining(candidates: string[], marker: string): string | undefined {
  return candidates.find((dir) => fs.existsSync(path.join(dir, marker)));
}

export interface DataDirInputs {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  homedir?: string;
}

/**
 * Where the lowdb JSON stores live.
 *
 * Not the repo's `data/` directory: an installed menubar app's files have to
 * survive updates and cannot live inside a read-only `.app` bundle. Per the
 * ratified "fresh start" decision there is no migration from the old location —
 * `data/` is simply left alone.
 */
export function resolveDataDir({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
}: DataDirInputs = {}): string {
  const override = envPath(env.CENTRAL_BRAIN_DATA_DIR);
  if (override) return override;

  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", APP_DIR_NAME);
  }
  if (platform === "win32") {
    const appData = envPath(env.APPDATA);
    return appData
      ? path.join(appData, APP_DIR_NAME)
      : path.join(homedir, "AppData", "Roaming", APP_DIR_NAME);
  }
  const xdgDataHome = envPath(env.XDG_DATA_HOME);
  return xdgDataHome
    ? path.join(xdgDataHome, APP_DIR_NAME)
    : path.join(homedir, ".local", "share", APP_DIR_NAME);
}

/**
 * Client-dist candidates, relative to the module doing the asking, most likely
 * first. Probed rather than hardcoded because the same code runs from three
 * layouts (tsx dev, `dist/server/index.js`, a single-file bundle).
 *
 * `../../dist/client` is first because it is correct for BOTH repo layouts:
 * from `src/server` and from `dist/server` it lands on `<repo>/dist/client`,
 * which is where `vite build` writes (see vite.config.ts `build.outDir`).
 */
const CLIENT_DIR_CANDIDATES = [
  "../../dist/client", // src/server (tsx dev) and dist/server (built) both land here
  "../client", // a bundle one level below its client dir
  "client", // a bundle sitting beside its client dir
  "../dist/client", // a bundle at the repo root
];

export interface ClientDirInputs {
  env?: NodeJS.ProcessEnv;
  moduleDir?: string;
}

/**
 * Where the built client (`index.html`, `assets/`) lives.
 *
 * Returns the most likely candidate rather than throwing when nothing is built,
 * so a missing client shows up as a 404 from fastify-static instead of killing
 * the server at startup.
 */
export function resolveClientDir({ env = process.env, moduleDir = thisModuleDir }: ClientDirInputs = {}): string {
  const override = envPath(env.CENTRAL_BRAIN_CLIENT_DIR);
  if (override) return override;

  const candidates = CLIENT_DIR_CANDIDATES.map((rel) => path.resolve(moduleDir, rel));
  return firstContaining(candidates, "index.html") ?? candidates[0];
}

/** Hooks-dir candidates, same reasoning as CLIENT_DIR_CANDIDATES. `<repo>/hooks` is at the same depth from src/server and dist/server. */
const HOOKS_DIR_CANDIDATES = [
  "../../hooks", // src/server and dist/server
  "../hooks", // a bundle in dist/
  "hooks", // a bundle at the repo root
  "../../../hooks", // src/server/<subdir> and dist/server/<subdir>
];

export interface NotifyScriptInputs {
  /** Script filename, e.g. "notify.sh" or "notify-codex.sh". */
  name: string;
  env?: NodeJS.ProcessEnv;
  moduleDir?: string;
}

/**
 * Absolute path to a hook forwarder script in `hooks/`.
 *
 * Probes for the named script so the answer is right for whichever layout we
 * are running from; returns the most likely candidate if it is nowhere to be
 * found, letting the caller report a missing-file error with a real path in it.
 */
export function resolveNotifyScript({
  name,
  env = process.env,
  moduleDir = thisModuleDir,
}: NotifyScriptInputs): string {
  const override = envPath(env.CENTRAL_BRAIN_HOOKS_DIR);
  if (override) return path.join(override, name);

  const candidates = HOOKS_DIR_CANDIDATES.map((rel) => path.resolve(moduleDir, rel));
  return path.join(firstContaining(candidates, name) ?? candidates[0], name);
}
