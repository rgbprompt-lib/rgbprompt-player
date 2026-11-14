//! Blocking OpenRGB SDK client (PLAYER §5, §9).
//!
//! Implemented from the protocol description, not from OpenRGB source
//! (GPL-2). Little-endian throughout; every parse is bounds-checked and a
//! short or inconsistent packet becomes `OpenRgbError::Protocol`, never a
//! panic or an over-read.
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const MAGIC: [u8; 4] = *b"ORGB";
const HEADER_BYTES: usize = 16;
const MAX_PAYLOAD: usize = 4 * 1024 * 1024;
const CLIENT_MAX_VERSION: u32 = 3;

pub const REQUEST_CONTROLLER_COUNT: u32 = 0;
pub const REQUEST_CONTROLLER_DATA: u32 = 1;
pub const REQUEST_PROTOCOL_VERSION: u32 = 40;
pub const SET_CLIENT_NAME: u32 = 50;
/// Unsolicited notification real OpenRGB sends on hot-plug.
pub const DEVICE_LIST_UPDATED: u32 = 100;
pub const REQUEST_RESCAN_DEVICES: u32 = 140;
pub const RGBCONTROLLER_UPDATELEDS: u32 = 1050;
pub const RGBCONTROLLER_SETCUSTOMMODE: u32 = 1100;
pub const RGBCONTROLLER_UPDATEMODE: u32 = 1101;

#[derive(Debug, thiserror::Error)]
pub enum OpenRgbError {
    #[error("OpenRGB I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("OpenRGB protocol error: {0}")]
    Protocol(String),
    #[error("expected packet {expected}, got {actual}")]
    UnexpectedPacket { expected: u32, actual: u32 },
    #[error("controller {0} is out of range")]
    ControllerIndex(u32),
    #[error("got {actual} LED colours, controller has {expected}")]
    LedCount { expected: usize, actual: usize },
    #[error("packet payload {0} exceeds the {MAX_PAYLOAD}-byte cap")]
    PacketTooLarge(usize),
}

#[derive(Clone, Debug)]
pub struct ControllerData {
    pub kind: i32,
    pub name: String,
    pub vendor: String,
    pub description: String,
    pub version: String,
    pub serial: String,
    pub location: String,
    pub active_mode: i32,
    pub modes: Vec<Mode>,
    pub zones: Vec<Zone>,
    pub leds: Vec<Led>,
    pub colors: Vec<[u8; 3]>,
}

#[derive(Clone, Debug)]
pub struct Mode {
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

impl Mode {
    /// Serialise one mode block in the negotiated protocol version's format.
    pub fn to_bytes(&self, protocol_version: u32) -> Vec<u8> {
        let mut out = Vec::new();
        write_string(&mut out, &self.name);
        out.extend_from_slice(&self.value.to_le_bytes());
        out.extend_from_slice(&self.flags.to_le_bytes());
        out.extend_from_slice(&self.speed_min.to_le_bytes());
        out.extend_from_slice(&self.speed_max.to_le_bytes());
        if protocol_version >= 3 {
            out.extend_from_slice(&self.brightness_min.to_le_bytes());
            out.extend_from_slice(&self.brightness_max.to_le_bytes());
        }
        out.extend_from_slice(&self.colors_min.to_le_bytes());
        out.extend_from_slice(&self.colors_max.to_le_bytes());
        out.extend_from_slice(&self.speed.to_le_bytes());
        if protocol_version >= 3 {
            out.extend_from_slice(&self.brightness.to_le_bytes());
        }
        out.extend_from_slice(&self.direction.to_le_bytes());
        out.extend_from_slice(&self.color_mode.to_le_bytes());
        out.extend_from_slice(&(self.colors.len() as u16).to_le_bytes());
        for color in &self.colors {
            out.extend_from_slice(&color.to_le_bytes());
        }
        out
    }
}

#[derive(Clone, Debug)]
pub struct Zone {
    pub name: String,
    pub zone_type: i32,
    pub leds_min: u32,
    pub leds_max: u32,
    pub leds_count: u32,
    pub matrix: Option<Matrix>,
}

#[derive(Clone, Debug)]
pub struct Matrix {
    pub height: u32,
    pub width: u32,
    pub map: Vec<u32>,
}

#[derive(Clone, Debug)]
pub struct Led {
    pub name: String,
    pub value: u32,
}

pub struct OpenRGBClient {
    stream: TcpStream,
    negotiated: u32,
    led_counts: HashMap<u32, usize>,
    device_list_changed: bool,
    answered: bool,
}

impl OpenRGBClient {
    /// Connect, send the client name and negotiate the protocol version. A
    /// missing protocol-version reply means the server is version 0.
    pub fn connect(
        addr: SocketAddr,
        client_name: &str,
        timeout: Duration,
    ) -> Result<Self, OpenRgbError> {
        let stream = TcpStream::connect_timeout(&addr, timeout)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        stream.set_nodelay(true)?;
        let mut client = Self {
            stream,
            negotiated: 0,
            led_counts: HashMap::new(),
            device_list_changed: false,
            answered: false,
        };

        client.send(0, SET_CLIENT_NAME, &encode_string(client_name))?;
        client.send(
            0,
            REQUEST_PROTOCOL_VERSION,
            &CLIENT_MAX_VERSION.to_le_bytes(),
        )?;

        let server_version = loop {
            match client.read_packet()? {
                Some((_dev, packet, payload)) => {
                    if packet == DEVICE_LIST_UPDATED {
                        client.device_list_changed = true;
                        continue;
                    }
                    if packet != REQUEST_PROTOCOL_VERSION {
                        return Err(OpenRgbError::UnexpectedPacket {
                            expected: REQUEST_PROTOCOL_VERSION,
                            actual: packet,
                        });
                    }
                    let mut reader = Reader::new(&payload);
                    let version = reader.u32()?;
                    client.answered = true;
                    break version;
                }
                None => break 0,
            }
        };
        client.negotiated = server_version.min(CLIENT_MAX_VERSION);
        Ok(client)
    }

    pub fn protocol_version(&self) -> u32 {
        self.negotiated
    }

    /// Whether the server actually replied to `REQUEST_PROTOCOL_VERSION`.
    /// Protocol version 0 servers do not reply, so a bare TCP connect is not
    /// enough to tell them apart from an unrelated listener.
    pub fn answered(&self) -> bool {
        self.answered
    }

    pub fn controller_count(&mut self) -> Result<u32, OpenRgbError> {
        self.send(0, REQUEST_CONTROLLER_COUNT, &[])?;
        let (_, packet, payload) = self.expect_reply(REQUEST_CONTROLLER_COUNT)?;
        debug_assert_eq!(packet, REQUEST_CONTROLLER_COUNT);
        let mut reader = Reader::new(&payload);
        reader.u32()
    }

    pub fn controller_data(&mut self, index: u32) -> Result<ControllerData, OpenRgbError> {
        let request = if self.negotiated > 0 {
            self.negotiated.to_le_bytes().to_vec()
        } else {
            Vec::new()
        };
        self.send(index, REQUEST_CONTROLLER_DATA, &request)?;
        let (_, _packet, payload) = self.expect_reply(REQUEST_CONTROLLER_DATA)?;
        let data = parse_controller_data(&payload, self.negotiated)?;
        self.led_counts.insert(index, data.leds.len());
        Ok(data)
    }

    pub fn set_custom_mode(&mut self, index: u32) -> Result<(), OpenRgbError> {
        self.send(index, RGBCONTROLLER_SETCUSTOMMODE, &[])
    }

    pub fn update_leds(&mut self, index: u32, colors: &[[u8; 3]]) -> Result<(), OpenRgbError> {
        let expected = match self.led_counts.get(&index) {
            Some(expected) => *expected,
            None => self.controller_data(index)?.leds.len(),
        };
        if colors.len() != expected {
            return Err(OpenRgbError::LedCount {
                expected,
                actual: colors.len(),
            });
        }

        let size = 4 + 2 + colors.len() * 4;
        let mut payload = Vec::with_capacity(size);
        payload.extend_from_slice(&(size as u32).to_le_bytes());
        payload.extend_from_slice(&(colors.len() as u16).to_le_bytes());
        for color in colors {
            payload.extend_from_slice(&color_to_u32(*color).to_le_bytes());
        }
        self.send(index, RGBCONTROLLER_UPDATELEDS, &payload)
    }

    /// Ask the server to re-detect hardware (protocol packet 140). No reply is
    /// required; clients learn the new list from packet 100 once detection
    /// finishes. This is a best-effort recovery for an external OpenRGB; the
    /// managed driver is restarted when a handle is stale.
    pub fn request_rescan_devices(&mut self) -> Result<(), OpenRgbError> {
        self.send(0, REQUEST_RESCAN_DEVICES, &[])
    }

    /// Whether an unsolicited device-list notification was seen since the last
    /// call. The playback loop drains this even when no request was in flight.
    pub fn take_device_list_changed(&mut self) -> bool {
        std::mem::take(&mut self.device_list_changed)
    }

    /// Read pending unsolicited packets without blocking the frame. Packet 100
    /// sets the flag; other packets are ignored (there is no request to match).
    pub fn poll_device_list_changed(&mut self) -> Result<bool, OpenRgbError> {
        let previous = self.stream.read_timeout()?;
        self.stream
            .set_read_timeout(Some(Duration::from_millis(1)))?;
        let result = self.read_packet();
        let _ = self.stream.set_read_timeout(previous);
        match result {
            Ok(Some((_dev, packet, _payload))) if packet == DEVICE_LIST_UPDATED => {
                self.device_list_changed = true;
                Ok(true)
            }
            Ok(Some(_)) => Ok(false),
            Ok(None) => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn expect_reply(&mut self, expected: u32) -> Result<(u32, u32, Vec<u8>), OpenRgbError> {
        loop {
            match self.read_packet()? {
                Some((dev, packet, payload)) => {
                    if packet == DEVICE_LIST_UPDATED {
                        self.device_list_changed = true;
                        continue;
                    }
                    if packet != expected {
                        return Err(OpenRgbError::UnexpectedPacket {
                            expected,
                            actual: packet,
                        });
                    }
                    return Ok((dev, packet, payload));
                }
                None => {
                    return Err(OpenRgbError::Protocol(format!(
                        "no reply to packet {expected} within the timeout"
                    )))
                }
            }
        }
    }

    fn send(&mut self, dev: u32, packet: u32, payload: &[u8]) -> Result<(), OpenRgbError> {
        if payload.len() > MAX_PAYLOAD {
            return Err(OpenRgbError::PacketTooLarge(payload.len()));
        }
        let mut header = [0u8; HEADER_BYTES];
        header[0..4].copy_from_slice(&MAGIC);
        header[4..8].copy_from_slice(&dev.to_le_bytes());
        header[8..12].copy_from_slice(&packet.to_le_bytes());
        header[12..16].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        self.stream.write_all(&header)?;
        if !payload.is_empty() {
            self.stream.write_all(payload)?;
        }
        self.stream.flush()?;
        Ok(())
    }

    fn read_packet(&mut self) -> Result<Option<(u32, u32, Vec<u8>)>, OpenRgbError> {
        let mut header = [0u8; HEADER_BYTES];
        let mut read = 0;
        while read < HEADER_BYTES {
            match self.stream.read(&mut header[read..]) {
                Ok(0) => {
                    return Err(OpenRgbError::Protocol(
                        "connection closed while reading a header".to_string(),
                    ))
                }
                Ok(count) => read += count,
                Err(error) if is_timeout(&error) => {
                    if read == 0 {
                        return Ok(None);
                    }
                    return Err(OpenRgbError::Protocol(
                        "timed out part-way through a header".to_string(),
                    ));
                }
                Err(error) => return Err(OpenRgbError::Io(error)),
            }
        }

        if header[0..4] != MAGIC {
            return Err(OpenRgbError::Protocol("bad packet magic".to_string()));
        }
        let dev = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        let packet = u32::from_le_bytes([header[8], header[9], header[10], header[11]]);
        let size = u32::from_le_bytes([header[12], header[13], header[14], header[15]]) as usize;
        if size > MAX_PAYLOAD {
            return Err(OpenRgbError::PacketTooLarge(size));
        }

        let mut payload = vec![0u8; size];
        let mut read = 0;
        while read < size {
            match self.stream.read(&mut payload[read..]) {
                Ok(0) => {
                    return Err(OpenRgbError::Protocol(
                        "connection closed while reading a payload".to_string(),
                    ))
                }
                Ok(count) => read += count,
                Err(error) if is_timeout(&error) => {
                    return Err(OpenRgbError::Protocol(
                        "timed out part-way through a payload".to_string(),
                    ))
                }
                Err(error) => return Err(OpenRgbError::Io(error)),
            }
        }
        Ok(Some((dev, packet, payload)))
    }
}

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    )
}

/// Treat a direct-mode controller as a scoped session: begin switches it to
/// custom (direct) mode, write streams colours, end sends one all-black frame
/// and stops writing. The previous OpenRGB mode is not saved or restored:
/// drivers such as the K552's cannot report or hand back the keyboard's own
/// lighting, so the Player turns the keys off and the user replugs the
/// keyboard to bring its lighting back (PLY-20, user decision 2026-11-08).
/// Dropping without `end` sends the black frame too (best effort).
pub struct DirectSession {
    client: OpenRGBClient,
    index: u32,
    led_count: usize,
    ended: bool,
}

impl DirectSession {
    pub fn begin(client: OpenRGBClient, index: u32) -> Result<Self, OpenRgbError> {
        let mut client = client;
        let led_count = client.controller_data(index)?.leds.len();
        client.set_custom_mode(index)?;
        Ok(Self {
            client,
            index,
            led_count,
            ended: false,
        })
    }

    pub fn write(&mut self, colors: &[[u8; 3]]) -> Result<(), OpenRgbError> {
        self.client.update_leds(self.index, colors)
    }

    pub fn index(&self) -> u32 {
        self.index
    }

    pub fn controller_count(&mut self) -> Result<u32, OpenRgbError> {
        self.client.controller_count()
    }

    pub fn controller_data(&mut self, index: u32) -> Result<ControllerData, OpenRgbError> {
        self.client.controller_data(index)
    }

    pub fn take_device_list_changed(&mut self) -> bool {
        self.client.take_device_list_changed()
    }

    pub fn poll_device_list_changed(&mut self) -> Result<bool, OpenRgbError> {
        self.client.poll_device_list_changed()
    }

    /// Move the direct session to another controller index after a hot-plug
    /// reorders the list. Blanks the old controller before switching.
    pub fn rebind(&mut self, index: u32) -> Result<(), OpenRgbError> {
        if index == self.index {
            return Ok(());
        }
        self.end()?;
        let led_count = self.client.controller_data(index)?.leds.len();
        self.client.set_custom_mode(index)?;
        self.index = index;
        self.led_count = led_count;
        self.ended = false;
        Ok(())
    }

    /// Send one all-black frame and stop writing.
    pub fn end(&mut self) -> Result<(), OpenRgbError> {
        if self.ended {
            return Ok(());
        }
        self.ended = true;
        let black = vec![[0u8; 3]; self.led_count];
        self.client.update_leds(self.index, &black)
    }

    /// Stop writing without touching the keyboard (PLAYER §5: on backend or
    /// device errors, leave the current lighting).
    pub fn abandon(&mut self) {
        self.ended = true;
    }
}

impl Drop for DirectSession {
    fn drop(&mut self) {
        let _ = self.end();
    }
}

fn encode_string(value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() + 3);
    write_string(&mut out, value);
    out
}

fn write_string(out: &mut Vec<u8>, value: &str) {
    let bytes = value.as_bytes();
    let length = (bytes.len() + 1) as u16;
    out.extend_from_slice(&length.to_le_bytes());
    out.extend_from_slice(bytes);
    out.push(0);
}

fn color_to_u32(color: [u8; 3]) -> u32 {
    u32::from_le_bytes([color[0], color[1], color[2], 0])
}

fn parse_controller_data(payload: &[u8], version: u32) -> Result<ControllerData, OpenRgbError> {
    let mut reader = Reader::new(payload);
    let data_size = reader.u32()? as usize;
    if data_size != payload.len() {
        return Err(OpenRgbError::Protocol(format!(
            "controller block declares {data_size} bytes, payload has {}",
            payload.len()
        )));
    }
    let kind = reader.i32()?;
    let name = reader.string()?;
    let vendor = if version >= 1 {
        reader.string()?
    } else {
        String::new()
    };
    let description = reader.string()?;
    let version_string = reader.string()?;
    let serial = reader.string()?;
    let location = reader.string()?;

    let num_modes = reader.u16()?;
    let active_mode = reader.i32()?;
    let mut modes = Vec::with_capacity(usize::from(num_modes));
    for _ in 0..num_modes {
        modes.push(parse_mode(&mut reader, version)?);
    }

    let num_zones = reader.u16()?;
    let mut zones = Vec::with_capacity(usize::from(num_zones));
    for _ in 0..num_zones {
        zones.push(parse_zone(&mut reader)?);
    }

    let num_leds = reader.u16()?;
    let mut leds = Vec::with_capacity(usize::from(num_leds));
    for _ in 0..num_leds {
        leds.push(Led {
            name: reader.string()?,
            value: reader.u32()?,
        });
    }

    let num_colors = reader.u16()?;
    let mut colors = Vec::with_capacity(usize::from(num_colors));
    for _ in 0..num_colors {
        colors.push(color_from_u32(reader.u32()?));
    }

    Ok(ControllerData {
        kind,
        name,
        vendor,
        description,
        version: version_string,
        serial,
        location,
        active_mode,
        modes,
        zones,
        leds,
        colors,
    })
}

fn parse_mode(reader: &mut Reader<'_>, version: u32) -> Result<Mode, OpenRgbError> {
    let name = reader.string()?;
    let value = reader.i32()?;
    let flags = reader.u32()?;
    let speed_min = reader.u32()?;
    let speed_max = reader.u32()?;
    let (brightness_min, brightness_max) = if version >= 3 {
        (reader.u32()?, reader.u32()?)
    } else {
        (0, 0)
    };
    let colors_min = reader.u32()?;
    let colors_max = reader.u32()?;
    let speed = reader.u32()?;
    let brightness = if version >= 3 { reader.u32()? } else { 0 };
    let direction = reader.u32()?;
    let color_mode = reader.u32()?;
    let num_colors = reader.u16()?;
    let mut colors = Vec::with_capacity(usize::from(num_colors));
    for _ in 0..num_colors {
        colors.push(reader.u32()?);
    }
    Ok(Mode {
        name,
        value,
        flags,
        speed_min,
        speed_max,
        brightness_min,
        brightness_max,
        colors_min,
        colors_max,
        speed,
        brightness,
        direction,
        color_mode,
        colors,
    })
}

fn parse_zone(reader: &mut Reader<'_>) -> Result<Zone, OpenRgbError> {
    let name = reader.string()?;
    let zone_type = reader.i32()?;
    let leds_min = reader.u32()?;
    let leds_max = reader.u32()?;
    let leds_count = reader.u32()?;
    let matrix_len = reader.u16()?;
    let matrix = if matrix_len > 0 {
        let height = reader.u32()?;
        let width = reader.u32()?;
        let cells = u64::from(height) * u64::from(width);
        let expected = 8 + 4 * cells;
        if u64::from(matrix_len) != expected {
            return Err(OpenRgbError::Protocol(format!(
                "matrix_len {matrix_len} does not match {height}x{width}"
            )));
        }
        let mut map = Vec::with_capacity(cells as usize);
        for _ in 0..cells {
            map.push(reader.u32()?);
        }
        Some(Matrix { height, width, map })
    } else {
        None
    };
    Ok(Zone {
        name,
        zone_type,
        leds_min,
        leds_max,
        leds_count,
        matrix,
    })
}

fn color_from_u32(value: u32) -> [u8; 3] {
    let bytes = value.to_le_bytes();
    [bytes[0], bytes[1], bytes[2]]
}

struct Reader<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], OpenRgbError> {
        let end = self
            .position
            .checked_add(count)
            .ok_or_else(|| OpenRgbError::Protocol("packet length overflow".to_string()))?;
        if end > self.data.len() {
            return Err(OpenRgbError::Protocol(format!(
                "packet ended after {} bytes, needed {count} more",
                self.data.len()
            )));
        }
        let slice = &self.data[self.position..end];
        self.position = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, OpenRgbError> {
        let bytes = self.take(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self) -> Result<u32, OpenRgbError> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn i32(&mut self) -> Result<i32, OpenRgbError> {
        Ok(self.u32()? as i32)
    }

    fn string(&mut self) -> Result<String, OpenRgbError> {
        let length = usize::from(self.u16()?);
        if length == 0 {
            return Err(OpenRgbError::Protocol(
                "string length includes a NUL and cannot be zero".to_string(),
            ));
        }
        let bytes = self.take(length)?;
        if bytes[length - 1] != 0 {
            return Err(OpenRgbError::Protocol(
                "string is missing its trailing NUL".to_string(),
            ));
        }
        String::from_utf8(bytes[..length - 1].to_vec())
            .map_err(|_| OpenRgbError::Protocol("string is not UTF-8".to_string()))
    }
}
