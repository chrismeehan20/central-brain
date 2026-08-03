import { handleHookEvent } from "../alert/attention.js";
import { drainSpool, ensureSpoolDirs, type DrainResult } from "../hooks/spool.js";

/**
 * Replays Codex hook events that fired while the server was down.
 *
 * Runs once at boot — the case this exists for, since the app owns the
 * server's lifetime and every restart is a window where events are pushed at
 * nothing — and then on a timer, which catches the shorter outages: a request
 * that timed out, a moment of load, a 5xx.
 */
const DRAIN_INTERVAL_MS = 60_000;

/**
 * Replayed events never fire a desktop notification.
 *
 * Coming back from a ten-minute outage with a dozen permission prompts would
 * mean a dozen pings at once for decisions mostly already made. The attention
 * rows still appear, so nothing is hidden — only the interruption is dropped.
 */
async function replay(payload: Parameters<typeof handleHookEvent>[0]): Promise<void> {
  await handleHookEvent(payload, "codex", { notify: async () => {}, skipLiveness: true });
}

function describe(result: DrainResult): string | undefined {
  const parts: string[] = [];
  if (result.delivered > 0) parts.push(`${result.delivered} replayed`);
  if (result.expired > 0) parts.push(`${result.expired} expired`);
  if (result.trimmed > 0) parts.push(`${result.trimmed} dropped (queue full)`);
  if (result.quarantined > 0) parts.push(`${result.quarantined} quarantined`);
  return parts.length > 0 ? `spooled Codex hook events: ${parts.join(", ")}` : undefined;
}

export function startSpoolDrain(log: (message: string) => void = console.log): void {
  ensureSpoolDirs();

  const run = () => {
    void drainSpool({ handle: replay, log })
      .then((result) => {
        const summary = describe(result);
        if (summary) log(summary);
      })
      // Never let a drain failure take the server with it: the spool is a
      // best-effort backlog, not a critical path.
      .catch((err) => log(`could not drain the Codex hook spool: ${(err as Error).message}`));
  };

  run();
  setInterval(run, DRAIN_INTERVAL_MS).unref();
}
