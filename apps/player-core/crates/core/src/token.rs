//! Blocking play-token client (PLAYER §3, §9.0.5; ADR-0014).
//!
//! Plain `http://` is accepted only for loopback bases; everything else must be
//! `https://` with rustls + webpki roots (no native/system TLS). The token is
//! never logged and response bodies never appear in logs.
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::model::{FailureCode, PlayKeyboard, PlayResult};

pub const PLAYER_PROTOCOL_VERSION: u32 = 1;
pub const MAX_LEP_BYTES: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    #[error("play token not found")]
    NotFound,
    #[error("rate limited")]
    RateLimited { retry_after: Option<u64> },
    #[error("plain HTTP is only allowed to loopback")]
    InsecureBase,
    #[error("token request failed: {0}")]
    Http(String),
}

#[derive(Clone, Debug)]
pub struct Redeemed {
    pub name: Option<String>,
    pub lep: Vec<u8>,
    pub engine_version: String,
    pub min_player_version: String,
    pub ack_deadline: i64,
}

#[derive(Clone, Debug)]
pub struct AckBody {
    pub result: PlayResult,
    pub code: Option<FailureCode>,
    pub keyboard: Option<PlayKeyboard>,
}

impl AckBody {
    pub fn playing(keyboard: Option<PlayKeyboard>) -> Self {
        Self {
            result: PlayResult::Playing,
            code: None,
            keyboard,
        }
    }

    pub fn needs_driver() -> Self {
        Self {
            result: PlayResult::NeedsDriver,
            code: None,
            keyboard: None,
        }
    }

    pub fn no_keyboard() -> Self {
        Self {
            result: PlayResult::NoKeyboard,
            code: None,
            keyboard: None,
        }
    }

    pub fn failed(code: FailureCode) -> Self {
        Self {
            result: PlayResult::Failed,
            code: Some(code),
            keyboard: None,
        }
    }
}

#[derive(Clone)]
pub struct TokenClient {
    api_base: String,
    platform: String,
    player_version: String,
    engine_version: String,
    agent: ureq::Agent,
}

impl TokenClient {
    pub fn new(
        api_base: &str,
        platform: &str,
        player_version: &str,
        engine_version: &str,
    ) -> Result<Self, TokenError> {
        let api_base = api_base.trim_end_matches('/').to_string();
        validate_base(&api_base)?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            // The Player talks directly; environment proxies are not used.
            .proxy(None)
            .timeout_global(Some(Duration::from_secs(10)))
            .timeout_connect(Some(Duration::from_secs(5)))
            .build()
            .into();
        Ok(Self {
            api_base,
            platform: platform.to_string(),
            player_version: player_version.to_string(),
            engine_version: engine_version.to_string(),
            agent,
        })
    }

    pub fn api_base(&self) -> &str {
        &self.api_base
    }

    /// Same credentials against a different allowlisted API base (play URL `o=`).
    pub fn with_api_base(&self, api_base: &str) -> Result<Self, TokenError> {
        let api_base = api_base.trim_end_matches('/').to_string();
        validate_base(&api_base)?;
        Ok(Self {
            api_base,
            platform: self.platform.clone(),
            player_version: self.player_version.clone(),
            engine_version: self.engine_version.clone(),
            agent: self.agent.clone(),
        })
    }

    pub fn redeem(&self, token: &str) -> Result<Redeemed, TokenError> {
        let url = format!("{}/player/redeem", self.api_base);
        let request = RedeemRequestWire {
            token,
            platform: &self.platform,
            player_version: &self.player_version,
            engine_version: &self.engine_version,
            protocol_version: PLAYER_PROTOCOL_VERSION,
        };
        let mut response = self
            .agent
            .post(&url)
            .send_json(request)
            .map_err(http_error)?;
        let status = response.status().as_u16();
        if status >= 400 {
            return Err(error_from_response(status, &mut response));
        }

        let wire: RedeemResponseWire = response
            .body_mut()
            .with_config()
            .limit(2 * MAX_LEP_BYTES as u64)
            .read_json()
            .map_err(|error| TokenError::Http(error.to_string()))?;

        let lep_text = wire
            .lep
            .ok_or_else(|| TokenError::Http("redeem response is missing lep".to_string()))?;
        if lep_text.len() > MAX_LEP_BYTES * 2 {
            return Err(TokenError::Http("lep payload is too large".to_string()));
        }
        let lep = base64::engine::general_purpose::STANDARD
            .decode(lep_text.as_bytes())
            .map_err(|error| TokenError::Http(format!("invalid lep base64: {error}")))?;
        if lep.len() > MAX_LEP_BYTES {
            return Err(TokenError::Http("lep payload is too large".to_string()));
        }

        Ok(Redeemed {
            name: wire.name,
            lep,
            engine_version: wire
                .engine_version
                .ok_or_else(|| TokenError::Http("missing engineVersion".to_string()))?,
            min_player_version: wire
                .min_player_version
                .ok_or_else(|| TokenError::Http("missing minPlayerVersion".to_string()))?,
            ack_deadline: wire
                .ack_deadline
                .ok_or_else(|| TokenError::Http("missing ackDeadline".to_string()))?,
        })
    }

    pub fn ack(&self, token: &str, body: AckBody) -> Result<(), TokenError> {
        let url = format!("{}/player/ack", self.api_base);
        let request = AckRequestWire {
            token,
            result: body.result.as_str(),
            code: body.code.map(FailureCode::as_str),
            keyboard: body.keyboard.map(|keyboard| PlayKeyboardWire {
                name: keyboard.name,
                support: support_wire(keyboard.support),
            }),
        };
        let mut response = self
            .agent
            .post(&url)
            .send_json(request)
            .map_err(http_error)?;
        let status = response.status().as_u16();
        if status >= 400 {
            return Err(error_from_response(status, &mut response));
        }
        let wire: AckResponseWire = response
            .body_mut()
            .with_config()
            .limit(16 * 1024)
            .read_json()
            .map_err(|error| TokenError::Http(error.to_string()))?;
        if !wire.ok {
            return Err(TokenError::Http("ack was not accepted".to_string()));
        }
        Ok(())
    }
}

fn support_wire(support: crate::layout::Support) -> &'static str {
    crate::model::support_str(support)
}

/// Shared URL rule for the token client and the driver manifest: `https://`
/// anywhere, or plain `http://` to a loopback host only.
pub fn is_allowed_url(value: &str) -> bool {
    validate_base(value).is_ok()
}

fn validate_base(api_base: &str) -> Result<(), TokenError> {
    if let Some(rest) = api_base.strip_prefix("http://") {
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("").to_string();
        let host = if let Some(stripped) = authority.strip_prefix('[') {
            match stripped.find(']') {
                Some(end) => format!("[{}]", &stripped[..end]),
                None => authority.clone(),
            }
        } else {
            authority.split(':').next().unwrap_or("").to_string()
        };
        if host == "127.0.0.1" || host == "localhost" || host == "[::1]" {
            return Ok(());
        }
        return Err(TokenError::InsecureBase);
    }
    if api_base.starts_with("https://") {
        return Ok(());
    }
    Err(TokenError::InsecureBase)
}

fn http_error(error: ureq::Error) -> TokenError {
    TokenError::Http(error.to_string())
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Deserialize)]
struct ErrorBody {
    code: String,
    #[serde(rename = "retryAfter")]
    retry_after: Option<u64>,
}

fn error_from_response(status: u16, response: &mut ureq::http::Response<ureq::Body>) -> TokenError {
    let body = response
        .body_mut()
        .with_config()
        .limit(64 * 1024)
        .read_to_string()
        .ok()
        .and_then(|text| serde_json::from_str::<ErrorEnvelope>(&text).ok());
    match body {
        Some(envelope) if envelope.error.code == "NOT_FOUND" => TokenError::NotFound,
        Some(envelope) if envelope.error.code == "RATE_LIMITED" => TokenError::RateLimited {
            retry_after: envelope.error.retry_after,
        },
        Some(envelope) => TokenError::Http(format!("{} (status {status})", envelope.error.code)),
        None => TokenError::Http(format!("status {status}")),
    }
}

#[derive(Serialize)]
struct RedeemRequestWire<'a> {
    token: &'a str,
    platform: &'a str,
    #[serde(rename = "playerVersion")]
    player_version: &'a str,
    #[serde(rename = "engineVersion")]
    engine_version: &'a str,
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
}

#[derive(Deserialize)]
struct RedeemResponseWire {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    lep: Option<String>,
    #[serde(default, rename = "engineVersion")]
    engine_version: Option<String>,
    #[serde(default, rename = "minPlayerVersion")]
    min_player_version: Option<String>,
    #[serde(default, rename = "ackDeadline")]
    ack_deadline: Option<i64>,
}

#[derive(Serialize)]
struct AckRequestWire<'a> {
    token: &'a str,
    result: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    keyboard: Option<PlayKeyboardWire>,
}

#[derive(Serialize)]
struct PlayKeyboardWire {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    support: &'static str,
}

#[derive(Deserialize)]
struct AckResponseWire {
    #[serde(default)]
    ok: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_loopback_http() {
        for base in [
            "http://127.0.0.1:8787",
            "http://localhost:8787/api",
            "http://[::1]:8787",
            "http://127.0.0.1",
        ] {
            assert!(validate_base(base).is_ok(), "{base}");
        }
    }

    #[test]
    fn refuses_non_loopback_http() {
        for base in [
            "http://example.com",
            "http://192.168.1.2:8787",
            "http://localhost.evil.test",
            "http://[::2]:8787",
            "ftp://127.0.0.1",
        ] {
            assert!(matches!(validate_base(base), Err(TokenError::InsecureBase)));
        }
    }

    #[test]
    fn accepts_https_anywhere() {
        assert!(validate_base("https://api.rgbprompt.com").is_ok());
    }
}
