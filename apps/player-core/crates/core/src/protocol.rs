//! `rgbprompt://` URL parsing, line-by-line equivalent to
//! `parsePlayerUrl` in `@rgbprompt/contracts` (PLAYER §3.1). The shared case
//! table lives in `tests/data/protocol-cases.json` and is read by both this
//! crate and `packages/contracts`.
use std::collections::HashMap;

pub const PLAYER_URL_SCHEME: &str = "rgbprompt://";
pub const PLAYER_PROTOCOL_VERSION: u64 = 1;
/// JavaScript's `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParsedPlayerUrl {
    Play {
        token: String,
        version: u64,
        /// Allowlisted `{origin}/api` when the URL carries `o=…`.
        api_base: Option<String>,
    },
    Open,
    UnsupportedVersion { version: u64 },
}

/// Parse a Player URL. Equivalent to the contracts implementation:
/// extra query parameters are ignored, the first occurrence of a key wins and
/// a higher `v` is reported as unsupported rather than rejected.

/// Hosts the Player may redeem against when a play URL carries `o`.
const ALLOWED_API_HOSTS: &[&str] = &["rgbprompt.com", "www.rgbprompt.com", "test.rgbprompt.com"];

/// Map a site origin (or already-qualified `/api` base) to `{origin}/api`.
/// Only https allowlisted hosts and http(s) loopback are accepted.
pub fn api_base_from_origin(origin: &str) -> Option<String> {
    let origin = origin.trim();
    if origin.is_empty() {
        return None;
    }
    let (scheme, rest) = if let Some(rest) = origin.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = origin.strip_prefix("http://") {
        ("http", rest)
    } else {
        return None;
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let path_and_more = &rest[authority_end..];
    if authority.is_empty() {
        return None;
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        let end = stripped.find(']')?;
        format!("[{}]", &stripped[..end]).to_ascii_lowercase()
    } else {
        authority
            .split(':')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    if host.is_empty() {
        return None;
    }
    let loopback = host == "127.0.0.1" || host == "localhost" || host == "[::1]";
    let allowlisted = ALLOWED_API_HOSTS.iter().any(|item| *item == host);
    match scheme {
        "https" if allowlisted || loopback => {}
        "http" if loopback => {}
        _ => return None,
    }
    let path_only = match path_and_more.find(['?', '#']) {
        Some(index) => &path_and_more[..index],
        None => path_and_more,
    };
    let mut path = path_only.trim_end_matches('/').to_string();
    if path.is_empty() {
        path = "/api".to_string();
    } else if path != "/api" {
        return None;
    }
    Some(format!("{scheme}://{authority}{path}"))
}

pub fn parse_player_url(url: &str) -> Option<ParsedPlayerUrl> {
    let rest = url.strip_prefix(PLAYER_URL_SCHEME)?;

    let without_hash = match rest.find('#') {
        Some(index) => &rest[..index],
        None => rest,
    };
    let (raw_path, query) = match without_hash.find('?') {
        Some(index) => (&without_hash[..index], &without_hash[index + 1..]),
        None => (without_hash, ""),
    };
    // Some Windows browsers normalize `rgbprompt://play?…` to `play/?…`.
    let path = raw_path.strip_suffix('/').unwrap_or(raw_path);

    if path == "open" {
        return Some(ParsedPlayerUrl::Open);
    }
    if path != "play" {
        return None;
    }

    let mut params: HashMap<&str, &str> = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = match pair.find('=') {
            Some(index) => (&pair[..index], &pair[index + 1..]),
            None => (pair, ""),
        };
        params.entry(key).or_insert(value);
    }

    let token = params.get("t")?;
    if !is_player_token(token) {
        return None;
    }

    let api_base = match params.get("o") {
        Some(raw) if !raw.is_empty() => {
            let decoded = percent_decode(raw)?;
            Some(api_base_from_origin(&decoded)?)
        }
        _ => None,
    };

    let play = |version: u64| ParsedPlayerUrl::Play {
        token: (*token).to_string(),
        version,
        api_base: api_base.clone(),
    };

    let raw_version = match params.get("v") {
        Some(value) if !value.is_empty() => *value,
        _ => return Some(play(PLAYER_PROTOCOL_VERSION)),
    };
    if !raw_version.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let version: u64 = raw_version.parse().ok()?;
    if version > MAX_SAFE_INTEGER {
        return None;
    }
    if version > PLAYER_PROTOCOL_VERSION {
        return Some(ParsedPlayerUrl::UnsupportedVersion { version });
    }
    Some(play(version))
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hi = from_hex(bytes[index + 1])?;
                let lo = from_hex(bytes[index + 2])?;
                out.push((hi << 4) | lo);
                index += 3;
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub fn is_player_token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct Table {
        cases: Vec<Case>,
    }

    #[derive(Debug, Deserialize)]
    struct Case {
        name: String,
        url: String,
        expected: Option<Expected>,
    }

    #[derive(Debug, Deserialize)]
    struct Expected {
        kind: String,
        token: Option<String>,
        version: Option<u64>,
        #[serde(rename = "apiBase", default)]
        api_base: Option<String>,
    }

    fn table() -> Table {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/data/protocol-cases.json"
        ));
        serde_json::from_str(raw).expect("protocol case table")
    }

    #[test]
    fn matches_the_shared_table() {
        for case in table().cases {
            let actual = parse_player_url(&case.url);
            let expected = case.expected.map(|expected| match expected.kind.as_str() {
                "play" => ParsedPlayerUrl::Play {
                    token: expected.token.expect("play token"),
                    version: expected.version.expect("play version"),
                    api_base: expected.api_base,
                },
                "open" => ParsedPlayerUrl::Open,
                "unsupported_version" => ParsedPlayerUrl::UnsupportedVersion {
                    version: expected.version.expect("unsupported version"),
                },
                other => panic!("unknown expected kind {other:?}"),
            });
            assert_eq!(actual, expected, "case: {}", case.name);
        }
    }
}
