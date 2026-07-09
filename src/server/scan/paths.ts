import path from "node:path";

/**
 * Both Claude Code and Codex report `cwd` as the actual on-disk path
 * (from process.cwd()), so path.resolve alone is a consistent join key
 * across the two tools without needing to lowercase/normalize case.
 */
export function canonicalize(rawPath: string): string {
  return path.resolve(rawPath);
}
