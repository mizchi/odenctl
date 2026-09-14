# Public response cache

A WASI P3 Rust component returns all 256 byte values with
`Cache-Control: public, max-age=30`. A Node deployment gateway selects the
component, applies [cache.json](cache.json), and skips Wasmtime invocation on a
cache hit. It uses a local route snapshot and needs no control-plane database.

Run from the repository root with Node 24+, pnpm and Rust installed:

```sh
just response-cache-demo
```

In another terminal:

```sh
curl -sS -D - -o /tmp/first.bin \
  -H 'Host: cache.example.local' http://127.0.0.1:8080/public/bytes
curl -sS -D - -o /tmp/second.bin \
  -H 'Host: cache.example.local' http://127.0.0.1:8080/public/bytes
cmp /tmp/first.bin /tmp/second.bin

# Authentication/cookie traffic bypasses even a warm entry.
curl -sS -D - -o /dev/null -H 'Host: cache.example.local' \
  -H 'Cookie: session=example' http://127.0.0.1:8080/public/bytes

curl --fail -sS -H 'Authorization: Bearer local-cache-demo' \
  http://127.0.0.1:8080/__runtime/response-cache
curl --fail -sS -H 'Authorization: Bearer local-cache-demo' \
  http://127.0.0.1:8080/__runtime/metrics
curl --fail -sS -X POST -H 'Authorization: Bearer local-cache-demo' \
  -H 'Content-Type: application/json' --data '{"projectId":"prj_cache_demo"}' \
  http://127.0.0.1:8080/__runtime/response-cache/purge
```

Expect `MISS`, then `HIT`, then `BYPASS`, with three requests and two guest
invocations. After purge, the next request is a miss. HEAD can reuse a cached GET
entry. `/publicity` and other paths outside `/public` always bypass the cache.

`RESPONSE_CACHE_PORT` overrides port 8080. The demo binds only to loopback and uses
`local-cache-demo` as its local management token; set `ODEN_RUNTIME_TOKEN` to
override it. Ctrl-C drains the gateway and removes its temporary compilation
directory. The response cache is always in memory.

```sh
just response-cache-test
```

The test verifies real guest byte integrity, cache status, avoided invocations,
Cookie bypass, purge and graceful shutdown. This is a gateway cache example;
it provisions no CDN, image processor or AWS resources. See the
[response cache guide](../../docs/user/response-cache.md) for deployment configuration
and supported HTTP semantics.
