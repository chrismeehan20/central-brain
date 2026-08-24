import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GithubCliStatus } from "@shared/types.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 8000;

/**
 * Find the `gh` binary by absolute path before trusting PATH.
 *
 * This exists for the same reason `src-tauri/src/sidecar.rs` hunts for `node`
 * by absolute path, and it is the same bug one layer up. A `.app` launched
 * from Finder or at login does not inherit a shell PATH — it gets roughly
 * `/usr/bin:/bin:/usr/sbin:/sbin` — and the sidecar spawns the server without
 * setting PATH, so the server inherits that stub. Homebrew installs `gh` to
 * `/opt/homebrew/bin/gh`, which is not in it.
 *
 * So `execFile("gh", …)` raised ENOENT in the packaged app while working
 * perfectly under `npm run dev`, which inherits the developer's shell. Every
 * `gh` call site catches and moves on, so the result was not an error anywhere:
 * it was a GitHub panel that quietly stayed empty on exactly the installs that
 * were not developer machines.
 */

/** Absolute candidates, in install-popularity order. Apple Silicon Homebrew first. */
export const GH_CANDIDATES = [
  "/opt/homebrew/bin/gh", // Homebrew, Apple Silicon
  "/usr/local/bin/gh", // Homebrew on Intel, and manual installs
  "/usr/bin/gh", // system package managers
  "/opt/local/bin/gh", // MacPorts
];

/**
 * $HOME-relative candidates, probed after the static list. A release tarball
 * unpacked by hand usually lands in one of these, and like the version-manager
 * layouts in sidecar.rs they reach PATH only through shell init, which a
 * Finder-launched app never runs.
 */
export const GH_HOME_CANDIDATES = [".local/bin/gh", "bin/gh"];

export interface FindGhDeps {
  isExecutableFile?: (p: string) => boolean;
  home?: string;
  pathVar?: string;
}

function defaultIsExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path to a usable `gh`, or null.
 *
 * PATH is consulted last rather than not at all: it is the only thing that
 * finds an install in a location nobody predicted, and it is authoritative
 * whenever the server was started from a shell (`npm run dev`, or a user
 * running the bundle directly).
 */
export function findGhBinary(deps: FindGhDeps = {}): string | null {
  const isExecutableFile = deps.isExecutableFile ?? defaultIsExecutableFile;
  const home = deps.home ?? os.homedir();
  const pathVar = deps.pathVar ?? process.env.PATH ?? "";

  for (const candidate of GH_CANDIDATES) {
    if (isExecutableFile(candidate)) return candidate;
  }
  for (const relative of GH_HOME_CANDIDATES) {
    const candidate = path.join(home, relative);
    if (isExecutableFile(candidate)) return candidate;
  }
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "gh");
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

let cachedPath: string | null | undefined;

/**
 * The resolved `gh`, looked up once per process.
 *
 * Cached because it is read on every poll of every project and the answer only
 * changes when the user installs something — `refreshGhStatus()` is the
 * explicit way to reconsider, so installing `gh` costs a button press rather
 * than an app restart.
 */
export function ghPath(): string | null {
  if (cachedPath === undefined) cachedPath = findGhBinary();
  return cachedPath;
}

/** Test seam, and what `refreshGhStatus` calls before re-inspecting. */
export function resetGhPathCache(): void {
  cachedPath = undefined;
}

export interface InspectGhDeps {
  /** Resolves the binary; returns null when `gh` is not installed anywhere we look. */
  resolve?: () => string | null;
  /** Runs `<gh> <args>`, resolving with stdout and rejecting on a non-zero exit. */
  run?: (bin: string, args: string[]) => Promise<string>;
  now?: () => number;
}

const defaultRun = async (bin: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(bin, args, { timeout: TIMEOUT_MS, cwd: os.homedir() });
  return stdout.trim();
};

/**
 * What the GitHub half of the app can actually do right now.
 *
 * Three states that used to be one empty panel. "gh missing", "gh installed but
 * signed out" and "nothing needs you" are different problems with different
 * fixes, and rendering all three as silence is the failure the Codex hook work
 * already fixed once (docs/decisions/0004): a status dashboard that cannot
 * report its own status.
 *
 * `gh auth status`'s exit code is the signal, deliberately — its human-readable
 * output has changed shape across releases, its stream has moved between stdout
 * and stderr, and none of that affects "did it exit 0". The account name is a
 * separate best-effort call, so a `gh` too old for it reports connected without
 * a name rather than reporting nothing.
 */
export async function inspectGhCli(deps: InspectGhDeps = {}): Promise<GithubCliStatus> {
  const resolve = deps.resolve ?? ghPath;
  const run = deps.run ?? defaultRun;
  const checkedAt = new Date(deps.now?.() ?? Date.now()).toISOString();

  const bin = resolve();
  if (!bin) {
    return {
      state: "missing",
      checkedAt,
      detail: "The gh CLI isn't installed, or isn't in a location this app looks in.",
    };
  }

  try {
    await run(bin, ["auth", "status"]);
  } catch (err) {
    // A non-zero exit is the documented "not logged in" answer. A spawn failure
    // is something else entirely — the binary was there a moment ago and now
    // will not run — and must not be reported as a login problem.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "EACCES") {
      resetGhPathCache();
      return {
        state: "missing",
        path: bin,
        checkedAt,
        detail: `Found gh at ${bin}, but it could not be run (${code}).`,
      };
    }
    return {
      state: "unauthenticated",
      path: bin,
      checkedAt,
      detail: "gh is installed but not signed in. Run `gh auth login` in a terminal.",
    };
  }

  let login: string | undefined;
  try {
    const out = await run(bin, ["api", "user", "--jq", ".login"]);
    if (out) login = out.split("\n")[0].trim();
  } catch {
    // Offline, or a gh without `--jq`. Connected is still the right answer.
  }

  return {
    state: "connected",
    path: bin,
    checkedAt,
    ...(login ? { login } : {}),
  };
}

let cachedStatus: GithubCliStatus = { state: "unknown" };

export function getGhStatus(): GithubCliStatus {
  return cachedStatus;
}

/** Re-resolve and re-inspect. Called at boot, and by the ⚙ panel's Re-check button. */
export async function refreshGhStatus(deps: InspectGhDeps = {}): Promise<GithubCliStatus> {
  resetGhPathCache();
  cachedStatus = await inspectGhCli(deps);
  return cachedStatus;
}

/** Test seam: drop both caches so a case starts from a known state. */
export function resetGhStatusCache(): void {
  cachedStatus = { state: "unknown" };
  resetGhPathCache();
}
