import type { Project, Override, ProjectSummary, ProjectDetail, DetailItemKind, DailyDigest } from "@shared/types";

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

export async function fetchDigest(): Promise<{ digest: DailyDigest | null }> {
  const res = await fetch("/api/digest");
  if (!res.ok) throw new Error(`Failed to load digest: ${res.status}`);
  return res.json();
}

export async function refreshDigest(): Promise<{ digest: DailyDigest }> {
  const res = await fetch("/api/digest/refresh", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to refresh digest: ${res.status}`);
  }
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

async function detailRequest(
  url: string,
  method: string,
  body: Record<string, unknown>
): Promise<ProjectDetail> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Request failed: ${res.status}`);
  }
  return (await res.json()).detail;
}

export async function fetchProjectDetail(path: string): Promise<ProjectDetail> {
  const res = await fetch(`/api/projects/detail?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to load detail: ${res.status}`);
  return (await res.json()).detail;
}

export function refreshProjectDetail(path: string): Promise<ProjectDetail> {
  return detailRequest("/api/projects/detail/refresh", "POST", { path });
}

export function addDetailItem(
  path: string,
  kind: DetailItemKind,
  text: string
): Promise<ProjectDetail> {
  return detailRequest("/api/projects/detail/item", "POST", { path, kind, text });
}

export function updateDetailItem(
  path: string,
  id: string,
  patch: { status?: "open" | "done" | "dismissed"; text?: string; note?: string }
): Promise<ProjectDetail> {
  return detailRequest("/api/projects/detail/item", "PATCH", { path, id, ...patch });
}

export function saveDetailNotes(path: string, notes: string): Promise<ProjectDetail> {
  return detailRequest("/api/projects/detail/notes", "PUT", { path, notes });
}
