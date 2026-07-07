#!/usr/bin/env bash
set -euo pipefail

flyctl_version="${WASMPLANE_FLYCTL_VERSION:-0.4.67}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    platform="Linux_x86_64"
    default_sha256="f18a0a751801a84072e4e128233eeed45a7f13b8c23dab439f77a32b07b9ea53"
    ;;
  Linux-aarch64|Linux-arm64)
    platform="Linux_arm64"
    default_sha256="e9027eafaba6e2c57ca39e569f51b00a9b110701dc7fb1e423da2069feb1161c"
    ;;
  Darwin-arm64)
    platform="macOS_arm64"
    default_sha256="518928793af7126dd605009ec2fffdbd94832941fe32644aca98f1b61a29d921"
    ;;
  Darwin-x86_64)
    platform="macOS_x86_64"
    default_sha256="4b527b09d49d36f695e8a0bd8490ee21bd5b80bc3690a4752a41119b4c17ddc3"
    ;;
  *)
    echo "unsupported flyctl platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

flyctl_sha256="${WASMPLANE_FLYCTL_SHA256:-$default_sha256}"
archive="flyctl_${flyctl_version}_${platform}.tar.gz"
url="https://github.com/superfly/flyctl/releases/download/v${flyctl_version}/${archive}"
install_dir="${WASMPLANE_CI_BIN_DIR:-$HOME/.local/bin}"
work_dir="${RUNNER_TEMP:-/tmp}/wasmplane-flyctl"
target_dir="$work_dir/flyctl-$flyctl_version-$platform"

mkdir -p "$install_dir" "$target_dir"
export PATH="$install_dir:$PATH"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$install_dir" >> "$GITHUB_PATH"
fi

curl --fail --location --show-error --silent "$url" --output "$target_dir/$archive"

if command -v sha256sum >/dev/null 2>&1; then
  printf "%s  %s\n" "$flyctl_sha256" "$target_dir/$archive" | sha256sum -c -
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$target_dir/$archive" | awk '{print $1}')"
  if [[ "$actual" != "$flyctl_sha256" ]]; then
    echo "flyctl checksum mismatch: expected $flyctl_sha256 got $actual" >&2
    exit 1
  fi
else
  echo "sha256sum or shasum is required to verify flyctl" >&2
  exit 1
fi

tar -xzf "$target_dir/$archive" -C "$target_dir"
flyctl_bin="$(find "$target_dir" -type f -name flyctl -perm -111 | head -n 1)"
if [[ -z "$flyctl_bin" ]]; then
  echo "flyctl binary was not found in $archive" >&2
  exit 1
fi

install -m 0755 "$flyctl_bin" "$install_dir/flyctl"
ln -sf "$install_dir/flyctl" "$install_dir/fly"

flyctl version
