import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { canonicalize, toUtcIso } from "./paths.js";

test("canonicalize resolves a relative path against cwd", () => {
  const result = canonicalize("some/relative/path");
  assert.equal(result, path.resolve("some/relative/path"));
  assert.ok(path.isAbsolute(result));
});

test("canonicalize collapses .. and . segments", () => {
  const result = canonicalize("/a/b/../c/./d");
  assert.equal(result, path.resolve("/a/c/d"));
});

test("toUtcIso returns the fallback for undefined", () => {
  assert.equal(toUtcIso(undefined, "fallback-value"), "fallback-value");
});

test("toUtcIso returns the fallback for an unparseable string", () => {
  assert.equal(toUtcIso("not-a-real-date", "fallback-value"), "fallback-value");
});

test("toUtcIso normalizes a non-UTC offset string to a Z-suffixed UTC ISO string", () => {
  const result = toUtcIso("2024-03-05T10:00:00+02:00", "fallback-value");
  assert.equal(result, "2024-03-05T08:00:00.000Z");
});

test("toUtcIso accepts a number (epoch ms)", () => {
  const epochMs = 1700000000000;
  const result = toUtcIso(epochMs, "fallback-value");
  assert.equal(result, new Date(epochMs).toISOString());
});

test("toUtcIso accepts a Date instance", () => {
  const date = new Date("2024-01-01T00:00:00.000Z");
  const result = toUtcIso(date, "fallback-value");
  assert.equal(result, "2024-01-01T00:00:00.000Z");
});
