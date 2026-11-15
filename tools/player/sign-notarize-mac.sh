#!/usr/bin/env bash
# Sign, notarize and staple a macOS RGBPrompt Player release (Developer ID).
#
# By default this script copies an already-built Release .app, signs every
# Mach-O inside-out with hardened runtime + a secure timestamp, wraps it in
# a zip (the format GET /api/player/download/mac expects) and a DMG, submits
# the DMG to Apple notary, then staples the ticket to both the .app and the
# DMG. It never prints keychain items or the notary password.
#
# Usage:
#   tools/player/sign-notarize-mac.sh --app PATH/To/RGBPrompt\ Player.app
#   tools/player/sign-notarize-mac.sh --build
#
# Environment (all optional):
#   CODESIGN_IDENTITY          default: Developer ID Application: lixin li (3ZEMHQZW5S)
#   NOTARY_KEYCHAIN_PROFILE    default: rgbprompt  (notarytool keychain profile name)
#   DIST_DIR                   default: $ROOT/dist/player-mac
#   CARGO_BUILD_JOBS           passed through to --build (default 2)
#   XCODEBUILD_JOBS            passed through to --build (default 2)
#   OPENRGB_APP                pre-built OpenRGB.app to nest at Contents/Helpers/
#                              default: ~/personal/rgbprompt-signing/releases/openrgb-f81fd32-evision.1/OpenRGB.app
#   OPENRGB_ENTITLEMENTS       empty plist used when re-signing the helper
#   SKIP_OPENRGB=1             skip nesting (dev only; the release Player needs the helper)
#
# Official URL scheme: in-tree / Xcode Info.plist does not declare
# CFBundleURLTypes. This script injects rgbprompt:// into the staged
# copy after ditto + helper nesting and before codesign, then verifies
# the scheme (and the helper, unless SKIP_OPENRGB=1) are present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IDENTITY="${CODESIGN_IDENTITY:-Developer ID Application: lixin li (3ZEMHQZW5S)}"
PROFILE="${NOTARY_KEYCHAIN_PROFILE:-rgbprompt}"
ENTITLEMENTS="$ROOT/apps/player-mac/RGBPromptPlayer.entitlements"
DIST_DIR="${DIST_DIR:-$ROOT/dist/player-mac}"
APP_SRC=""
DO_BUILD=0

usage() {
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --app)
            [[ $# -ge 2 ]] || usage
            APP_SRC="$2"
            shift 2
            ;;
        --build)
            DO_BUILD=1
            shift
            ;;
        --dist)
            [[ $# -ge 2 ]] || usage
            DIST_DIR="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "player:mac:release: unknown argument: $1" >&2
            usage
            ;;
    esac
done

if [[ "$DO_BUILD" -eq 1 ]]; then
    export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
    export XCODEBUILD_JOBS="${XCODEBUILD_JOBS:-2}"
    bash "$ROOT/tools/player/build-mac.sh"
    APP_SRC="$ROOT/apps/player-mac/build/Build/Products/Release/RGBPrompt Player.app"
fi

if [[ -z "$APP_SRC" ]]; then
    echo "player:mac:release: pass --app PATH or --build" >&2
    exit 2
fi
if [[ ! -d "$APP_SRC" ]]; then
    echo "player:mac:release: missing app: $APP_SRC" >&2
    exit 1
fi
if [[ ! -f "$ENTITLEMENTS" ]]; then
    echo "player:mac:release: missing entitlements: $ENTITLEMENTS" >&2
    exit 1
fi

# Refuse to sign if the named identity is not in the keychain.
if ! security find-identity -v -p codesigning | grep -F -q "$IDENTITY"; then
    echo "player:mac:release: codesign identity not found in the keychain: $IDENTITY" >&2
    exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_SRC/Contents/Info.plist")"
BUILD_NO="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_SRC/Contents/Info.plist")"
ARCH="$(lipo -archs "$APP_SRC/Contents/MacOS/RGBPrompt Player" 2>/dev/null || echo unknown)"
ARCH_TAG="${ARCH// /+}"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$DIST_DIR/stage"
APP="$STAGE/RGBPrompt Player.app"
VOL="RGBPrompt Player"
BASE="RGBPrompt-Player-${VERSION}-${BUILD_NO}-mac-${ARCH_TAG}"
mkdir -p "$DIST_DIR"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# Copy, not move: never mutate the Xcode derived-data app in place.
ditto "$APP_SRC" "$APP"

# Nest the already-built OpenRGB helper. Re-sign it with the same identity after
# copying so the outer ticket covers the whole tree. Keep framework symlinks.
OPENRGB_APP="${OPENRGB_APP:-$HOME/personal/rgbprompt-signing/releases/openrgb-f81fd32-evision.1/OpenRGB.app}"
OPENRGB_ENTITLEMENTS="${OPENRGB_ENTITLEMENTS:-$(dirname "$OPENRGB_APP")/OpenRGB.entitlements}"
if [[ "${SKIP_OPENRGB:-0}" != 1 ]]; then
    if [[ ! -d "$OPENRGB_APP" ]]; then
        echo "player:mac:release: missing OpenRGB.app (set OPENRGB_APP): $OPENRGB_APP" >&2
        exit 1
    fi
    mkdir -p "$APP/Contents/Helpers"
    rm -rf "$APP/Contents/Helpers/OpenRGB.app"
    ditto "$OPENRGB_APP" "$APP/Contents/Helpers/OpenRGB.app"
    echo "player:mac:release: bundled OpenRGB from $OPENRGB_APP"
fi

# Development builds must not appear as rgbprompt:// handlers. Claim the
# scheme only on this official staged copy, before any signing.
SCHEME_PLIST="$ROOT/tools/player/official-url-scheme.plist"
STAGED_PLIST="$APP/Contents/Info.plist"
if [[ ! -f "$SCHEME_PLIST" ]]; then
    echo "player:mac:release: missing official URL scheme fragment: $SCHEME_PLIST" >&2
    exit 1
fi
if /usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes' "$STAGED_PLIST" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c 'Delete :CFBundleURLTypes' "$STAGED_PLIST"
fi
/usr/libexec/PlistBuddy -c "Merge $SCHEME_PLIST" "$STAGED_PLIST"
SCHEME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes:0:CFBundleURLSchemes:0' "$STAGED_PLIST")"
if [[ "$SCHEME" != "rgbprompt" ]]; then
    echo "player:mac:release: official URL scheme inject failed (got: ${SCHEME:-empty})" >&2
    exit 1
fi
if [[ "${SKIP_OPENRGB:-0}" != 1 ]]; then
    if [[ ! -x "$APP/Contents/Helpers/OpenRGB.app/Contents/MacOS/OpenRGB" ]]; then
        echo "player:mac:release: official package is missing the bundled OpenRGB helper" >&2
        exit 1
    fi
fi
echo "player:mac:release: injected official rgbprompt:// URL scheme"

is_macho() {
    file -b "$1" 2>/dev/null | grep -q 'Mach-O'
}

# List regular files deepest-first (do not follow symlinks).
list_files_deepest_first() {
    python3 -c '
import os, sys
root = sys.argv[1]
files = []
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    for name in filenames:
        path = os.path.join(dirpath, name)
        if os.path.islink(path) or not os.path.isfile(path):
            continue
        files.append(path)
files.sort(key=lambda p: p.count(os.sep), reverse=True)
print("\n".join(files))
' "$1"
}

list_frameworks_deepest_first() {
    python3 -c '
import os, sys
root = sys.argv[1]
bundles = []
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    if os.path.basename(dirpath).endswith(".framework"):
        bundles.append(dirpath)
bundles.sort(key=lambda p: p.count(os.sep), reverse=True)
print("\n".join(bundles))
' "$1"
}

# Sign nested Mach-O files inside-out. Player audio-input entitlements stay on
# the outer app only; the OpenRGB helper gets empty entitlements (no sandbox).
while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    if is_macho "$file"; then
        codesign --force --options runtime --timestamp --sign "$IDENTITY" "$file"
    fi
done < <(list_files_deepest_first "$APP")

if [[ -d "$APP/Contents/Helpers/OpenRGB.app" ]]; then
    while IFS= read -r bundle; do
        [[ -n "$bundle" ]] || continue
        codesign --force --options runtime --timestamp --sign "$IDENTITY" "$bundle"
    done < <(list_frameworks_deepest_first "$APP/Contents/Helpers/OpenRGB.app")
    if [[ -f "$OPENRGB_ENTITLEMENTS" ]]; then
        codesign --force --options runtime --timestamp \
            --entitlements "$OPENRGB_ENTITLEMENTS" \
            --sign "$IDENTITY" \
            "$APP/Contents/Helpers/OpenRGB.app"
    else
        codesign --force --options runtime --timestamp \
            --sign "$IDENTITY" \
            "$APP/Contents/Helpers/OpenRGB.app"
    fi
fi

codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$IDENTITY" \
    "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"

SCHEME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleURLTypes:0:CFBundleURLSchemes:0' "$APP/Contents/Info.plist")"
if [[ "$SCHEME" != "rgbprompt" ]]; then
    echo "player:mac:release: signed app is missing the official rgbprompt:// URL scheme" >&2
    exit 1
fi
if [[ "${SKIP_OPENRGB:-0}" != 1 && ! -x "$APP/Contents/Helpers/OpenRGB.app/Contents/MacOS/OpenRGB" ]]; then
    echo "player:mac:release: signed app is missing the bundled OpenRGB helper" >&2
    exit 1
fi
echo "player:mac:release: signed app still has official rgbprompt:// scheme and helper"


# Writable scratch folder → compressed DMG, then sign the DMG.
DMG_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/rgbprompt-dmg.XXXXXX")"
cleanup() { rm -rf "$DMG_SCRATCH"; }
trap cleanup EXIT
ditto "$APP" "$DMG_SCRATCH/RGBPrompt Player.app"
ln -s /Applications "$DMG_SCRATCH/Applications"
DMG="$DIST_DIR/${BASE}.dmg"
rm -f "$DMG"
hdiutil create \
    -volname "$VOL" \
    -srcfolder "$DMG_SCRATCH" \
    -ov -format UDZO -imagekey zlib-level=9 \
    "$DMG" >/dev/null
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

echo "player:mac:release: submitting DMG to notary (profile name only, no secrets)"
SUBMIT_JSON="$(mktemp "${TMPDIR:-/tmp}/rgbprompt-notary.XXXXXX")"
if ! xcrun notarytool submit "$DMG" \
        --keychain-profile "$PROFILE" \
        --wait \
        --output-format json > "$SUBMIT_JSON"; then
    echo "player:mac:release: notarytool submit failed" >&2
    # Print the JSON status only (no credentials). Then try to fetch the log by id.
    python3 - "$SUBMIT_JSON" <<'PY' >&2 || true
import json, sys
path = sys.argv[1]
try:
    data = json.load(open(path))
except Exception as exc:
    print(f"could not parse notary json: {exc}")
    sys.exit(0)
print(json.dumps({k: data.get(k) for k in ("id", "status", "message", "success") if k in data or True}, indent=2))
PY
    SUBMISSION_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id") or "")' "$SUBMIT_JSON" 2>/dev/null || true)"
    if [[ -n "${SUBMISSION_ID:-}" ]]; then
        xcrun notarytool log "$SUBMISSION_ID" --keychain-profile "$PROFILE" || true
    fi
    exit 1
fi

python3 - "$SUBMIT_JSON" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
status = data.get("status")
sid = data.get("id")
print(f"player:mac:release: notary id={sid} status={status}")
if status != "Accepted":
    sys.exit(1)
PY

SUBMISSION_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$SUBMIT_JSON")"
rm -f "$SUBMIT_JSON"

xcrun stapler staple "$APP"
xcrun stapler staple "$DMG"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"

# Zip of the stapled app: this is the download-page artifact.
ZIP="$DIST_DIR/${BASE}.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

# Final copy of the stapled .app next to the archives; drop the staging tree.
FINAL_APP="$DIST_DIR/RGBPrompt Player.app"
rm -rf "$FINAL_APP"
ditto "$APP" "$FINAL_APP"
rm -rf "$STAGE"

SHA_ZIP="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
SHA_DMG="$(shasum -a 256 "$DMG" | awk '{print $1}')"
SIZE_ZIP="$(stat -f %z "$ZIP")"
SIZE_DMG="$(stat -f %z "$DMG")"
GIT_COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

INFO="$DIST_DIR/build-info.json"
python3 - "$INFO" <<PY
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
path.write_text(json.dumps({
    "name": "RGBPrompt Player",
    "bundleId": "com.rgbprompt.player",
    "version": "$VERSION",
    "build": "$BUILD_NO",
    "arch": "$ARCH",
    "minOs": "macOS 14.2",
    "sourceCommit": "$GIT_COMMIT",
    "sourceBranch": "$GIT_BRANCH",
    "identity": "$IDENTITY",
    "entitlements": ["com.apple.security.device.audio-input"],
    "notaryProfile": "$PROFILE",
    "notarySubmissionId": "$SUBMISSION_ID",
    "notaryStatus": "Accepted",
    "artifacts": {
        "app": "RGBPrompt Player.app",
        "zip": "$(basename "$ZIP")",
        "zipBytes": int("$SIZE_ZIP"),
        "zipSha256": "$SHA_ZIP",
        "dmg": "$(basename "$DMG")",
        "dmgBytes": int("$SIZE_DMG"),
        "dmgSha256": "$SHA_DMG",
    },
}, indent=2) + "\n")
print(f"player:mac:release: wrote {path}")
PY

{
    echo "$SHA_ZIP  $(basename "$ZIP")"
    echo "$SHA_DMG  $(basename "$DMG")"
} > "$DIST_DIR/SHA256SUMS.txt"

echo "player:mac:release: app=$FINAL_APP"
echo "player:mac:release: zip=$ZIP (${SIZE_ZIP} bytes) sha256=$SHA_ZIP"
echo "player:mac:release: dmg=$DMG (${SIZE_DMG} bytes) sha256=$SHA_DMG"
echo "player:mac:release: version=$VERSION build=$BUILD_NO arch=$ARCH commit=$GIT_COMMIT"
echo "player:mac:release: notary=$SUBMISSION_ID Accepted"
