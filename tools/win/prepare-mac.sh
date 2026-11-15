#!/usr/bin/env bash
# Build the Node artifacts a Windows Player build consumes.
# Run from this repository's root. It does not read any other checkout.
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
echo "Bundles and fixtures are ready in this repository."
echo "On Windows, from this repository root, run:"
echo "  powershell -ExecutionPolicy Bypass -File tools\\win\\build.ps1"
