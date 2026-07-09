import type { Project } from "@shared/types.js";
import { resolveProjects } from "./resolveProject.js";

let cache: Project[] = [];
let lastScanAt: string | null = null;

export function runScan(): Project[] {
  cache = resolveProjects();
  lastScanAt = new Date().toISOString();
  return cache;
}

export function getCachedProjects(): Project[] {
  return cache;
}

export function getLastScanAt(): string | null {
  return lastScanAt;
}
