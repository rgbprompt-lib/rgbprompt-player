//! Test-only OpenRGB SDK server stub (PLAYER §11).
//!
//! Implements the same protocol description as `rgbprompt-player-core`, so a
//! shared misreading would pass these tests; the real-device run in M6-C4 is
//! the check for that.
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const MAGIC: [u8; 4] = *b"ORGB";
const HEADER_BYTES: usize = 16;
const MAX_PAYLOAD: usize = 4 * 1024 * 1024;

const REQUEST_CONTROLLER_COUNT: u32 = 0;
const REQUEST_CONTROLLER_DATA: u32 = 1;
const REQUEST_PROTOCOL_VERSION: u32 = 40;
const SET_CLIENT_NAME: u32 = 50;
const DEVICE_LIST_UPDATED: u32 = 100;
const RGBCONTROLLER_UPDATELEDS: u32 = 1050;
const RGBCONTROLLER_SETCUSTOMMODE: u32 = 1100;
const RGBCONTROLLER_UPDATEMODE: u32 = 1101;
const REQUEST_RESCAN_DEVICES: u32 = 140;

const KEY_NAMES_JSON: &str = include_str!("../../core/data/openrgb-key-names.json");

pub const DEVICE_TYPE_KEYBOARD: i32 = 5;
pub const DEVICE_TYPE_MOUSE: i32 = 6;

#[derive(Clone, Debug)]
pub struct StubConfig {
    /// Server protocol version. `0` means "never reply to
    /// REQUEST_PROTOCOL_VERSION"; the client then treats the server as 0.
    pub protocol_version: u32,
    pub controllers: Vec<StubController>,
}

#[derive(Clone, Debug)]
pub struct StubController {
    pub kind: i32,
    pub name: String,
    pub vendor: String,
    pub description: String,
    pub version: String,
    pub serial: String,
    pub location: String,
    pub modes: Vec<StubMode>,
    pub active_mode: i32,
    pub zones: Vec<StubZone>,
    pub leds: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct StubMode {
    pub name: String,
    pub value: i32,
    pub flags: u32,
    pub speed_min: u32,
    pub speed_max: u32,
    pub brightness_min: u32,
    pub brightness_max: u32,
    pub colors_min: u32,
    pub colors_max: u32,
    pub speed: u32,
    pub brightness: u32,
    pub direction: u32,
    pub color_mode: u32,
    pub colors: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct StubZone {
    pub name: String,
    /// 0 single, 1 linear, 2 matrix.
    pub zone_type: i32,
    pub leds_count: u32,
}

#[derive(Clone, Debug)]
pub struct StubControllerState {
    pub active_mode: i32,
    pub colors: Vec<[u8; 3]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StubEvent {
    ClientName(String),
    ProtocolVersion(u32),
    ControllerCount,
    ControllerData,
    SetCustomMode {
        dev: u32,
    },
    UpdateLeds {
        dev: u32,
        colors: Vec<[u8; 3]>,
    },
    UpdateMode {
        dev: u32,
        mode_idx: i32,
        block: Vec<u8>,
    },
    DeviceListUpdated,
    ControllerRemoved {
        index: usize,
    },
    RescanDevices,
    BadPacket {
        reason: String,
    },
}

struct Shared {
    config: StubConfig,
    states: Vec<StubControllerState>,
    events: Vec<StubEvent>,
    /// Mode blocks served per controller, in the version of the last
    /// controller-data request.
    served_blocks: Vec<Vec<Vec<u8>>>,
    /// Cloned client sockets used to broadcast unsolicited notifications.
    writers: Vec<TcpStream>,
}

pub struct StubServer {
    addr: SocketAddr,
    shared: Arc<Mutex<Shared>>,
    shutdown: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
    connections: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl StubServer {
    pub fn start(config: StubConfig) -> io::Result<StubServer> {
        Self::start_on(0, config)
    }

    pub fn start_on(port: u16, config: StubConfig) -> io::Result<StubServer> {
        let listener = TcpListener::bind(("127.0.0.1", port))?;
        let addr = listener.local_addr()?;
        listener.set_nonblocking(true)?;

        let states = config
            .controllers
            .iter()
            .map(|controller| StubControllerState {
                active_mode: controller.active_mode,
                colors: vec![[0, 0, 0]; controller.leds.len()],
            })
            .collect();
        let served_blocks = config
            .controllers
            .iter()
            .map(|controller| vec![Vec::new(); controller.modes.len()])
            .collect();
        let shared = Arc::new(Mutex::new(Shared {
            config,
            states,
            events: Vec::new(),
            served_blocks,
            writers: Vec::new(),
        }));
        let shutdown = Arc::new(AtomicBool::new(false));
        let connections: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));

        let accept_shared = Arc::clone(&shared);
        let accept_shutdown = Arc::clone(&shutdown);
        let accept_connections = Arc::clone(&connections);
        let listener_thread = thread::spawn(move || loop {
            if accept_shutdown.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _addr)) => {
                    let shared = Arc::clone(&accept_shared);
                    let shutdown = Arc::clone(&accept_shutdown);
                    if let Ok(mut handles) = accept_connections.lock() {
                        handles.push(thread::spawn(move || {
                            let _ = handle_connection(stream, shared, shutdown);
                        }));
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        });

        Ok(StubServer {
            addr,
            shared,
            shutdown,
            listener: Some(listener_thread),
            connections,
        })
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn events(&self) -> Vec<StubEvent> {
        self.shared
            .lock()
            .map(|shared| shared.events.clone())
            .unwrap_or_default()
    }

    pub fn controller(&self, index: usize) -> Option<StubControllerState> {
        self.shared
            .lock()
            .ok()
            .and_then(|shared| shared.states.get(index).cloned())
    }

    /// The mode block served for `mode_idx` in the last controller-data reply.
    /// Send the unsolicited `DEVICE_LIST_UPDATED` packet to every connected
    /// client, as real OpenRGB does on hot-plug.
    pub fn emit_device_list_updated(&self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.events.push(StubEvent::DeviceListUpdated);
            for writer in &mut shared.writers {
                let _ = write_reply(writer, 0, DEVICE_LIST_UPDATED, &[]);
            }
        }
    }

    /// Add a controller to the list (a device was plugged in).
    pub fn add_controller(&self, controller: StubController) {
        if let Ok(mut shared) = self.shared.lock() {
            let state = StubControllerState {
                active_mode: controller.active_mode,
                colors: vec![[0, 0, 0]; controller.leds.len()],
            };
            let blocks = vec![Vec::new(); controller.modes.len()];
            shared.config.controllers.push(controller);
            shared.states.push(state);
            shared.served_blocks.push(blocks);
        }
    }

    pub fn controller_count_requests(&self) -> usize {
        self.events()
            .iter()
            .filter(|event| matches!(event, StubEvent::ControllerCount))
            .count()
    }

    /// Remove a controller from the list (a device was unplugged).
    pub fn remove_controller(&self, index: usize) {
        if let Ok(mut shared) = self.shared.lock() {
            if index < shared.config.controllers.len() {
                shared.config.controllers.remove(index);
                shared.states.remove(index);
                shared.served_blocks.remove(index);
                shared.events.push(StubEvent::ControllerRemoved { index });
            }
        }
    }

    pub fn served_mode_block(&self, controller: usize, mode_idx: usize) -> Option<Vec<u8>> {
        self.shared.lock().ok().and_then(|shared| {
            shared
                .served_blocks
                .get(controller)
                .and_then(|blocks| blocks.get(mode_idx))
                .cloned()
        })
    }

    pub fn shutdown(&mut self) {
        if self.shutdown.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut shared) = self.shared.lock() {
            // Dropping the cloned sockets makes clients see EOF promptly.
            shared.writers.clear();
        }
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
        let handles = self
            .connections
            .lock()
            .map(|mut handles| std::mem::take(&mut *handles))
            .unwrap_or_default();
        for handle in handles {
            let _ = handle.join();
        }
    }
}

impl Drop for StubServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl StubController {
    pub fn per_key_ansi104() -> StubController {
        let leds = key_names_table()
            .into_iter()
            .map(|(_, aliases)| aliases[0].clone())
            .rev()
            .collect();
        per_key_controller(leds)
    }

    pub fn per_key_tkl() -> StubController {
        let leds = key_names_table()
            .into_iter()
            .filter(|(key, _)| key != "NUMLOCK" && !key.starts_with("KP_"))
            .map(|(_, aliases)| aliases[0].clone())
            .rev()
            .collect();
        per_key_controller(leds)
    }

    pub fn zones(count: usize) -> StubController {
        StubController {
            kind: DEVICE_TYPE_KEYBOARD,
            name: "Zone Keyboard".to_string(),
            vendor: "Stub".to_string(),
            description: String::new(),
            version: String::new(),
            serial: String::new(),
            location: String::new(),
            modes: preset_modes(),
            active_mode: 2,
            zones: vec![StubZone {
                name: "Zones".to_string(),
                zone_type: 1,
                leds_count: count as u32,
            }],
            leds: (1..=count).map(|index| format!("Zone {index}")).collect(),
        }
    }

    pub fn single() -> StubController {
        StubController {
            kind: DEVICE_TYPE_KEYBOARD,
            name: "Single Keyboard".to_string(),
            vendor: "Stub".to_string(),
            description: String::new(),
            version: String::new(),
            serial: String::new(),
            location: String::new(),
            modes: preset_modes(),
            active_mode: 2,
            zones: vec![StubZone {
                name: "Backlight".to_string(),
                zone_type: 0,
                leds_count: 1,
            }],
            leds: vec!["Backlight".to_string()],
        }
    }

    pub fn mouse() -> StubController {
        StubController {
            kind: DEVICE_TYPE_MOUSE,
            name: "Stub Mouse".to_string(),
            vendor: "Stub".to_string(),
            description: String::new(),
            version: String::new(),
            serial: String::new(),
            location: "usb-1234:5678".to_string(),
            modes: preset_modes(),
            active_mode: 2,
            zones: vec![StubZone {
                name: "Logo".to_string(),
                zone_type: 0,
                leds_count: 1,
            }],
            leds: vec!["Logo".to_string()],
        }
    }
}

fn per_key_controller(leds: Vec<String>) -> StubController {
    StubController {
        kind: DEVICE_TYPE_KEYBOARD,
        name: "Per-key Keyboard".to_string(),
        vendor: "Stub".to_string(),
        description: String::new(),
        version: String::new(),
        serial: String::new(),
        location: String::new(),
        modes: preset_modes(),
        active_mode: 2,
        zones: vec![StubZone {
            name: "Keys".to_string(),
            zone_type: 2,
            leds_count: leds.len() as u32,
        }],
        leds,
    }
}

fn preset_modes() -> Vec<StubMode> {
    vec![
        mode("Direct", 0),
        mode("Static", 1),
        mode("Rainbow Wave", 2),
    ]
}

fn mode(name: &str, value: i32) -> StubMode {
    StubMode {
        name: name.to_string(),
        value,
        flags: 0,
        speed_min: 0,
        speed_max: 5,
        brightness_min: 0,
        brightness_max: 100,
        colors_min: 0,
        colors_max: 1,
        speed: 2,
        brightness: 50,
        direction: 0,
        color_mode: 0,
        colors: Vec::new(),
    }
}

fn key_names_table() -> Vec<(String, Vec<String>)> {
    let table: HashMap<String, Vec<String>> =
        serde_json::from_str(KEY_NAMES_JSON).expect("embedded key names are valid");
    table.into_iter().collect()
}

enum ReadOutcome {
    Packet {
        dev: u32,
        packet: u32,
        payload: Vec<u8>,
    },
    Timeout,
    Closed,
}

fn handle_connection(
    mut stream: TcpStream,
    shared: Arc<Mutex<Shared>>,
    shutdown: Arc<AtomicBool>,
) -> io::Result<()> {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    if let Ok(writer) = stream.try_clone() {
        if let Ok(mut shared) = shared.lock() {
            shared.writers.push(writer);
        }
    }

    loop {
        if shutdown.load(Ordering::SeqCst) {
            return Ok(());
        }
        match read_packet(&mut stream, &shutdown) {
            Ok(ReadOutcome::Packet {
                dev,
                packet,
                payload,
            }) => match handle_packet(dev, packet, &payload, &mut stream, &shared) {
                Ok(Close::No) => {}
                Ok(Close::Yes) => return Ok(()),
                Err(error) => {
                    record(
                        &shared,
                        StubEvent::BadPacket {
                            reason: error.to_string(),
                        },
                    );
                    return Ok(());
                }
            },
            Ok(ReadOutcome::Timeout) => continue,
            Ok(ReadOutcome::Closed) => return Ok(()),
            Err(error) => {
                if shutdown.load(Ordering::SeqCst) {
                    return Ok(());
                }
                record(
                    &shared,
                    StubEvent::BadPacket {
                        reason: error.to_string(),
                    },
                );
                return Ok(());
            }
        }
    }
}

fn read_packet(stream: &mut TcpStream, shutdown: &AtomicBool) -> io::Result<ReadOutcome> {
    let mut header = [0u8; HEADER_BYTES];
    let mut read = 0;
    while read < HEADER_BYTES {
        if shutdown.load(Ordering::SeqCst) {
            return Ok(ReadOutcome::Timeout);
        }
        match stream.read(&mut header[read..]) {
            Ok(0) => return Ok(ReadOutcome::Closed),
            Ok(count) => read += count,
            Err(error) if is_timeout(&error) => {
                if read == 0 {
                    return Ok(ReadOutcome::Timeout);
                }
            }
            Err(error) => return Err(error),
        }
    }
    if header[0..4] != MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad packet magic",
        ));
    }
    let dev = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    let packet = u32::from_le_bytes([header[8], header[9], header[10], header[11]]);
    let size = u32::from_le_bytes([header[12], header[13], header[14], header[15]]) as usize;
    if size > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "payload exceeds the cap",
        ));
    }
    let mut payload = vec![0u8; size];
    let mut read = 0;
    while read < size {
        if shutdown.load(Ordering::SeqCst) {
            return Ok(ReadOutcome::Timeout);
        }
        match stream.read(&mut payload[read..]) {
            Ok(0) => return Ok(ReadOutcome::Closed),
            Ok(count) => read += count,
            Err(error) if is_timeout(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(ReadOutcome::Packet {
        dev,
        packet,
        payload,
    })
}

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    )
}

enum Close {
    No,
    Yes,
}

fn handle_packet(
    dev: u32,
    packet: u32,
    payload: &[u8],
    stream: &mut TcpStream,
    shared: &Arc<Mutex<Shared>>,
) -> io::Result<Close> {
    match packet {
        SET_CLIENT_NAME => {
            let name = parse_string(payload)?;
            record(shared, StubEvent::ClientName(name));
            Ok(Close::No)
        }
        REQUEST_PROTOCOL_VERSION => {
            let mut reader = Reader::new(payload);
            let _client_max = reader.u32()?;
            let server = shared
                .lock()
                .map(|shared| shared.config.protocol_version)
                .unwrap_or(0);
            record(shared, StubEvent::ProtocolVersion(server));
            if server > 0 {
                write_reply(stream, dev, packet, &server.to_le_bytes())?;
            }
            Ok(Close::No)
        }
        REQUEST_CONTROLLER_COUNT => {
            let count = shared
                .lock()
                .map(|shared| shared.config.controllers.len())
                .unwrap_or(0) as u32;
            record(shared, StubEvent::ControllerCount);
            write_reply(stream, dev, packet, &count.to_le_bytes())?;
            Ok(Close::No)
        }
        REQUEST_CONTROLLER_DATA => {
            let mut reader = Reader::new(payload);
            let requested_version = if reader.remaining() >= 4 {
                reader.u32()?
            } else {
                0
            };
            let mut shared = match shared.lock() {
                Ok(shared) => shared,
                Err(_) => return Ok(Close::Yes),
            };
            let index = dev as usize;
            let Some(controller) = shared.config.controllers.get(index).cloned() else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "controller index out of range",
                ));
            };
            let server_version = shared.config.protocol_version;
            let version = if server_version == 0 {
                0
            } else {
                requested_version.min(server_version)
            };
            let (payload, blocks) = serialize_controller_data(&controller, version);
            if let Some(slot) = shared.served_blocks.get_mut(index) {
                *slot = blocks;
            }
            shared.events.push(StubEvent::ControllerData);
            drop(shared);
            write_reply(stream, dev, packet, &payload)?;
            Ok(Close::No)
        }
        RGBCONTROLLER_UPDATELEDS => {
            let mut reader = Reader::new(payload);
            let data_size = reader.u32()? as usize;
            if data_size != payload.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "UpdateLEDs data_size {data_size} disagrees with the payload {}",
                        payload.len()
                    ),
                ));
            }
            let count = reader.u16()? as usize;
            let mut colors = Vec::with_capacity(count);
            for _ in 0..count {
                let value = reader.u32()?;
                let bytes = value.to_le_bytes();
                colors.push([bytes[0], bytes[1], bytes[2]]);
            }
            let mut shared = match shared.lock() {
                Ok(shared) => shared,
                Err(_) => return Ok(Close::Yes),
            };
            let index = dev as usize;
            let expected = shared
                .config
                .controllers
                .get(index)
                .map(|controller| controller.leds.len());
            match expected {
                Some(expected) if expected == count => {
                    if let Some(state) = shared.states.get_mut(index) {
                        state.colors = colors.clone();
                    }
                    shared.events.push(StubEvent::UpdateLeds { dev, colors });
                    Ok(Close::No)
                }
                _ => {
                    let reason = format!("{count} LED colours do not match controller {dev}");
                    shared.events.push(StubEvent::BadPacket { reason });
                    Ok(Close::Yes)
                }
            }
        }
        RGBCONTROLLER_SETCUSTOMMODE => {
            let mut shared = match shared.lock() {
                Ok(shared) => shared,
                Err(_) => return Ok(Close::Yes),
            };
            let index = dev as usize;
            let Some(controller) = shared.config.controllers.get(index) else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "controller index out of range",
                ));
            };
            let direct = controller
                .modes
                .iter()
                .position(|mode| mode.name.eq_ignore_ascii_case("Direct"))
                .unwrap_or(0) as i32;
            if let Some(state) = shared.states.get_mut(index) {
                state.active_mode = direct;
            }
            shared.events.push(StubEvent::SetCustomMode { dev });
            Ok(Close::No)
        }
        RGBCONTROLLER_UPDATEMODE => {
            let mut reader = Reader::new(payload);
            let data_size = reader.u32()? as usize;
            if data_size != payload.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "UpdateMode data_size disagrees with the payload",
                ));
            }
            let mode_idx = reader.i32()?;
            let block = reader.take(reader.remaining())?.to_vec();
            let mut shared = match shared.lock() {
                Ok(shared) => shared,
                Err(_) => return Ok(Close::Yes),
            };
            let index = dev as usize;
            if index >= shared.config.controllers.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "controller index out of range",
                ));
            }
            if let Some(state) = shared.states.get_mut(index) {
                state.active_mode = mode_idx;
            }
            shared.events.push(StubEvent::UpdateMode {
                dev,
                mode_idx,
                block,
            });
            Ok(Close::No)
        }
        REQUEST_RESCAN_DEVICES => {
            let mut shared = match shared.lock() {
                Ok(shared) => shared,
                Err(_) => return Ok(Close::Yes),
            };
            shared.events.push(StubEvent::RescanDevices);
            Ok(Close::No)
        }
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown packet id {other}"),
        )),
    }
}

fn record(shared: &Arc<Mutex<Shared>>, event: StubEvent) {
    if let Ok(mut shared) = shared.lock() {
        shared.events.push(event);
    }
}

fn write_reply(stream: &mut TcpStream, dev: u32, packet: u32, payload: &[u8]) -> io::Result<()> {
    let mut header = [0u8; HEADER_BYTES];
    header[0..4].copy_from_slice(&MAGIC);
    header[4..8].copy_from_slice(&dev.to_le_bytes());
    header[8..12].copy_from_slice(&packet.to_le_bytes());
    header[12..16].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    stream.write_all(&header)?;
    stream.write_all(payload)?;
    stream.flush()
}

fn serialize_controller_data(controller: &StubController, version: u32) -> (Vec<u8>, Vec<Vec<u8>>) {
    let mut body = Vec::new();
    body.extend_from_slice(&controller.kind.to_le_bytes());
    write_string(&mut body, &controller.name);
    if version >= 1 {
        write_string(&mut body, &controller.vendor);
    }
    write_string(&mut body, &controller.description);
    write_string(&mut body, &controller.version);
    write_string(&mut body, &controller.serial);
    write_string(&mut body, &controller.location);

    body.extend_from_slice(&(controller.modes.len() as u16).to_le_bytes());
    body.extend_from_slice(&controller.active_mode.to_le_bytes());
    let mut blocks = Vec::with_capacity(controller.modes.len());
    for mode in &controller.modes {
        let block = serialize_mode(mode, version);
        blocks.push(block.clone());
        body.extend_from_slice(&block);
    }

    body.extend_from_slice(&(controller.zones.len() as u16).to_le_bytes());
    for zone in &controller.zones {
        write_string(&mut body, &zone.name);
        body.extend_from_slice(&zone.zone_type.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&zone.leds_count.to_le_bytes());
        body.extend_from_slice(&zone.leds_count.to_le_bytes());
        body.extend_from_slice(&0u16.to_le_bytes());
    }

    body.extend_from_slice(&(controller.leds.len() as u16).to_le_bytes());
    for (index, name) in controller.leds.iter().enumerate() {
        write_string(&mut body, name);
        body.extend_from_slice(&(index as u32).to_le_bytes());
    }

    body.extend_from_slice(&0u16.to_le_bytes());

    let mut payload = Vec::with_capacity(body.len() + 4);
    payload.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
    payload.extend_from_slice(&body);
    (payload, blocks)
}

fn serialize_mode(mode: &StubMode, version: u32) -> Vec<u8> {
    let mut out = Vec::new();
    write_string(&mut out, &mode.name);
    out.extend_from_slice(&mode.value.to_le_bytes());
    out.extend_from_slice(&mode.flags.to_le_bytes());
    out.extend_from_slice(&mode.speed_min.to_le_bytes());
    out.extend_from_slice(&mode.speed_max.to_le_bytes());
    if version >= 3 {
        out.extend_from_slice(&mode.brightness_min.to_le_bytes());
        out.extend_from_slice(&mode.brightness_max.to_le_bytes());
    }
    out.extend_from_slice(&mode.colors_min.to_le_bytes());
    out.extend_from_slice(&mode.colors_max.to_le_bytes());
    out.extend_from_slice(&mode.speed.to_le_bytes());
    if version >= 3 {
        out.extend_from_slice(&mode.brightness.to_le_bytes());
    }
    out.extend_from_slice(&mode.direction.to_le_bytes());
    out.extend_from_slice(&mode.color_mode.to_le_bytes());
    out.extend_from_slice(&(mode.colors.len() as u16).to_le_bytes());
    for color in &mode.colors {
        out.extend_from_slice(&color.to_le_bytes());
    }
    out
}

fn write_string(out: &mut Vec<u8>, value: &str) {
    let bytes = value.as_bytes();
    out.extend_from_slice(&((bytes.len() + 1) as u16).to_le_bytes());
    out.extend_from_slice(bytes);
    out.push(0);
}

fn parse_string(payload: &[u8]) -> io::Result<String> {
    let mut reader = Reader::new(payload);
    let length = reader.u16()? as usize;
    if length == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "string length cannot be zero",
        ));
    }
    let bytes = reader.take(length)?;
    if bytes[length - 1] != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "string is missing its trailing NUL",
        ));
    }
    String::from_utf8(bytes[..length - 1].to_vec())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "string is not UTF-8"))
}

struct Reader<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len() - self.position
    }

    fn take(&mut self, count: usize) -> io::Result<&'a [u8]> {
        let end = self
            .position
            .checked_add(count)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "length overflow"))?;
        if end > self.data.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "packet ended early",
            ));
        }
        let slice = &self.data[self.position..end];
        self.position = end;
        Ok(slice)
    }

    fn u16(&mut self) -> io::Result<u16> {
        let bytes = self.take(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self) -> io::Result<u32> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn i32(&mut self) -> io::Result<i32> {
        Ok(self.u32()? as i32)
    }
}
