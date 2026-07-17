import path from "node:path";

/**
 * Both Claude Code and Codex report `cwd` as the actual on-disk path
 * (from process.cwd()), so path.resolve alone is a consistent join key
 * across the two tools without needing to lowercase/normalize case.
 * (Case-variant duplicates are merged in resolveProjects.)
 */
export function canonicalize(rawPath: string): string {
  return path.resolve(rawPath);
}

/**
 * Normalize any timestamp representation to UTC ISO with a trailing Z, so
 * cross-source string comparison/sorting is always valid regardless of how
 * the source tool formatted it.
 */
export function toUtcIso(value: string | number | Date | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? fallback : t.toISOString();
}
