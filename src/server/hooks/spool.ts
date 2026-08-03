import fs from "node:fs";
import path from "node:path";
import type { HookEventPayload } from "@shared/types.js";
import { resolveDataDir } from "../appPaths.js";

/**
 * Offline spooling for Codex hook events.
 *
 * 0001's D1 made the Tauri app own the server's lifetime, and named the
 * consequence: everything derived from disk rebuilds on the next scan, but
 * *pushed* signals are gone forever. A hook that fires while the server is
 * down — during an app restart, an upgrade, a crash, the seconds after login —
 * used to be discarded by curl and never mentioned again. D1 ratified spooling
 * to close that and it was never built; this is it.
 *
 * The forwarder writes each event to its own file, tries to deliver, and keeps
 * the file only if delivery failed. The server drains on boot and on a timer.
 * One file per event, because appending to a shared log makes two concurrent
 * hooks interleave and makes partial writes unparseable.
 *
 * Payloads can contain tool arguments, so spool files are 0600 inside a 0700
 * directory in the private app-data dir, and expire quickly.
 */

export const SPOOL_DIR_NAME = "spool";

/** Files older than this are dropped undelivered — a day-old permission prompt is noise, not news. */
export const SPOOL_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Ceiling on the queue. Reached only if the server stays down for a very long
 * time; past it the forwarder stops adding rather than filling the disk, and
 * the drain trims the oldest. Newest events are the useful ones.
 */
export const SPOOL_MAX_FILES = 500;

export function spoolDir(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, SPOOL_DIR_NAME);
}

export function pendingDir(dataDir: string = resolveDataDir()): string {
  return path.join(spoolDir(dataDir), "pending");
}

/** Files we could not parse. Kept rather than deleted, so a bug leaves evidence. */
export function quarantineDir(dataDir: string = resolveDataDir()): string {
  return path.join(spoolDir(dataDir), "quarantine");
}

export function ensureSpoolDirs(dataDir: string = resolveDataDir()): void {
  for (const dir of [spoolDir(dataDir), pendingDir(dataDir), quarantineDir(dataDir)]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export interface SpoolCounts {
  pending: number;
  quarantined: number;
}

export function spoolCounts(dataDir: string = resolveDataDir()): SpoolCounts {
  return {
    pending: countFiles(pendingDir(dataDir)),
    quarantined: countFiles(quarantineDir(dataDir)),
  };
}

function countFiles(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export interface DrainResult {
  delivered: number;
  quarantined: number;
  expired: number;
  /** Dropped because the queue was over SPOOL_MAX_FILES. */
  trimmed: number;
}

export interface DrainOptions {
  dataDir?: string;
  now?: number;
  maxAgeMs?: number;
  maxFiles?: number;
  /**
   * Handles one spooled event. Rejecting leaves the file claimed but unmoved,
   * so it is retried on the next pass rather than lost.
   */
  handle: (payload: HookEventPayload) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Process everything waiting, oldest first.
 *
 * Each file is claimed by renaming it before it is read: rename is atomic, so
 * a boot drain racing the interval drain cannot both take the same event, and
 * a claim that fails simply means someone else got there.
 *
 * Deduplication is deliberately not attempted here. The one case that can
 * duplicate is a delivery the server received and acted on before the
 * connection dropped, which the forwarder then spools — and `handleHookEvent`
 * is idempotent for exactly those events: attention items upsert by
 * `<session>:<kind>` and clearing events filter by session, so a replay
 * converges on the same state instead of stacking. An in-process id set could
 * not catch that case anyway, since the replay usually happens in a *later*
 * process.
 */
export async function drainSpool(opts: DrainOptions): Promise<DrainResult> {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? SPOOL_MAX_AGE_MS;
  const maxFiles = opts.maxFiles ?? SPOOL_MAX_FILES;
  const log = opts.log ?? (() => {});
  const result: DrainResult = { delivered: 0, quarantined: 0, expired: 0, trimmed: 0 };

  const dir = pendingDir(dataDir);
  let names: string[];
  try {
    // By mtime, not by name: the forwarder's filenames carry an epoch prefix
    // for legibility but end in a random suffix, so sorting them as strings
    // would shuffle events within a second — and would put the trim below on
    // the wrong files entirely.
    names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ name, mtimeMs: mtimeOf(path.join(dir, name)) }))
      .filter((entry) => entry.mtimeMs !== undefined)
      .sort((a, b) => a.mtimeMs! - b.mtimeMs!)
      .map((entry) => entry.name);
  } catch {
    return result; // no spool directory yet — nothing has ever failed to deliver
  }

  // Oldest first, and past the cap the oldest are dropped rather than replayed:
  // a queue this long means a long outage, and the recent events are the ones
  // that still describe reality.
  const overflow = Math.max(0, names.length - maxFiles);
  for (const name of names.slice(0, overflow)) {
    if (remove(path.join(dir, name))) result.trimmed++;
  }

  for (const name of names.slice(overflow)) {
    const file = path.join(dir, name);
    const claimed = `${file}.claimed`;
    try {
      fs.renameSync(file, claimed);
    } catch {
      continue; // another drain took it, or it expired between readdir and here
    }

    let raw: string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(claimed);
      raw = fs.readFileSync(claimed, "utf8");
    } catch {
      continue;
    }

    if (now - stat.mtimeMs > maxAgeMs) {
      remove(claimed);
      result.expired++;
      continue;
    }

    let payload: HookEventPayload;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isHookPayload(parsed)) throw new Error("not a hook event payload");
      payload = parsed;
    } catch (err) {
      quarantine(claimed, quarantineDir(dataDir), name);
      result.quarantined++;
      log(`Quarantined an unreadable spooled hook event (${name}): ${(err as Error).message}`);
      continue;
    }

    try {
      await opts.handle(payload);
    } catch (err) {
      // Put it back rather than dropping it — a handler that threw once may
      // well succeed next pass, and losing the event is the failure we are
      // here to prevent.
      try {
        fs.renameSync(claimed, file);
      } catch {
        /* the next pass will find it under either name */
      }
      log(`Could not process a spooled hook event (${name}): ${(err as Error).message}`);
      continue;
    }

    remove(claimed);
    result.delivered++;
  }

  return result;
}

/** The same shape the live route insists on, so the spool can't smuggle junk past it. */
function isHookPayload(value: unknown): value is HookEventPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.session_id === "string" && typeof candidate.hook_event_name === "string";
}

function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined; // vanished between readdir and stat — not ours to worry about
  }
}

function remove(file: string): boolean {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function quarantine(claimed: string, dir: string, name: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.renameSync(claimed, path.join(dir, name));
  } catch {
    remove(claimed); // couldn't keep the evidence; still must not retry forever
  }
}
