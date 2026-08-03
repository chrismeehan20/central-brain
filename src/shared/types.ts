export type SourceTool = "claude" | "codex";

export interface SessionRef {
  tool: SourceTool;
  sessionId: string;
  lastActivity: string; // ISO timestamp
  firstPrompt?: string;
  summary?: string;
  gitBranch?: string;
  entrypoint?: string; // e.g. "claude-vscode", "cli"
  transcriptPath?: string; // absent when the transcript file no longer exists
  /**
   * Set when repository grouping folded this session in from a sibling
   * checkout: the directory the session actually ran in. Open/resume must use
   * this over the card's primary path, or a worktree session resumes in the
   * wrong working tree. Absent = the session lives at the project's own path.
   */
  checkoutPath?: string;
  // Codex only, from its own state DB (~/.codex/state_<n>.sqlite) — the rollout
  // files do not carry these.
  tokensUsed?: number;
  model?: string;
  approvalMode?: string;
  gitOriginUrl?: string;
}

export interface MarkdownDoc {
  file: string; // absolute path
  relativePath: string; // relative to project root
  mtime: string; // ISO timestamp
  firstHeading?: string;
  status?: string; // frontmatter `status:` field, if present
}

export interface GithubStatus {
  lastCommitSha?: string;
  lastCommitMessage?: string;
  lastCommitDate?: string;
  branch?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  openPrs?: Array<{
    number: number;
    title: string;
    state: string;
    isDraft: boolean;
    /**
     * Worst state across this PR's ENTIRE check rollup, lowercase: "failure"
     * (at least one check failed/errored/was cancelled), else "pending" (at
     * least one still running), else "success" (at least one passed).
     * Undefined when the PR has no checks at all.
     */
    ciStatus?: string;
  }>;
  /**
   * CI state of the checkout's CURRENT BRANCH — the newest workflow run on
   * `branch`, normalized lowercase to "success" | "failure" | "pending".
   * Undefined when that branch has never run CI, the repo has no CI, HEAD is
   * detached (no branch to scope the query to), or `gh` was unavailable.
   * Deliberately NOT the newest run repo-wide: a Dependabot or someone else's
   * feature-branch run says nothing about the code you have checked out.
   */
  ciStatus?: string;
  fetchedAt?: string;
  unavailableReason?: string;
}

export interface ProjectSummary {
  text: string;
  generatedAt: string;
  model: string;
  hash: string;
  lastError?: string; // last failed generation (API error / daily cap) — surfaced in the UI
  /** The model judged the evidence too thin to summarize (`text` is empty) — the card says so quietly instead of showing its hedging. */
  insufficientEvidence?: boolean;
}

export interface DailyDigest {
  date: string; // local YYYY-MM-DD the digest covers
  text: string;
  generatedAt: string;
  model: string;
  hash: string;
  lastError?: string;
}

export interface Override {
  displayName?: string;
  hidden?: boolean;
  pinned?: boolean;
  /**
   * Absolute path this project was moved to on disk. Sessions still recorded
   * under the old path fold into the new one, so moving a repo doesn't split
   * its history across two cards.
   */
  movedTo?: string;
}

export type RelocationConfidence = "high" | "medium" | "low";

/** A folder on disk that might be where a missing project moved to. */
export interface RelocationCandidate {
  path: string;
  score: number; // 0-1
  confidence: RelocationConfidence;
  reason: string; // human-readable, shown in the UI so the guess is auditable
}

/** One missing project plus its ranked relocation candidates (best first). */
export interface MissingProjectTriage {
  path: string;
  displayName: string;
  candidates: RelocationCandidate[];
}

export type DetailItemKind = "todo" | "decision" | "pending";
export type DetailItemStatus = "open" | "done" | "dismissed";
export type DetailItemOrigin = "ai" | "user";

export interface DetailItem {
  id: string; // stable, content-derived so refreshes reconcile instead of duplicating
  kind: DetailItemKind;
  text: string;
  status: DetailItemStatus;
  origin: DetailItemOrigin;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  completedBy?: "ai" | "user"; // who moved it out of "open"
  completionEvidence?: string; // AI-completions only: the commit/file/discussion line that proved it done
  note?: string;
}

export interface ProjectDetail {
  path: string;
  items: DetailItem[];
  notes: string; // freeform scratchpad, user-owned
  hash?: string; // hash of the last AI evidence input (hourly gate)
  cheapHash?: string; // zero-subprocess pre-gate; skips git/doc reads when nothing moved
  generatedAt?: string; // last successful AI generation
  model?: string;
  lastError?: string; // e.g. "daily AI cap reached" — surfaced in the UI
}

/**
 * One checkout of a repository that resolved to a single project card —
 * a linked worktree, or an alternate clone sharing the same origin remote.
 */
export interface ProjectCheckout {
  path: string;
  /** True for the checkout the card itself represents. */
  primary: boolean;
  /** Checked-out branch, when HEAD is a readable symbolic ref. */
  branch?: string;
  lastActivity?: string;
  sessionCount: number;
  /** Uncommitted changes in THIS checkout — a dirty worktree must not hide behind a clean primary. */
  dirty?: boolean;
  /** CI state of THIS checkout's branch, lowercase (same semantics as GithubStatus.ciStatus). */
  ciStatus?: string;
}

export interface Project {
  path: string; // canonical absolute path (real on-disk casing; case-insensitive merged)
  displayName: string;
  discovered: boolean; // true = no override saved yet — the dashboard shows a "New" chip
  hidden: boolean;
  pinned: boolean;
  missing: boolean; // true = the folder no longer exists on disk (moved/deleted)
  mergedFrom?: string[]; // old paths folded in via a relocation, if any
  /**
   * Present when several on-disk checkouts of the same repository folded into
   * this one card (always length ≥ 2, primary first). Sessions and
   * lastActivity on the card cover the whole set; markdown, GitHub status and
   * overrides come from the primary checkout.
   */
  checkouts?: ProjectCheckout[];
  lastActivity?: string;
  sessions: SessionRef[];
  markdown: MarkdownDoc[];
  github?: GithubStatus;
  summary?: ProjectSummary;
  openItems?: string[]; // open detail-item texts, for dashboard search
}

export type AttentionType =
  | "permission"
  | "waiting"
  | "codex-maybe-waiting"
  | "done";

export type AttentionPriority = "high" | "medium" | "low" | "none";

export interface AttentionItem {
  id: string; // sessionId, or sessionId+type for uniqueness
  sessionId: string;
  projectPath: string;
  tool: SourceTool;
  type: AttentionType;
  priority: AttentionPriority;
  message?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * ISO instant until which this item is hidden from the panel. The item keeps
   * living its normal lifecycle underneath — hook events still clear it, the
   * staleness heuristic still decays and retires it — so a snooze only ever
   * suppresses the row, it never freezes the state behind it. A fresh hook
   * event clears this (new information should un-hide the row).
   */
  snoozedUntil?: string;
}

/**
 * Whether a tool's hook events are actually arriving. Codex hooks require a
 * one-off interactive trust approval before they ever fire, so this is the
 * difference between "quiet because nothing needs you" and "quiet because the
 * push signal was never switched on".
 */
export interface HookLiveness {
  tool: SourceTool;
  live: boolean;
  lastEventAt?: string; // ISO; absent = a hook event has never been received
  windowMs: number; // how recent an event has to be to count as live
  /**
   * Why a recent event still didn't count. `stale-install` means it came from
   * a previous generation of the wiring (the hooks were since reinstalled,
   * repaired, or removed); `unsupported-forwarder` means it came from a script
   * older than the one now installed. Absent when `live` is true, or when
   * nothing has ever arrived.
   */
  disqualifiedBy?: "stale-install" | "unsupported-forwarder";
}

/**
 * What the last hook event said about the wiring that produced it.
 *
 * Recorded so liveness can require proof from the CURRENT install rather than
 * from any install: a timestamp alone reads the same whether events are
 * arriving now or arrived once before the pipeline broke.
 */
export interface HookReceipt {
  receivedAt: string; // ISO
  eventName?: string;
  /** Identity of the hook wiring in place when this fired; rotates on install/repair/uninstall. */
  installId?: string;
  /** The forwarder script's protocol revision. */
  forwarderRevision?: string;
}

export interface HookEventPayload {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: unknown;
  last_assistant_message?: string;
  [key: string]: unknown;
}

/**
 * Where the Anthropic API key comes from. `env` is `ANTHROPIC_API_KEY` (a `.env`
 * under `npm run dev`); `settings` is a key entered in the dashboard and stored
 * in the user-data dir — the only source a packaged app can use, since its
 * sidecar runs with cwd `/` and never loads a `.env`.
 */
export type ApiKeySource = "env" | "settings" | "none";

/** The key's state as sent to the client. Never carries the key itself, only a last-4 hint. */
export interface ApiKeyStatus {
  configured: boolean;
  source: ApiKeySource;
  hint: string | null;
  managedByEnv: boolean;
  setupDismissed: boolean;
}

/**
 * VS Code-family editors. Forks register their own URL scheme and app bundle,
 * so one id drives all three editor touchpoints: `<scheme>://file/` doc links,
 * `open -a <appName>`, and the `<scheme>://anthropic.claude-code/...` chat
 * deep link (extension URI handlers inherit the fork's scheme).
 */
export type EditorId = "vscode" | "cursor" | "vscodium" | "windsurf";

export const EDITORS: Record<
  EditorId,
  { label: string; shortLabel: string; scheme: string; appName: string }
> = {
  vscode: { label: "Visual Studio Code", shortLabel: "VS Code", scheme: "vscode", appName: "Visual Studio Code" },
  cursor: { label: "Cursor", shortLabel: "Cursor", scheme: "cursor", appName: "Cursor" },
  vscodium: { label: "VSCodium", shortLabel: "VSCodium", scheme: "vscodium", appName: "VSCodium" },
  windsurf: { label: "Windsurf", shortLabel: "Windsurf", scheme: "windsurf", appName: "Windsurf" },
};

export const DEFAULT_EDITOR: EditorId = "vscode";

/** User preferences editable from the settings panel. */
export interface Preferences {
  /** Fire desktop notifications for attention events. Off = the panel still updates, silently. */
  notifications: boolean;
  /** Which editor doc links and the open route target. */
  editor: EditorId;
}

export const DEFAULT_PREFERENCES: Preferences = {
  notifications: true,
  editor: DEFAULT_EDITOR,
};

export interface SettingsResponse {
  apiKey: ApiKeyStatus;
  ai: { model: string; dailyCap: number; callsRemaining: number };
  preferences: Preferences;
}

/**
 * State of the dashboard-driven hook install, per tool. `dirExists` is "is the
 * tool even on this machine"; `installed` is "are our entries in its config";
 * `live` is "have real events actually arrived recently" — the only proof the
 * pipeline works end to end.
 */
export interface HookToolStatus {
  dirExists: boolean;
  installed: boolean;
  live: boolean;
  lastEventAt?: string;
}

/**
 * Every distinct thing that can be wrong with the Codex pipeline, where
 * "distinct" means a different cause AND a different thing for the user to do.
 * States the review proposed that collapse to identical copy, or that no code
 * path can produce, are deliberately absent.
 */
export type CodexHooksOverall =
  | "not_detected" // Codex isn't on this machine
  | "config_error" // hooks.json is unreadable or the wrong shape
  | "disabled" // Codex's own config switches hooks off
  | "needs_install" // no entries of ours
  | "needs_repair" // ours are present but not what this version installs
  | "needs_review" // correct, but not approved inside Codex
  | "waiting_for_verification" // correct and apparently approved; no event yet
  | "connected" // an event from this install arrived recently
  | "stale"; // verified once, but nothing recently

export interface CodexHooksDiagnosis {
  overall: CodexHooksOverall;
  codexHome: string;
  hooksPath: string;
  forwarderPath: string;
  /** Events with no entry of ours at all. */
  missingEvents: string[];
  /** Events whose entry of ours isn't the definition this version installs. */
  staleEvents: string[];
  duplicatedEvents: string[];
  /**
   * What `trusted_hash` suggests — a hint, never a verdict. Its location inside
   * hook groups is current-Codex behaviour, not a documented contract, so a
   * real event always outranks it.
   */
  approval: "approved" | "needs-review" | "unknown";
  lastEventAt?: string;
  /**
   * Events waiting to be replayed because delivery failed, and events we could
   * not parse. A pending count that keeps climbing means the server is not
   * draining, which is otherwise completely invisible.
   */
  spool?: { pending: number; quarantined: number };
  /** Human-readable specifics for the panel; may be empty. */
  diagnostics: string[];
}

export interface HooksSetupStatus {
  claude: HookToolStatus;
  /**
   * Codex adds the interactive trust-approval step. `trusted` = every one of
   * our hook groups in hooks.json carries the `trusted_hash` Codex stamps on
   * approval — the only proof short of a live event that our handlers can run.
   */
  codex: HookToolStatus & { trusted: boolean; diagnosis: CodexHooksDiagnosis };
  setupDismissed: boolean;
}
