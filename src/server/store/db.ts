import fs from "node:fs";
import path from "node:path";
import { JSONFilePreset } from "lowdb/node";
import { resolveDataDir } from "../appPaths.js";
import type { Override, AttentionItem, GithubStatus, ProjectSummary, ProjectDetail, DailyDigest, SourceTool } from "@shared/types.js";

/** Exported so startup can log it — inside an app bundle this is the only clue to where the data went. */
export const dataDir = resolveDataDir();
fs.mkdirSync(dataDir, { recursive: true });

export type OverridesData = Record<string, Override>;
export interface AttentionData {
  items: AttentionItem[];
}
export type GithubData = Record<string, GithubStatus>;
export type SummariesData = Record<string, ProjectSummary>;
export type DetailsData = Record<string, ProjectDetail>;
export interface AiUsageData {
  date: string; // YYYY-MM-DD; resets the daily counter when the day rolls over
  calls: number;
}

export const overridesDb = await JSONFilePreset<OverridesData>(path.join(dataDir, "overrides.json"), {});
export const attentionDb = await JSONFilePreset<AttentionData>(path.join(dataDir, "attention.json"), {
  items: [],
});
export const githubDb = await JSONFilePreset<GithubData>(path.join(dataDir, "github.json"), {});
export const summariesDb = await JSONFilePreset<SummariesData>(path.join(dataDir, "summaries.json"), {});
export const detailsDb = await JSONFilePreset<DetailsData>(path.join(dataDir, "details.json"), {});
export const aiUsageDb = await JSONFilePreset<AiUsageData>(path.join(dataDir, "ai-usage.json"), {
  date: "",
  calls: 0,
});
export interface DigestData {
  digest: DailyDigest | null;
}
export const digestDb = await JSONFilePreset<DigestData>(path.join(dataDir, "digest.json"), {
  digest: null,
});

/**
 * Last time a hook event was actually received from each tool. Codex's hooks
 * only fire after a one-off interactive trust approval, so "have we ever heard
 * from them, and how recently" is the only reliable way to know whether the
 * push signal is real — see alert/hookLiveness.ts.
 */
export interface HookLivenessData {
  lastEventAt: Partial<Record<SourceTool, string>>; // ISO timestamps; absent = never seen
}
export const hookLivenessDb = await JSONFilePreset<HookLivenessData>(
  path.join(dataDir, "hook-liveness.json"),
  { lastEventAt: {} },
);
