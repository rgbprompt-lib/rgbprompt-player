//! Detect a stale OpenRGB device handle.
//!
//! On macOS, OpenRGB reports a controller location as `HID: DevSrvsID:<id>`,
//! where `<id>` is the IOKit registry ID of the HID device it opened. After
//! unplug/replug, sleep/wake, or a USB hub re-enumeration, that ID disappears,
//! but OpenRGB keeps the old controller object and still accepts `UpdateLEDs`
//! over TCP. The Player preview then looks healthy while the keyboard keeps
//! playing its last firmware or last successfully written frame.
//!
//! A location without a `DevSrvsID` (Windows paths, test stubs) is treated as
//! live: this probe cannot judge those transports.

use std::fmt;
use std::sync::Arc;

/// Decimal IOKit registry id in an OpenRGB macOS location string.
pub fn parse_devsrvs_id(location: &str) -> Option<u64> {
    let marker = "DevSrvsID:";
    let bytes = location.as_bytes();
    let marker_bytes = marker.as_bytes();
    let start = bytes
        .windows(marker_bytes.len())
        .position(|window| window.eq_ignore_ascii_case(marker_bytes))?;
    let rest = &location[start + marker.len()..];
    let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// Whether OpenRGB's reported location still names a live device.
///
/// Returns `true` when the location cannot be judged, so tests and Windows
/// builds do not false-positive.
pub fn location_is_live(location: &str) -> bool {
    match parse_devsrvs_id(location) {
        None => true,
        Some(id) => registry_id_exists(id),
    }
}

#[cfg(target_os = "macos")]
fn registry_id_exists(id: u64) -> bool {
    macos::registry_id_exists(id)
}

#[cfg(not(target_os = "macos"))]
fn registry_id_exists(_id: u64) -> bool {
    true
}

/// Injectable liveness probe. Production uses [`location_is_live`].
#[derive(Clone)]
pub struct LocationLiveProbe {
    inner: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

impl LocationLiveProbe {
    pub fn new(probe: impl Fn(&str) -> bool + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(probe),
        }
    }

    pub fn is_live(&self, location: &str) -> bool {
        (self.inner)(location)
    }
}

impl Default for LocationLiveProbe {
    fn default() -> Self {
        Self::new(location_is_live)
    }
}

impl fmt::Debug for LocationLiveProbe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LocationLiveProbe")
    }
}

/// Vendors we treat as RGB keyboards when deciding whether a missing
/// OpenRGB controller is a detection failure or a genuinely unplugged device.
const RGB_KEYBOARD_VENDORS: &[u32] = &[
    0x320F, // EVision / Redragon K552
    0x1EA7,
];

/// Whether a known RGB keyboard is currently attached (IORegistry on macOS).
///
/// Used to decide if a process restart of our OpenRGB is warranted after a
/// rescan still reports no keyboard. Returns `false` on other platforms.
pub fn hid_keyboard_attached() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::hid_vendors_present(RGB_KEYBOARD_VENDORS)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Injectable "a keyboard is physically present" probe.
#[derive(Clone)]
pub struct KeyboardAttachedProbe {
    inner: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl KeyboardAttachedProbe {
    pub fn new(probe: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(probe),
        }
    }

    pub fn is_attached(&self) -> bool {
        (self.inner)()
    }
}

impl Default for KeyboardAttachedProbe {
    fn default() -> Self {
        Self::new(hid_keyboard_attached)
    }
}

impl fmt::Debug for KeyboardAttachedProbe {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("KeyboardAttachedProbe")
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IORegistryEntryIDMatching(id: u64) -> *mut c_void;
        fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> u32;
        fn IOObjectRelease(object: u32) -> i32;
    }

    pub fn registry_id_exists(id: u64) -> bool {
        // Safety: IORegistryEntryIDMatching returns a CF dictionary that
        // IOServiceGetMatchingService consumes. A zero service means the id is
        // gone; a non-zero service must be released.
        unsafe {
            let matching = IORegistryEntryIDMatching(id);
            if matching.is_null() {
                return false;
            }
            let service = IOServiceGetMatchingService(0, matching);
            if service == 0 {
                return false;
            }
            let _ = IOObjectRelease(service);
            true
        }
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            c_str: *const i8,
            encoding: u32,
        ) -> *mut c_void;
        fn CFNumberGetValue(number: *mut c_void, the_type: i32, value_ptr: *mut c_void) -> u8;
        fn CFRelease(cf: *mut c_void);
    }

    extern "C" {
        fn IOServiceMatching(name: *const i8) -> *mut c_void;
        fn IOServiceGetMatchingServices(
            main_port: u32,
            matching: *mut c_void,
            existing: *mut u32,
        ) -> i32;
        fn IOIteratorNext(iterator: u32) -> u32;
        fn IORegistryEntryCreateCFProperty(
            entry: u32,
            key: *mut c_void,
            allocator: *const c_void,
            options: u32,
        ) -> *mut c_void;
    }

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_CF_NUMBER_SINT32_TYPE: i32 = 3;

    pub fn hid_vendors_present(vendors: &[u32]) -> bool {
        if vendors.is_empty() {
            return false;
        }
        // Safety: IOServiceMatching("IOHIDDevice") is a standard IOKit
        // dictionary consumed by IOServiceGetMatchingServices. Properties
        // returned by IORegistryEntryCreateCFProperty are owned and released.
        unsafe {
            let matching = IOServiceMatching(b"IOHIDDevice\0".as_ptr() as *const i8);
            if matching.is_null() {
                return false;
            }
            let mut iterator = 0u32;
            if IOServiceGetMatchingServices(0, matching, &mut iterator) != 0 {
                return false;
            }
            let key = CFStringCreateWithCString(
                std::ptr::null(),
                b"VendorID\0".as_ptr() as *const i8,
                K_CF_STRING_ENCODING_UTF8,
            );
            if key.is_null() {
                let _ = IOObjectRelease(iterator);
                return false;
            }
            let mut found = false;
            loop {
                let service = IOIteratorNext(iterator);
                if service == 0 {
                    break;
                }
                let prop = IORegistryEntryCreateCFProperty(service, key, std::ptr::null(), 0);
                if !prop.is_null() {
                    let mut vid: i32 = 0;
                    if CFNumberGetValue(
                        prop,
                        K_CF_NUMBER_SINT32_TYPE,
                        &mut vid as *mut i32 as *mut c_void,
                    ) != 0
                        && vendors.contains(&(vid as u32))
                    {
                        found = true;
                    }
                    CFRelease(prop);
                }
                let _ = IOObjectRelease(service);
                if found {
                    break;
                }
            }
            CFRelease(key);
            let _ = IOObjectRelease(iterator);
            found
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openrgb_macos_location() {
        assert_eq!(
            parse_devsrvs_id("HID: DevSrvsID:4295279001"),
            Some(4_295_279_001)
        );
        assert_eq!(
            parse_devsrvs_id("HID: devsrvsid:4295284402"),
            Some(4_295_284_402)
        );
        assert_eq!(parse_devsrvs_id("usb-1234:5678"), None);
        assert_eq!(parse_devsrvs_id(""), None);
        assert_eq!(parse_devsrvs_id("HID: DevSrvsID:"), None);
    }

    #[test]
    fn unparseable_locations_are_live() {
        assert!(location_is_live("usb-1234:5678"));
        assert!(location_is_live(""));
    }

    #[test]
    fn missing_devsrvs_id_is_dead_on_macos() {
        // A number that will not exist in IORegistry: the parse works, and on
        // macOS the default probe must report dead so we do not treat a stale
        // OpenRGB handle as applied.
        let location = "HID: DevSrvsID:1";
        assert_eq!(parse_devsrvs_id(location), Some(1));
        if cfg!(target_os = "macos") {
            assert!(
                !location_is_live(location),
                "registry id 1 must not be treated as a live keyboard handle"
            );
        }
    }

    #[test]
    fn probe_can_be_injected() {
        let probe = LocationLiveProbe::new(|location| !location.contains("stale"));
        assert!(probe.is_live("usb-live"));
        assert!(!probe.is_live("HID: DevSrvsID:stale"));
    }

    #[test]
    fn attached_probe_can_be_injected() {
        let yes = KeyboardAttachedProbe::new(|| true);
        let no = KeyboardAttachedProbe::new(|| false);
        assert!(yes.is_attached());
        assert!(!no.is_attached());
    }
}
