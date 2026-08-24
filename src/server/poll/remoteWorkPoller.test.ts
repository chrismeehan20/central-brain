import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AttentionItem, Project } from "@shared/types.js";
import type { NotifyOptions } from "../alert/notifier.js";
import type { AttentionStoreLike } from "../alert/attention.js";
import type { RemotePrJson } from "../github/remotePrs.js";
import { createRemoteWorkContext, runRemoteWorkPass } from "./remoteWorkPoller.js";

/**
 * The pass is driven through an injected context: a fake project list, a fake
 * `gh` that returns canned PR JSON, an in-memory attention store, and a stubbed
 * notifier. Nothing here shells out or writes data/*.json.
 *
 * What these tests are really pinning is the difference between a *polled* row
 * and a *pushed* one. A hook row is edge-triggered and only a later event can
 * clear it; a PR row is re-derived every pass, so this module has to delete
 * rows the world no longer justifies — while never mistaking "couldn't ask" for
 * "nothing to report".
 */

const NOW = Date.parse("2026-08-24T12:00:00Z");
const QUIET = new Date(NOW - 30 * 60_000).toISOString();
const REPO = "someone/belfry";

/**
 * A real checkout on disk, because the repo set is derived from `.git/config`
 * rather than injected — stubbing that out would skip the one step that turns a
 * project card into something `gh --repo` can be pointed at.
 */
const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeCheckout(remote = `git@github.com:${REPO}.git`): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-remote-work-test-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
  return dir;
}

const PROJECT = makeCheckout();

interface FakeStore extends AttentionStoreLike {
  writes: number;
}

function makeStore(items: AttentionItem[] = []): FakeStore {
  const store: FakeStore = {
    data: { items },
    writes: 0,
    write: async () => {
      store.writes += 1;
    },
  };
  return store;
}

function project(path = PROJECT): Project {
  return {
    path,
    displayName: "belfry",
    discovered: true,
    hidden: false,
    pinned: false,
    missing: false,
    sessions: [],
    markdown: [],
  };
}

function pr(overrides: Partial<RemotePrJson> = {}): RemotePrJson {
  return {
    number: 11,
    title: "Phase 4",
    url: `https://github.com/${REPO}/pull/11`,
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "",
    headRefName: "claude/phase-4",
    updatedAt: QUIET,
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    ...overrides,
  };
}

interface Harness {
  store: FakeStore;
  logs: string[];
  notifications: NotifyOptions[];
  emitted: number;
  fetchCalls: string[];
  run: () => Promise<boolean>;
  setPrs: (prs: RemotePrJson[]) => void;
  fail: (yes: boolean) => void;
}

interface HarnessOptions {
  items?: AttentionItem[];
  projects?: Project[];
  extraRepos?: string[];
}

function harness({ items = [], projects = [project()], extraRepos = [] }: HarnessOptions = {}): Harness {
  let prs: RemotePrJson[] = [];
  let failing = false;
  const store = makeStore(items);
  const h: Harness = {
    store,
    logs: [],
    notifications: [],
    emitted: 0,
    fetchCalls: [],
    setPrs: (next) => {
      prs = next;
    },
    fail: (yes) => {
      failing = yes;
    },
    run: () => runRemoteWorkPass(ctx),
  };
  const ctx = createRemoteWorkContext({
    projects: () => projects,
    extraRepos: () => extraRepos,
    fetch: async (repo) => {
      h.fetchCalls.push(repo);
      if (failing) throw new Error("gh: not authenticated");
      return prs;
    },
    store,
    notify: async (opts) => {
      h.notifications.push(opts);
    },
    emit: () => {
      h.emitted += 1;
    },
    now: () => NOW,
    log: (message) => h.logs.push(message),
  });
  return h;
}

test("a qualifying PR becomes a row with a link and no session", async () => {
  const h = harness();
  h.setPrs([pr()]);
  assert.equal(await h.run(), true);

  const [item] = h.store.data.items;
  assert.equal(item.tool, "github");
  assert.equal(item.type, "pr-review");
  assert.equal(item.id, `pr:${REPO}#11`);
  assert.equal(item.pr?.url, `https://github.com/${REPO}/pull/11`);
  assert.equal(
    item.projectPath,
    PROJECT,
    "the repo was found through the project's origin remote, so the row lands on that card"
  );
  assert.equal(
    item.sessionId,
    item.id,
    "the synthetic id keeps PR rows out of clearSession, which matches hook rows by session id"
  );
  assert.equal(h.store.writes, 1);
  assert.equal(h.emitted, 1);
});

test("a repo watched by hand, with no checkout here, still produces a row", async () => {
  // The reason the preference exists: project discovery is session-derived, so
  // a repo you only ever touch from claude.ai/code never becomes a card, and
  // nothing would ever ask about it.
  const h = harness({ projects: [], extraRepos: ["someone/cloud-only"] });
  h.setPrs([pr()]);
  await h.run();
  assert.deepEqual(h.fetchCalls, ["someone/cloud-only"]);
  assert.equal(h.store.data.items[0].projectPath, "unknown", "nothing local to point at");
});

test("a merged PR's row disappears on the next pass", async () => {
  const h = harness();
  h.setPrs([pr()]);
  await h.run();
  h.setPrs([]);
  assert.equal(await h.run(), true);
  assert.equal(h.store.data.items.length, 0, "polled rows clear themselves; nothing else would");
});

test("a repo we could not reach keeps its rows instead of losing them", async () => {
  const h = harness();
  h.setPrs([pr()]);
  await h.run();
  h.fail(true);
  await h.run();
  assert.equal(
    h.store.data.items.length,
    1,
    "no answer is not the same as 'resolved' — offline must not look like merged"
  );
});

test("a total failure backs off, and says why", async () => {
  const h = harness();
  h.fail(true);
  await h.run();
  const after = h.fetchCalls.length;
  await h.run();
  assert.equal(h.fetchCalls.length, after, "gh missing or unauthenticated will not fix itself in ten minutes");
  assert.equal(h.logs.length, 1);
  assert.match(
    h.logs[0],
    /not authenticated/,
    "silence here is indistinguishable from 'no PRs need you' — the cause has to reach somewhere"
  );
});

test("an unchanged PR does not rewrite the store or bump the row's age", async () => {
  const h = harness();
  h.setPrs([pr()]);
  await h.run();
  const firstUpdated = h.store.data.items[0].updatedAt;
  assert.equal(await h.run(), false);
  assert.equal(h.store.writes, 1, "a second identical pass is not a change");
  assert.equal(h.store.data.items[0].updatedAt, firstUpdated);
});

test("a PR going from green to conflicted updates in place, keeping its snooze", async () => {
  const h = harness();
  h.setPrs([pr()]);
  await h.run();
  h.store.data.items[0].snoozedUntil = "2099-01-01T00:00:00.000Z";
  const createdAt = h.store.data.items[0].createdAt;

  h.setPrs([pr({ mergeable: "CONFLICTING" })]);
  assert.equal(await h.run(), true);
  const [item] = h.store.data.items;
  assert.equal(item.type, "pr-conflict");
  assert.equal(item.priority, "high");
  assert.equal(item.snoozedUntil, "2099-01-01T00:00:00.000Z", "same PR, still snoozed");
  assert.equal(item.createdAt, createdAt);
});

test("hook rows are left alone entirely", async () => {
  const hookRow: AttentionItem = {
    id: "abc:permission",
    sessionId: "abc",
    projectPath: PROJECT,
    tool: "claude",
    type: "permission",
    priority: "high",
    createdAt: QUIET,
    updatedAt: QUIET,
  };
  const h = harness({ items: [hookRow] });
  h.setPrs([]);
  await h.run();
  assert.deepEqual(h.store.data.items, [hookRow]);
});

test("rows for a repo that stopped being watched are dropped", async () => {
  const h = harness();
  h.setPrs([pr()]);
  await h.run();
  assert.equal(h.store.data.items.length, 1);

  // The project was hidden, renamed onto another remote, or its checkout went
  // away — either way nothing asks about this repo any more.
  const h2 = harness({ items: h.store.data.items, projects: [project(makeCheckout("git@github.com:someone/other.git"))] });
  h2.setPrs([]);
  await h2.run();
  assert.equal(h2.store.data.items.length, 0, "otherwise an un-watched repo's rows are immortal");
});

test("a pile of new rows collapses into one notification", async () => {
  const h = harness();
  h.setPrs([pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3 })]);
  await h.run();
  assert.equal(h.notifications.length, 1, "twelve banners is not twelve times the signal");
  assert.match(h.notifications[0].title, /3 pull requests/);
});

test("one or two new rows get their own notification", async () => {
  const h = harness();
  h.setPrs([pr({ number: 1, mergeable: "CONFLICTING" })]);
  await h.run();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].sound, true, "a blocked PR is worth a sound; a finished draft is not");
});

test("nothing new means nothing said", async () => {
  const h = harness();
  h.setPrs([pr()]);
  await h.run();
  h.notifications.length = 0;
  await h.run();
  assert.equal(h.notifications.length, 0);
});
