mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use openrgb_stub::{StubConfig, StubController, StubEvent, StubServer};
use rgbprompt_player_core::clock::FakeWallClock;
use rgbprompt_player_core::device_health::{KeyboardAttachedProbe, LocationLiveProbe};
use rgbprompt_player_core::driver::{
    DriverFailure, DriverProvider, DriverStatus, DriverTimings, InstallResult, ManagedDriver,
    Manifest,
};
use rgbprompt_player_core::model::PlayerState;
use rgbprompt_player_core::service::{
    PlayerConfig, PlayerHandle, PlayerService, PlayerShared, ServiceCommand, ServiceOptions,
    StateSnapshot,
};
use serde_json::{json, Value};

const LEP: &[u8] = include_bytes!("data/example-cyber-breath.lep");
const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALL_NOW: u64 = 1_700_000_000_000;

fn lep_base64() -> String {
    base64::engine::general_purpose::STANDARD.encode(LEP)
}

fn play_url() -> String {
    format!("rgbprompt://play?t={TOKEN}&v=1")
}

fn redeem_response() -> String {
    json!({
        "effect": {},
        "lep": lep_base64(),
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

fn manifest(
    urls: &[&str],
    sha256: Option<&str>,
    size: u64,
    executable: &str,
    args: &[&str],
) -> Manifest {
    let urls: Vec<Value> = urls
        .iter()
        .map(|url| json!({ "kind": "official", "url": url }))
        .collect();
    let json = json!({
        "schema": 1,
        "variant": "standard",
        "version": "1.0",
        "platform": "macos",
        "arch": "arm64",
        "archive": "zip",
        "size_bytes": size,
        "sha256": sha256,
        "executable": executable,
        "args": args,
        "urls": urls,
        "license": "GPL-2.0-only",
        "source": "https://openrgb.org",
    });
    Manifest::from_json(&json.to_string()).expect("manifest")
}

fn short_timings(range: (u16, u16)) -> DriverTimings {
    DriverTimings {
        probe_timeout: Duration::from_millis(100),
        handshake_timeout: Duration::from_secs(5),
        handshake_poll: Duration::from_millis(25),
        supervisor_poll: Duration::from_millis(40),
        crash_window: Duration::from_secs(5),
        crash_limit: 3,
        backoff: [
            Duration::from_millis(40),
            Duration::from_millis(80),
            Duration::from_millis(160),
        ],
        quick_exit: Duration::from_secs(2),
        log_cap: 1024 * 1024,
        port_range: range,
        download_retry: Duration::from_millis(10),
    }
}

fn stub_entry() -> Vec<u8> {
    std::fs::read(common::stub_binary()).expect("stub binary")
}

struct Harness {
    handle: PlayerHandle,
    snapshots: Arc<Mutex<Vec<StateSnapshot>>>,
}

impl Harness {
    fn start(api_base: &str, driver: Arc<ManagedDriver>, data_dir: &std::path::Path) -> Harness {
        let config = PlayerConfig {
            data_dir: data_dir.to_path_buf(),
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
        let lister: Box<dyn rgbprompt_player_core::ProcessLister> = Box::new(common::EmptyLister);
        let dyn_driver: Arc<dyn DriverProvider> = Arc::clone(&driver) as Arc<dyn DriverProvider>;
        let handle = PlayerService::start_with(
            config,
            Arc::clone(&shared),
            dyn_driver,
            wall,
            Some(lister),
            ServiceOptions {
                watch_interval: Duration::from_millis(100),
                rescan_debounce: Duration::from_millis(100),
                managed_restart_cooldown: Duration::from_secs(30),
                location_live: LocationLiveProbe::default(),
                keyboard_attached: KeyboardAttachedProbe::new(|| false),
            },
        )
        .expect("service");
        let _ = &shared;
        Harness { handle, snapshots }
    }

    fn send(&self, command: ServiceCommand) {
        assert!(self.handle.send(command), "service command channel");
    }

    fn wait_for(&self, predicate: impl Fn(&StateSnapshot) -> bool) -> StateSnapshot {
        let deadline = std::time::Instant::now() + Duration::from_secs(25);
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

    fn states(&self) -> Vec<StateSnapshot> {
        self.snapshots.lock().expect("snapshots").clone()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.handle.shutdown();
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

#[test]
fn install_end_to_end_plays() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    let files = common::FileServer::start_bytes(zip.clone());
    let http = common::HttpStub::start(api_handler());
    let dir = common::temp_dir("driver-e2e");
    let base = common::free_port_range(8);
    let configured = common::free_port();
    let manifest = manifest(
        &[&files.url()],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let driver = Arc::new(ManagedDriver::with_manifest(
        std::net::SocketAddr::from(([127, 0, 0, 1], configured)),
        dir.join("openrgb"),
        manifest,
        short_timings((base, base + 7)),
    ));
    let harness = Harness::start(&http.base_url(), Arc::clone(&driver), &dir);

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NeedsDriver);
    assert!(common::wait_until(Duration::from_secs(3), || {
        ack_results(&http)
            .iter()
            .any(|result| result == "needs_driver")
    }));

    harness.send(ServiceCommand::InstallDriver);
    let playing = harness.wait_state(PlayerState::Playing);
    assert_eq!(playing.effect_name.as_deref(), Some("Demo"));
    assert_eq!(playing.driver_error, 0);

    let progress: Vec<i32> = harness
        .states()
        .iter()
        .map(|snapshot| snapshot.driver_progress)
        .collect();
    assert!(
        progress.contains(&100),
        "progress must reach 100: {progress:?}"
    );
    assert!(
        progress.iter().any(|value| (1..100).contains(value)),
        "progress must climb: {progress:?}"
    );
    assert!(common::wait_until(Duration::from_secs(3), || {
        ack_results(&http).iter().any(|result| result == "playing")
    }));
    assert_eq!(
        ack_results(&http).first().map(String::as_str),
        Some("needs_driver")
    );

    assert!(dir.join("openrgb/installed.json").is_file());
    let info = driver.info();
    assert!(info.installed);
    assert_eq!(info.mode, "managed");
    assert!(driver.managed_pid().is_some());

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    drop(harness);
    assert!(
        driver.managed_pid().is_none(),
        "destroy must reap the child"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

fn install_driver(dir: &std::path::Path, manifest: Manifest) -> (ManagedDriver, InstallResult) {
    let base = common::free_port_range(8);
    install_driver_with_range(dir, manifest, (base, base + 7))
}

fn install_driver_with_range(
    dir: &std::path::Path,
    manifest: Manifest,
    range: (u16, u16),
) -> (ManagedDriver, InstallResult) {
    let driver = ManagedDriver::with_manifest(
        std::net::SocketAddr::from(([127, 0, 0, 1], common::free_port())),
        dir.join("openrgb"),
        manifest,
        short_timings(range),
    );
    let result = driver.install();
    (driver, result)
}

#[test]
fn checksum_mismatch_falls_back_to_the_mirror() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    let served = zip.clone();
    let files = common::FileServer::start(move |path| {
        if path == "/official.zip" {
            (200, b"wrong bytes".to_vec())
        } else {
            (200, served.clone())
        }
    });
    let dir = common::temp_dir("driver-mirror");
    let manifest = manifest(
        &[
            &files.url_path("/official.zip"),
            &files.url_path("/mirror.zip"),
        ],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let (driver, result) = install_driver(&dir, manifest);
    assert_eq!(result, InstallResult::Installed);
    assert!(dir.join("openrgb/installed.json").is_file());
    let _ = driver;
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn both_downloads_bad_reports_the_last_reason() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    let files = common::FileServer::start(|_| (200, b"wrong bytes".to_vec()));
    let dir = common::temp_dir("driver-bad");
    let manifest = manifest(
        &[&files.url_path("/a.zip"), &files.url_path("/b.zip")],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let (_driver, result) = install_driver(&dir, manifest);
    assert_eq!(
        result,
        InstallResult::Failed(DriverFailure::ChecksumMismatch)
    );
    assert!(!dir.join("openrgb/installed.json").exists());
    let download = dir.join("openrgb/.download");
    assert!(
        std::fs::read_dir(&download)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true),
        "the part file must be removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn both_downloads_404_reports_download_failed() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    let files = common::FileServer::start(|_| (404, Vec::new()));
    let dir = common::temp_dir("driver-404");
    let manifest = manifest(
        &[&files.url_path("/a.zip"), &files.url_path("/b.zip")],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let (_driver, result) = install_driver(&dir, manifest);
    assert_eq!(result, InstallResult::Failed(DriverFailure::DownloadFailed));
    assert!(!dir.join("openrgb/installed.json").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stop_during_download_cancels_and_removes_the_part() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    let slow = common::SlowServer::start(zip, Duration::from_millis(5));
    let dir = common::temp_dir("driver-cancel");
    let manifest = manifest(
        &[&slow.url()],
        Some("0000000000000000000000000000000000000000000000000000000000000000"),
        common::stub_binary().metadata().unwrap().len(),
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let driver = Arc::new(ManagedDriver::with_manifest(
        std::net::SocketAddr::from(([127, 0, 0, 1], common::free_port())),
        dir.join("openrgb"),
        manifest,
        short_timings((common::free_port_range(8), 0)),
    ));
    let worker = {
        let driver = Arc::clone(&driver);
        std::thread::spawn(move || driver.install())
    };
    std::thread::sleep(Duration::from_millis(200));
    driver.cancel_install();
    let result = worker.join().expect("install thread");
    assert_eq!(result, InstallResult::Cancelled);
    let download = dir.join("openrgb/.download");
    assert!(
        std::fs::read_dir(&download)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true),
        "the part file must be removed on cancel"
    );
    assert!(!dir.join("openrgb/installed.json").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_dropped_connection_resumes_with_range_requests() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    // The first three responses die after 700 bytes; the downloader must keep
    // what arrived and ask for the rest instead of starting over.
    let server = common::RangeServer::start(zip.clone(), 3, 700);
    let dir = common::temp_dir("driver-resume");
    let manifest = manifest(
        &[&server.url()],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let (driver, result) = install_driver(&dir, manifest);
    assert_eq!(result, InstallResult::Installed);
    let ranges = server.ranges();
    assert!(
        ranges.first().is_some_and(|r| r.starts_with("bytes=0-")),
        "{ranges:?}"
    );
    assert!(
        ranges.iter().any(|r| r.starts_with("bytes=700-")),
        "{ranges:?}"
    );
    assert!(
        ranges.iter().any(|r| r.starts_with("bytes=1400-")),
        "{ranges:?}"
    );
    assert!(
        ranges.iter().any(|r| r.starts_with("bytes=2100-")),
        "{ranges:?}"
    );
    let _ = driver;
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_download_keeps_the_part_for_the_next_attempt() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    // Every response is cut after 500 bytes until the downloader gives up.
    let flaky = common::RangeServer::start(zip.clone(), usize::MAX, 64);
    let dir = common::temp_dir("driver-keep-part");
    let manifest_for = |url: &str| {
        manifest(
            &[url],
            Some(&common::sha256_hex(&zip)),
            zip.len() as u64,
            "openrgb-stub",
            &["--server", "--server-port", "{port}"],
        )
    };
    let driver = ManagedDriver::with_manifest(
        std::net::SocketAddr::from(([127, 0, 0, 1], common::free_port())),
        dir.join("openrgb"),
        manifest_for(&flaky.url()),
        short_timings((common::free_port_range(8), 0)),
    );
    // Stop the flaky server mid-way so the attempt ends with a partial file.
    let started = std::time::Instant::now();
    let worker = std::thread::spawn(move || driver.install());
    std::thread::sleep(Duration::from_millis(300));
    drop(flaky);
    let result = worker.join().expect("install thread");
    assert_eq!(result, InstallResult::Failed(DriverFailure::DownloadFailed));
    assert!(started.elapsed() < Duration::from_secs(60));
    let part = dir
        .join("openrgb/.download")
        .join(format!("{}.part", common::sha256_hex(&zip)));
    let kept = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    assert!(kept >= 64, "partial bytes are kept for resume, got {kept}");
    assert!(
        kept < zip.len() as u64,
        "the flaky server must not finish the file"
    );

    let good = common::RangeServer::start(zip.clone(), 0, 0);
    let (driver, result) = install_driver(&dir, manifest_for(&good.url()));
    assert_eq!(result, InstallResult::Installed);
    let ranges = good.ranges();
    assert!(
        ranges
            .first()
            .is_some_and(|r| r.starts_with(&format!("bytes={kept}-"))),
        "resumes at byte {kept}: {ranges:?}"
    );
    assert!(!part.exists());
    let _ = driver;
    let _ = std::fs::remove_dir_all(&dir);
}

/// Live network check of the real install path (chunked Range download,
/// redirects, SHA-256, extract). Opt-in only:
/// `RGBP_LIVE_DOWNLOAD_URL`, `RGBP_LIVE_DOWNLOAD_SHA256`, `RGBP_LIVE_DOWNLOAD_SIZE`,
/// `RGBP_LIVE_DOWNLOAD_EXE`, then `cargo test --test driver_e2e live_ -- --ignored`.
#[test]
#[ignore]
fn live_download_installs_a_real_archive() {
    let env = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
    let url = env("RGBP_LIVE_DOWNLOAD_URL");
    let sha = env("RGBP_LIVE_DOWNLOAD_SHA256");
    let size: u64 = env("RGBP_LIVE_DOWNLOAD_SIZE").parse().expect("size");
    let exe = env("RGBP_LIVE_DOWNLOAD_EXE");
    let dir = common::temp_dir("driver-live");
    let started = std::time::Instant::now();
    let (_driver, result) = install_driver(&dir, manifest(&[&url], Some(&sha), size, &exe, &[]));
    let elapsed = started.elapsed();
    eprintln!(
        "live download: {result:?} in {:.1}s ({:.0} KiB/s)",
        elapsed.as_secs_f64(),
        size as f64 / 1024.0 / elapsed.as_secs_f64()
    );
    assert_eq!(result, InstallResult::Installed);
    assert!(dir.join("openrgb/installed.json").is_file());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn zip_slip_is_rejected() {
    let zip = common::zip_bytes(&[
        ("openrgb-stub", stub_entry(), 0o755),
        ("../evil.txt", b"escape".to_vec(), 0o644),
    ]);
    let files = common::FileServer::start_bytes(zip.clone());
    let dir = common::temp_dir("driver-slip");
    let manifest = manifest(
        &[&files.url()],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let (_driver, result) = install_driver(&dir, manifest);
    assert!(matches!(result, InstallResult::Failed(_)));
    assert!(!dir.join("openrgb/installed.json").exists());
    assert!(!dir.join("openrgb/evil.txt").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn managed_port_falls_back_when_the_first_is_occupied() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    let files = common::FileServer::start_bytes(zip.clone());
    let dir = common::temp_dir("driver-port");
    let base = common::free_port_range(8);
    let manifest = manifest(
        &[&files.url()],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let (driver, result) = install_driver_with_range(&dir, manifest, (base, base + 7));
    assert_eq!(result, InstallResult::Installed);
    let _occupied = std::net::TcpListener::bind(("127.0.0.1", base)).expect("occupy");
    let status = driver.status();
    match status {
        DriverStatus::Running { port, .. } => assert_eq!(port, base + 1),
        other => panic!("expected a managed launch on the next port, got {other:?}"),
    }
    assert!(driver.managed_pid().is_some());
    driver.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_external_server_on_the_configured_port_is_used_as_is() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("stub");
    let dir = common::temp_dir("driver-external");
    let manifest = manifest(
        &["https://example.com/openrgb.zip"],
        Some("0000000000000000000000000000000000000000000000000000000000000000"),
        10,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let driver = ManagedDriver::with_manifest(
        stub.addr(),
        dir.join("openrgb"),
        manifest,
        short_timings((common::free_port_range(8), 0)),
    );
    match driver.status() {
        DriverStatus::Running { version, port, .. } => {
            assert_eq!(version, "external");
            assert_eq!(port, stub.port());
        }
        other => panic!("expected the external server, got {other:?}"),
    }
    assert_eq!(driver.info().mode, "external");
    assert!(driver.managed_pid().is_none());
    driver.shutdown();
    stub.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn info_soft_probes_an_external_server_without_status() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("stub");
    let dir = common::temp_dir("driver-info-soft-probe");
    let manifest = manifest(
        &["https://example.com/openrgb.zip"],
        Some("0000000000000000000000000000000000000000000000000000000000000000"),
        10,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let driver = ManagedDriver::with_manifest(
        stub.addr(),
        dir.join("openrgb"),
        manifest,
        short_timings((common::free_port_range(8), 0)),
    );
    // Settings calls rgbp_driver_info_json without going through status()/resolve.
    // Soft-probe must still surface the user's already-running SDK server.
    let info = driver.info();
    assert_eq!(info.mode, "external");
    assert_eq!(info.port, Some(stub.port()));
    assert!(!info.installed);
    assert!(info.supervision.external);
    assert!(driver.managed_pid().is_none());
    driver.shutdown();
    stub.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_crash_relaunches_and_resumes_playback() {
    let stub = stub_entry();
    let script = br#"#!/bin/sh
DIR=$(dirname "$0")
FLAG="$DIR/.crashed"
if [ ! -f "$FLAG" ]; then
  : > "$FLAG"
  "$DIR/openrgb-stub" "$@" &
  CHILD=$!
  sleep 0.8
  kill "$CHILD" 2>/dev/null
  exit 1
fi
exec "$DIR/openrgb-stub" "$@"
"#
    .to_vec();
    let zip = common::zip_bytes(&[("run.sh", script, 0o755), ("openrgb-stub", stub, 0o755)]);
    let files = common::FileServer::start_bytes(zip.clone());
    let http = common::HttpStub::start(api_handler());
    let dir = common::temp_dir("driver-crash");
    let base = common::free_port_range(8);
    let manifest = manifest(
        &[&files.url()],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "run.sh",
        &["--server", "--server-port", "{port}"],
    );
    let driver = Arc::new(ManagedDriver::with_manifest(
        std::net::SocketAddr::from(([127, 0, 0, 1], common::free_port())),
        dir.join("openrgb"),
        manifest,
        short_timings((base, base + 7)),
    ));
    assert_eq!(driver.install(), InstallResult::Installed);
    let harness = Harness::start(&http.base_url(), Arc::clone(&driver), &dir);

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    harness.wait_state(PlayerState::BackendUnresponsive);
    harness.wait_state(PlayerState::Playing);
    assert!(driver.managed_pid().is_some());

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    drop(harness);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn repeated_crashes_give_up_on_the_backend() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    let files = common::FileServer::start_bytes(zip.clone());
    let http = common::HttpStub::start(api_handler());
    let dir = common::temp_dir("driver-gave-up");
    let base = common::free_port_range(8);
    let manifest = manifest(
        &[&files.url()],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "openrgb-stub",
        &[
            "--server",
            "--server-port",
            "{port}",
            "--exit-after-ms",
            "700",
        ],
    );
    let driver = Arc::new(ManagedDriver::with_manifest(
        std::net::SocketAddr::from(([127, 0, 0, 1], common::free_port())),
        dir.join("openrgb"),
        manifest,
        short_timings((base, base + 7)),
    ));
    assert_eq!(driver.install(), InstallResult::Installed);
    let harness = Harness::start(&http.base_url(), Arc::clone(&driver), &dir);

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::BackendUnresponsive);
    assert!(common::wait_until(Duration::from_secs(10), || {
        let info = driver.info();
        info.supervision.state == "gaveUp" && info.supervision.crashes == 4
    }));
    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    drop(harness);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn restart_backend_on_managed_replaces_the_child() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    let files = common::FileServer::start_bytes(zip.clone());
    let http = common::HttpStub::start(api_handler());
    let dir = common::temp_dir("driver-restart-managed");
    let base = common::free_port_range(8);
    let manifest = manifest(
        &[&files.url()],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let driver = Arc::new(ManagedDriver::with_manifest(
        std::net::SocketAddr::from(([127, 0, 0, 1], common::free_port())),
        dir.join("openrgb"),
        manifest,
        short_timings((base, base + 7)),
    ));
    assert_eq!(driver.install(), InstallResult::Installed);
    let harness = Harness::start(&http.base_url(), Arc::clone(&driver), &dir);
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    let first_pid = driver.managed_pid().expect("managed child");

    harness.send(ServiceCommand::RestartBackend);
    assert!(common::wait_until(Duration::from_secs(10), || {
        let pid = driver.managed_pid();
        pid.is_some()
            && pid != Some(first_pid)
            && harness
                .states()
                .iter()
                .rev()
                .find(|snapshot| snapshot.state == PlayerState::Playing)
                .is_some()
    }));
    harness.wait_state(PlayerState::Playing);

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    drop(harness);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn restart_backend_on_external_does_not_spawn_or_kill() {
    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("stub");
    let http = common::HttpStub::start(api_handler());
    let dir = common::temp_dir("driver-restart-external");
    let manifest = manifest(
        &["https://example.com/openrgb.zip"],
        Some("0000000000000000000000000000000000000000000000000000000000000000"),
        10,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let driver = Arc::new(ManagedDriver::with_manifest(
        stub.addr(),
        dir.join("openrgb"),
        manifest,
        short_timings((common::free_port_range(8), 0)),
    ));
    let harness = Harness::start(&http.base_url(), Arc::clone(&driver), &dir);
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    assert!(driver.managed_pid().is_none());
    let before = stub
        .events()
        .iter()
        .filter(|event| matches!(event, StubEvent::UpdateLeds { .. }))
        .count();

    harness.send(ServiceCommand::RestartBackend);
    assert!(common::wait_until(Duration::from_secs(5), || {
        stub.events()
            .iter()
            .filter(|event| matches!(event, StubEvent::UpdateLeds { .. }))
            .count()
            > before
    }));
    assert!(driver.managed_pid().is_none());

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    drop(harness);
    stub.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

fn custom_timings(range: (u16, u16), backoff: Duration) -> DriverTimings {
    DriverTimings {
        probe_timeout: Duration::from_millis(100),
        handshake_timeout: Duration::from_secs(5),
        handshake_poll: Duration::from_millis(20),
        supervisor_poll: Duration::from_millis(20),
        crash_window: Duration::from_secs(5),
        crash_limit: 3,
        backoff: [backoff, backoff, backoff],
        quick_exit: Duration::from_secs(2),
        log_cap: 1024 * 1024,
        port_range: range,
        download_retry: Duration::from_millis(10),
    }
}

#[test]
fn manifest_override_installs_and_plays() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    let files = common::FileServer::start_bytes(zip.clone());
    let http = common::HttpStub::start(api_handler());
    let dir = common::temp_dir("driver-override");
    let base = common::free_port_range(8);
    let override_manifest = manifest(
        &[&files.url()],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let driver = Arc::new(ManagedDriver::with_manifest(
        std::net::SocketAddr::from(([127, 0, 0, 1], common::free_port())),
        dir.join("openrgb"),
        Manifest::embedded().clone(),
        short_timings((base, base + 7)),
    ));
    // `verified` follows the active manifest: a sha256 counts, and a bundle
    // without a helper does not. The macOS embedded manifest has sha256 null.
    // The Windows embedded manifest carries a measured hash, so it starts verified.
    assert_eq!(
        driver.info().verified,
        Manifest::embedded().sha256.is_some()
    );
    assert!(
        driver.set_manifest(override_manifest),
        "idle override is accepted"
    );
    assert!(driver.info().verified);
    assert_eq!(driver.info().version, "1.0");

    let harness = Harness::start(&http.base_url(), Arc::clone(&driver), &dir);
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::NeedsDriver);
    harness.send(ServiceCommand::InstallDriver);
    harness.wait_state(PlayerState::Playing);
    assert!(driver.info().installed);

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    drop(harness);
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn supervision_reports_restart_then_running() {
    let stub = stub_entry();
    let script = br#"#!/bin/sh
DIR=$(dirname "$0")
FLAG="$DIR/.crashed"
if [ ! -f "$FLAG" ]; then
  : > "$FLAG"
  "$DIR/openrgb-stub" "$@" &
  CHILD=$!
  sleep 0.8
  kill "$CHILD" 2>/dev/null
  exit 1
fi
exec "$DIR/openrgb-stub" "$@"
"#
    .to_vec();
    let zip = common::zip_bytes(&[("run.sh", script, 0o755), ("openrgb-stub", stub, 0o755)]);
    let files = common::FileServer::start_bytes(zip.clone());
    let http = common::HttpStub::start(api_handler());
    let dir = common::temp_dir("driver-supervision");
    let base = common::free_port_range(8);
    let manifest = manifest(
        &[&files.url()],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "run.sh",
        &["--server", "--server-port", "{port}"],
    );
    let driver = Arc::new(ManagedDriver::with_manifest(
        std::net::SocketAddr::from(([127, 0, 0, 1], common::free_port())),
        dir.join("openrgb"),
        manifest,
        custom_timings((base, base + 7), Duration::from_millis(400)),
    ));
    assert_eq!(driver.install(), InstallResult::Installed);
    let harness = Harness::start(&http.base_url(), Arc::clone(&driver), &dir);

    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);

    assert!(common::wait_until(Duration::from_secs(5), || {
        let info = driver.info();
        info.supervision.state == "restarting" && info.supervision.crashes == 1
    }));
    assert!(common::wait_until(Duration::from_secs(5), || {
        let info = driver.info();
        info.supervision.state == "running"
            && harness
                .states()
                .iter()
                .rev()
                .any(|snapshot| snapshot.state == PlayerState::Playing)
    }));

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    drop(harness);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn external_driver_loss_is_probe_only_until_an_explicit_retry() {
    let zip = common::zip_bytes(&[("openrgb-stub", stub_entry(), 0o755)]);
    let files = common::FileServer::start_bytes(zip.clone());
    let http = common::HttpStub::start(api_handler());
    let dir = common::temp_dir("driver-external-lost");
    let base = common::free_port_range(8);

    let mut stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("external stub");
    let external_port = stub.port();

    let manifest = manifest(
        &[&files.url()],
        Some(&common::sha256_hex(&zip)),
        zip.len() as u64,
        "openrgb-stub",
        &["--server", "--server-port", "{port}"],
    );
    let driver = Arc::new(ManagedDriver::with_manifest(
        stub.addr(),
        dir.join("openrgb"),
        manifest,
        short_timings((base, base + 7)),
    ));
    assert_eq!(driver.install(), InstallResult::Installed);

    let harness = Harness::start(&http.base_url(), Arc::clone(&driver), &dir);
    harness.send(ServiceCommand::OpenUrl(play_url()));
    harness.wait_state(PlayerState::Playing);
    assert!(driver.managed_pid().is_none());

    stub.shutdown();
    harness.wait_state(PlayerState::BackendUnresponsive);
    assert!(common::wait_until(Duration::from_secs(5), || {
        driver.info().supervision.state == "externalLost"
    }));

    // Three automatic rescans must not launch our own copy.
    for _ in 0..3 {
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            driver.managed_pid().is_none(),
            "automatic rescans must not steal the external port"
        );
    }

    stub = StubServer::start_on(
        external_port,
        StubConfig {
            protocol_version: 3,
            controllers: vec![StubController::per_key_ansi104()],
        },
    )
    .expect("restart external stub");
    harness.wait_for(|snapshot| {
        snapshot.state == PlayerState::Playing && snapshot.effect_name.as_deref() == Some("Demo")
    });

    stub.shutdown();
    harness.wait_state(PlayerState::BackendUnresponsive);
    assert!(common::wait_until(Duration::from_secs(5), || {
        driver.info().supervision.state == "externalLost"
    }));

    harness.send(ServiceCommand::Retry);
    assert!(common::wait_until(Duration::from_secs(10), || {
        driver.managed_pid().is_some()
            && harness
                .states()
                .iter()
                .rev()
                .any(|snapshot| snapshot.state == PlayerState::Playing)
    }));

    harness.send(ServiceCommand::Stop);
    harness.wait_state(PlayerState::Idle);
    drop(harness);
    let _ = std::fs::remove_dir_all(&dir);
}
