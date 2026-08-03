import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateCheckRollup, normalizeRunStatus } from "./ghClient.js";

/**
 * `gh pr list --json statusCheckRollup` hands back a mixed array: CheckRun
 * objects (`status` + `conclusion`, where conclusion is null until the run
 * finishes) and StatusContext objects (`state`). These tests pin the shapes
 * straight from the API so the aggregation can be checked without `gh`.
 */
const checkRun = (conclusion: string | null, status = conclusion ? "COMPLETED" : "IN_PROGRESS") => ({
  __typename: "CheckRun",
  name: "test",
  status,
  conclusion,
});
const statusContext = (state: string) => ({
  __typename: "StatusContext",
  context: "ci/legacy",
  state,
});

test("a failing check anywhere in the rollup beats an earlier passing one", () => {
  assert.equal(
    aggregateCheckRollup([checkRun("SUCCESS"), checkRun("FAILURE")]),
    "failure",
    "reading only the first entry would have called this green"
  );
});

test("every check passing is a success", () => {
  assert.equal(aggregateCheckRollup([checkRun("SUCCESS"), checkRun("SUCCESS")]), "success");
});

test("one pending check among successes holds the whole rollup at pending", () => {
  assert.equal(
    aggregateCheckRollup([checkRun("SUCCESS"), checkRun(null, "QUEUED"), checkRun("SUCCESS")]),
    "pending"
  );
});

test("a failure outranks a pending check", () => {
  assert.equal(aggregateCheckRollup([checkRun(null, "IN_PROGRESS"), checkRun("TIMED_OUT")]), "failure");
});

test("a CheckRun with a null conclusion is still running, not silently fine", () => {
  assert.equal(aggregateCheckRollup([checkRun(null)]), "pending");
});

test("an empty rollup means no checks, not a pass", () => {
  assert.equal(aggregateCheckRollup([]), undefined);
});

test("a missing or non-array rollup is undefined", () => {
  assert.equal(aggregateCheckRollup(undefined), undefined);
  assert.equal(aggregateCheckRollup(null), undefined);
  assert.equal(aggregateCheckRollup("SUCCESS"), undefined);
  assert.equal(aggregateCheckRollup({ conclusion: "FAILURE" }), undefined);
});

test("legacy StatusContext-only rollups are read through `state`", () => {
  assert.equal(aggregateCheckRollup([statusContext("SUCCESS")]), "success");
  assert.equal(aggregateCheckRollup([statusContext("SUCCESS"), statusContext("ERROR")]), "failure");
  assert.equal(aggregateCheckRollup([statusContext("SUCCESS"), statusContext("PENDING")]), "pending");
  assert.equal(aggregateCheckRollup([statusContext("EXPECTED")]), "pending");
});

test("CheckRuns and StatusContexts mix in one rollup", () => {
  assert.equal(aggregateCheckRollup([checkRun("SUCCESS"), statusContext("FAILURE")]), "failure");
  assert.equal(aggregateCheckRollup([checkRun("SKIPPED"), statusContext("SUCCESS")]), "success");
});

test("every failure-class conclusion counts as a failure", () => {
  for (const conclusion of [
    "FAILURE",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ]) {
    assert.equal(aggregateCheckRollup([checkRun(conclusion)]), "failure", conclusion);
  }
});

test("neutral and skipped checks are not failures", () => {
  assert.equal(aggregateCheckRollup([checkRun("NEUTRAL")]), "success");
  assert.equal(aggregateCheckRollup([checkRun("SKIPPED")]), "success");
});

test("an unrecognized value is not turned into a verdict", () => {
  assert.equal(
    aggregateCheckRollup([{ __typename: "CheckRun", conclusion: "STALE", status: "COMPLETED" }]),
    undefined
  );
  assert.equal(aggregateCheckRollup([statusContext("WHO_KNOWS")]), undefined);
  assert.equal(
    aggregateCheckRollup([statusContext("WHO_KNOWS"), checkRun("SUCCESS")]),
    "success",
    "one unreadable entry must not erase a real result"
  );
});

test("rollup values are matched case-insensitively, so cached lowercase data still reads", () => {
  assert.equal(aggregateCheckRollup([{ conclusion: "success" }, { conclusion: "failure" }]), "failure");
});

test("a completed run reports its conclusion", () => {
  assert.equal(normalizeRunStatus({ status: "completed", conclusion: "success" }), "success");
  assert.equal(normalizeRunStatus({ status: "completed", conclusion: "failure" }), "failure");
  assert.equal(normalizeRunStatus({ status: "completed", conclusion: "cancelled" }), "failure");
  assert.equal(normalizeRunStatus({ status: "completed", conclusion: "skipped" }), "success");
});

test("a run still going is pending, whatever stage it's at", () => {
  assert.equal(normalizeRunStatus({ status: "in_progress", conclusion: null }), "pending");
  assert.equal(normalizeRunStatus({ status: "queued", conclusion: null }), "pending");
  assert.equal(normalizeRunStatus({ status: "waiting" }), "pending");
  assert.equal(normalizeRunStatus({ status: "requested", conclusion: "" }), "pending");
});

test("no run at all — a branch that has never run CI — is undefined", () => {
  assert.equal(normalizeRunStatus(undefined), undefined);
  assert.equal(normalizeRunStatus({}), undefined);
  assert.equal(normalizeRunStatus({ status: "completed", conclusion: null }), undefined);
});

test("run status is normalized to lowercase regardless of the casing gh used", () => {
  assert.equal(normalizeRunStatus({ status: "COMPLETED", conclusion: "SUCCESS" }), "success");
  assert.equal(normalizeRunStatus({ status: "IN_PROGRESS", conclusion: null }), "pending");
});
