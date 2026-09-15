import assert from "node:assert/strict";
import { test } from "node:test";
import { createSnapshotPublishJob } from "../crates/odenctl/src/control-plane/snapshot-publish-job.ts";

test("snapshot publish job skips overlapping ticks", async () => {
  let publishes = 0;
  let releasePublish: (() => void) | undefined;
  const job = createSnapshotPublishJob({
    intervalMs: 1000,
    async publish() {
      publishes += 1;
      await new Promise<void>((resolve) => {
        releasePublish = resolve;
      });
    },
  });

  const first = job.tick();
  const second = await job.tick();
  assert.equal(second, false);
  assert.equal(publishes, 1);

  releasePublish?.();
  assert.equal(await first, true);
  const third = job.tick();
  releasePublish?.();
  assert.equal(await third, true);
  assert.equal(publishes, 2);
});

test("snapshot publish job start and stop use the configured timer hooks", () => {
  const scheduled: Array<() => void> = [];
  const cleared: unknown[] = [];
  const job = createSnapshotPublishJob({
    intervalMs: 1000,
    async publish() {},
    setIntervalFn(callback) {
      scheduled.push(callback);
      return "timer-id";
    },
    clearIntervalFn(timer) {
      cleared.push(timer);
    },
  });

  job.start();
  job.start();
  assert.equal(scheduled.length, 1);
  assert.equal(job.running(), true);

  job.stop();
  assert.deepEqual(cleared, ["timer-id"]);
  assert.equal(job.running(), false);
});

test("snapshot publish job reports unsuccessful publish results as failures", async () => {
  const errors: unknown[] = [];
  const job = createSnapshotPublishJob({
    intervalMs: 1000,
    async publish() {
      return { ok: false };
    },
    isSuccess(result) {
      return (result as any).ok === true;
    },
    onError(error) {
      errors.push(error);
    },
  });

  assert.equal(await job.tick(), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0] instanceof Error ? errors[0].message : String(errors[0]), /unsuccessful/);
});
