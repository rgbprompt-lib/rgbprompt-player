#!/usr/bin/env bash
# Build the engine/safety player bundles and the macOS arm64 static core.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export COREPACK_DEFAULT_TO_LATEST="${COREPACK_DEFAULT_TO_LATEST:-0}"

cd "$ROOT"
corepack pnpm --filter @rgbprompt/engine build
corepack pnpm --filter @rgbprompt/safety build

export MACOSX_DEPLOYMENT_TARGET=14.2
cd "$ROOT/apps/player-core"
cargo build --release --target aarch64-apple-darwin -p rgbprompt-player

STATIC_LIB="$ROOT/apps/player-core/target/aarch64-apple-darwin/release/librgbprompt_player.a"
if [ ! -f "$STATIC_LIB" ]; then
    echo "player:core:mac: missing $STATIC_LIB" >&2
    exit 1
fi

SIZE="$(du -h "$STATIC_LIB" | cut -f1)"
printf 'player:core:mac: %s (%s)\n' "$STATIC_LIB" "$SIZE"
