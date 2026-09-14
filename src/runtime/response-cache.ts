import {
  matchResponseCacheRequest,
  parseResponseCacheConfig,
  prepareResponseCacheEntry,
  type ResponseCacheConfig,
  type ResponseCacheRequest,
  type ResponseCacheScope,
} from "./response-cache-policy.ts";
import type { InvokeComponentResponse } from "./types.ts";

export type ResponseCacheStatus = "HIT" | "MISS" | "BYPASS";
export interface ResponseCacheResult {
  status: ResponseCacheStatus;
  response: InvokeComponentResponse;
}
interface Entry
  extends NonNullable<ReturnType<typeof prepareResponseCacheEntry>> {
  projectId?: string;
  deploymentId: string;
  size: number;
}
interface Pending {
  listeners: Set<(stored: boolean) => void>;
  settled?: boolean;
  resolve(stored: boolean): void;
}

export function createResponseCache(
  input: ResponseCacheConfig,
  options: { now?: () => number } = {},
) {
  const config = parseResponseCacheConfig(input);
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const fills = new Map<string, Pending>();
  const counters = {
    hits: 0,
    misses: 0,
    bypasses: 0,
    fills: 0,
    coalesced: 0,
    evictions: 0,
    expired: 0,
    purges: 0,
  };
  let generation = {};
  let suspended = 0;
  let bytes = 0;
  let pending = 0;

  function remove(key: string) {
    const entry = entries.get(key);
    if (entry) {
      bytes -= entry.size;
      entries.delete(key);
    }
  }

  function lookup(
    key: string,
    method: string,
  ): ResponseCacheResult | undefined {
    const entry = entries.get(key);
    if (!entry) return;
    const time = now();
    if (time >= entry.expiresAt) {
      remove(key);
      counters.expired++;
      return;
    }
    entries.delete(key);
    entries.set(key, entry);
    counters.hits++;
    return {
      status: "HIT",
      response: {
        status: entry.response.status,
        headers: [...entry.response.headers.map((h) => ({ ...h })), {
          name: "age",
          value: String(
            Math.floor(
              (entry.initialAgeMs + Math.max(0, time - entry.storedAt)) / 1000,
            ),
          ),
        }],
        body: method === "HEAD"
          ? new Uint8Array()
          : Uint8Array.from(entry.response.body),
      },
    };
  }

  function matches(item: ResponseCacheScope, scope: ResponseCacheScope) {
    return (scope.projectId === undefined ||
      item.projectId === scope.projectId) &&
      (scope.deploymentId === undefined ||
        item.deploymentId === scope.deploymentId);
  }

  function purge(scope: ResponseCacheScope = {}) {
    generation = {};
    let removed = 0;
    for (const [key, entry] of entries) {
      if (matches(entry, scope)) {
        remove(key);
        removed++;
      }
    }
    // Fence every pending fill, including unrelated ones, without evicting unrelated entries.
    // Detaching before resolving lets new requests start in the new generation.
    for (const fill of fills.values()) fill.resolve(false);
    fills.clear();
    counters.purges++;
    return { removed };
  }

  return {
    revision: () => generation,
    stats: () => ({ ...counters, entries: entries.size, bytes, pending }),
    purge,
    suspend() {
      suspended++;
      purge();
      let resumed = false;
      return () => {
        if (!resumed) {
          resumed = true;
          suspended--;
          purge();
        }
      };
    },
    async execute(
      request: ResponseCacheRequest,
      load: () => Promise<InvokeComponentResponse>,
      execution: { signal?: AbortSignal; revision?: object } = {},
    ): Promise<ResponseCacheResult> {
      const signal = execution.signal;
      signal?.throwIfAborted();
      const revision = generation;
      const bypass = async (): Promise<ResponseCacheResult> => {
        counters.bypasses++;
        return { status: "BYPASS", response: await abortable(load, signal) };
      };
      if (
        suspended || (execution.revision && execution.revision !== generation)
      ) return bypass();
      const match = matchResponseCacheRequest(config, request);
      if (!match) return bypass();
      const hit = lookup(match.key, request.method);
      if (hit) return hit;
      if (request.method === "HEAD") return bypass();
      counters.misses++;
      if (pending >= config.maxPending) return bypass();
      const existing = fills.get(match.key);
      if (existing) {
        counters.coalesced++;
        pending++;
        try {
          const stored = await waitForFill(existing, signal);
          if (stored && revision === generation && !suspended) {
            const hit = lookup(match.key, request.method);
            if (hit) return hit;
          }
        } finally {
          pending--;
        }
        // A private response, failure, cancellation, eviction or purge requires an independent invocation.
        return bypass();
      }
      const fill = createPendingFill();
      fills.set(match.key, fill);
      pending++;
      let stored = false;
      try {
        const requestTime = now();
        const response = await abortable(load, signal);
        if (generation === revision && !suspended && !signal?.aborted) {
          const prepared = response.body.byteLength <= config.maxEntryBytes
            ? prepareResponseCacheEntry(
              response,
              match.rule,
              requestTime,
              now(),
            )
            : undefined;
          if (prepared) {
            const size = prepared.response.body.byteLength +
              Buffer.byteLength(match.key) +
              prepared.response.headers.reduce(
                (sum, h) =>
                  sum + Buffer.byteLength(h.name) + Buffer.byteLength(h.value) +
                  4,
                0,
              );
            if (size <= config.maxEntryBytes && size <= config.maxBytes) {
              for (const [key, entry] of entries) {
                if (entry.expiresAt <= now()) {
                  remove(key);
                  counters.expired++;
                }
              }
              remove(match.key);
              while (
                entries.size >= config.maxEntries ||
                bytes + size > config.maxBytes
              ) {
                remove(entries.keys().next().value!);
                counters.evictions++;
              }
              entries.set(match.key, {
                ...prepared,
                size,
                projectId: request.projectId,
                deploymentId: request.deploymentId,
              });
              bytes += size;
              counters.fills++;
              stored = true;
            }
          }
        }
        return { status: "MISS", response };
      } finally {
        if (fills.get(match.key) === fill) fills.delete(match.key);
        pending--;
        fill.resolve(stored);
      }
    },
  };
}

function createPendingFill(): Pending {
  const fill: Pending = {
    listeners: new Set(),
    resolve(stored) {
      if (fill.settled !== undefined) return;
      fill.settled = stored;
      for (const listener of fill.listeners) listener(stored);
      fill.listeners.clear();
    },
  };
  return fill;
}

// Explicit subscriptions let aborted waiters detach from a slow leader. A shared
// Promise would retain each cancelled waiter's callbacks until that leader finished.
function waitForFill(fill: Pending, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (fill.settled !== undefined) return Promise.resolve(fill.settled);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      fill.listeners.delete(done);
      signal?.removeEventListener("abort", aborted);
    };
    const done = (stored: boolean) => {
      cleanup();
      resolve(stored);
    };
    const aborted = () => {
      cleanup();
      reject(signal!.reason);
    };
    fill.listeners.add(done);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

// Cancellation detaches cache work promptly. The loader remains responsible for cancelling
// its underlying I/O; its eventual result is observed but cannot populate this cache.
function abortable<T>(
  load: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return load();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return load();
    }).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}
