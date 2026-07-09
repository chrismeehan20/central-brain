import type { Project, Override, ProjectSummary } from "@shared/types";

export async function fetchProjects(): Promise<{ projects: Project[]; lastScanAt: string | null }> {
  const res = await fetch("/api/projects");
  if (!res.ok) throw new Error(`Failed to load projects: ${res.status}`);
  return res.json();
}

export async function triggerScan(): Promise<{ projects: Project[] }> {
  const res = await fetch("/api/scan", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to scan: ${res.status}`);
  return res.json();
}

export async function updateOverride(
  path: string,
  override: Partial<Override>
): Promise<{ projects: Project[] }> {
  const res = await fetch("/api/overrides", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, override }),
  });
  if (!res.ok) throw new Error(`Failed to update override: ${res.status}`);
  return res.json();
}

export async function summarizeProject(path: string): Promise<{ summary: ProjectSummary }> {
  const res = await fetch("/api/projects/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to summarize: ${res.status}`);
  }
  return res.json();
}
