import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { MarkdownDoc } from "@shared/types.js";

const CANDIDATE_FILES = ["README.md", "TODO.md", "STATUS.md", "ROADMAP.md", "PLAN.md", "CLAUDE.md"];

function firstHeading(content: string): string | undefined {
  const match = content.match(/^#{1,3}\s+(.+)$/m);
  return match?.[1]?.trim();
}

function readDoc(fullPath: string, relativePath: string): MarkdownDoc | null {
  try {
    const stat = fs.statSync(fullPath);
    const raw = fs.readFileSync(fullPath, "utf8");
    const parsed = matter(raw);
    return {
      file: fullPath,
      relativePath,
      mtime: stat.mtime.toISOString(),
      firstHeading: firstHeading(parsed.content),
      status: typeof parsed.data?.status === "string" ? parsed.data.status : undefined,
    };
  } catch {
    return null;
  }
}

export function scanMarkdown(projectPath: string): MarkdownDoc[] {
  const docs: MarkdownDoc[] = [];
  if (!fs.existsSync(projectPath)) return docs;

  for (const name of CANDIDATE_FILES) {
    const doc = readDoc(path.join(projectPath, name), name);
    if (doc) docs.push(doc);
  }

  const docsDir = path.join(projectPath, "docs");
  try {
    const entries = fs.readdirSync(docsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = path.join("docs", entry.name);
        const doc = readDoc(path.join(docsDir, entry.name), rel);
        if (doc) docs.push(doc);
      }
    }
  } catch {
    // no docs dir, that's fine
  }

  return docs;
}
