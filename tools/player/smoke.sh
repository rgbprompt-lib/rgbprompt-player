#!/usr/bin/env bash
# C ABI smoke test on macOS (PLAYER §11). Builds the staticlib and the OpenRGB
# stub, starts the stub on a free port, compiles the C file with clang, runs
# create -> open_lep -> preview -> stop -> destroy, and kills the stub on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLAYER_CORE="$ROOT/apps/player-core"
cd "$PLAYER_CORE"

cargo build -q -p rgbprompt-player -p openrgb-stub

STUB="target/debug/openrgb-stub"
BIN="target/smoke-c-abi"
LEP="crates/core/tests/data/example-cyber-breath.lep"
LOG="$(mktemp -t rgbprompt-smoke)"
BUILD_LOG="$(mktemp -t rgbprompt-smoke-build)"

cleanup() {
    if [ -n "${STUB_PID:-}" ]; then
        kill "$STUB_PID" 2>/dev/null || true
        wait "$STUB_PID" 2>/dev/null || true
    fi
    rm -f "$LOG" "$BUILD_LOG"
}
trap cleanup EXIT

"$STUB" --port 0 --preset per-key --protocol 3 >"$LOG" 2>&1 &
STUB_PID=$!

PORT=""
for _ in $(seq 1 200); do
    PORT="$(sed -n 's/.*127\.0\.0\.1:\([0-9][0-9]*\).*/\1/p' "$LOG" | head -n1)"
    if [ -n "$PORT" ]; then
        break
    fi
    sleep 0.05
done

if [ -z "$PORT" ]; then
    echo "smoke: openrgb-stub did not start"
    cat "$LOG"
    exit 1
fi

if ! clang "crates/ffi/tests/c/smoke.c" \
    -I include \
    -L target/debug \
    -lrgbprompt_player \
    -lpthread -lm \
    -framework Security -framework CoreFoundation \
    -o "$BIN" 2>"$BUILD_LOG"; then
    echo "smoke: C build failed"
    cat "$BUILD_LOG"
    exit 1
fi

"$BIN" "$LEP" "$PORT"
