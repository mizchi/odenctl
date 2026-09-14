# Static site release test

This example packages a small static site into a WASI P3 component and tests the
real deployment path with Chromium. It includes HTML, CSS, JavaScript, a binary
PNG, a nested guide page, and two release versions.

## Run the release test

From the repository root, with Node 24+, Rust and `just` installed:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --only-shell chromium
just static-site-test
```

On Linux, use `pnpm exec playwright install --with-deps --only-shell chromium`
to install the browser's system dependencies too. The repository pins Playwright
and CI uses the same test task.

The task builds the host and two distinct components, runs the Rust serving tests
for both versions, then runs three Playwright scenarios. No external account,
database, DNS record or cloud credentials are needed.

Each scenario starts an isolated control plane, runtime gateway and Wasmtime
daemon on loopback ports. It creates a project and registers the runtime through
HTTP. The real deployment CLI then uploads the component to the control plane,
which validates it with Wasmtime, creates an immutable deployment, points the
route and publishes its snapshot using a bearer token. The runtime downloads the
artifact over HTTP, verifies its digest and warms it before acknowledging the
publication. No component invocation or control-plane operation is mocked.

The control-plane repository is in memory for this test. Uploaded/downloaded
artifacts and compilation caches use temporary directories. The test closes its
servers and host process afterward. It does not publish a site to the Internet.

## What is verified

| Scenario | Assertions |
| --- | --- |
| Initial release | CLI reports a successful publication; correct deployment ID; HTML, CSS, JavaScript and PNG served with correct MIME types |
| Browser behavior | Visible page, computed stylesheet color, decoded image, functioning JavaScript button, nested navigation and direct page reload |
| Gateway cache | First request misses, repeated request hits, identical bytes, fresh request IDs, only one guest invocation for two identical requests |
| HTTP details | HEAD preserves representation length without a body; directory redirect; 404 and 405; unknown/encoded paths never read files |
| Update and rollback | New artifact/deployment IDs; HTML invalidated on v2 activation and v1 rollback; one browser context sees the correct HTML, CSS and JS at every step |
| Asset continuity | v1 asset URLs keep working after activating v2; their bytes do not change |
| Management and validation | Unauthenticated publication/purge rejected; invalid Wasm rejected without replacing the current release; Cookie requests bypass caching |

The test supplies `X-Forwarded-Host: static.example.local` as a local ingress
simulation. The browser connects to a loopback address; it does not resolve that
test hostname. A real ingress must set trusted forwarding headers itself.

Screenshots, deployment IDs and the browser report are written under `target/`:

```sh
pnpm exec playwright show-report target/playwright-report
```

Successful screenshots are saved as `static-site-v1.png` and `static-site-v2.png`
inside `target/playwright-results/`. Failing tests additionally retain a trace
and failure screenshot. `pnpm test` covers the Node unit suites; use
`just static-site-test` explicitly to include this browser/release test.

## Components and cache policy

`just static-site-build` produces:

- `examples/static-site/target/site-v1.wasm`
- `examples/static-site/target/site-v2.wasm`

The Rust `release-v2` feature selects the HTML release marker and asset URLs.
`src/site.rs` contains the serving policy separately from the WASI adapter in
`src/lib.rs`. Files are embedded using `include_str!` and `include_bytes!` with an
explicit route table; the guest needs no filesystem or outbound network grants.
This is a small release fixture, not a generic directory packager or SPA router.

HTML uses `public, max-age=0, s-maxage=30, must-revalidate`: the gateway can cache
it for 30 seconds while browsers must check freshness on reuse. Activation and
rollback clear the gateway's entries through snapshot publication.

CSS and JavaScript use release-scoped URLs such as `/assets/v1/site.css` and
`/assets/v2/site.js`, with `public, max-age=31536000, immutable`. Both bundles
retain both versions for this two-release scenario. Never change the bytes at an
immutable asset URL. The shared PNG is unchanged between these releases; give it
a new URL if its bytes change. A general site builder should generate content
hashes or immutable release IDs and retain old assets for the intended rollout
and rollback window.

The gateway's test policy limits shared freshness to 300 seconds and stores at
most 128 entries / 8 MiB. These limits are independent of the browser's asset TTL.
See [Deployment response cache](../../docs/user/response-cache.md) for full semantics.

## Release through an existing control plane

After configuring a runtime node, public host routing and an opt-in response
cache rule for your project, use the same CLI exercised by the test:

```sh
ODENCTL_CONTROL_PLANE_URL=https://control.example.com \
ODENCTL_CONTROL_PLANE_TOKEN="$CONTROL_TOKEN" \
pnpm odenctl deploy \
  --project-id "$PROJECT_ID" \
  --component examples/static-site/target/site-v1.wasm \
  --host site.example.com \
  --runtime-version wasmtime-48.0.2 \
  --limit cpuMs=5000 --limit wallMs=10000
```

The JSON result must report `published: true`. Keep its `deploymentId` for
rollback. Deploy `site-v2.wasm` to the same project/host to activate the next
version. Rollback uses `POST /routes/rollback` with the original deployment ID,
followed by `POST /snapshots/routes/publish`; changing the control-plane route
alone does not update serving nodes.

These local tests demonstrate the Wasm/gateway release path. They do not verify
AWS deployment, CDN cache invalidation, public DNS/TLS, persistence across control
plane restarts, or multi-node atomic release switching.
