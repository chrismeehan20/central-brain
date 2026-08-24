import type { AttentionItem, AttentionType, Project } from "@shared/types.js";
import { attentionDb, getPreferences } from "../store/db.js";
import { bus } from "../events/bus.js";
import { notify, type NotifyOptions } from "../alert/notifier.js";
import { PRIORITY_BY_TYPE, type AttentionStoreLike } from "../alert/attention.js";
import { getCachedProjects } from "../scan/index.js";
import {
  classifyPr,
  fetchAuthoredPrs,
  resolveWatchedRepos,
  toAttentionPr,
  type RemotePrJson,
} from "../github/remotePrs.js";

/**
 * Turns your open pull requests into attention rows, so work done by a Claude
 * session running in the cloud is visible here at all.
 *
 * The scanners and the hook pipeline are both local-only by construction —
 * ~/.claude/projects for transcripts, 127.0.0.1 for hook events — and a cloud
 * session can reach neither. Its PRs are the one artifact that crosses back.
 * See github/remotePrs.ts for what counts as needing you and why.
 *
 * Everything here is *polled*, which is the important structural difference
 * from hook events: rows are re-derived from GitHub every pass, so this module
 * owns them completely. It creates them, updates them in place, and — unlike
 * the pushed path, where only a later event can clear a row — deletes them the
 * moment the PR stops qualifying. A merged PR's row disappears on its own.
 */

const POLL_MS = Number(process.env.REMOTE_PR_POLL_MS ?? 10 * 60_000);

/**
 * After a pass where every single repo failed, wait this long instead of the
 * normal interval. That shape of failure is not a blip: it is `gh` missing,
 * `gh auth` expired, or no network — none of which fix themselves inside ten
 * minutes, and all of which would otherwise cost 25 doomed subprocesses per
 * pass forever. Any success resets it.
 */
const BACKOFF_MS = 60 * 60_000;

/** Rows this module owns. Anything else in the store belongs to a hook or the Codex heuristic. */
const PR_TYPES = new Set<AttentionType>(["pr-conflict", "pr-ci-failed", "pr-review"]);

/** More than this many new rows in one pass gets a single summary banner instead of a pile. */
const NOTIFY_INDIVIDUALLY_MAX = 2;

export interface RemoteWorkContext {
  projects: () => Project[];
  extraRepos: () => string[];
  fetch: (repo: string) => Promise<RemotePrJson[]>;
  store: AttentionStoreLike;
  notify: (opts: NotifyOptions) => Promise<void>;
  emit: (items: AttentionItem[]) => void;
  now: () => number;
  log: (message: string) => void;
  /** Set after a total-failure pass; passes before this instant do nothing. Mutable state, per context. */
  skipUntil: number;
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "unknown error");
  return message.split("\n")[0].slice(0, 200);
}

export function createRemoteWorkContext(
  overrides: Partial<RemoteWorkContext> = {},
): RemoteWorkContext {
  return {
    projects: () => getCachedProjects(),
    extraRepos: () => getPreferences().remoteRepos,
    fetch: (repo) => fetchAuthoredPrs(repo),
    store: attentionDb,
    notify,
    emit: (items) => void bus.emit("attention:update", items),
    now: () => Date.now(),
    log: (message) => console.error(message),
    skipUntil: 0,
    ...overrides,
  };
}

/** The fields a pass derives from GitHub. Everything else on the row is bookkeeping we preserve. */
type DerivedRow = Pick<AttentionItem, "type" | "priority" | "message" | "projectPath" | "pr">;

function differs(item: AttentionItem, next: DerivedRow): boolean {
  return (
    item.type !== next.type ||
    item.priority !== next.priority ||
    item.message !== next.message ||
    item.projectPath !== next.projectPath ||
    item.pr?.title !== next.pr?.title ||
    item.pr?.isDraft !== next.pr?.isDraft ||
    item.pr?.branch !== next.pr?.branch
  );
}

/** Returns true if the attention list changed. Exported for tests. */
export async function runRemoteWorkPass(ctx: RemoteWorkContext): Promise<boolean> {
  const now = ctx.now();
  if (now < ctx.skipUntil) return false;

  const watched = resolveWatchedRepos(ctx.projects(), ctx.extraRepos());
  const derived = new Map<string, DerivedRow>();
  const fetched = new Set<string>();
  let firstError: unknown;

  for (const [repo, projectPath] of watched) {
    let prs: RemotePrJson[];
    try {
      prs = await ctx.fetch(repo);
    } catch (err) {
      firstError ??= err;
      // Could not ask — a private repo `gh` can't see, a transient network
      // failure. Deliberately NOT recorded as fetched, so this repo's existing
      // rows survive below instead of being read as "resolved".
      continue;
    }
    fetched.add(repo);
    for (const pr of prs) {
      const verdict = classifyPr(pr, now);
      if (!verdict) continue;
      derived.set(`pr:${repo}#${pr.number}`, {
        type: verdict.type,
        priority: PRIORITY_BY_TYPE[verdict.type],
        message: verdict.message,
        projectPath,
        pr: toAttentionPr(repo, pr),
      });
    }
  }

  // Every repo failed and there was something to ask: stand down for an hour
  // rather than hammering a broken `gh` every ten minutes.
  if (watched.size > 0 && fetched.size === 0) {
    ctx.skipUntil = now + BACKOFF_MS;
    // Said out loud, once per backoff, because the alternative is a feature
    // that is indistinguishable from "you have no PRs that need you". Missing
    // `gh`, an expired `gh auth`, and a rejected `--json` field all land here.
    ctx.log(`remote PR poll: every repo failed, backing off for an hour — ${describe(firstError)}`);
    return false;
  }
  ctx.skipUntil = 0;

  const nowIso = new Date(now).toISOString();
  let changed = false;

  // Drop rows the world no longer justifies: PR merged, CI went green, repo
  // un-watched. Rows for a repo we could not reach this pass are kept — the
  // absence of an answer is not an answer.
  const before = ctx.store.data.items.length;
  ctx.store.data.items = ctx.store.data.items.filter((item) => {
    if (!PR_TYPES.has(item.type)) return true;
    const repo = item.pr?.repo;
    if (!repo || !watched.has(repo)) return false;
    if (!fetched.has(repo)) return true;
    return derived.has(item.id);
  });
  if (ctx.store.data.items.length !== before) changed = true;

  const created: Array<{ id: string; row: DerivedRow }> = [];
  for (const [id, row] of derived) {
    const existing = ctx.store.data.items.find((i) => i.id === id);
    if (!existing) {
      ctx.store.data.items.push({
        id,
        // No session exists to point at — the work happened in a container that
        // no longer exists. The synthetic id keeps this row out of the way of
        // `clearSession`, which matches hook rows by session id.
        sessionId: id,
        tool: "github",
        ...row,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      created.push({ id, row });
      changed = true;
      continue;
    }
    if (differs(existing, row)) {
      // `snoozedUntil` and `createdAt` survive: a PR going from red to
      // conflicted is the same PR, still snoozed, first seen when it was first
      // seen. Only a genuine change bumps `updatedAt`, so the row's age in the
      // panel means "since this last changed", not "since the last poll".
      Object.assign(existing, row, { updatedAt: nowIso });
      changed = true;
    }
  }

  if (changed) {
    await ctx.store.write();
    ctx.emit(ctx.store.data.items);
  }
  await announce(ctx, created);
  return changed;
}

async function announce(
  ctx: RemoteWorkContext,
  created: Array<{ id: string; row: DerivedRow }>,
): Promise<void> {
  if (created.length === 0) return;
  // A first pass after the app has been off for a while can qualify a dozen PRs
  // at once. Twelve banners is not twelve times the signal.
  if (created.length > NOTIFY_INDIVIDUALLY_MAX) {
    await ctx
      .notify({
        title: `${created.length} pull requests need you`,
        body: created
          .map(({ row }) => `${row.pr!.repo}#${row.pr!.number}`)
          .join(", "),
        sound: false,
      })
      .catch(() => {});
    return;
  }
  for (const { row } of created) {
    await ctx
      .notify({
        title: `${row.pr!.repo}#${row.pr!.number} needs you`,
        body: `${row.message} — ${row.pr!.title}`,
        sound: row.priority === "high",
      })
      .catch(() => {});
  }
}

/**
 * Depends on `runScan()` having already populated the project cache — index.ts
 * calls it first, synchronously. An empty project list is read as "nothing is
 * watched", which correctly clears rows for a repo you stopped tracking, and
 * would incorrectly clear every row if the first pass ran before the scan.
 */
export function startRemoteWorkPoller(): void {
  const ctx = createRemoteWorkContext();
  runRemoteWorkPass(ctx);
  setInterval(() => runRemoteWorkPass(ctx), POLL_MS);
}
