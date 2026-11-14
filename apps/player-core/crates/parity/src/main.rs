use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use rgbprompt_player_core::audio::{AudioAnalyzer, AudioRing};
use rgbprompt_player_core::clock::SystemClock;
use rgbprompt_player_core::device_health::LocationLiveProbe;
use rgbprompt_player_core::driver::DEFAULT_OPENRGB_ADDR;
use rgbprompt_player_core::engine_host::FRAME_BYTES;
use rgbprompt_player_core::layout::{detect, DeviceDb, Mapping, MappingKind, Support};
use rgbprompt_player_core::openrgb::OpenRGBClient;
use rgbprompt_player_core::playback::{
    KeyQueue, PlaybackSetup, PlaybackState, PreviewFrame, FPS_HIGH,
};
use rgbprompt_player_core::{
    AudioSample, DirectSession, EngineHost, HostLimits, KeyEvent, KEY_RGB_BYTES,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const DEFAULT_FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/golden");
const DEFAULT_VECTORS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../packages/safety/vectors"
);

#[derive(Debug, Deserialize)]
struct Manifest {
    schema: u32,
    #[serde(rename = "engineVersion")]
    engine_version: String,
    #[serde(rename = "bundleSha256")]
    bundle_sha256: String,
    #[serde(rename = "stepMs")]
    step_ms: u64,
    frames: usize,
    #[serde(rename = "frameBytes")]
    frame_bytes: usize,
    cases: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Inputs {
    #[serde(rename = "keyEvents")]
    key_events: Vec<InputKeyEvent>,
    audio: Vec<InputAudioSample>,
}

#[derive(Debug, Deserialize)]
struct InputKeyEvent {
    tick: u64,
    #[serde(rename = "type")]
    kind: String,
    cell: String,
}

#[derive(Debug, Deserialize)]
struct InputAudioSample {
    tick: u64,
    bands: Option<Vec<u8>>,
}

#[derive(Debug, Deserialize)]
struct Expected {
    #[serde(rename = "stepMs")]
    step_ms: u64,
    frames: usize,
    crc32: Vec<u32>,
    sha256: String,
}

struct GoldenArgs {
    fixtures: PathBuf,
    case: Option<String>,
}

fn main() -> ExitCode {
    // `pnpm <script> -- --flag` forwards the `--` separator; drop it.
    let mut args = std::env::args().skip(1).filter(|arg| arg != "--");
    match args.next().as_deref() {
        Some("golden") => match parse_golden_args(args.collect()) {
            Ok(options) => run_golden(options),
            Err(message) => {
                eprintln!("parity: {message}");
                ExitCode::from(2)
            }
        },
        Some("limiter") => match parse_limiter_args(args.collect()) {
            Ok(options) => run_limiter(options),
            Err(message) => {
                eprintln!("parity: {message}");
                ExitCode::from(2)
            }
        },
        Some("diagnostics-sample") => {
            println!("{}", rgbprompt_player_core::diagnostics::sample_json());
            ExitCode::SUCCESS
        }
        Some("openrgb-probe") => match parse_probe_args(args.collect()) {
            Ok(options) => run_probe(options),
            Err(message) => {
                eprintln!("parity: {message}");
                ExitCode::from(2)
            }
        },
        Some(other) => {
            eprintln!("parity: unknown command {other:?}");
            print_usage();
            ExitCode::from(2)
        }
        None => {
            print_usage();
            ExitCode::from(2)
        }
    }
}

fn print_usage() {
    eprintln!("usage: parity golden [--fixtures <dir>] [--case <id>]");
    eprintln!("       parity limiter [--vectors <dir>]");
    eprintln!("       parity diagnostics-sample");
    eprintln!(
        "       parity openrgb-probe [--addr 127.0.0.1:6742] [--out <file>] [--play <file.lep> --seconds N]"
    );
}

fn parse_golden_args(args: Vec<String>) -> Result<GoldenArgs, String> {
    let mut fixtures = PathBuf::from(DEFAULT_FIXTURES);
    let mut case = None;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--fixtures" => {
                let value = iter.next().ok_or("--fixtures needs a directory")?;
                fixtures = PathBuf::from(value);
            }
            "--case" => {
                let value = iter.next().ok_or("--case needs an id")?;
                case = Some(value);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(GoldenArgs { fixtures, case })
}

fn run_golden(options: GoldenArgs) -> ExitCode {
    let manifest_path = options.fixtures.join("manifest.json");
    let manifest: Manifest = match read_json(&manifest_path) {
        Ok(value) => value,
        Err(error) => {
            eprintln!(
                "parity golden: cannot read {}: {error}",
                manifest_path.display()
            );
            return ExitCode::FAILURE;
        }
    };

    if manifest.schema != 1 {
        eprintln!(
            "parity golden: unsupported manifest schema {}",
            manifest.schema
        );
        return ExitCode::FAILURE;
    }
    if manifest.bundle_sha256 != EngineHost::bundle_sha256() {
        eprintln!(
            "parity golden: fixtures and the embedded bundle come from different engine builds \
             (fixtures {}, bundle {}); run `pnpm player:fixtures`",
            &manifest.bundle_sha256[..12.min(manifest.bundle_sha256.len())],
            &EngineHost::bundle_sha256()[..12]
        );
        return ExitCode::FAILURE;
    }
    if manifest.frame_bytes != FRAME_BYTES {
        eprintln!(
            "parity golden: manifest frameBytes {} differs from the host frame length {}",
            manifest.frame_bytes, FRAME_BYTES
        );
        return ExitCode::FAILURE;
    }

    let selected: Vec<&String> = match &options.case {
        Some(id) => manifest.cases.iter().filter(|case| *case == id).collect(),
        None => manifest.cases.iter().collect(),
    };
    if let Some(id) = &options.case {
        if selected.is_empty() {
            eprintln!("parity golden: case {id:?} is not in the manifest");
            return ExitCode::FAILURE;
        }
    }

    let total = selected.len();
    let mut failures = 0;
    let mut frames = 0;

    for id in selected {
        match run_case(&options.fixtures, id, &manifest) {
            Ok(CaseOutcome::Passed(count)) => frames += count,
            Ok(CaseOutcome::Mismatch(message)) => {
                eprintln!("{message}");
                failures += 1;
            }
            Err(error) => {
                eprintln!("parity golden: {id}: {error}");
                failures += 1;
            }
        }
    }

    if failures > 0 {
        eprintln!("parity golden: {failures} of {total} case(s) failed");
        return ExitCode::FAILURE;
    }

    let bundle = EngineHost::bundle_sha256();
    println!(
        "parity golden: ok ({total} cases, {frames} frames, bundle {}, engine {})",
        &bundle[..12.min(bundle.len())],
        manifest.engine_version
    );
    ExitCode::SUCCESS
}

enum CaseOutcome {
    Passed(usize),
    Mismatch(String),
}

fn run_case(fixtures: &Path, id: &str, manifest: &Manifest) -> Result<CaseOutcome, String> {
    let lep = fs::read(fixtures.join(format!("{id}.lep")))
        .map_err(|error| format!("read .lep: {error}"))?;
    let inputs: Inputs = read_json(&fixtures.join(format!("{id}.inputs.json")))
        .map_err(|error| format!("read inputs: {error}"))?;
    let expected: Expected = read_json(&fixtures.join(format!("{id}.expected.json")))
        .map_err(|error| format!("read expected: {error}"))?;

    if expected.frames != manifest.frames || expected.step_ms != manifest.step_ms {
        return Err("expected.json disagrees with the manifest cadence".to_string());
    }

    let host = EngineHost::new(HostLimits::default()).map_err(|error| error.to_string())?;
    let program = host.decode(&lep).map_err(|error| error.to_string())?;
    let renderer = host.renderer(&program).map_err(|error| error.to_string())?;

    let mut keys = inputs.key_events;
    keys.sort_by_key(|event| event.tick);
    let mut audio = inputs.audio;
    audio.sort_by_key(|sample| sample.tick);

    let mut key_index = 0;
    let mut audio_index = 0;
    let mut crcs = Vec::with_capacity(manifest.frames);
    let mut hasher = Sha256::new();

    for frame_index in 0..manifest.frames {
        let tick = frame_index as u64 * manifest.step_ms;

        let mut due_keys: Vec<KeyEvent> = Vec::new();
        while key_index < keys.len() && keys[key_index].tick <= tick {
            let event = &keys[key_index];
            due_keys.push(KeyEvent {
                t: event.tick as f64,
                down: event.kind == "down",
                cell: event.cell.clone(),
            });
            key_index += 1;
        }

        let mut due_audio: Vec<AudioSample> = Vec::new();
        while audio_index < audio.len() && audio[audio_index].tick <= tick {
            let sample = &audio[audio_index];
            due_audio.push(AudioSample {
                t: sample.tick as f64,
                bands: sample.bands.clone(),
            });
            audio_index += 1;
        }

        let bytes = host
            .step(&renderer, tick as f64, &due_keys, &due_audio)
            .map_err(|error| error.to_string())?;
        crcs.push(crc32fast::hash(&bytes));
        hasher.update(&bytes);
    }

    let sha256 = hex(&hasher.finalize());
    if let Some(index) = first_crc_difference(&expected.crc32, &crcs) {
        let expected_crc = expected
            .crc32
            .get(index)
            .map(u32::to_string)
            .unwrap_or_else(|| "missing".to_string());
        let actual_crc = crcs
            .get(index)
            .map(u32::to_string)
            .unwrap_or_else(|| "missing".to_string());
        let at = index as u64 * manifest.step_ms;
        return Ok(CaseOutcome::Mismatch(format!(
            "parity golden: {id}: first differing frame {index} at t={at} ms (expected {expected_crc}, got {actual_crc})"
        )));
    }

    if sha256 != expected.sha256 {
        return Ok(CaseOutcome::Mismatch(format!(
            "parity golden: {id}: sha256 mismatch (expected {}, got {sha256})",
            expected.sha256
        )));
    }

    Ok(CaseOutcome::Passed(crcs.len()))
}

struct LimiterArgs {
    vectors: PathBuf,
}

#[derive(Debug, Deserialize)]
struct SafetyManifest {
    step_ms: u64,
    frame_bytes: usize,
    vectors: Vec<SafetyVector>,
}

#[derive(Debug, Deserialize)]
struct SafetyVector {
    id: String,
    file: String,
    frames: usize,
    input_sha256: String,
    output_sha256: String,
}

fn parse_limiter_args(args: Vec<String>) -> Result<LimiterArgs, String> {
    let mut vectors = PathBuf::from(DEFAULT_VECTORS);
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--vectors" => {
                let value = iter.next().ok_or("--vectors needs a directory")?;
                vectors = PathBuf::from(value);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(LimiterArgs { vectors })
}

fn run_limiter(options: LimiterArgs) -> ExitCode {
    let manifest_path = options.vectors.join("manifest.json");
    let manifest: SafetyManifest = match read_json(&manifest_path) {
        Ok(value) => value,
        Err(error) => {
            eprintln!(
                "parity limiter: cannot read {}: {error}",
                manifest_path.display()
            );
            return ExitCode::FAILURE;
        }
    };

    if manifest.frame_bytes != KEY_RGB_BYTES {
        eprintln!(
            "parity limiter: manifest frame_bytes {} differs from the host key frame length {}",
            manifest.frame_bytes, KEY_RGB_BYTES
        );
        return ExitCode::FAILURE;
    }

    let host = match EngineHost::new(HostLimits::default()) {
        Ok(host) => host,
        Err(error) => {
            eprintln!("parity limiter: could not start the engine host: {error}");
            return ExitCode::FAILURE;
        }
    };

    let total = manifest.vectors.len();
    let mut failures = 0;
    let mut frames = 0;

    for vector in &manifest.vectors {
        let path = options.vectors.join(&vector.file);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!(
                    "parity limiter: {}: read {}: {error}",
                    vector.id,
                    path.display()
                );
                failures += 1;
                continue;
            }
        };
        let expected_len = vector.frames * manifest.frame_bytes;
        if bytes.len() != expected_len {
            eprintln!(
                "parity limiter: {}: {} has {} bytes, expected {}",
                vector.id,
                vector.file,
                bytes.len(),
                expected_len
            );
            failures += 1;
            continue;
        }

        let input_sha = hex(&Sha256::digest(&bytes));
        if input_sha != vector.input_sha256 {
            eprintln!(
                "parity limiter: {}: input sha256 mismatch (expected {}, got {})",
                vector.id,
                short(&vector.input_sha256),
                short(&input_sha)
            );
            failures += 1;
            continue;
        }

        let limiter = match host.limiter() {
            Ok(limiter) => limiter,
            Err(error) => {
                eprintln!("parity limiter: {}: create limiter: {error}", vector.id);
                failures += 1;
                continue;
            }
        };

        let mut hasher = Sha256::new();
        let mut failed = false;
        for index in 0..vector.frames {
            let start = index * manifest.frame_bytes;
            let frame = &bytes[start..start + manifest.frame_bytes];
            match host.limit(&limiter, frame, manifest.step_ms as f64) {
                Ok(output) => hasher.update(&output),
                Err(error) => {
                    eprintln!("parity limiter: {}: frame {index}: {error}", vector.id);
                    failures += 1;
                    failed = true;
                    break;
                }
            }
        }
        if failed {
            continue;
        }
        frames += vector.frames;

        let output_sha = hex(&hasher.finalize());
        if output_sha != vector.output_sha256 {
            eprintln!(
                "parity limiter: {}: output sha256 mismatch (expected {}, got {})",
                vector.id,
                short(&vector.output_sha256),
                short(&output_sha)
            );
            failures += 1;
        }
    }

    if failures > 0 {
        eprintln!("parity limiter: {failures} of {total} vector(s) failed");
        return ExitCode::FAILURE;
    }

    let bundle = EngineHost::safety_bundle_sha256();
    println!(
        "parity limiter: ok ({total} vectors, {frames} frames, safety bundle {})",
        short(bundle)
    );
    ExitCode::SUCCESS
}

fn short(value: &str) -> &str {
    &value[..12.min(value.len())]
}

fn first_crc_difference(expected: &[u32], actual: &[u32]) -> Option<usize> {
    let limit = expected.len().min(actual.len());
    for index in 0..limit {
        if expected[index] != actual[index] {
            return Some(index);
        }
    }
    if expected.len() != actual.len() {
        return Some(limit);
    }
    None
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

struct ProbeArgs {
    addr: SocketAddr,
    out: Option<PathBuf>,
    play: Option<PathBuf>,
    seconds: u64,
}

fn parse_probe_args(args: Vec<String>) -> Result<ProbeArgs, String> {
    let mut addr = DEFAULT_OPENRGB_ADDR.parse().expect("default address");
    let mut out = None;
    let mut play = None;
    let mut seconds = 5u64;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--addr" => {
                let value = iter.next().ok_or("--addr needs a host:port")?;
                addr = value
                    .parse()
                    .map_err(|_| format!("invalid address {value:?}"))?;
            }
            "--out" => {
                out = Some(PathBuf::from(iter.next().ok_or("--out needs a file")?));
            }
            "--play" => {
                play = Some(PathBuf::from(
                    iter.next().ok_or("--play needs a .lep file")?,
                ));
            }
            "--seconds" => {
                let value = iter.next().ok_or("--seconds needs a number")?;
                seconds = value
                    .parse()
                    .map_err(|_| format!("invalid --seconds value {value:?}"))?;
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(ProbeArgs {
        addr,
        out,
        play,
        seconds: seconds.clamp(1, 30),
    })
}

struct ProbeController {
    index: u32,
    data: rgbprompt_player_core::ControllerData,
    mapping: Option<Mapping>,
    rank: u8,
}

fn run_probe(options: ProbeArgs) -> ExitCode {
    if TcpStream::connect_timeout(&options.addr, Duration::from_millis(500)).is_err() {
        println!(
            "No OpenRGB SDK server at {}. Start OpenRGB, enable SDK Server (port 6742), then re-run.",
            options.addr
        );
        return ExitCode::from(2);
    }
    let mut client =
        match OpenRGBClient::connect(options.addr, "RGBPrompt Probe", Duration::from_millis(800)) {
            Ok(client) => client,
            Err(error) => {
                eprintln!("parity openrgb-probe: handshake failed: {error}");
                return ExitCode::FAILURE;
            }
        };
    let protocol = client.protocol_version();
    let count = match client.controller_count() {
        Ok(count) => count,
        Err(error) => {
            eprintln!("parity openrgb-probe: controller count failed: {error}");
            return ExitCode::FAILURE;
        }
    };
    let host = match EngineHost::new(HostLimits::default()) {
        Ok(host) => host,
        Err(error) => {
            eprintln!("parity openrgb-probe: engine host: {error}");
            return ExitCode::FAILURE;
        }
    };
    let mut controllers = Vec::new();
    for index in 0..count {
        let data = match client.controller_data(index) {
            Ok(data) => data,
            Err(error) => {
                eprintln!("parity openrgb-probe: controller {index}: {error}");
                return ExitCode::FAILURE;
            }
        };
        let mapping = detect(
            &data,
            DeviceDb::embedded(),
            host.key_names(),
            host.key_centres_quarter(),
        )
        .ok();
        let rank = if data.kind == 5 {
            mapping.as_ref().map_or(0, |mapping| rank(mapping.support))
        } else {
            0
        };
        controllers.push(ProbeController {
            index,
            data,
            mapping,
            rank,
        });
    }

    let chosen = controllers
        .iter()
        .enumerate()
        .filter(|(_, controller)| controller.rank > 0)
        .max_by(|(left_index, left), (right_index, right)| {
            left.rank
                .cmp(&right.rank)
                .then_with(|| right_index.cmp(left_index))
        })
        .map(|(position, _)| position);

    let generated = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let controller_json: Vec<Value> = controllers.iter().map(controller_json).collect();
    let document = json!({
        "addr": options.addr.to_string(),
        "protocolVersion": protocol,
        "generatedAt": generated,
        "controllers": controller_json,
        "chosen": chosen.map(|position| controllers[position].index),
    });

    let out = options.out.unwrap_or_else(|| {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..");
        root.join("tmp")
            .join(format!("openrgb-probe-{generated}.json"))
    });
    if let Some(parent) = out.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = fs::write(
        &out,
        serde_json::to_string_pretty(&document).unwrap_or_default(),
    ) {
        eprintln!(
            "parity openrgb-probe: cannot write {}: {error}",
            out.display()
        );
        return ExitCode::FAILURE;
    }

    let chosen_description = match chosen {
        Some(position) => format!(
            "#{} {:?} ({})",
            controllers[position].index,
            controllers[position].data.name,
            support_name(
                controllers[position]
                    .mapping
                    .as_ref()
                    .map(|mapping| mapping.support)
            )
        ),
        None => "none".to_string(),
    };

    if let Some(lep_path) = options.play {
        let Some(position) = chosen else {
            eprintln!("parity openrgb-probe: no keyboard controller to play on");
            return ExitCode::FAILURE;
        };
        let chosen = &controllers[position];
        let mapping = match chosen.mapping.clone() {
            Some(mapping) => mapping,
            None => {
                eprintln!("parity openrgb-probe: chosen controller has no mapping");
                return ExitCode::FAILURE;
            }
        };
        let lep = match fs::read(&lep_path) {
            Ok(lep) => lep,
            Err(error) => {
                eprintln!(
                    "parity openrgb-probe: cannot read {}: {error}",
                    lep_path.display()
                );
                return ExitCode::FAILURE;
            }
        };
        if let Err(error) = play(
            &host,
            &lep,
            options.addr,
            chosen.index,
            mapping,
            &chosen.data.name,
            &chosen.data.location,
            options.seconds,
        ) {
            eprintln!("parity openrgb-probe: playback failed: {error}");
            return ExitCode::FAILURE;
        }
        println!(
            "openrgb-probe: ok ({} controllers, protocol {protocol}, chosen {chosen_description}, played {} s, wrote {})",
            controllers.len(),
            options.seconds,
            out.display()
        );
    } else {
        println!(
            "openrgb-probe: ok ({} controllers, protocol {protocol}, chosen {chosen_description}, wrote {})",
            controllers.len(),
            out.display()
        );
    }
    ExitCode::SUCCESS
}

fn controller_json(controller: &ProbeController) -> Value {
    let data = &controller.data;
    let mapping = controller.mapping.as_ref();
    let unmatched_led_names: Vec<String> = match mapping.map(|mapping| &mapping.kind) {
        Some(MappingKind::PerKey { led_to_key }) => data
            .leds
            .iter()
            .zip(led_to_key)
            .filter_map(|(led, key)| {
                if key.is_none() {
                    Some(led.name.clone())
                } else {
                    None
                }
            })
            .collect(),
        _ => Vec::new(),
    };
    let (vendor_id, product_id) = rgbprompt_player_core::diagnostics::parse_vid_pid(&data.location);
    let modes: Vec<Value> = data
        .modes
        .iter()
        .enumerate()
        .map(|(index, mode)| {
            json!({
                "index": index,
                "name": mode.name,
                "value": mode.value,
                "active": index as i32 == data.active_mode || mode.value == data.active_mode,
            })
        })
        .collect();
    let zones: Vec<Value> = data
        .zones
        .iter()
        .map(|zone| {
            json!({
                "name": zone.name,
                "type": zone_type_name(zone.zone_type),
                "ledCount": zone.leds_count,
                "matrix": zone.matrix.as_ref().map(|matrix| json!({
                    "width": matrix.width,
                    "height": matrix.height,
                })),
            })
        })
        .collect();
    json!({
        "index": controller.index,
        "name": data.name,
        "vendor": data.vendor,
        "description": data.description,
        "version": data.version,
        "kind": { "number": data.kind, "name": device_type_name(data.kind) },
        "location": data.location,
        "vid": vendor_id,
        "pid": product_id,
        "activeMode": data.active_mode,
        "modes": modes,
        "zones": zones,
        "ledCount": data.leds.len(),
        "ledNames": data.leds.iter().map(|led| led.name.clone()).collect::<Vec<_>>(),
        "layout": mapping.map(|mapping| json!({
            "support": support_name(Some(mapping.support)),
            "matchedKeys": mapping.matched_keys,
            "unmatchedKeys": 104usize.saturating_sub(mapping.matched_keys),
            "unmatchedLeds": mapping.unmapped_leds,
            "unmatchedLedNames": unmatched_led_names,
        })),
    })
}

#[allow(clippy::too_many_arguments)]
fn play(
    host: &EngineHost,
    lep: &[u8],
    addr: SocketAddr,
    index: u32,
    mapping: Mapping,
    controller_name: &str,
    controller_location: &str,
    seconds: u64,
) -> Result<(), String> {
    let program = host.decode(lep).map_err(|error| error.to_string())?;
    let renderer = host.renderer(&program).map_err(|error| error.to_string())?;
    let limiter = host.limiter().map_err(|error| error.to_string())?;
    let client = OpenRGBClient::connect(addr, "RGBPrompt Probe Play", Duration::from_millis(800))
        .map_err(|error| error.to_string())?;
    let session = DirectSession::begin(client, index).map_err(|error| error.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(seconds));
        stop_thread.store(true, Ordering::SeqCst);
    });
    let mut playback = PlaybackState::new(
        host,
        &renderer,
        &limiter,
        PlaybackSetup {
            session,
            mapping,
            controller_name: controller_name.to_string(),
            controller_location: controller_location.to_string(),
            preview: PreviewFrame::new(),
            keys: KeyQueue::new(),
            audio: AudioAnalyzer::new(AudioRing::new()),
            clock: Arc::new(SystemClock::new()),
            brightness: Arc::new(AtomicU32::new(100)),
            fps: Arc::new(AtomicU32::new(FPS_HIGH)),
            write_latency: Duration::ZERO,
            abandon: Arc::new(AtomicBool::new(false)),
            location_live: LocationLiveProbe::default(),
        },
    );
    match playback.run(&stop, &mut |_event| {}) {
        None => Ok(()),
        Some(failure) => Err(format!("{failure:?}")),
    }
}

fn rank(support: Support) -> u8 {
    match support {
        Support::PerKey => 3,
        Support::Zones => 2,
        Support::Single => 1,
    }
}

fn support_name(support: Option<Support>) -> &'static str {
    match support {
        Some(Support::PerKey) => "per_key",
        Some(Support::Zones) => "zones",
        Some(Support::Single) => "single",
        None => "unknown",
    }
}

fn device_type_name(kind: i32) -> &'static str {
    match kind {
        0 => "unknown",
        1 => "motherboard",
        2 => "dram",
        3 => "gpu",
        4 => "cooler",
        5 => "keyboard",
        6 => "mouse",
        18 => "keypad",
        _ => "other",
    }
}

fn zone_type_name(zone_type: i32) -> &'static str {
    match zone_type {
        0 => "single",
        1 => "linear",
        2 => "matrix",
        _ => "other",
    }
}
