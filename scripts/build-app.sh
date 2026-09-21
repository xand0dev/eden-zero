#!/bin/bash
#
# Build the EDEN//0 macOS .app bundle.
#
# Why this script exists instead of a one-line `tauri build`:
#
#  1. This checkout lives under a directory whose name contains `::`. Cargo puts
#     `<target>/release/deps` on DYLD_FALLBACK_LIBRARY_PATH, and a colon-delimited
#     list cannot represent a path that itself contains colons, so the build fails
#     with "path segment contains separator `:`". Redirecting CARGO_TARGET_DIR to
#     a colon-free location avoids it entirely.
#
#  2. Vite empties `dist/` with fs.rmSync before building, which this machine's
#     sandbox refuses. Moving the directory aside first is the workaround.
#
#  3. Xcode's licence is not accepted, so the Command Line Tools developer dir
#     has to be selected explicitly or git/clang hang on a licence prompt.
#
# The bundle is copied back into the repository so the path is predictable.

set -euo pipefail

cd "$(dirname "$0")/.."

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.eden-zero-build}"

PRODUCT="EDEN-0"

echo "==> Frontend + Rust release build"
mkdir -p "$CARGO_TARGET_DIR"

# Vite must not have to delete an existing output directory (the sandbox blocks
# that), so move it aside under a unique name before building.
if [ -d dist ]; then
  STASH="/tmp/eden-dist-$(date +%s)"
  mv dist "$STASH" && echo "    moved previous dist -> $STASH"
fi
if [ -d dist ]; then
  echo "!! could not move dist aside; the Vite build will likely fail" >&2
fi

./node_modules/.bin/tauri build

echo "==> Copying bundle into the repository"
mkdir -p src-tauri/target/release/bundle/macos
rm -rf "src-tauri/target/release/bundle/macos/$PRODUCT.app" 2>/dev/null || true
cp -R "$CARGO_TARGET_DIR/release/bundle/macos/$PRODUCT.app" src-tauri/target/release/bundle/macos/

echo
echo "Done."
echo "  app: $(pwd)/src-tauri/target/release/bundle/macos/$PRODUCT.app"
ls -d "$CARGO_TARGET_DIR"/release/bundle/*/* 2>/dev/null || true
