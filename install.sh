#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash install.sh [--prefix DIR] [--with-odenctl] [--force]

Build this checkout and install oden on macOS or Linux.

  --prefix DIR     Absolute installation prefix (default: $HOME/.local)
  --with-odenctl   Also install the Node management CLI and its oden-host adapter
  --force          Replace existing commands in PREFIX/bin
  --help           Show this help

Requires Rust/Cargo 1.95+ and a native linker. The management CLI additionally
requires Node.js 24+ and pnpm. It remains usable after removing the source checkout.
ODEN_INSTALL_TARGET_DIR overrides the Cargo build cache directory.
EOF
}

fail() { printf 'install: %s\n' "$*" >&2; exit 1; }
prefix=''
with_odenctl=0
force=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail '--prefix needs an absolute directory'
      prefix="$2"; shift 2 ;;
    --with-odenctl) with_odenctl=1; shift ;;
    --force) force=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
if [[ -z "$prefix" ]]; then
  [[ -n "${HOME:-}" ]] || fail 'HOME is unset; specify --prefix'
  prefix="$HOME/.local"
fi
[[ "$prefix" == /* && "$prefix" != / ]] || fail '--prefix must be an absolute directory other than /'
[[ ! -e "$prefix" || -d "$prefix" ]] || fail 'installation prefix must be a directory'
case "$(uname -s)" in Darwin|Linux) ;; *) fail 'only macOS and Linux are supported' ;; esac
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ -f "$source_dir/crates/oden/Cargo.toml" && -f "$source_dir/Cargo.lock" ]] || fail 'run install.sh from a complete odenctl source checkout'
command -v cargo >/dev/null 2>&1 || fail 'install Rust/Cargo 1.95+ first'
build_dir="${ODEN_INSTALL_TARGET_DIR:-$source_dir/target}"
[[ "$build_dir" == /* ]] || fail 'ODEN_INSTALL_TARGET_DIR must be absolute'
commands=(oden)
build_args=(--bin oden)
if [[ "$with_odenctl" == 1 ]]; then
  command -v node >/dev/null 2>&1 || fail '--with-odenctl requires Node.js 24+'
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || fail '--with-odenctl requires Node.js 24+'
  command -v pnpm >/dev/null 2>&1 || fail '--with-odenctl requires pnpm'
  commands+=(oden-host odenctl)
  build_args+=(--bin oden-host)
fi
for name in "${commands[@]}"; do
  destination="$prefix/bin/$name"
  [[ ! -d "$destination" ]] || fail "destination is a directory: $destination"
  if [[ ( -e "$destination" || -L "$destination" ) && "$force" != 1 ]]; then
    fail "$destination already exists; use --force to update it"
  fi
done

stage="$(mktemp -d "${TMPDIR:-/tmp}/oden-install.XXXXXX")"
stage="$(cd -- "$stage" && pwd -P)"
generation=''
published=0
cleanup() {
  rm -rf -- "$stage"
  if [[ -n "$generation" && "$published" == 0 ]]; then rm -rf -- "$generation"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Building oden from %s\n' "$source_dir"
(
  cd -- "$source_dir"
  # Install native binaries even when another target is selected in the environment.
  unset CARGO_BUILD_TARGET
  cargo build --locked --release --manifest-path "$source_dir/Cargo.toml" \
    --target-dir "$build_dir" -p oden "${build_args[@]}"
)
mkdir -p "$stage/bin"
install -m 0755 "$build_dir/release/oden" "$stage/bin/oden"
"$stage/bin/oden" --version
if [[ "$with_odenctl" == 1 ]]; then
  install -m 0755 "$build_dir/release/oden-host" "$stage/bin/oden-host"
  mkdir -p "$stage/odenctl"
  cp "$source_dir/package.json" "$source_dir/pnpm-lock.yaml" "$stage/odenctl/"
  cp -R "$source_dir/src" "$source_dir/db" "$stage/odenctl/"
  pnpm --dir "$stage/odenctl" install --prod --frozen-lockfile --ignore-scripts
  node "$stage/odenctl/src/cli.ts" --help
fi

# Keep each installed generation self-contained; builds finish before any command
# is replaced. Existing generations remain available to an already-running CLI.
mkdir -p "$prefix/bin" "$prefix/share/oden"
generation="$(mktemp -d "$prefix/share/oden/install.XXXXXX")"
generation="$(cd -- "$generation" && pwd -P)"
mv "$stage/bin" "$generation/bin"
if [[ "$with_odenctl" == 1 ]]; then
  mv "$stage/odenctl" "$generation/odenctl"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf 'default_host=%q\n' "$generation/bin/oden-host"
    printf 'export ODEN_WASIP3_HOST_BIN="${ODEN_WASIP3_HOST_BIN:-$default_host}"\n'
    printf 'exec node %q "$@"\n' "$generation/odenctl/src/cli.ts"
  } > "$generation/bin/odenctl"
  chmod 0755 "$generation/bin/odenctl"
fi
for name in "${commands[@]}"; do
  destination="$prefix/bin/$name"
  [[ ! -d "$destination" ]] || fail "destination became a directory: $destination"
  # Without --force, ln atomically refuses a concurrently-created command.
  if [[ "$force" == 1 ]]; then
    ln -s "$generation/bin/$name" "$generation/$name.link"
    mv -f "$generation/$name.link" "$destination"
  else
    ln -s "$generation/bin/$name" "$destination"
  fi
  published=1
  printf 'Installed %s\n' "$destination"
done
printf '\nAdd this directory to PATH if needed:\n  export PATH=%q:"$PATH"\n' "$prefix/bin"
