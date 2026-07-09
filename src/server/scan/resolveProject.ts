import path from "node:path";
import type { Project, SessionRef } from "@shared/types.js";
import { scanClaudeProjects } from "./claude.js";
import { scanCodexProjects } from "./codex.js";
import { scanMarkdown } from "./markdown.js";
import { overridesDb } from "../store/db.js";

function defaultDisplayName(projectPath: string): string {
  return path
    .basename(projectPath)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveProjects(): Project[] {
  const claudeSessions = scanClaudeProjects();
  const codexSessions = scanCodexProjects();

  const keys = new Set([...Object.keys(claudeSessions), ...Object.keys(codexSessions)]);
  const projects: Project[] = [];

  for (const key of keys) {
    const sessions: SessionRef[] = [...(claudeSessions[key] ?? []), ...(codexSessions[key] ?? [])];
    if (!sessions.length) continue;

    sessions.sort((a, b) => (a.lastActivity > b.lastActivity ? -1 : 1));

    const override = overridesDb.data[key];
    const markdown = scanMarkdown(key);

    projects.push({
      path: key,
      displayName: override?.displayName ?? defaultDisplayName(key),
      discovered: !override,
      hidden: override?.hidden ?? false,
      pinned: override?.pinned ?? false,
      lastActivity: sessions[0]?.lastActivity,
      sessions,
      markdown,
    });
  }

  projects.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
  });

  return projects;
}
