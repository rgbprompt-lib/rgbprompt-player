//! Layout detection and mapping (PLAYER §7, HW-02/03/06).
//!
//! The engine renders 104 keys in `ANSI104_KEYS` order. An OpenRGB controller
//! exposes LEDs in its own order and may be per-key, per-zone or single colour.
//! This module decides the support level and turns a key frame into one colour
//! per controller LED.
//!
//! The SDK carries no VID:PID, so `device-db.json` matches on the controller
//! name (case-insensitive, exact) and/or on a `vid:pid` hex pair found anywhere
//! in the controller `location` string.
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Deserialize;

use crate::openrgb::ControllerData;

const EMBEDDED_DEVICE_DB: &str = include_str!("../data/device-db.json");
const EMBEDDED_KEY_NAMES: &str = include_str!("../data/openrgb-key-names.json");

/// One `u` key is four quarter units; the board's right margin is one key.
const BAND_MARGIN_QUARTER: i32 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    PerKey,
    Zones,
    Single,
}

#[derive(Clone, Debug)]
pub enum MappingKind {
    PerKey {
        led_to_key: Vec<Option<usize>>,
    },
    Zones {
        led_count: usize,
        key_band: Vec<usize>,
    },
    Single,
}

#[derive(Clone, Debug)]
pub struct Mapping {
    pub support: Support,
    pub kind: MappingKind,
    pub unmapped_leds: usize,
    pub matched_keys: usize,
}

impl Mapping {
    /// One colour per controller LED, in the controller's LED order.
    pub fn map(&self, keys_rgb: &[u8]) -> Vec<[u8; 3]> {
        match &self.kind {
            MappingKind::PerKey { led_to_key } => led_to_key
                .iter()
                .map(|key| key.map_or([0, 0, 0], |index| color_at(keys_rgb, index)))
                .collect(),
            MappingKind::Zones {
                led_count,
                key_band,
            } => {
                let mut sums = vec![[0u64; 3]; *led_count];
                let mut counts = vec![0u64; *led_count];
                for (key, band) in key_band.iter().enumerate() {
                    if let Some(band_sum) = sums.get_mut(*band) {
                        let color = color_at(keys_rgb, key);
                        for channel in 0..3 {
                            band_sum[channel] += u64::from(color[channel]);
                        }
                        counts[*band] += 1;
                    }
                }
                sums.iter()
                    .zip(&counts)
                    .map(|(sum, count)| {
                        if *count == 0 {
                            [0, 0, 0]
                        } else {
                            [
                                (sum[0] / count) as u8,
                                (sum[1] / count) as u8,
                                (sum[2] / count) as u8,
                            ]
                        }
                    })
                    .collect()
            }
            MappingKind::Single => {
                let key_count = keys_rgb.len() / 3;
                if key_count == 0 {
                    return vec![[0, 0, 0]];
                }
                let mut sums = [0u64; 3];
                for key in 0..key_count {
                    let color = color_at(keys_rgb, key);
                    for channel in 0..3 {
                        sums[channel] += u64::from(color[channel]);
                    }
                }
                vec![[
                    (sums[0] / key_count as u64) as u8,
                    (sums[1] / key_count as u64) as u8,
                    (sums[2] / key_count as u64) as u8,
                ]]
            }
        }
    }
}

fn color_at(keys_rgb: &[u8], key: usize) -> [u8; 3] {
    let offset = key * 3;
    [
        keys_rgb.get(offset).copied().unwrap_or(0),
        keys_rgb.get(offset + 1).copied().unwrap_or(0),
        keys_rgb.get(offset + 2).copied().unwrap_or(0),
    ]
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MappingError {
    #[error("controller reports no LEDs")]
    NoLeds,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceDb {
    #[serde(default)]
    schema: u32,
    #[serde(default)]
    devices: Vec<DeviceEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceEntry {
    pub id: String,
    #[serde(rename = "match")]
    pub match_: DeviceMatch,
    pub support: Support,
    #[serde(default)]
    pub leds: Option<HashMap<String, String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceMatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub vidpid: Option<String>,
}

impl DeviceDb {
    /// The device table committed with the Player (currently empty; real
    /// devices are recorded in M6-C4).
    pub fn embedded() -> &'static DeviceDb {
        static DB: OnceLock<DeviceDb> = OnceLock::new();
        DB.get_or_init(|| {
            DeviceDb::from_json(EMBEDDED_DEVICE_DB).expect("embedded device-db.json is valid")
        })
    }

    pub fn from_json(json: &str) -> Result<DeviceDb, String> {
        let db: DeviceDb = serde_json::from_str(json).map_err(|error| error.to_string())?;
        if db.schema != 1 {
            return Err(format!("device-db schema must be 1, got {}", db.schema));
        }
        for entry in &db.devices {
            if entry.match_.name.is_none() && entry.match_.vidpid.is_none() {
                return Err(format!("device {} needs a name or vidpid match", entry.id));
            }
        }
        Ok(db)
    }

    fn find(&self, controller: &ControllerData) -> Option<&DeviceEntry> {
        self.devices.iter().find(|entry| entry.matches(controller))
    }
}

impl DeviceEntry {
    fn matches(&self, controller: &ControllerData) -> bool {
        if let Some(name) = &self.match_.name {
            if controller.name.trim().to_lowercase() != name.trim().to_lowercase() {
                return false;
            }
        }
        if let Some(vidpid) = &self.match_.vidpid {
            if !controller
                .location
                .to_lowercase()
                .contains(&vidpid.to_lowercase())
            {
                return false;
            }
        }
        true
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
struct KeyNames {
    #[serde(flatten)]
    by_key: HashMap<String, Vec<String>>,
}

impl KeyNames {
    fn embedded() -> &'static KeyNames {
        static NAMES: OnceLock<KeyNames> = OnceLock::new();
        NAMES.get_or_init(|| {
            serde_json::from_str(EMBEDDED_KEY_NAMES)
                .expect("embedded openrgb-key-names.json is valid")
        })
    }
}

fn normalize(name: &str) -> String {
    name.trim().to_lowercase()
}

struct NameTables {
    key_index: HashMap<String, usize>,
    led_name_to_key: HashMap<String, usize>,
}

impl NameTables {
    fn new(key_names: &[String]) -> Self {
        let mut key_index = HashMap::with_capacity(key_names.len());
        for (index, name) in key_names.iter().enumerate() {
            key_index.insert(normalize(name), index);
        }
        let mut led_name_to_key = HashMap::new();
        for (index, name) in key_names.iter().enumerate() {
            if let Some(aliases) = KeyNames::embedded().by_key.get(name) {
                for alias in aliases {
                    led_name_to_key.entry(normalize(alias)).or_insert(index);
                }
            }
        }
        Self {
            key_index,
            led_name_to_key,
        }
    }

    fn resolve_led(&self, name: &str) -> Option<usize> {
        self.led_name_to_key.get(&normalize(name)).copied()
    }

    fn resolve_key(&self, name: &str) -> Option<usize> {
        self.key_index.get(&normalize(name)).copied()
    }
}

/// Detect the support level and per-LED mapping for a controller (PLAYER §7).
pub fn detect(
    controller: &ControllerData,
    db: &DeviceDb,
    key_names: &[String],
    key_centres_quarter: &[[i32; 2]],
) -> Result<Mapping, MappingError> {
    let led_count = controller.leds.len();
    if led_count == 0 {
        return Err(MappingError::NoLeds);
    }
    let tables = NameTables::new(key_names);

    if let Some(entry) = db.find(controller) {
        return Ok(match entry.support {
            Support::PerKey => per_key_mapping(controller, entry, &tables),
            Support::Zones => zones_mapping(led_count, key_names.len(), key_centres_quarter),
            Support::Single => single_mapping(key_names.len()),
        });
    }

    let led_to_key = controller
        .leds
        .iter()
        .map(|led| tables.resolve_led(&led.name))
        .collect::<Vec<_>>();
    let matched_leds = led_to_key.iter().filter(|key| key.is_some()).count();
    let mut seen = HashSet::new();
    for key in led_to_key.iter().flatten() {
        seen.insert(*key);
    }
    let matched_keys = seen.len();

    if matched_keys >= 40 && matched_leds * 2 >= led_count {
        return Ok(Mapping {
            support: Support::PerKey,
            kind: MappingKind::PerKey { led_to_key },
            unmapped_leds: led_count - matched_leds,
            matched_keys,
        });
    }
    if led_count >= 2 {
        return Ok(zones_mapping(
            led_count,
            key_names.len(),
            key_centres_quarter,
        ));
    }
    Ok(single_mapping(key_names.len()))
}

fn per_key_mapping(
    controller: &ControllerData,
    entry: &DeviceEntry,
    tables: &NameTables,
) -> Mapping {
    let overrides: HashMap<String, usize> = entry
        .leds
        .as_ref()
        .map(|leds| {
            leds.iter()
                .filter_map(|(led, key)| {
                    tables.resolve_key(key).map(|index| (normalize(led), index))
                })
                .collect()
        })
        .unwrap_or_default();

    let led_to_key = controller
        .leds
        .iter()
        .map(|led| {
            let normalized = normalize(&led.name);
            overrides
                .get(&normalized)
                .copied()
                .or_else(|| tables.resolve_led(&led.name))
        })
        .collect::<Vec<_>>();
    let matched_leds = led_to_key.iter().filter(|key| key.is_some()).count();
    let mut seen = HashSet::new();
    for key in led_to_key.iter().flatten() {
        seen.insert(*key);
    }
    Mapping {
        support: Support::PerKey,
        kind: MappingKind::PerKey { led_to_key },
        unmapped_leds: controller.leds.len() - matched_leds,
        matched_keys: seen.len(),
    }
}

/// Zones are equal-width bands by key centre x, in quarter key units. The
/// board width is the rightmost centre plus one key (four quarter units), so
/// the rightmost key lands in the last band. LEDs are assumed to be ordered
/// left to right; M6-C4 checks that assumption on hardware.
fn zones_mapping(led_count: usize, key_count: usize, key_centres_quarter: &[[i32; 2]]) -> Mapping {
    let max_x = key_centres_quarter
        .iter()
        .map(|centre| centre[0])
        .max()
        .unwrap_or(0);
    let board_width = i64::from((max_x + BAND_MARGIN_QUARTER).max(1));
    let bands = led_count as i64;
    let key_band = (0..key_count)
        .map(|key| {
            key_centres_quarter
                .get(key)
                .map(|centre| {
                    let x = i64::from(centre[0].max(0));
                    ((x * bands) / board_width).min(bands - 1) as usize
                })
                .unwrap_or(0)
        })
        .collect();
    Mapping {
        support: Support::Zones,
        kind: MappingKind::Zones {
            led_count,
            key_band,
        },
        unmapped_leds: 0,
        matched_keys: key_count,
    }
}

/// A white-only keyboard shows the board's mean colour as brightness. M6-C4
/// revisits this on hardware.
fn single_mapping(key_count: usize) -> Mapping {
    Mapping {
        support: Support::Single,
        kind: MappingKind::Single,
        unmapped_leds: 0,
        matched_keys: key_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openrgb::{Led, Zone};

    const ANSI_KEYS: [&str; 104] = [
        "ESC",
        "F1",
        "F2",
        "F3",
        "F4",
        "F5",
        "F6",
        "F7",
        "F8",
        "F9",
        "F10",
        "F11",
        "F12",
        "PRINTSCREEN",
        "SCROLLLOCK",
        "PAUSE",
        "GRAVE",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "0",
        "MINUS",
        "EQUAL",
        "BACKSPACE",
        "INSERT",
        "HOME",
        "PAGEUP",
        "NUMLOCK",
        "KP_SLASH",
        "KP_ASTERISK",
        "KP_MINUS",
        "TAB",
        "Q",
        "W",
        "E",
        "R",
        "T",
        "Y",
        "U",
        "I",
        "O",
        "P",
        "LBRACKET",
        "RBRACKET",
        "BACKSLASH",
        "DELETE",
        "END",
        "PAGEDOWN",
        "KP_7",
        "KP_8",
        "KP_9",
        "KP_PLUS",
        "CAPSLOCK",
        "A",
        "S",
        "D",
        "F",
        "G",
        "H",
        "J",
        "K",
        "L",
        "SEMICOLON",
        "QUOTE",
        "ENTER",
        "KP_4",
        "KP_5",
        "KP_6",
        "LSHIFT",
        "Z",
        "X",
        "C",
        "V",
        "B",
        "N",
        "M",
        "COMMA",
        "PERIOD",
        "SLASH",
        "RSHIFT",
        "UP",
        "KP_1",
        "KP_2",
        "KP_3",
        "KP_ENTER",
        "LCTRL",
        "LGUI",
        "LALT",
        "SPACE",
        "RALT",
        "RGUI",
        "APPLICATION",
        "RCTRL",
        "LEFT",
        "DOWN",
        "RIGHT",
        "KP_0",
        "KP_PERIOD",
    ];

    fn key_names() -> Vec<String> {
        ANSI_KEYS.iter().map(|name| (*name).to_string()).collect()
    }

    fn centres() -> Vec<[i32; 2]> {
        // A fake ANSI-like grid: 15 keys per row, 4 rows, 4 units apart.
        (0..104)
            .map(|index| [(index % 15) * 4 + 2, (index / 15) * 4 + 2])
            .collect()
    }

    fn controller(led_names: &[&str]) -> ControllerData {
        ControllerData {
            kind: 0,
            name: "Test Keyboard".to_string(),
            vendor: String::new(),
            description: String::new(),
            version: String::new(),
            serial: String::new(),
            location: String::new(),
            active_mode: 0,
            modes: Vec::new(),
            zones: vec![Zone {
                name: "Zone".to_string(),
                zone_type: 1,
                leds_min: 1,
                leds_max: led_names.len() as u32,
                leds_count: led_names.len() as u32,
                matrix: None,
            }],
            leds: led_names
                .iter()
                .enumerate()
                .map(|(index, name)| Led {
                    name: (*name).to_string(),
                    value: index as u32,
                })
                .collect(),
            colors: Vec::new(),
        }
    }

    fn all_led_names() -> Vec<String> {
        ANSI_KEYS
            .iter()
            .map(|key| KeyNames::embedded().by_key.get(*key).unwrap()[0].clone())
            .collect()
    }

    fn detect_for(leds: &[String]) -> Mapping {
        let refs = leds.iter().map(String::as_str).collect::<Vec<_>>();
        detect(
            &controller(&refs),
            DeviceDb::embedded(),
            &key_names(),
            &centres(),
        )
        .expect("detect")
    }

    #[test]
    fn per_key_shuffled_and_mixed_case_maps_esc() {
        let mut names = all_led_names();
        names.reverse();
        // Mix the case of the ESC LED only.
        let esc_position = names.iter().position(|name| name == "Key: Escape").unwrap();
        names[esc_position] = "key: escape".to_string();
        let refs = names.iter().map(String::as_str).collect::<Vec<_>>();
        let mapping = detect(
            &controller(&refs),
            DeviceDb::embedded(),
            &key_names(),
            &centres(),
        )
        .expect("detect");
        assert_eq!(mapping.support, Support::PerKey);

        let mut keys = vec![0u8; 104 * 3];
        keys[0..3].copy_from_slice(&[10, 20, 30]);
        let leds = mapping.map(&keys);
        let led_index = names
            .iter()
            .position(|name| name.eq_ignore_ascii_case("key: escape"))
            .unwrap();
        assert_eq!(leds[led_index], [10, 20, 30]);
    }

    #[test]
    fn db_match_by_name_and_vidpid() {
        for (json_match, location) in [
            (r#"{ "name": "my keyboard" }"#, ""),
            (r#"{ "vidpid": "1EA7:0907" }"#, "USB\\VID_1EA7&PID_0907"),
        ] {
            let db = DeviceDb::from_json(&format!(
                r#"{{ "schema": 1, "devices": [{{ "id": "k", "match": {json_match}, "support": "single" }}] }}"#
            ))
            .expect("db");
            let mut data = controller(&["Backlight"]);
            data.name = "My Keyboard".to_string();
            data.location = location.to_string();
            let mapping = detect(&data, &db, &key_names(), &centres()).expect("detect");
            assert_eq!(mapping.support, Support::Single);
        }
    }

    #[test]
    fn db_leds_override_wins() {
        let db = DeviceDb::from_json(
            r#"{ "schema": 1, "devices": [{
                "id": "k",
                "match": { "name": "Test Keyboard" },
                "support": "per_key",
                "leds": { "mystery led": "ENTER" }
            }] }"#,
        )
        .expect("db");
        let mut names = all_led_names();
        // Rename the ESC LED to something the name table does not know.
        let esc_position = names.iter().position(|name| name == "Key: Escape").unwrap();
        names[esc_position] = "Mystery LED".to_string();
        let refs = names.iter().map(String::as_str).collect::<Vec<_>>();
        let mapping = detect(&controller(&refs), &db, &key_names(), &centres()).expect("detect");
        assert_eq!(mapping.support, Support::PerKey);
        // The override maps Mystery LED to ENTER (index 70), not the ESC slot.
        let mut keys = vec![0u8; 104 * 3];
        keys[70 * 3..70 * 3 + 3].copy_from_slice(&[1, 2, 3]);
        let leds = mapping.map(&keys);
        // Find the LED named Mystery LED by rebuilding the LED list order.
        let mystery = refs.iter().position(|name| *name == "Mystery LED").unwrap();
        assert_eq!(leds[mystery], [1, 2, 3]);
        // The real ESC key is no longer matched by that LED.
        let mut esc_only = vec![0u8; 104 * 3];
        esc_only[0..3].copy_from_slice(&[9, 9, 9]);
        assert_eq!(mapping.map(&esc_only)[mystery], [0, 0, 0]);
    }

    #[test]
    fn zones_with_three_leds_average_bands() {
        let mapping = detect(
            &controller(&["Zone 1", "Zone 2", "Zone 3"]),
            DeviceDb::embedded(),
            &key_names(),
            &centres(),
        )
        .expect("detect");
        assert_eq!(mapping.support, Support::Zones);
        let mut keys = vec![0u8; 104 * 3];
        // Key 14 sits at x = 58, the rightmost fake column, so it lands in the
        // last band; everything else stays black.
        keys[14 * 3..14 * 3 + 3].copy_from_slice(&[120, 120, 120]);
        let leds = mapping.map(&keys);
        assert_eq!(leds.len(), 3);
        assert_eq!(leds[0], [0, 0, 0]);
        assert!(leds[2][0] > 0, "rightmost band takes the coloured key");
    }

    #[test]
    fn single_uses_the_board_mean() {
        let mapping = detect(
            &controller(&["Backlight"]),
            DeviceDb::embedded(),
            &key_names(),
            &centres(),
        )
        .expect("detect");
        assert_eq!(mapping.support, Support::Single);
        let mut keys = vec![0u8; 104 * 3];
        for key in 0..104 {
            keys[key * 3..key * 3 + 3].copy_from_slice(&[10, 20, 30]);
        }
        assert_eq!(mapping.map(&keys), vec![[10, 20, 30]]);
    }

    #[test]
    fn zero_leds_is_an_error() {
        let data = controller(&[]);
        let error = detect(&data, DeviceDb::embedded(), &key_names(), &centres())
            .expect_err("zero LEDs must fail");
        assert_eq!(error, MappingError::NoLeds);
    }

    #[test]
    fn per_key_threshold_edge() {
        let names = all_led_names();
        // 39 known keys + 1 unknown LED: below the 40-key threshold.
        let mut leds = names[0..39].to_vec();
        leds.push("Mystery LED".to_string());
        assert_eq!(detect_for(&leds).support, Support::Zones);

        // 40 known keys + 40 unknown LEDs: 40 keys match and cover half.
        let mut leds = names[0..40].to_vec();
        for index in 0..40 {
            leds.push(format!("Mystery {index}"));
        }
        assert_eq!(detect_for(&leds).support, Support::PerKey);
    }

    #[test]
    fn embedded_db_maps_the_evision_320f_5000_fn_key() {
        // The patched OpenRGB (Direct mode for 320F:5000, e.g. Redragon K552)
        // uses standard names except `Key: Fn`, which sits in the RGUI slot.
        let mut names = all_led_names();
        let rgui = ANSI_KEYS.iter().position(|key| *key == "RGUI").unwrap();
        names[rgui] = "Key: Fn".to_string();
        let refs = names.iter().map(String::as_str).collect::<Vec<_>>();
        let mut data = controller(&refs);
        data.name = "EVision Keyboard 320F:5000".to_string();
        let mapping =
            detect(&data, DeviceDb::embedded(), &key_names(), &centres()).expect("detect");
        assert_eq!(mapping.support, Support::PerKey);
        assert_eq!(mapping.unmapped_leds, 0);
        assert_eq!(mapping.matched_keys, 104);
        let mut keys = vec![0u8; 104 * 3];
        keys[rgui * 3..rgui * 3 + 3].copy_from_slice(&[4, 5, 6]);
        assert_eq!(mapping.map(&keys)[rgui], [4, 5, 6]);
    }

    #[test]
    fn split_space_bar_leds_both_map_to_space() {
        let mut names = all_led_names();
        let space = names.iter().position(|name| name == "Key: Space").unwrap();
        names[space] = "Key: Left Space".to_string();
        names.push("Key: Right Space".to_string());
        let mapping = detect_for(&names);
        assert_eq!(mapping.support, Support::PerKey);
        assert_eq!(mapping.matched_keys, 104);
        let space_index = ANSI_KEYS.iter().position(|key| *key == "SPACE").unwrap();
        let mut keys = vec![0u8; 104 * 3];
        keys[space_index * 3..space_index * 3 + 3].copy_from_slice(&[7, 8, 9]);
        let colors = mapping.map(&keys);
        assert_eq!(colors[space], [7, 8, 9]);
        assert_eq!(colors[names.len() - 1], [7, 8, 9]);
    }
}
