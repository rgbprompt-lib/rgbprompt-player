#!/usr/bin/env bash
# Run the PlayerKit XCTest suite, including the openrgb-stub integration test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export COREPACK_DEFAULT_TO_LATEST="${COREPACK_DEFAULT_TO_LATEST:-0}"

if ! command -v "${XCODEGEN:-xcodegen}" >/dev/null 2>&1; then
    echo "player:mac:test: XcodeGen is not installed (brew install xcodegen)" >&2
    exit 1
fi

bash "$ROOT/tools/player/build-core-mac.sh"

cd "$ROOT/apps/player-core"
cargo build -p openrgb-stub

STUB="$ROOT/apps/player-core/target/debug/openrgb-stub"
LEP="$ROOT/apps/player-core/crates/core/tests/data/example-cyber-breath.lep"
if [ ! -x "$STUB" ]; then
    echo "player:mac:test: missing $STUB" >&2
    exit 1
fi
if [ ! -f "$LEP" ]; then
    echo "player:mac:test: missing $LEP" >&2
    exit 1
fi

cd "$ROOT"
node "$ROOT/tools/player/gen-mac-layout.mjs" --check
"${XCODEGEN:-xcodegen}" generate --spec apps/player-mac/project.yml

xcodebuild test \
    -project apps/player-mac/RGBPromptPlayer.xcodeproj \
    -scheme PlayerKitTests \
    -configuration Debug \
    -derivedDataPath apps/player-mac/build \
    -destination "platform=macOS,arch=arm64" \
    CODE_SIGN_IDENTITY=- \
    CODE_SIGN_STYLE=Manual \
    RGBP_STUB="$STUB" \
    RGBP_LEP="$LEP" \
    TEST_RUNNER_RGBP_STUB="$STUB" \
    TEST_RUNNER_RGBP_LEP="$LEP"

printf 'player:mac:test: PlayerKitTests complete (stub %s)\n' "$STUB"
