//! `parity openrgb-probe` against the in-process OpenRGB stub (decision 13).
use std::path::PathBuf;
use std::process::Command;

use openrgb_stub::{StubConfig, StubController, StubEvent, StubServer};

fn parity() -> &'static str {
    env!("CARGO_BIN_EXE_parity")
}

fn temp_out(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "rgbprompt-probe-{name}-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn lep_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../core/tests/data/example-cyber-breath.lep")
}

fn start_stub() -> StubServer {
    StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("stub")
}

fn has_event(stub: &StubServer, predicate: impl Fn(&StubEvent) -> bool) -> bool {
    stub.events().iter().any(predicate)
}

#[test]
fn read_only_probe_writes_the_chosen_controller() {
    let mut stub = start_stub();
    let out = temp_out("read-only");
    let output = Command::new(parity())
        .args([
            "openrgb-probe",
            "--addr",
            &stub.addr().to_string(),
            "--out",
            &out.display().to_string(),
        ])
        .output()
        .expect("run parity");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = std::fs::read_to_string(&out).expect("probe json");
    let document: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(document["chosen"], 0);
    assert_eq!(document["controllers"][0]["name"], "Per-key Keyboard");
    assert_eq!(document["controllers"][0]["kind"]["number"], 5);
    assert_eq!(document["controllers"][0]["layout"]["support"], "per_key");
    assert!(document["controllers"][0]["ledCount"].as_u64().unwrap() >= 104);
    assert!(
        !has_event(&stub, |event| matches!(
            event,
            StubEvent::UpdateLeds { .. } | StubEvent::SetCustomMode { .. }
        )),
        "read-only probing must not write"
    );
    stub.shutdown();
    let _ = std::fs::remove_file(&out);
}

#[test]
fn play_probe_writes_and_ends_dark() {
    let mut stub = start_stub();
    let out = temp_out("play");
    let output = Command::new(parity())
        .args([
            "openrgb-probe",
            "--addr",
            &stub.addr().to_string(),
            "--out",
            &out.display().to_string(),
            "--play",
            &lep_path().display().to_string(),
            "--seconds",
            "1",
        ])
        .output()
        .expect("run parity");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(has_event(&stub, |event| matches!(
        event,
        StubEvent::UpdateLeds { .. }
    )));
    assert!(has_event(&stub, |event| matches!(
        event,
        StubEvent::SetCustomMode { .. }
    )));
    assert!(!has_event(&stub, |event| matches!(
        event,
        StubEvent::UpdateMode { .. }
    )));
    assert!(
        stub.controller(0)
            .expect("state")
            .colors
            .iter()
            .all(|color| *color == [0, 0, 0]),
        "play mode must end with an all-black frame"
    );
    stub.shutdown();
    let _ = std::fs::remove_file(&out);
}
