#!/usr/bin/env bash
# Build the macOS menu-bar app. Pass --debug for a Debug build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="Release"

for argument in "$@"; do
    case "$argument" in
        --debug) CONFIG="Debug" ;;
        *)
            echo "player:mac:build: unknown argument: $argument" >&2
            exit 2
            ;;
    esac
done

if ! command -v "${XCODEGEN:-xcodegen}" >/dev/null 2>&1; then
    echo "player:mac:build: XcodeGen is not installed (brew install xcodegen)" >&2
    exit 1
fi

export COREPACK_DEFAULT_TO_LATEST="${COREPACK_DEFAULT_TO_LATEST:-0}"
bash "$ROOT/tools/player/build-core-mac.sh"

cd "$ROOT"
"${XCODEGEN:-xcodegen}" generate --spec apps/player-mac/project.yml

XCODEBUILD_ARGS=(
    -project apps/player-mac/RGBPromptPlayer.xcodeproj
    -scheme RGBPromptPlayer
    -configuration "$CONFIG"
    -derivedDataPath apps/player-mac/build
    -destination "platform=macOS,arch=arm64"
    CODE_SIGN_IDENTITY=-
    CODE_SIGN_STYLE=Manual
)
if [[ -n "${XCODEBUILD_JOBS:-}" ]]; then
    XCODEBUILD_ARGS+=(-jobs "$XCODEBUILD_JOBS")
fi

xcodebuild "${XCODEBUILD_ARGS[@]}" build

APP="$ROOT/apps/player-mac/build/Build/Products/$CONFIG/RGBPrompt Player.app"
if [ ! -d "$APP" ]; then
    echo "player:mac:build: missing $APP" >&2
    exit 1
fi

SIZE_KB="$(du -sk "$APP" | cut -f1)"
printf 'player:mac:build: %s (%s KB)\n' "$APP" "$SIZE_KB"
