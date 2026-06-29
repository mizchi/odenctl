export interface SnapshotPublishJobOptions {
  intervalMs: number;
  publish(): Promise<unknown>;
  onError?(error: unknown): void;
  setIntervalFn?: (callback: () => void, intervalMs: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
}

export function createSnapshotPublishJob(options: SnapshotPublishJobOptions) {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("snapshot publish interval must be a positive integer");
  }
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let timer: unknown;
  let inFlight = false;

  async function tick(): Promise<boolean> {
    if (inFlight) {
      return false;
    }
    inFlight = true;
    try {
      await options.publish();
      return true;
    } catch (error) {
      options.onError?.(error);
      return false;
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (timer !== undefined) {
      return;
    }
    timer = setIntervalFn(() => {
      void tick();
    }, options.intervalMs);
  }

  function stop(): void {
    if (timer === undefined) {
      return;
    }
    clearIntervalFn(timer);
    timer = undefined;
  }

  function running(): boolean {
    return timer !== undefined;
  }

  return { tick, start, stop, running };
}
