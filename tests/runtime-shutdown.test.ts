import assert from "node:assert/strict";
import { test } from "node:test";
import { installRuntimeShutdownHandlers } from "../crates/odenctl/src/runtime/shutdown.ts";

test("runtime shutdown handler drains once and exits after close resolves", async () => {
  const listeners: Record<string, () => void> = {};
  const exits: number[] = [];
  let releaseClose!: () => void;
  let closeCalls = 0;

  installRuntimeShutdownHandlers({
    process: {
      once(signal, listener) {
        listeners[signal] = listener;
        return this;
      },
      exit(code) {
        exits.push(code ?? 0);
      },
    },
    logger: {
      log() {},
      error() {},
    },
    async close() {
      closeCalls += 1;
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
    },
  });

  listeners.SIGTERM();
  listeners.SIGINT();
  assert.equal(closeCalls, 1);
  assert.deepEqual(exits, []);

  releaseClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [0]);
});

test("runtime shutdown handler exits non-zero when close fails", async () => {
  const listeners: Record<string, () => void> = {};
  const exits: number[] = [];
  const errors: string[] = [];

  installRuntimeShutdownHandlers({
    process: {
      once(signal, listener) {
        listeners[signal] = listener;
        return this;
      },
      exit(code) {
        exits.push(code ?? 0);
      },
    },
    logger: {
      log() {},
      error(message) {
        errors.push(String(message));
      },
    },
    async close() {
      throw new Error("drain timed out");
    },
  });

  listeners.SIGTERM();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(exits, [1]);
  assert.match(errors[0] ?? "", /runtime shutdown failed: drain timed out/);
});
