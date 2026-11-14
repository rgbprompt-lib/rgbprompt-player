//! 25 fps playback loop (adaptive 15 fps) on the thread that owns the QuickJS
//! runtime (PLAYER §5, §9.0.5).
//!
//! The loop is split into `run_once` so tests can drive it with a fake clock.
//! Every frame goes engine -> limiter -> preview -> mapping -> brightness ->
//! `UpdateLEDs`; the limiter is unconditionally in the path.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::audio::AudioAnalyzer;
use crate::clock::Clock;
use crate::device_health::LocationLiveProbe;
use crate::engine_host::{
    AudioSample, EngineHost, KeyEvent, LimiterHandle, RendererHandle, KEY_RGB_BYTES,
};
use crate::layout::{detect, DeviceDb, Mapping};
use crate::openrgb::DirectSession;
use crate::output::OutputStage;

pub const FPS_HIGH: u32 = 25;
pub const FPS_LOW: u32 = 15;
pub const PERIOD_HIGH: Duration = Duration::from_millis(40);
/// 66.67 ms tracked in microseconds so schedules do not drift.
pub const PERIOD_LOW: Duration = Duration::from_micros(66_667);
const LATENCY_WINDOW: usize = 10;
const HIGH_TO_LOW_MS: u128 = 30;
const LOW_TO_HIGH_MS: u128 = 20;
const LOW_RECOVERY: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaybackFailure {
    DeviceLost,
    OpenRgbUnreachable,
    /// OpenRGB still lists the controller, but its HID handle is dead.
    DeviceStale,
    Internal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaybackEvent {
    FpsChanged(u32),
    Failed(PlaybackFailure),
}

/// Latest limited key frame, pulled by the shell through `rgbp_preview_frame`.
pub struct PreviewFrame {
    seq: AtomicU64,
    data: Mutex<[u8; KEY_RGB_BYTES]>,
}

impl PreviewFrame {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            seq: AtomicU64::new(0),
            data: Mutex::new([0u8; KEY_RGB_BYTES]),
        })
    }

    pub fn store(&self, frame: &[u8]) -> u64 {
        if let Ok(mut data) = self.data.lock() {
            let count = frame.len().min(KEY_RGB_BYTES);
            data[..count].copy_from_slice(&frame[..count]);
        }
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn snapshot(&self, out: &mut [u8; KEY_RGB_BYTES]) -> u64 {
        if let Ok(data) = self.data.lock() {
            out.copy_from_slice(&data[..]);
        }
        self.seq.load(Ordering::SeqCst)
    }

    pub fn clear(&self) {
        self.store(&[0u8; KEY_RGB_BYTES]);
    }

    pub fn seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }
}

impl Default for PreviewFrame {
    fn default() -> Self {
        Self {
            seq: AtomicU64::new(0),
            data: Mutex::new([0u8; KEY_RGB_BYTES]),
        }
    }
}

/// Key events from the shell thread. Bounded: the oldest events are dropped.
pub struct KeyQueue {
    items: Mutex<VecDeque<KeyEvent>>,
}

impl KeyQueue {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            items: Mutex::new(VecDeque::with_capacity(256)),
        })
    }

    pub fn push(&self, event: KeyEvent) {
        let Ok(mut items) = self.items.lock() else {
            return;
        };
        if items.len() >= 256 {
            items.pop_front();
        }
        items.push_back(event);
    }

    pub fn drain(&self) -> Vec<KeyEvent> {
        let Ok(mut items) = self.items.lock() else {
            return Vec::new();
        };
        items.drain(..).collect()
    }
}

pub struct PlaybackSetup {
    pub session: DirectSession,
    pub mapping: Mapping,
    pub controller_name: String,
    pub controller_location: String,
    pub preview: Arc<PreviewFrame>,
    pub keys: Arc<KeyQueue>,
    pub audio: AudioAnalyzer,
    pub clock: Arc<dyn Clock>,
    pub brightness: Arc<AtomicU32>,
    pub fps: Arc<AtomicU32>,
    /// Test-only latency injection, measured through the injected clock.
    pub write_latency: Duration,
    /// Set by the service when the loop is stopped because the backend or the
    /// device went away: leave the keyboard lights as they are (PLAYER §5).
    pub abandon: Arc<AtomicBool>,
    /// Reports whether the OpenRGB location still names a live HID device.
    pub location_live: LocationLiveProbe,
}

pub struct PlaybackState<'a> {
    host: &'a EngineHost,
    renderer: &'a RendererHandle<'a>,
    limiter: &'a LimiterHandle<'a>,
    session: DirectSession,
    mapping: Mapping,
    controller_name: String,
    controller_location: String,
    preview: Arc<PreviewFrame>,
    keys: Arc<KeyQueue>,
    audio: AudioAnalyzer,
    clock: Arc<dyn Clock>,
    brightness: Arc<AtomicU32>,
    fps: Arc<AtomicU32>,
    write_latency: Duration,
    abandon: Arc<AtomicBool>,
    location_live: LocationLiveProbe,
    output: OutputStage,
    start: Duration,
    next_deadline: Duration,
    period: Duration,
    last_t_ms: Option<f64>,
    latencies: VecDeque<Duration>,
    /// When the 15 fps window median first stayed below 20 ms; reset on any
    /// window at or above 20 ms.
    recovery_since: Option<Duration>,
    pending_fps: Option<u32>,
    finished: Option<PlaybackFailure>,
    dropped_frames: u64,
    frames_since_health: u64,
}

impl<'a> PlaybackState<'a> {
    pub fn new(
        host: &'a EngineHost,
        renderer: &'a RendererHandle<'a>,
        limiter: &'a LimiterHandle<'a>,
        setup: PlaybackSetup,
    ) -> Self {
        let now = setup.clock.now();
        let brightness = setup.brightness.load(Ordering::Relaxed).clamp(10, 100) as u8;
        setup.fps.store(FPS_HIGH, Ordering::Relaxed);
        Self {
            host,
            renderer,
            limiter,
            session: setup.session,
            mapping: setup.mapping,
            controller_name: setup.controller_name,
            controller_location: setup.controller_location,
            preview: setup.preview,
            keys: setup.keys,
            audio: setup.audio,
            clock: setup.clock,
            brightness: setup.brightness,
            fps: setup.fps,
            write_latency: setup.write_latency,
            abandon: setup.abandon,
            location_live: setup.location_live,
            output: OutputStage::new(brightness),
            start: now,
            next_deadline: now,
            period: PERIOD_HIGH,
            last_t_ms: None,
            latencies: VecDeque::with_capacity(LATENCY_WINDOW),
            recovery_since: None,
            pending_fps: None,
            finished: None,
            dropped_frames: 0,
            frames_since_health: 0,
        }
    }

    pub fn fps(&self) -> u32 {
        self.fps.load(Ordering::Relaxed)
    }

    pub fn dropped_frames(&self) -> u64 {
        self.dropped_frames
    }

    /// Run one scheduled frame. Returns a failure that stops playback.
    pub fn run_once(&mut self) {
        self.clock.sleep_until(self.next_deadline);
        let now = self.clock.now();
        if now > self.next_deadline + self.period {
            self.next_deadline = now + self.period;
            self.dropped_frames += 1;
        } else {
            self.next_deadline += self.period;
        }
        if let Some(failure) = self.step_once() {
            self.finished = Some(failure);
        }
    }

    /// Step the engine at the current clock time and write one frame.
    pub fn step_once(&mut self) -> Option<PlaybackFailure> {
        if let Some(failure) = self.check_device_change() {
            return Some(failure);
        }

        let now = self.clock.now();
        let t_ms = (now - self.start).as_secs_f64() * 1000.0;
        let dt_ms = match self.last_t_ms {
            Some(last) => (t_ms - last).max(0.0),
            None => self.period.as_secs_f64() * 1000.0,
        };
        self.last_t_ms = Some(t_ms);

        let mut keys = self.keys.drain();
        // The shell only supplies name + direction; stamp drained events at the
        // frame they are applied, like the web's per-frame drain.
        for key in &mut keys {
            key.t = t_ms;
        }
        let audio = match self.audio.bands(self.host) {
            Ok(bands) => vec![AudioSample {
                t: t_ms,
                bands: Some(bands.to_vec()),
            }],
            Err(_) => Vec::new(),
        };

        let key_frame = match self.host.step_keys(self.renderer, t_ms, &keys, &audio) {
            Ok(frame) => frame,
            Err(_) => return Some(PlaybackFailure::Internal),
        };
        let limited = match self.host.limit(self.limiter, &key_frame, dt_ms) {
            Ok(frame) => frame,
            Err(_) => return Some(PlaybackFailure::Internal),
        };
        self.preview.store(&limited);

        let brightness = self.brightness.load(Ordering::Relaxed).clamp(10, 100) as u8;
        if brightness != self.output.brightness_pct() {
            self.output = OutputStage::new(brightness);
        }
        let mut leds = self.mapping.map(&limited);
        self.output.apply(&mut leds);

        let write_start = self.clock.now();
        let result = self.session.write(&leds);
        if !self.write_latency.is_zero() {
            self.clock
                .sleep_until(self.clock.now() + self.write_latency);
        }
        let elapsed = self.clock.now().saturating_sub(write_start);

        match result {
            Ok(()) => {
                self.record_latency(elapsed);
                self.frames_since_health = self.frames_since_health.saturating_add(1);
                // Stale OpenRGB can accept UpdateLEDs but stop talking on
                // request/response packets, or keep a dead HID handle while
                // TCP still works. Probe every ~3 s (25 fps), and on the
                // first frame so a stale handle never looks "playing".
                if self.frames_since_health == 1 {
                    // First frame: only the HID-location check. Do not add a
                    // controller_count request; connect already talked to the
                    // SDK, and existing tests treat extra counts as watcher ticks.
                    if !self.location_live.is_live(&self.controller_location) {
                        return Some(PlaybackFailure::DeviceStale);
                    }
                } else if self.frames_since_health >= 75 {
                    self.frames_since_health = 0;
                    if self.session.controller_count().is_err() {
                        return Some(PlaybackFailure::OpenRgbUnreachable);
                    }
                    if !self.location_live.is_live(&self.controller_location) {
                        return Some(PlaybackFailure::DeviceStale);
                    }
                }
                None
            }
            Err(_) => Some(PlaybackFailure::OpenRgbUnreachable),
        }
    }

    fn check_device_change(&mut self) -> Option<PlaybackFailure> {
        let flagged = self.session.take_device_list_changed();
        let polled = match self.session.poll_device_list_changed() {
            Ok(value) => value,
            Err(_) => return Some(PlaybackFailure::OpenRgbUnreachable),
        };
        if !flagged && !polled {
            return None;
        }

        let count = match self.session.controller_count() {
            Ok(count) => count,
            Err(_) => return Some(PlaybackFailure::DeviceLost),
        };
        let mut exact = None;
        let mut same_name_live = None;
        let mut same_name_stale = false;
        for index in 0..count {
            match self.session.controller_data(index) {
                Ok(data) => {
                    if data.name != self.controller_name {
                        continue;
                    }
                    let live = self.location_live.is_live(&data.location);
                    if data.location == self.controller_location {
                        if live {
                            exact = Some((index, data));
                        } else {
                            same_name_stale = true;
                        }
                    } else if live && same_name_live.is_none() {
                        same_name_live = Some((index, data));
                    } else if !live {
                        same_name_stale = true;
                    }
                }
                Err(_) => return Some(PlaybackFailure::DeviceLost),
            }
        }
        let Some((index, data)) = exact.or(same_name_live) else {
            return Some(if same_name_stale {
                PlaybackFailure::DeviceStale
            } else {
                PlaybackFailure::DeviceLost
            });
        };
        self.rebind_to(index, data)
    }

    fn rebind_to(
        &mut self,
        index: u32,
        data: crate::openrgb::ControllerData,
    ) -> Option<PlaybackFailure> {
        let mapping = match detect(
            &data,
            DeviceDb::embedded(),
            self.host.key_names(),
            self.host.key_centres_quarter(),
        ) {
            Ok(mapping) => mapping,
            Err(_) => return Some(PlaybackFailure::DeviceLost),
        };
        if index != self.session.index() && self.session.rebind(index).is_err() {
            return Some(PlaybackFailure::DeviceLost);
        }
        self.controller_name = data.name.clone();
        self.controller_location = data.location.clone();
        self.mapping = mapping;
        None
    }

    fn record_latency(&mut self, elapsed: Duration) {
        if self.latencies.len() == LATENCY_WINDOW {
            self.latencies.pop_front();
        }
        self.latencies.push_back(elapsed);
        if self.latencies.len() < LATENCY_WINDOW {
            return;
        }
        let mut sorted: Vec<Duration> = self.latencies.iter().copied().collect();
        sorted.sort_unstable();
        let median = sorted[sorted.len() / 2];
        let now = self.clock.now();
        let fast = Duration::from_millis(LOW_TO_HIGH_MS as u64);
        if self.fps() == FPS_HIGH {
            if median > Duration::from_millis(HIGH_TO_LOW_MS as u64) {
                self.switch_fps(FPS_LOW, PERIOD_LOW);
            }
        } else if median < fast {
            // Recovery needs a continuous 5 s run of below-20 ms windows.
            match self.recovery_since {
                None => self.recovery_since = Some(now),
                Some(since) if now >= since + LOW_RECOVERY => {
                    self.switch_fps(FPS_HIGH, PERIOD_HIGH);
                }
                Some(_) => {}
            }
        } else {
            self.recovery_since = None;
        }
    }

    fn switch_fps(&mut self, fps: u32, period: Duration) {
        self.fps.store(fps, Ordering::Relaxed);
        self.period = period;
        self.recovery_since = None;
        self.pending_fps = Some(fps);
    }

    /// Advance by `duration` without ending the session. Tests use
    /// this to model a latency change mid-session.
    pub fn advance_for(&mut self, duration: Duration) -> Option<PlaybackFailure> {
        let until = self.clock.now() + duration;
        while self.finished.is_none() && self.next_deadline < until {
            self.run_once();
        }
        if self.finished.is_some() {
            self.finish();
        }
        self.finished
    }

    pub fn set_write_latency(&mut self, latency: Duration) {
        self.write_latency = latency;
    }

    pub fn finish_session(&mut self) {
        self.finish();
    }

    /// Run until `duration` of (fake or real) time has elapsed.
    pub fn run_for(&mut self, duration: Duration) -> Option<PlaybackFailure> {
        let until = self.start + duration;
        while self.finished.is_none() && self.next_deadline < until {
            self.run_once();
        }
        self.finish();
        self.finished
    }

    /// Production loop: runs until the stop flag is set or a failure occurs.
    pub fn run(
        &mut self,
        stop: &AtomicBool,
        emit: &mut dyn FnMut(PlaybackEvent),
    ) -> Option<PlaybackFailure> {
        while !stop.load(Ordering::Relaxed) && self.finished.is_none() {
            self.run_once();
            if let Some(fps) = self.pending_fps.take() {
                emit(PlaybackEvent::FpsChanged(fps));
            }
        }
        self.finish();
        if let Some(failure) = self.finished {
            emit(PlaybackEvent::Failed(failure));
        }
        self.finished
    }

    fn finish(&mut self) {
        if self.finished.is_some() || self.abandon.load(Ordering::Relaxed) {
            // PLAYER §5: on a backend/device error leave the keyboard as it is.
            self.session.abandon();
        } else {
            let _ = self.session.end();
        }
        self.preview.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_frame_sequences() {
        let preview = PreviewFrame::new();
        assert_eq!(preview.seq(), 0);
        let mut out = [0u8; KEY_RGB_BYTES];
        assert_eq!(preview.snapshot(&mut out), 0);
        assert_eq!(preview.store(&[1u8; KEY_RGB_BYTES]), 1);
        assert_eq!(preview.snapshot(&mut out), 1);
        assert_eq!(out[0], 1);
        preview.clear();
        assert_eq!(preview.seq(), 2);
        preview.snapshot(&mut out);
        assert_eq!(out, [0u8; KEY_RGB_BYTES]);
    }

    #[test]
    fn key_queue_is_bounded() {
        let queue = KeyQueue::new();
        for index in 0..300 {
            queue.push(KeyEvent {
                t: index as f64,
                down: true,
                cell: "0,0".to_string(),
            });
        }
        let drained = queue.drain();
        assert_eq!(drained.len(), 256);
        assert_eq!(drained.first().unwrap().t, 44.0);
    }
}
