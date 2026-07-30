import type { EventEmitter } from "node:events";

/**
 * Exit when the process that spawned us goes away.
 *
 * The Tauri app spawns this server as a child and kills it on a clean quit, but
 * a clean quit is not the only way an app dies. Measured: sending SIGTERM to the
 * packaged app left the server running and still holding port 4317. That orphan
 * is worse than a crash, because the next launch *probe-then-attaches* to it —
 * so the app would silently talk to a stale server running the previous build.
 *
 * The mechanism is the standard one: the parent hands us a stdin pipe and never
 * writes to it. While the parent lives the pipe stays open; when it dies for any
 * reason — quit, SIGTERM, SIGKILL, crash — the OS closes the write end and we
 * see EOF. No signal handling, no PID polling, no platform-specific code.
 *
 * Only armed when the parent explicitly asks for it, so `npm run dev` and a
 * plain `node dist/server-bundle.mjs` are unaffected (an interactive shell's
 * stdin would otherwise close and take the server with it).
 */

export interface ParentWatchOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected for testing; defaults to the real `process.stdin`. */
  stdin?: EventEmitter & { resume?: () => void };
  /** Injected for testing; defaults to exiting the process. */
  onParentGone?: () => void;
}

export const PARENT_WATCH_ENV = "CENTRAL_BRAIN_WATCH_PARENT";

/**
 * Returns true if the watch was armed. Callers can log that, since a silently
 * un-armed watchdog is indistinguishable from a working one until an orphan
 * appears.
 */
export function watchParent({
  env = process.env,
  stdin = process.stdin,
  onParentGone,
}: ParentWatchOptions = {}): boolean {
  if (env[PARENT_WATCH_ENV] !== "1") return false;

  const exit =
    onParentGone ??
    (() => {
      // The parent is gone, so there is nobody left to serve. Leave a trace in
      // case someone is reading logs, then go.
      console.error("central-brain: parent process exited, shutting down");
      process.exit(0);
    });

  let fired = false;
  const once = () => {
    if (fired) return;
    fired = true;
    exit();
  };

  // `end` is the normal EOF; `close` covers the pipe being torn down without a
  // clean end event. Either means the write end is gone.
  stdin.on("end", once);
  stdin.on("close", once);
  // A paused stream never emits `end`, and stdin starts paused.
  stdin.resume?.();

  return true;
}
