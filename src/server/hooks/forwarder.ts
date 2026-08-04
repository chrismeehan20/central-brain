import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, resolveNotifyScript } from "../appPaths.js";

/**
 * Where the Codex hook forwarder lives once installed, and how the server
 * tells it which port to talk to.
 *
 * Both exist for the same reason: Codex keys hook approval to the *exact* hook
 * definition. Every byte of the command string in hooks.json is part of what
 * the user approved, so anything volatile baked into it — the path of a git
 * checkout, a versioned `.app` resource, a port number — turns an ordinary app
 * move, upgrade, or `CENTRAL_BRAIN_PORT` change into a silently dead pipeline
 * that can only be revived by making the user re-approve.
 *
 * So the installed command names one path that never changes:
 *
 *   <data dir>/hooks/notify-codex.sh
 *
 * and the script discovers the endpoint at delivery time from
 *
 *   <data dir>/runtime/endpoint
 *
 * which it finds relative to itself. Upgrading the app rewrites the script in
 * place; changing the port rewrites one line of text. Neither touches
 * hooks.json, so neither costs an approval.
 */

/** Subdirectory of the data dir holding the installed forwarder scripts. */
export const FORWARDER_DIR_NAME = "hooks";

/** Subdirectory of the data dir holding the running server's endpoint. */
export const RUNTIME_DIR_NAME = "runtime";

export const CODEX_FORWARDER_NAME = "notify-codex.sh";

export function forwarderDir(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, FORWARDER_DIR_NAME);
}

/** The stable path the Codex hook definition points at. */
export function codexForwarderPath(dataDir: string = resolveDataDir()): string {
  return path.join(forwarderDir(dataDir), CODEX_FORWARDER_NAME);
}

export function runtimeDir(dataDir: string = resolveDataDir()): string {
  return path.join(dataDir, RUNTIME_DIR_NAME);
}

export function runtimeEndpointPath(dataDir: string = resolveDataDir()): string {
  return path.join(runtimeDir(dataDir), "endpoint");
}

export class ForwarderInstallError extends Error {}

/**
 * Quote a path for POSIX `sh`.
 *
 * The old command was built with double quotes, which is wrong for any path
 * containing `$`, a backtick, a backslash or a double quote — all legal in a
 * macOS home directory name, and `$` is not even unusual. Single quotes are
 * literal in `sh` with exactly one exception, the single quote itself, which
 * is escaped by closing the string, emitting an escaped quote, and reopening.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Write `contents` to `target` via a same-directory temp file and an atomic rename. */
function writeAtomic(target: string, contents: string, mode: number): void {
  const dir = path.dirname(target);
  // `process.pid` keeps concurrent writers (server boot racing a CLI install)
  // off each other's temp file; the rename itself is what makes it atomic.
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, contents, { mode });
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export interface ForwarderInstallOptions {
  /** Defaults to the resolved data dir; tests pass a temp dir. */
  dataDir?: string;
  /** Defaults to the shipped `hooks/notify-codex.sh`; tests pass a fixture. */
  sourcePath?: string;
}

export interface ForwarderInstallResult {
  /** Absolute path of the installed copy — what the hook definition names. */
  path: string;
  /** True when this call actually wrote; false when the copy was already current. */
  updated: boolean;
}

/**
 * Copy the shipped forwarder into the data dir, if it isn't already there and
 * identical.
 *
 * Called on every server boot, so a new app version's script lands without any
 * user action, and at install time, so the CLI installer works with no server
 * running.
 *
 * A missing source is only fatal when there is nothing installed yet: a
 * bundled server that cannot find its own `hooks/` directory must not delete
 * or invalidate a copy that is already working.
 */
export function installCodexForwarder(opts: ForwarderInstallOptions = {}): ForwarderInstallResult {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const target = codexForwarderPath(dataDir);
  const sourcePath = opts.sourcePath ?? resolveNotifyScript({ name: CODEX_FORWARDER_NAME });

  let source: string;
  try {
    source = fs.readFileSync(sourcePath, "utf8");
  } catch (err) {
    if (fs.existsSync(target)) return { path: target, updated: false };
    throw new ForwarderInstallError(
      `Could not read the Codex hook forwarder at ${sourcePath}, and none is installed at ${target}.\n` +
        `  ${(err as Error).message}\n` +
        `Set CENTRAL_BRAIN_HOOKS_DIR to the directory holding ${CODEX_FORWARDER_NAME}.`
    );
  }

  let installed: string | undefined;
  try {
    installed = fs.readFileSync(target, "utf8");
  } catch {
    installed = undefined; // not installed yet
  }
  if (installed === source) return { path: target, updated: false };

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeAtomic(target, source, 0o755);
  return { path: target, updated: true };
}

/**
 * Publish the endpoint the forwarder should POST to.
 *
 * Written on boot, after the listen succeeds — advertising an endpoint nothing
 * is listening on would just turn a startup failure into silently dropped
 * events. The value is a bare origin (`http://127.0.0.1:4317`); the script
 * appends the path, so the file stays something a human can read and edit.
 */
export function writeRuntimeEndpoint(origin: string, opts: { dataDir?: string } = {}): string {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const target = runtimeEndpointPath(dataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeAtomic(target, `${origin.replace(/\/+$/, "")}\n`, 0o600);
  return target;
}

/** The published endpoint, or undefined when no server has booted since install. */
export function readRuntimeEndpoint(opts: { dataDir?: string } = {}): string | undefined {
  return readRuntimeFile(runtimeEndpointPath(opts.dataDir ?? resolveDataDir()));
}

function readRuntimeFile(target: string): string | undefined {
  try {
    const raw = fs.readFileSync(target, "utf8").trim();
    return raw === "" ? undefined : raw;
  } catch {
    return undefined;
  }
}

/**
 * The forwarder's protocol version, sent with every delivery and bumped when
 * the script's contract changes.
 *
 * It exists so a receipt can be attributed to a script we still understand. An
 * app upgrade rewrites the installed forwarder (see installCodexForwarder), so
 * without this a receipt from the *previous* script would keep vouching for a
 * pipeline that the upgrade may have changed.
 */
export const FORWARDER_REVISION = "3";

/**
 * Revisions whose receipts we accept as proof the pipeline works.
 *
 * Includes the previous revision: 2 differed only by not spooling, and its
 * deliveries were identical on the wire, so refusing them would cost a
 * re-verification that proves nothing.
 */
export const SUPPORTED_FORWARDER_REVISIONS: ReadonlySet<string> = new Set([FORWARDER_REVISION, "2"]);

export function installIdPath(dataDir: string = resolveDataDir()): string {
  return path.join(runtimeDir(dataDir), "install-id");
}

/**
 * Identity of the current hook wiring — the thing a receipt has to match
 * before it counts as evidence.
 *
 * Rotated whenever the installed hook definitions change (install, repair, or
 * uninstall), so events collected under the *previous* wiring stop vouching
 * for the new one. Without it, "we heard from Codex once, six days ago" reads
 * identically to "Codex is talking to us right now", and the dashboard says
 * Connected either way.
 */
export function readInstallId(opts: { dataDir?: string } = {}): string | undefined {
  return readRuntimeFile(installIdPath(opts.dataDir ?? resolveDataDir()));
}

function writeInstallId(dataDir: string, id: string): string {
  const target = installIdPath(dataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeAtomic(target, `${id}\n`, 0o600);
  return id;
}

/** Mint a new identity, invalidating every receipt collected under the old one. */
export function rotateInstallId(opts: { dataDir?: string } = {}): string {
  return writeInstallId(opts.dataDir ?? resolveDataDir(), crypto.randomUUID());
}

/** The current identity, creating one on first run. */
export function ensureInstallId(opts: { dataDir?: string } = {}): string {
  const dataDir = opts.dataDir ?? resolveDataDir();
  return readInstallId({ dataDir }) ?? writeInstallId(dataDir, crypto.randomUUID());
}
