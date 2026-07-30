import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { apiKeyStatus, clearApiKey, dismissSetup, looksLikeAnthropicKey, resolveApiKey, saveApiKey } from "./apiKey.js";
import { getAnthropic } from "./client.js";
import { settingsDb, settingsPath, writeSettings } from "../store/db.js";

/**
 * A syntactically valid key that is not a real credential — long enough to pass
 * the local shape check so the tests exercise the branch after it.
 */
const FAKE_KEY = "sk-ant-api03-" + "A".repeat(40);
const OTHER_KEY = "sk-ant-api03-" + "B".repeat(40);

const realEnvKey = process.env.ANTHROPIC_API_KEY;

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  settingsDb.data.apiKey = "";
  settingsDb.data.setupDismissed = false;
  await writeSettings();
});

after(async () => {
  if (realEnvKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realEnvKey;
  settingsDb.data.apiKey = "";
  settingsDb.data.setupDismissed = false;
  await writeSettings();
});

test("no key anywhere reads as unconfigured rather than as an empty key", () => {
  assert.deepEqual(resolveApiKey({}), { key: null, source: "none" });
  const status = apiKeyStatus();
  assert.equal(status.configured, false);
  assert.equal(status.source, "none");
  assert.equal(status.hint, null);
});

test("the environment wins over a stored key", () => {
  settingsDb.data.apiKey = OTHER_KEY;
  const resolved = resolveApiKey({ ANTHROPIC_API_KEY: FAKE_KEY });
  assert.equal(resolved.key, FAKE_KEY);
  assert.equal(resolved.source, "env");
});

test("a stored key is used when the environment has none", () => {
  settingsDb.data.apiKey = FAKE_KEY;
  assert.deepEqual(resolveApiKey({}), { key: FAKE_KEY, source: "settings" });
});

/**
 * The bundle test injects `ANTHROPIC_API_KEY: ""` precisely so no real call can
 * happen. An empty value must therefore mean "absent", not "a key that fails
 * every request".
 */
test("a blank or whitespace env var is absent, not a key", () => {
  assert.equal(resolveApiKey({ ANTHROPIC_API_KEY: "" }).source, "none");
  assert.equal(resolveApiKey({ ANTHROPIC_API_KEY: "   " }).source, "none");

  settingsDb.data.apiKey = FAKE_KEY;
  assert.equal(resolveApiKey({ ANTHROPIC_API_KEY: "" }).source, "settings");
});

test("status carries a last-4 hint and never the key itself", () => {
  settingsDb.data.apiKey = FAKE_KEY;
  const status = apiKeyStatus();
  assert.equal(status.configured, true);
  assert.equal(status.hint, FAKE_KEY.slice(-4));
  assert.doesNotMatch(JSON.stringify(status), /sk-ant/, "status must not leak the key");
});

test("managedByEnv distinguishes an env key from a stored one", () => {
  settingsDb.data.apiKey = FAKE_KEY;
  assert.equal(apiKeyStatus().managedByEnv, false);
  process.env.ANTHROPIC_API_KEY = OTHER_KEY;
  assert.equal(apiKeyStatus().managedByEnv, true);
});

test("obvious paste errors are rejected locally, before any network call", () => {
  assert.equal(looksLikeAnthropicKey(FAKE_KEY), true);
  assert.equal(looksLikeAnthropicKey(""), false);
  assert.equal(looksLikeAnthropicKey("sk-ant-short"), false);
  assert.equal(looksLikeAnthropicKey("sk-proj-" + "A".repeat(40)), false, "an OpenAI key is not one");
  assert.equal(
    looksLikeAnthropicKey(`export ANTHROPIC_API_KEY=${FAKE_KEY}`),
    false,
    "a pasted shell line is not a key"
  );
});

test("saving a malformed key fails without storing it", async () => {
  const result = await saveApiKey("nope");
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /sk-ant-/);
  assert.equal(settingsDb.data.apiKey, "", "a rejected key must not be persisted");
});

test("skipping setup is remembered, so onboarding stops asking", async () => {
  assert.equal(apiKeyStatus().setupDismissed, false);
  const status = await dismissSetup();
  assert.equal(status.setupDismissed, true);
  assert.equal(status.configured, false, "skipping must not fabricate a key");
});

test("clearing a key switches AI features back off", async () => {
  settingsDb.data.apiKey = FAKE_KEY;
  await writeSettings();
  const status = await clearApiKey();
  assert.equal(status.configured, false);
  assert.equal(getAnthropic(), null);
});

/** The file holds a live credential, so it must not be world-readable. */
test("settings.json is owner-only", async () => {
  settingsDb.data.apiKey = FAKE_KEY;
  await writeSettings();
  const mode = fs.statSync(settingsPath).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

/**
 * The regression this refactor exists for: three modules each memoised the
 * client on first use, so a key entered at runtime did nothing until restart.
 */
test("the shared client follows the current key without a restart", () => {
  assert.equal(getAnthropic(), null, "no key means no client");

  settingsDb.data.apiKey = FAKE_KEY;
  const first = getAnthropic();
  assert.ok(first, "a saved key must produce a client with no restart");
  assert.equal(getAnthropic(), first, "an unchanged key should reuse the client");

  settingsDb.data.apiKey = OTHER_KEY;
  const second = getAnthropic();
  assert.ok(second);
  assert.notEqual(second, first, "a changed key must not keep serving the old client");

  settingsDb.data.apiKey = "";
  assert.equal(getAnthropic(), null, "removing the key must switch the client off");
});
