# Quickstart

[User guide](README.md) / Quickstart

Run a minimal WAT command, then start an HTTP service written in Rust or MoonBit.
The commands below assume a macOS or Linux shell. This page uses the standalone
`oden` runtime. For deployment through the control plane, use
[Deploy with odenctl](control-plane.md).

## Prerequisites

| Task | Required tools |
| --- | --- |
| Install the runtime and run WAT directly | Git, Rust/Cargo 1.95 or later, a native linker |
| Run a Rust service | The runtime build tools and Rust's `wasm32-wasip2` target |
| Run a MoonBit service | The runtime build tools, Node.js 24 or later, MoonBit, wit-bindgen, wasm-tools |
| Connect to celld or run tests that use Node | Node.js 24 or later, pnpm 10.33.0, and celld 0.4.1 where needed |

Install Rust before starting. The MoonBit examples have been tested with
`moon 0.1.20260904`, wit-bindgen 0.62.0, and wasm-tools 1.259.0.
MoonBit and Node.js are not required if you only want to try WAT and Rust.

## 1. Install the runtime

```sh
git clone https://github.com/mizchi/odenctl.git
cd odenctl
bash install.sh
export PATH="$HOME/.local/bin:$PATH"
oden --version
```

The version output should include `oden` and `Wasmtime 48.0.2`.
The first build takes time to compile Rust dependencies. If you already cloned the
repository, run `bash install.sh` there. Use `--force` to update an existing
installation, or `--prefix` for another location. See [installation](installation.md).

The `export PATH=...` command applies only to the current terminal. In another
terminal, add the installation directory to PATH or use `$HOME/.local/bin/oden`.

## Create an independent application (optional)

Once the runtime is on PATH, you can generate a project from any working directory.
The destination must be a new directory; existing directories are not overwritten.

```sh
oden init my-app --language rust
rustup target add wasm32-wasip2
oden dev my-app/app.json
```

Use `--language moonbit` for MoonBit. The generated `vendor/oden-sdk` contains
the SDK, WIT contracts, and build support, so developing the app does not require
the runtime's source tree. Commit `app.json`, your source, and `vendor` to your own
repository. Cargo downloads dependencies during the first Rust build. Commit the
generated Cargo.lock as well; add `--locked` to the manifest's build command to
require the locked dependencies.

The generated app returns `{"count":1}` to `curl http://127.0.0.1:8080`.
To build and check it without starting a server:

```sh
oden build my-app/app.json
oden check my-app/app.json
```

The remaining steps use the repository's examples, which also include timers and
lifecycle logs.

## 2. Run the minimal WAT command

```sh
oden run examples/minimal-command/command.wat
echo $?
```

The command produces no stdout output and exits with code `0`. It only demonstrates
successful termination. The runtime reads `.wat` directly, so no external Wasmtime
CLI or Wasm conversion tool is needed. Input must use `(component ...)` format;
a WAT file containing only a core `(module ...)` is not an executable component.

See the [minimal examples](../../examples/minimal-command/README.md) to convert WAT to
a binary or try a minimal MoonBit command.

## 3. Start the Rust HTTP service

```sh
rustup target add wasm32-wasip2
oden dev examples/service-rust/app.json
```

After the build, you should see logs similar to:

```text
starting application generation
lifecycle:start
listening on http://127.0.0.1:8080
```

Logs use both stdout and stderr, so their display order can vary. Send requests
from another terminal:

```sh
curl http://127.0.0.1:8080
curl http://127.0.0.1:8080
```

Example response; `ticks` depends on how long the service has been running:

```json
{"starts":1,"count":1,"ticks":12}
```

The second response has `count: 2`, while `starts` stays at `1`. The server retains
the same instance and increments `ticks` with a timer even when no requests arrive.

## 4. Edit and reload

Edit a response or log message in the [Rust example](../../examples/service-rust/src/lib.rs)
and save it. `dev` detects the change, builds and validates the component, then stops
the old service and starts a new one. The first request after a restart returns
`count: 1` again.

On a build error, `dev` logs `build failed; keeping current generation` and the
previous service continues running. Fix the error and save to trigger another build.
After a successful build, it also checks imports, exports, the execution mode, and
host configuration. A failed check logs `validation failed; keeping current generation`
and keeps the old service. If guest initialization fails after validation, it waits
for the next change without rolling back to the old service.

Press Ctrl-C in the server terminal to stop it. The service waits for accepted
requests, then prints `lifecycle:stop`. See [execution limits](configuration.md#execution-limits)
for startup and shutdown deadline behavior.

## Run the same service in MoonBit

Stop the Rust server first; both examples default to port `8080`.
Put Node.js 24 or later and MoonBit on PATH, then install the Wasm tools:

```sh
node --version
moon version
bash tools/scripts/install-wasm-ci-tools.sh
export PATH="$HOME/.local/bin:$PATH"
oden dev examples/service-moonbit/app.json
```

The installer supports Linux x86_64 and macOS arm64. It places pinned versions of
the Wasmtime CLI, wasm-tools, and wit-bindgen in `$HOME/.local/bin`.
The runtime itself does not invoke the external Wasmtime CLI. Install `moon`
separately; the installer does not include it.

The MoonBit service uses the same URL and JSON response format as the Rust example.
Edit [app.mbt](../../examples/service-moonbit/app.mbt). Files under `target/generated`
are regenerated on each build and should not be edited directly.

## Run an existing build

When you do not need file watching, separate building from starting:

```sh
oden build examples/service-rust/app.json
oden check examples/service-rust/app.json
oden start examples/service-rust/app.json
```

`start` does not build the app. Run `build` first if you changed the source.
You can also pass the same manifest to `just app-dev`, `just app-build`, or
`just app-start`.

Continue with [Writing services](writing-services.md) to implement your handler,
and the [CLI and configuration reference](configuration.md) to set ports and permissions.
