import type { Override, Project } from "@shared/types.js";
import { compareProjects, resolveProjects } from "./resolveProject.js";

let cache: Project[] = [];
let lastScanAt: string | null = null;

export function runScan(): Project[] {
  cache = resolveProjects();
  lastScanAt = new Date().toISOString();
  return cache;
}

/**
 * Apply an override (hide/pin/rename/keep) to the cached projects without a
 * full rescan — a rescan re-reads every session dir and markdown tree and
 * made these one-click actions feel stalled. The watcher/interval scan keeps
 * everything else fresh.
 */
export function applyOverrideToCache(projectPath: string, override: Override | undefined): Project[] {
  const project = cache.find((p) => p.path === projectPath);
  if (project) {
    project.discovered = !override;
    project.hidden = override?.hidden ?? false;
    project.pinned = override?.pinned ?? false;
    if (override?.displayName) project.displayName = override.displayName;
    cache.sort(compareProjects);
  }
  return cache;
}

export function getCachedProjects(): Project[] {
  return cache;
}

export function getLastScanAt(): string | null {
  return lastScanAt;
}
