import type {
  ActivityEvent,
  AttentionItem,
  BoardCard,
  BoardColumnId,
  Project,
  Override,
  ProjectSummary,
  ProjectDetail,
  DetailItemKind,
  DailyDigest,
  ApiKeyStatus,
  HooksSetupStatus,
  Preferences,
  SettingsResponse,
  MissingProjectTriage,
  UsageWindow,
} from "@shared/types";

export async function fetchProjects(): Promise<{ projects: Project[]; lastScanAt: string | null }> {
  const res = await fetch("/api/projects");
  if (!res.ok) throw new Error(`Failed to load projects: ${res.status}`);
  return res.json();
}

export async function triggerScan(): Promise<{ projects: Project[] }> {
  const res = await fetch("/api/scan", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to scan: ${res.status}`);
  return res.json();
}

export async function updateOverride(
  path: string,
  override: Partial<Override>
): Promise<{ projects: Project[] }> {
  const res = await fetch("/api/overrides", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, override }),
  });
  if (!res.ok) throw new Error(`Failed to update override: ${res.status}`);
  return res.json();
}

export async function fetchRelocations(): Promise<{
  missing: MissingProjectTriage[];
  searchedRoots: string[];
}> {
  const res = await fetch("/api/projects/relocations");
  if (!res.ok) throw new Error(`Failed to look for moved folders: ${res.status}`);
  return res.json();
}

/** `to: null` undoes a previous relocation. */
export async function relocateProject(
  from: string,
  to: string | null
): Promise<{ projects: Project[]; lastScanAt: string | null }> {
  const res = await fetch("/api/projects/relocate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to relocate: ${res.status}`);
  }
  return res.json();
}

/**
 * Open/focus VS Code at a project the server already knows about. With a
 * sessionId, the server reopens that specific chat in its original surface
 * (Claude Code panel / Terminal); `note` carries an informational message for
 * routes that can't do that (e.g. Codex).
 */
export async function openInVsCode(
  projectPath: string,
  sessionId?: string
): Promise<{ note?: string }> {
  const res = await fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectPath, ...(sessionId ? { sessionId } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to open: ${res.status}`);
  }
  return { note: body.note };
}

/**
 * Snooze/dismiss an attention row. Both return the full list so the panel can
 * update without waiting for the SSE frame that follows (they converge on the
 * same list, so whichever lands first is fine).
 */
async function attentionMutation(
  url: string,
  body: Record<string, unknown>
): Promise<{ items: AttentionItem[] }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(parsed.error ?? `Request failed: ${res.status}`);
  return parsed;
}

export function snoozeAttention(id: string, minutes: number): Promise<{ items: AttentionItem[] }> {
  return attentionMutation("/api/attention/snooze", { id, minutes });
}

export function dismissAttention(id: string): Promise<{ items: AttentionItem[] }> {
  return attentionMutation("/api/attention/dismiss", { id });
}

/**
 * Every board mutation returns the full card list, mirroring the attention
 * mutations: the board re-renders from the server's answer, so two tabs (or an
 * optimistic drag racing a slow save) converge on whatever the server holds.
 */
async function boardMutation(
  url: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ cards: BoardCard[] }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(parsed.error ?? `Request failed: ${res.status}`);
  return parsed;
}

export async function fetchBoard(): Promise<{ cards: BoardCard[] }> {
  const res = await fetch("/api/board");
  if (!res.ok) throw new Error(`Failed to load the board: ${res.status}`);
  return res.json();
}

export function createBoardCard(input: {
  title: string;
  note?: string;
  projectPath?: string;
  column?: BoardColumnId;
}): Promise<{ cards: BoardCard[] }> {
  return boardMutation("/api/board/card", "POST", input);
}

export function updateBoardCard(
  id: string,
  patch: { title?: string; note?: string; projectPath?: string | null }
): Promise<{ cards: BoardCard[] }> {
  return boardMutation("/api/board/card", "PATCH", { id, ...patch });
}

export function moveBoardCard(
  id: string,
  column: BoardColumnId,
  index: number
): Promise<{ cards: BoardCard[] }> {
  return boardMutation("/api/board/move", "POST", { id, column, index });
}

export function deleteBoardCard(id: string): Promise<{ cards: BoardCard[] }> {
  return boardMutation("/api/board/delete", "POST", { id });
}

/**
 * "Start agent": opens a Terminal running Claude Code seeded with this card,
 * optionally in a fresh git worktree. Returns where it started so the UI can
 * say so.
 */
export function dispatchBoardCard(
  id: string,
  freshWorktree: boolean
): Promise<{ cards: BoardCard[]; startedIn: string; branch?: string }> {
  return boardMutation("/api/board/dispatch", "POST", { id, freshWorktree }) as Promise<{
    cards: BoardCard[];
    startedIn: string;
    branch?: string;
  }>;
}

/** The estimated Claude usage window; see UsageWindow for what "estimated" claims. */
export async function fetchUsage(): Promise<{ claude: UsageWindow }> {
  const res = await fetch("/api/usage");
  if (!res.ok) throw new Error(`Failed to load usage: ${res.status}`);
  return res.json();
}

/** The rolling hook-event window, oldest first; live appends arrive over SSE. */
export async function fetchActivity(): Promise<{ events: ActivityEvent[] }> {
  const res = await fetch("/api/activity");
  if (!res.ok) throw new Error(`Failed to load activity: ${res.status}`);
  return res.json();
}

/** `noActivity` = there is genuinely nothing to digest (not "AI is off"). */
export async function fetchDigest(): Promise<{ digest: DailyDigest | null; noActivity?: boolean }> {
  const res = await fetch("/api/digest");
  if (!res.ok) throw new Error(`Failed to load digest: ${res.status}`);
  return res.json();
}

export async function refreshDigest(): Promise<{ digest: DailyDigest | null; noActivity?: boolean }> {
  const res = await fetch("/api/digest/refresh", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to refresh digest: ${res.status}`);
  }
  return res.json();
}

export async function summarizeProject(path: string): Promise<{ summary: ProjectSummary }> {
  const res = await fetch("/api/projects/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to summarize: ${res.status}`);
  }
  return res.json();
}

async function detailRequest(
  url: string,
  method: string,
  body: Record<string, unknown>
): Promise<ProjectDetail> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Request failed: ${res.status}`);
  }
  return (await res.json()).detail;
}

export async function fetchProjectDetail(path: string): Promise<ProjectDetail> {
  const res = await fetch(`/api/projects/detail?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to load detail: ${res.status}`);
  return (await res.json()).detail;
}

export function refreshProjectDetail(path: string): Promise<ProjectDetail> {
  return detailRequest("/api/projects/detail/refresh", "POST", { path });
}

export function addDetailItem(
  path: string,
  kind: DetailItemKind,
  text: string
): Promise<ProjectDetail> {
  return detailRequest("/api/projects/detail/item", "POST", { path, kind, text });
}

export function updateDetailItem(
  path: string,
  id: string,
  patch: { status?: "open" | "done" | "dismissed"; text?: string; note?: string }
): Promise<ProjectDetail> {
  return detailRequest("/api/projects/detail/item", "PATCH", { path, id, ...patch });
}

export function saveDetailNotes(path: string, notes: string): Promise<ProjectDetail> {
  return detailRequest("/api/projects/detail/notes", "PUT", { path, notes });
}

export async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(`Failed to load settings: ${res.status}`);
  return res.json();
}

/**
 * Every api-key mutation returns the new status. Errors propagate the server's
 * message verbatim — for a rejected key that message ("Anthropic rejected that
 * key…") is the entire value of the response.
 */
async function apiKeyRequest(
  url: string,
  method: string,
  body?: Record<string, unknown>
): Promise<ApiKeyStatus> {
  const res = await fetch(url, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Request failed: ${res.status}`);
  }
  return (await res.json()).apiKey;
}

export async function fetchHooksStatus(): Promise<HooksSetupStatus> {
  const res = await fetch("/api/hooks/status");
  if (!res.ok) throw new Error(`Failed to load hook status: ${res.status}`);
  return res.json();
}

/** Install our hook entries into the tool's config. Errors carry the server's explanation verbatim. */
export async function installHooks(tool: "claude" | "codex"): Promise<HooksSetupStatus> {
  const res = await fetch("/api/hooks/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Failed to install hooks: ${res.status}`);
  return body.status;
}

export async function dismissHooksSetup(): Promise<HooksSetupStatus> {
  const res = await fetch("/api/hooks/dismiss-setup", { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body.status;
}

export async function updatePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const res = await fetch("/api/settings/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Failed to save preferences: ${res.status}`);
  }
  return (await res.json()).preferences;
}

/** Empty string turns phone push off. Returns the stored state for the settings field. */
export async function saveNtfyUrl(url: string): Promise<{ configured: boolean; url: string | null }> {
  const res = await fetch("/api/settings/ntfy", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Failed to save: ${res.status}`);
  return body.ntfy;
}

export function saveApiKey(apiKey: string): Promise<ApiKeyStatus> {
  return apiKeyRequest("/api/settings/api-key", "PUT", { apiKey });
}

export function clearApiKey(): Promise<ApiKeyStatus> {
  return apiKeyRequest("/api/settings/api-key", "DELETE");
}

export function dismissApiKeySetup(): Promise<ApiKeyStatus> {
  return apiKeyRequest("/api/settings/dismiss-setup", "POST");
}
