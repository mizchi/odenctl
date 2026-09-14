# Deployment response cache

The Node deployment gateway can cache public HTTP responses before invoking a
Wasm component. A hit still performs routing, capability checks and request rate
limiting, but creates no guest instance and consumes no invocation concurrency
slot. Rust, MoonBit and other WASI HTTP components use ordinary response headers;
no language-specific SDK is required.

This is an opt-in, in-memory cache in each gateway process. It applies to
`pnpm runtime` and `createRuntimeNodeApp`, independently of the compiled-component
cache. The standalone `oden serve` / `start` commands do not enable it.
CloudFront resources, distributed purge jobs and the guest WIT Cache API remain
planned work. See the [edge platform design](../developer/edge-platform.md).

## Try it locally

```sh
just response-cache-demo
```

The [example](../../examples/response-cache/README.md) compiles a real WASI P3
component and starts a gateway on `127.0.0.1:8080`. In another terminal:

```sh
curl -sS -D - -o /tmp/cache-first.bin \
  -H 'Host: cache.example.local' http://127.0.0.1:8080/public/bytes
curl -sS -D - -o /tmp/cache-second.bin \
  -H 'Host: cache.example.local' http://127.0.0.1:8080/public/bytes
cmp /tmp/cache-first.bin /tmp/cache-second.bin
```

The first response has `x-oden-cache: MISS`. Repeating the request within
30 seconds returns `HIT`, an `Age` header and a fresh `x-oden-request-id`.
The 256-byte body contains every byte value, including NUL and invalid UTF-8.

```sh
just response-cache-test
```

This runs policy tests, HTTP gateway tests and the real component integration
test. CI runs the same task.

To verify a complete site release, run `just static-site-test`. The
[static site example](../../examples/static-site/README.md) uses the real upload and
publication CLI, serves HTML/CSS/JavaScript/PNG in Chromium, and tests an update
and rollback with the gateway cache enabled.

## Configure a runtime node

Create a JSON policy file. All fields below are required; an empty `rules` array
disables cache eligibility. Unknown fields and invalid limits fail startup.

```json
{
  "maxBytes": 33554432,
  "maxEntries": 256,
  "maxEntryBytes": 1048576,
  "maxPending": 128,
  "rules": [
    {
      "projectId": "prj_public",
      "host": "assets.example.com",
      "pathPrefix": "/public",
      "maxTtlSeconds": 60,
      "varyHeaders": ["accept-encoding", "accept-language"]
    }
  ]
}
```

```sh
RUNTIME_RESPONSE_CACHE_FILE=./response-cache.json \
ODEN_RUNTIME_TOKEN="$RUNTIME_ADMIN_TOKEN" \
pnpm runtime
```

Keep your existing route snapshot, artifact, host daemon, secret and control-plane
configuration. The file is loaded once at startup; restart the gateway to change
the policy. Policy publication through the control plane is not implemented yet.
For embedding, pass the parsed policy as `responseCache` to `createRuntimeNodeApp`.

Rules require an exact project ID and lowercase host authority, with an optional
non-default port. `/public` matches `/public` and `/public/file`, but not
`/publicity`. Use `/` for the entire host and omit trailing slashes elsewhere.
The longest matching path prefix wins; duplicate project/host/prefix rules are
rejected. `varyHeaders` names must be lowercase HTTP tokens.

A rule declares that the route is public and that the listed headers cover its
application-level response variants. Exclude routes using custom authentication
headers or user-specific state. Add every header that changes the public
representation to `varyHeaders` and emit the corresponding `Vary` response
header. Authorization and Cookie requests are always bypassed, even on warm keys.
As with existing gateway routing, configure your ingress to replace client-supplied
`X-Forwarded-Host` and `X-Forwarded-Proto` with trusted values. This feature does
not add a trusted-proxy configuration layer.

The cache key includes the selected project and deployment, compiled component
identity, scheme/authority, path, exact query order, policy and configured header
values. Incoming host/forwarding headers are also included. Weighted deployment
selection happens before lookup. With a response cache and an explicit invoker,
the gateway uses that invoker even if the direct daemon worker proxy is enabled:
the daemon's `/invoke` endpoint executes the already selected component. A
proxy-only embedding bypasses the response cache because direct proxy routing
could independently select a different deployment.

## Eligibility and freshness

The initial implementation supports a conservative subset of HTTP caching:

| Input or response | Behavior |
| --- | --- |
| GET without a body, matching a rule | Lookup; invoke on miss; consider the complete response for storage |
| HEAD | Read an existing GET entry without a body; a miss invokes independently and never fills the GET key |
| HTTP 200 with `public, max-age=N` or `s-maxage=N`, where N is positive | Eligible, subject to the remaining checks and policy TTL cap |
| Authorization, Proxy-Authorization, Cookie, Range, conditional headers, Upgrade, or Transfer-Encoding on the request | Bypass lookup and storage |
| Any request Cache-Control or Pragma | Bypass lookup and storage, including `no-cache` and `no-store` |
| Other methods, nonempty bodies or unmatched routes | Bypass |
| Set-Cookie, private, no-store, no-cache, unsupported Vary, partial or non-200 responses | Do not store |
| Malformed freshness/framing headers or bodies beyond the entry size limit | Do not store |

`s-maxage` takes precedence over `max-age`; zero disables storage. The lifetime is
capped by `maxTtlSeconds`. Upstream `Age`, `Date` and invocation duration reduce
remaining freshness. Hits increment `Age` without extending the entry's expiry.
Entries are immutable copies of complete bytes and headers. Guest logs, tracing
headers, timing headers and gateway metadata are not replayed from storage.

Validators, ranges, stale-while-revalidate and stale-if-error are not implemented.
Responses advertising either stale extension are currently left uncached. Expired
entries require a new invocation, including when the origin subsequently fails.

Concurrent misses for the same key share a fill only after a complete cacheable
response is stored. Private responses and invocation failures are never handed to
other callers; those callers perform their own invocation. Waiters count toward
`maxPending` and obey the component wall deadline (30 seconds if none is set).
When the pending budget is exhausted, requests bypass coordination and go through
normal invocation admission. Client disconnects release cache waiters and prevent
late results from populating the cache. Underlying invokers retain their existing
execution deadlines; disconnecting a client does not guarantee immediate
cancellation of Wasmtime execution.

`maxBytes` accounts for stored body bytes, header text and hash keys, not total
process RSS. `maxEntryBytes` uses the same accounting for one entry. `maxEntries`
and LRU eviction also bound retained responses; oversized entries cannot evict
existing useful entries. Limits are shared across projects on that node. Per-project
cache capacity reservations are not implemented. Expired entries are removed on
lookup or insertion, and remain counted until then. Restarting the process loses
all entries.

## Observe and purge

Worker responses carry `x-oden-cache` while the cache is configured:

| Value | Meaning |
| --- | --- |
| `HIT` | Returned a stored response; no guest invocation |
| `MISS` | Eligible GET missed and invoked; the response may still be uncacheable |
| `BYPASS` | No cached response used; the request invoked independently |

Guest headers cannot overwrite the gateway's cache status, request ID, deployment
or compiled-path metadata. Request metrics, events and host telemetry include
hits; guest invocation metrics and logs only describe actual executions.

The following management endpoints require `ODEN_RUNTIME_TOKEN`. They remain
closed when no token is configured, even though some legacy local management
endpoints allow unauthenticated development access.

```sh
curl --fail -sS -H "Authorization: Bearer $RUNTIME_ADMIN_TOKEN" \
  http://127.0.0.1:8788/__runtime/response-cache

curl --fail -sS -X POST -H "Authorization: Bearer $RUNTIME_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"projectId":"prj_public","deploymentId":"dep_release"}' \
  http://127.0.0.1:8788/__runtime/response-cache/purge
```

Stats include `hits`, `misses`, `bypasses`, `fills`, `coalesced`, `evictions`,
`expired`, `purges`, `entries`, `bytes` and `pending`. They describe the local cache
coordinator, not provider/CDN activity; proxy-only calls do not enter it. Counters
overlap: a request may miss, coalesce, then hit or bypass. Subtracting hits from
total requests is therefore not a reliable invocation count; use runtime invocation
metrics instead. For embeddings, `app.responseCacheStats()` returns the same data.

Purge accepts `{}` for all entries, `{ "projectId": "..." }`,
`{ "deploymentId": "..." }`, or both fields together. The response is
`{ "removed": N }`. The body is limited to 4 KiB. When management identity keys
are configured, purge additionally requires the same signed method/path/body
headers used for route snapshot updates.

Purge advances the generation: fills started before it cannot repopulate the
cache. Scoped purge preserves unrelated stored entries but fences all in-flight
fills. Accepted route snapshot updates suspend caching throughout warmup and
publication, clearing it both before and after the update, including error paths
and rollbacks. Requests that selected a route before an update cannot fill the
new generation. Embedders should publish route changes through the gateway's
snapshot endpoint to obtain this behavior; mutating a supervisor directly does
not notify the cache.

Purge affects this process only. It does not revoke responses already being sent,
clear browser caches, invalidate a CDN or clear other runtime nodes. Keep any CDN
caching disabled for these application routes until its key, release switching
and invalidation behavior are configured separately.
