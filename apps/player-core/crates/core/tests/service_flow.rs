mod common;

use std::net::{SocketAddr, TcpListener};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use openrgb_stub::{StubConfig, StubController, StubEvent, StubServer};
use rgbprompt_player_core::clock::FakeWallClock;
use rgbprompt_player_core::driver::{DriverStatus, ScriptedDriver};
use rgbprompt_player_core::model::{FailureCode, PlayerState};
use rgbprompt_player_core::service::{
    PlayerConfig, PlayerHandle, PlayerService, PlayerShared, ServiceCommand, StateSnapshot,
};
use rgbprompt_player_core::Support;
use serde_json::{json, Value};

const LEP: &[u8] = include_bytes!("data/example-cyber-breath.lep");
const AUDIO_LEP: &[u8] = include_bytes!("data/music-spectrum.lep");
const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALL_NOW: u64 = 1_700_000_000_000;

fn play_url() -> String {
    format!("rgbprompt://play?t={TOKEN}&v=1")
}

fn lep_base64() -> String {
    base64::engine::general_purpose::STANDARD.encode(LEP)
}

fn redeem_ok(min_player_version: &str, lep: &str, name: &str) -> String {
    json!({
        "effect": {},
        "lep": lep,
        "name": name,
        "compiledHash": "hash",
        "engineVersion": "0.4.0",
        "minPlayerVersion": min_player_version,
        "ackDeadline": WALL_NOW as i64 + 30 * 60 * 1000,
    })
    .to_string()
}

fn handler_returning(redeem: String, status: u16) -> impl Fn(&str, &str, &str) -> (u16, String) {
    move |_method, path, _body| {
        if path.ends_with("/player/redeem") {
            (status, redeem.clone())
        } else {
            (200, json!({"ok": true}).to_string())
        }
    }
}

fn running(stub: &StubServer) -> DriverStatus {
    DriverStatus::Running {
        addr: stub.addr(),
        version: "external".to_string(),
        port: stub.port(),
    }
}

fn free_addr() -> SocketAddr {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let addr = listener.local_addr().expect("addr");
    drop(listener);
    addr
}

struct Harness {
    handle: PlayerHandle,
    shared: Arc<PlayerShared>,
    snapshots: Arc<Mutex<Vec<StateSnapshot>>>,
    wall: Arc<FakeWallClock>,
}

impl Harness {
    fn start(
        api_base: &str,
        statuses: Vec<DriverStatus>,
        app_version: &str,
        openrgb_addr: SocketAddr,
    ) -> Harness {
        let config = PlayerConfig {
            data_dir: std::env::temp_dir().join("rgbprompt-test"),
            api_base: api_base.to_string(),
            platform: "mac".to_string(),
            language: "en".to_string(),
            app_version: app_version.to_string(),
            os_version: "macOS 14.2".to_string(),
            openrgb_addr,
        };
        let shared = PlayerShared::new(config.clone());
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&snapshots);
        shared.set_state_callback(Some(Box::new(move |snapshot: &StateSnapshot| {
            captured.lock().expect("snapshots").push(snapshot.clone());
        })));
        let wall = Arc::new(FakeWallClock::new(WALL_NOW));
        let driver = ScriptedDriver::new(statuses);
        let handle =
            PlayerService::start(config, Arc::clone(&shared), Box::new(driver), wall.clone())
                .expect("service");
        Harness {
            handle,
            shared,
            snapshots,
            wall,
        }
    }

    fn send(&self, command: ServiceCommand) {
        assert!(self.handle.send(command), "service command channel");
    }

    fn wait_for(&self, predicate: impl Fn(&StateSnapshot) -> bool) -> StateSnapshot {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(snapshot) = self
                .snapshots
                .lock()
                .expect("snapshots")
                .iter()
                .rev()
                .find(|snapshot| predicate(snapshot))
                .cloned()
            {
                return snapshot;
            }
            if std::time::Instant::now() >= deadline {
                panic!(
                    "timed out; snapshots: {:?}",
                    self.snapshots.lock().expect("snapshots")
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_state(&self, state: PlayerState) -> StateSnapshot {
        self.wait_for(|snapshot| snapshot.state == state)
    }

    fn wait_error(&self, code: FailureCode) -> StateSnapshot {
        self.wait_for(|snapshot| snapshot.error == code.status_code())
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.handle.shutdown();
    }
}

fn ack_bodies(http: &common::HttpStub) -> Vec<Value> {
    http.requests()
        .iter()
        .filter(|request| request.path == "/player/ack")
        .map(|request| serde_json::from_str(&request.body).expect("ack json"))
        .collect()
}

fn wait_for_ack(http: &common::HttpStub, result: &str) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(body) = ack_bodies(http)
            .into_iter()
            .find(|body| body["result"] == result)
        {
            return body;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {result} ack"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn plays_and_acks_playing() {
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("0.3.0", &lep_base64(), "Demo"),
        200,
    ));
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    let playing = harness.wait_state(PlayerState::Playing);
    assert_eq!(playing.effect_name.as_deref(), Some("Demo"));
    assert_eq!(playing.keyboard_support, Some(Support::PerKey));
    let ack = wait_for_ack(&http, "playing");
    assert_eq!(ack["keyboard"]["support"], "per_key");
    assert!(ack.get("code").is_none());
    assert!(common::wait_until(Duration::from_secs(3), || {
        openrgb
            .events()
            .iter()
            .any(|event| matches!(event, StubEvent::UpdateLeds { .. }))
    }));

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    openrgb.shutdown();
}

#[test]
fn needs_driver_then_retry_plays() {
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("0.3.0", &lep_base64(), "Demo"),
        200,
    ));
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![DriverStatus::Missing, running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NeedsDriver);
    wait_for_ack(&http, "needs_driver");

    harness.send(ServiceCommand::Retry);
    harness.wait_state(PlayerState::Playing);
    wait_for_ack(&http, "playing");
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    openrgb.shutdown();
}

#[test]
fn no_keyboard_then_retry_plays() {
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("0.3.0", &lep_base64(), "Demo"),
        200,
    ));
    let mut empty = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: Vec::new(),
    })
    .expect("empty stub");
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&empty), running(&openrgb)],
        "0.3.0",
        empty.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NoKeyboard);
    wait_for_ack(&http, "no_keyboard");

    harness.send(ServiceCommand::Retry);
    harness.wait_state(PlayerState::Playing);
    wait_for_ack(&http, "playing");
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    empty.shutdown();
    openrgb.shutdown();
}

#[test]
fn update_required_is_acked_and_reported() {
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("9.9.9", &lep_base64(), "Demo"),
        200,
    ));
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_error(FailureCode::UpdateRequired);
    let ack = wait_for_ack(&http, "failed");
    assert_eq!(ack["code"], "update_required");
    openrgb.shutdown();
}

#[test]
fn decode_failed_is_acked_and_reported() {
    let invalid = base64::engine::general_purpose::STANDARD.encode(b"not a lep file");
    let http =
        common::HttpStub::start(handler_returning(redeem_ok("0.3.0", &invalid, "Demo"), 200));
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_error(FailureCode::DecodeFailed);
    let ack = wait_for_ack(&http, "failed");
    assert_eq!(ack["code"], "decode_failed");
    openrgb.shutdown();
}

#[test]
fn unsupported_package_is_acked_and_reported() {
    let mut lep = vec![0u8; 44];
    lep[0..4].copy_from_slice(b"LEP1");
    lep[4] = 99;
    lep[36] = 44; // totalSize, so CRC offset is in range
    let encoded = base64::engine::general_purpose::STANDARD.encode(lep);
    let http =
        common::HttpStub::start(handler_returning(redeem_ok("0.3.0", &encoded, "Demo"), 200));
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_error(FailureCode::UnsupportedPackage);
    let ack = wait_for_ack(&http, "failed");
    assert_eq!(ack["code"], "unsupported_package");
    openrgb.shutdown();
}

#[test]
fn link_unavailable_is_local_without_ack() {
    let http = common::HttpStub::start(|_method, _path, _body| {
        (
            404,
            json!({"error": {"code": "NOT_FOUND", "message": "gone", "retryable": false, "requestId": "r"}})
                .to_string(),
        )
    });
    let openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![DriverStatus::Missing],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_error(FailureCode::LinkUnavailable);
    std::thread::sleep(Duration::from_millis(100));
    assert!(ack_bodies(&http).is_empty(), "a gone token cannot be acked");
}

#[test]
fn unexpected_redeem_error_acks_internal() {
    let http = common::HttpStub::start(|_method, _path, _body| {
        (
            500,
            json!({"error": {"code": "INTERNAL", "message": "boom", "retryable": true, "requestId": "r"}})
                .to_string(),
        )
    });
    let openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![DriverStatus::Missing],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_error(FailureCode::Internal);
    let ack = wait_for_ack(&http, "failed");
    assert_eq!(ack["code"], "internal");
}

#[test]
fn acks_leave_in_fifo_order() {
    let order = Arc::new(Mutex::new(Vec::<String>::new()));
    let order_for_handler = Arc::clone(&order);
    let http = common::HttpStub::start(move |_method, path, body| {
        if path.ends_with("/player/redeem") {
            return (200, redeem_ok("0.3.0", &lep_base64(), "Demo"));
        }
        let request: Value = serde_json::from_str(body).expect("ack json");
        let result = request["result"].as_str().unwrap_or_default().to_string();
        if result == "needs_driver" {
            std::thread::sleep(Duration::from_millis(300));
        }
        order_for_handler.lock().expect("order").push(result);
        (200, json!({"ok": true}).to_string())
    });
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![DriverStatus::Missing, running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NeedsDriver);
    // The ack worker is now blocked on the slow needs_driver response; the
    // playing ack must queue behind it instead of racing it.
    harness.send(ServiceCommand::Retry);
    harness.wait_state(PlayerState::Playing);

    assert!(common::wait_until(Duration::from_secs(5), || {
        order.lock().expect("order").len() >= 2
    }));
    let seen = order.lock().expect("order").clone();
    assert_eq!(
        seen,
        vec!["needs_driver".to_string(), "playing".to_string()]
    );
    let results: Vec<String> = ack_bodies(&http)
        .iter()
        .filter_map(|body| body["result"].as_str().map(str::to_string))
        .collect();
    assert_eq!(results, seen, "requests must reach the server in order");

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    openrgb.shutdown();
}

#[test]
fn stopping_while_needs_driver_acks_driver_declined() {
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("0.3.0", &lep_base64(), "Demo"),
        200,
    ));
    let openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![DriverStatus::Missing],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NeedsDriver);
    wait_for_ack(&http, "needs_driver");
    harness.send(ServiceCommand::Stop);
    harness.wait_error(FailureCode::DriverDeclined);
    let ack = wait_for_ack(&http, "failed");
    assert_eq!(ack["code"], "driver_declined");
}

#[test]
fn unusable_openrgb_is_reported_and_acked() {
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("0.3.0", &lep_base64(), "Demo"),
        200,
    ));
    let addr = free_addr();
    let harness = Harness::start(
        &http.base_url(),
        vec![DriverStatus::Running {
            addr,
            version: "external".to_string(),
            port: addr.port(),
        }],
        "0.3.0",
        addr,
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_error(FailureCode::OpenRgbUnreachable);
    let ack = wait_for_ack(&http, "failed");
    assert_eq!(ack["code"], "openrgb_unreachable");
}

#[test]
fn device_lost_is_reported_and_acked() {
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("0.3.0", &lep_base64(), "Demo"),
        200,
    ));
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    wait_for_ack(&http, "playing");

    openrgb.remove_controller(0);
    openrgb.emit_device_list_updated();
    harness.wait_error(FailureCode::DeviceLost);
    let ack = wait_for_ack(&http, "failed");
    assert_eq!(ack["code"], "device_lost");
    openrgb.shutdown();
}

#[test]
fn shutdown_while_playing_sends_one_black_frame() {
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("0.3.0", &lep_base64(), "Demo"),
        200,
    ));
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let mut harness = Harness::start(
        &http.base_url(),
        vec![running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    harness.handle.shutdown();
    let black = |event: &StubEvent| match event {
        StubEvent::UpdateLeds { colors, .. } => colors.iter().all(|c| *c == [0, 0, 0]),
        _ => false,
    };
    assert!(common::wait_until(Duration::from_secs(3), || {
        openrgb.events().last().is_some_and(black)
    }));
    assert!(!openrgb
        .events()
        .iter()
        .any(|event| matches!(event, StubEvent::UpdateMode { .. })));
    openrgb.shutdown();
}

#[test]
fn stop_sends_one_black_frame_then_nothing() {
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("0.3.0", &lep_base64(), "Demo"),
        200,
    ));
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    let black = |event: &StubEvent| match event {
        StubEvent::UpdateLeds { colors, .. } => colors.iter().all(|c| *c == [0, 0, 0]),
        _ => false,
    };
    assert!(common::wait_until(Duration::from_secs(3), || {
        openrgb.events().last().is_some_and(black)
    }));
    let settled = openrgb.events().len();
    std::thread::sleep(Duration::from_millis(300));
    let events = openrgb.events();
    assert_eq!(
        events.len(),
        settled,
        "nothing is written after the black frame"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, StubEvent::UpdateMode { .. })),
        "stop must not change the mode"
    );
    openrgb.shutdown();
}

#[test]
fn input_wanted_follows_the_effect_and_settings() {
    let audio_lep = base64::engine::general_purpose::STANDARD.encode(AUDIO_LEP);
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("0.3.0", &audio_lep, "Audio"),
        200,
    ));
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    assert!(common::wait_until(Duration::from_secs(2), || {
        harness.shared.input_wanted() == 1
    }));

    harness.send(ServiceCommand::SetAudioEnabled(false));
    assert!(common::wait_until(Duration::from_secs(2), || {
        harness.shared.input_wanted() == 0
    }));

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    openrgb.shutdown();
}

#[test]
fn brightness_is_clamped_in_shared_state() {
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("0.3.0", &lep_base64(), "Demo"),
        200,
    ));
    let openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![DriverStatus::Missing],
        "0.3.0",
        openrgb.addr(),
    );
    harness.send(ServiceCommand::SetBrightness(5));
    assert!(common::wait_until(Duration::from_secs(2), || {
        harness
            .shared
            .brightness
            .load(std::sync::atomic::Ordering::Relaxed)
            == 10
    }));
    harness.send(ServiceCommand::SetBrightness(150));
    assert!(common::wait_until(Duration::from_secs(2), || {
        harness
            .shared
            .brightness
            .load(std::sync::atomic::Ordering::Relaxed)
            == 100
    }));
    let _ = &harness.wall;
}

#[test]
fn failed_ack_is_retried() {
    let attempts = Arc::new(Mutex::new(0u32));
    let attempts_for_handler = Arc::clone(&attempts);
    let http = common::HttpStub::start(move |_method, path, _body| {
        if path.ends_with("/player/redeem") {
            return (200, redeem_ok("0.3.0", &lep_base64(), "Demo"));
        }
        let mut count = attempts_for_handler.lock().expect("attempts");
        *count += 1;
        if *count == 1 {
            (503, json!({"error": {"code": "UNAVAILABLE"}}).to_string())
        } else {
            (200, json!({"ok": true}).to_string())
        }
    });
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    assert!(common::wait_until(Duration::from_secs(5), || {
        *attempts.lock().expect("attempts") >= 2
    }));
    let results: Vec<String> = ack_bodies(&http)
        .iter()
        .filter_map(|body| body["result"].as_str().map(str::to_string))
        .collect();
    assert_eq!(results, vec!["playing".to_string(), "playing".to_string()]);

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    openrgb.shutdown();
}

#[test]
fn replaying_the_same_effect_acks_without_restarting() {
    let http = common::HttpStub::start(handler_returning(
        redeem_ok("0.3.0", &lep_base64(), "Demo"),
        200,
    ));
    let mut openrgb = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("openrgb");
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&openrgb)],
        "0.3.0",
        openrgb.addr(),
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    wait_for_ack(&http, "playing");
    let snapshots_before = harness.snapshots.lock().expect("snapshots").len();

    let second = "b".repeat(64);
    harness.send(ServiceCommand::OpenUrl(format!(
        "rgbprompt://play?t={second}&v=1"
    )));
    assert!(common::wait_until(Duration::from_secs(5), || {
        ack_bodies(&http)
            .iter()
            .filter(|body| body["result"] == "playing")
            .count()
            >= 2
    }));
    let acks = ack_bodies(&http);
    assert_eq!(acks.last().expect("ack")["token"], second.as_str());
    let later: Vec<PlayerState> = harness.snapshots.lock().expect("snapshots")[snapshots_before..]
        .iter()
        .map(|snapshot| snapshot.state)
        .collect();
    assert!(
        later.iter().all(|state| *state == PlayerState::Playing),
        "the effect must not restart: {later:?}"
    );

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    openrgb.shutdown();
}
