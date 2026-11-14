//! `PlayerService`: the control-thread state machine (PLAYER §6).
//!
//! The C ABI only sends commands over a channel and returns immediately. The
//! control thread orchestrates redeem, driver, device detection and playback,
//! emits state snapshots and acks the play token at most once per
//! (token, result) transition. Failure recovery (PLAYER §5, §8) keeps the
//! prepared effect across device and backend failures and retries on the
//! watcher tick.
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::audio::{AudioAnalyzer, AudioRing};
use crate::bundle::ENGINE_PACKAGE_VERSION;
use crate::clock::{SystemClock, WallClock};
use crate::conflict::{ConflictDetector, ProcessLister, SysinfoLister};
use crate::device_health::{KeyboardAttachedProbe, LocationLiveProbe};
use crate::diagnostics::{
    build_json, DeviceDiagnostic, DiagnosticsStore, DiagnosticsView, OpenRgbDiagnostic,
};
use crate::driver::{DriverEvent, DriverFailure, DriverProvider, DriverStatus, InstallResult};
use crate::engine_host::{EngineHost, HostError, HostLimits};
use crate::layout::{detect, DeviceDb, Mapping, Support};
use crate::log::LocalLog;
use crate::model::{support_str, FailureCode, PlayKeyboard, PlayResult, PlayerState};
use crate::openrgb::{ControllerData, DirectSession, OpenRGBClient};
use crate::playback::{
    KeyQueue, PlaybackEvent, PlaybackFailure, PlaybackSetup, PlaybackState, PreviewFrame, FPS_HIGH,
};
use crate::protocol::{parse_player_url, ParsedPlayerUrl};
use crate::token::{AckBody, Redeemed, TokenClient, TokenError, MAX_LEP_BYTES};
use crate::watcher::DeviceWatcher;

const REDEEM_TIMEOUT: Duration = Duration::from_millis(800);
/// The server accepts acks for 30 minutes after redemption
/// (`PLAYER_ACK_WINDOW_MS`). Used when redeem itself fails after the server
/// already consumed the token.
const ACK_WINDOW_MS: u64 = 30 * 60 * 1000;
const DEVICE_TYPE_KEYBOARD: i32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ControllerHealth {
    Live,
    Stale,
    Gone,
    Unreachable,
}

#[derive(Clone, Debug)]
pub struct PlayerConfig {
    pub data_dir: PathBuf,
    pub api_base: String,
    pub platform: String,
    pub language: String,
    pub app_version: String,
    pub os_version: String,
    pub openrgb_addr: SocketAddr,
}

#[derive(Clone, Debug, Default)]
pub struct ServiceOptions {
    pub watch_interval: Duration,
    pub rescan_debounce: Duration,
    pub managed_restart_cooldown: Duration,
    pub location_live: LocationLiveProbe,
    pub keyboard_attached: KeyboardAttachedProbe,
}

impl ServiceOptions {
    pub fn production() -> Self {
        Self {
            watch_interval: Duration::from_secs(2),
            rescan_debounce: Duration::from_millis(500),
            managed_restart_cooldown: Duration::from_secs(30),
            location_live: LocationLiveProbe::default(),
            keyboard_attached: KeyboardAttachedProbe::default(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct StateSnapshot {
    pub state: PlayerState,
    pub error: i32,
    pub effect_name: Option<String>,
    pub keyboard_name: Option<String>,
    pub keyboard_support: Option<Support>,
    pub fps: u32,
    pub driver_progress: i32,
    pub driver_error: i32,
    pub conflict_name: Option<String>,
}

impl Default for StateSnapshot {
    fn default() -> Self {
        Self {
            state: PlayerState::Idle,
            error: 0,
            effect_name: None,
            keyboard_name: None,
            keyboard_support: None,
            fps: FPS_HIGH,
            driver_progress: -1,
            driver_error: 0,
            conflict_name: None,
        }
    }
}

pub type StateCallback = Box<dyn Fn(&StateSnapshot) + Send + Sync>;

pub struct PlayerShared {
    pub config: PlayerConfig,
    pub preview: Arc<PreviewFrame>,
    pub keys: Arc<KeyQueue>,
    pub audio: Arc<AudioRing>,
    pub diagnostics: Mutex<DiagnosticsStore>,
    pub protocol_registered: AtomicBool,
    pub audio_enabled: AtomicBool,
    pub key_enabled: AtomicBool,
    pub brightness: Arc<AtomicU32>,
    pub wants_audio: AtomicBool,
    pub wants_keys: AtomicBool,
    pub fps: Arc<AtomicU32>,
    pub unknown_keys: AtomicU64,
    pub language: Mutex<String>,
    state: Mutex<Option<StateSnapshot>>,
    callback: Mutex<Option<StateCallback>>,
    openrgb: Mutex<Option<OpenRgbDiagnostic>>,
    key_cells: RwLock<HashMap<String, String>>,
    log: Mutex<Option<LocalLog>>,
    /// Explicit user pick (OpenRGB controller name). `None` = first supported.
    pub preferred_keyboard: Mutex<Option<String>>,
}

impl PlayerShared {
    pub fn new(config: PlayerConfig) -> Arc<Self> {
        let language = config.language.clone();
        let log = LocalLog::open(&config.data_dir.join("logs"));
        Arc::new(Self {
            config,
            preview: PreviewFrame::new(),
            keys: KeyQueue::new(),
            audio: AudioRing::new(),
            diagnostics: Mutex::new(DiagnosticsStore::new()),
            protocol_registered: AtomicBool::new(false),
            audio_enabled: AtomicBool::new(true),
            key_enabled: AtomicBool::new(true),
            brightness: Arc::new(AtomicU32::new(100)),
            wants_audio: AtomicBool::new(false),
            wants_keys: AtomicBool::new(false),
            fps: Arc::new(AtomicU32::new(FPS_HIGH)),
            unknown_keys: AtomicU64::new(0),
            language: Mutex::new(language),
            state: Mutex::new(None),
            callback: Mutex::new(None),
            openrgb: Mutex::new(None),
            key_cells: RwLock::new(HashMap::new()),
            log: Mutex::new(log),
            preferred_keyboard: Mutex::new(None),
        })
    }

    pub fn preferred_keyboard(&self) -> Option<String> {
        self.preferred_keyboard
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    pub fn set_preferred_keyboard(&self, name: Option<String>) {
        if let Ok(mut slot) = self.preferred_keyboard.lock() {
            *slot = name.and_then(|value| {
                let trimmed = value.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            });
        }
    }

    pub fn input_wanted(&self) -> u32 {
        let audio =
            self.wants_audio.load(Ordering::Relaxed) && self.audio_enabled.load(Ordering::Relaxed);
        let keys =
            self.wants_keys.load(Ordering::Relaxed) && self.key_enabled.load(Ordering::Relaxed);
        u32::from(audio) | (u32::from(keys) << 1)
    }

    pub fn set_state_callback(&self, callback: Option<StateCallback>) {
        *self.callback.lock().expect("state callback") = callback;
    }

    pub fn set_key_cells(&self, cells: Vec<(String, String)>) {
        let mut map = self.key_cells.write().expect("key cells");
        map.clear();
        for (name, cell) in cells {
            map.insert(name, cell);
        }
    }

    pub fn key_cell(&self, name: &str) -> Option<String> {
        self.key_cells.read().expect("key cells").get(name).cloned()
    }

    pub fn set_openrgb(&self, openrgb: Option<OpenRgbDiagnostic>) {
        *self.openrgb.lock().expect("openrgb diagnostics") = openrgb;
    }

    pub fn add_error(&self, at: u64, code: &str) {
        self.diagnostics
            .lock()
            .expect("diagnostics")
            .add_error(at, code);
    }

    pub fn set_devices(&self, devices: Vec<DeviceDiagnostic>) {
        self.diagnostics
            .lock()
            .expect("diagnostics")
            .set_devices(devices);
    }

    pub fn log_line(&self, line: &str) {
        if let Ok(log) = self.log.lock() {
            if let Some(log) = log.as_ref() {
                log.write_line(line);
            }
        }
    }

    pub fn log_path(&self) -> Option<PathBuf> {
        self.log
            .lock()
            .ok()
            .and_then(|log| log.as_ref().map(|log| log.path().to_path_buf()))
    }

    pub fn diagnostics_json(&self) -> String {
        let store = self.diagnostics.lock().expect("diagnostics");
        let openrgb = self.openrgb.lock().expect("openrgb diagnostics").clone();
        build_json(&DiagnosticsView {
            player_version: &self.config.app_version,
            platform: &self.config.platform,
            os_version: &self.config.os_version,
            protocol_registered: self.protocol_registered.load(Ordering::Relaxed),
            openrgb,
            store: &store,
        })
    }

    pub fn publish(&self, snapshot: StateSnapshot) {
        *self.state.lock().expect("state") = Some(snapshot.clone());
        if let Some(callback) = self.callback.lock().expect("state callback").as_ref() {
            callback(&snapshot);
        }
    }

    pub fn current_state(&self) -> Option<StateSnapshot> {
        self.state.lock().expect("state").clone()
    }
}

#[derive(Debug)]
pub enum ServiceCommand {
    OpenUrl(String),
    OpenLepFile(PathBuf),
    Stop,
    Retry,
    InstallDriver,
    RestartBackend,
    WatchTick,
    DevicesChanged,
    SetBrightness(u8),
    SetLanguage(String),
    SetAudioEnabled(bool),
    SetKeyReactiveEnabled(bool),
    SetProtocolRegistered(bool),
    /// Prefer this OpenRGB controller name for playback (explicit user pick).
    SelectKeyboard(String),
    Shutdown,
    Redeemed {
        generation: u64,
        outcome: Result<Redeemed, TokenError>,
        api_base: String,
    },
    Playback {
        generation: u64,
        event: PlaybackEvent,
    },
    DriverEvent(DriverEvent),
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("engine error: {0}")]
    Engine(String),
    #[error("token client: {0}")]
    Token(#[from] TokenError),
}

pub struct PlayerHandle {
    pub shared: Arc<PlayerShared>,
    pub commands: mpsc::Sender<ServiceCommand>,
    join: Option<JoinHandle<()>>,
}

impl PlayerHandle {
    pub fn send(&self, command: ServiceCommand) -> bool {
        self.commands.send(command).is_ok()
    }

    pub fn shutdown(&mut self) {
        let _ = self.commands.send(ServiceCommand::Shutdown);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Phase {
    Redeemed,
    NeedsDriver,
    NoKeyboard,
}

struct PreparedPlay {
    lep: Vec<u8>,
    phase: Phase,
}

struct AckContext {
    token: String,
    deadline: i64,
    api_base: String,
}

struct AckJob {
    token: String,
    body: AckBody,
    deadline: i64,
    api_base: String,
}

/// Waits between ack attempts. A failed ack leaves the web page waiting, so a
/// transient network or 5xx error is retried a few times inside the server's
/// ack window before giving up.
const ACK_RETRY_DELAYS_MS: [u64; 4] = [500, 1_000, 2_000, 4_000];

/// One long-lived worker per service so acks leave in FIFO order. Acking from
/// per-call threads could reorder `needs_driver` / `playing` on the wire, and
/// the server keeps the last result.
struct AckWorker {
    sender: Option<mpsc::Sender<AckJob>>,
    join: Option<JoinHandle<()>>,
}

impl AckWorker {
    fn spawn(token: TokenClient, shared: Arc<PlayerShared>, wall: Arc<dyn WallClock>) -> Self {
        let (sender, receiver) = mpsc::channel::<AckJob>();
        let join = thread::spawn(move || {
            let mut queue: VecDeque<AckJob> = VecDeque::new();
            // Once the service shuts down, queued acks still get one attempt
            // each, but nothing waits for a retry.
            let mut closing = false;
            loop {
                let job = match queue.pop_front() {
                    Some(job) => job,
                    None if closing => return,
                    None => match receiver.recv() {
                        Ok(job) => job,
                        Err(_) => return,
                    },
                };
                let mut attempt = 0usize;
                loop {
                    let client = match token.with_api_base(&job.api_base) {
                        Ok(client) => client,
                        Err(error) => {
                            shared.add_error(wall.unix_ms(), "ack_failed");
                            let _ = error;
                            break;
                        }
                    };
                    let error = match client.ack(&job.token, job.body.clone()) {
                        Ok(()) => break,
                        Err(error) => error,
                    };
                    let retryable =
                        !matches!(error, TokenError::NotFound | TokenError::InsecureBase);
                    let delay = match &error {
                        TokenError::RateLimited {
                            retry_after: Some(seconds),
                        } => seconds.saturating_mul(1_000),
                        _ => ACK_RETRY_DELAYS_MS.get(attempt).copied().unwrap_or(0),
                    };
                    let past_deadline = wall.unix_ms() as i64 + delay as i64 > job.deadline;
                    if closing
                        || !retryable
                        || attempt >= ACK_RETRY_DELAYS_MS.len()
                        || past_deadline
                    {
                        shared.add_error(wall.unix_ms(), "ack_failed");
                        break;
                    }
                    attempt += 1;
                    if !wait_queueing(&receiver, &mut queue, Duration::from_millis(delay)) {
                        closing = true;
                        shared.add_error(wall.unix_ms(), "ack_failed");
                        break;
                    }
                }
            }
        });
        Self {
            sender: Some(sender),
            join: Some(join),
        }
    }

    fn send(&self, token: String, body: AckBody, deadline: i64, api_base: String) {
        if let Some(sender) = &self.sender {
            let _ = sender.send(AckJob {
                token,
                body,
                deadline,
                api_base,
            });
        }
    }
}

/// Sleeps on the channel for `delay`, queueing any acks that arrive meanwhile
/// so they keep their FIFO place. Returns false once the service shuts down,
/// so a pending retry never holds up quitting.
fn wait_queueing(
    receiver: &mpsc::Receiver<AckJob>,
    queue: &mut VecDeque<AckJob>,
    delay: Duration,
) -> bool {
    let until = Instant::now() + delay;
    while let Some(left) = until.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(left) {
            Ok(next) => queue.push_back(next),
            Err(mpsc::RecvTimeoutError::Timeout) => return true,
            Err(mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
    true
}

impl Drop for AckWorker {
    fn drop(&mut self) {
        // Closing the channel lets the worker drain its queue and exit.
        self.sender.take();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

struct PlaybackHandle {
    stop: Arc<AtomicBool>,
    abandon: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct Selection {
    index: u32,
    data: ControllerData,
    mapping: Mapping,
}

pub struct PlayerService {
    config: PlayerConfig,
    shared: Arc<PlayerShared>,
    rx: mpsc::Receiver<ServiceCommand>,
    tx: mpsc::Sender<ServiceCommand>,
    token: TokenClient,
    driver: Arc<dyn DriverProvider>,
    wall: Arc<dyn WallClock>,
    ack_worker: AckWorker,
    decoder: EngineHost,
    state: PlayerState,
    error: Option<FailureCode>,
    effect_name: Option<String>,
    keyboard: Option<PlayKeyboard>,
    generation: u64,
    playback_generation: u64,
    playback: Option<PlaybackHandle>,
    prepared: Option<PreparedPlay>,
    current_token: Option<String>,
    /// A play link that arrived while an effect was already playing. The
    /// current effect keeps running until the redeem tells us whether the new
    /// link is the same effect (ack directly) or a different one (restart).
    pending_token: Option<String>,
    ack_ctx: Option<AckContext>,
    last_ack: Option<(PlayResult, Option<FailureCode>)>,
    controller_name: String,
    controller_location: String,
    active_addr: Option<SocketAddr>,
    driver_progress: i32,
    driver_error: i32,
    conflict_name: Option<String>,
    conflicts: ConflictDetector,
    watcher: DeviceWatcher,
    options: ServiceOptions,
    last_rescan: Option<Instant>,
    last_managed_restart: Option<Instant>,
    last_hardware_rescan: Option<Instant>,
    last_idle_probe: Option<Instant>,
    install_in_progress: bool,
}

impl PlayerService {
    pub fn start(
        config: PlayerConfig,
        shared: Arc<PlayerShared>,
        driver: Box<dyn DriverProvider>,
        wall: Arc<dyn WallClock>,
    ) -> Result<PlayerHandle, ServiceError> {
        Self::start_with(
            config,
            shared,
            Arc::from(driver),
            wall,
            None,
            ServiceOptions::production(),
        )
    }

    pub fn start_with(
        config: PlayerConfig,
        shared: Arc<PlayerShared>,
        driver: Arc<dyn DriverProvider>,
        wall: Arc<dyn WallClock>,
        lister: Option<Box<dyn ProcessLister>>,
        options: ServiceOptions,
    ) -> Result<PlayerHandle, ServiceError> {
        let token = TokenClient::new(
            &config.api_base,
            &config.platform,
            &config.app_version,
            ENGINE_PACKAGE_VERSION,
        )?;

        // Resolve ANSI104 key names to engine cells for `rgbp_push_key`.
        let cells = {
            let host = EngineHost::new(HostLimits::default())
                .map_err(|e| ServiceError::Engine(e.to_string()))?;
            host.key_names()
                .iter()
                .cloned()
                .zip(host.key_cells().iter().cloned())
                .collect::<Vec<_>>()
        };
        shared.set_key_cells(cells);

        let (tx, rx) = mpsc::channel();
        let thread_tx = tx.clone();
        let thread_shared = Arc::clone(&shared);
        let join = thread::spawn(move || {
            let decoder = match EngineHost::new(HostLimits::default()) {
                Ok(decoder) => decoder,
                Err(error) => {
                    thread_shared.add_error(wall.unix_ms(), "internal");
                    let _ = thread_tx.send(ServiceCommand::Shutdown);
                    eprintln!("rgbprompt-player: engine host failed to start: {error}");
                    return;
                }
            };
            let ack_worker =
                AckWorker::spawn(token.clone(), Arc::clone(&thread_shared), Arc::clone(&wall));

            let event_tx = thread_tx.clone();
            driver.set_event_sink(Arc::new(move |event| {
                let _ = event_tx.send(ServiceCommand::DriverEvent(event));
            }));

            let watcher = DeviceWatcher::start(thread_tx.clone(), options.watch_interval);
            let conflicts =
                ConflictDetector::new(lister.unwrap_or_else(|| Box::new(SysinfoLister)));
            let mut service = PlayerService {
                config,
                shared: thread_shared,
                rx,
                tx: thread_tx,
                token,
                driver,
                wall,
                ack_worker,
                decoder,
                state: PlayerState::Idle,
                error: None,
                effect_name: None,
                keyboard: None,
                generation: 0,
                playback_generation: 0,
                playback: None,
                prepared: None,
                current_token: None,
                pending_token: None,
                ack_ctx: None,
                last_ack: None,
                controller_name: String::new(),
                controller_location: String::new(),
                active_addr: None,
                driver_progress: -1,
                driver_error: 0,
                conflict_name: None,
                conflicts,
                watcher,
                options,
                last_rescan: None,
                last_managed_restart: None,
                last_hardware_rescan: None,
                last_idle_probe: None,
                install_in_progress: false,
            };
            service.publish_state();
            service.update_watcher();
            service.run();
        });

        Ok(PlayerHandle {
            shared,
            commands: tx,
            join: Some(join),
        })
    }

    fn run(&mut self) {
        while let Ok(command) = self.rx.recv() {
            if !self.handle(command) {
                break;
            }
        }
        self.stop_playback();
        self.watcher.shutdown();
        self.driver.shutdown();
    }

    fn handle(&mut self, command: ServiceCommand) -> bool {
        match command {
            ServiceCommand::Shutdown => {
                self.stop_playback();
                return false;
            }
            ServiceCommand::OpenUrl(url) => self.open_url(url),
            ServiceCommand::OpenLepFile(path) => self.open_lep_file(path),
            ServiceCommand::Stop => self.stop(),
            ServiceCommand::Retry => self.retry(),
            ServiceCommand::InstallDriver => self.install_driver(),
            ServiceCommand::RestartBackend => self.restart_backend(),
            ServiceCommand::WatchTick => self.watch_tick(),
            ServiceCommand::DevicesChanged => self.devices_changed(),
            ServiceCommand::SetBrightness(value) => {
                self.shared
                    .brightness
                    .store(u32::from(value.clamp(10, 100)), Ordering::Relaxed);
            }
            ServiceCommand::SetLanguage(language) => {
                *self.shared.language.lock().expect("language") = language;
            }
            ServiceCommand::SetAudioEnabled(enabled) => {
                self.shared.audio_enabled.store(enabled, Ordering::Relaxed);
            }
            ServiceCommand::SetKeyReactiveEnabled(enabled) => {
                self.shared.key_enabled.store(enabled, Ordering::Relaxed);
            }
            ServiceCommand::SelectKeyboard(name) => self.select_preferred_keyboard(name),
            ServiceCommand::SetProtocolRegistered(registered) => {
                self.shared
                    .protocol_registered
                    .store(registered, Ordering::Relaxed);
            }
            ServiceCommand::Redeemed {
                generation,
                outcome,
                api_base,
            } => {
                self.on_redeemed(generation, outcome, api_base);
            }
            ServiceCommand::Playback { generation, event } => {
                self.on_playback(generation, event);
            }
            ServiceCommand::DriverEvent(event) => self.on_driver_event(event),
        }
        true
    }

    fn publish_state(&self) {
        let keyboard_name = self
            .keyboard
            .as_ref()
            .and_then(|keyboard| keyboard.name.clone());
        let keyboard_support = self.keyboard.as_ref().map(|keyboard| keyboard.support);
        self.shared.publish(StateSnapshot {
            state: self.state,
            error: self.error.map_or(0, FailureCode::status_code),
            effect_name: self.effect_name.clone(),
            keyboard_name,
            keyboard_support,
            fps: self.shared.fps.load(Ordering::Relaxed).max(1),
            driver_progress: self.driver_progress,
            driver_error: self.driver_error,
            conflict_name: self.conflict_name.clone(),
        });
    }

    fn set_state(&mut self, state: PlayerState, error: Option<FailureCode>) {
        self.state = state;
        self.error = error;
        self.update_watcher();
        self.publish_state();
        self.log_state();
    }

    fn update_watcher(&self) {
        // Idle stays active so soft_probe_keyboard can refresh Settings'
        // live keyboard row without requiring a prior successful play.
        let active = matches!(
            self.state,
            PlayerState::Idle
                | PlayerState::NoKeyboard
                | PlayerState::BackendUnresponsive
                | PlayerState::VendorConflict
        );
        self.watcher.set_active(active);
    }

    fn log_state(&self) {
        let error = self.error.map_or(0, FailureCode::status_code);
        let device = self
            .keyboard
            .as_ref()
            .and_then(|keyboard| keyboard.name.as_deref())
            .unwrap_or("-");
        let support = self
            .keyboard
            .as_ref()
            .map(|keyboard| support_str(keyboard.support))
            .unwrap_or("-");
        self.shared.log_line(&format!(
            "{} state={} code={} fps={} device={} support={}",
            self.wall.unix_ms(),
            self.state.as_str(),
            error,
            self.shared.fps.load(Ordering::Relaxed).max(1),
            device,
            support
        ));
    }

    fn clear_current(&mut self) {
        self.prepared = None;
        self.current_token = None;
        self.pending_token = None;
        self.ack_ctx = None;
        self.last_ack = None;
        self.effect_name = None;
        self.keyboard = None;
        self.active_addr = None;
        self.driver_progress = -1;
        self.driver_error = 0;
        self.conflict_name = None;
        self.install_in_progress = false;
        self.shared.wants_audio.store(false, Ordering::Relaxed);
        self.shared.wants_keys.store(false, Ordering::Relaxed);
        self.shared.fps.store(FPS_HIGH, Ordering::Relaxed);
    }

    fn open_url(&mut self, url: String) {
        match parse_player_url(&url) {
            // `rgbprompt://open` only asks the shell to show the panel; it must
            // not interrupt an effect that is already playing.
            Some(ParsedPlayerUrl::Open) => self.publish_state(),
            None => {
                self.stop_playback();
                self.driver.cancel_install();
                self.generation += 1;
                self.clear_current();
                self.set_state(PlayerState::Idle, Some(FailureCode::Internal));
            }
            Some(ParsedPlayerUrl::UnsupportedVersion { .. }) => {
                self.stop_playback();
                self.driver.cancel_install();
                self.generation += 1;
                self.clear_current();
                self.set_state(PlayerState::Idle, Some(FailureCode::UpdateRequired));
            }
            Some(ParsedPlayerUrl::Play {
                token, api_base, ..
            }) if self.state == PlayerState::Playing && self.playback.is_some() => {
                // Keep the current effect running while the new link redeems.
                self.generation += 1;
                self.pending_token = Some(token.clone());
                self.spawn_redeem(token, api_base);
            }
            Some(ParsedPlayerUrl::Play {
                token, api_base, ..
            }) => {
                self.stop_playback();
                self.driver.cancel_install();
                self.generation += 1;
                self.clear_current();
                self.current_token = Some(token.clone());
                self.set_state(PlayerState::Preparing, None);
                self.spawn_redeem(token, api_base);
            }
        }
    }

    fn spawn_redeem(&self, token: String, api_base: Option<String>) {
        let generation = self.generation;
        let tx = self.tx.clone();
        let base = api_base.unwrap_or_else(|| self.token.api_base().to_string());
        let client = match self.token.with_api_base(&base) {
            Ok(client) => client,
            Err(_) => self.token.clone(),
        };
        // Remember which API issued this token so ack hits the same host.
        // Stored on the control thread when Redeemed arrives via pending/current token path.
        thread::spawn(move || {
            let outcome = client.redeem(&token);
            let _ = tx.send(ServiceCommand::Redeemed {
                generation,
                outcome,
                api_base: base,
            });
        });
    }

    /// Resolves a play link that arrived while an effect was playing. Returns
    /// true when the link was the same effect and has been acked in place.
    fn settle_pending(
        &mut self,
        token: String,
        outcome: &Result<Redeemed, TokenError>,
        api_base: &str,
    ) -> bool {
        let same = match outcome {
            Ok(redeemed) => {
                self.state == PlayerState::Playing
                    && self.playback.is_some()
                    && !version_gt(&redeemed.min_player_version, &self.config.app_version)
                    && self
                        .prepared
                        .as_ref()
                        .is_some_and(|prepared| prepared.lep == redeemed.lep)
            }
            Err(_) => false,
        };
        if same {
            if let Ok(redeemed) = outcome {
                self.current_token = Some(token);
                self.ack_ctx = Some(AckContext {
                    token: self.current_token.clone().unwrap_or_default(),
                    deadline: redeemed.ack_deadline,
                    api_base: api_base.to_string(),
                });
                self.last_ack = None;
                if redeemed.name.is_some() {
                    self.effect_name = redeemed.name.clone();
                    self.publish_state();
                }
                let keyboard = self.keyboard.clone();
                self.maybe_ack(PlayResult::Playing, None, keyboard);
            }
            return true;
        }
        // A different effect (or a failed redeem): fall back to the normal
        // restart so the new link is handled exactly like a fresh play.
        self.stop_playback();
        self.driver.cancel_install();
        self.clear_current();
        self.current_token = Some(token);
        self.set_state(PlayerState::Preparing, None);
        false
    }

    fn open_lep_file(&mut self, path: PathBuf) {
        self.stop_playback();
        self.driver.cancel_install();
        self.generation += 1;
        self.clear_current();
        let lep = match fs::read(&path) {
            Ok(bytes) if bytes.len() <= MAX_LEP_BYTES => bytes,
            _ => {
                self.shared.add_error(self.wall.unix_ms(), "decode_failed");
                self.set_state(PlayerState::Idle, Some(FailureCode::DecodeFailed));
                return;
            }
        };
        let bits = match self.decode_inputs(&lep) {
            Ok(bits) => bits,
            Err(failure) => {
                self.shared.add_error(self.wall.unix_ms(), failure.as_str());
                self.set_state(PlayerState::Idle, Some(failure));
                return;
            }
        };
        self.effect_name = None;
        self.apply_wants(bits);
        self.prepared = Some(PreparedPlay {
            lep,
            phase: Phase::Redeemed,
        });
        self.set_state(PlayerState::Preparing, None);
        self.proceed_driver();
    }

    fn decode_inputs(&self, lep: &[u8]) -> Result<u32, FailureCode> {
        match self.decoder.decode(lep) {
            Ok(program) => self
                .decoder
                .input_wanted(&program)
                .map_err(|_| FailureCode::DecodeFailed),
            Err(error) if is_unsupported_package_error(&error) => {
                Err(FailureCode::UnsupportedPackage)
            }
            Err(_) => Err(FailureCode::DecodeFailed),
        }
    }

    fn apply_wants(&self, bits: u32) {
        self.shared
            .wants_audio
            .store(bits & 1 != 0, Ordering::Relaxed);
        self.shared
            .wants_keys
            .store(bits & 2 != 0, Ordering::Relaxed);
    }

    fn on_redeemed(
        &mut self,
        generation: u64,
        outcome: Result<Redeemed, TokenError>,
        api_base: String,
    ) {
        if generation != self.generation {
            return;
        }
        if let Some(token) = self.pending_token.take() {
            if self.settle_pending(token, &outcome, &api_base) {
                return;
            }
        }
        match outcome {
            Err(TokenError::NotFound) => {
                self.shared
                    .add_error(self.wall.unix_ms(), "link_unavailable");
                self.clear_current();
                self.set_state(PlayerState::Idle, Some(FailureCode::LinkUnavailable));
            }
            Err(error) => {
                let code = match &error {
                    TokenError::RateLimited { .. } => "rate_limited",
                    _ => "internal",
                };
                self.shared.add_error(self.wall.unix_ms(), code);
                if let Some(token) = self.current_token.clone() {
                    self.ack_ctx = Some(AckContext {
                        token,
                        deadline: self.wall.unix_ms() as i64 + ACK_WINDOW_MS as i64,
                        api_base: api_base.clone(),
                    });
                    self.last_ack = None;
                }
                self.maybe_ack_failed(FailureCode::Internal);
                self.end_with(PlayerState::Idle, Some(FailureCode::Internal));
            }
            Ok(redeemed) => {
                self.ack_ctx = Some(AckContext {
                    token: self.current_token.clone().unwrap_or_default(),
                    deadline: redeemed.ack_deadline,
                    api_base: api_base.clone(),
                });
                self.last_ack = None;

                if version_gt(&redeemed.min_player_version, &self.config.app_version) {
                    self.shared
                        .add_error(self.wall.unix_ms(), "update_required");
                    self.maybe_ack_failed(FailureCode::UpdateRequired);
                    self.end_with(PlayerState::Idle, Some(FailureCode::UpdateRequired));
                    return;
                }

                let bits = match self.decode_inputs(&redeemed.lep) {
                    Ok(bits) => bits,
                    Err(failure) => {
                        self.shared.add_error(self.wall.unix_ms(), failure.as_str());
                        self.maybe_ack_failed(failure);
                        self.end_with(PlayerState::Idle, Some(failure));
                        return;
                    }
                };

                self.effect_name = redeemed.name;
                self.apply_wants(bits);
                self.prepared = Some(PreparedPlay {
                    lep: redeemed.lep,
                    phase: Phase::Redeemed,
                });
                self.proceed_driver();
            }
        }
    }

    fn proceed_driver(&mut self) {
        if self.prepared.is_none() {
            return;
        }
        match self.driver.status() {
            DriverStatus::Missing => {
                if let Some(prepared) = self.prepared.as_mut() {
                    prepared.phase = Phase::NeedsDriver;
                }
                self.driver_error = self.driver.last_error().map_or(0, DriverFailure::code);
                self.set_state(PlayerState::NeedsDriver, None);
                self.maybe_ack(PlayResult::NeedsDriver, None, None);
            }
            DriverStatus::Blocked => {
                self.driver_error = DriverFailure::Blocked.code();
                self.shared.add_error(self.wall.unix_ms(), "driver_blocked");
                self.set_state(PlayerState::Blocked, None);
            }
            DriverStatus::Running {
                addr,
                version,
                port,
            } => {
                self.set_openrgb(&version, port);
                self.connect_and_detect(addr, true);
            }
        }
    }

    fn set_openrgb(&self, version: &str, port: u16) {
        self.shared.set_openrgb(Some(OpenRgbDiagnostic {
            version: version.to_string(),
            port,
            running: true,
        }));
    }

    fn connect_and_detect(&mut self, addr: SocketAddr, initial: bool) {
        let mut client = match OpenRGBClient::connect(addr, "RGBPrompt Player", REDEEM_TIMEOUT) {
            Ok(client) => client,
            Err(_) => {
                self.shared
                    .add_error(self.wall.unix_ms(), "openrgb_unreachable");
                if initial {
                    self.maybe_ack_failed(FailureCode::OpenRgbUnreachable);
                    self.end_with(PlayerState::Idle, Some(FailureCode::OpenRgbUnreachable));
                } else {
                    self.enter_backend_unresponsive(false);
                }
                return;
            }
        };

        let selection = match self.select_keyboard(&mut client) {
            Ok(selection) => selection,
            Err(()) => {
                self.shared
                    .add_error(self.wall.unix_ms(), "openrgb_unreachable");
                if initial {
                    self.maybe_ack_failed(FailureCode::OpenRgbUnreachable);
                    self.end_with(PlayerState::Idle, Some(FailureCode::OpenRgbUnreachable));
                } else {
                    self.enter_backend_unresponsive(false);
                }
                return;
            }
        };

        let Some(selection) = selection else {
            self.enter_no_keyboard(
                if initial {
                    None
                } else {
                    self.error.filter(|code| *code == FailureCode::DeviceLost)
                },
                initial,
            );
            return;
        };

        if !self.options.location_live.is_live(&selection.data.location) {
            self.active_addr = Some(addr);
            self.controller_name = selection.data.name.clone();
            self.controller_location = selection.data.location.clone();
            self.recover_stale_device(Some(addr));
            return;
        }

        self.active_addr = Some(addr);
        self.controller_name = selection.data.name.clone();
        self.controller_location = selection.data.location.clone();
        let keyboard = PlayKeyboard {
            name: Some(selection.data.name.clone()),
            support: selection.mapping.support,
        };
        self.keyboard = Some(keyboard.clone());
        self.conflict_name = None;
        self.state = PlayerState::Playing;
        self.error = None;
        self.update_watcher();
        self.publish_state();
        self.log_state();
        self.maybe_ack(PlayResult::Playing, None, Some(keyboard));
        self.start_playback(
            client,
            selection.index,
            selection.mapping,
            selection.data.name,
            selection.data.location,
        );
    }

    fn select_keyboard(&mut self, client: &mut OpenRGBClient) -> Result<Option<Selection>, ()> {
        let count = client.controller_count().map_err(|_| ())?;
        let key_names = self.decoder.key_names();
        let centres = self.decoder.key_centres_quarter();
        let db = DeviceDb::embedded();

        // Diagnostics keep every controller; playback only accepts per-key
        // keyboards (usable Direct LED control via the SDK).
        let mut devices: Vec<(u32, DeviceDiagnostic, Option<Selection>)> = Vec::new();
        let mut supported: Vec<Selection> = Vec::new();
        for index in 0..count {
            let data = match client.controller_data(index) {
                Ok(data) => data,
                Err(_) => continue,
            };
            let mapping = detect(&data, db, key_names, centres);
            let (support, candidate) = match mapping {
                Ok(mapping) => {
                    let support = mapping.support;
                    let candidate = (data.kind == DEVICE_TYPE_KEYBOARD
                        && support == Support::PerKey)
                        .then(|| Selection {
                            index,
                            data: data.clone(),
                            mapping,
                        });
                    (support, candidate)
                }
                Err(_) => (Support::Single, None),
            };
            let (vendor_id, product_id) = crate::diagnostics::parse_vid_pid(&data.location);
            let diagnostic = DeviceDiagnostic {
                name: data.name.clone(),
                vendor_id,
                product_id,
                support,
            };
            if let Some(candidate) = candidate {
                supported.push(candidate.clone());
                devices.push((index, diagnostic, Some(candidate)));
            } else {
                devices.push((index, diagnostic, None));
            }
        }

        let preferred = self.shared.preferred_keyboard();
        let current = self.controller_name.clone();
        let chosen = choose_keyboard(&supported, preferred.as_deref(), current.as_str());

        // Put the chosen device first in diagnostics for stable UI ordering.
        if let Some(selection) = chosen.as_ref() {
            if let Some(position) = devices
                .iter()
                .position(|(index, _, _)| *index == selection.index)
            {
                if position > 0 {
                    devices.swap(0, position);
                }
            }
        }
        self.shared.set_devices(
            devices
                .iter()
                .map(|(_, device, _)| device.clone())
                .collect(),
        );

        Ok(chosen)
    }

    fn select_preferred_keyboard(&mut self, name: String) {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            self.shared.set_preferred_keyboard(None);
            if self.state == PlayerState::Idle {
                self.soft_probe_keyboard();
            }
            return;
        }
        self.shared.set_preferred_keyboard(Some(trimmed.clone()));
        if self.state == PlayerState::Playing {
            // Retarget without a Studio round-trip: stop the loop (blacks the
            // old board), then rescan so select_keyboard honors the new pick
            // and start_playback continues the same prepared effect.
            self.stop_playback();
            self.rescan();
            return;
        }
        if matches!(
            self.state,
            PlayerState::NoKeyboard | PlayerState::BackendUnresponsive
        ) && self.prepared.is_some()
        {
            self.rescan();
            return;
        }
        if self.state == PlayerState::Idle {
            self.soft_probe_keyboard();
        }
    }

    fn enter_no_keyboard(&mut self, error: Option<FailureCode>, initial: bool) {
        if let Some(prepared) = self.prepared.as_mut() {
            prepared.phase = Phase::NoKeyboard;
        }
        self.keyboard = None;
        if let Some(name) = self.conflicts.detect(&self.config.platform) {
            self.conflict_name = Some(name);
            self.shared
                .add_error(self.wall.unix_ms(), "vendor_conflict");
            self.set_state(PlayerState::VendorConflict, error);
        } else {
            self.conflict_name = None;
            self.set_state(PlayerState::NoKeyboard, error);
        }
        if initial {
            self.maybe_ack(PlayResult::NoKeyboard, None, None);
        }
    }

    fn enter_backend_unresponsive(&mut self, ack: bool) {
        self.keyboard = None;
        if let Some(name) = self.conflicts.detect(&self.config.platform) {
            self.conflict_name = Some(name);
            self.shared
                .add_error(self.wall.unix_ms(), "vendor_conflict");
            self.set_state(PlayerState::VendorConflict, None);
        } else {
            self.conflict_name = None;
            self.set_state(PlayerState::BackendUnresponsive, None);
        }
        if ack {
            self.maybe_ack_failed(FailureCode::OpenRgbUnreachable);
        }
    }

    fn start_playback(
        &mut self,
        client: OpenRGBClient,
        index: u32,
        mapping: Mapping,
        controller_name: String,
        controller_location: String,
    ) {
        let lep = match self.prepared.as_ref() {
            Some(prepared) => prepared.lep.clone(),
            None => return,
        };
        let session = match DirectSession::begin(client, index) {
            Ok(session) => session,
            Err(_) => {
                self.shared
                    .add_error(self.wall.unix_ms(), "openrgb_unreachable");
                self.maybe_ack_failed(FailureCode::OpenRgbUnreachable);
                self.enter_backend_unresponsive(false);
                return;
            }
        };

        let preview = Arc::clone(&self.shared.preview);
        let keys = Arc::clone(&self.shared.keys);
        let audio = AudioAnalyzer::new(Arc::clone(&self.shared.audio));
        let brightness = Arc::clone(&self.shared.brightness);
        let fps = Arc::clone(&self.shared.fps);
        let stop = Arc::new(AtomicBool::new(false));
        let abandon = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        let abandon_thread = Arc::clone(&abandon);
        let tx = self.tx.clone();
        let generation = self.generation;
        let shared = Arc::clone(&self.shared);
        let location_live = self.options.location_live.clone();

        let join = thread::spawn(move || {
            let host = match EngineHost::new(HostLimits::default()) {
                Ok(host) => host,
                Err(_) => {
                    let _ = tx.send(ServiceCommand::Playback {
                        generation,
                        event: PlaybackEvent::Failed(PlaybackFailure::Internal),
                    });
                    return;
                }
            };
            let program = match host.decode(&lep) {
                Ok(program) => program,
                Err(_) => {
                    let _ = tx.send(ServiceCommand::Playback {
                        generation,
                        event: PlaybackEvent::Failed(PlaybackFailure::Internal),
                    });
                    return;
                }
            };
            let renderer = match host.renderer(&program) {
                Ok(renderer) => renderer,
                Err(_) => {
                    let _ = tx.send(ServiceCommand::Playback {
                        generation,
                        event: PlaybackEvent::Failed(PlaybackFailure::Internal),
                    });
                    return;
                }
            };
            let limiter = match host.limiter() {
                Ok(limiter) => limiter,
                Err(_) => {
                    let _ = tx.send(ServiceCommand::Playback {
                        generation,
                        event: PlaybackEvent::Failed(PlaybackFailure::Internal),
                    });
                    return;
                }
            };

            let mut playback = PlaybackState::new(
                &host,
                &renderer,
                &limiter,
                PlaybackSetup {
                    session,
                    mapping,
                    controller_name,
                    controller_location,
                    preview,
                    keys,
                    audio,
                    clock: Arc::new(SystemClock::new()),
                    brightness,
                    fps,
                    write_latency: Duration::ZERO,
                    abandon: abandon_thread,
                    location_live,
                },
            );
            let mut emit = |event: PlaybackEvent| {
                let _ = tx.send(ServiceCommand::Playback { generation, event });
            };
            playback.run(&stop_thread, &mut emit);
            shared.fps.store(FPS_HIGH, Ordering::Relaxed);
        });

        self.playback = Some(PlaybackHandle {
            stop,
            abandon,
            join: Some(join),
        });
        self.playback_generation = generation;
    }

    fn on_playback(&mut self, generation: u64, event: PlaybackEvent) {
        if generation != self.playback_generation {
            return;
        }
        match event {
            PlaybackEvent::FpsChanged(fps) => {
                self.shared.fps.store(fps, Ordering::Relaxed);
                self.publish_state();
            }
            PlaybackEvent::Failed(failure) => {
                self.join_playback();
                match failure {
                    PlaybackFailure::DeviceLost => {
                        self.shared.add_error(self.wall.unix_ms(), "device_lost");
                        self.maybe_ack_failed(FailureCode::DeviceLost);
                        self.enter_no_keyboard(Some(FailureCode::DeviceLost), false);
                    }
                    PlaybackFailure::DeviceStale => {
                        self.recover_stale_device(self.active_addr);
                    }
                    PlaybackFailure::OpenRgbUnreachable => {
                        self.shared
                            .add_error(self.wall.unix_ms(), "openrgb_unreachable");
                        self.maybe_ack_failed(FailureCode::OpenRgbUnreachable);
                        // Frame-path health probe failed (UpdateLEDs write or
                        // request/response round-trip). Restart managed OpenRGB
                        // so a stale SDK that still accepts TCP recovers.
                        if self.driver.is_managed() {
                            let now = Instant::now();
                            let allowed = self.last_managed_restart.is_none_or(|last| {
                                now.duration_since(last) >= self.options.managed_restart_cooldown
                            });
                            if allowed {
                                self.last_managed_restart = Some(now);
                                let _ = self.driver.restart();
                            }
                        }
                        self.enter_backend_unresponsive(false);
                    }
                    PlaybackFailure::Internal => {
                        self.shared.add_error(self.wall.unix_ms(), "internal");
                        self.maybe_ack_failed(FailureCode::Internal);
                        self.end_with(PlayerState::Idle, Some(FailureCode::Internal));
                    }
                }
            }
        }
    }

    fn watch_tick(&mut self) {
        if matches!(
            self.state,
            PlayerState::NoKeyboard | PlayerState::BackendUnresponsive
        ) {
            self.recover_absent_keyboard(false, false);
        } else if self.state == PlayerState::VendorConflict {
            self.rescan();
        }
        // Live keyboard row for Settings while idle: probe the SDK when the
        // driver is up so we do not depend on a prior successful play.
        if self.state == PlayerState::Idle {
            let now = Instant::now();
            let due = self
                .last_idle_probe
                .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(3));
            if due {
                self.last_idle_probe = Some(now);
                self.soft_probe_keyboard();
            }
        }
    }

    fn soft_probe_keyboard(&mut self) {
        let DriverStatus::Running {
            addr,
            version,
            port,
        } = self.driver.status()
        else {
            if self.keyboard.take().is_some() {
                self.publish_state();
            }
            return;
        };
        self.set_openrgb(&version, port);
        let Ok(mut client) = OpenRGBClient::connect(addr, "RGBPrompt Probe", REDEEM_TIMEOUT) else {
            if self.keyboard.take().is_some() {
                self.publish_state();
            }
            return;
        };
        match self.select_keyboard(&mut client) {
            Ok(Some(selection)) => {
                if !self.options.location_live.is_live(&selection.data.location) {
                    self.controller_name = selection.data.name.clone();
                    self.controller_location = selection.data.location.clone();
                    self.shared.add_error(self.wall.unix_ms(), "device_stale");
                    self.shared.log_line(&format!(
                        "{} device_stale probe device={} location={}",
                        self.wall.unix_ms(),
                        selection.data.name,
                        selection.data.location
                    ));
                    if self.keyboard.take().is_some() {
                        self.publish_state();
                    }
                    self.recover_stale_handle(addr);
                    return;
                }
                let name = selection.data.name.clone();
                let changed = self
                    .keyboard
                    .as_ref()
                    .and_then(|k| k.name.as_ref())
                    .map(|n| n != &name)
                    .unwrap_or(true);
                self.controller_name = name.clone();
                self.controller_location = selection.data.location.clone();
                self.keyboard = Some(PlayKeyboard {
                    name: Some(name),
                    support: selection.mapping.support,
                });
                if changed {
                    self.publish_state();
                }
            }
            _ => {
                if self.keyboard.take().is_some() {
                    self.publish_state();
                }
            }
        }
    }

    fn devices_changed(&mut self) {
        if self.state == PlayerState::Idle {
            self.soft_probe_keyboard();
            return;
        }
        let now = Instant::now();
        if let Some(last) = self.last_rescan {
            if now.duration_since(last) < self.options.rescan_debounce {
                return;
            }
        }
        self.last_rescan = Some(now);

        match self.state {
            PlayerState::Playing => {
                let Some(addr) = self.active_addr else {
                    return;
                };
                match self.controller_health(addr) {
                    ControllerHealth::Live => {
                        // Rebuild the mapping by reconnecting; playback restarts
                        // with the same effect.
                        self.stop_playback();
                        self.rescan();
                    }
                    ControllerHealth::Stale => self.recover_stale_device(Some(addr)),
                    ControllerHealth::Gone => {
                        self.stop_playback_abandon();
                        self.shared.add_error(self.wall.unix_ms(), "device_lost");
                        self.maybe_ack_failed(FailureCode::DeviceLost);
                        self.enter_no_keyboard(Some(FailureCode::DeviceLost), false);
                    }
                    ControllerHealth::Unreachable => {
                        self.stop_playback_abandon();
                        self.enter_backend_unresponsive(false);
                    }
                }
            }
            PlayerState::NoKeyboard | PlayerState::BackendUnresponsive => {
                // A HID arrival after unplug/replug must force a hardware
                // rescan: OpenRGB's controller list stays empty until packet
                // 140 (or a process restart) runs again.
                self.recover_absent_keyboard(true, false);
            }
            PlayerState::VendorConflict => {
                self.rescan();
                if self.driver.is_managed() {
                    let now = Instant::now();
                    let allowed = self.last_managed_restart.is_none_or(|last| {
                        now.duration_since(last) >= self.options.managed_restart_cooldown
                    });
                    if allowed {
                        self.last_managed_restart = Some(now);
                        let _ = self.driver.restart();
                    }
                }
            }
            _ => {}
        }
    }

    fn controller_health(&self, addr: SocketAddr) -> ControllerHealth {
        let Ok(mut client) = OpenRGBClient::connect(addr, "RGBPrompt Check", REDEEM_TIMEOUT) else {
            return ControllerHealth::Unreachable;
        };
        let Ok(count) = client.controller_count() else {
            return ControllerHealth::Unreachable;
        };
        let mut stale = false;
        for index in 0..count {
            if let Ok(data) = client.controller_data(index) {
                if data.name != self.controller_name {
                    continue;
                }
                if self.options.location_live.is_live(&data.location) {
                    return ControllerHealth::Live;
                }
                stale = true;
            }
        }
        if stale {
            ControllerHealth::Stale
        } else {
            ControllerHealth::Gone
        }
    }

    /// OpenRGB still lists this keyboard, but the HID handle behind the
    /// location string is dead. Ask the server to re-detect hardware (packet
    /// 140). If a rescan was already tried recently and the handle is still
    /// dead, restart a managed driver. Keep the prepared effect so the
    /// watcher can resume playback. Leave the keyboard lights as they are.
    fn recover_stale_device(&mut self, addr: Option<SocketAddr>) {
        self.stop_playback_abandon();
        self.shared.add_error(self.wall.unix_ms(), "device_stale");
        self.shared.log_line(&format!(
            "{} device_stale device={} location={}",
            self.wall.unix_ms(),
            if self.controller_name.is_empty() {
                "-"
            } else {
                &self.controller_name
            },
            if self.controller_location.is_empty() {
                "-"
            } else {
                &self.controller_location
            }
        ));
        if let Some(addr) = addr {
            self.recover_stale_handle(addr);
        }
        // Do not ack failed: the effect is still prepared and will resume
        // once a live handle is back. Status must not stay on Playing.
        self.enter_backend_unresponsive(false);
    }

    /// Re-open a dead HID handle. Packet 140 works on this project's OpenRGB
    /// even when the process was inherited as External after a Player relaunch.
    /// A managed process restart is the fallback if a rescan was already
    /// requested within the cooldown and the handle is still dead.
    fn recover_stale_handle(&mut self, addr: SocketAddr) {
        self.request_hardware_rescan(addr, false);
        // No-op when the process was inherited as External (the usual case
        // after a Player relaunch). Packet 140 is what re-opens the HID handle.
        self.restart_managed_if_allowed();
    }

    const HARDWARE_RESCAN_COOLDOWN: Duration = Duration::from_secs(10);

    fn request_hardware_rescan(&mut self, addr: SocketAddr, force: bool) -> bool {
        let now = Instant::now();
        let allowed = force
            || self
                .last_hardware_rescan
                .is_none_or(|last| now.duration_since(last) >= Self::HARDWARE_RESCAN_COOLDOWN);
        if !allowed {
            return false;
        }
        self.last_hardware_rescan = Some(now);
        match OpenRGBClient::connect(addr, "RGBPrompt Rescan", REDEEM_TIMEOUT) {
            Ok(mut client) => match client.request_rescan_devices() {
                Ok(()) => {
                    self.shared
                        .log_line(&format!("{} device_rescan requested", self.wall.unix_ms()));
                    true
                }
                Err(error) => {
                    self.shared.log_line(&format!(
                        "{} device_rescan failed: {error}",
                        self.wall.unix_ms()
                    ));
                    false
                }
            },
            Err(error) => {
                self.shared.log_line(&format!(
                    "{} device_rescan connect failed: {error}",
                    self.wall.unix_ms()
                ));
                false
            }
        }
    }

    /// After unplug the SDK list is empty even once the keyboard is back in
    /// IORegistry. Packet 140 re-detects it; if that is not enough and the
    /// device is physically present, restart our OpenRGB-RGBPrompt.app.
    fn recover_absent_keyboard(&mut self, force: bool, wait: bool) {
        let status = if force {
            self.driver.status_full()
        } else {
            self.driver.status()
        };
        let DriverStatus::Running { addr, .. } = status else {
            if force {
                self.rescan_with(true);
            } else {
                self.rescan();
            }
            return;
        };
        let sent = self.request_hardware_rescan(addr, force);
        if wait && sent {
            self.wait_for_device_list(addr, Duration::from_secs(5));
        }
        if force {
            self.rescan_with(true);
        } else {
            self.rescan();
        }
        if self.state == PlayerState::NoKeyboard {
            self.restart_ours_if_keyboard_waiting();
        }
    }

    fn wait_for_device_list(&self, addr: SocketAddr, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Ok(mut client) = OpenRGBClient::connect(addr, "RGBPrompt Wait", REDEEM_TIMEOUT) {
                if client
                    .controller_count()
                    .ok()
                    .is_some_and(|count| count > 0)
                {
                    return;
                }
            }
            thread::sleep(Duration::from_millis(150));
        }
    }

    fn restart_ours_if_keyboard_waiting(&mut self) {
        if !self.options.keyboard_attached.is_attached() {
            return;
        }
        let now = Instant::now();
        // Let packet 140 finish (OpenRGB detection can take a few seconds)
        // before falling back to a process restart.
        let rescan_settled = self
            .last_hardware_rescan
            .is_some_and(|last| now.duration_since(last) >= Duration::from_secs(3));
        if !rescan_settled {
            return;
        }
        let allowed = self
            .last_managed_restart
            .is_none_or(|last| now.duration_since(last) >= self.options.managed_restart_cooldown);
        if !allowed {
            return;
        }
        self.last_managed_restart = Some(now);
        self.shared
            .log_line(&format!("{} device_restart_ours", self.wall.unix_ms()));
        let _ = self.driver.restart_inherited_ours();
        self.rescan_with(true);
    }

    fn restart_managed_if_allowed(&mut self) {
        if !self.driver.is_managed() {
            return;
        }
        let now = Instant::now();
        let allowed = self
            .last_managed_restart
            .is_none_or(|last| now.duration_since(last) >= self.options.managed_restart_cooldown);
        if allowed {
            self.last_managed_restart = Some(now);
            let _ = self.driver.restart();
        }
    }

    fn rescan(&mut self) {
        self.rescan_with(false);
    }

    /// `full` is only set by an explicit user retry; automatic rescans keep
    /// probing the configured external address after it disappeared (PLAYER §4).
    fn rescan_with(&mut self, full: bool) {
        if self.prepared.is_none() {
            return;
        }
        let status = if full {
            self.driver.status_full()
        } else {
            self.driver.status()
        };
        match status {
            DriverStatus::Running {
                addr,
                version,
                port,
            } => {
                self.set_openrgb(&version, port);
                self.connect_and_detect(addr, false);
            }
            DriverStatus::Blocked => {
                self.driver_error = DriverFailure::Blocked.code();
                self.shared.add_error(self.wall.unix_ms(), "driver_blocked");
                self.set_state(PlayerState::Blocked, None);
            }
            DriverStatus::Missing => {
                if self.state != PlayerState::NeedsDriver {
                    self.enter_backend_unresponsive(false);
                }
            }
        }
    }

    fn stop(&mut self) {
        self.driver.cancel_install();
        self.install_in_progress = false;
        self.driver_progress = -1;
        if self.state == PlayerState::NeedsDriver && self.ack_ctx.is_some() {
            self.maybe_ack_failed(FailureCode::DriverDeclined);
            self.end_with(PlayerState::Idle, Some(FailureCode::DriverDeclined));
            return;
        }
        self.stop_playback();
        self.generation += 1;
        self.clear_current();
        self.set_state(PlayerState::Idle, None);
    }

    fn retry(&mut self) {
        match self.state {
            PlayerState::NeedsDriver => self.proceed_driver(),
            PlayerState::NoKeyboard | PlayerState::BackendUnresponsive => {
                self.recover_absent_keyboard(true, true);
            }
            PlayerState::VendorConflict => {
                if self.conflicts.detect(&self.config.platform).is_some() {
                    self.rescan_with(true);
                } else {
                    self.conflict_name = None;
                    self.rescan_with(true);
                }
            }
            PlayerState::Blocked => {
                self.driver_error = 0;
                match self.driver.restart() {
                    Ok(()) => self.proceed_driver(),
                    Err(failure) => {
                        self.driver_error = failure.code();
                        self.shared
                            .add_error(self.wall.unix_ms(), failure.diagnostic_code());
                    }
                }
            }
            _ => {}
        }
    }

    fn install_driver(&mut self) {
        if self.state != PlayerState::NeedsDriver || self.install_in_progress {
            return;
        }
        self.install_in_progress = true;
        self.driver_progress = 0;
        self.driver_error = 0;
        self.publish_state();
        self.shared.log_line(&format!(
            "{} driver_install_start variant={}",
            self.wall.unix_ms(),
            self.driver.info().variant
        ));
        let driver = Arc::clone(&self.driver);
        let tx = self.tx.clone();
        thread::spawn(move || {
            let event = match driver.install() {
                InstallResult::Installed => DriverEvent::Installed {
                    version: driver.info().version,
                },
                InstallResult::Failed(failure) => DriverEvent::InstallFailed(failure),
                InstallResult::Cancelled => DriverEvent::InstallCancelled,
            };
            let _ = tx.send(ServiceCommand::DriverEvent(event));
        });
    }

    fn restart_backend(&mut self) {
        self.shared
            .log_line(&format!("{} driver_restart", self.wall.unix_ms()));
        match self.driver.restart() {
            Ok(()) => {
                self.driver_error = 0;
            }
            Err(failure) => {
                self.driver_error = failure.code();
                self.shared
                    .add_error(self.wall.unix_ms(), failure.diagnostic_code());
                if failure == DriverFailure::Blocked {
                    self.set_state(PlayerState::Blocked, None);
                }
                return;
            }
        }
        match self.state {
            PlayerState::Playing => {
                self.stop_playback_abandon();
                self.rescan();
            }
            PlayerState::NoKeyboard
            | PlayerState::BackendUnresponsive
            | PlayerState::VendorConflict => self.rescan(),
            _ => {}
        }
    }

    fn on_driver_event(&mut self, event: DriverEvent) {
        match event {
            DriverEvent::Progress(progress) => {
                if self.state == PlayerState::NeedsDriver
                    || self.install_in_progress
                    || self.driver_progress >= 0
                {
                    self.driver_progress = progress;
                    self.publish_state();
                }
            }
            DriverEvent::InstallFailed(failure) => {
                self.install_in_progress = false;
                self.driver_progress = -1;
                self.driver_error = failure.code();
                self.shared
                    .add_error(self.wall.unix_ms(), failure.diagnostic_code());
                self.shared.log_line(&format!(
                    "{} driver_install_failed code={}",
                    self.wall.unix_ms(),
                    failure.diagnostic_code()
                ));
                if failure == DriverFailure::Blocked {
                    self.set_state(PlayerState::Blocked, None);
                } else {
                    self.set_state(PlayerState::NeedsDriver, None);
                }
            }
            DriverEvent::Installed { .. } => {
                self.install_in_progress = false;
                self.driver_progress = -1;
                self.driver_error = 0;
                self.shared.log_line(&format!(
                    "{} driver_install_ok version={}",
                    self.wall.unix_ms(),
                    self.driver.info().version
                ));
                self.publish_state();
                if self.prepared.is_some() {
                    self.proceed_driver();
                }
            }
            DriverEvent::InstallCancelled => {
                self.install_in_progress = false;
                self.driver_progress = -1;
                self.publish_state();
            }
            DriverEvent::Launched { addr, version } => {
                self.shared.log_line(&format!(
                    "{} driver_launch port={}",
                    self.wall.unix_ms(),
                    addr.port()
                ));
                self.set_openrgb(&version, addr.port());
                if matches!(
                    self.state,
                    PlayerState::NoKeyboard
                        | PlayerState::BackendUnresponsive
                        | PlayerState::VendorConflict
                ) {
                    self.rescan();
                }
                self.publish_state();
            }
            DriverEvent::Crashed => {
                self.shared.add_error(self.wall.unix_ms(), "driver_crashed");
                self.shared
                    .log_line(&format!("{} driver_crashed", self.wall.unix_ms()));
                self.publish_state();
            }
            DriverEvent::Blocked => {
                self.driver_error = DriverFailure::Blocked.code();
                self.shared.add_error(self.wall.unix_ms(), "driver_blocked");
                self.set_state(PlayerState::Blocked, None);
            }
            DriverEvent::GaveUp => {
                self.shared.add_error(self.wall.unix_ms(), "driver_crashed");
                self.shared
                    .log_line(&format!("{} driver_gave_up", self.wall.unix_ms()));
                if self.prepared.is_some() {
                    self.enter_backend_unresponsive(false);
                } else {
                    // Let the shell re-read driver info and show `gaveUp` even
                    // while no effect is prepared.
                    self.publish_state();
                }
            }
        }
    }

    fn stop_playback(&mut self) {
        self.stop_playback_with(false);
    }

    fn stop_playback_abandon(&mut self) {
        self.stop_playback_with(true);
    }

    fn stop_playback_with(&mut self, abandon: bool) {
        if let Some(mut handle) = self.playback.take() {
            if abandon {
                handle.abandon.store(true, Ordering::SeqCst);
            }
            handle.stop.store(true, Ordering::SeqCst);
            if let Some(join) = handle.join.take() {
                let _ = join.join();
            }
        }
    }

    fn join_playback(&mut self) {
        if let Some(mut handle) = self.playback.take() {
            handle.stop.store(true, Ordering::SeqCst);
            if let Some(join) = handle.join.take() {
                let _ = join.join();
            }
        }
    }

    fn end_with(&mut self, state: PlayerState, error: Option<FailureCode>) {
        self.stop_playback();
        self.clear_current();
        self.set_state(state, error);
    }

    fn maybe_ack(
        &mut self,
        result: PlayResult,
        code: Option<FailureCode>,
        keyboard: Option<PlayKeyboard>,
    ) {
        let Some(context) = self.ack_ctx.as_ref() else {
            return;
        };
        let now = self.wall.unix_ms() as i64;
        if now > context.deadline {
            return;
        }
        let key = (result, code);
        if self.last_ack == Some(key) {
            return;
        }
        self.last_ack = Some(key);

        let token = context.token.clone();
        let deadline = context.deadline;
        let api_base = context.api_base.clone();
        let body = match result {
            PlayResult::Playing => AckBody::playing(keyboard),
            PlayResult::NeedsDriver => AckBody::needs_driver(),
            PlayResult::NoKeyboard => AckBody::no_keyboard(),
            PlayResult::Failed => AckBody::failed(code.unwrap_or(FailureCode::Internal)),
        };
        self.ack_worker.send(token, body, deadline, api_base);
    }

    fn maybe_ack_failed(&mut self, code: FailureCode) {
        self.maybe_ack(PlayResult::Failed, Some(code), None);
    }
}

#[allow(dead_code)]
fn support_rank(support: Support) -> u8 {
    match support {
        Support::PerKey => 3,
        Support::Zones => 2,
        Support::Single => 1,
    }
}

/// Pick among per-key keyboards already sorted in OpenRGB order.
///
/// An explicit user pick wins when that board is present. Otherwise stay on
/// the board this session was already playing (name or VID:PID). If that
/// board is gone, return `None` so the Player shows no-keyboard / recovering
/// instead of silently driving a different keyboard. A different board is
/// only chosen when the user picks it, or when this is a fresh start and
/// exactly one supported keyboard is attached.
fn choose_keyboard(
    supported: &[Selection],
    preferred: Option<&str>,
    current: &str,
) -> Option<Selection> {
    if supported.is_empty() {
        return None;
    }
    if let Some(name) = preferred {
        if let Some(found) = find_keyboard(supported, name) {
            return Some(found);
        }
        if current.is_empty() {
            return None;
        }
    }
    if !current.is_empty() {
        return find_keyboard(supported, current);
    }
    if supported.len() == 1 {
        return supported.first().cloned();
    }
    None
}

fn find_keyboard(supported: &[Selection], target: &str) -> Option<Selection> {
    supported
        .iter()
        .find(|item| keyboard_matches(&item.data, target))
        .cloned()
}

fn keyboard_matches(data: &crate::openrgb::ControllerData, target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    if data.name == target {
        return true;
    }
    let (want_vid, want_pid) = crate::diagnostics::parse_vid_pid(target);
    if want_vid == 0 || want_pid == 0 {
        return false;
    }
    for source in [&data.location, &data.name, &data.vendor] {
        let (vid, pid) = crate::diagnostics::parse_vid_pid(source);
        if vid == want_vid && pid == want_pid {
            return true;
        }
    }
    false
}

fn is_unsupported_package_error(error: &HostError) -> bool {
    matches!(error, HostError::Decode(message) if message.contains("incompatible package"))
}

fn version_gt(min: &str, app: &str) -> bool {
    match (semver::Version::parse(min), semver::Version::parse(app)) {
        (Ok(min), Ok(app)) => min > app,
        _ => false,
    }
}

/// Convenience for callers that only have a string address.
pub fn parse_openrgb_addr(value: &str) -> Result<SocketAddr, std::net::AddrParseError> {
    value.parse()
}

#[cfg(test)]
mod keyboard_choice_tests {
    use super::{choose_keyboard, Selection};
    use crate::layout::{Mapping, MappingKind, Support};
    use crate::openrgb::ControllerData;

    fn selection(name: &str, index: u32) -> Selection {
        Selection {
            index,
            data: ControllerData {
                kind: 5,
                name: name.to_string(),
                vendor: String::new(),
                description: String::new(),
                version: String::new(),
                serial: String::new(),
                location: String::new(),
                active_mode: 0,
                modes: vec![],
                zones: vec![],
                leds: vec![],
                colors: vec![],
            },
            mapping: Mapping {
                support: Support::PerKey,
                kind: MappingKind::Single,
                unmapped_leds: 0,
                matched_keys: 1,
            },
        }
    }

    #[test]
    fn choose_keyboard_picks_the_only_keyboard_at_fresh_start() {
        let list = vec![selection("A", 0)];
        let chosen = choose_keyboard(&list, None, "").unwrap();
        assert_eq!(chosen.data.name, "A");
    }

    #[test]
    fn choose_keyboard_does_not_pick_among_several_at_fresh_start() {
        let list = vec![selection("A", 0), selection("B", 1)];
        assert!(choose_keyboard(&list, None, "").is_none());
    }

    #[test]
    fn choose_keyboard_prefers_remembered() {
        let list = vec![selection("A", 0), selection("B", 1)];
        let chosen = choose_keyboard(&list, Some("B"), "A").unwrap();
        assert_eq!(chosen.data.name, "B");
    }

    #[test]
    fn choose_keyboard_keeps_current_when_preferred_missing() {
        let list = vec![selection("A", 0), selection("B", 1)];
        let chosen = choose_keyboard(&list, Some("Gone"), "B").unwrap();
        assert_eq!(chosen.data.name, "B");
    }

    #[test]
    fn choose_keyboard_does_not_switch_when_current_is_gone() {
        let list = vec![selection("A", 0), selection("B", 1)];
        assert!(choose_keyboard(&list, None, "Missing").is_none());
        assert!(choose_keyboard(&list, Some("Gone"), "Missing").is_none());
        // Even the only remaining board must not silently replace the bound one.
        let only_other = vec![selection("A", 0)];
        assert!(choose_keyboard(&only_other, None, "Missing").is_none());
    }

    #[test]
    fn choose_keyboard_matches_current_by_vid_pid_when_the_name_changes() {
        let mut board = selection("RGB Keyboard", 0);
        board.data.location = "HID: 320F:5000".to_string();
        let list = vec![board, selection("Other Board", 1)];
        let chosen = choose_keyboard(&list, None, "EVision Keyboard 320F:5000").unwrap();
        assert_eq!(chosen.data.name, "RGB Keyboard");
    }
}
