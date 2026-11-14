# Security policy

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository
(GitHub private vulnerability reporting). Do not open a public issue for security problems.

Useful details: affected platform and version, steps to reproduce, and impact. Areas of
particular interest are permission handling (keyboard / audio capture), the play-token and
URL-scheme handling in `apps/player-core/crates/core/src/protocol.rs` and `token.rs`, the
managed OpenRGB download and its checksum verification, and the safety limiter.

Supported versions: the latest release.
