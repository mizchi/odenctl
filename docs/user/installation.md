# Installation

[User documentation](README.md) / Installation

The source installer builds the current checkout and installs commands under
`$HOME/.local` by default. It supports macOS and Linux, uses the locked Cargo
dependencies, and needs Rust/Cargo 1.95+ and a native linker. Prebuilt release
downloads are not provided by this installer.

```sh
git clone https://github.com/mizchi/odenctl.git
cd odenctl
bash install.sh
export PATH="$HOME/.local/bin:$PATH"
oden --version
oden run examples/minimal-command/command.wat
```

The first release build can take several minutes. It installs `oden`; the runtime
does not require Node.js, pnpm, just, or an external Wasmtime CLI to run components.
Language compilers and guest binding tools are separate prerequisites when building
your application. See [the quickstart](getting-started.md).

## Include the management CLI

With Node.js 24+ and pnpm installed:

```sh
bash install.sh --with-odenctl
odenctl --help
```

If `oden` is already installed in this prefix, add `--force` to update it.
This option installs `oden`, `oden-host`, and `odenctl`. It includes the CLI's
TypeScript sources, production Node dependencies, and database migrations in a
self-contained installation. Node.js remains a runtime prerequisite; pnpm is
only used during installation. The CLI works from your application's working
directory after the source checkout is removed.

The installer packages the `crates/odenctl` workspace in a temporary directory;
it preserves the source checkout's development dependencies. The default runtime
build selects only `crates/oden`, with shared Wasmtime code in `crates/runtime-core`.

The installed CLI can use the same arguments as `pnpm odenctl` in the
[deployment guide](control-plane.md). Its wrapper sets `ODEN_WASIP3_HOST_BIN` to
the installed host adapter unless you override it. The installer does not start
the control-plane API, a gateway, or an operating-system service. Those processes
have their own deployment configuration.

## Choose a location and update

```sh
bash install.sh --prefix "$HOME/tools/oden" --with-odenctl
export PATH="$HOME/tools/oden/bin:$PATH"
```

The prefix must be an absolute path other than `/`. Installation creates commands
in `PREFIX/bin` and self-contained generations in `PREFIX/share/oden`. It does
not use sudo or edit shell startup files. Add the printed PATH line to your shell
configuration if you want it in future terminals.

To install a specific revision, check it out before running the script. To update
an existing installation from that checkout:

```sh
bash install.sh --with-odenctl --force
```

Without `--force`, existing commands are preserved and the installer exits before
building. Builds and optional dependency installation finish before commands are
replaced, so build failures leave the existing installation intact. Directory
destinations are rejected even with `--force`. Only the selected commands are
updated; updating `oden` alone leaves an existing `odenctl` installation intact.

The Cargo build cache defaults to this checkout's `target/`. Set
`ODEN_INSTALL_TARGET_DIR` to another absolute path to reuse or isolate that cache.
`just install` is a convenience wrapper for the same installer when just is available.

## Remove an installation

For a dedicated prefix, remove that directory after stopping processes using it.
For a shared prefix such as `$HOME/.local`, remove only the installer-created
`bin/oden`, `bin/odenctl`, and `bin/oden-host` links and the `share/oden` directory.
Older generations are retained during updates so running commands can finish;
they can be removed once no process uses them. Application data and configuration
are stored separately and are not removed by these steps.
