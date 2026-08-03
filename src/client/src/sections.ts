/**
 * How the dashboard decides what you actually look at.
 *
 * Forty project cards in one grid is inventory, not mission control — so the
 * visible projects split into "Active" (what you're working on, plus anything
 * broken) and a collapsed "All projects" drawer for the rest, with filter chips
 * on top.
 *
 * Deliberately dependency-free: only *type* imports, so `node:test` can run
 * this file directly without the `@shared` vite alias existing at runtime.
 * Keep it that way — a single runtime import here breaks `npm test`.
 */
import type { Project } from "@shared/types";

const DAY_MS = 86_400_000;

/**
 * Something is broken and it's yours to fix: CI red on the branch you have
 * checked out, or a non-draft open PR with failing checks. Draft PRs don't
 * count — a red draft is a work in progress, not a regression.
 *
 * The `.toLowerCase()` calls are defensive. Both fields have been normalized
 * lowercase server-side since Loop 6, but a `github.json` written by an older
 * build can still carry `"FAILURE"`, and ProjectCard hedges the same way.
 */
export function needsAttention(p: Project): boolean {
  if (p.github?.ciStatus?.toLowerCase() === "failure") return true;
  // A folded sibling checkout with red CI is just as much yours to fix.
  if ((p.checkouts ?? []).some((c) => c.ciStatus?.toLowerCase() === "failure")) return true;
  return (p.github?.openPrs ?? []).some(
    (pr) => !pr.isDraft && pr.ciStatus?.toLowerCase() === "failure"
  );
}

/** How recently a project must have been touched to count as active. */
export const ACTIVE_WINDOW_DAYS = 14;

/**
 * Active = you pinned it, it's broken, or you've touched it inside the window.
 * A project with no recorded activity is dormant unless pinned or broken —
 * "never active" should not read as "active".
 */
export function isActive(p: Project, now: Date): boolean {
  if (p.pinned) return true;
  if (needsAttention(p)) return true;
  if (!p.lastActivity) return false;
  const last = Date.parse(p.lastActivity);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last <= ACTIVE_WINDOW_DAYS * DAY_MS;
}

/**
 * Dashboard order: pinned first, then whatever is broken, then most recent.
 * Same string-compare on ISO timestamps as the server's `compareProjects` —
 * these sort lexicographically, so no Date parsing is needed.
 */
export function compareDashboard(a: Project, b: Project): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const aAttention = needsAttention(a);
  const bAttention = needsAttention(b);
  if (aAttention !== bAttention) return aAttention ? -1 : 1;
  return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
}

export interface DashboardSections {
  active: Project[];
  dormant: Project[];
  missing: Project[];
  hidden: Project[];
}

/**
 * Split every project into the four dashboard buckets.
 *
 * Hidden wins over missing: you hid it, so a folder that later vanished is not
 * news. Missing wins over active/dormant, because a project you can't open
 * belongs in the triage section no matter how recently you used it — including
 * a pinned one.
 */
export function partitionDashboard(projects: Project[], now: Date): DashboardSections {
  const sections: DashboardSections = { active: [], dormant: [], missing: [], hidden: [] };
  for (const p of projects) {
    if (p.hidden) sections.hidden.push(p);
    else if (p.missing) sections.missing.push(p);
    else if (isActive(p, now)) sections.active.push(p);
    else sections.dormant.push(p);
  }
  for (const bucket of [sections.active, sections.dormant, sections.missing, sections.hidden]) {
    bucket.sort(compareDashboard);
  }
  return sections;
}

export type ChipId = "attention" | "dirty" | "ci" | "new";

/** The filter chips, in the order they render. Titles spell out the predicate. */
export const CHIPS: Array<{ id: ChipId; label: string; title: string }> = [
  { id: "attention", label: "Attention", title: "CI failing or PR checks failing" },
  { id: "dirty", label: "Dirty", title: "Uncommitted changes" },
  { id: "ci", label: "CI red", title: "CI red on the current branch" },
  { id: "new", label: "New", title: "Newly discovered — not yet triaged" },
];

/**
 * AND across the active chips, not OR: two chips on means "show me the
 * projects that are both", which is how you narrow forty cards down to the
 * one you want. An empty set matches everything.
 */
export function matchesChips(p: Project, chips: Set<ChipId>): boolean {
  if (chips.has("attention") && !needsAttention(p)) return false;
  if (chips.has("dirty") && p.github?.dirty !== true) return false;
  if (chips.has("ci") && p.github?.ciStatus?.toLowerCase() !== "failure") return false;
  if (chips.has("new") && !p.discovered) return false;
  return true;
}
