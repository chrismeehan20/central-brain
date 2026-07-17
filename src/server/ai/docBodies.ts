import fs from "node:fs";
import matter from "gray-matter";
import type { Project } from "@shared/types.js";

// Planning docs worth feeding to the AI. CLAUDE.md is included — it often
// carries the project's real intent/roadmap notes.
export const PLANNING_DOC_RE = /README|TODO|STATUS|PLAN|ROADMAP|CLAUDE/i;

export interface DocBodyOptions {
  filter?: RegExp;
  budget?: number; // total chars across all docs
  perDoc?: number; // chars kept per doc
}

/** Frontmatter-stripped bodies of a project's planning docs, within a char budget. */
export function readDocBodies(project: Project, opts: DocBodyOptions = {}): string {
  const { filter = PLANNING_DOC_RE, budget: totalBudget = 6000, perDoc = 1600 } = opts;
  const wanted = project.markdown.filter((d) => filter.test(d.relativePath));
  const parts: string[] = [];
  let budget = totalBudget;
  for (const doc of wanted) {
    if (budget <= 0) break;
    try {
      const body = matter(fs.readFileSync(doc.file, "utf8")).content.trim();
      if (!body) continue;
      const slice = body.slice(0, Math.min(perDoc, budget));
      parts.push(`### ${doc.relativePath}\n${slice}`);
      budget -= slice.length;
    } catch {
      // unreadable doc — skip
    }
  }
  return parts.join("\n\n");
}
