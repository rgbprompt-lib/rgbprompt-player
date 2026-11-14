mod common;

use common::HttpStub;
use rgbprompt_player_core::layout::Support;
use rgbprompt_player_core::model::{FailureCode, PlayKeyboard};
use rgbprompt_player_core::token::{AckBody, TokenClient, TokenError};
use serde_json::{json, Value};

const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn redeem_ok_parses_lep_and_sends_the_contract_body() {
    let stub = HttpStub::start(|method, _path, _body| {
        assert_eq!(method, "POST");
        (
            200,
            json!({
                "effect": {},
                "lep": "AQID",
                "name": "Demo",
                "compiledHash": "hash",
                "engineVersion": "0.4.0",
                "minPlayerVersion": "0.3.0",
                "ackDeadline": 1_700_000_000_000i64,
                "unknownField": "ignored"
            })
            .to_string(),
        )
    });
    let client = TokenClient::new(&stub.base_url(), "mac", "0.3.0", "0.4.0").expect("client");
    let redeemed = client.redeem(TOKEN).expect("redeem");
    assert_eq!(redeemed.lep, vec![1, 2, 3]);
    assert_eq!(redeemed.name.as_deref(), Some("Demo"));
    assert_eq!(redeemed.engine_version, "0.4.0");
    assert_eq!(redeemed.min_player_version, "0.3.0");
    assert_eq!(redeemed.ack_deadline, 1_700_000_000_000);

    let requests = stub.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "/player/redeem");
    let body: Value = serde_json::from_str(&requests[0].body).expect("json");
    assert_eq!(body["token"], TOKEN);
    assert_eq!(body["platform"], "mac");
    assert_eq!(body["playerVersion"], "0.3.0");
    assert_eq!(body["engineVersion"], "0.4.0");
    assert_eq!(body["protocolVersion"], 1);
}

#[test]
fn redeem_maps_not_found_and_rate_limited_codes() {
    let not_found = HttpStub::start(|_method, _path, _body| {
        (
            404,
            json!({"error": {"code": "NOT_FOUND", "message": "gone", "retryable": false, "requestId": "r"}})
                .to_string(),
        )
    });
    let client = TokenClient::new(&not_found.base_url(), "win", "0.3.0", "0.4.0").expect("client");
    assert!(matches!(client.redeem(TOKEN), Err(TokenError::NotFound)));

    let limited = HttpStub::start(|_method, _path, _body| {
        (
            429,
            json!({"error": {"code": "RATE_LIMITED", "message": "slow", "retryable": true, "requestId": "r", "retryAfter": 7}})
                .to_string(),
        )
    });
    let client = TokenClient::new(&limited.base_url(), "win", "0.3.0", "0.4.0").expect("client");
    match client.redeem(TOKEN) {
        Err(TokenError::RateLimited { retry_after }) => assert_eq!(retry_after, Some(7)),
        other => panic!("expected RateLimited, got {other:?}"),
    }
}

#[test]
fn validation_and_unknown_codes_are_http_errors() {
    for code in ["VALIDATION", "INTERNAL"] {
        let stub = HttpStub::start(move |_method, _path, _body| {
            (
                400,
                json!({"error": {"code": code, "message": "bad", "retryable": false, "requestId": "r"}})
                    .to_string(),
            )
        });
        let client = TokenClient::new(&stub.base_url(), "mac", "0.3.0", "0.4.0").expect("client");
        assert!(matches!(client.redeem(TOKEN), Err(TokenError::Http(_))));
    }
}

#[test]
fn refuses_plain_http_to_a_non_loopback_host() {
    assert!(matches!(
        TokenClient::new("http://example.test", "mac", "0.3.0", "0.4.0"),
        Err(TokenError::InsecureBase)
    ));
}

#[test]
fn ack_bodies_match_the_schema() {
    let stub = HttpStub::start(|_method, _path, body| {
        let request: Value = serde_json::from_str(body).expect("json");
        assert_eq!(request["token"], TOKEN);
        (200, json!({"ok": true}).to_string())
    });
    let client = TokenClient::new(&stub.base_url(), "mac", "0.3.0", "0.4.0").expect("client");

    client
        .ack(
            TOKEN,
            AckBody::playing(Some(PlayKeyboard {
                name: Some("Board".to_string()),
                support: Support::PerKey,
            })),
        )
        .expect("playing ack");
    client
        .ack(TOKEN, AckBody::needs_driver())
        .expect("needs_driver ack");
    client
        .ack(TOKEN, AckBody::no_keyboard())
        .expect("no_keyboard ack");
    client
        .ack(TOKEN, AckBody::failed(FailureCode::Internal))
        .expect("failed ack");

    let requests = stub.requests();
    assert_eq!(requests.len(), 4);
    for request in &requests {
        assert_eq!(request.path, "/player/ack");
    }

    let playing: Value = serde_json::from_str(&requests[0].body).expect("json");
    assert_eq!(playing["result"], "playing");
    assert_eq!(playing["keyboard"]["name"], "Board");
    assert_eq!(playing["keyboard"]["support"], "per_key");
    assert!(playing.get("code").is_none());

    let needs_driver: Value = serde_json::from_str(&requests[1].body).expect("json");
    assert_eq!(needs_driver["result"], "needs_driver");
    assert!(needs_driver.get("code").is_none());
    assert!(needs_driver.get("keyboard").is_none());

    let no_keyboard: Value = serde_json::from_str(&requests[2].body).expect("json");
    assert_eq!(no_keyboard["result"], "no_keyboard");
    assert!(no_keyboard.get("code").is_none());

    let failed: Value = serde_json::from_str(&requests[3].body).expect("json");
    assert_eq!(failed["result"], "failed");
    assert_eq!(failed["code"], "internal");
    assert!(failed.get("keyboard").is_none());
}
