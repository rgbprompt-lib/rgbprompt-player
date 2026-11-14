//! End-to-end output chain against the OpenRGB stub (PLAYER §5, §11):
//! engine frame -> limiter -> layout mapping -> brightness/gamma -> UpdateLEDs,
//! then one all-black frame on end (no mode restore, PLY-20).
use std::thread;
use std::time::Duration;

use openrgb_stub::{StubConfig, StubController, StubEvent, StubServer};
use rgbprompt_player_core::layout::{detect, DeviceDb};
use rgbprompt_player_core::openrgb::{DirectSession, OpenRGBClient};
use rgbprompt_player_core::output::OutputStage;
use rgbprompt_player_core::{
    AudioSample, EngineHost, HostLimits, KeyEvent, Support, KEY_RGB_BYTES,
};

const LEP: &[u8] = include_bytes!("data/example-cyber-breath.lep");
const STEP_MS: f64 = 40.0;
const FRAMES: usize = 50;
const TIMEOUT: Duration = Duration::from_millis(300);

/// Wait until the stub has processed a packet. The stub handles packets in
/// order on one connection, so once a later packet is recorded every earlier
/// write is already applied.
fn wait_for_event(stub: &StubServer, predicate: impl Fn(&StubEvent) -> bool) -> Vec<StubEvent> {
    for _ in 0..400 {
        let events = stub.events();
        if events.iter().any(&predicate) {
            return events;
        }
        thread::sleep(Duration::from_millis(5));
    }
    stub.events()
}

fn led_updates(events: &[StubEvent]) -> Vec<Vec<[u8; 3]>> {
    events
        .iter()
        .filter_map(|event| match event {
            StubEvent::UpdateLeds { colors, .. } => Some(colors.clone()),
            _ => None,
        })
        .collect()
}

/// Wait until the stub has recorded `count` UpdateLEDs packets.
fn wait_for_updates(stub: &StubServer, count: usize) -> Vec<StubEvent> {
    for _ in 0..400 {
        let events = stub.events();
        if led_updates(&events).len() >= count {
            return events;
        }
        thread::sleep(Duration::from_millis(5));
    }
    stub.events()
}

fn has_update_mode(events: &[StubEvent]) -> bool {
    events
        .iter()
        .any(|event| matches!(event, StubEvent::UpdateMode { .. }))
}

fn wait_for_custom_mode(stub: &StubServer) -> Vec<StubEvent> {
    wait_for_event(stub, |event| {
        matches!(event, StubEvent::SetCustomMode { .. })
    })
}

fn run_chain(controller: StubController, protocol_version: u32, expected_support: Support) {
    let configured_leds = controller.leds.len();
    let config = StubConfig {
        protocol_version,
        controllers: vec![controller],
    };
    let mut stub = StubServer::start(config).expect("start stub");
    let addr = stub.addr();

    let mut probe =
        OpenRGBClient::connect(addr, "rgbprompt-test", TIMEOUT).expect("connect client");
    assert_eq!(probe.protocol_version(), protocol_version.min(3));
    let data = probe.controller_data(0).expect("controller data");
    assert_eq!(data.leds.len(), configured_leds);

    let host = EngineHost::new(HostLimits::default()).expect("engine host");
    let mapping = detect(
        &data,
        DeviceDb::embedded(),
        host.key_names(),
        host.key_centres_quarter(),
    )
    .expect("detect layout");
    assert_eq!(mapping.support, expected_support);

    let mut session = DirectSession::begin(probe, 0).expect("begin direct session");
    let program = host.decode(LEP).expect("decode lep");
    let renderer = host.renderer(&program).expect("renderer");
    let limiter = host.limiter().expect("limiter");
    let output = OutputStage::new(100);

    let mut last_colors: Vec<[u8; 3]> = Vec::new();
    let mut saw_non_black = false;
    for frame in 0..FRAMES {
        let t = frame as f64 * STEP_MS;
        let keys: Vec<KeyEvent> = Vec::new();
        let audio: Vec<AudioSample> = Vec::new();
        let key_frame = host
            .step_keys(&renderer, t, &keys, &audio)
            .expect("step_keys");
        assert_eq!(key_frame.len(), KEY_RGB_BYTES);
        let limited = host.limit(&limiter, &key_frame, STEP_MS).expect("limit");
        let mut leds = mapping.map(&limited);
        assert_eq!(leds.len(), configured_leds);
        output.apply(&mut leds);
        if leds.iter().any(|color| *color != [0, 0, 0]) {
            saw_non_black = true;
        }
        if let Err(error) = session.write(&leds) {
            eprintln!(
                "write failed at frame {frame}: {error}; events={:?}",
                stub.events()
            );
            panic!("write frame");
        }
        last_colors = leds;
    }
    session.end().expect("end session");
    drop(session);

    let events = wait_for_updates(&stub, FRAMES + 1);
    assert!(saw_non_black, "the effect must light at least one LED");
    let first_custom = events
        .iter()
        .position(|event| matches!(event, StubEvent::SetCustomMode { .. }))
        .expect("SetCustomMode");
    let first_update = events
        .iter()
        .position(|event| matches!(event, StubEvent::UpdateLeds { .. }))
        .expect("UpdateLeds");
    assert!(
        first_custom < first_update,
        "custom mode must be set before the first LED write"
    );

    let updates = led_updates(&events);
    assert_eq!(updates.len(), FRAMES + 1, "the frames plus one black frame");
    for colors in &updates {
        assert_eq!(colors.len(), configured_leds);
    }
    assert_eq!(updates[FRAMES - 1], last_colors);
    assert!(
        updates[FRAMES].iter().all(|color| *color == [0, 0, 0]),
        "end() must send one all-black frame"
    );
    assert_eq!(
        stub.controller(0).expect("state").colors,
        vec![[0, 0, 0]; configured_leds],
        "the keyboard must end dark"
    );
    assert!(!has_update_mode(&events), "end() must not change the mode");

    stub.shutdown();
}

#[test]
fn per_key_ansi104_v3() {
    run_chain(StubController::per_key_ansi104(), 3, Support::PerKey);
}

#[test]
fn per_key_ansi104_v0() {
    run_chain(StubController::per_key_ansi104(), 0, Support::PerKey);
}

#[test]
fn tkl_v3() {
    run_chain(StubController::per_key_tkl(), 3, Support::PerKey);
}

#[test]
fn tkl_v0() {
    run_chain(StubController::per_key_tkl(), 0, Support::PerKey);
}

#[test]
fn zones_v3() {
    run_chain(StubController::zones(3), 3, Support::Zones);
}

#[test]
fn zones_v0() {
    run_chain(StubController::zones(3), 0, Support::Zones);
}

#[test]
fn single_v3() {
    run_chain(StubController::single(), 3, Support::Single);
}

#[test]
fn single_v0() {
    run_chain(StubController::single(), 0, Support::Single);
}

#[test]
fn protocol_four_negotiates_three() {
    let config = StubConfig {
        protocol_version: 4,
        controllers: vec![StubController::per_key_ansi104()],
    };
    let mut stub = StubServer::start(config).expect("start stub");
    let mut client =
        OpenRGBClient::connect(stub.addr(), "rgbprompt-test", TIMEOUT).expect("connect");
    assert_eq!(client.protocol_version(), 3);
    let data = client.controller_data(0).expect("controller data");
    assert_eq!(data.leds.len(), 104);
    stub.shutdown();
}

#[test]
fn end_sends_one_black_frame_then_nothing() {
    let config = StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    };
    let mut stub = StubServer::start(config).expect("start stub");
    let client = OpenRGBClient::connect(stub.addr(), "rgbprompt-test", TIMEOUT).expect("connect");
    let mut session = DirectSession::begin(client, 0).expect("begin");
    session.write(&vec![[255, 0, 0]; 104]).expect("write");
    session.end().expect("end");
    session.end().expect("second end is a no-op");
    drop(session);

    let events = wait_for_updates(&stub, 2);
    thread::sleep(Duration::from_millis(200));
    let events_later = stub.events();
    assert_eq!(
        events_later.len(),
        events.len(),
        "nothing is sent after the black frame"
    );
    let updates = led_updates(&events_later);
    assert_eq!(updates.len(), 2);
    assert_eq!(updates[1], vec![[0, 0, 0]; 104]);
    assert!(!has_update_mode(&events_later));
    stub.shutdown();
}

#[test]
fn dropping_without_end_sends_the_black_frame() {
    let config = StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    };
    let mut stub = StubServer::start(config).expect("start stub");
    let client = OpenRGBClient::connect(stub.addr(), "rgbprompt-test", TIMEOUT).expect("connect");
    let session = DirectSession::begin(client, 0).expect("begin");
    wait_for_custom_mode(&stub);
    drop(session);

    let events = wait_for_updates(&stub, 1);
    let updates = led_updates(&events);
    assert_eq!(updates, vec![vec![[0, 0, 0]; 104]]);
    assert!(!has_update_mode(&events), "Drop must not change the mode");
    stub.shutdown();
}

#[test]
fn abandon_sends_nothing() {
    let config = StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    };
    let mut stub = StubServer::start(config).expect("start stub");
    let client = OpenRGBClient::connect(stub.addr(), "rgbprompt-test", TIMEOUT).expect("connect");
    let mut session = DirectSession::begin(client, 0).expect("begin");
    wait_for_custom_mode(&stub);
    session.abandon();
    drop(session);
    thread::sleep(Duration::from_millis(200));
    let events = stub.events();
    assert!(
        led_updates(&events).is_empty(),
        "abandon leaves the lighting alone"
    );
    assert!(!has_update_mode(&events));
    stub.shutdown();
}
