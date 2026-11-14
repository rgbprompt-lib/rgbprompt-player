#!/usr/bin/env bash
# Driver install end to end (PLAYER §4, §11): build the OpenRGB stub, zip it as
# a fake OpenRGB, serve it from a loopback HTTP server, write a temporary
# manifest with the real sha256, then go NeedsDriver -> install -> Playing ->
# stop. This is the same journey as the Rust test, so the script runs that test
# with --nocapture instead of duplicating the harness. The test kills every
# child it starts; nothing here talks to the network or to port 6742.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/apps/player-core"

cargo test -q -p rgbprompt-player-core --test driver_e2e install_end_to_end_plays -- --nocapture
echo "player:driver:e2e: ok"
