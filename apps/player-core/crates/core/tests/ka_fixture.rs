//! LEP v15 A5: the Player KeyboardAgent analyser and the web TS port
//! (apps/web/src/features/sound/lib/ka-band-clock.ts) must produce the same
//! bands, bit for bit, from the same PCM. Both sides generate this integer PCM
//! and compare against fixtures/ka/synthetic-48k.bands (one 40 ms push per line).
//! Regenerate with KA_FIXTURE_UPDATE=1 after an intentional analyser change.
use rgbprompt_player_core::audio::{AudioAnalyzer, AudioRing};
use rgbprompt_player_core::{EngineHost, HostLimits};

const RATE: usize = 48_000;
const PUSH_FRAMES: usize = 1920;

fn synthetic_pcm(frames: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames);
    let mut seed: u32 = 0x1234567;
    for i in 0..frames {
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345) & 0x7fff_ffff;
        let noise = ((seed >> 16) & 0x7fff) as i64 - 16384;
        let p = (i % 480) as i64;
        let tone = (if p < 240 { p } else { 480 - p }) * 66 - 7920;
        let beat = (i % 24000) as i64;
        let kick = if beat < 4800 { tone * (4800 - beat) / 4800 } else { 0 };
        let hat = if (i + 6000) % 12000 < 1200 { noise / 4 } else { 0 };
        let bed = ((i % 109) as i64 - 54) * 40 * ((i >> 13) & 7) as i64 / 7;
        let quiet = if i >= frames - RATE { 0 } else { 1 };
        let value = ((kick + hat + bed) * quiet).clamp(-32768, 32767);
        out.push(value as f32 / 32768.0);
    }
    out
}

#[test]
fn ka_bands_match_the_shared_fixture() {
    let pcm = synthetic_pcm(RATE * 6);
    let host = EngineHost::new(HostLimits::default()).expect("engine host");
    let ring = AudioRing::new();
    let mut analyser = AudioAnalyzer::new(ring.clone());
    let mut lines = Vec::new();
    for chunk in pcm.chunks(PUSH_FRAMES) {
        ring.push(chunk, chunk.len(), 1, RATE as f64);
        let bands = analyser.bands(&host).expect("bands");
        lines.push(bands.iter().map(u8::to_string).collect::<Vec<_>>().join(","));
    }
    let actual = lines.join("\n") + "\n";
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/ka/synthetic-48k.bands");
    if std::env::var_os("KA_FIXTURE_UPDATE").is_some() {
        std::fs::write(path, &actual).expect("write fixture");
    }
    let expected = std::fs::read_to_string(path).expect("fixture present");
    assert_eq!(actual, expected, "Player KA bands drifted from fixtures/ka/synthetic-48k.bands");
    assert!(lines.iter().any(|l| l.split(',').any(|v| v != "0")), "fixture exercises non-zero bands");
}
