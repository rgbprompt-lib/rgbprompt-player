//! System-audio analysis ported from KeyboardAgent's SpectrumAnalyzer.
//!
//! Capture stays Process Tap (shell). Analysis matches KeyboardAgent so system
//! playback shows rhythmic dynamics: hop 512 @ 48 kHz (~93 Hz), Hann window,
//! log band edges, low-shelf tilt, dB window (−62…0), soft knee (^0.93), AGC,
//! per-band noise gate, fast attack / slow release. Output is 22 bands (0…255)
//! for the engine; KeyboardAgent's 24→22 linear resample is applied last.
//!
//! Constants are mirrored in apps/web/.../keyboard-agent-spectrum.ts for
//! WYSIWYG web preview. Do not edit the keybord project copy.
use std::collections::VecDeque;
use std::f32::consts::PI;
use std::sync::{Arc, Mutex};

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};

use crate::engine_host::{EngineHost, HostError};

pub const AUDIO_FFT_SIZE: usize = 2048;
pub const AUDIO_HOP_SIZE: usize = 512;
pub const AUDIO_BAND_COUNT: usize = 22;
pub const AUDIO_KA_BAND_COUNT: usize = 24;
pub const AUDIO_SMOOTHING_TIME_CONSTANT: f32 = 0.8; // legacy export; unused by KA path
const MAX_CHANNELS: usize = 8;
const RING_CAPACITY: usize = AUDIO_FFT_SIZE * MAX_CHANNELS;
const KA_SAMPLE_RATE: f32 = 48_000.0;
const AGC_TARGET: f32 = 0.72;
const HOLD_LIMIT: i32 = 4;

/// Interleaved PCM ring. `push` never allocates (capacity is fixed) and never
/// blocks: if another thread holds the lock the samples are dropped.
pub struct AudioRing {
    inner: Mutex<Ring>,
}

struct Ring {
    samples: VecDeque<f32>,
    channels: usize,
    sample_rate: f64,
}

impl AudioRing {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Ring {
                samples: VecDeque::with_capacity(RING_CAPACITY),
                channels: 1,
                sample_rate: 0.0,
            }),
        })
    }

    pub fn push(&self, interleaved: &[f32], frames: usize, channels: u16, sample_rate: f64) {
        let channels = usize::from(channels);
        if channels == 0 || frames == 0 || sample_rate.is_nan() || sample_rate <= 0.0 {
            return;
        }
        let available = frames.saturating_mul(channels).min(interleaved.len());
        if available == 0 {
            return;
        }
        let Ok(mut ring) = self.inner.try_lock() else {
            return;
        };
        if ring.channels != channels || (ring.sample_rate - sample_rate).abs() > f64::EPSILON {
            ring.samples.clear();
            ring.channels = channels;
            ring.sample_rate = sample_rate;
        }
        let take = available.min(RING_CAPACITY);
        for value in &interleaved[available - take..available] {
            if ring.samples.len() == RING_CAPACITY {
                ring.samples.pop_front();
            }
            ring.samples.push_back(*value);
        }
    }

    /// Drain all currently buffered frames as mono (average of channels).
    fn drain_mono(&self, out: &mut Vec<f32>) -> f64 {
        let Ok(mut ring) = self.inner.lock() else {
            return 0.0;
        };
        let channels = ring.channels.max(1);
        let frames = ring.samples.len() / channels;
        out.clear();
        out.reserve(frames);
        for frame in 0..frames {
            let base = frame * channels;
            let mut sum = 0.0f32;
            for channel in 0..channels {
                sum += ring.samples.get(base + channel).copied().unwrap_or(0.0);
            }
            out.push(sum / channels as f32);
        }
        ring.samples.clear();
        if ring.sample_rate > 0.0 {
            ring.sample_rate
        } else {
            0.0
        }
    }
}

impl Default for AudioRing {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Ring {
                samples: VecDeque::with_capacity(RING_CAPACITY),
                channels: 1,
                sample_rate: 0.0,
            }),
        }
    }
}

pub struct AudioAnalyzer {
    ring: Arc<AudioRing>,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    ka_ring: Vec<f32>,
    write_index: usize,
    since_hop: usize,
    band_edges: Vec<f32>,
    band_tilt: Vec<f32>,
    smoothed: Vec<f32>,
    gate_open: Vec<bool>,
    hold_frames: Vec<i32>,
    agc_peak: f32,
    agc_gain: f32,
    silent_frames: i32,
    last_bands: [u8; AUDIO_BAND_COUNT],
    scratch_mono: Vec<f32>,
    hop_seconds: f32,
}

impl AudioAnalyzer {
    pub fn new(ring: Arc<AudioRing>) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(AUDIO_FFT_SIZE);
        let window: Vec<f32> = (0..AUDIO_FFT_SIZE)
            .map(|index| {
                let phase = 2.0 * PI * index as f32 / (AUDIO_FFT_SIZE as f32 - 1.0);
                0.5 - 0.5 * phase.cos()
            })
            .collect();

        let low = 60.0f32;
        let high = 16_000.0f32;
        let edges: Vec<f32> = (0..=AUDIO_KA_BAND_COUNT)
            .map(|index| low * (high / low).powf(index as f32 / AUDIO_KA_BAND_COUNT as f32))
            .collect();
        let band_tilt: Vec<f32> = (0..AUDIO_KA_BAND_COUNT)
            .map(|index| {
                let center = (edges[index] * edges[index + 1]).sqrt();
                let low_shelf = 6.0 * (220.0 / center).log2().max(0.0);
                low_shelf.min(6.0)
            })
            .collect();

        let hop_seconds = AUDIO_HOP_SIZE as f32 / KA_SAMPLE_RATE;
        Self {
            ring,
            fft,
            window,
            ka_ring: vec![0.0; AUDIO_FFT_SIZE],
            write_index: 0,
            since_hop: 0,
            band_edges: edges,
            band_tilt,
            smoothed: vec![0.0; AUDIO_KA_BAND_COUNT],
            gate_open: vec![false; AUDIO_KA_BAND_COUNT],
            hold_frames: vec![0; AUDIO_KA_BAND_COUNT],
            agc_peak: 0.0,
            agc_gain: 1.0,
            silent_frames: 0,
            last_bands: [0; AUDIO_BAND_COUNT],
            scratch_mono: Vec::with_capacity(AUDIO_FFT_SIZE * 2),
            hop_seconds,
        }
    }

    fn attack_coeff(&self) -> f32 {
        1.0 - (-self.hop_seconds / 0.012).exp()
    }

    fn release_low_coeff(&self) -> f32 {
        (-self.hop_seconds / 0.190).exp()
    }

    fn release_high_coeff(&self) -> f32 {
        (-self.hop_seconds / 0.130).exp()
    }

    fn agc_peak_decay(&self) -> f32 {
        (-self.hop_seconds / 1.5).exp()
    }

    fn agc_gain_attack(&self) -> f32 {
        1.0 - (-self.hop_seconds / 0.08).exp()
    }

    fn agc_gain_release(&self) -> f32 {
        1.0 - (-self.hop_seconds / 1.0).exp()
    }

    /// Consume new PCM from the ring, run every available hop, return latest 22 bands.
    pub fn bands(&mut self, _host: &EngineHost) -> Result<[u8; AUDIO_BAND_COUNT], HostError> {
        let sample_rate = self.ring.drain_mono(&mut self.scratch_mono);
        if sample_rate.is_nan() || sample_rate <= 0.0 {
            return Ok(self.last_bands);
        }
        // KeyboardAgent assumes 48 kHz edges; still run if device rate differs.
        let samples = std::mem::take(&mut self.scratch_mono);
        for sample in samples {
            self.ka_ring[self.write_index] = sample;
            self.write_index = (self.write_index + 1) % AUDIO_FFT_SIZE;
            self.since_hop += 1;
            if self.since_hop >= AUDIO_HOP_SIZE {
                self.since_hop = 0;
                self.analyze_hop();
            }
        }
        Ok(self.last_bands)
    }

    fn analyze_hop(&mut self) {
        let mut buffer: Vec<Complex<f32>> = (0..AUDIO_FFT_SIZE)
            .map(|index| {
                let sample = self.ka_ring[(self.write_index + index) % AUDIO_FFT_SIZE];
                Complex::new(sample * self.window[index], 0.0)
            })
            .collect();
        self.fft.process(&mut buffer);

        let bin_width = KA_SAMPLE_RATE / AUDIO_FFT_SIZE as f32;
        let max_bin = AUDIO_FFT_SIZE / 2 - 1;
        let mut shaped = [0.0f32; AUDIO_KA_BAND_COUNT];

        for band in 0..AUDIO_KA_BAND_COUNT {
            let low_f = self.band_edges[band];
            let high_f = self.band_edges[band + 1];
            let first = ((low_f / bin_width).round() as usize).max(1);
            let mut last = ((high_f / bin_width).round() as usize).min(max_bin);
            if last <= first {
                last = (first + 1).min(max_bin);
            }
            let mut total_power = 0.0f32;
            let mut peak_power = 0.0f32;
            for bin in first..last {
                let c = buffer[bin];
                let power = c.re * c.re + c.im * c.im;
                total_power += power;
                peak_power = peak_power.max(power);
            }
            let bin_count = (last - first).max(1) as f32;
            let mean_mag = (total_power / bin_count).sqrt();
            let peak_mag = peak_power.sqrt();
            let magnitude = (mean_mag * 0.7 + peak_mag * 0.3) / (AUDIO_FFT_SIZE as f32 / 2.0);
            let decibels = 20.0 * magnitude.max(1e-7).log10() + self.band_tilt[band];
            let normalized = ((decibels + 62.0) / 62.0).clamp(0.0, 1.0);
            shaped[band] = normalized.powf(0.93);
        }

        let frame_peak = shaped.iter().copied().fold(0.0f32, f32::max);
        if frame_peak < 0.025 {
            self.silent_frames += 1;
            if self.silent_frames >= 3 {
                self.smoothed.fill(0.0);
                self.gate_open.fill(false);
                self.hold_frames.fill(0);
                self.last_bands = [0; AUDIO_BAND_COUNT];
                return;
            }
        } else {
            self.silent_frames = 0;
        }

        self.agc_peak = frame_peak.max(self.agc_peak * self.agc_peak_decay());
        let desired = if self.agc_peak > 0.0001 {
            (AGC_TARGET / self.agc_peak).min(1.0)
        } else {
            1.0
        };
        let gain_coeff = if desired < self.agc_gain {
            self.agc_gain_attack()
        } else {
            self.agc_gain_release()
        };
        self.agc_gain += (desired - self.agc_gain) * gain_coeff;

        let attack = self.attack_coeff();
        let release_low = self.release_low_coeff();
        let release_high = self.release_high_coeff();
        let mut ka_out = [0u8; AUDIO_KA_BAND_COUNT];

        for band in 0..AUDIO_KA_BAND_COUNT {
            let mut target = shaped[band] * self.agc_gain;
            let close_level = if band < 3 {
                0.020
            } else if band >= 12 {
                0.040
            } else {
                0.030
            };
            let open_level = if band < 3 {
                0.040
            } else if band >= 12 {
                0.080
            } else {
                0.060
            };
            if self.gate_open[band] {
                if target < close_level {
                    self.gate_open[band] = false;
                    target = 0.0;
                }
            } else if target >= open_level {
                self.gate_open[band] = true;
            } else {
                target = 0.0;
            }

            let previous = self.smoothed[band];
            let next = if target > previous {
                if target - previous > 0.015 {
                    self.hold_frames[band] = HOLD_LIMIT;
                }
                previous + (target - previous) * attack
            } else if self.hold_frames[band] > 0 {
                self.hold_frames[band] -= 1;
                previous
            } else {
                previous * if band >= 12 { release_high } else { release_low }
            };
            self.smoothed[band] = next;
            ka_out[band] = (next * 255.0).round().clamp(0.0, 255.0) as u8;
        }

        // 24 → 22 linear resample (KeyboardAgent.keyboardBands without sensitivity).
        for index in 0..AUDIO_BAND_COUNT {
            let position = index as f32 * (AUDIO_KA_BAND_COUNT as f32 - 1.0) / 21.0;
            let lower = (position as usize).min(AUDIO_KA_BAND_COUNT - 1);
            let upper = (lower + 1).min(AUDIO_KA_BAND_COUNT - 1);
            let fraction = position - lower as f32;
            let value = ka_out[lower] as f32 * (1.0 - fraction) + ka_out[upper] as f32 * fraction;
            self.last_bands[index] = value.round().clamp(0.0, 255.0) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine_host::HostLimits;

    fn analyzer_with(ring: Arc<AudioRing>) -> AudioAnalyzer {
        AudioAnalyzer::new(ring)
    }

    fn push_sine(ring: &AudioRing, frequency: f64, amplitude: f32, sample_rate: f64, frames: usize) {
        let mut samples = Vec::with_capacity(frames);
        for index in 0..frames {
            let phase = 2.0 * std::f64::consts::PI * frequency * index as f64 / sample_rate;
            samples.push((amplitude as f64 * phase.sin()) as f32);
        }
        ring.push(&samples, frames, 1, sample_rate);
    }

    fn argmax(values: &[u8]) -> usize {
        let mut best = 0;
        for (index, value) in values.iter().enumerate() {
            if *value > values[best] {
                best = index;
            }
        }
        best
    }

    #[test]
    fn silence_is_all_zero() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let ring = AudioRing::new();
        ring.push(&vec![0.0; AUDIO_FFT_SIZE * 2], AUDIO_FFT_SIZE * 2, 1, 48_000.0);
        let mut analyzer = analyzer_with(ring);
        let bands = analyzer.bands(&host).expect("bands");
        assert_eq!(bands, [0u8; AUDIO_BAND_COUNT]);
    }

    #[test]
    fn one_khz_sine_lights_a_mid_band() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let ring = AudioRing::new();
        // Several hops of a strong 1 kHz tone.
        push_sine(&ring, 1000.0, 0.5, 48_000.0, AUDIO_FFT_SIZE + AUDIO_HOP_SIZE * 8);
        let mut analyzer = analyzer_with(ring);
        let bands = analyzer.bands(&host).expect("bands");
        let peak = argmax(&bands);
        assert!(bands[peak] > 40, "bands were {bands:?}");
        // 1 kHz sits in the lower-mid log bands, not the extreme ends.
        assert!(peak >= 2 && peak <= 16, "peak band {peak} bands={bands:?}");
    }

    #[test]
    fn attack_rises_across_hops() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let ring = AudioRing::new();
        let mut analyzer = analyzer_with(Arc::clone(&ring));
        push_sine(&ring, 1000.0, 0.4, 48_000.0, AUDIO_HOP_SIZE);
        let first = analyzer.bands(&host).expect("first");
        push_sine(&ring, 1000.0, 0.4, 48_000.0, AUDIO_HOP_SIZE * 2);
        let second = analyzer.bands(&host).expect("second");
        push_sine(&ring, 1000.0, 0.4, 48_000.0, AUDIO_HOP_SIZE * 2);
        let third = analyzer.bands(&host).expect("third");
        let peak = argmax(&third);
        assert!(
            first[peak] <= second[peak] && second[peak] <= third[peak],
            "{first:?} {second:?} {third:?}"
        );
        assert!(third[peak] > first[peak], "expected rising attack");
    }
}
