/**
 * Central Brain's MCP server: the door through which coding agents read and
 * write the brain. A Claude Code session anywhere on the machine can ask
 * "what's waiting on Chris across every project?", file follow-up work onto
 * the mission-control board as it finishes, or pull another project's summary
 * before touching shared code.
 *
 * Runs as a separate stdio process (one per connected agent session) and
 * talks HTTP to the running dashboard server rather than opening the lowdb
 * files itself: two processes writing those JSON files would corrupt them,
 * and the HTTP API is already the single source of truth with its own
 * validation. The endpoint is read from <dataDir>/runtime/endpoint — the same
 * file the Codex hook forwarder uses — so a CENTRAL_BRAIN_PORT change needs
 * no MCP reconfiguration either.
 */
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type {
  ActivityEvent,
  AttentionItem,
  BoardCard,
  BoardColumnId,
  Project,
  ProjectDetail,
} from "@shared/types.js";
import { BOARD_COLUMNS } from "@shared/types.js";
import { fleetRows } from "@shared/fleet.js";
import { resolveDataDir } from "../appPaths.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:4317";

function resolveEndpoint(): string {
  try {
    const raw = fs.readFileSync(path.join(resolveDataDir(), "runtime", "endpoint"), "utf8").trim();
    if (raw.startsWith("http")) return raw;
  } catch {
    // No runtime file (server never ran, or a custom data dir) — the default
    // port is the best remaining guess.
  }
  return DEFAULT_ENDPOINT;
}

const endpoint = resolveEndpoint();

async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(endpoint + pathname, init);
  } catch {
    throw new Error(
      `Central Brain isn't reachable at ${endpoint}. Launch the Central Brain menubar app ` +
        `(or \`npm run dev\` in its repo), then retry.`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Central Brain returned ${res.status} for ${pathname}`);
  return body;
}

/** One line of a string, capped — tool output is context an agent pays for. */
function clip(text: string | undefined, max = 200): string | undefined {
  if (!text) return undefined;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function dropEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)),
  ) as Partial<T>;
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}

async function fetchProjects(): Promise<Project[]> {
  return (await api<{ projects: Project[] }>("/api/projects")).projects;
}

function cardLine(card: BoardCard) {
  return dropEmpty({
    id: card.id,
    title: card.title,
    column: card.column,
    projectPath: card.projectPath,
    note: clip(card.note),
    updatedAt: card.updatedAt,
    doneAt: card.doneAt,
  });
}

const COLUMN_IDS = BOARD_COLUMNS.map((c) => c.id) as [BoardColumnId, ...BoardColumnId[]];

const server = new McpServer({ name: "central-brain", version: "1.0.0" });

server.registerTool(
  "brain_fleet_status",
  {
    title: "Fleet status",
    description:
      "Live state of every AI agent session across all projects: which agents are blocked waiting " +
      "on the user (and why), which are actively working right now, plus per-view counts. " +
      "Call this first to orient before asking about specific projects.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const [projects, attention] = await Promise.all([
      fetchProjects(),
      api<{ items: AttentionItem[] }>("/api/attention"),
    ]);
    const rows = fleetRows(projects, attention.items, Date.now());
    const summarize = (status: string) =>
      rows
        .filter((r) => r.status === status)
        .slice(0, 30)
        .map((r) =>
          dropEmpty({
            project: r.projectName,
            projectPath: r.projectPath,
            tool: r.tool,
            branch: r.branch,
            lastActivity: r.lastActivity,
            about: clip(r.label, 120),
            waitingOn: r.waitingOn,
          }),
        );
    return json({
      waitingOnUser: summarize("waiting"),
      activeNow: summarize("active"),
      idleRecent: rows.filter((r) => r.status === "idle").length,
      note: "activeNow = transcript moved in the last 10 minutes (heuristic); waitingOnUser = a hook event flagged the session blocked.",
    });
  },
);

server.registerTool(
  "brain_list_projects",
  {
    title: "List projects",
    description:
      "Every project Central Brain tracks (auto-discovered from Claude Code / Codex session stores), " +
      "with last activity, git branch, CI state, open PR count, and the AI one-line summary when one exists. " +
      "Optionally filter by a case-insensitive substring of the name or path.",
    inputSchema: { query: z.string().optional().describe("Substring filter on name or path") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query }) => {
    const q = query?.toLowerCase();
    const projects = (await fetchProjects())
      .filter((p) => !p.hidden)
      .filter((p) => !q || p.displayName.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      .slice(0, 60)
      .map((p) =>
        dropEmpty({
          name: p.displayName,
          path: p.path,
          lastActivity: p.lastActivity,
          sessions: p.sessions.length,
          branch: p.github?.branch,
          dirty: p.github?.dirty,
          ci: p.github?.ciStatus,
          openPrs: p.github?.openPrs?.length,
          summary: clip(p.summary?.text),
          missing: p.missing || undefined,
        }),
      );
    return json({ projects });
  },
);

server.registerTool(
  "brain_project",
  {
    title: "Project detail",
    description:
      "Deep view of one project by its absolute path (get paths from brain_list_projects): open to-dos, " +
      "decisions and blockers from its detail board, the user's own notes, linked markdown docs, git/PR/CI " +
      "state, and recent agent sessions.",
    inputSchema: { path: z.string().describe("The project's absolute canonical path") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ path: projectPath }) => {
    const projects = await fetchProjects();
    const project = projects.find((p) => p.path === projectPath);
    if (!project) {
      const near = projects
        .filter((p) => p.path.toLowerCase().includes(projectPath.toLowerCase().split("/").pop() ?? ""))
        .map((p) => p.path)
        .slice(0, 5);
      throw new Error(
        `No project at ${projectPath}.` + (near.length ? ` Did you mean: ${near.join(", ")}` : " Use brain_list_projects first."),
      );
    }
    const { detail } = await api<{ detail: ProjectDetail }>(
      `/api/projects/detail?path=${encodeURIComponent(projectPath)}`,
    );
    return json(
      dropEmpty({
        name: project.displayName,
        path: project.path,
        summary: clip(project.summary?.text, 400),
        github: project.github
          ? dropEmpty({
              branch: project.github.branch,
              dirty: project.github.dirty,
              ahead: project.github.ahead,
              behind: project.github.behind,
              ci: project.github.ciStatus,
              openPrs: project.github.openPrs?.map((pr) => `#${pr.number} ${pr.title} (${pr.isDraft ? "draft" : pr.state}${pr.ciStatus ? `, ci ${pr.ciStatus}` : ""})`),
              lastCommit: clip(project.github.lastCommitMessage, 100),
            })
          : undefined,
        openItems: detail.items
          .filter((i) => i.status === "open")
          .map((i) => dropEmpty({ kind: i.kind, text: clip(i.text, 200) })),
        userNotes: clip(detail.notes, 1500),
        docs: project.markdown.slice(0, 15).map((d) => d.relativePath),
        checkouts: project.checkouts?.map((c) => dropEmpty({ path: c.path, branch: c.branch, dirty: c.dirty, primary: c.primary || undefined })),
        recentSessions: project.sessions.slice(0, 8).map((s) =>
          dropEmpty({ tool: s.tool, lastActivity: s.lastActivity, branch: s.gitBranch, about: clip(s.summary ?? s.firstPrompt, 120) }),
        ),
      }),
    );
  },
);

server.registerTool(
  "brain_board_list",
  {
    title: "List board cards",
    description:
      "The cross-project mission-control board: every card with its column " +
      "(inbox = captured, next = chosen to run next, doing = in progress, done), " +
      "linked project, and notes. Cards are ordered by rank within each column.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const { cards } = await api<{ cards: BoardCard[] }>("/api/board");
    return json({ columns: BOARD_COLUMNS.map((c) => ({ id: c.id, label: c.label })), cards: cards.map(cardLine) });
  },
);

server.registerTool(
  "brain_board_add",
  {
    title: "Add a board card",
    description:
      "Capture a piece of work onto the mission-control board. Use this to file follow-up work you " +
      "discover but shouldn't do now — the user triages the inbox. Link the card to a project with " +
      "projectPath (from brain_list_projects) so it shows that project's live agent state.",
    inputSchema: {
      title: z.string().min(1).max(300).describe("Short imperative title, e.g. 'Add retry to the fetcher'"),
      note: z.string().max(5000).optional().describe("Context the person picking this up will need"),
      projectPath: z.string().optional().describe("Absolute path of the project this belongs to"),
      column: z.enum(COLUMN_IDS).optional().describe("Defaults to inbox; only use doing/done when that is already true"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (input) => {
    const { cards } = await api<{ cards: BoardCard[] }>("/api/board/card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return json({ added: cardLine(cards[0]), boardSize: cards.length });
  },
);

server.registerTool(
  "brain_board_move",
  {
    title: "Move a board card",
    description:
      "Move a card (by id from brain_board_list) to a column, at an optional rank (0 = top; omitted = top). " +
      "Moving to done marks the work finished.",
    inputSchema: {
      id: z.string().describe("Card id from brain_board_list"),
      column: z.enum(COLUMN_IDS),
      index: z.number().int().min(0).optional().describe("Rank within the column; 0 (default) = top"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id, column, index }) => {
    const { cards } = await api<{ cards: BoardCard[] }>("/api/board/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, column, index: index ?? 0 }),
    });
    const moved = cards.find((c) => c.id === id);
    return json({ moved: moved ? cardLine(moved) : null });
  },
);

server.registerTool(
  "brain_board_update",
  {
    title: "Update a board card",
    description: "Edit a card's title, note, or project link (empty note clears it; empty projectPath unlinks).",
    inputSchema: {
      id: z.string().describe("Card id from brain_board_list"),
      title: z.string().min(1).max(300).optional(),
      note: z.string().max(5000).optional(),
      projectPath: z.string().optional().describe("Empty string unlinks the card from its project"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id, title, note, projectPath }) => {
    const { cards } = await api<{ cards: BoardCard[] }>("/api/board/card", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        ...(title !== undefined ? { title } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(projectPath !== undefined ? { projectPath: projectPath || null } : {}),
      }),
    });
    const updated = cards.find((c) => c.id === id);
    return json({ updated: updated ? cardLine(updated) : null });
  },
);

server.registerTool(
  "brain_recent_activity",
  {
    title: "Recent activity",
    description:
      "The rolling stream of agent hook events across all projects, newest first: sessions starting, " +
      "prompts sent, permission asks, turns finishing. Metadata only — event names, never prompt contents.",
    inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("Max events (default 30)") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ limit }) => {
    const { events } = await api<{ events: ActivityEvent[] }>("/api/activity");
    return json({
      events: events
        .slice(-(limit ?? 30))
        .reverse()
        .map((e) => dropEmpty({ at: e.at, tool: e.tool, projectPath: e.projectPath, what: e.message })),
    });
  },
);

await server.connect(new StdioServerTransport());
