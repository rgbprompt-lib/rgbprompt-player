use std::ffi::{c_void, CString};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use rgbprompt_player::*;
use serde_json::json;

const LEP: &[u8] = include_bytes!("../../core/tests/data/example-cyber-breath.lep");
const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn valid_manifest(url: &str) -> String {
    json!({
        "schema": 1,
        "variant": "standard",
        "version": "9.9",
        "platform": "macos",
        "arch": "arm64",
        "archive": "zip",
        "size_bytes": 1024,
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "executable": "OpenRGB.app/Contents/MacOS/OpenRGB",
        "args": ["--server", "--server-port", "{port}"],
        "urls": [{ "kind": "official", "url": url }],
        "license": "GPL-2.0-only",
        "source": "https://openrgb.org",
    })
    .to_string()
}

fn open_handle(api_base: &str) -> *mut RgbpHandle {
    let data_dir = std::env::temp_dir().join(format!(
        "rgbprompt-ffi-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&data_dir).expect("data dir");
    let data_dir = CString::new(data_dir.display().to_string()).unwrap();
    let api_base = CString::new(api_base).unwrap();
    let platform = CString::new("mac").unwrap();
    let language = CString::new("en").unwrap();
    let version = CString::new("0.3.0").unwrap();
    let os = CString::new("14.2.0").unwrap();
    let openrgb = CString::new("127.0.0.1:1").unwrap();
    let config = RgbpConfig {
        data_dir: data_dir.as_ptr(),
        api_base: api_base.as_ptr(),
        platform: platform.as_ptr(),
        language: language.as_ptr(),
        app_version: version.as_ptr(),
        os_version: os.as_ptr(),
        openrgb_addr: openrgb.as_ptr(),
    };
    let handle = unsafe { rgbp_create(&config) };
    assert!(!handle.is_null(), "rgbp_create returned null");
    handle
}

fn set_manifest(handle: *mut RgbpHandle, json: &str) -> i32 {
    let json = CString::new(json).unwrap();
    unsafe { rgbp_set_driver_manifest_json(handle, json.as_ptr()) }
}

#[test]
fn override_requires_a_verified_loopback_manifest_in_idle() {
    let handle = open_handle("http://127.0.0.1:1/api");
    assert_eq!(
        set_manifest(handle, &valid_manifest("http://127.0.0.1:1/openrgb.zip")),
        RGBP_OK
    );

    let unverified = valid_manifest("http://127.0.0.1:1/openrgb.zip").replace(
        "\"0000000000000000000000000000000000000000000000000000000000000000\"",
        "null",
    );
    assert_eq!(set_manifest(handle, &unverified), RGBP_ERR_INVALID_ARGUMENT);
    assert_eq!(
        set_manifest(handle, &valid_manifest("http://example.com/openrgb.zip")),
        RGBP_ERR_INVALID_ARGUMENT
    );
    assert_eq!(set_manifest(handle, "{not json"), RGBP_ERR_INVALID_ARGUMENT);
    unsafe { rgbp_destroy(handle) };
}

#[derive(Default)]
struct StateProbe {
    state: AtomicI32,
    progress: AtomicI32,
}

unsafe extern "C" fn capture_state(event: *const RgbpStateEvent, user: *mut c_void) {
    let probe = unsafe { &*(user as *const StateProbe) };
    if let Some(event) = unsafe { event.as_ref() } {
        probe.state.store(event.state, Ordering::SeqCst);
        probe
            .progress
            .store(event.driver_progress, Ordering::SeqCst);
    }
}

/// Reads the whole request (headers and Content-Length body). On Windows,
/// closing a socket with unread bytes sends RST, and the client then loses the
/// response, so the stub must drain the request before replying.
fn read_request(stream: &mut std::net::TcpStream) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut data = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(n) => data.extend_from_slice(&buffer[..n]),
        }
        if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&data[..end]).to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if data.len() >= end + 4 + length {
                return;
            }
        }
    }
}

struct RedeemStub {
    addr: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
}

impl RedeemStub {
    fn start() -> RedeemStub {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        read_request(&mut stream);
                        let response = json!({
                            "effect": {},
                            "lep": base64::engine::general_purpose::STANDARD.encode(LEP),
                            "name": "Demo",
                            "compiledHash": "hash",
                            "engineVersion": "0.4.0",
                            "minPlayerVersion": "0.3.0",
                            "ackDeadline": SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap()
                                .as_millis() as u64
                                + 1_800_000,
                        })
                        .to_string();
                        let payload = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                            response.len()
                        );
                        let _ = stream.write_all(payload.as_bytes());
                    }
                    Err(_) => thread::sleep(Duration::from_millis(2)),
                }
            }
        });
        RedeemStub { addr, stop }
    }
}

impl Drop for RedeemStub {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(self.addr);
    }
}

struct SlowServer {
    addr: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
}

impl SlowServer {
    fn start() -> SlowServer {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind slow");
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0u8; 1024];
                        let _ = stream.read(&mut request);
                        let header = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n";
                        if stream.write_all(header.as_bytes()).is_err() {
                            continue;
                        }
                        for _ in 0..4096 {
                            if thread_stop.load(Ordering::SeqCst) {
                                break;
                            }
                            if stream.write_all(&[0u8]).is_err() {
                                break;
                            }
                            thread::sleep(Duration::from_millis(5));
                        }
                    }
                    Err(_) => thread::sleep(Duration::from_millis(2)),
                }
            }
        });
        SlowServer { addr, stop }
    }
}

impl Drop for SlowServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = std::net::TcpStream::connect(self.addr);
    }
}

#[test]
fn override_is_rejected_while_an_install_runs() {
    let redeem = RedeemStub::start();
    let slow = SlowServer::start();
    let handle = open_handle(&format!("http://{}/api", redeem.addr));

    let probe = Box::new(StateProbe::default());
    unsafe {
        assert_eq!(
            rgbp_set_state_callback(
                handle,
                Some(capture_state),
                Box::as_ref(&probe) as *const StateProbe as *mut c_void
            ),
            RGBP_OK
        );
    }

    let url = CString::new(format!("rgbprompt://play?t={TOKEN}&v=1")).unwrap();
    unsafe {
        assert_eq!(rgbp_open_url(handle, url.as_ptr()), RGBP_OK);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && probe.state.load(Ordering::SeqCst) != 2 {
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        probe.state.load(Ordering::SeqCst),
        2,
        "never reached NeedsDriver"
    );

    let manifest = valid_manifest(&format!(
        "http://127.0.0.1:{}/openrgb.zip",
        slow.addr.port()
    ));
    assert_eq!(set_manifest(handle, &manifest), RGBP_OK);
    unsafe {
        assert_eq!(rgbp_install_driver(handle), RGBP_OK);
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut saw_progress = false;
    while Instant::now() < deadline {
        if probe.progress.load(Ordering::SeqCst) >= 0 {
            saw_progress = true;
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(saw_progress, "install never reported progress");
    assert_eq!(
        set_manifest(handle, &manifest),
        RGBP_ERR_INVALID_ARGUMENT,
        "an override must be rejected while an install runs"
    );

    unsafe {
        let _ = rgbp_stop(handle);
        rgbp_destroy(handle);
    }
    drop(slow);
    drop(redeem);
}
