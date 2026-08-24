/**
 * Selectors for the consolidated cross-project views: every open PR, global
 * recent activity, and sessions that look live right now.
 *
 * Hidden projects stay hidden: every selector here starts from
 * `visibleProjects`, so a hidden (or missing) project contributes nothing to
 * any consolidated list. The one deliberate exception is attention rows with
 * `projectPath: "unknown"` — those come from repos the user explicitly asked
 * to watch (`Preferences.remoteRepos`) or hook events with no cwd; there is no
 * project to carry a hidden flag, and dropping them would make the watch
 * feature lie.
 *
 * Deliberately dependency-free, same as sections.ts: only *type* imports, so
 * `node:test` can run this file without the `@shared` vite alias existing at
 * runtime. A single runtime import here breaks `npm test`.
 */
import type { AttentionItem, Project, SessionRef, SourceTool } from "@shared/types";

/**
 * The projects consolidated views are allowed to see. `missing` is excluded
 * too: the GitHub poller skips missing paths, so anything they'd contribute
 * is stale, and they already have their own triage section.
 */
export function visibleProjects(projects: Project[]): Project[] {
  return projects.filter((p) => !p.hidden && !p.missing);
}

/** Parse `owner/repo` out of a github.com PR url. Null for anything else. */
export function repoSlugFromPrUrl(url: string | undefined): string | null {
  if (!url) return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

export interface PrRow {
  projectPath: string;
  projectName: string;
  /** Absent when the cached status predates the url field. */
  repoSlug?: string;
  number: number;
  title: string;
  isDraft: boolean;
  ciStatus?: string;
  url?: string;
  updatedAt?: string;
  headRefName?: string;
  author?: string;
  /** The attention row backing this PR, when one exists — drives the badge. */
  attention?: AttentionItem;
}

/**
 * Index unsnoozed PR attention rows by their id key (`pr:<owner/repo>#<n>`),
 * so a flat PR row can pick up its conflict/CI/review verdict.
 */
export function attentionByPrKey(items: AttentionItem[], now: Date): Map<string, AttentionItem> {
  const map = new Map<string, AttentionItem>();
  for (const item of items) {
    if (!item.pr) continue;
    if (item.snoozedUntil && Date.parse(item.snoozedUntil) > now.getTime()) continue;
    map.set(`pr:${item.pr.repo}#${item.pr.number}`, item);
  }
  return map;
}

/**
 * Every open PR across the visible projects, flattened into one list.
 *
 * Deduped by url (fallback `slug#number`): repo grouping already folds
 * same-origin checkouts into one card, so duplicates should be rare — this is
 * belt-and-braces against two cards reaching the same repo. Sorted problems
 * first (an attention row or red checks), then most recently updated.
 */
export function flattenOpenPrs(
  projects: Project[],
  attentionItems: AttentionItem[],
  now: Date
): PrRow[] {
  const byKey = attentionByPrKey(attentionItems, now);
  const seen = new Set<string>();
  const rows: PrRow[] = [];
  for (const p of visibleProjects(projects)) {
    for (const pr of p.github?.openPrs ?? []) {
      const repoSlug = repoSlugFromPrUrl(pr.url) ?? undefined;
      const dedupeKey = pr.url ?? (repoSlug ? `${repoSlug}#${pr.number}` : `${p.path}#${pr.number}`);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      rows.push({
        projectPath: p.path,
        projectName: p.displayName,
        repoSlug,
        number: pr.number,
        title: pr.title,
        isDraft: pr.isDraft,
        ciStatus: pr.ciStatus,
        url: pr.url,
        updatedAt: pr.updatedAt,
        headRefName: pr.headRefName,
        author: pr.author,
        attention: repoSlug ? byKey.get(`pr:${repoSlug}#${pr.number}`) : undefined,
      });
    }
  }
  const needsYou = (r: PrRow) =>
    Boolean(r.attention) || (!r.isDraft && r.ciStatus?.toLowerCase() === "failure");
  return rows.sort((a, b) => {
    const aNeeds = needsYou(a);
    const bNeeds = needsYou(b);
    if (aNeeds !== bNeeds) return aNeeds ? -1 : 1;
    // ISO timestamps sort lexicographically; rows without one go last.
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
}

export interface GlobalActivityEntry {
  at?: string;
  projectPath: string;
  projectName: string;
  /** "claude" | "codex" | "commit" — matches the .activity__label--* styles. */
  label: SourceTool | "commit";
  text: string;
}

/** How many entries the global activity feed shows. */
export const ACTIVITY_LIMIT = 50;

/**
 * Recent work across every visible project: each project's recent sessions
 * plus its last commit, merged into one reverse-chronological feed. The same
 * shape as ProjectDetailPage's per-project activity list, tagged with the
 * project it came from.
 */
export function buildGlobalActivity(projects: Project[], limit = ACTIVITY_LIMIT): GlobalActivityEntry[] {
  const entries: GlobalActivityEntry[] = [];
  for (const p of visibleProjects(projects)) {
    for (const s of p.sessions.slice(0, 12)) {
      entries.push({
        at: s.lastActivity,
        projectPath: p.path,
        projectName: p.displayName,
        label: s.tool,
        text: s.summary ?? s.firstPrompt ?? "(session)",
      });
    }
    if (p.github?.lastCommitMessage) {
      entries.push({
        at: p.github.lastCommitDate,
        projectPath: p.path,
        projectName: p.displayName,
        label: "commit",
        text: p.github.lastCommitMessage,
      });
    }
  }
  return entries
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, limit);
}

export interface LiveSessionRow {
  projectPath: string;
  projectName: string;
  session: SessionRef;
  /** Set on waiting rows: the attention row that proves the agent is blocked. */
  attention?: AttentionItem;
}

export interface LiveSessions {
  /** Sessions with an unsnoozed hook attention row — the agent is blocked on you right now. */
  waiting: LiveSessionRow[];
  /** Everything else with activity inside the window. */
  recent: LiveSessionRow[];
}

/** How recent a session's last activity must be to show under "recently active". */
export const LIVE_SESSION_WINDOW_MS = 60 * 60_000;

/** The pushed hook row types that prove a session is live and blocked. */
const WAITING_TYPES = new Set(["permission", "waiting", "codex-maybe-waiting"]);

/**
 * Sessions that look live, in two honest tiers. There is no PID or
 * running-flag anywhere in the data, so this never claims "running": tier one
 * is backed by a hook event (cleared on SessionEnd/Stop), tier two is just
 * recency.
 *
 * An attention row whose session belongs to a hidden project is excluded —
 * hidden means hidden — which is why rows are resolved through the visible
 * projects' sessions rather than trusting `item.projectPath` alone.
 */
export function partitionLiveSessions(
  projects: Project[],
  attentionItems: AttentionItem[],
  now: Date
): LiveSessions {
  const waitingBySession = new Map<string, AttentionItem>();
  for (const item of attentionItems) {
    if (!WAITING_TYPES.has(item.type)) continue;
    if (item.snoozedUntil && Date.parse(item.snoozedUntil) > now.getTime()) continue;
    waitingBySession.set(item.sessionId, item);
  }
  const waiting: LiveSessionRow[] = [];
  const recent: LiveSessionRow[] = [];
  for (const p of visibleProjects(projects)) {
    for (const s of p.sessions) {
      const attention = waitingBySession.get(s.sessionId);
      if (attention) {
        waiting.push({ projectPath: p.path, projectName: p.displayName, session: s, attention });
        continue;
      }
      const last = Date.parse(s.lastActivity);
      if (!Number.isNaN(last) && now.getTime() - last <= LIVE_SESSION_WINDOW_MS) {
        recent.push({ projectPath: p.path, projectName: p.displayName, session: s });
      }
    }
  }
  const byActivity = (a: LiveSessionRow, b: LiveSessionRow) =>
    b.session.lastActivity.localeCompare(a.session.lastActivity);
  waiting.sort(byActivity);
  recent.sort(byActivity);
  return { waiting, recent };
}
