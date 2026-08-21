import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BoardCard, Project } from "@shared/types.js";
import { boardDb, dataDir } from "../store/db.js";

const execFileAsync = promisify(execFile);

/**
 * "Start agent": turn a board card into a running Claude Code session — the
 * Conductor / Vibe-Kanban move, sized to this product. The launch is a
 * visible interactive Terminal session, not a headless run: the agent works
 * under the same permission prompts it would anywhere else, and the user can
 * watch or take over. Central Brain plans and observes; the agent's own
 * harness governs.
 *
 * Optionally the card gets a fresh git worktree first (a sibling directory,
 * its own agent/<slug> branch), so parallel cards never fight over one
 * checkout. The scanner already folds worktrees of a repo into its card, so
 * the new checkout shows up in the dashboard without any extra wiring.
 */

/** Kebab a card title into a branch/directory slug. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    // Decomposition leaves combining marks behind; drop them so "Ünïcode"
    // slugs as one word, not three.
    .replace(/\p{Mark}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "card";
}

/**
 * The prompt the launched session starts with. The card IS the brief: its
 * title is the task, its note is the context, and the trailer tells the
 * agent how work lands (commit + report back to the board via MCP when the
 * tools are registered — and harmlessly by hand when not).
 */
export function composeDispatchPrompt(card: BoardCard): string {
  const lines = [
    `Work on this task from my mission-control board: ${card.title}`,
  ];
  if (card.note) lines.push("", "Context:", card.note);
  lines.push(
    "",
    "When you're done, commit your work on the current branch with a clear message.",
    "If a central-brain MCP tool like brain_board_move is available, move this " +
      `card (titled ${JSON.stringify(card.title)}) to the "done" column and file any ` +
      "follow-up work you discovered as new cards in the inbox; otherwise just say what's left.",
  );
  return lines.join("\n");
}

/** POSIX single-quoting: the only shell-safe way to embed an arbitrary path. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** AppleScript string literal escaping for `osascript -e`. */
export function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface DispatchPlan {
  /** Directory the agent runs in (the worktree when one is being cut). */
  cwd: string;
  /** Present when a fresh worktree should be created first. */
  worktree?: { repoDir: string; path: string; branch: string };
  prompt: string;
}

export interface DispatchRequest {
  card: BoardCard;
  projects: Project[];
  freshWorktree: boolean;
  /** Existing checkout dirs, for slug collision checks (injectable for tests). */
  exists?: (dir: string) => boolean;
}

/**
 * Decide everything about a dispatch without touching the system — pure, so
 * the trust rule and the worktree naming are testable. The trust rule is the
 * same one the open route enforces: only paths the scanner itself reported
 * ever reach a shell. A card's projectPath is user (or agent!) input; a card
 * pointing anywhere else is refused, not created.
 */
export function resolveDispatch({ card, projects, freshWorktree, exists }: DispatchRequest):
  | { plan: DispatchPlan }
  | { error: string } {
  if (!card.projectPath) return { error: "Link this card to a project first — an agent needs a repo to work in." };
  const project = projects.find(
    (p) => p.path === card.projectPath || p.checkouts?.some((c) => c.path === card.projectPath),
  );
  if (!project) {
    return { error: `That card's project (${card.projectPath}) isn't one the scanner knows — relink the card.` };
  }
  if (project.missing) {
    return { error: `${project.displayName} is missing from disk — relocate it before dispatching.` };
  }

  const prompt = composeDispatchPrompt(card);
  if (!freshWorktree) return { plan: { cwd: card.projectPath, prompt } };

  const repoDir = card.projectPath;
  const base = slugify(card.title);
  const parent = path.dirname(repoDir);
  const repoName = path.basename(repoDir);
  const fileExists = exists ?? fs.existsSync;
  // agents/ sibling dir keeps worktrees out of the repo (git refuses nesting)
  // and out of the parent's top level, where a pile of slugs would read as
  // projects. Uniqued with -2, -3… on collision rather than failing.
  let slug = base;
  for (let n = 2; fileExists(path.join(parent, `${repoName}-agents`, slug)); n++) {
    slug = `${base}-${n}`;
  }
  const worktreePath = path.join(parent, `${repoName}-agents`, slug);
  return {
    plan: {
      cwd: worktreePath,
      worktree: { repoDir, path: worktreePath, branch: `agent/${slug}` },
      prompt,
    },
  };
}

/**
 * The Terminal launch command. The prompt travels via a file, not the
 * command line: card notes are arbitrary text, and one layer of quoting
 * (shell) wrapped in another (AppleScript) is exactly where injection bugs
 * live. The file is read back with $(cat …) inside the session's own shell.
 */
export function buildTerminalScript(cwd: string, promptFile: string): string {
  const shell = `cd ${shellQuote(cwd)} && claude "$(cat ${shellQuote(promptFile)})"`;
  return `tell application "Terminal"
	activate
	do script ${appleScriptQuote(shell)}
end tell`;
}

export interface PerformDeps {
  run?: (file: string, args: string[]) => Promise<unknown>;
  writePrompt?: (id: string, prompt: string) => string;
  now?: number;
  platform?: NodeJS.Platform;
}

function defaultWritePrompt(id: string, prompt: string): string {
  const dir = path.join(dataDir, "dispatch");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  fs.writeFileSync(file, prompt, "utf8");
  return file;
}

/**
 * Execute a resolved plan: cut the worktree if asked, open Terminal on the
 * seeded session, and stamp the card (top of "In progress", dispatch record).
 * Errors surface verbatim — "git worktree add failed: …" is actionable,
 * a swallowed one is a Terminal window that never appeared.
 */
export async function performDispatch(
  cardId: string,
  plan: DispatchPlan,
  deps: PerformDeps = {},
): Promise<BoardCard[]> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error("Dispatch opens a Terminal session, which needs macOS.");
  }
  const run = deps.run ?? ((file: string, args: string[]) => execFileAsync(file, args));
  const writePrompt = deps.writePrompt ?? defaultWritePrompt;
  const now = deps.now ?? Date.now();

  if (plan.worktree) {
    fs.mkdirSync(path.dirname(plan.worktree.path), { recursive: true });
    try {
      await run("git", ["-C", plan.worktree.repoDir, "worktree", "add", plan.worktree.path, "-b", plan.worktree.branch]);
    } catch (err) {
      throw new Error(`git worktree add failed: ${(err as Error).message}`);
    }
  }

  const promptFile = writePrompt(cardId, plan.prompt);
  await run("osascript", ["-e", buildTerminalScript(plan.cwd, promptFile)]);

  // Stamp the card last, so a failed launch leaves the board truthful.
  const nowIso = new Date(now).toISOString();
  const card = boardDb.data.cards.find((c) => c.id === cardId);
  if (card) {
    card.column = "doing";
    card.updatedAt = nowIso;
    delete card.doneAt;
    card.dispatch = {
      at: nowIso,
      path: plan.cwd,
      ...(plan.worktree ? { branch: plan.worktree.branch } : {}),
    };
    // Top of In progress: the thing just started is the thing being watched.
    boardDb.data.cards = [card, ...boardDb.data.cards.filter((c) => c.id !== cardId)];
    await boardDb.write();
  }
  return boardDb.data.cards;
}
