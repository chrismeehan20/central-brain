import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import matter from "gray-matter";
import Anthropic from "@anthropic-ai/sdk";
import type { DetailItem, DetailItemKind, Project, ProjectDetail } from "@shared/types.js";
import { detailsDb } from "../store/db.js";
import { canSpend, capMessage, isDebounced, recordCall } from "./budget.js";

const MODEL = "claude-haiku-4-5-20251001";
const KINDS: DetailItemKind[] = ["todo", "decision", "pending"];
const MAX_OPEN_PER_KIND = 40; // guardrail against a runaway AI adding endless items

let client: Anthropic | null | undefined;
function getClient(): Anthropic | null {
  if (client !== undefined) return client;
  client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  return client;
}

function now(): string {
  return new Date().toISOString();
}

/** Normalized text is the dedup key — punctuation/case/whitespace-insensitive. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function itemId(kind: DetailItemKind, text: string): string {
  return crypto.createHash("sha1").update(`${kind}|${normalize(text)}`).digest("hex").slice(0, 12);
}

function tokenSet(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter((w) => w.length >= 3));
}

/**
 * True if `text` is an exact or near-duplicate of any existing item (any
 * status). Catches the common failure where the model restates an open item in
 * slightly different words each run — exact-normalized match, high containment
 * (one is nearly a subset of the other), or high Jaccard overlap.
 */
function isNearDuplicate(text: string, existing: DetailItem[]): boolean {
  const na = normalize(text);
  const a = tokenSet(text);
  for (const item of existing) {
    if (normalize(item.text) === na) return true; // exact restatement
    if (a.size < 3) continue; // too short to judge fuzzily
    const b = tokenSet(item.text);
    if (b.size === 0) continue;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const containment = inter / Math.min(a.size, b.size);
    const jaccard = inter / (a.size + b.size - inter);
    if (containment >= 0.8 || jaccard >= 0.7) return true;
  }
  return false;
}

export function ensureDetail(projectPath: string): ProjectDetail {
  return detailsDb.data[projectPath] ?? { path: projectPath, items: [], notes: "" };
}

export function getCachedDetail(projectPath: string): ProjectDetail | undefined {
  return detailsDb.data[projectPath];
}

// ---- Evidence the AI reasons over (planning-doc bodies + recent sessions + last commit) ----

function readDocBodies(project: Project): string {
  const wanted = project.markdown.filter((d) => /README|TODO|STATUS|PLAN|ROADMAP/i.test(d.relativePath));
  const parts: string[] = [];
  let budget = 6000;
  for (const doc of wanted) {
    if (budget <= 0) break;
    try {
      const body = matter(fs.readFileSync(doc.file, "utf8")).content.trim();
      if (!body) continue;
      const slice = body.slice(0, 1600);
      parts.push(`### ${doc.relativePath}\n${slice}`);
      budget -= slice.length;
    } catch {
      // unreadable doc — skip
    }
  }
  return parts.join("\n\n");
}

const COLD_START_SESSIONS = 6;

function git(projectPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", projectPath, ...args], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return ""; // not a git repo, or git unavailable
  }
}

/** Recent commit messages (subject + body) — the strongest signal for what's
 *  ALREADY built. Body is included so completions described there (not just in
 *  the one-line subject) are detectable. */
function readGitLog(projectPath: string): string {
  return git(projectPath, ["log", "--pretty=format:%s%n%b%n-----", "-n", "15"]);
}

/**
 * The working-tree source files (tracked + untracked-not-ignored). This is the
 * decisive "what exists" signal: if a feature has a module here, it's BUILT —
 * which stops the model from listing shipped features as todos when the git
 * history is too coarse to reveal them.
 */
function readCodeTree(projectPath: string): string {
  const both = `${git(projectPath, ["ls-files"])}\n${git(projectPath, ["ls-files", "--others", "--exclude-standard"])}`;
  const skip = /(^|\/)(node_modules|dist|build|target|data|coverage|icons|\.[^/]+)\//;
  const codey = /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|rb|java|kt|swift|c|cpp|h|json|toml|ya?ml|md|css|scss|html|vue|svelte)$/i;
  const files = Array.from(
    new Set(
      both
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f && !skip.test(f) && codey.test(f))
    )
  ).slice(0, 140);
  return files.join("\n");
}

const TRANSCRIPT_SESSIONS = 4; // max recent sessions read verbatim
const TRANSCRIPT_TAIL_BYTES = 512 * 1024; // read window per transcript file
const TRANSCRIPT_PER_SESSION = 2500; // chars kept per session (the tail)
const TRANSCRIPT_TOTAL = 8000; // char budget across all sessions

/** Read up to the last `maxBytes` of a file, dropping any partial first line. */
function readTail(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1); // drop the partial first line
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/** Pull "role: text" from one transcript line (Claude or Codex), skipping tool noise. */
function lineToMessage(obj: any): string | undefined {
  const msg = obj?.message ?? obj?.payload ?? obj;
  const role = msg?.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const content = msg?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(
        (c: any) =>
          c &&
          (c.type === "text" || c.type === "input_text" || c.type === "output_text") &&
          typeof c.text === "string"
      )
      .map((c: any) => c.text)
      .join(" ");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text ? `${role}: ${text}` : undefined;
}

/** Verbatim tail of one session's actual conversation (not the lagging summary). */
function extractTranscript(transcriptPath: string): string {
  try {
    const msgs: string[] = [];
    for (const line of readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES).split("\n")) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const m = lineToMessage(obj);
      if (m) msgs.push(m);
    }
    return msgs.join("\n");
  } catch {
    return "";
  }
}

/** The most recent sessions' conversation tails, within a char budget. */
function readRecentDiscussion(project: Project, sinceIso: string | undefined): string {
  const pool = (
    sinceIso ? project.sessions.filter((s) => s.lastActivity > sinceIso) : project.sessions.slice(0, COLD_START_SESSIONS)
  )
    .filter((s) => s.transcriptPath)
    .slice(0, TRANSCRIPT_SESSIONS);

  const parts: string[] = [];
  let budget = TRANSCRIPT_TOTAL;
  for (const s of pool) {
    if (budget <= 0) break;
    const text = extractTranscript(s.transcriptPath as string);
    if (!text) continue;
    const slice = text.slice(-Math.min(TRANSCRIPT_PER_SESSION, budget));
    parts.push(`— [${s.tool}] ${s.summary ?? s.firstPrompt ?? s.sessionId}:\n${slice}`);
    budget -= slice.length;
  }
  return parts.join("\n\n");
}

/**
 * The prompt text. Deliberately labels evidence by what it means so the model
 * doesn't turn shipped features into todos: git = done, sessions/discussion =
 * what's being worked on now (incremental since the last run), docs = mixed.
 */
function buildEvidence(
  project: Project,
  sinceIso: string | undefined,
  shipped: string,
  tree: string,
  docs: string
): string {
  // New activity since the last run is the incremental signal; cold start
  // (no prior run) falls back to the few most-recent sessions.
  const pool = sinceIso
    ? project.sessions.filter((s) => s.lastActivity > sinceIso)
    : project.sessions.slice(0, COLD_START_SESSIONS);
  const recent = pool
    .slice(0, 12)
    .map((s) => `- [${s.tool}] ${s.summary ?? s.firstPrompt ?? "(no summary)"}`)
    .join("\n");

  const discussion = readRecentDiscussion(project, sinceIso);

  return [
    `Project: ${project.displayName}`,
    sinceIso
      ? `Only surface items still open as of the last check (${sinceIso}) or later.`
      : "First check for this project — be conservative.",
    tree
      ? `CODEBASE — files that already exist. If a feature has a matching module/file here, it is BUILT; do NOT list it as a todo:\n${tree}`
      : "CODEBASE: (unknown)",
    shipped
      ? `ALREADY SHIPPED (recent commits — do NOT list these as todos):\n${shipped}`
      : "ALREADY SHIPPED: (no git history)",
    recent ? `RECENT ACTIVITY since last check:\n${recent}` : "RECENT ACTIVITY since last check: (none)",
    discussion
      ? "RECENT DISCUSSION (verbatim from recent sessions — a PRIMARY source for still-open todos/decisions/" +
        "pending the developer committed to; but IGNORE anything already reflected in CODEBASE or ALREADY " +
        `SHIPPED, that work is done):\n${discussion}`
      : "RECENT DISCUSSION: (none)",
    docs
      ? "PLANNING DOCS (describe BOTH done and pending work — only pull items explicitly still open, e.g. " +
        `unchecked "- [ ]", "TODO:", "Next steps"; never features that already work):\n${docs}`
      : "PLANNING DOCS: (none)",
  ].join("\n\n");
}

function hashInput(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

// ---- AI reconciliation output ----

interface AiReport {
  completed_ids?: string[];
  new_items?: Array<{ kind?: string; text?: string }>;
}

const REPORT_TOOL: Anthropic.Tool = {
  name: "report_detail",
  description:
    "Report which existing open items are now done, and any genuinely new todos/decisions/pending items.",
  input_schema: {
    type: "object",
    properties: {
      completed_ids: {
        type: "array",
        items: { type: "string" },
        description: "IDs of the listed OPEN items that the evidence now clearly shows are DONE.",
      },
      new_items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["todo", "decision", "pending"] },
            text: { type: "string", description: "One concrete item, under 18 words." },
          },
          required: ["kind", "text"],
        },
      },
    },
    required: ["completed_ids", "new_items"],
  },
};

function buildPrompt(project: Project, evidence: string, openItems: DetailItem[]): string {
  const listed = openItems.length
    ? openItems.map((i) => `- (${i.id}) [${i.kind}] ${i.text}`).join("\n")
    : "(none yet)";
  return (
    "You help a developer track many side projects. This project is ALREADY SUBSTANTIALLY BUILT and under " +
    "active development — most features its docs describe already work. Surface ONLY action items that are " +
    "genuinely still open right now, then reconcile the existing list.\n\n" +
    "1) COMPLETE: from the currently-open items below, return the ids that ALREADY SHIPPED commits or recent " +
    "activity now show are DONE.\n" +
    "2) ADD: propose only NEW, genuinely-open items, categorized:\n" +
    "   - todo: concrete work still left to build.\n" +
    "   - decision: an open choice not yet made.\n" +
    "   - pending: blocked / waiting on something external.\n\n" +
    "STRICT RULES:\n" +
    "- If a feature has a matching file/module in CODEBASE, or appears in ALREADY SHIPPED, it is BUILT — never " +
    "list it as a todo. Do NOT turn descriptions of existing, working features into todos.\n" +
    "- RECENT DISCUSSION often mentions work that was then completed in the SAME session. Cross-check every " +
    "discussed item against CODEBASE and ALREADY SHIPPED; if it's there, it's DONE — skip it. Only surface " +
    "discussed work that is still genuinely open (e.g. explicitly deferred, or with no matching code yet).\n" +
    "- Prefer items evidenced by RECENT DISCUSSION/ACTIVITY or explicitly-open doc markers.\n" +
    "- Do NOT restate items already listed. When in doubt, OMIT.\n" +
    "- Aim for a short, high-signal list (usually 0–6 new items), not a re-derivation of the whole project.\n\n" +
    `Currently-open items:\n${listed}\n\n` +
    `Evidence:\n${evidence}`
  );
}

// ---- Generation (hourly-gated + debounced + capped) ----

export async function getOrGenerateDetail(project: Project, force = false): Promise<ProjectDetail> {
  const detail = ensureDetail(project.path);
  const shipped = readGitLog(project.path);
  const tree = readCodeTree(project.path);
  const docs = readDocBodies(project);
  // Stable change-signal: only flips when the newest session, git history,
  // code tree, or doc bodies actually change — so an idle project never
  // re-spends, and the window shifting forward each run doesn't cause thrash.
  const hash = hashInput(`${project.sessions[0]?.lastActivity ?? ""}\n${shipped}\n${tree}\n${docs}`);

  // Hourly gate: nothing changed since last generation → nothing new to learn.
  if (!force && detail.hash === hash) return detail;
  // Debounce rapid manual refreshes.
  if (force && isDebounced(detail.generatedAt)) return detail;

  const anthropic = getClient();
  if (!anthropic) return detail; // no key — manual items still work, just no AI drafting

  if (!canSpend()) {
    detail.lastError = capMessage();
    detailsDb.data[project.path] = detail;
    await detailsDb.write();
    return detail;
  }

  const openItems = detail.items.filter((i) => i.status === "open");
  // Windowed to activity since the last run (incremental); cold start uses recent sessions.
  const evidence = buildEvidence(project, detail.generatedAt, shipped, tree, docs);

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 900,
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: "report_detail" },
      messages: [{ role: "user", content: buildPrompt(project, evidence, openItems) }],
    });
    await recordCall();

    const report = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    )?.input as AiReport | undefined;

    applyReport(detail, report);
    detail.hash = hash;
    detail.generatedAt = now();
    detail.model = MODEL;
    detail.lastError = undefined;
    detailsDb.data[project.path] = detail;
    await detailsDb.write();
    return detail;
  } catch (err) {
    console.error("AI detail failed:", err);
    return detail;
  }
}

function applyReport(detail: ProjectDetail, report: AiReport | undefined): void {
  if (!report) return;
  const stamp = now();

  // 1) Auto-complete: mark listed open items the AI judged done.
  const completed = new Set(report.completed_ids ?? []);
  for (const item of detail.items) {
    if (item.status === "open" && completed.has(item.id)) {
      item.status = "done";
      item.completedBy = "ai";
      item.completedAt = stamp;
      item.updatedAt = stamp;
    }
  }

  // 2) Add new items, skipping near-duplicates of anything that already exists
  //    (any status) so a done/dismissed item never resurrects and reworded
  //    restatements never pile up.
  const openCount: Record<DetailItemKind, number> = { todo: 0, decision: 0, pending: 0 };
  for (const item of detail.items) if (item.status === "open") openCount[item.kind]++;

  for (const raw of report.new_items ?? []) {
    const kind = raw.kind as DetailItemKind;
    const text = raw.text?.trim();
    if (!text || !KINDS.includes(kind)) continue;
    // Checks against detail.items, which includes items just pushed in this loop.
    if (isNearDuplicate(text, detail.items)) continue;
    if (openCount[kind] >= MAX_OPEN_PER_KIND) continue;
    detail.items.push({
      id: itemId(kind, text),
      kind,
      text,
      status: "open",
      origin: "ai",
      createdAt: stamp,
      updatedAt: stamp,
    });
    openCount[kind]++;
  }
}

// ---- User-driven item mutations (persisted, never overwritten by the AI) ----

export async function addUserItem(
  projectPath: string,
  kind: DetailItemKind,
  text: string
): Promise<ProjectDetail> {
  const detail = ensureDetail(projectPath);
  const trimmed = text.trim();
  if (trimmed) {
    const id = itemId(kind, trimmed);
    // Dedup by the stable id (across every status) so we never create a
    // duplicate row / colliding id. Re-adding a done/dismissed item reopens it.
    const existing = detail.items.find((i) => i.id === id);
    const stamp = now();
    if (!existing) {
      detail.items.push({
        id,
        kind,
        text: trimmed,
        status: "open",
        origin: "user",
        createdAt: stamp,
        updatedAt: stamp,
      });
    } else if (existing.status !== "open") {
      existing.status = "open";
      existing.completedAt = undefined;
      existing.completedBy = undefined;
      existing.updatedAt = stamp;
    }
  }
  detailsDb.data[projectPath] = detail;
  await detailsDb.write();
  return detail;
}

export interface ItemPatch {
  status?: DetailItem["status"];
  text?: string;
  note?: string;
}

export async function updateItem(
  projectPath: string,
  id: string,
  patch: ItemPatch
): Promise<ProjectDetail | undefined> {
  const detail = detailsDb.data[projectPath];
  const item = detail?.items.find((i) => i.id === id);
  if (!detail || !item) return undefined;

  const stamp = now();
  if (patch.status && patch.status !== item.status) {
    item.status = patch.status;
    if (patch.status === "open") {
      item.completedAt = undefined;
      item.completedBy = undefined;
    } else {
      item.completedAt = stamp;
      item.completedBy = "user";
    }
  }
  if (typeof patch.text === "string" && patch.text.trim()) item.text = patch.text.trim();
  if (typeof patch.note === "string") item.note = patch.note;
  item.updatedAt = stamp;

  detailsDb.data[projectPath] = detail;
  await detailsDb.write();
  return detail;
}

export async function setNotes(projectPath: string, notes: string): Promise<ProjectDetail> {
  const detail = ensureDetail(projectPath);
  detail.notes = notes;
  detailsDb.data[projectPath] = detail;
  await detailsDb.write();
  return detail;
}
