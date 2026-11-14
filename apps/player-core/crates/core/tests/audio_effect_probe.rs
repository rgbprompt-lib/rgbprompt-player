//! Opt-in timing probe for the audio-reactive built-in presets: runs the real
//! playback steps (AudioAnalyzer -> step_keys -> limit) with a 48 kHz signal
//! and reports per-step time and the first error. Diagnostic only.
//! `cargo test --test audio_effect_probe -- --ignored --nocapture`
use std::time::{Duration, Instant};

use rgbprompt_player_core::engine_host::{AudioSample, KeyEvent};
use rgbprompt_player_core::{AudioAnalyzer, AudioRing, EngineHost, HostLimits};

const PRESETS: &[(&str, &[u8])] = &[
    (
        "04-fingertip-ripple",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../player-mac/Resources/Presets/04-fingertip-ripple.lep"
        )),
    ),
    (
        "07-music-spectrum",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../player-mac/Resources/Presets/07-music-spectrum.lep"
        )),
    ),
    (
        "08-mirror-spectrum",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../player-mac/Resources/Presets/08-mirror-spectrum.lep"
        )),
    ),
];

#[test]
#[ignore]
fn audio_presets_step_within_budget() {
    let limits = HostLimits::default();
    for (name, lep) in PRESETS {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let program = host.decode(lep).expect("decode");
        let wanted = host.input_wanted(&program).expect("wanted");
        let renderer = host.renderer(&program).expect("renderer");
        let limiter = host.limiter().expect("limiter");
        let ring = AudioRing::new();
        let mut analyzer = AudioAnalyzer::new(ring.clone());
        let mut worst = Duration::ZERO;
        let mut total = Duration::ZERO;
        let mut first_error = None;
        let steps: u32 = 75;
        for step in 0..steps {
            let t_ms = step as f64 * 40.0;
            // 40 ms of a 220 Hz + 2 kHz stereo signal at 48 kHz.
            let frames = 1920;
            let mut pcm = Vec::with_capacity(frames * 2);
            for i in 0..frames {
                let s = (step as usize * frames + i) as f32 / 48_000.0;
                let v = 0.4 * (s * 220.0 * std::f32::consts::TAU).sin()
                    + 0.2 * (s * 2000.0 * std::f32::consts::TAU).sin();
                pcm.push(v);
                pcm.push(v);
            }
            ring.push(&pcm, frames, 2, 48_000.0);
            let keys: Vec<KeyEvent> = if step % 10 == 0 {
                vec![KeyEvent {
                    t: t_ms,
                    down: true,
                    cell: "3,5".into(),
                }]
            } else {
                Vec::new()
            };
            let started = Instant::now();
            let bands = analyzer.bands(&host).expect("bands");
            let audio = vec![AudioSample {
                t: t_ms,
                bands: Some(bands.to_vec()),
            }];
            let result = host
                .step_keys(&renderer, t_ms, &keys, &audio)
                .and_then(|frame| host.limit(&limiter, &frame, 40.0));
            let elapsed = started.elapsed();
            worst = worst.max(elapsed);
            total += elapsed;
            if let Err(error) = result {
                first_error = Some(format!("step {step}: {error} after {elapsed:?}"));
                break;
            }
        }
        eprintln!(
            "{name}: wanted={wanted} avg={:?} worst={worst:?} budget={:?} error={}",
            total / steps,
            limits.step_budget,
            first_error.as_deref().unwrap_or("none")
        );
    }
}

/// Real-time variant: 25 fps pacing like PlaybackState, a capture thread
/// pushing 10 ms of 48 kHz PCM like WASAPI, and an optional busy thread
/// (`RGBP_PROBE_BURNERS`) standing in for the shell. Prints the first error.
#[test]
#[ignore]
fn audio_presets_survive_real_time_playback() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    let seconds: u64 = std::env::var("RGBP_PROBE_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    let burners: usize = std::env::var("RGBP_PROBE_BURNERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    for (name, lep) in PRESETS {
        let stop = Arc::new(AtomicBool::new(false));
        let mut threads = Vec::new();
        for _ in 0..burners {
            let stop = stop.clone();
            threads.push(std::thread::spawn(move || {
                let mut x = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
                }
                std::hint::black_box(x);
            }));
        }
        let ring = AudioRing::new();
        {
            let ring = ring.clone();
            let stop = stop.clone();
            threads.push(std::thread::spawn(move || {
                let mut n = 0usize;
                let started = Instant::now();
                let mut chunk = 0u32;
                while !stop.load(Ordering::Relaxed) {
                    let frames = 480;
                    let mut pcm = Vec::with_capacity(frames * 2);
                    for i in 0..frames {
                        let s = (n + i) as f32 / 48_000.0;
                        let v = 0.4 * (s * 110.0 * std::f32::consts::TAU).sin()
                            + 0.2 * (s * 3000.0 * std::f32::consts::TAU).sin();
                        pcm.push(v);
                        pcm.push(v);
                    }
                    n += frames;
                    ring.push(&pcm, frames, 2, 48_000.0);
                    chunk += 1;
                    let due = started + Duration::from_millis(10 * chunk as u64);
                    if let Some(wait) = due.checked_duration_since(Instant::now()) {
                        std::thread::sleep(wait);
                    }
                }
            }));
        }
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let setup = Instant::now();
        let program = host.decode(lep).expect("decode");
        let renderer = host.renderer(&program).expect("renderer");
        let limiter = host.limiter().expect("limiter");
        let setup = setup.elapsed();
        let mut analyzer = AudioAnalyzer::new(ring.clone());
        let start = Instant::now();
        let mut deadline = start;
        let period = Duration::from_millis(40);
        let mut last: Option<f64> = None;
        let (mut steps, mut worst_step, mut worst_bands) = (0u32, Duration::ZERO, Duration::ZERO);
        let mut first_error = None;
        while start.elapsed() < Duration::from_secs(seconds) {
            if let Some(wait) = deadline.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            let now = Instant::now();
            deadline = if now > deadline + period {
                now + period
            } else {
                deadline + period
            };
            let t_ms = (now - start).as_secs_f64() * 1000.0;
            let dt = last.map(|l| (t_ms - l).max(0.0)).unwrap_or(40.0);
            last = Some(t_ms);
            let b0 = Instant::now();
            let bands = analyzer.bands(&host).expect("bands");
            worst_bands = worst_bands.max(b0.elapsed());
            let audio = vec![AudioSample {
                t: t_ms,
                bands: Some(bands.to_vec()),
            }];
            let s0 = Instant::now();
            let frame = host.step_keys(&renderer, t_ms, &[], &audio);
            let step_time = s0.elapsed();
            let result = frame.and_then(|f| host.limit(&limiter, &f, dt).map(|_| ()));
            let total = s0.elapsed();
            worst_step = worst_step.max(total);
            steps += 1;
            if let Err(error) = result {
                first_error = Some(format!(
                    "step {steps} t={t_ms:.0}ms: {error:?} (step_keys {step_time:?}, total {total:?})"
                ));
                break;
            }
        }
        stop.store(true, Ordering::Relaxed);
        for thread in threads {
            let _ = thread.join();
        }
        eprintln!(
            "rt {name}: burners={burners} setup={setup:?} steps={steps} worst_step={worst_step:?} worst_bands={worst_bands:?} error={}",
            first_error.as_deref().unwrap_or("none")
        );
    }
}
