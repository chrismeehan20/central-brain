import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONFilePreset } from "lowdb/node";
import type { Override, AttentionItem, GithubStatus, ProjectSummary, ProjectDetail, DailyDigest } from "@shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../../../data");
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
