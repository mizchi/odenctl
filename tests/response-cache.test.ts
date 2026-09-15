import assert from "node:assert/strict";
import { test } from "node:test";
import { createResponseCache } from "../crates/odenctl/src/runtime/response-cache.ts";
import { parseResponseCacheConfig } from "../crates/odenctl/src/runtime/response-cache-policy.ts";
import type { ResponseCacheRequest } from "../crates/odenctl/src/runtime/response-cache-policy.ts";
import type {
  InvokeComponentResponse,
  RuntimeHeader,
} from "../crates/odenctl/src/runtime/types.ts";

const config = {
  maxBytes: 8192,
  maxEntries: 4,
  maxEntryBytes: 2048,
  maxPending: 8,
  rules: [{
    projectId: "p1",
    host: "public.example",
    pathPrefix: "/public",
    maxTtlSeconds: 60,
    varyHeaders: ["accept-language", "accept-encoding"],
  }],
};
const start = Date.parse("2026-09-13T00:00:00Z");
function request(
  overrides: Partial<ResponseCacheRequest> = {},
): ResponseCacheRequest {
  return {
    projectId: "p1",
    deploymentId: "d1",
    componentIdentity: "/d1.cwasm",
    method: "GET",
    uri: "https://public.example/public/file?a=1&b=2",
    headers: [],
    bodyBytes: 0,
    ...overrides,
  };
}
function response(headers: RuntimeHeader[] = []): InvokeComponentResponse {
  return {
    status: 200,
    headers: [
      { name: "cache-control", value: "public, max-age=30" },
      ...headers,
    ],
    body: Uint8Array.from([0, 255, 128, 65]),
    logs: [{ message: "executed" }],
  };
}
function deferred<T>() {
  return Promise.withResolvers<T>();
}

test("response cache preserves binary bytes, copies entries, omits logs and expires with Age", async () => {
  let now = start;
  const cache = createResponseCache(config, { now: () => now });
  let calls = 0;
  const load = async () => {
    calls++;
    return response();
  };
  const first = await cache.execute(request(), load);
  assert.equal(first.status, "MISS");
  first.response.body.fill(7);
  now += 2100;
  const hit = await cache.execute(request(), load);
  assert.equal(hit.status, "HIT");
  assert.deepEqual([...hit.response.body], [0, 255, 128, 65]);
  assert.equal(hit.response.logs, undefined);
  assert.equal(hit.response.headers.find((h) => h.name === "age")?.value, "2");
  hit.response.body.fill(8);
  assert.deepEqual([...(await cache.execute(request(), load)).response.body], [
    0,
    255,
    128,
    65,
  ]);
  now += 28_000;
  assert.equal((await cache.execute(request(), load)).status, "MISS");
  assert.equal(calls, 2);
});

test("cache keys separate tenants, deployments, authorities, exact queries, and configured headers", async () => {
  const cache = createResponseCache({
    ...config,
    maxEntries: 20,
    rules: [...config.rules, { ...config.rules[0], projectId: "p2" }, {
      ...config.rules[0],
      host: "public.example:8443",
    }],
  });
  const cases = [
    request(),
    request({ projectId: "p2" }),
    request({ deploymentId: "d2" }),
    request({ componentIdentity: "/new.cwasm" }),
    request({ uri: "http://public.example/public/file?a=1&b=2" }),
    request({ uri: "https://public.example:8443/public/file?a=1&b=2" }),
    request({ uri: "https://public.example/public/file?b=2&a=1" }),
    request({ headers: [{ name: "Accept-Language", value: "ja" }] }),
  ];
  for (const input of cases) {
    assert.equal(
      (await cache.execute(input, async () => response())).status,
      "MISS",
    );
  }
  for (const input of cases) {
    assert.equal(
      (await cache.execute(
        input,
        async () => assert.fail("unexpected invocation"),
      )).status,
      "HIT",
    );
  }
});

test("request bypasses apply even to a warm cache", async () => {
  const cache = createResponseCache(config);
  await cache.execute(request(), async () => response());
  const cases = [
    request({ method: "POST" }),
    request({ bodyBytes: 1 }),
    request({ projectId: undefined }),
    request({ uri: "https://public.example/publicity" }),
    ...[
      "authorization",
      "proxy-authorization",
      "cookie",
      "range",
      "if-none-match",
      "if-modified-since",
      "if-match",
      "if-unmodified-since",
      "if-range",
      "cache-control",
      "pragma",
      "upgrade",
      "transfer-encoding",
    ]
      .map((name) => request({ headers: [{ name, value: "anything" }] })),
  ];
  for (const input of cases) {
    let called = false;
    assert.equal(
      (await cache.execute(input, async () => {
        called = true;
        return response();
      })).status,
      "BYPASS",
    );
    assert(called, JSON.stringify(input));
  }
});

test("HEAD reads GET entries but never populates them", async () => {
  const cache = createResponseCache(config);
  assert.equal(
    (await cache.execute(
      request({ method: "HEAD" }),
      async () => ({ ...response(), body: new Uint8Array() }),
    )).status,
    "BYPASS",
  );
  assert.equal(
    (await cache.execute(request(), async () => response())).status,
    "MISS",
  );
  const hit = await cache.execute(
    request({ method: "HEAD" }),
    async () => assert.fail("HEAD invoked"),
  );
  assert.equal(hit.status, "HIT");
  assert.equal(hit.response.body.length, 0);
  assert.equal(
    hit.response.headers.find((h) => h.name === "content-length")?.value,
    "4",
  );
});

test("uncacheable responses are never reused", async () => {
  const cases: InvokeComponentResponse[] = [
    { ...response(), status: 500 },
    { ...response(), status: 206 },
    { ...response(), headers: [] },
    ...[
      "private, max-age=30",
      "public, no-store, max-age=30",
      "public, no-cache, max-age=30",
      "max-age=30",
      "public, max-age=30, s-maxage=0",
      "public, max-age=30, max-age=40",
      "public, max-age=oops",
      "public=1, max-age=30",
      "max-age, s-maxage=30",
      "public, max-age=30, stale-while-revalidate=60",
    ]
      .map((value) => ({
        ...response(),
        headers: [{ name: "cache-control", value }],
      })),
    ...[
      { name: "Set-Cookie", value: "session=secret" },
      { name: "Vary", value: "*" },
      { name: "vary", value: "x-unconfigured" },
      { name: "content-range", value: "bytes 0-3/10" },
      { name: "content-length", value: "8" },
      { name: "age", value: "invalid" },
    ]
      .map((header) => response([header])),
  ];
  for (const result of cases) {
    const cache = createResponseCache(config);
    let calls = 0;
    const load = async () => {
      calls++;
      return result;
    };
    await cache.execute(request(), load);
    await cache.execute(request(), load);
    assert.equal(calls, 2, JSON.stringify(result.headers));
    assert.equal(cache.stats().entries, 0);
  }
});

test("supported Vary headers partition responses and byte pressure evicts least recently used entries", async () => {
  const cache = createResponseCache({
    ...config,
    maxBytes: 500,
    maxEntryBytes: 500,
  });
  const input = (language: string) =>
    request({ headers: [{ name: "accept-language", value: language }] });
  await cache.execute(
    input("ja"),
    async () => response([{ name: "Vary", value: "Accept-Language" }]),
  );
  assert.equal(
    (await cache.execute(
      input("en"),
      async () => response([{ name: "vary", value: "accept-language" }]),
    )).status,
    "MISS",
  );
  assert.equal(
    (await cache.execute(input("ja"), async () => assert.fail())).status,
    "HIT",
  );
  await cache.execute(
    input("fr"),
    async () => response([{ name: "vary", value: "accept-language" }]),
  );
  assert(cache.stats().bytes <= 500);
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().evictions, 1);
  const hit = await cache.execute(input("ja"), async () => assert.fail());
  hit.response.headers[0].value = "corrupted";
  assert.equal(
    (await cache.execute(input("ja"), async () => assert.fail())).response
      .headers[0].value,
    "public, max-age=30",
  );
});

test("s-maxage, Date, upstream Age, response delay and policy TTL limit freshness", async () => {
  let now = start;
  const cache = createResponseCache(config, { now: () => now });
  const load = async () => {
    now += 2000;
    return {
      ...response(),
      headers: [{ name: "cache-control", value: "s-maxage=120" }, {
        name: "date",
        value: new Date(start - 10_000).toUTCString(),
      }, { name: "age", value: "20" }],
    };
  };
  await cache.execute(request(), load);
  assert.equal(
    (await cache.execute(request(), load)).response.headers.find((h) =>
      h.name === "age"
    )?.value,
    "22",
  );
  now += 37_000;
  assert.equal((await cache.execute(request(), load)).status, "HIT");
  now += 1000;
  assert.equal((await cache.execute(request(), load)).status, "MISS");
});

test("concurrent cacheable misses invoke once; uncacheable responses and failures are not shared", async () => {
  for (const kind of ["public", "private", "failure"]) {
    const cache = createResponseCache(config);
    const pending = deferred<InvokeComponentResponse>();
    const first = cache.execute(request(), () => pending.promise);
    let secondCalls = 0;
    const second = cache.execute(request(), async () => {
      secondCalls++;
      return response();
    });
    assert.equal(cache.stats().pending, 2);
    if (kind === "failure") pending.reject(new Error("trap"));
    else {pending.resolve(
        kind === "public"
          ? response()
          : response([{ name: "set-cookie", value: "private" }]),
      );}
    if (kind === "failure") await assert.rejects(first, /trap/);
    else await first;
    assert.equal((await second).status, kind === "public" ? "HIT" : "BYPASS");
    assert.equal(secondCalls, kind === "public" ? 0 : 1);
    assert.equal(cache.stats().pending, 0);
  }
});

test("purge fences in-flight fills and preserves a replacement fill", async () => {
  const cache = createResponseCache(config);
  const old = deferred<InvokeComponentResponse>();
  const first = cache.execute(request(), () => old.promise);
  const waiter = cache.execute(request(), async () => response());
  cache.purge({ projectId: "p1", deploymentId: "d1" });
  assert.equal((await waiter).status, "BYPASS");
  const replacement = deferred<InvokeComponentResponse>();
  const fresh = cache.execute(request(), () => replacement.promise);
  old.resolve(response());
  await first;
  assert.equal(cache.stats().entries, 0);
  replacement.resolve({ ...response(), body: Uint8Array.of(42) });
  await fresh;
  assert.deepEqual([
    ...(await cache.execute(request(), async () => assert.fail())).response
      .body,
  ], [42]);
});

test("cancellation releases waiters and prevents an aborted leader from filling", async () => {
  const cache = createResponseCache(config);
  const pending = deferred<InvokeComponentResponse>();
  const controller = new AbortController();
  const first = cache.execute(request(), () => pending.promise, {
    signal: controller.signal,
  });
  const second = cache.execute(request(), async () => response());
  controller.abort(new Error("cancelled"));
  await assert.rejects(first, /cancelled/);
  assert.equal((await second).status, "BYPASS");
  pending.resolve(response());
  await Promise.resolve();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().pending, 0);
});

test("snapshot suspension rejects old route revisions and invalidates on completion", async () => {
  const cache = createResponseCache(config);
  const revision = cache.revision();
  await cache.execute(request(), async () => response());
  const resume = cache.suspend();
  assert.equal(
    (await cache.execute(request(), async () => response())).status,
    "BYPASS",
  );
  resume();
  assert.equal(
    (await cache.execute(request(), async () => response(), { revision }))
      .status,
    "BYPASS",
  );
  assert.equal(
    (await cache.execute(request(), async () => response())).status,
    "MISS",
  );
});

test("LRU, entry sizes and pending work stay bounded", async () => {
  const cache = createResponseCache({
    ...config,
    maxEntries: 2,
    maxPending: 1,
  });
  const a = request(),
    b = request({ uri: a.uri + "b" }),
    c = request({ uri: a.uri + "c" });
  await cache.execute(a, async () => response());
  await cache.execute(b, async () => response());
  await cache.execute(a, async () => assert.fail());
  await cache.execute(c, async () => response());
  assert.equal(cache.stats().evictions, 1);
  assert.equal(
    (await cache.execute(a, async () => assert.fail())).status,
    "HIT",
  );
  await cache.execute(
    b,
    async () => ({ ...response(), body: new Uint8Array(3000) }),
  );
  assert.equal(cache.stats().entries, 2);
  assert(cache.stats().bytes <= config.maxBytes);
  const pending = deferred<InvokeComponentResponse>();
  const leader = cache.execute(b, () => pending.promise);
  assert.equal(
    (await cache.execute(b, async () => response())).status,
    "BYPASS",
  );
  assert.equal(cache.stats().pending, 1);
  pending.resolve(response());
  await leader;
});

test("configuration validation is strict and rules are copied", () => {
  for (
    const invalid of [
      null,
      {},
      { ...config, typo: true },
      { ...config, maxBytes: 0 },
      { ...config, maxEntries: 1.5 },
      { ...config, maxEntryBytes: 100_000 },
      { ...config, rules: [{ ...config.rules[0], pathPrefix: "public" }] },
      {
        ...config,
        rules: [{ ...config.rules[0], host: "https://public.example" }],
      },
      {
        ...config,
        rules: [{ ...config.rules[0], varyHeaders: ["authorization"] }],
      },
      { ...config, rules: [config.rules[0], config.rules[0]] },
    ]
  ) {
    assert.throws(() => parseResponseCacheConfig(invalid), /response cache/i);
  }
  const parsed = parseResponseCacheConfig(config);
  assert.deepEqual(parsed, config);
  assert.notEqual(parsed.rules, config.rules);
});
