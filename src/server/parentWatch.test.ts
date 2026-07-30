import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { watchParent, PARENT_WATCH_ENV } from "./parentWatch.js";

function fakeStdin() {
  const emitter = new EventEmitter() as EventEmitter & { resume?: () => void; resumed?: boolean };
  emitter.resumed = false;
  emitter.resume = () => {
    emitter.resumed = true;
  };
  return emitter;
}

test("does nothing unless the parent explicitly opts in", () => {
  const stdin = fakeStdin();
  let called = 0;

  const armed = watchParent({ env: {}, stdin, onParentGone: () => called++ });

  assert.equal(armed, false, "must not arm without the env flag");
  assert.equal(stdin.listenerCount("end"), 0);
  assert.equal(stdin.listenerCount("close"), 0);
  // Critically: an interactive shell closing stdin must not kill a dev server.
  stdin.emit("end");
  assert.equal(called, 0);
});

test("a value other than 1 does not arm the watch", () => {
  const stdin = fakeStdin();
  const armed = watchParent({
    env: { [PARENT_WATCH_ENV]: "true" },
    stdin,
    onParentGone: () => {},
  });
  assert.equal(armed, false, "only the exact value \"1\" arms it");
});

test("exits when stdin reaches EOF", () => {
  const stdin = fakeStdin();
  let called = 0;

  const armed = watchParent({
    env: { [PARENT_WATCH_ENV]: "1" },
    stdin,
    onParentGone: () => called++,
  });

  assert.equal(armed, true);
  assert.equal(stdin.resumed, true, "a paused stream never emits end, so it must be resumed");
  assert.equal(called, 0, "must not fire before the parent goes away");

  stdin.emit("end");
  assert.equal(called, 1);
});

test("exits when the stdin pipe is torn down without a clean end", () => {
  const stdin = fakeStdin();
  let called = 0;
  watchParent({ env: { [PARENT_WATCH_ENV]: "1" }, stdin, onParentGone: () => called++ });

  stdin.emit("close");
  assert.equal(called, 1, "close alone must be enough — a killed parent may not send end");
});

test("fires at most once even if both end and close arrive", () => {
  const stdin = fakeStdin();
  let called = 0;
  watchParent({ env: { [PARENT_WATCH_ENV]: "1" }, stdin, onParentGone: () => called++ });

  stdin.emit("end");
  stdin.emit("close");
  stdin.emit("end");

  assert.equal(called, 1, "shutdown must be idempotent");
});
