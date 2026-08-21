// Pure fleet-status derivation, shared by the Agents roster, the board's live
// chips, and the sidebar badges. Deliberately type-imports-only (like
// sections.ts) so node:test can load it without the vite alias.
import type { AttentionItem, Project, SessionRef, SourceTool } from "@shared/types";

/**
 * "Active" means the transcript moved this recently. There is no positive
 * "agent is running" signal — Stop events clear attention but sessions carry
 * only a last-activity stamp — so recency is the honest proxy, and the UI
 * labels it as such ("active <10m") rather than claiming certainty.
 */
export const ACTIVE_AGENT_WINDOW_MS = 10 * 60 * 1000;

/** How far back the roster reaches. Beyond this a session is history, not fleet. */
export const ROSTER_WINDOW_MS = 48 * 60 * 60 * 1000;

export type AgentStatus = "waiting" | "active" | "idle";

export interface AgentRow {
  tool: SourceTool;
  sessionId: string;
  projectPath: string;
  projectName: string;
  /** The directory the session actually ran in, when it differs (worktrees). */
  checkoutPath?: string;
  branch?: string;
  model?: string;
  tokensUsed?: number;
  entrypoint?: string;
  lastActivity: string;
  /** Best one-line description we have: the session summary, else its first prompt. */
  label?: string;
  status: AgentStatus;
  /** The attention message when status is "waiting" — why the agent needs you. */
  waitingOn?: string;
}

/** Attention items that mean "an agent is blocked on you", keyed by session. */
function waitingBySession(attention: AttentionItem[], now: number): Map<string, AttentionItem> {
  const map = new Map<string, AttentionItem>();
  for (const item of attention) {
    if (item.type === "done") continue;
    // Snoozed rows are hidden by choice; the fleet view honours that choice.
    if (item.snoozedUntil && Date.parse(item.snoozedUntil) > now) continue;
    // Permission outranks waiting when a session has both.
    const existing = map.get(item.sessionId);
    if (!existing || item.type === "permission") map.set(item.sessionId, item);
  }
  return map;
}

function rowFor(
  session: SessionRef,
  project: Project,
  waiting: Map<string, AttentionItem>,
  now: number,
): AgentRow {
  const blocked = waiting.get(session.sessionId);
  const ageMs = now - Date.parse(session.lastActivity);
  const status: AgentStatus = blocked ? "waiting" : ageMs <= ACTIVE_AGENT_WINDOW_MS ? "active" : "idle";
  const label = session.summary || session.firstPrompt;
  return {
    tool: session.tool,
    sessionId: session.sessionId,
    projectPath: project.path,
    projectName: project.displayName,
    ...(session.checkoutPath ? { checkoutPath: session.checkoutPath } : {}),
    ...(session.gitBranch ? { branch: session.gitBranch } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.tokensUsed !== undefined ? { tokensUsed: session.tokensUsed } : {}),
    ...(session.entrypoint ? { entrypoint: session.entrypoint } : {}),
    lastActivity: session.lastActivity,
    ...(label ? { label } : {}),
    status,
    ...(blocked?.message ? { waitingOn: blocked.message } : {}),
  };
}

const STATUS_RANK: Record<AgentStatus, number> = { waiting: 0, active: 1, idle: 2 };

/**
 * Every session across every visible project, newest first within status,
 * waiting → active → idle. Hidden projects stay out — hiding a project is a
 * statement that its noise is unwanted, and the roster is the noisiest view.
 * Sessions older than the roster window are dropped entirely, EXCEPT one that
 * is still flagged waiting: an agent blocked on you must never age out of
 * sight while the block stands.
 */
export function fleetRows(projects: Project[], attention: AttentionItem[], now: number): AgentRow[] {
  const waiting = waitingBySession(attention, now);
  const rows: AgentRow[] = [];
  for (const project of projects) {
    if (project.hidden) continue;
    for (const session of project.sessions) {
      const row = rowFor(session, project, waiting, now);
      if (row.status !== "waiting" && now - Date.parse(session.lastActivity) > ROSTER_WINDOW_MS) {
        continue;
      }
      rows.push(row);
    }
  }
  return rows.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      Date.parse(b.lastActivity) - Date.parse(a.lastActivity),
  );
}

/**
 * The live state of one project, for a board card's status chip: the "worst"
 * status across its sessions — waiting beats active beats idle beats nothing.
 * `checkouts` paths count as the project too, so a card linked to a repo whose
 * agent runs in a worktree still lights up.
 */
export function projectAgentStatus(
  projectPath: string,
  rows: AgentRow[],
): AgentStatus | undefined {
  let best: AgentStatus | undefined;
  for (const row of rows) {
    if (row.projectPath !== projectPath) continue;
    if (!best || STATUS_RANK[row.status] < STATUS_RANK[best]) best = row.status;
    if (best === "waiting") break;
  }
  return best;
}

export interface FleetCounts {
  waiting: number;
  active: number;
}

/** Sidebar badge numbers. Counts sessions, not projects: three stuck agents are three problems. */
export function fleetCounts(rows: AgentRow[]): FleetCounts {
  return {
    waiting: rows.filter((r) => r.status === "waiting").length,
    active: rows.filter((r) => r.status === "active").length,
  };
}
