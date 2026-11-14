//! `PlayerDiagnosticsSchema` payload (PLAYER §10). Never contains key names,
//! audio, prompts, tokens or email.
use std::collections::VecDeque;

use serde_json::{json, Value};

use crate::bundle::ENGINE_PACKAGE_VERSION;
use crate::layout::Support;
use crate::model::support_str;

pub const MAX_DEVICES: usize = 16;
pub const MAX_ERRORS: usize = 20;
pub const ERROR_CODE_MAX_LEN: usize = 40;

#[derive(Clone, Debug)]
pub struct DeviceDiagnostic {
    pub name: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub support: Support,
}

#[derive(Clone, Debug)]
pub struct ErrorEntry {
    pub at: u64,
    pub code: String,
}

#[derive(Clone, Debug, Default)]
pub struct DiagnosticsStore {
    devices: Vec<DeviceDiagnostic>,
    recent_errors: VecDeque<ErrorEntry>,
}

impl DiagnosticsStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn devices(&self) -> &[DeviceDiagnostic] {
        &self.devices
    }

    pub fn recent_errors(&self) -> &VecDeque<ErrorEntry> {
        &self.recent_errors
    }

    pub fn set_devices(&mut self, mut devices: Vec<DeviceDiagnostic>) {
        devices.truncate(MAX_DEVICES);
        self.devices = devices;
    }

    pub fn add_error(&mut self, at: u64, code: &str) {
        if self.recent_errors.len() == MAX_ERRORS {
            self.recent_errors.pop_front();
        }
        self.recent_errors.push_back(ErrorEntry {
            at,
            code: sanitize_code(code),
        });
    }
}

#[derive(Clone, Debug)]
pub struct OpenRgbDiagnostic {
    pub version: String,
    pub port: u16,
    pub running: bool,
}

pub struct DiagnosticsView<'a> {
    pub player_version: &'a str,
    pub platform: &'a str,
    pub os_version: &'a str,
    pub protocol_registered: bool,
    pub openrgb: Option<OpenRgbDiagnostic>,
    pub store: &'a DiagnosticsStore,
}

pub fn build_json(view: &DiagnosticsView<'_>) -> String {
    let devices: Vec<Value> = view
        .store
        .devices
        .iter()
        .map(|device| {
            json!({
                "name": clean_name(&device.name),
                "vendorId": device.vendor_id,
                "productId": device.product_id,
                "support": support_str(device.support),
            })
        })
        .collect();
    let recent_errors: Vec<Value> = view
        .store
        .recent_errors
        .iter()
        .map(|error| {
            json!({
                "at": error.at,
                "code": error.code,
            })
        })
        .collect();
    let openrgb = view.openrgb.as_ref().map(|openrgb| {
        json!({
            "version": openrgb.version,
            "port": openrgb.port,
            "running": openrgb.running,
        })
    });

    json!({
        "schema": 1,
        "playerVersion": view.player_version,
        "platform": view.platform,
        "osVersion": view.os_version,
        "engineVersion": ENGINE_PACKAGE_VERSION,
        "openrgb": openrgb,
        "protocolRegistered": view.protocol_registered,
        "devices": devices,
        "recentErrors": recent_errors,
    })
    .to_string()
}

/// A filled-in sample used by `parity diagnostics-sample` and
/// `pnpm player:diagnostics:check`.
pub fn sample_json() -> String {
    let mut store = DiagnosticsStore::new();
    store.set_devices(vec![
        DeviceDiagnostic {
            name: "Stub Per-key Keyboard".to_string(),
            vendor_id: 0x1ea7,
            product_id: 0x0907,
            support: Support::PerKey,
        },
        DeviceDiagnostic {
            name: "Zone Keyboard".to_string(),
            vendor_id: 0,
            product_id: 0,
            support: Support::Zones,
        },
    ]);
    store.add_error(1_700_000_000_000, "openrgb_unreachable");
    store.add_error(1_700_000_001_000, "device_lost");
    build_json(&DiagnosticsView {
        player_version: "0.3.0",
        platform: "mac",
        os_version: "macOS 14.2",
        protocol_registered: true,
        openrgb: Some(OpenRgbDiagnostic {
            version: "external".to_string(),
            port: 6742,
            running: true,
        }),
        store: &store,
    })
}

fn clean_name(name: &str) -> String {
    let trimmed: String = name.chars().take(120).collect();
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        trimmed
    }
}

fn sanitize_code(code: &str) -> String {
    let valid = !code.is_empty()
        && code.len() <= ERROR_CODE_MAX_LEN
        && code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_');
    if valid {
        code.to_string()
    } else {
        "internal".to_string()
    }
}

fn hex_byte(byte: u8) -> Option<u16> {
    match byte {
        b'0'..=b'9' => Some(u16::from(byte - b'0')),
        b'a'..=b'f' => Some(u16::from(byte - b'a') + 10),
        b'A'..=b'F' => Some(u16::from(byte - b'A') + 10),
        _ => None,
    }
}

fn hex4(bytes: &[u8]) -> Option<u16> {
    if bytes.len() != 4 {
        return None;
    }
    let mut value = 0u16;
    for byte in bytes {
        value = value * 16 + hex_byte(*byte)?;
    }
    Some(value)
}

/// Parse `vid:pid` (or the Windows `VID_xxxx&PID_xxxx` form) out of an
/// OpenRGB controller `location`.
pub fn parse_vid_pid(location: &str) -> (u16, u16) {
    let bytes = location.as_bytes();
    if bytes.len() >= 9 {
        for index in 0..=bytes.len() - 9 {
            if bytes[index + 4] == b':' {
                let vendor = hex4(&bytes[index..index + 4]);
                let product = hex4(&bytes[index + 5..index + 9]);
                if let (Some(vendor), Some(product)) = (vendor, product) {
                    return (vendor, product);
                }
            }
        }
    }

    let upper: Vec<u8> = bytes.iter().map(u8::to_ascii_uppercase).collect();
    let vendor = find_hex_after(&upper, b"VID_");
    let product = find_hex_after(&upper, b"PID_");
    (vendor.unwrap_or(0), product.unwrap_or(0))
}

fn find_hex_after(bytes: &[u8], marker: &[u8]) -> Option<u16> {
    if bytes.len() < marker.len() + 4 {
        return None;
    }
    for index in 0..=bytes.len() - marker.len() - 4 {
        if &bytes[index..index + marker.len()] == marker {
            if let Some(value) = hex4(&bytes[index + marker.len()..index + marker.len() + 4]) {
                return Some(value);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_colon_and_windows_vid_pid() {
        assert_eq!(parse_vid_pid("USB\\VID_1EA7&PID_0907"), (0x1ea7, 0x0907));
        assert_eq!(parse_vid_pid("usb-1ea7:0907"), (0x1ea7, 0x0907));
        assert_eq!(parse_vid_pid("no ids here"), (0, 0));
    }

    #[test]
    fn caps_devices_and_errors() {
        let mut store = DiagnosticsStore::new();
        store.set_devices(
            (0..40)
                .map(|index| DeviceDiagnostic {
                    name: format!("Keyboard {index}"),
                    vendor_id: 0,
                    product_id: 0,
                    support: Support::Single,
                })
                .collect(),
        );
        assert_eq!(store.devices().len(), MAX_DEVICES);
        for index in 0..30 {
            store.add_error(index, "device_lost");
        }
        assert_eq!(store.recent_errors().len(), MAX_ERRORS);
        assert_eq!(store.recent_errors().back().unwrap().at, 29);
    }

    #[test]
    fn rejects_unknown_error_codes() {
        let mut store = DiagnosticsStore::new();
        store.add_error(1, "Escape");
        store.add_error(2, "key names");
        store.add_error(3, "openrgb_unreachable");
        assert_eq!(store.recent_errors()[0].code, "internal");
        assert_eq!(store.recent_errors()[1].code, "internal");
        assert_eq!(store.recent_errors()[2].code, "openrgb_unreachable");
    }

    #[test]
    fn sample_has_only_schema_fields() {
        let value: Value = serde_json::from_str(&sample_json()).expect("json");
        let object = value.as_object().expect("object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "devices",
                "engineVersion",
                "openrgb",
                "osVersion",
                "platform",
                "playerVersion",
                "protocolRegistered",
                "recentErrors",
                "schema"
            ]
        );
    }
}
