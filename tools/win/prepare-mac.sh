#!/usr/bin/env bash
# Prepare Mac-side Node artifacts that the Windows VM build needs.
# Run from the repository root on macOS before tools/win/build.ps1 in the VM.
# Never run pnpm install inside the Windows VM (shared node_modules is macOS).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "==> building @rgbprompt/engine player IIFE"
corepack pnpm --filter @rgbprompt/engine build

echo "==> building @rgbprompt/safety player IIFE"
corepack pnpm --filter @rgbprompt/safety build

ENGINE="$ROOT/packages/engine/dist/player/engine.iife.js"
SAFETY="$ROOT/packages/safety/dist/player/safety.iife.js"
for f in "$ENGINE" "$SAFETY"; do
  if [ ! -f "$f" ]; then
    echo "prepare-mac: missing $f" >&2
    exit 1
  fi
  echo "  ok $(du -h "$f" | awk '{print $1}')  $f"
done

echo "==> writing player golden fixtures"
node tools/golden/player-fixtures.mjs

FIXTURES="$ROOT/apps/player-core/fixtures/golden/manifest.json"
if [ ! -f "$FIXTURES" ]; then
  echo "prepare-mac: missing $FIXTURES" >&2
  exit 1
fi
echo "  ok fixtures at apps/player-core/fixtures/golden/"

echo
echo "Mac side ready. In the Windows VM, from the shared repo root, run:"
echo "  powershell -ExecutionPolicy Bypass -File tools\\win\\build.ps1"
