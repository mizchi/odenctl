#!/usr/bin/env bash
set -euo pipefail

wasmtime_version="${WASMPLANE_WASMTIME_VERSION:-42.0.1}"
wasm_tools_version="${WASMPLANE_WASM_TOOLS_VERSION:-1.245.1}"
wit_bindgen_version="${WASMPLANE_WIT_BINDGEN_VERSION:-0.51.0}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    platform="x86_64-linux"
    ;;
  *)
    echo "unsupported CI platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

install_dir="${WASMPLANE_CI_BIN_DIR:-$HOME/.local/bin}"
work_dir="${RUNNER_TEMP:-/tmp}/wasmplane-ci-tools"

mkdir -p "$install_dir" "$work_dir"
export PATH="$install_dir:$PATH"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$install_dir" >> "$GITHUB_PATH"
fi

download_and_install() {
  local name="$1"
  local version="$2"
  local url="$3"
  local archive="$4"
  local member="$5"
  local binary="$6"
  local target_dir="$work_dir/$name-$version"

  rm -rf "$target_dir"
  mkdir -p "$target_dir"

  curl --fail --location --show-error --silent "$url" --output "$target_dir/$archive"

  case "$archive" in
    *.tar.gz)
      tar -xzf "$target_dir/$archive" -C "$target_dir"
      ;;
    *.tar.xz)
      tar -xJf "$target_dir/$archive" -C "$target_dir"
      ;;
    *)
      echo "unsupported archive: $archive" >&2
      exit 1
      ;;
  esac

  install -m 0755 "$target_dir/$member" "$install_dir/$binary"
}

download_and_install \
  "wasmtime" \
  "$wasmtime_version" \
  "https://github.com/bytecodealliance/wasmtime/releases/download/v${wasmtime_version}/wasmtime-v${wasmtime_version}-${platform}.tar.xz" \
  "wasmtime-v${wasmtime_version}-${platform}.tar.xz" \
  "wasmtime-v${wasmtime_version}-${platform}/wasmtime" \
  "wasmtime"

download_and_install \
  "wasm-tools" \
  "$wasm_tools_version" \
  "https://github.com/bytecodealliance/wasm-tools/releases/download/v${wasm_tools_version}/wasm-tools-${wasm_tools_version}-${platform}.tar.gz" \
  "wasm-tools-${wasm_tools_version}-${platform}.tar.gz" \
  "wasm-tools-${wasm_tools_version}-${platform}/wasm-tools" \
  "wasm-tools"

download_and_install \
  "wit-bindgen" \
  "$wit_bindgen_version" \
  "https://github.com/bytecodealliance/wit-bindgen/releases/download/v${wit_bindgen_version}/wit-bindgen-${wit_bindgen_version}-${platform}.tar.gz" \
  "wit-bindgen-${wit_bindgen_version}-${platform}.tar.gz" \
  "wit-bindgen-${wit_bindgen_version}-${platform}/wit-bindgen" \
  "wit-bindgen"

wasmtime --version
wasm-tools --version
wit-bindgen --version
