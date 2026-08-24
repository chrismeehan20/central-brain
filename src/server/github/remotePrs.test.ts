import { test } from "node:test";
import assert from "node:assert/strict";
import type { Project } from "@shared/types.js";
import {
  MAX_REPOS,
  QUIET_MS,
  classifyPr,
  fetchAuthoredPrs,
  repoSlugForCheckout,
  resolveWatchedRepos,
  type RemotePrJson,
} from "./remotePrs.js";

const NOW = Date.parse("2026-08-24T12:00:00Z");
/** Quiet long enough to qualify, well inside the max-age ceiling. */
const QUIET = new Date(NOW - 30 * 60_000).toISOString();

const check = (conclusion: string | null, status = conclusion ? "COMPLETED" : "IN_PROGRESS") => ({
  __typename: "CheckRun",
  name: "test",
  status,
  conclusion,
});

function pr(overrides: Partial<RemotePrJson> = {}): RemotePrJson {
  return {
    number: 11,
    title: "Phase 4",
    url: "https://github.com/o/r/pull/11",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "",
    headRefName: "claude/phase-4",
    updatedAt: QUIET,
    statusCheckRollup: [check("SUCCESS")],
    ...overrides,
  };
}

test("a PR still being pushed to says nothing", () => {
  const justPushed = pr({ updatedAt: new Date(NOW - 60_000).toISOString() });
  assert.equal(
    classifyPr(justPushed, NOW),
    null,
    "a cloud session mid-run is not waiting on you, and its own harness fixes its own CI"
  );
});

test("the quiet window is the only thing separating in-flight from finished", () => {
  assert.equal(classifyPr(pr({ updatedAt: new Date(NOW - QUIET_MS + 1000).toISOString() }), NOW), null);
  assert.ok(classifyPr(pr({ updatedAt: new Date(NOW - QUIET_MS - 1000).toISOString() }), NOW));
});

test("a PR nobody has touched in weeks is backlog, not an alert", () => {
  const ancient = pr({ updatedAt: new Date(NOW - 30 * 24 * 60 * 60_000).toISOString() });
  assert.equal(classifyPr(ancient, NOW), null);
});

test("a merge conflict outranks red CI — it blocks even a green PR", () => {
  const verdict = classifyPr(
    pr({ mergeable: "CONFLICTING", statusCheckRollup: [check("FAILURE")] }),
    NOW
  );
  assert.equal(verdict?.type, "pr-conflict");
});

test("failing CI names the branch, so the row is actionable without opening it", () => {
  const verdict = classifyPr(pr({ statusCheckRollup: [check("FAILURE")] }), NOW);
  assert.equal(verdict?.type, "pr-ci-failed");
  assert.match(verdict!.message, /claude\/phase-4/);
});

test("checks still running produce no row — the verdict isn't in yet", () => {
  assert.equal(classifyPr(pr({ statusCheckRollup: [check(null, "IN_PROGRESS")] }), NOW), null);
});

test("changes requested is the user's move even though CI is green", () => {
  const verdict = classifyPr(pr({ reviewDecision: "CHANGES_REQUESTED" }), NOW);
  assert.equal(verdict?.type, "pr-review");
});

test("a finished draft is the core cloud-session signal, not something to ignore", () => {
  // Sessions on the web open drafts by default, so skipping drafts would skip
  // almost everything this poller exists to surface.
  const verdict = classifyPr(pr({ isDraft: true }), NOW);
  assert.equal(verdict?.type, "pr-review");
  assert.match(verdict!.message, /Draft finished/);
});

test("an open, green, unconflicted PR in a repo with no required reviews is yours to merge", () => {
  // reviewDecision is "" on a personal repo — the common case here — so a rule
  // keyed on REVIEW_REQUIRED alone would never fire at all.
  const verdict = classifyPr(pr({ reviewDecision: "" }), NOW);
  assert.deepEqual(verdict, { type: "pr-review", message: "Ready to merge" });
});

test("a PR with no timestamp is skipped rather than guessed at", () => {
  assert.equal(classifyPr(pr({ updatedAt: undefined }), NOW), null);
});

test("github checkouts resolve to owner/repo, other hosts don't", () => {
  const config = (url: string) => `[remote "origin"]\n\turl = ${url}\n`;
  const read = (text: string | null) => () => text;
  assert.equal(
    repoSlugForCheckout("/x", read(config("git@github.com:Chris/Belfry.git"))),
    "chris/belfry",
    "gh is case-insensitive about slugs; normalizing keeps one repo from being watched twice"
  );
  assert.equal(repoSlugForCheckout("/x", read(config("https://gitlab.com/a/b.git"))), null);
  assert.equal(repoSlugForCheckout("/x", read(null)), null, "not a git checkout");
});

function project(path: string, extra: Partial<Project> = {}): Project {
  return {
    path,
    displayName: path,
    discovered: true,
    hidden: false,
    pinned: false,
    missing: false,
    sessions: [],
    markdown: [],
    ...extra,
  };
}

test("hidden and missing projects are not queried", () => {
  const watched = resolveWatchedRepos(
    [
      project("/a"),
      project("/b", { hidden: true }),
      project("/c", { missing: true }),
    ],
    [],
    (p) => `o${p.replace("/", "")}/r`
  );
  assert.deepEqual([...watched.keys()], ["oa/r"]);
});

test("a manually watched repo maps to no project, and never overrides a real one", () => {
  const watched = resolveWatchedRepos([project("/a")], ["o/r", "someone/cloud-only", "not a repo"], () => "o/r");
  assert.equal(watched.get("o/r"), "/a", "the local checkout keeps the mapping");
  assert.equal(watched.get("someone/cloud-only"), "unknown");
  assert.equal(watched.has("not a repo"), false, "junk never reaches an argv");
});

test("the repo set is capped so a pass can't spawn unbounded subprocesses", () => {
  const projects = Array.from({ length: MAX_REPOS + 10 }, (_, i) => project(`/p${i}`));
  const watched = resolveWatchedRepos(projects, [], (p) => `o${p.slice(2)}/r`);
  assert.equal(watched.size, MAX_REPOS);
});

test("a malformed slug is refused before it becomes a gh argument", async () => {
  await assert.rejects(
    () => fetchAuthoredPrs("--version", async () => "[]"),
    /malformed repo slug/
  );
});

test("fetch asks only for the caller's own open PRs", async () => {
  let seen: string[] = [];
  await fetchAuthoredPrs("o/r", async (_cmd, args) => {
    seen = args;
    return "[]";
  });
  assert.ok(seen.includes("--author") && seen.includes("@me"));
  assert.ok(seen.includes("--state") && seen.includes("open"));
  assert.equal(seen[seen.indexOf("--repo") + 1], "o/r");
});

test("an empty gh response is not a parse error", async () => {
  assert.deepEqual(await fetchAuthoredPrs("o/r", async () => ""), []);
});
