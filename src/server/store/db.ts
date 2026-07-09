import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONFilePreset } from "lowdb/node";
import type { Override, AttentionItem, GithubStatus, ProjectSummary } from "@shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../../../data");
fs.mkdirSync(dataDir, { recursive: true });

export type OverridesData = Record<string, Override>;
export interface AttentionData {
  items: AttentionItem[];
}
export type GithubData = Record<string, GithubStatus>;
export type SummariesData = Record<string, ProjectSummary>;

export const overridesDb = await JSONFilePreset<OverridesData>(path.join(dataDir, "overrides.json"), {});
export const attentionDb = await JSONFilePreset<AttentionData>(path.join(dataDir, "attention.json"), {
  items: [],
});
export const githubDb = await JSONFilePreset<GithubData>(path.join(dataDir, "github.json"), {});
export const summariesDb = await JSONFilePreset<SummariesData>(path.join(dataDir, "summaries.json"), {});
