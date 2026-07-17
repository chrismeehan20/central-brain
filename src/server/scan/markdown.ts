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

const DOCS_MAX_DEPTH = 3;
const DOCS_MAX_FILES = 30;
const SKIP_DIRS = /^(node_modules|dist|build|target|coverage|\..+)$/;

function walkDocsDir(dir: string, relDir: string, depth: number, docs: MarkdownDoc[]): void {
  if (depth > DOCS_MAX_DEPTH || docs.length >= DOCS_MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no docs dir, that's fine
  }
  for (const entry of entries) {
    if (docs.length >= DOCS_MAX_FILES) return;
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.test(entry.name)) walkDocsDir(path.join(dir, entry.name), rel, depth + 1, docs);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const doc = readDoc(path.join(dir, entry.name), rel);
      if (doc) docs.push(doc);
    }
  }
}

export function scanMarkdown(projectPath: string): MarkdownDoc[] {
  const docs: MarkdownDoc[] = [];
  if (!fs.existsSync(projectPath)) return docs;

  for (const name of CANDIDATE_FILES) {
    const doc = readDoc(path.join(projectPath, name), name);
    if (doc) docs.push(doc);
  }

  walkDocsDir(path.join(projectPath, "docs"), "docs", 1, docs);

  return docs;
}
