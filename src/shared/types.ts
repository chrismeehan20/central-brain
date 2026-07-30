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
    ciStatus?: string;
  }>;
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

export interface Project {
  path: string; // canonical absolute path (real on-disk casing; case-insensitive merged)
  displayName: string;
  discovered: boolean; // true = auto-discovered, not yet triaged
  hidden: boolean;
  pinned: boolean;
  missing: boolean; // true = the folder no longer exists on disk (moved/deleted)
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
