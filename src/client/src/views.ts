/**
 * Selectors for the consolidated cross-project Open PRs view.
 *
 * Hidden projects stay hidden: every selector here starts from
 * `visibleProjects`, so a hidden (or missing) project contributes nothing to
 * the consolidated list.
 *
 * Deliberately dependency-free, same as sections.ts and shared/fleet.ts: only
 * *type* imports, so `node:test` can run this file without the `@shared` vite
 * alias existing at runtime. A single runtime import here breaks `npm test`.
 */
import type { AttentionItem, Project } from "@shared/types";

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
 * "This PR needs you": an attention row, or red checks on a non-draft. Drives
 * both the problems-first sort and the sidebar badge, so the badge count can
 * never disagree with which rows render highlighted.
 */
export function prNeedsAttention(row: PrRow): boolean {
  return Boolean(row.attention) || (!row.isDraft && row.ciStatus?.toLowerCase() === "failure");
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
  return rows.sort((a, b) => {
    const aNeeds = prNeedsAttention(a);
    const bNeeds = prNeedsAttention(b);
    if (aNeeds !== bNeeds) return aNeeds ? -1 : 1;
    // ISO timestamps sort lexicographically; rows without one go last.
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
}
