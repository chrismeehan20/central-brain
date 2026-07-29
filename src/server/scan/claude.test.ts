import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "./paths.js";
import { scanClaudeProjects } from "./claude.js";

const tmpDirs: string[] = [];

function makeProjectsRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "central-brain-claude-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeProjectDir(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function userLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "user", ...fields });
}

function writeTranscript(dir: string, sessionId: string, lines: string[]): string {
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scanClaudeProjects resolves a transcript from its first user line with a cwd", () => {
  const root = makeProjectsRoot();
  const dir = makeProjectDir(root, "-Users-someone-code-alpha");
  const file = writeTranscript(dir, "sess-alpha", [
    JSON.stringify({ type: "queue-operation", note: "no cwd here" }),
    // A user entry with no cwd must not win over the later one that has it.
    userLine({ message: { content: [{ type: "text", text: "ignored, no cwd" }] } }),
    userLine({
      cwd: "/Users/someone/code/alpha/./",
      gitBranch: "feature/bounded-reads",
      entrypoint: "claude-vscode",
      message: { content: [{ type: "thinking" }, { type: "text", text: "first real prompt" }] },
    }),
    JSON.stringify({ type: "assistant", cwd: "/Users/someone/code/other" }),
  ]);

  const scanned = scanClaudeProjects(root);
  const key = canonicalize("/Users/someone/code/alpha");

  assert.deepEqual(Object.keys(scanned), [key], "expected exactly one project key, canonicalized");
  const sessions = scanned[key]!;
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], {
    tool: "claude",
    sessionId: "sess-alpha",
    lastActivity: fs.statSync(file).mtime.toISOString(),
    firstPrompt: "first real prompt",
    gitBranch: "feature/bounded-reads",
    entrypoint: "claude-vscode",
    transcriptPath: file,
  });
});

test("a transcript with no cwd of its own inherits a sibling transcript's project path", () => {
  const root = makeProjectsRoot();
  const dir = makeProjectDir(root, "-Users-someone-code-beta");
  // Deliberately named so readdir sorts the cwd-less transcript FIRST, proving
  // the fallback is not order-dependent.
  const orphan = writeTranscript(dir, "aaa-orphan", [
    JSON.stringify({ type: "queue-operation", note: "nothing useful" }),
    userLine({ message: { content: [{ type: "text", text: "no cwd anywhere" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
  ]);
  const sibling = writeTranscript(dir, "zzz-sibling", [
    userLine({
      cwd: "/Users/someone/code/beta",
      gitBranch: "main",
      message: { content: [{ type: "text", text: "sibling prompt" }] },
    }),
  ]);

  const scanned = scanClaudeProjects(root);
  const key = canonicalize("/Users/someone/code/beta");

  assert.deepEqual(Object.keys(scanned), [key]);
  const byId = new Map(scanned[key]!.map((s) => [s.sessionId, s]));
  assert.equal(byId.size, 2, "both the orphan and the sibling must be present");

  const orphanRef = byId.get("aaa-orphan");
  assert.ok(orphanRef, "the cwd-less transcript must not be dropped");
  assert.equal(orphanRef.transcriptPath, orphan);
  // Inherited only the project path - none of the sibling's own metadata.
  assert.equal(orphanRef.firstPrompt, undefined);
  assert.equal(orphanRef.gitBranch, undefined);

  const siblingRef = byId.get("zzz-sibling");
  assert.ok(siblingRef);
  assert.equal(siblingRef.transcriptPath, sibling);
  assert.equal(siblingRef.gitBranch, "main");
});

test("a directory where no transcript yields a cwd produces no entry and does not throw", () => {
  const root = makeProjectsRoot();
  const dir = makeProjectDir(root, "-Users-someone-code-gamma");
  writeTranscript(dir, "sess-1", [JSON.stringify({ type: "queue-operation" })]);
  writeTranscript(dir, "sess-2", [userLine({ message: { content: [{ type: "text", text: "hi" }] } })]);

  const scanned = scanClaudeProjects(root);

  assert.deepEqual(scanned, {}, "an unresolvable directory must contribute nothing");
});

test("the transcript read is bounded: a multi-megabyte transcript resolves without being read whole", () => {
  const root = makeProjectsRoot();
  const dir = makeProjectDir(root, "-Users-someone-code-delta");
  const file = path.join(dir, "sess-huge.jsonl");

  const head = userLine({
    cwd: "/Users/someone/code/delta",
    gitBranch: "main",
    message: { content: [{ type: "text", text: "tiny first prompt" }] },
  });
  // ~8 MB of filler after the useful line - twice the scanner's give-up cap.
  const filler = JSON.stringify({ type: "assistant", pad: "x".repeat(64 * 1024) });
  const out = fs.openSync(file, "w");
  try {
    fs.writeSync(out, head + "\n");
    for (let i = 0; i < 128; i++) fs.writeSync(out, filler + "\n");
  } finally {
    fs.closeSync(out);
  }
  const fileSize = fs.statSync(file).size;
  assert.ok(fileSize > 8 * 1024 * 1024, `fixture should be >8MB, got ${fileSize}`);

  // Count bytes actually pulled off disk for this transcript.
  const realReadSync = fs.readSync;
  const realReadFileSync = fs.readFileSync;
  let readSyncCalls = 0;
  let bytesRead = 0;
  let readFileSyncOnJsonl = 0;

  (fs as any).readSync = function (this: unknown, ...args: any[]) {
    const n = (realReadSync as any).apply(this, args);
    readSyncCalls++;
    bytesRead += typeof n === "number" ? n : 0;
    return n;
  };
  (fs as any).readFileSync = function (this: unknown, ...args: any[]) {
    if (typeof args[0] === "string" && args[0].endsWith(".jsonl")) readFileSyncOnJsonl++;
    return (realReadFileSync as any).apply(this, args);
  };

  let scanned: ReturnType<typeof scanClaudeProjects>;
  try {
    scanned = scanClaudeProjects(root);
  } finally {
    fs.readSync = realReadSync;
    fs.readFileSync = realReadFileSync;
  }

  const key = canonicalize("/Users/someone/code/delta");
  assert.equal(scanned[key]?.length, 1, "the huge transcript must still resolve");
  assert.equal(scanned[key]?.[0]?.firstPrompt, "tiny first prompt");

  assert.equal(readFileSyncOnJsonl, 0, "transcripts must never be slurped with readFileSync");
  assert.equal(readSyncCalls, 1, "the first 64KiB chunk already contains the first user line");
  assert.ok(
    bytesRead <= 128 * 1024,
    `expected <=128KiB read from an ${fileSize}-byte transcript, got ${bytesRead}`,
  );
  assert.ok(
    bytesRead < fileSize / 50,
    `expected to read well under 2% of the file, read ${bytesRead} of ${fileSize}`,
  );
});

test("a malformed or truncated JSON line does not throw and does not block a later valid line", () => {
  const root = makeProjectsRoot();
  const dir = makeProjectDir(root, "-Users-someone-code-epsilon");
  const file = path.join(dir, "sess-malformed.jsonl");
  fs.writeFileSync(
    file,
    [
      "{not json at all",
      // A truncated user entry - looks right up until it is cut off mid-object.
      '{"type":"user","cwd":"/Users/someone/code/WRONG","message":{"content":[{"type":"tex',
      "",
      "   ",
      userLine({
        cwd: "/Users/someone/code/epsilon",
        gitBranch: "recovered",
        message: { content: [{ type: "text", text: "recovered prompt" }] },
      }),
      // No trailing newline: the final line must still be parsed at EOF.
    ].join("\n"),
  );

  const scanned = scanClaudeProjects(root);
  const key = canonicalize("/Users/someone/code/epsilon");
  assert.equal(scanned[key]?.length, 1, "the valid line after the malformed ones must resolve");
  assert.equal(scanned[key]?.[0]?.firstPrompt, "recovered prompt");
  assert.equal(canonicalize("/Users/someone/code/WRONG") in scanned, false);
});

test("sessions-index.json entries are honoured and take precedence over a same-id raw transcript", () => {
  const root = makeProjectsRoot();
  const dir = makeProjectDir(root, "-Users-someone-code-zeta");

  fs.writeFileSync(
    path.join(dir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      originalPath: "/Users/someone/code/zeta",
      entries: [
        {
          sessionId: "indexed-and-on-disk",
          fullPath: path.join(dir, "indexed-and-on-disk.jsonl"),
          fileMtime: Date.parse("2024-01-01T00:00:00.000Z"),
          modified: "2024-05-05T12:00:00.000Z",
          firstPrompt: "from the index",
          summary: "indexed summary",
          gitBranch: "index-branch",
        },
        {
          // Transcript was auto-cleaned; the index is the only surviving record.
          sessionId: "deleted-transcript",
          fullPath: path.join(dir, "deleted-transcript.jsonl"),
          fileMtime: Date.parse("2024-02-02T00:00:00.000Z"),
          firstPrompt: "No prompt",
        },
        {
          sessionId: "a-sidechain",
          fullPath: path.join(dir, "a-sidechain.jsonl"),
          fileMtime: Date.parse("2024-03-03T00:00:00.000Z"),
          isSidechain: true,
        },
      ],
    }),
  );

  // Same sessionId as the first index entry, with deliberately different data
  // and a different cwd - the index must win and the raw path must not run.
  writeTranscript(dir, "indexed-and-on-disk", [
    userLine({
      cwd: "/Users/someone/code/RAW-SHOULD-NOT-WIN",
      gitBranch: "raw-branch",
      message: { content: [{ type: "text", text: "from the raw transcript" }] },
    }),
  ]);
  // A sidechain that is also on disk: filtered from the index, but the raw path
  // has no sidechain filter, so it resolves from its own cwd.
  writeTranscript(dir, "a-sidechain", [
    userLine({ cwd: "/Users/someone/code/zeta", isSidechain: true, message: { content: [] } }),
  ]);

  const scanned = scanClaudeProjects(root);
  const key = canonicalize("/Users/someone/code/zeta");

  assert.deepEqual(Object.keys(scanned), [key], "the raw transcript's cwd must not create a second project");
  const byId = new Map(scanned[key]!.map((s) => [s.sessionId, s]));

  const indexed = byId.get("indexed-and-on-disk");
  assert.ok(indexed);
  assert.equal(indexed.firstPrompt, "from the index", "index entry must take precedence over the raw transcript");
  assert.equal(indexed.gitBranch, "index-branch");
  assert.equal(indexed.summary, "indexed summary");
  assert.equal(indexed.lastActivity, "2024-05-05T12:00:00.000Z");
  assert.equal(indexed.entrypoint, undefined, "index-sourced refs carry no entrypoint");

  const deleted = byId.get("deleted-transcript");
  assert.ok(deleted, "an index entry whose transcript was auto-cleaned must survive");
  assert.equal(deleted.firstPrompt, undefined, '"No prompt" is normalized away');
  assert.equal(deleted.lastActivity, new Date(Date.parse("2024-02-02T00:00:00.000Z")).toISOString());

  assert.equal(byId.size, 3, "expected the two index entries plus the raw sidechain transcript");
  assert.ok(byId.has("a-sidechain"));
});
