import { test } from "node:test";
import assert from "node:assert/strict";
import { isInsufficientEvidence } from "./summarize.js";

test("the bare sentinel is detected, whitespace and all", () => {
  assert.equal(isInsufficientEvidence("INSUFFICIENT_EVIDENCE"), true);
  assert.equal(isInsufficientEvidence("  INSUFFICIENT_EVIDENCE\n"), true);
});

test("the sentinel is matched case-insensitively", () => {
  assert.equal(isInsufficientEvidence("insufficient_evidence"), true);
  assert.equal(isInsufficientEvidence("Insufficient_Evidence"), true);
});

test("models that wrap the sentinel in markdown or quotes are still understood", () => {
  assert.equal(isInsufficientEvidence("**INSUFFICIENT_EVIDENCE**"), true);
  assert.equal(isInsufficientEvidence('"INSUFFICIENT_EVIDENCE"'), true);
  assert.equal(isInsufficientEvidence("`INSUFFICIENT_EVIDENCE`"), true);
  assert.equal(isInsufficientEvidence("_INSUFFICIENT_EVIDENCE_"), true);
});

test("a sentence that starts with the sentinel counts", () => {
  assert.equal(isInsufficientEvidence("INSUFFICIENT_EVIDENCE — no commits or docs to go on."), true);
});

test("an ordinary summary is not the sentinel", () => {
  assert.equal(isInsufficientEvidence("Auth is wired up; the payment webhook is still stubbed out."), false);
  assert.equal(isInsufficientEvidence(""), false);
});

test("prose that merely mentions the sentinel later is still a summary", () => {
  assert.equal(
    isInsufficientEvidence("The docs are thin, so a stricter prompt would return INSUFFICIENT_EVIDENCE here."),
    false
  );
  assert.equal(isInsufficientEvidence("There is insufficient_evidence tooling in this repo."), false);
});
