mod common;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use openrgb_stub::{StubConfig, StubController, StubEvent, StubServer};
use rgbprompt_player_core::audio::{AudioAnalyzer, AudioRing};
use rgbprompt_player_core::clock::{Clock, FakeClock};
use rgbprompt_player_core::device_health::LocationLiveProbe;
use rgbprompt_player_core::layout::{detect, DeviceDb, Mapping};
use rgbprompt_player_core::openrgb::{ControllerData, DirectSession, OpenRGBClient};
use rgbprompt_player_core::playback::{
    KeyQueue, PlaybackFailure, PlaybackSetup, PlaybackState, PreviewFrame,
};
use rgbprompt_player_core::{EngineHost, HostLimits, LimiterHandle, RendererHandle};

const LEP: &[u8] = include_bytes!("data/example-cyber-breath.lep");
const TIMEOUT: Duration = Duration::from_millis(300);

fn update_count(stub: &StubServer) -> usize {
    stub.events()
        .iter()
        .filter(|event| matches!(event, StubEvent::UpdateLeds { .. }))
        .count()
}

fn last_update_is_black(stub: &StubServer) -> bool {
    stub.events()
        .iter()
        .rev()
        .find_map(|event| match event {
            StubEvent::UpdateLeds { colors, .. } => Some(colors.iter().all(|c| *c == [0, 0, 0])),
            _ => None,
        })
        .unwrap_or(false)
}

fn start_stub() -> (StubServer, EngineHost, ControllerData) {
    let stub = StubServer::start(StubConfig {
        protocol_version: 3,
        controllers: vec![StubController::per_key_ansi104()],
    })
    .expect("stub");
    let mut client =
        OpenRGBClient::connect(stub.addr(), "rgbprompt-test", TIMEOUT).expect("connect");
    let data = client.controller_data(0).expect("controller data");
    drop(client);
    let host = EngineHost::new(HostLimits::default()).expect("host");
    (stub, host, data)
}

#[allow(clippy::too_many_arguments)]
fn build_playback<'a>(
    stub: &StubServer,
    host: &'a EngineHost,
    renderer: &'a RendererHandle<'a>,
    limiter: &'a LimiterHandle<'a>,
    mapping: Mapping,
    data: &ControllerData,
    clock: Arc<FakeClock>,
    latency: Duration,
) -> (PlaybackState<'a>, Arc<PreviewFrame>, Arc<AtomicU32>) {
    build_playback_with(
        stub,
        host,
        renderer,
        limiter,
        mapping,
        data,
        clock,
        latency,
        LocationLiveProbe::default(),
    )
}

#[allow(clippy::too_many_arguments)]
fn build_playback_with<'a>(
    stub: &StubServer,
    host: &'a EngineHost,
    renderer: &'a RendererHandle<'a>,
    limiter: &'a LimiterHandle<'a>,
    mapping: Mapping,
    data: &ControllerData,
    clock: Arc<FakeClock>,
    latency: Duration,
    location_live: LocationLiveProbe,
) -> (PlaybackState<'a>, Arc<PreviewFrame>, Arc<AtomicU32>) {
    let client =
        OpenRGBClient::connect(stub.addr(), "rgbprompt-play", TIMEOUT).expect("connect playback");
    let session = DirectSession::begin(client, 0).expect("direct session");
    let preview = PreviewFrame::new();
    let fps = Arc::new(AtomicU32::new(25));
    let brightness = Arc::new(AtomicU32::new(100));
    let playback = PlaybackState::new(
        host,
        renderer,
        limiter,
        PlaybackSetup {
            session,
            mapping,
            controller_name: data.name.clone(),
            controller_location: data.location.clone(),
            preview: Arc::clone(&preview),
            keys: KeyQueue::new(),
            audio: AudioAnalyzer::new(AudioRing::new()),
            clock,
            brightness,
            fps: Arc::clone(&fps),
            write_latency: latency,
            abandon: Arc::new(AtomicBool::new(false)),
            location_live,
        },
    );
    (playback, preview, fps)
}

#[test]
fn runs_at_25_fps_and_ends_with_one_black_frame() {
    let (mut stub, host, data) = start_stub();
    let mapping = detect(
        &data,
        DeviceDb::embedded(),
        host.key_names(),
        host.key_centres_quarter(),
    )
    .expect("detect");
    let program = host.decode(LEP).expect("decode");
    let renderer = host.renderer(&program).expect("renderer");
    let limiter = host.limiter().expect("limiter");
    let clock = Arc::new(FakeClock::new());
    let (mut playback, preview, fps) = build_playback(
        &stub,
        &host,
        &renderer,
        &limiter,
        mapping,
        &data,
        clock,
        Duration::ZERO,
    );

    assert!(playback.run_for(Duration::from_secs(2)).is_none());
    assert!(common::wait_until(Duration::from_secs(2), || {
        last_update_is_black(&stub)
    }));
    // The effect frames plus the single black frame sent on stop.
    let updates = update_count(&stub) - 1;
    assert!(
        (49..=51).contains(&updates),
        "expected about 50 frames, got {updates}"
    );
    assert_eq!(fps.load(Ordering::Relaxed), 25);
    assert!(preview.seq() >= 50);
    assert!(
        !stub
            .events()
            .iter()
            .any(|event| matches!(event, StubEvent::UpdateMode { .. })),
        "stopping must not change the mode"
    );
    stub.shutdown();
}

#[test]
fn high_latency_drops_to_15_fps_and_recovers() {
    let (mut stub, host, data) = start_stub();
    let mapping = detect(
        &data,
        DeviceDb::embedded(),
        host.key_names(),
        host.key_centres_quarter(),
    )
    .expect("detect");
    let program = host.decode(LEP).expect("decode");
    let renderer = host.renderer(&program).expect("renderer");
    let limiter = host.limiter().expect("limiter");
    let clock = Arc::new(FakeClock::new());
    let (mut playback, _preview, fps) = build_playback(
        &stub,
        &host,
        &renderer,
        &limiter,
        mapping,
        &data,
        clock,
        Duration::from_millis(40),
    );

    playback.advance_for(Duration::from_secs(2));
    assert_eq!(
        fps.load(Ordering::Relaxed),
        15,
        "slow writes must drop to 15 fps"
    );
    let before = update_count(&stub);
    assert!(before > 10);

    playback.set_write_latency(Duration::ZERO);
    playback.advance_for(Duration::from_secs(6));
    assert_eq!(fps.load(Ordering::Relaxed), 25, "fast writes must recover");
    assert!(update_count(&stub) > before);
    playback.finish_session();
    stub.shutdown();
}

#[test]
fn brief_fast_windows_do_not_recover_to_25_fps() {
    let (mut stub, host, data) = start_stub();
    let mapping = detect(
        &data,
        DeviceDb::embedded(),
        host.key_names(),
        host.key_centres_quarter(),
    )
    .expect("detect");
    let program = host.decode(LEP).expect("decode");
    let renderer = host.renderer(&program).expect("renderer");
    let limiter = host.limiter().expect("limiter");
    let clock = Arc::new(FakeClock::new());
    let (mut playback, _preview, fps) = build_playback(
        &stub,
        &host,
        &renderer,
        &limiter,
        mapping,
        &data,
        clock.clone(),
        Duration::from_millis(40),
    );

    playback.advance_for(Duration::from_secs(2));
    assert_eq!(fps.load(Ordering::Relaxed), 15);

    // Slow stretches produce a 40 ms median; each short fast burst pushes the
    // median below 20 ms for well under 5 s, then the next slow frame resets
    // the recovery timer. The old "5 s since the switch plus current median"
    // rule would recover on the first burst after 5 s.
    let target = clock.now() + Duration::from_secs(7);
    while clock.now() < target && fps.load(Ordering::Relaxed) == 15 {
        playback.set_write_latency(Duration::from_millis(40));
        for _ in 0..8 {
            playback.run_once();
        }
        playback.set_write_latency(Duration::ZERO);
        for _ in 0..7 {
            playback.run_once();
        }
    }
    assert_eq!(
        fps.load(Ordering::Relaxed),
        15,
        "brief dips below 20 ms must not recover"
    );

    playback.set_write_latency(Duration::ZERO);
    playback.advance_for(Duration::from_secs(6));
    assert_eq!(fps.load(Ordering::Relaxed), 25);
    playback.finish_session();
    stub.shutdown();
}

#[test]
fn device_list_updated_keeps_playing_when_the_controller_stays() {
    let (mut stub, host, data) = start_stub();
    let mapping = detect(
        &data,
        DeviceDb::embedded(),
        host.key_names(),
        host.key_centres_quarter(),
    )
    .expect("detect");
    let program = host.decode(LEP).expect("decode");
    let renderer = host.renderer(&program).expect("renderer");
    let limiter = host.limiter().expect("limiter");
    let clock = Arc::new(FakeClock::new());
    let (mut playback, _preview, _fps) = build_playback(
        &stub,
        &host,
        &renderer,
        &limiter,
        mapping,
        &data,
        clock,
        Duration::ZERO,
    );

    playback.advance_for(Duration::from_millis(200));
    let before = update_count(&stub);
    stub.emit_device_list_updated();
    let result = playback.advance_for(Duration::from_millis(400));
    assert_eq!(result, None);
    assert!(update_count(&stub) > before, "playback must continue");
    playback.finish_session();
    stub.shutdown();
}

#[test]
fn device_list_updated_with_the_controller_gone_is_device_lost() {
    let (mut stub, host, data) = start_stub();
    let mapping = detect(
        &data,
        DeviceDb::embedded(),
        host.key_names(),
        host.key_centres_quarter(),
    )
    .expect("detect");
    let program = host.decode(LEP).expect("decode");
    let renderer = host.renderer(&program).expect("renderer");
    let limiter = host.limiter().expect("limiter");
    let clock = Arc::new(FakeClock::new());
    let (mut playback, preview, _fps) = build_playback(
        &stub,
        &host,
        &renderer,
        &limiter,
        mapping,
        &data,
        clock,
        Duration::ZERO,
    );

    playback.advance_for(Duration::from_millis(200));
    stub.remove_controller(0);
    stub.emit_device_list_updated();
    let result = playback.advance_for(Duration::from_millis(400));
    assert_eq!(result, Some(PlaybackFailure::DeviceLost));
    let mut frame = [0u8; rgbprompt_player_core::KEY_RGB_BYTES];
    preview.snapshot(&mut frame);
    assert_eq!(frame, [0u8; rgbprompt_player_core::KEY_RGB_BYTES]);
    stub.shutdown();
}

#[test]
fn stale_handle_fails_on_the_first_health_probe() {
    let (mut stub, host, data) = start_stub();
    let mapping = detect(
        &data,
        DeviceDb::embedded(),
        host.key_names(),
        host.key_centres_quarter(),
    )
    .expect("detect");
    let program = host.decode(LEP).expect("decode");
    let renderer = host.renderer(&program).expect("renderer");
    let limiter = host.limiter().expect("limiter");
    let clock = Arc::new(FakeClock::new());
    let (mut playback, _preview, _fps) = build_playback_with(
        &stub,
        &host,
        &renderer,
        &limiter,
        mapping,
        &data,
        clock,
        Duration::ZERO,
        LocationLiveProbe::new(|_| false),
    );

    let result = playback.advance_for(Duration::from_millis(80));
    assert_eq!(result, Some(PlaybackFailure::DeviceStale));
    stub.shutdown();
}
