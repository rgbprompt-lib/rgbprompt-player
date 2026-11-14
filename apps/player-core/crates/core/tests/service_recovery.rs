mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use openrgb_stub::{StubConfig, StubController, StubEvent, StubServer};
use rgbprompt_player_core::clock::FakeWallClock;
use rgbprompt_player_core::device_health::{KeyboardAttachedProbe, LocationLiveProbe};
use rgbprompt_player_core::driver::{DriverFailure, DriverProvider, DriverStatus, ScriptedDriver};
use rgbprompt_player_core::model::{FailureCode, PlayerState};
use rgbprompt_player_core::service::{
    PlayerConfig, PlayerHandle, PlayerService, PlayerShared, ServiceCommand, ServiceOptions,
    StateSnapshot,
};
use rgbprompt_player_core::Support;
use serde_json::{json, Value};

const LEP: &[u8] = include_bytes!("data/example-cyber-breath.lep");
const TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WALL_NOW: u64 = 1_700_000_000_000;

fn play_url() -> String {
    format!("rgbprompt://play?t={TOKEN}&v=1")
}

fn redeem_response() -> String {
    json!({
        "effect": {},
        "lep": base64::engine::general_purpose::STANDARD.encode(LEP),
        "name": "Demo",
        "compiledHash": "hash",
        "engineVersion": "0.4.0",
        "minPlayerVersion": "0.3.0",
        "ackDeadline": WALL_NOW as i64 + 30 * 60 * 1000,
    })
    .to_string()
}

fn api_handler() -> impl Fn(&str, &str, &str) -> (u16, String) {
    move |_method, path, _body| {
        if path.ends_with("/player/redeem") {
            (200, redeem_response())
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

struct FakeLister(Arc<Mutex<Vec<String>>>);

impl rgbprompt_player_core::ProcessLister for FakeLister {
    fn processes(&self) -> Vec<String> {
        self.0.lock().expect("processes").clone()
    }
}

struct Harness {
    handle: PlayerHandle,
    shared: Arc<PlayerShared>,
    snapshots: Arc<Mutex<Vec<StateSnapshot>>>,
}

impl Harness {
    fn start(
        api_base: &str,
        statuses: Vec<DriverStatus>,
        processes: Arc<Mutex<Vec<String>>>,
        options: ServiceOptions,
    ) -> Harness {
        Self::start_platform(api_base, statuses, processes, options, "mac")
    }

    fn start_platform(
        api_base: &str,
        statuses: Vec<DriverStatus>,
        processes: Arc<Mutex<Vec<String>>>,
        options: ServiceOptions,
        platform: &str,
    ) -> Harness {
        let config = PlayerConfig {
            data_dir: common::temp_dir("recovery"),
            api_base: api_base.to_string(),
            platform: platform.to_string(),
            language: "en".to_string(),
            app_version: "0.3.0".to_string(),
            os_version: "macOS 14.2".to_string(),
            openrgb_addr: "127.0.0.1:1".parse().expect("addr"),
        };
        let shared = PlayerShared::new(config.clone());
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&snapshots);
        shared.set_state_callback(Some(Box::new(move |snapshot: &StateSnapshot| {
            captured.lock().expect("snapshots").push(snapshot.clone());
        })));
        let wall = Arc::new(FakeWallClock::new(WALL_NOW));
        let driver: Arc<dyn DriverProvider> =
            Arc::from(Box::new(ScriptedDriver::new(statuses)) as Box<dyn DriverProvider>);
        let lister: Box<dyn rgbprompt_player_core::ProcessLister> = Box::new(FakeLister(processes));
        let handle = PlayerService::start_with(
            config,
            Arc::clone(&shared),
            driver,
            wall,
            Some(lister),
            options,
        )
        .expect("service");
        Harness {
            handle,
            shared,
            snapshots,
        }
    }

    fn send(&self, command: ServiceCommand) {
        assert!(self.handle.send(command), "service command channel");
    }

    fn wait_for(&self, predicate: impl Fn(&StateSnapshot) -> bool) -> StateSnapshot {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
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
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.handle.shutdown();
    }
}

fn options() -> ServiceOptions {
    ServiceOptions {
        watch_interval: Duration::from_millis(100),
        rescan_debounce: Duration::from_millis(200),
        managed_restart_cooldown: Duration::from_secs(30),
        location_live: LocationLiveProbe::default(),
        keyboard_attached: KeyboardAttachedProbe::new(|| false),
    }
}

fn ack_results(http: &common::HttpStub) -> Vec<String> {
    http.requests()
        .iter()
        .filter(|request| request.path == "/player/ack")
        .filter_map(|request| {
            let body: Value = serde_json::from_str(&request.body).ok()?;
            body["result"].as_str().map(str::to_string)
        })
        .collect()
}

fn modes(stub: &StubServer) -> usize {
    stub.events()
        .iter()
        .filter(|event| matches!(event, StubEvent::UpdateMode { .. }))
        .count()
}

#[test]
fn selects_the_best_supported_keyboard() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![
            StubController::mouse(),
            StubController::zones(3),
            StubController::per_key_ansi104(),
        ],
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        options(),
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    let playing = harness.wait_state(PlayerState::Playing);
    assert_eq!(playing.keyboard_name.as_deref(), Some("Per-key Keyboard"));
    assert_eq!(playing.keyboard_support, Some(Support::PerKey));
    assert!(common::wait_until(Duration::from_secs(3), || {
        stub.events()
            .iter()
            .any(|event| matches!(event, StubEvent::UpdateLeds { dev: 2, .. }))
    }));
    let diagnostics: Value =
        serde_json::from_str(&harness.shared.diagnostics_json()).expect("diagnostics");
    assert_eq!(diagnostics["devices"][0]["name"], "Per-key Keyboard");
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}

#[test]
fn only_a_mouse_is_no_keyboard() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::mouse()],
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        options(),
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NoKeyboard);
    assert!(common::wait_until(Duration::from_secs(3), || {
        ack_results(&http)
            .iter()
            .any(|result| result == "no_keyboard")
    }));
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}

#[test]
fn device_lost_keeps_the_lights_and_recovers() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        options(),
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    let modes_before = modes(&stub);

    stub.remove_controller(0);
    stub.emit_device_list_updated();
    let lost = harness.wait_state(PlayerState::NoKeyboard);
    assert_eq!(lost.error, FailureCode::DeviceLost.status_code());
    assert!(common::wait_until(Duration::from_secs(3), || {
        ack_results(&http).iter().any(|result| result == "failed")
    }));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(modes(&stub), modes_before, "device loss must not restore");

    stub.add_controller(StubController::per_key_ansi104());
    stub.emit_device_list_updated();
    let playing = harness.wait_state(PlayerState::Playing);
    assert_eq!(playing.effect_name.as_deref(), Some("Demo"));
    assert!(common::wait_until(Duration::from_secs(3), || {
        ack_results(&http)
            .iter()
            .filter(|r| *r == "playing")
            .count()
            >= 2
    }));

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}

#[test]
fn backend_loss_reconnects_to_a_new_server() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("stub");
    let port = stub.port();
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        options(),
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);

    stub.shutdown();
    harness.wait_state(PlayerState::BackendUnresponsive);

    let mut replacement = StubServer::start_on(
        port,
        StubConfig {
            protocol_version: 3,
            controllers: vec![StubController::per_key_ansi104()],
        },
    )
    .expect("replacement stub");
    let playing = harness.wait_state(PlayerState::Playing);
    assert_eq!(playing.effect_name.as_deref(), Some("Demo"));

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    replacement.shutdown();
}

#[test]
fn stop_in_no_keyboard_stops_rescans() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: Vec::new(),
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        options(),
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NoKeyboard);
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    // Idle may issue one soft-probe on the first watcher tick. Wait for that
    // in-flight tick, then assert the periodic NoKeyboard rescan has stopped.
    std::thread::sleep(Duration::from_millis(250));
    let count = stub.controller_count_requests();
    std::thread::sleep(Duration::from_millis(700));
    assert_eq!(
        stub.controller_count_requests(),
        count,
        "no rescans may run after stop"
    );
    stub.shutdown();
}

#[test]
fn devices_changed_is_debounced() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: Vec::new(),
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let mut service_options = options();
    service_options.watch_interval = Duration::from_secs(10);
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        service_options,
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NoKeyboard);
    let baseline = stub.controller_count_requests();

    for _ in 0..5 {
        harness.send(ServiceCommand::DevicesChanged);
    }
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(
        stub.controller_count_requests(),
        baseline + 1,
        "five notifications inside the debounce window are one rescan"
    );

    std::thread::sleep(Duration::from_millis(250));
    harness.send(ServiceCommand::DevicesChanged);
    assert!(common::wait_until(Duration::from_secs(2), || {
        stub.controller_count_requests() == baseline + 2
    }));
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}

#[test]
fn the_watcher_is_idle_unless_retrying() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: Vec::new(),
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let mut service_options = options();
    service_options.watch_interval = Duration::from_millis(50);
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        service_options,
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        stub.controller_count_requests() > 0,
        "Idle soft-probes the SDK so Settings can show the live keyboard"
    );

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NoKeyboard);
    stub.add_controller(StubController::per_key_ansi104());
    stub.emit_device_list_updated();
    harness.wait_state(PlayerState::Playing);
    let count = stub.controller_count_requests();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        stub.controller_count_requests(),
        count,
        "no ticks while Playing"
    );
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}

#[test]
fn vendor_conflict_is_reported_and_retry_continues() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: Vec::new(),
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let processes = Arc::new(Mutex::new(vec!["iCUE.exe".to_string()]));
    let harness = Harness::start_platform(
        &http.base_url(),
        vec![running(&stub)],
        Arc::clone(&processes),
        options(),
        "win",
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    let conflict = harness.wait_state(PlayerState::VendorConflict);
    assert_eq!(conflict.conflict_name.as_deref(), Some("Corsair iCUE"));

    processes.lock().expect("processes").clear();
    stub.add_controller(StubController::per_key_ansi104());
    harness.send(ServiceCommand::Retry);
    harness.wait_state(PlayerState::Playing);

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}

#[test]
fn the_local_log_never_contains_keys_or_the_token() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        options(),
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    harness.shared.keys.push(rgbprompt_player_core::KeyEvent {
        t: 0.0,
        down: true,
        cell: "0,0".to_string(),
    });
    std::thread::sleep(Duration::from_millis(100));
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);

    let path = harness.shared.log_path().expect("log path");
    let text = std::fs::read_to_string(&path).expect("log");
    assert!(text.contains("state=playing"), "{text}");
    assert!(!text.contains(TOKEN), "the token must never be logged");
    assert!(!text.contains("Escape"), "key names must never be logged");
    stub.shutdown();
}

struct RestartingDriver {
    status: Mutex<DriverStatus>,
    restarts: AtomicUsize,
    on_restart: Mutex<Option<Box<dyn Fn() + Send>>>,
}

impl RestartingDriver {
    fn new(status: DriverStatus) -> Arc<Self> {
        Arc::new(Self {
            status: Mutex::new(status),
            restarts: AtomicUsize::new(0),
            on_restart: Mutex::new(None),
        })
    }
}

impl DriverProvider for RestartingDriver {
    fn status(&self) -> DriverStatus {
        self.status.lock().expect("status").clone()
    }

    fn is_managed(&self) -> bool {
        true
    }

    fn restart(&self) -> Result<(), DriverFailure> {
        self.restarts.fetch_add(1, Ordering::SeqCst);
        if let Some(callback) = self.on_restart.lock().expect("on_restart").as_ref() {
            callback();
        }
        Ok(())
    }
}

impl Harness {
    fn start_with_driver(
        api_base: &str,
        driver: Arc<dyn DriverProvider>,
        options: ServiceOptions,
    ) -> Harness {
        let config = PlayerConfig {
            data_dir: common::temp_dir("recovery"),
            api_base: api_base.to_string(),
            platform: "mac".to_string(),
            language: "en".to_string(),
            app_version: "0.3.0".to_string(),
            os_version: "macOS 14.2".to_string(),
            openrgb_addr: "127.0.0.1:1".parse().expect("addr"),
        };
        let shared = PlayerShared::new(config.clone());
        let snapshots = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&snapshots);
        shared.set_state_callback(Some(Box::new(move |snapshot: &StateSnapshot| {
            captured.lock().expect("snapshots").push(snapshot.clone());
        })));
        let wall = Arc::new(FakeWallClock::new(WALL_NOW));
        let handle = PlayerService::start_with(
            config,
            Arc::clone(&shared),
            driver,
            wall,
            Some(Box::new(FakeLister(Arc::new(Mutex::new(Vec::new()))))),
            options,
        )
        .expect("service");
        Harness {
            handle,
            shared,
            snapshots,
        }
    }
}

fn stale_keyboard() -> StubController {
    let mut keyboard = StubController::per_key_ansi104();
    keyboard.name = "EVision Keyboard 320F:5000".to_string();
    keyboard.location = "HID: DevSrvsID:4295279001".to_string();
    keyboard
}

fn evision_keyboard() -> StubController {
    let mut keyboard = StubController::per_key_ansi104();
    keyboard.name = "EVision Keyboard 320F:5000".to_string();
    keyboard.location = "HID: 320F:5000".to_string();
    keyboard
}

#[test]
fn stale_hid_handle_does_not_look_playing() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![stale_keyboard()],
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        ServiceOptions {
            watch_interval: Duration::from_millis(100),
            rescan_debounce: Duration::from_millis(200),
            managed_restart_cooldown: Duration::from_millis(50),
            location_live: LocationLiveProbe::new(|_| false),
            keyboard_attached: KeyboardAttachedProbe::new(|| false),
        },
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    let snapshot = harness.wait_state(PlayerState::BackendUnresponsive);
    let states: Vec<_> = harness
        .snapshots
        .lock()
        .expect("snapshots")
        .iter()
        .map(|snapshot| snapshot.state)
        .collect();
    assert!(
        !states.iter().any(|state| *state == PlayerState::Playing),
        "a stale handle must not be reported as playing: {states:?}"
    );
    assert_eq!(snapshot.keyboard_name, None);
    let diagnostics: Value =
        serde_json::from_str(&harness.shared.diagnostics_json()).expect("diagnostics");
    let codes: Vec<String> = diagnostics["recentErrors"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .filter_map(|error| error["code"].as_str().map(str::to_string))
        .collect();
    assert!(
        codes.iter().any(|code| code == "device_stale"),
        "diagnostics should record device_stale, got {diagnostics}"
    );
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}

#[test]
fn stale_hid_handle_restarts_managed_driver_and_resumes() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![stale_keyboard()],
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let live = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&live);
    let driver = RestartingDriver::new(running(&stub));
    let driver_for_cb = Arc::clone(&driver);
    *driver.on_restart.lock().expect("on_restart") = Some(Box::new(move || {
        flag.store(true, Ordering::SeqCst);
    }));
    let probe_flag = Arc::clone(&live);
    let options = ServiceOptions {
        watch_interval: Duration::from_millis(100),
        rescan_debounce: Duration::from_millis(50),
        managed_restart_cooldown: Duration::from_millis(50),
        location_live: LocationLiveProbe::new(move |_| probe_flag.load(Ordering::SeqCst)),
        keyboard_attached: KeyboardAttachedProbe::new(|| false),
    };
    let harness = Harness::start_with_driver(&http.base_url(), driver_for_cb, options);
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::BackendUnresponsive);
    assert!(
        driver.restarts.load(Ordering::SeqCst) >= 1,
        "managed OpenRGB must restart for a stale handle"
    );
    let playing = harness.wait_state(PlayerState::Playing);
    assert_eq!(
        playing.keyboard_name.as_deref(),
        Some("EVision Keyboard 320F:5000")
    );
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}

#[test]
fn idle_stale_handle_requests_rescan_on_external_server() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![stale_keyboard()],
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        ServiceOptions {
            watch_interval: Duration::from_millis(50),
            rescan_debounce: Duration::from_millis(50),
            managed_restart_cooldown: Duration::from_millis(50),
            location_live: LocationLiveProbe::new(|_| false),
            keyboard_attached: KeyboardAttachedProbe::new(|| false),
        },
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if stub
            .events()
            .iter()
            .any(|event| *event == StubEvent::RescanDevices)
        {
            break;
        }
        if std::time::Instant::now() >= deadline {
            panic!(
                "idle soft probe should request packet 140; events: {:?}",
                stub.events()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let snapshot = harness
        .snapshots
        .lock()
        .expect("snapshots")
        .last()
        .cloned()
        .expect("snapshot");
    assert_eq!(snapshot.state, PlayerState::Idle);
    assert_eq!(snapshot.keyboard_name, None);
    let diagnostics: Value =
        serde_json::from_str(&harness.shared.diagnostics_json()).expect("diagnostics");
    let codes: Vec<String> = diagnostics["recentErrors"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .filter_map(|error| error["code"].as_str().map(str::to_string))
        .collect();
    assert!(
        codes.iter().any(|code| code == "device_stale"),
        "diagnostics should record device_stale, got {diagnostics}"
    );
    harness.send(ServiceCommand::Stop);
    stub.shutdown();
}

#[test]
fn no_keyboard_rescan_finds_a_replugged_device() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: Vec::new(),
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        ServiceOptions {
            watch_interval: Duration::from_millis(50),
            rescan_debounce: Duration::from_millis(50),
            managed_restart_cooldown: Duration::from_millis(50),
            location_live: LocationLiveProbe::default(),
            keyboard_attached: KeyboardAttachedProbe::new(|| true),
        },
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NoKeyboard);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if stub
            .events()
            .iter()
            .any(|event| *event == StubEvent::RescanDevices)
        {
            break;
        }
        if std::time::Instant::now() >= deadline {
            panic!(
                "NoKeyboard should request packet 140; events: {:?}",
                stub.events()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    stub.add_controller(StubController::per_key_ansi104());
    stub.emit_device_list_updated();
    let playing = harness.wait_state(PlayerState::Playing);
    assert_eq!(playing.keyboard_name.as_deref(), Some("Per-key Keyboard"));
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}

#[test]
fn retry_forces_a_hardware_rescan_when_no_keyboard() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: Vec::new(),
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        ServiceOptions {
            watch_interval: Duration::from_secs(30),
            rescan_debounce: Duration::from_millis(50),
            managed_restart_cooldown: Duration::from_secs(30),
            location_live: LocationLiveProbe::default(),
            keyboard_attached: KeyboardAttachedProbe::new(|| false),
        },
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NoKeyboard);
    // Long watch interval: only Retry should force packet 140 (and wait
    // for the list). The first NoKeyboard watch tick may already have
    // requested one; clear events by requiring a *new* rescan after Retry.
    let before = stub
        .events()
        .iter()
        .filter(|event| **event == StubEvent::RescanDevices)
        .count();
    stub.add_controller(StubController::per_key_ansi104());
    harness.send(ServiceCommand::Retry);
    let playing = harness.wait_state(PlayerState::Playing);
    assert_eq!(playing.keyboard_name.as_deref(), Some("Per-key Keyboard"));
    let after = stub
        .events()
        .iter()
        .filter(|event| **event == StubEvent::RescanDevices)
        .count();
    assert!(
        after > before,
        "重新查找 must send packet 140; before={before} after={after} events={:?}",
        stub.events()
    );
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}

#[test]
fn losing_the_bound_keyboard_does_not_switch_to_another() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![evision_keyboard()],
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        options(),
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    let playing = harness.wait_state(PlayerState::Playing);
    assert_eq!(
        playing.keyboard_name.as_deref(),
        Some("EVision Keyboard 320F:5000")
    );

    stub.add_controller(StubController::per_key_ansi104());
    stub.remove_controller(0);
    stub.emit_device_list_updated();
    let lost = harness.wait_state(PlayerState::NoKeyboard);
    assert_eq!(lost.keyboard_name, None);
    let names: Vec<_> = harness
        .snapshots
        .lock()
        .expect("snapshots")
        .iter()
        .filter_map(|snapshot| snapshot.keyboard_name.clone())
        .collect();
    assert!(
        names
            .iter()
            .all(|name| name == "EVision Keyboard 320F:5000"),
        "must not silently play on the other keyboard: {names:?}"
    );

    stub.add_controller(evision_keyboard());
    stub.emit_device_list_updated();
    let resumed = harness.wait_state(PlayerState::Playing);
    assert_eq!(
        resumed.keyboard_name.as_deref(),
        Some("EVision Keyboard 320F:5000")
    );
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}

#[test]
fn two_keyboards_at_fresh_start_wait_for_an_explicit_choice() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![evision_keyboard(), StubController::per_key_ansi104()],
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let harness = Harness::start(
        &http.base_url(),
        vec![running(&stub)],
        Arc::new(Mutex::new(Vec::new())),
        options(),
    );
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NoKeyboard);
    harness.send(ServiceCommand::SelectKeyboard(
        "EVision Keyboard 320F:5000".to_string(),
    ));
    let playing = harness.wait_state(PlayerState::Playing);
    assert_eq!(
        playing.keyboard_name.as_deref(),
        Some("EVision Keyboard 320F:5000")
    );
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    stub.shutdown();
}
