#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    pub body: String,
}

pub struct HttpStub {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    shutdown: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl HttpStub {
    pub fn start(
        handler: impl Fn(&str, &str, &str) -> (u16, String) + Send + Sync + 'static,
    ) -> HttpStub {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind HTTP stub");
        let addr = listener.local_addr().expect("stub addr");
        listener.set_nonblocking(true).expect("nonblocking");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let handler = Arc::new(handler);

        let accept_requests = Arc::clone(&requests);
        let accept_shutdown = Arc::clone(&shutdown);
        let accept = thread::spawn(move || {
            let mut workers: Vec<JoinHandle<()>> = Vec::new();
            loop {
                if accept_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        let requests = Arc::clone(&accept_requests);
                        let handler = Arc::clone(&handler);
                        workers.push(thread::spawn(move || {
                            let _ = handle(stream, requests, handler);
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
            for worker in workers {
                let _ = worker.join();
            }
        });

        HttpStub {
            addr,
            requests,
            shutdown,
            accept: Some(accept),
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().expect("requests").clone()
    }

    pub fn shutdown(&mut self) {
        if self.shutdown.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = TcpStream::connect(self.addr);
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

impl Drop for HttpStub {
    fn drop(&mut self) {
        self.shutdown();
    }
}

type Handler = dyn Fn(&str, &str, &str) -> (u16, String) + Send + Sync;

fn handle(
    mut stream: TcpStream,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    handler: Arc<Handler>,
) -> std::io::Result<()> {
    // macOS can inherit O_NONBLOCK from the nonblocking listener.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(headers_end) = find(&buffer, b"\r\n\r\n") {
            let header_text = String::from_utf8_lossy(&buffer[..headers_end]).to_string();
            let content_length = header_text
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if name.eq_ignore_ascii_case("content-length") {
                        value.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            let body_start = headers_end + 4;
            while buffer.len() < body_start + content_length {
                let read = stream.read(&mut chunk)?;
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..read]);
            }
            let body = String::from_utf8_lossy(&buffer[body_start..body_start + content_length])
                .to_string();
            let first_line = header_text.lines().next().unwrap_or_default();
            let mut parts = first_line.split_whitespace();
            let method = parts.next().unwrap_or_default().to_string();
            let path = parts.next().unwrap_or_default().to_string();
            requests.lock().expect("requests").push(RecordedRequest {
                method: method.clone(),
                path: path.clone(),
                body: body.clone(),
            });
            let (status, response) = handler(&method, &path, &body);
            let payload = format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            );
            stream.write_all(payload.as_bytes())?;
            stream.flush()?;
            return Ok(());
        }
    }
    Ok(())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub fn wait_until(timeout: Duration, predicate: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if predicate() {
            return true;
        }
        thread::sleep(Duration::from_millis(5));
    }
    predicate()
}

use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

pub fn free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("free port");
    listener.local_addr().expect("addr").port()
}

pub fn free_port_range(span: u16) -> u16 {
    static OFFSET: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
    let offset = OFFSET.fetch_add(1, Ordering::Relaxed) * 23 % 15000;
    for base in (40000 + offset..=60000).step_by(19) {
        if base + span > 65000 {
            break;
        }
        let all_free =
            (0..span).all(|offset| TcpListener::bind(("127.0.0.1", base + offset)).is_ok());
        if all_free {
            return base;
        }
    }
    panic!("no free port range");
}

pub fn temp_dir(prefix: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rgbprompt-{prefix}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn zip_bytes(entries: &[(&str, Vec<u8>, u32)]) -> Vec<u8> {
    use std::io::Write as _;
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data, mode) in entries {
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(*mode);
        writer.start_file(*name, options).expect("zip entry");
        writer.write_all(data).expect("zip write");
    }
    writer.finish().expect("zip finish").into_inner()
}

pub fn stub_binary() -> PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let core_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace = core_dir.join("../..");
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
        let status = Command::new(cargo)
            .args(["build", "-q", "-p", "openrgb-stub"])
            .current_dir(&workspace)
            .status()
            .expect("run cargo build -p openrgb-stub");
        assert!(status.success(), "openrgb-stub must build");
        let target = std::env::var("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| workspace.join("target"));
        let profile = if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        };
        let path = target
            .join(profile)
            .join(format!("openrgb-stub{}", std::env::consts::EXE_SUFFIX));
        assert!(path.is_file(), "{} is missing", path.display());
        path
    })
    .clone()
}

type FileHandler = dyn Fn(&str) -> (u16, Vec<u8>) + Send + Sync;

pub struct FileServer {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<String>>>,
    shutdown: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl FileServer {
    pub fn start(handler: impl Fn(&str) -> (u16, Vec<u8>) + Send + Sync + 'static) -> FileServer {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind file server");
        let addr = listener.local_addr().expect("file server addr");
        listener.set_nonblocking(true).expect("nonblocking");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let handler: Arc<FileHandler> = Arc::new(handler);
        let accept_requests = Arc::clone(&requests);
        let accept_shutdown = Arc::clone(&shutdown);
        let accept = thread::spawn(move || {
            let mut workers: Vec<JoinHandle<()>> = Vec::new();
            loop {
                if accept_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        let requests = Arc::clone(&accept_requests);
                        let handler = Arc::clone(&handler);
                        workers.push(thread::spawn(move || {
                            let _ = serve_file(stream, requests, handler);
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
            for worker in workers {
                let _ = worker.join();
            }
        });
        FileServer {
            addr,
            requests,
            shutdown,
            accept: Some(accept),
        }
    }

    pub fn start_bytes(body: Vec<u8>) -> FileServer {
        Self::start(move |_| (200, body.clone()))
    }

    pub fn url(&self) -> String {
        format!("http://{}/openrgb.zip", self.addr)
    }

    pub fn url_path(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }

    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().expect("requests").clone()
    }

    pub fn shutdown(&mut self) {
        if self.shutdown.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = TcpStream::connect(self.addr);
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

impl Drop for FileServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn serve_file(
    mut stream: TcpStream,
    requests: Arc<Mutex<Vec<String>>>,
    handler: Arc<FileHandler>,
) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if find(&buffer, b"\r\n\r\n").is_some() {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buffer);
    let path = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_string();
    requests.lock().expect("requests").push(path.clone());
    let (status, body) = handler(&path);
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(&body)?;
    stream.flush()
}

pub struct SlowServer {
    addr: SocketAddr,
    shutdown: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl SlowServer {
    pub fn start(body: Vec<u8>, delay: Duration) -> SlowServer {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind slow server");
        let addr = listener.local_addr().expect("slow addr");
        listener.set_nonblocking(true).expect("nonblocking");
        let shutdown = Arc::new(AtomicBool::new(false));
        let accept_shutdown = Arc::clone(&shutdown);
        let accept = thread::spawn(move || {
            let mut workers: Vec<JoinHandle<()>> = Vec::new();
            loop {
                if accept_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let shutdown = Arc::clone(&accept_shutdown);
                        let body = body.clone();
                        workers.push(thread::spawn(move || {
                            let _ = stream.set_nonblocking(false);
                            let mut request = [0u8; 1024];
                            let _ = stream.read(&mut request);
                            let header = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            if stream.write_all(header.as_bytes()).is_err() {
                                return;
                            }
                            for byte in body {
                                if shutdown.load(Ordering::SeqCst) {
                                    return;
                                }
                                if stream.write_all(&[byte]).is_err() {
                                    return;
                                }
                                thread::sleep(delay);
                            }
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
            for worker in workers {
                let _ = worker.join();
            }
        });
        SlowServer {
            addr,
            shutdown,
            accept: Some(accept),
        }
    }

    pub fn url(&self) -> String {
        format!("http://{}/openrgb.zip", self.addr)
    }

    pub fn shutdown(&mut self) {
        if self.shutdown.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = TcpStream::connect(self.addr);
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

impl Drop for SlowServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub struct EmptyLister;

impl rgbprompt_player_core::ProcessLister for EmptyLister {
    fn processes(&self) -> Vec<String> {
        Vec::new()
    }
}

/// Serves `body` honoring `Range: bytes=a-b` (HTTP 206). The first
/// `flaky_requests` responses advertise the full range but close the
/// connection after `cut_after` bytes, like a stalled cross-border link.
pub struct RangeServer {
    addr: SocketAddr,
    ranges: Arc<Mutex<Vec<String>>>,
    shutdown: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl RangeServer {
    pub fn start(body: Vec<u8>, flaky_requests: usize, cut_after: usize) -> RangeServer {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind range server");
        let addr = listener.local_addr().expect("range addr");
        listener.set_nonblocking(true).expect("nonblocking");
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let accept_ranges = Arc::clone(&ranges);
        let accept_shutdown = Arc::clone(&shutdown);
        let body = Arc::new(body);
        let accept = thread::spawn(move || {
            let mut served = 0usize;
            loop {
                if accept_shutdown.load(Ordering::SeqCst) {
                    break;
                }
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                        let mut buffer = Vec::new();
                        let mut chunk = [0u8; 1024];
                        while find(&buffer, b"\r\n\r\n").is_none() {
                            match stream.read(&mut chunk) {
                                Ok(0) | Err(_) => break,
                                Ok(read) => buffer.extend_from_slice(&chunk[..read]),
                            }
                        }
                        let text = String::from_utf8_lossy(&buffer).to_string();
                        let range = text.lines().find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("range")
                                .then(|| value.trim().to_string())
                        });
                        let Some(range) = range else {
                            let header = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = stream.write_all(header.as_bytes());
                            let _ = stream.write_all(&body);
                            continue;
                        };
                        accept_ranges.lock().expect("ranges").push(range.clone());
                        let spec = range.trim_start_matches("bytes=");
                        let (a, b) = spec.split_once('-').unwrap_or((spec, ""));
                        let start: usize = a.parse().unwrap_or(0);
                        let end: usize = b
                            .parse::<usize>()
                            .unwrap_or(body.len() - 1)
                            .min(body.len().saturating_sub(1));
                        if start >= body.len() {
                            let _ = stream.write_all(
                                format!(
                                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                                    body.len()
                                )
                                .as_bytes(),
                            );
                            continue;
                        }
                        let slice = &body[start..=end];
                        let header = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len(),
                            slice.len()
                        );
                        let _ = stream.write_all(header.as_bytes());
                        let send = if served < flaky_requests {
                            &slice[..cut_after.min(slice.len())]
                        } else {
                            slice
                        };
                        served += 1;
                        let _ = stream.write_all(send);
                        let _ = stream.flush();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        RangeServer {
            addr,
            ranges,
            shutdown,
            accept: Some(accept),
        }
    }

    pub fn url(&self) -> String {
        format!("http://{}/openrgb.zip", self.addr)
    }

    pub fn ranges(&self) -> Vec<String> {
        self.ranges.lock().expect("ranges").clone()
    }

    pub fn shutdown(&mut self) {
        if self.shutdown.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = TcpStream::connect(self.addr);
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

impl Drop for RangeServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}
