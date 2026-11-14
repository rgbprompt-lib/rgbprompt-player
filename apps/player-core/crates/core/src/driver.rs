//! OpenRGB driver management (PLAYER §4, PLY-06, PLY-11, PLW-03).
//!
//! Resolution order: the user's own SDK server first, then a managed copy
//! under `<data_dir>/openrgb`, otherwise `Missing`. Installation downloads and
//! verifies an embedded manifest, extracts into a staging directory and only
//! writes `installed.json` last. The child process is supervised by a worker
//! thread; the C ABI never blocks on a download or a launch.
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::openrgb::OpenRGBClient;
use crate::token::is_allowed_url;

pub const DEFAULT_OPENRGB_ADDR: &str = "127.0.0.1:6742";
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const LOG_CAP_BYTES: u64 = 1024 * 1024;
const DOWNLOAD_SLACK_BYTES: u64 = 1024 * 1024;

const EMBEDDED_MACOS_MANIFEST: &str = include_str!("../data/manifests/openrgb-macos.json");
const EMBEDDED_WINDOWS_MANIFEST: &str = include_str!("../data/manifests/openrgb-windows.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManifestVariant {
    Standard,
    Tuned,
}

impl ManifestVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Tuned => "tuned",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestUrl {
    pub kind: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    pub variant: ManifestVariant,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub archive: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
    pub executable: String,
    pub args: Vec<String>,
    pub urls: Vec<ManifestUrl>,
    pub license: String,
    pub source: String,
}

impl Manifest {
    pub fn embedded() -> &'static Manifest {
        static MACOS: std::sync::OnceLock<Manifest> = std::sync::OnceLock::new();
        static WINDOWS: std::sync::OnceLock<Manifest> = std::sync::OnceLock::new();
        if cfg!(target_os = "windows") {
            WINDOWS.get_or_init(|| {
                Manifest::from_json(EMBEDDED_WINDOWS_MANIFEST)
                    .expect("embedded Windows manifest is valid")
            })
        } else {
            MACOS.get_or_init(|| {
                Manifest::from_json(EMBEDDED_MACOS_MANIFEST)
                    .expect("embedded macOS manifest is valid")
            })
        }
    }

    pub fn from_json(json: &str) -> Result<Self, String> {
        let manifest: Manifest = serde_json::from_str(json).map_err(|error| error.to_string())?;
        if manifest.schema != 1 {
            return Err(format!(
                "manifest schema must be 1, got {}",
                manifest.schema
            ));
        }
        if manifest.version.is_empty() || manifest.executable.is_empty() {
            return Err("manifest needs a version and an executable".to_string());
        }
        if manifest.urls.is_empty() {
            return Err("manifest needs at least one URL".to_string());
        }
        for url in &manifest.urls {
            if !is_allowed_url(&url.url) {
                return Err(format!(
                    "manifest URL is not https or loopback: {}",
                    url.url
                ));
            }
        }
        Ok(manifest)
    }

    pub fn install_dir(&self, install_root: &Path) -> PathBuf {
        install_root.join(format!("{}-{}", self.variant.as_str(), self.version))
    }

    pub fn executable_path(&self, install_root: &Path) -> PathBuf {
        self.install_dir(install_root).join(&self.executable)
    }

    fn matches_marker(&self, marker: &InstallMarker, install_root: &Path) -> bool {
        marker.schema == 1
            && marker.variant == self.variant.as_str()
            && marker.version == self.version
            && marker.executable == self.executable
            && Some(marker.sha256.as_str()) == self.sha256.as_deref()
            && self.executable_path(install_root).is_file()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InstallMarker {
    pub schema: u32,
    pub variant: String,
    pub version: String,
    pub sha256: String,
    pub executable: String,
}

/// Side-by-side OpenRGB builds under the Player data dir (PLAYER §4 / M6-M2).
/// The patched `OpenRGB-RGBPrompt.app` is preferred over a stock `OpenRGB.app`.
fn side_by_side_executable(install_root: &Path) -> Option<PathBuf> {
    let data_dir = install_root.parent()?;
    for app in ["OpenRGB-RGBPrompt.app", "OpenRGB.app"] {
        let exe = data_dir
            .join(app)
            .join("Contents")
            .join("MacOS")
            .join("OpenRGB");
        if exe.is_file() {
            return Some(exe);
        }
    }
    None
}

impl InstallMarker {
    pub fn read(install_root: &Path) -> Option<Self> {
        let text = fs::read_to_string(install_root.join("installed.json")).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn write(install_root: &Path, marker: &InstallMarker) -> io::Result<()> {
        let text = serde_json::to_string(marker).map_err(io::Error::other)?;
        let temporary = install_root.join(".installed.json.tmp");
        fs::write(&temporary, text.as_bytes())?;
        fs::rename(&temporary, install_root.join("installed.json"))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DriverStatus {
    Missing,
    Blocked,
    Running {
        addr: SocketAddr,
        version: String,
        port: u16,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriverFailure {
    DownloadFailed = 1,
    ChecksumMismatch = 2,
    LaunchFailed = 3,
    Blocked = 4,
    Unverified = 5,
}

impl DriverFailure {
    pub fn code(self) -> i32 {
        self as i32
    }

    pub fn diagnostic_code(self) -> &'static str {
        match self {
            Self::DownloadFailed => "driver_download_failed",
            Self::ChecksumMismatch => "driver_checksum_mismatch",
            Self::LaunchFailed => "driver_launch_failed",
            Self::Blocked => "driver_blocked",
            Self::Unverified => "driver_unverified",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InstallResult {
    Installed,
    Failed(DriverFailure),
    Cancelled,
}

#[derive(Clone, Debug)]
pub enum DriverEvent {
    Progress(i32),
    InstallFailed(DriverFailure),
    Installed { version: String },
    Launched { addr: SocketAddr, version: String },
    Crashed,
    GaveUp,
    Blocked,
    InstallCancelled,
}

pub type DriverEventSink = Arc<dyn Fn(DriverEvent) + Send + Sync>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionInfo {
    /// `none`, `running`, `restarting`, `gaveUp` or `externalLost`.
    pub state: String,
    pub crashes: usize,
    pub crash_limit: usize,
    pub external: bool,
}

impl Default for SupervisionInfo {
    fn default() -> Self {
        Self {
            state: "none".to_string(),
            crashes: 0,
            crash_limit: 3,
            external: false,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverInfo {
    pub variant: String,
    pub version: String,
    pub size_bytes: u64,
    pub install_dir: String,
    pub source: String,
    pub license: String,
    pub installed: bool,
    pub mode: String,
    pub port: Option<u16>,
    pub executable: Option<String>,
    /// True when the manifest carries a SHA-256.
    pub verified: bool,
    pub supervision: SupervisionInfo,
}

impl DriverInfo {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

#[derive(Clone, Debug)]
pub struct DriverTimings {
    pub probe_timeout: Duration,
    pub handshake_timeout: Duration,
    pub handshake_poll: Duration,
    pub supervisor_poll: Duration,
    pub crash_window: Duration,
    pub crash_limit: usize,
    pub backoff: [Duration; 3],
    pub quick_exit: Duration,
    pub log_cap: u64,
    pub port_range: (u16, u16),
    /// First retry delay after a failed download chunk; doubles per retry.
    pub download_retry: Duration,
}

impl Default for DriverTimings {
    fn default() -> Self {
        Self {
            probe_timeout: PROBE_TIMEOUT,
            handshake_timeout: Duration::from_secs(10),
            handshake_poll: Duration::from_millis(200),
            supervisor_poll: Duration::from_millis(500),
            crash_window: Duration::from_secs(60),
            crash_limit: 3,
            backoff: [
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4),
            ],
            quick_exit: Duration::from_secs(2),
            log_cap: LOG_CAP_BYTES,
            port_range: (6742, 6749),
            download_retry: Duration::from_secs(1),
        }
    }
}

pub trait DriverProvider: Send + Sync {
    fn status(&self) -> DriverStatus;

    /// Full resolution order, ignoring the external-lost probe-only rule.
    /// Used only by an explicit user retry (PLAYER §4).
    fn status_full(&self) -> DriverStatus {
        self.status()
    }

    /// Replace the manifest used by the next install and launch (test/dev
    /// override, PLAYER §4). The default provider has no manifest to replace.
    fn set_manifest(&self, _manifest: Manifest) -> bool {
        false
    }

    fn install(&self) -> InstallResult {
        InstallResult::Failed(DriverFailure::Unverified)
    }

    fn restart(&self) -> Result<(), DriverFailure> {
        Err(DriverFailure::LaunchFailed)
    }

    fn info(&self) -> DriverInfo {
        DriverInfo::default()
    }

    fn cancel_install(&self) {}

    fn set_event_sink(&self, _sink: DriverEventSink) {}

    fn is_managed(&self) -> bool {
        false
    }

    /// Restart the OpenRGB we shipped (`OpenRGB-RGBPrompt.app`) even when it
    /// was inherited as External after a Player relaunch. A stock or unknown
    /// OpenRGB on the configured port is left alone.
    fn restart_inherited_ours(&self) -> Result<(), DriverFailure> {
        if self.is_managed() {
            self.restart()
        } else {
            Ok(())
        }
    }

    fn last_error(&self) -> Option<DriverFailure> {
        None
    }

    /// Whether the manifest carries a hash to verify a download against.
    fn installable(&self) -> bool {
        true
    }

    fn shutdown(&self) {}
}

impl DriverProvider for Arc<dyn DriverProvider> {
    fn status(&self) -> DriverStatus {
        (**self).status()
    }

    fn status_full(&self) -> DriverStatus {
        (**self).status_full()
    }

    fn set_manifest(&self, manifest: Manifest) -> bool {
        (**self).set_manifest(manifest)
    }

    fn install(&self) -> InstallResult {
        (**self).install()
    }

    fn restart(&self) -> Result<(), DriverFailure> {
        (**self).restart()
    }

    fn info(&self) -> DriverInfo {
        (**self).info()
    }

    fn cancel_install(&self) {
        (**self).cancel_install()
    }

    fn set_event_sink(&self, sink: DriverEventSink) {
        (**self).set_event_sink(sink)
    }

    fn is_managed(&self) -> bool {
        (**self).is_managed()
    }

    fn restart_inherited_ours(&self) -> Result<(), DriverFailure> {
        (**self).restart_inherited_ours()
    }

    fn last_error(&self) -> Option<DriverFailure> {
        (**self).last_error()
    }

    fn installable(&self) -> bool {
        (**self).installable()
    }

    fn shutdown(&self) {
        (**self).shutdown()
    }
}

/// Use the OpenRGB server the user already runs at a configured address.
pub struct ExternalOpenRgb {
    pub addr: SocketAddr,
}

impl ExternalOpenRgb {
    pub fn new(addr: SocketAddr) -> Self {
        Self { addr }
    }
}

impl DriverProvider for ExternalOpenRgb {
    fn status(&self) -> DriverStatus {
        if probe_reply(self.addr, PROBE_TIMEOUT) {
            DriverStatus::Running {
                addr: self.addr,
                version: "external".to_string(),
                port: self.addr.port(),
            }
        } else {
            DriverStatus::Missing
        }
    }
}

/// Test provider: returns the queued statuses, then keeps returning the last.
pub struct ScriptedDriver {
    statuses: Mutex<Vec<DriverStatus>>,
}

impl ScriptedDriver {
    pub fn new(statuses: Vec<DriverStatus>) -> Self {
        Self {
            statuses: Mutex::new(statuses),
        }
    }

    pub fn push(&self, status: DriverStatus) {
        self.statuses.lock().expect("driver statuses").push(status);
    }
}

impl DriverProvider for ScriptedDriver {
    fn status(&self) -> DriverStatus {
        let mut statuses = self.statuses.lock().expect("driver statuses");
        if statuses.len() > 1 {
            statuses.remove(0)
        } else {
            statuses.first().cloned().unwrap_or(DriverStatus::Missing)
        }
    }
}

#[derive(Clone, Debug)]
enum DriverMode {
    None,
    External {
        addr: SocketAddr,
    },
    Managed {
        addr: SocketAddr,
        port: u16,
        version: String,
    },
}

struct Inner {
    mode: DriverMode,
    process: Option<ManagedProcess>,
    crash_times: VecDeque<Instant>,
    last_error: Option<DriverFailure>,
    cancel: Arc<AtomicBool>,
    gave_up: bool,
    /// The last successful probe used the configured external server.
    last_external: bool,
    /// The most recent probe of that external server failed.
    external_lost: bool,
}

struct ManagedProcess {
    control: Arc<ProcessControl>,
    supervisor: JoinHandle<()>,
}

struct ProcessControl {
    child: Mutex<Child>,
    stop: AtomicBool,
    port: u16,
    addr: SocketAddr,
    started: Mutex<Instant>,
}

impl ProcessControl {
    fn alive(&self) -> bool {
        let Ok(mut child) = self.child.lock() else {
            return false;
        };
        matches!(child.try_wait(), Ok(None))
    }
}

struct DriverShared {
    configured_addr: SocketAddr,
    install_root: PathBuf,
    manifest: Mutex<Manifest>,
    timings: DriverTimings,
    sink: Mutex<Option<DriverEventSink>>,
    inner: Mutex<Inner>,
}

impl DriverShared {
    fn manifest(&self) -> Manifest {
        self.manifest
            .lock()
            .map(|manifest| manifest.clone())
            .unwrap_or_else(|_| Manifest::embedded().clone())
    }

    fn set_manifest(&self, manifest: Manifest) {
        if let Ok(mut slot) = self.manifest.lock() {
            *slot = manifest;
        }
    }

    fn emit(&self, event: DriverEvent) {
        let sink = self.sink.lock().ok().and_then(|slot| slot.clone());
        if let Some(sink) = sink {
            sink(event);
        }
    }

    fn set_last_error(&self, failure: Option<DriverFailure>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_error = failure;
        }
    }
}

pub struct ManagedDriver {
    shared: Arc<DriverShared>,
}

impl ManagedDriver {
    pub fn new(
        configured_addr: SocketAddr,
        install_root: PathBuf,
        _platform: String,
        timings: DriverTimings,
    ) -> Self {
        Self::with_manifest(
            configured_addr,
            install_root,
            Manifest::embedded().clone(),
            timings,
        )
    }

    pub fn with_manifest(
        configured_addr: SocketAddr,
        install_root: PathBuf,
        manifest: Manifest,
        timings: DriverTimings,
    ) -> Self {
        Self {
            shared: Arc::new(DriverShared {
                configured_addr,
                install_root,
                manifest: Mutex::new(manifest),
                timings,
                sink: Mutex::new(None),
                inner: Mutex::new(Inner {
                    mode: DriverMode::None,
                    process: None,
                    crash_times: VecDeque::new(),
                    last_error: None,
                    cancel: Arc::new(AtomicBool::new(false)),
                    gave_up: false,
                    last_external: false,
                    external_lost: false,
                }),
            }),
        }
    }

    pub fn managed_pid(&self) -> Option<u32> {
        let inner = self.shared.inner.lock().ok()?;
        let process = inner.process.as_ref()?;
        let child = process.control.child.lock().ok()?;
        Some(child.id())
    }

    fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.shared
            .inner
            .lock()
            .map(|inner| Arc::clone(&inner.cancel))
            .unwrap_or_else(|_| Arc::new(AtomicBool::new(false)))
    }

    fn launch(&self) -> DriverStatus {
        let shared = &self.shared;
        let (start, end) = shared.timings.port_range;
        let mut chosen = None;
        for port in start..=end {
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            match TcpListener::bind(addr) {
                Ok(listener) => {
                    drop(listener);
                    chosen = Some(port);
                    break;
                }
                Err(_) => {
                    if probe_reply(addr, shared.timings.probe_timeout) {
                        if let Ok(mut inner) = shared.inner.lock() {
                            inner.mode = DriverMode::External { addr };
                            inner.last_error = None;
                            inner.last_external = true;
                            inner.external_lost = false;
                        }
                        return DriverStatus::Running {
                            addr,
                            version: "external".to_string(),
                            port,
                        };
                    }
                }
            }
        }

        let Some(port) = chosen else {
            shared.set_last_error(Some(DriverFailure::LaunchFailed));
            return DriverStatus::Missing;
        };
        match self.launch_at(port) {
            Ok(()) => DriverStatus::Running {
                addr: SocketAddr::from(([127, 0, 0, 1], port)),
                version: shared.manifest().version.clone(),
                port,
            },
            Err(DriverFailure::Blocked) => DriverStatus::Blocked,
            Err(_) => DriverStatus::Missing,
        }
    }

    fn launch_at(&self, port: u16) -> Result<(), DriverFailure> {
        let shared = &self.shared;
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let side = side_by_side_executable(&shared.install_root);
        let mut child = match spawn_child(
            &shared.manifest(),
            &shared.install_root,
            port,
            side.as_deref(),
        ) {
            Ok(child) => child,
            Err(error) => {
                let failure = spawn_failure(&error);
                shared.set_last_error(Some(failure));
                return Err(failure);
            }
        };

        let started = Instant::now();
        loop {
            if probe_reply(addr, shared.timings.probe_timeout) {
                break;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let failure =
                        exit_failure(status, started.elapsed(), shared.timings.quick_exit);
                    shared.set_last_error(Some(failure));
                    return Err(failure);
                }
                Ok(None) => {}
                Err(_) => {
                    shared.set_last_error(Some(DriverFailure::LaunchFailed));
                    return Err(DriverFailure::LaunchFailed);
                }
            }
            if started.elapsed() >= shared.timings.handshake_timeout {
                let _ = child.kill();
                let _ = child.wait();
                shared.set_last_error(Some(DriverFailure::LaunchFailed));
                return Err(DriverFailure::LaunchFailed);
            }
            thread::sleep(shared.timings.handshake_poll);
        }

        let control = Arc::new(ProcessControl {
            child: Mutex::new(child),
            stop: AtomicBool::new(false),
            port,
            addr,
            started: Mutex::new(Instant::now()),
        });
        let supervisor = spawn_supervisor(Arc::clone(shared), Arc::clone(&control));
        {
            let mut inner = shared
                .inner
                .lock()
                .map_err(|_| DriverFailure::LaunchFailed)?;
            inner.mode = DriverMode::Managed {
                addr,
                port,
                version: shared.manifest().version.clone(),
            };
            inner.process = Some(ManagedProcess {
                control,
                supervisor,
            });
            inner.last_error = None;
            inner.gave_up = false;
            inner.last_external = false;
            inner.external_lost = false;
        }
        shared.emit(DriverEvent::Launched {
            addr,
            version: shared.manifest().version.clone(),
        });
        Ok(())
    }

    /// The managed child exited without us stopping it and the supervisor is
    /// still responsible for it (it has not given up).
    fn managed_exit_pending(&self) -> bool {
        let Ok(inner) = self.shared.inner.lock() else {
            return false;
        };
        !inner.gave_up
            && inner.process.as_ref().is_some_and(|process| {
                !process.control.stop.load(Ordering::Relaxed) && !process.control.alive()
            })
    }

    fn stop_managed(&self) {
        let process = self.shared.inner.lock().ok().and_then(|mut inner| {
            inner.mode = DriverMode::None;
            inner.process.take()
        });
        if let Some(process) = process {
            stop_process(process);
        }
    }

    fn installed_info(&self) -> (bool, Option<InstallMarker>, Option<PathBuf>) {
        let marker = InstallMarker::read(&self.shared.install_root);
        let managed = marker.as_ref().is_some_and(|value| {
            self.shared
                .manifest()
                .matches_marker(value, &self.shared.install_root)
        });
        if managed {
            return (true, marker, None);
        }
        let side = side_by_side_executable(&self.shared.install_root);
        (side.is_some(), marker, side)
    }

    /// Resolution order from PLAYER §4. `honor_external_lost` keeps the
    /// automatic rescans on the configured address after the user's own
    /// OpenRGB disappeared; only an explicit retry passes `false`.
    fn resolve(&self, honor_external_lost: bool) -> DriverStatus {
        let shared = &self.shared;

        // An existing managed child is ours even when it happens to listen on
        // the configured address; do not misclassify it as external.
        {
            let Ok(inner) = shared.inner.lock() else {
                return DriverStatus::Missing;
            };
            if let Some(process) = inner.process.as_ref() {
                if !process.control.stop.load(Ordering::Relaxed) && process.control.alive() {
                    if let DriverMode::Managed {
                        addr,
                        port,
                        version,
                    } = inner.mode.clone()
                    {
                        return DriverStatus::Running {
                            addr,
                            version,
                            port,
                        };
                    }
                } else {
                    // The supervisor owns the backoff/relaunch (and the
                    // give-up limit); do not start a second child here.
                    return DriverStatus::Missing;
                }
            }
        }

        if probe_reply(shared.configured_addr, shared.timings.probe_timeout) {
            if let Ok(mut inner) = shared.inner.lock() {
                inner.mode = DriverMode::External {
                    addr: shared.configured_addr,
                };
                inner.last_error = None;
                inner.last_external = true;
                inner.external_lost = false;
            }
            return DriverStatus::Running {
                addr: shared.configured_addr,
                version: "external".to_string(),
                port: shared.configured_addr.port(),
            };
        }

        let last_external = shared
            .inner
            .lock()
            .map(|inner| inner.last_external)
            .unwrap_or(false);
        if last_external {
            // The configured external server answered before and the probe
            // just failed: mark it lost and never steal its port automatically.
            if let Ok(mut inner) = shared.inner.lock() {
                inner.external_lost = true;
            }
            if honor_external_lost {
                return DriverStatus::Missing;
            }
        }

        let gave_up = shared
            .inner
            .lock()
            .map(|inner| inner.gave_up)
            .unwrap_or(false);
        if gave_up {
            return DriverStatus::Missing;
        }
        let (installed, _, _) = self.installed_info();
        if !installed {
            if let Ok(mut inner) = shared.inner.lock() {
                inner.mode = DriverMode::None;
            }
            return DriverStatus::Missing;
        }
        self.launch()
    }
}

impl Drop for ManagedDriver {
    fn drop(&mut self) {
        self.cancel_install();
        self.stop_managed();
    }
}

impl DriverProvider for ManagedDriver {
    fn status(&self) -> DriverStatus {
        self.resolve(true)
    }

    fn status_full(&self) -> DriverStatus {
        self.resolve(false)
    }

    fn set_manifest(&self, manifest: Manifest) -> bool {
        self.shared.set_manifest(manifest);
        true
    }

    fn install(&self) -> InstallResult {
        let shared = &self.shared;
        let manifest = shared.manifest();
        let cancel = self.cancel_flag();
        cancel.store(false, Ordering::SeqCst);
        shared.emit(DriverEvent::Progress(0));

        let Some(expected_sha) = manifest.sha256.clone() else {
            shared.set_last_error(Some(DriverFailure::Unverified));
            return InstallResult::Failed(DriverFailure::Unverified);
        };

        let download_dir = shared.install_root.join(".download");
        if fs::create_dir_all(&download_dir).is_err() {
            return install_failed(shared, DriverFailure::DownloadFailed);
        }
        let part = download_dir.join(format!("{expected_sha}.part"));

        let mut last_failure = DriverFailure::DownloadFailed;
        let mut verified = false;
        for url in &manifest.urls {
            if cancel.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&part);
                return InstallResult::Cancelled;
            }
            if !is_allowed_url(&url.url) {
                last_failure = DriverFailure::DownloadFailed;
                continue;
            }
            match download(shared, &url.url, &part, &expected_sha, &cancel) {
                Ok(()) => {
                    verified = true;
                    break;
                }
                Err(DownloadError::Cancelled) => {
                    let _ = fs::remove_file(&part);
                    return InstallResult::Cancelled;
                }
                Err(DownloadError::Checksum) => {
                    let _ = fs::remove_file(&part);
                    last_failure = DriverFailure::ChecksumMismatch;
                }
                Err(DownloadError::TooLarge) => {
                    let _ = fs::remove_file(&part);
                    last_failure = DriverFailure::DownloadFailed;
                }
                Err(DownloadError::Http | DownloadError::Io) => {
                    // Keep the verified-name part file: the next URL or the
                    // next install attempt resumes it with HTTP Range.
                    last_failure = DriverFailure::DownloadFailed;
                }
            }
        }

        if cancel.load(Ordering::SeqCst) {
            let _ = fs::remove_file(&part);
            return InstallResult::Cancelled;
        }
        if !verified {
            if last_failure != DriverFailure::DownloadFailed {
                let _ = fs::remove_file(&part);
            }
            return install_failed(shared, last_failure);
        }

        shared.emit(DriverEvent::Progress(100));
        if extract_zip(&part, &shared.install_root, &manifest).is_err() {
            let _ = fs::remove_file(&part);
            return install_failed(shared, DriverFailure::DownloadFailed);
        }
        let _ = fs::remove_file(&part);

        if let Err(error) = InstallMarker::write(
            &shared.install_root,
            &InstallMarker {
                schema: 1,
                variant: manifest.variant.as_str().to_string(),
                version: manifest.version.clone(),
                sha256: expected_sha,
                executable: manifest.executable.clone(),
            },
        ) {
            eprintln!("rgbprompt-player: cannot write installed.json: {error}");
            return install_failed(shared, DriverFailure::LaunchFailed);
        }

        shared.set_last_error(None);
        InstallResult::Installed
    }

    fn restart(&self) -> Result<(), DriverFailure> {
        // A managed child that already exited on its own is a crash. Leave it
        // to the supervisor, which counts it once (crash limit, backoff) and
        // respawns; killing and relaunching here would hide the crash.
        if self.managed_exit_pending() {
            return Ok(());
        }
        if let Ok(mut inner) = self.shared.inner.lock() {
            inner.gave_up = false;
            inner.external_lost = false;
        }
        self.stop_managed();
        match self.status_full() {
            DriverStatus::Running { .. } => Ok(()),
            DriverStatus::Blocked => Err(DriverFailure::Blocked),
            DriverStatus::Missing => Err(self
                .shared
                .inner
                .lock()
                .ok()
                .and_then(|inner| inner.last_error)
                .unwrap_or(DriverFailure::LaunchFailed)),
        }
    }

    fn restart_inherited_ours(&self) -> Result<(), DriverFailure> {
        if self.is_managed() {
            return self.restart();
        }
        let port = self.shared.configured_addr.port();
        if !kill_our_openrgb_on(port) {
            return Ok(());
        }
        if let Ok(mut inner) = self.shared.inner.lock() {
            inner.mode = DriverMode::None;
            inner.last_external = false;
            inner.external_lost = false;
            inner.gave_up = false;
            inner.last_error = None;
        }
        match self.status_full() {
            DriverStatus::Running { .. } => Ok(()),
            DriverStatus::Blocked => Err(DriverFailure::Blocked),
            DriverStatus::Missing => Err(DriverFailure::LaunchFailed),
        }
    }

    fn info(&self) -> DriverInfo {
        // Soft probe for Settings / shell status: if we have never recorded a
        // mode this session but an SDK server already answers on the
        // configured address, classify it as external. Matches resolve()'s
        // first step without launching a managed child.
        {
            let mode_none = self
                .shared
                .inner
                .lock()
                .map(|inner| matches!(inner.mode, DriverMode::None) && inner.process.is_none())
                .unwrap_or(false);
            if mode_none
                && probe_reply(
                    self.shared.configured_addr,
                    self.shared.timings.probe_timeout,
                )
            {
                if let Ok(mut inner) = self.shared.inner.lock() {
                    if matches!(inner.mode, DriverMode::None) && inner.process.is_none() {
                        inner.mode = DriverMode::External {
                            addr: self.shared.configured_addr,
                        };
                        inner.last_error = None;
                        inner.last_external = true;
                        inner.external_lost = false;
                    }
                }
            }
        }

        let manifest = self.shared.manifest();
        let (installed, marker, side_by_side) = self.installed_info();
        let (mode, port, supervision) = self
            .shared
            .inner
            .lock()
            .map(|inner| {
                let (mode, port) = match inner.mode.clone() {
                    DriverMode::None => ("none".to_string(), None),
                    DriverMode::External { addr } => ("external".to_string(), Some(addr.port())),
                    DriverMode::Managed { port, .. } => ("managed".to_string(), Some(port)),
                };
                let state = match inner.process.as_ref() {
                    Some(_) if inner.gave_up => "gaveUp",
                    Some(process) if process.control.stop.load(Ordering::Relaxed) => "none",
                    Some(process) if process.control.alive() => "running",
                    Some(_) => "restarting",
                    None if inner.gave_up => "gaveUp",
                    None if inner.external_lost => "externalLost",
                    None if mode == "external" => "running",
                    None => "none",
                };
                let supervision = SupervisionInfo {
                    state: state.to_string(),
                    crashes: inner.crash_times.len(),
                    crash_limit: self.shared.timings.crash_limit,
                    external: inner.last_external,
                };
                (mode, port, supervision)
            })
            .unwrap_or_else(|_| ("none".to_string(), None, SupervisionInfo::default()));
        let executable = if let Some(path) = side_by_side.as_ref() {
            Some(path.display().to_string())
        } else if marker.is_some() || installed {
            Some(
                manifest
                    .executable_path(&self.shared.install_root)
                    .display()
                    .to_string(),
            )
        } else {
            None
        };
        // A side-by-side app under ~/.rgbprompt is treated as verified so the
        // shell does not offer a download of an unpinned official build.
        let verified = manifest.sha256.is_some() || side_by_side.is_some();
        let install_dir = if let Some(path) = side_by_side.as_ref() {
            path.parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| {
                    manifest
                        .install_dir(&self.shared.install_root)
                        .display()
                        .to_string()
                })
        } else {
            manifest
                .install_dir(&self.shared.install_root)
                .display()
                .to_string()
        };
        DriverInfo {
            variant: manifest.variant.as_str().to_string(),
            version: manifest.version.clone(),
            size_bytes: manifest.size_bytes,
            install_dir,
            source: manifest.source.clone(),
            license: manifest.license.clone(),
            installed,
            mode,
            port,
            executable,
            verified,
            supervision,
        }
    }

    fn cancel_install(&self) {
        self.cancel_flag().store(true, Ordering::SeqCst);
    }

    fn set_event_sink(&self, sink: DriverEventSink) {
        if let Ok(mut slot) = self.shared.sink.lock() {
            *slot = Some(sink);
        }
    }

    fn is_managed(&self) -> bool {
        self.shared
            .inner
            .lock()
            .map(|inner| matches!(inner.mode, DriverMode::Managed { .. }))
            .unwrap_or(false)
    }

    fn last_error(&self) -> Option<DriverFailure> {
        self.shared
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.last_error)
    }

    fn installable(&self) -> bool {
        self.shared.manifest().sha256.is_some()
    }

    fn shutdown(&self) {
        self.cancel_install();
        self.stop_managed();
    }
}

fn install_failed(shared: &DriverShared, failure: DriverFailure) -> InstallResult {
    shared.set_last_error(Some(failure));
    InstallResult::Failed(failure)
}

#[derive(Debug)]
enum DownloadError {
    Http,
    Io,
    TooLarge,
    Checksum,
    Cancelled,
}

/// Bytes requested per HTTP Range call. Small enough that one chunk finishes
/// well inside [`CHUNK_DEADLINE`] on a slow cross-border link (~35 KiB/s).
const DOWNLOAD_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
/// Hard deadline for one ranged chunk. A stalled connection is abandoned here
/// and the same range is requested again; nothing already on disk is lost.
const CHUNK_DEADLINE: Duration = Duration::from_secs(60);
/// Deadline for a server that ignores `Range` and streams the whole file.
const FULL_BODY_DEADLINE: Duration = Duration::from_secs(30 * 60);
/// Consecutive failed attempts (no new bytes) before moving to the next URL.
const DOWNLOAD_ATTEMPTS: u32 = 5;

/// Downloads `url` into `part`, resuming from whatever `part` already holds.
///
/// The archive is fetched in [`DOWNLOAD_CHUNK_BYTES`] ranged requests so a
/// slow or flaky link (Codeberg / GitHub release CDNs from mainland China)
/// never trips a whole-download timeout: each chunk has its own deadline, a
/// failed chunk is retried with backoff, and the attempt counter resets
/// whenever bytes arrive. A server that ignores `Range` (HTTP 200) is read
/// in one stream instead. The SHA-256 is computed over the finished file.
/// On `Http` / `Io` errors the partial file is kept so the next URL or the
/// next install attempt resumes; callers delete it on checksum or cancel.
fn download(
    shared: &DriverShared,
    url: &str,
    part: &Path,
    expected_sha: &str,
    cancel: &AtomicBool,
) -> Result<(), DownloadError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .proxy(None)
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .build()
        .into();
    let expected_size = shared.manifest().size_bytes;
    let cap = if expected_size > 0 {
        expected_size + DOWNLOAD_SLACK_BYTES
    } else {
        256 * 1024 * 1024
    };
    // Not `append(true)`: on Windows an append-only handle lacks
    // FILE_WRITE_DATA, so `set_len` (restart from 0) fails. Writes seek to
    // their offset instead.
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(part)
        .map_err(|_| DownloadError::Io)?;
    let mut have = file.metadata().map_err(|_| DownloadError::Io)?.len();
    if expected_size > 0 && have > expected_size {
        file.set_len(0).map_err(|_| DownloadError::Io)?;
        have = 0;
    }
    let mut total_size: Option<u64> = (expected_size > 0).then_some(expected_size);
    let mut last_percent = -1i32;
    let mut failures = 0u32;
    let mut last_error: DownloadError;

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        if total_size.is_some_and(|size| have >= size) {
            break;
        }
        emit_progress(shared, have, total_size, &mut last_percent);

        let end = have + DOWNLOAD_CHUNK_BYTES - 1;
        let end = total_size.map_or(end, |size| end.min(size - 1));
        let outcome = fetch_chunk(&agent, url, have, end, &mut file, cap, cancel);
        match outcome {
            Ok(Chunk::Partial { written, total }) => {
                // The manifest size wins; the server total only fills a gap.
                total_size = total_size.or(total);
                if written > 0 {
                    have += written;
                    failures = 0;
                    continue;
                }
                last_error = DownloadError::Io;
            }
            Ok(Chunk::Whole { written }) => {
                have = written;
                total_size = Some(written);
                break;
            }
            Ok(Chunk::RangeNotSatisfiable) => {
                // The part file is at or past the end; let the hash decide.
                if have > 0 && total_size.is_none() {
                    total_size = Some(have);
                    break;
                }
                file.set_len(0).map_err(|_| DownloadError::Io)?;
                have = 0;
                last_error = DownloadError::Http;
            }
            Err(DownloadError::Io) => {
                // A stalled or dropped chunk may have appended some bytes.
                let now = file.metadata().map_err(|_| DownloadError::Io)?.len();
                if now > have {
                    have = now;
                    failures = 0;
                    continue;
                }
                last_error = DownloadError::Io;
            }
            Err(error @ (DownloadError::Cancelled | DownloadError::TooLarge)) => return Err(error),
            Err(error) => last_error = error,
        }
        failures += 1;
        if matches!(last_error, DownloadError::Http) || failures >= DOWNLOAD_ATTEMPTS {
            return Err(last_error);
        }
        let delay = shared.timings.download_retry * (1u32 << (failures - 1).min(4));
        if !sleep_unless_cancelled(delay, cancel) {
            return Err(DownloadError::Cancelled);
        }
    }
    file.flush().map_err(|_| DownloadError::Io)?;
    drop(file);
    emit_progress(shared, have, total_size, &mut last_percent);

    let digest = sha256_file(part).map_err(|_| DownloadError::Io)?;
    if digest != expected_sha.to_lowercase() {
        return Err(DownloadError::Checksum);
    }
    Ok(())
}

enum Chunk {
    /// HTTP 206: `written` bytes appended; `total` from `Content-Range`.
    Partial { written: u64, total: Option<u64> },
    /// HTTP 200: the server ignored `Range`; the file now holds the whole body.
    Whole { written: u64 },
    /// HTTP 416.
    RangeNotSatisfiable,
}

fn fetch_chunk(
    agent: &ureq::Agent,
    url: &str,
    start: u64,
    end: u64,
    file: &mut File,
    cap: u64,
    cancel: &AtomicBool,
) -> Result<Chunk, DownloadError> {
    let mut response = agent
        .get(url)
        .header("Range", &format!("bytes={start}-{end}"))
        .config()
        .timeout_global(Some(CHUNK_DEADLINE))
        .build()
        .call()
        .map_err(|_| DownloadError::Io)?;
    let status = response.status().as_u16();
    match status {
        206 => {
            let total = response
                .headers()
                .get("content-range")
                .and_then(|value| value.to_str().ok())
                .and_then(parse_content_range_total);
            let written = copy_body(response.body_mut().as_reader(), file, start, cap, cancel)?;
            Ok(Chunk::Partial { written, total })
        }
        200 => {
            // No range support: re-request without a per-chunk deadline and
            // stream from byte 0.
            drop(response);
            let mut response = agent
                .get(url)
                .config()
                .timeout_global(Some(FULL_BODY_DEADLINE))
                .build()
                .call()
                .map_err(|_| DownloadError::Io)?;
            if response.status().as_u16() != 200 {
                return Err(DownloadError::Http);
            }
            file.set_len(0).map_err(|_| DownloadError::Io)?;
            let written = copy_body(response.body_mut().as_reader(), file, 0, cap, cancel)?;
            Ok(Chunk::Whole { written })
        }
        416 => Ok(Chunk::RangeNotSatisfiable),
        408 | 429 | 500..=599 => Err(DownloadError::Io),
        _ => Err(DownloadError::Http),
    }
}

fn copy_body(
    mut reader: impl Read,
    file: &mut File,
    offset: u64,
    cap: u64,
    cancel: &AtomicBool,
) -> Result<u64, DownloadError> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| DownloadError::Io)?;
    let mut buffer = [0u8; 64 * 1024];
    let mut written = 0u64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(DownloadError::Cancelled);
        }
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) if written > 0 => break,
            Err(_) => return Err(DownloadError::Io),
        };
        if offset + written + read as u64 > cap {
            return Err(DownloadError::TooLarge);
        }
        file.write_all(&buffer[..read])
            .map_err(|_| DownloadError::Io)?;
        written += read as u64;
    }
    Ok(written)
}

/// `bytes 0-1023/22019605` → `22019605`; `*` totals are unknown.
fn parse_content_range_total(value: &str) -> Option<u64> {
    value.rsplit_once('/')?.1.trim().parse().ok()
}

fn emit_progress(shared: &DriverShared, have: u64, total: Option<u64>, last: &mut i32) {
    let Some(total) = total.filter(|total| *total > 0) else {
        return;
    };
    let percent = (have.saturating_mul(100) / total).min(99) as i32;
    if percent != *last {
        *last = percent;
        shared.emit(DriverEvent::Progress(percent));
    }
}

fn sleep_unless_cancelled(duration: Duration, cancel: &AtomicBool) -> bool {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        thread::sleep(Duration::from_millis(20).min(duration));
    }
    !cancel.load(Ordering::SeqCst)
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

fn extract_zip(part: &Path, install_root: &Path, manifest: &Manifest) -> Result<(), String> {
    let staging = install_root.join(format!(".staging-{}", random_suffix()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;

    let result = (|| -> Result<(), String> {
        let file = File::open(part).map_err(|error| error.to_string())?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|error| format!("zip open: {error}"))?;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("zip entry {index}: {error}"))?;
            let Some(relative) = entry.enclosed_name() else {
                return Err(format!("zip entry {:?} escapes the archive", entry.name()));
            };
            if relative.is_absolute()
                || relative.components().any(|component| {
                    matches!(
                        component,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                })
            {
                return Err(format!("zip entry {:?} is an unsafe path", entry.name()));
            }
            if let Some(mode) = entry.unix_mode() {
                if mode & 0o170000 == 0o120000 {
                    return Err(format!("zip entry {:?} is a symlink", entry.name()));
                }
            }
            let target = staging.join(&relative);
            if entry.is_dir() {
                fs::create_dir_all(&target).map_err(|error| error.to_string())?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut output = File::create(&target).map_err(|error| error.to_string())?;
            io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            if let Some(mode) = entry.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o777));
            }
        }
        if !staging.join(&manifest.executable).is_file() {
            return Err(format!(
                "archive does not contain the executable {}",
                manifest.executable
            ));
        }
        Ok(())
    })();

    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let target = manifest.install_dir(install_root);
    let _ = fs::remove_dir_all(&target);
    fs::rename(&staging, &target).map_err(|error| {
        let _ = fs::remove_dir_all(&staging);
        error.to_string()
    })
}

fn spawn_child(
    manifest: &Manifest,
    install_root: &Path,
    port: u16,
    override_executable: Option<&Path>,
) -> io::Result<Child> {
    let managed = manifest.executable_path(install_root);
    let executable = override_executable.unwrap_or(managed.as_path());
    let config_dir = install_root.join("config");
    let _ = fs::create_dir_all(&config_dir);
    let port = port.to_string();
    let config = config_dir.display().to_string();
    // Side-by-side apps use the same server flags; skip --config when the
    // override binary lives outside the managed install tree.
    let args: Vec<String> = if override_executable.is_some() {
        vec![
            "--server".to_string(),
            "--server-port".to_string(),
            port.clone(),
        ]
    } else {
        manifest
            .args
            .iter()
            .map(|arg| {
                arg.replace("{port}", &port)
                    .replace("{config_dir}", &config)
            })
            .collect()
    };

    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let log_path = install_root.join("openrgb.log");
    let sink = Arc::new(LogSink::new(log_path, LOG_CAP_BYTES));
    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(stdout, Arc::clone(&sink));
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(stderr, sink);
    }
    Ok(child)
}

struct LogSink {
    path: PathBuf,
    written: Mutex<u64>,
    cap: u64,
}

impl LogSink {
    fn new(path: PathBuf, cap: u64) -> Self {
        let _ = fs::remove_file(&path);
        Self {
            path,
            written: Mutex::new(0),
            cap,
        }
    }

    fn write(&self, bytes: &[u8]) {
        let Ok(mut written) = self.written.lock() else {
            return;
        };
        if *written >= self.cap {
            return;
        }
        let take = ((self.cap - *written) as usize).min(bytes.len());
        if take == 0 {
            return;
        }
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            if file.write_all(&bytes[..take]).is_ok() {
                *written += take as u64;
            }
        }
    }
}

fn spawn_log_reader(mut reader: impl Read + Send + 'static, sink: Arc<LogSink>) {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => sink.write(&buffer[..count]),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
}

fn spawn_supervisor(shared: Arc<DriverShared>, control: Arc<ProcessControl>) -> JoinHandle<()> {
    thread::spawn(move || {
        let timings = shared.timings.clone();
        loop {
            thread::sleep(timings.supervisor_poll);
            if control.stop.load(Ordering::Relaxed) {
                break;
            }
            let exited = {
                let Ok(mut child) = control.child.lock() else {
                    break;
                };
                child.try_wait().ok().flatten()
            };
            let Some(status) = exited else {
                continue;
            };
            if control.stop.load(Ordering::Relaxed) {
                break;
            }
            let elapsed = control
                .started
                .lock()
                .map(|started| started.elapsed())
                .unwrap_or(Duration::ZERO);
            if is_blocked_exit(status, elapsed, timings.quick_exit) {
                if let Ok(mut inner) = shared.inner.lock() {
                    inner.gave_up = true;
                    inner.last_error = Some(DriverFailure::Blocked);
                }
                shared.emit(DriverEvent::Blocked);
                break;
            }
            let count = record_crash(&shared, &timings);
            shared.emit(DriverEvent::Crashed);
            if count > timings.crash_limit {
                if let Ok(mut inner) = shared.inner.lock() {
                    inner.gave_up = true;
                }
                shared.emit(DriverEvent::GaveUp);
                break;
            }
            let backoff = timings.backoff[(count.saturating_sub(1)).min(2)];
            if !sleep_interruptible(&control, backoff) {
                break;
            }
            if control.stop.load(Ordering::Relaxed) {
                break;
            }
            match respawn(&shared, &control) {
                Ok(()) => shared.emit(DriverEvent::Launched {
                    addr: control.addr,
                    version: shared.manifest().version.clone(),
                }),
                Err(_) => {
                    // The next loop iteration sees the dead child and counts
                    // another crash, so a permanently broken executable
                    // eventually gives up.
                    continue;
                }
            }
        }
    })
}

fn record_crash(shared: &DriverShared, timings: &DriverTimings) -> usize {
    let Ok(mut inner) = shared.inner.lock() else {
        return timings.crash_limit + 1;
    };
    let now = Instant::now();
    while let Some(first) = inner.crash_times.front() {
        if now.duration_since(*first) > timings.crash_window {
            inner.crash_times.pop_front();
        } else {
            break;
        }
    }
    inner.crash_times.push_back(now);
    inner.crash_times.len()
}

fn sleep_interruptible(control: &ProcessControl, duration: Duration) -> bool {
    let until = Instant::now() + duration;
    while Instant::now() < until {
        if control.stop.load(Ordering::Relaxed) {
            return false;
        }
        thread::sleep(Duration::from_millis(20).min(until - Instant::now()));
    }
    !control.stop.load(Ordering::Relaxed)
}

fn respawn(shared: &DriverShared, control: &ProcessControl) -> Result<(), DriverFailure> {
    let child = spawn_child(
        &shared.manifest(),
        &shared.install_root,
        control.port,
        side_by_side_executable(&shared.install_root).as_deref(),
    )
    .map_err(|error| spawn_failure(&error))?;
    {
        let Ok(mut slot) = control.child.lock() else {
            return Err(DriverFailure::LaunchFailed);
        };
        *slot = child;
    }
    if let Ok(mut started) = control.started.lock() {
        *started = Instant::now();
    }
    let started = Instant::now();
    loop {
        if control.stop.load(Ordering::Relaxed) {
            return Err(DriverFailure::LaunchFailed);
        }
        if probe_reply(control.addr, shared.timings.probe_timeout) {
            return Ok(());
        }
        if !control.alive() {
            return Err(DriverFailure::LaunchFailed);
        }
        if started.elapsed() >= shared.timings.handshake_timeout {
            let Ok(mut child) = control.child.lock() else {
                return Err(DriverFailure::LaunchFailed);
            };
            let _ = child.kill();
            let _ = child.wait();
            return Err(DriverFailure::LaunchFailed);
        }
        thread::sleep(shared.timings.handshake_poll);
    }
}

fn stop_process(process: ManagedProcess) {
    process.control.stop.store(true, Ordering::SeqCst);
    {
        let Ok(mut child) = process.control.child.lock() else {
            let _ = process.supervisor.join();
            return;
        };
        let _ = child.kill();
        let _ = child.wait();
    }
    let _ = process.supervisor.join();
}

fn spawn_failure(error: &io::Error) -> DriverFailure {
    if cfg!(target_os = "macos") && error.kind() == io::ErrorKind::PermissionDenied {
        DriverFailure::Blocked
    } else {
        DriverFailure::LaunchFailed
    }
}

#[cfg(unix)]
fn exit_failure(
    status: std::process::ExitStatus,
    elapsed: Duration,
    quick_exit: Duration,
) -> DriverFailure {
    use std::os::unix::process::ExitStatusExt;
    if cfg!(target_os = "macos") && elapsed <= quick_exit && status.signal() == Some(9) {
        DriverFailure::Blocked
    } else {
        DriverFailure::LaunchFailed
    }
}

#[cfg(not(unix))]
fn exit_failure(
    _status: std::process::ExitStatus,
    _elapsed: Duration,
    _quick_exit: Duration,
) -> DriverFailure {
    DriverFailure::LaunchFailed
}

#[cfg(unix)]
fn is_blocked_exit(
    status: std::process::ExitStatus,
    elapsed: Duration,
    quick_exit: Duration,
) -> bool {
    use std::os::unix::process::ExitStatusExt;
    cfg!(target_os = "macos") && elapsed <= quick_exit && status.signal() == Some(9)
}

#[cfg(not(unix))]
fn is_blocked_exit(
    _status: std::process::ExitStatus,
    _elapsed: Duration,
    _quick_exit: Duration,
) -> bool {
    false
}

fn probe_reply(addr: SocketAddr, timeout: Duration) -> bool {
    // Stricter probe for port selection: an unrelated listener accepts the
    // connection but never answers `REQUEST_PROTOCOL_VERSION`.
    let timeout = timeout.min(Duration::from_millis(500));
    OpenRGBClient::connect(addr, "RGBPrompt Probe", timeout)
        .map(|client| client.answered())
        .unwrap_or(false)
}

fn random_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", std::process::id(), nanos, counter)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_json(sha256: &str, urls: &str) -> String {
        format!(
            r#"{{
                "schema": 1,
                "variant": "standard",
                "version": "1.0",
                "platform": "macos",
                "arch": "arm64",
                "archive": "zip",
                "size_bytes": 10,
                "sha256": {sha256},
                "executable": "OpenRGB",
                "args": ["--server", "--server-port", "{{port}}"],
                "urls": {urls},
                "license": "GPL-2.0-only",
                "source": "https://openrgb.org"
            }}"#
        )
    }

    /// Marker in the Windows manifest URLs until the patched OpenRGB release
    /// exists under github.com/rgbprompt-lib. Replace the tag, then fill in
    /// the measured `sha256` / `size_bytes` (both stay fail-closed until then).
    const WINDOWS_RELEASE_PLACEHOLDER: &str = "PLACEHOLDER-";

    #[test]
    fn parses_the_embedded_manifests() {
        for json in [EMBEDDED_MACOS_MANIFEST, EMBEDDED_WINDOWS_MANIFEST] {
            let manifest = Manifest::from_json(json).expect("manifest");
            assert_eq!(manifest.schema, 1);
            if manifest.platform == "windows" {
                // Windows installs the patched (K552 EVision Direct) build
                // from rgbprompt-lib GitHub Releases. A CDN mirror is optional:
                // list one only once the object really exists.
                assert_eq!(manifest.variant, ManifestVariant::Tuned);
                assert_eq!(manifest.urls[0].kind, "official");
                assert!(manifest.urls[0]
                    .url
                    .starts_with("https://github.com/rgbprompt-lib/"));
                let placeholder = manifest
                    .urls
                    .iter()
                    .any(|url| url.url.contains(WINDOWS_RELEASE_PLACEHOLDER));
                if placeholder {
                    assert!(
                        manifest.sha256.is_none() && manifest.size_bytes == 0,
                        "a placeholder release must stay fail-closed"
                    );
                } else {
                    assert!(manifest.size_bytes > 0);
                    assert!(manifest.sha256.as_ref().is_some_and(|sha| sha.len() == 64));
                }
            } else {
                assert_eq!(manifest.variant, ManifestVariant::Standard);
                // macOS stays fail-closed until its official archive is hashed.
                assert!(manifest.sha256.is_none(), "macOS shipped manifest stays fail-closed");
            }
        }
    }

    #[test]
    fn parses_content_range_totals() {
        assert_eq!(
            parse_content_range_total("bytes 0-1023/22019605"),
            Some(22019605)
        );
        assert_eq!(parse_content_range_total("bytes 0-1023/*"), None);
        assert_eq!(parse_content_range_total("garbage"), None);
    }

    #[test]
    fn rejects_unknown_fields_and_insecure_urls() {
        let json = manifest_json(
            "null",
            r#"[{ "kind": "official", "url": "http://example.com/openrgb.zip" }]"#,
        );
        assert!(Manifest::from_json(&json).is_err());

        let json = manifest_json(
            "null",
            r#"[{ "kind": "official", "url": "http://127.0.0.1:1/openrgb.zip" }]"#,
        );
        assert!(Manifest::from_json(&json).is_ok());

        let json = manifest_json("null", r#"[]"#);
        assert!(Manifest::from_json(&json).is_err());

        let mut value: serde_json::Value = serde_json::from_str(&manifest_json(
            "null",
            r#"[{ "kind": "official", "url": "https://example.com/a.zip" }]"#,
        ))
        .unwrap();
        value["unexpected"] = serde_json::json!(true);
        assert!(Manifest::from_json(&value.to_string()).is_err());
    }

    #[test]
    fn install_fails_closed_without_a_hash() {
        let install_root =
            std::env::temp_dir().join(format!("rgbprompt-driver-unverified-{}", random_suffix()));
        let json = manifest_json(
            "null",
            r#"[{ "kind": "official", "url": "http://127.0.0.1:1/a.zip" }]"#,
        );
        let driver = ManagedDriver::with_manifest(
            "127.0.0.1:9".parse().unwrap(),
            install_root.clone(),
            Manifest::from_json(&json).unwrap(),
            DriverTimings::default(),
        );
        assert_eq!(
            driver.install(),
            InstallResult::Failed(DriverFailure::Unverified)
        );
        assert!(!install_root.join("installed.json").exists());
        let _ = fs::remove_dir_all(&install_root);
    }
}

/// If the process listening on `port` is our patched OpenRGB, terminate it.
/// Returns true when a process was killed so the caller can relaunch.
fn kill_our_openrgb_on(port: u16) -> bool {
    let Some((pid, path)) = listener_on(port) else {
        return false;
    };
    let text = path.to_string_lossy();
    if !text.contains("OpenRGB-RGBPrompt.app") {
        return false;
    }
    terminate_pid(pid)
}

fn listener_on(port: u16) -> Option<(u32, PathBuf)> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let pid: u32 = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.trim().parse().ok())?;
    Some((pid, process_path(pid)?))
}

fn process_path(pid: u32) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        macos_pid_path(pid)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pid;
        None
    }
}

#[cfg(target_os = "macos")]
fn macos_pid_path(pid: u32) -> Option<PathBuf> {
    let mut buf = [0i8; 4096];
    // Safety: proc_pidpath writes at most buf.len() bytes into buf.
    let n = unsafe { proc_pidpath(pid as i32, buf.as_mut_ptr(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, n as usize) };
    let text = std::str::from_utf8(bytes).ok()?;
    Some(PathBuf::from(text))
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut i8, buffersize: u32) -> i32;
}

fn terminate_pid(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe {
            libc_kill(pid as i32, 15);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if unsafe { libc_kill(pid as i32, 0) } != 0 {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc_kill(pid as i32, 9);
        }
        thread::sleep(Duration::from_millis(100));
        true
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

#[cfg(unix)]
unsafe extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}
