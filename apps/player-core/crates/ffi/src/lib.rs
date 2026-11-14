//! C ABI thin layer (PLAYER §9.0.2).
//!
//! Every entry point validates pointers and UTF-8, converts panics into
//! `RGBP_ERR_INTERNAL` with `catch_unwind`, and returns immediately after
//! queueing a command. State callback strings are valid only for the duration
//! of the callback and run on the control thread.
//!
//! Safety: every `unsafe extern "C"` entry point requires the pointer arguments
//! to be valid for the call; the header documents the buffer sizes.
#![allow(clippy::missing_safety_doc)]

use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use rgbprompt_player_core::clock::SystemWallClock;
use rgbprompt_player_core::driver::{DriverProvider, DriverTimings, ManagedDriver, Manifest};
use rgbprompt_player_core::layout::Support;
use rgbprompt_player_core::model::PlayerState;
use rgbprompt_player_core::service::{
    PlayerConfig, PlayerHandle, PlayerService, PlayerShared, ServiceCommand, ServiceOptions,
    StateSnapshot,
};
use rgbprompt_player_core::KEY_RGB_BYTES;

pub const RGBP_ABI_VERSION: u32 = 2;

pub const RGBP_OK: i32 = 0;
pub const RGBP_ERR_INTERNAL: i32 = -1;
pub const RGBP_ERR_UPDATE_REQUIRED: i32 = -2;
pub const RGBP_ERR_DECODE_FAILED: i32 = -3;
pub const RGBP_ERR_LINK_UNAVAILABLE: i32 = -4;
pub const RGBP_ERR_DRIVER_DECLINED: i32 = -5;
pub const RGBP_ERR_OPENRGB_UNREACHABLE: i32 = -6;
pub const RGBP_ERR_DEVICE_LOST: i32 = -7;
pub const RGBP_ERR_UNSUPPORTED_PACKAGE: i32 = -8;

pub const RGBP_ERR_INVALID_ARGUMENT: i32 = -100;
pub const RGBP_ERR_BUFFER_TOO_SMALL: i32 = -101;
pub const RGBP_ERR_NOT_SUPPORTED: i32 = -102;
pub const RGBP_ERR_BAD_URL: i32 = -103;

pub const RGBP_SUPPORT_UNKNOWN: i32 = -1;
pub const RGBP_SUPPORT_PER_KEY: i32 = 0;
pub const RGBP_SUPPORT_ZONES: i32 = 1;
pub const RGBP_SUPPORT_SINGLE: i32 = 2;

/// Opaque handle. Create with `rgbp_create`, release with `rgbp_destroy`.
#[repr(C)]
pub struct RgbpHandle {
    _private: [u8; 0],
}

#[repr(C)]
pub struct RgbpConfig {
    pub data_dir: *const c_char,
    pub api_base: *const c_char,
    pub platform: *const c_char,
    pub language: *const c_char,
    pub app_version: *const c_char,
    pub os_version: *const c_char,
    pub openrgb_addr: *const c_char,
}

#[repr(C)]
pub struct RgbpStateEvent {
    pub state: i32,
    pub error: i32,
    pub effect_name: *const c_char,
    pub keyboard_name: *const c_char,
    pub keyboard_support: i32,
    pub fps: u32,
    pub driver_progress: i32,
    pub driver_error: i32,
    pub conflict_name: *const c_char,
}

pub type RgbpStateCallback =
    Option<unsafe extern "C" fn(event: *const RgbpStateEvent, user: *mut c_void)>;

struct CallbackSlot {
    callback: RgbpStateCallback,
    user: *mut c_void,
}

// SAFETY: the callback and its user pointer are only invoked on the control
// thread, guarded by the mutex.
unsafe impl Send for CallbackSlot {}

struct HandleInner {
    shared: Arc<PlayerShared>,
    player: Mutex<Option<PlayerHandle>>,
    callback: Arc<Mutex<CallbackSlot>>,
    driver: Arc<dyn DriverProvider>,
}

impl Drop for HandleInner {
    fn drop(&mut self) {
        if let Ok(mut player) = self.player.lock() {
            if let Some(mut player) = player.take() {
                player.shutdown();
            }
        }
    }
}

fn guard(_default: i32, run: impl FnOnce() -> i32) -> i32 {
    match catch_unwind(AssertUnwindSafe(run)) {
        Ok(value) => value,
        Err(_) => RGBP_ERR_INTERNAL,
    }
}

unsafe fn require_string(ptr: *const c_char) -> Result<String, i32> {
    if ptr.is_null() {
        return Err(RGBP_ERR_INVALID_ARGUMENT);
    }
    CStr::from_ptr(ptr)
        .to_str()
        .map(str::to_string)
        .map_err(|_| RGBP_ERR_INVALID_ARGUMENT)
}

unsafe fn optional_string(ptr: *const c_char) -> Result<Option<String>, i32> {
    if ptr.is_null() {
        Ok(None)
    } else {
        require_string(ptr).map(Some)
    }
}

unsafe fn inner<'a>(handle: *mut RgbpHandle) -> Option<&'a HandleInner> {
    (handle as *mut HandleInner).as_ref()
}

fn send(handle: &HandleInner, command: ServiceCommand) -> i32 {
    match handle.player.lock() {
        Ok(player) => match player.as_ref() {
            Some(player) if player.send(command) => RGBP_OK,
            _ => RGBP_ERR_INTERNAL,
        },
        Err(_) => RGBP_ERR_INTERNAL,
    }
}

fn managed_port_range(configured: u16) -> (u16, u16) {
    (configured, configured.saturating_add(7))
}

fn support_code(support: Option<Support>) -> i32 {
    match support {
        Some(Support::PerKey) => RGBP_SUPPORT_PER_KEY,
        Some(Support::Zones) => RGBP_SUPPORT_ZONES,
        Some(Support::Single) => RGBP_SUPPORT_SINGLE,
        None => RGBP_SUPPORT_UNKNOWN,
    }
}

#[no_mangle]
pub extern "C" fn rgbp_abi_version() -> u32 {
    RGBP_ABI_VERSION
}

/// Create the Player core. Returns null on invalid arguments or startup failure.
#[no_mangle]
pub unsafe extern "C" fn rgbp_create(config: *const RgbpConfig) -> *mut RgbpHandle {
    let result = catch_unwind(AssertUnwindSafe(|| -> *mut RgbpHandle {
        let Some(config) = config.as_ref() else {
            return std::ptr::null_mut();
        };
        let Ok(api_base) = require_string(config.api_base) else {
            return std::ptr::null_mut();
        };
        let Ok(platform) = require_string(config.platform) else {
            return std::ptr::null_mut();
        };
        if platform != "mac" && platform != "win" {
            return std::ptr::null_mut();
        }
        let Ok(app_version) = require_string(config.app_version) else {
            return std::ptr::null_mut();
        };
        let Ok(os_version) = require_string(config.os_version) else {
            return std::ptr::null_mut();
        };
        let data_dir = match optional_string(config.data_dir) {
            Ok(Some(value)) => PathBuf::from(value),
            _ => PathBuf::from("."),
        };
        let language = optional_string(config.language)
            .ok()
            .flatten()
            .unwrap_or_default();
        let openrgb_addr = match optional_string(config.openrgb_addr) {
            Ok(Some(value)) => match value.parse() {
                Ok(addr) => addr,
                Err(_) => return std::ptr::null_mut(),
            },
            _ => rgbprompt_player_core::driver::DEFAULT_OPENRGB_ADDR
                .parse()
                .expect("default OpenRGB address"),
        };

        let player_config = PlayerConfig {
            data_dir,
            api_base,
            platform: platform.clone(),
            language,
            app_version,
            os_version,
            openrgb_addr,
        };
        let shared = PlayerShared::new(player_config.clone());
        let callback = Arc::new(Mutex::new(CallbackSlot {
            callback: None,
            user: std::ptr::null_mut(),
        }));
        let callback_for_state = Arc::clone(&callback);
        shared.set_state_callback(Some(Box::new(move |snapshot: &StateSnapshot| {
            let Ok(slot) = callback_for_state.lock() else {
                return;
            };
            let Some(callback) = slot.callback else {
                return;
            };
            let effect = snapshot
                .effect_name
                .as_ref()
                .and_then(|name| CString::new(name.as_str()).ok());
            let keyboard = snapshot
                .keyboard_name
                .as_ref()
                .and_then(|name| CString::new(name.as_str()).ok());
            let conflict = snapshot
                .conflict_name
                .as_ref()
                .and_then(|name| CString::new(name.as_str()).ok());
            let event = RgbpStateEvent {
                state: snapshot.state.as_i32(),
                error: snapshot.error,
                effect_name: effect
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                keyboard_name: keyboard
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
                keyboard_support: support_code(snapshot.keyboard_support),
                fps: snapshot.fps,
                driver_progress: snapshot.driver_progress,
                driver_error: snapshot.driver_error,
                conflict_name: conflict
                    .as_ref()
                    .map_or(std::ptr::null(), |value| value.as_ptr()),
            };
            unsafe { callback(&event, slot.user) };
        })));

        // The managed launcher scans eight ports starting at the configured
        // SDK port (6742-6749 by default, PLAYER §4). A shell or test that
        // configures a private port therefore never touches 6742.
        let timings = DriverTimings {
            port_range: managed_port_range(openrgb_addr.port()),
            ..DriverTimings::default()
        };
        let driver: Arc<dyn DriverProvider> = Arc::new(ManagedDriver::with_manifest(
            openrgb_addr,
            player_config.data_dir.join("openrgb"),
            Manifest::embedded().clone(),
            timings,
        ));
        let player = match PlayerService::start_with(
            player_config,
            Arc::clone(&shared),
            Arc::clone(&driver),
            Arc::new(SystemWallClock),
            None,
            ServiceOptions::production(),
        ) {
            Ok(player) => player,
            Err(_) => return std::ptr::null_mut(),
        };

        let inner = Box::new(HandleInner {
            shared,
            player: Mutex::new(Some(player)),
            callback,
            driver,
        });
        Box::into_raw(inner) as *mut RgbpHandle
    }));
    result.unwrap_or(std::ptr::null_mut())
}

/// Release the core. Blocks until the control thread has stopped.
#[no_mangle]
pub unsafe extern "C" fn rgbp_destroy(handle: *mut RgbpHandle) {
    if handle.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| {
        drop(Box::from_raw(handle as *mut HandleInner));
    }));
}

/// Install the state callback. Strings in the event are valid only for the
/// duration of the call; the callback runs on the control thread.
#[no_mangle]
pub unsafe extern "C" fn rgbp_set_state_callback(
    handle: *mut RgbpHandle,
    callback: RgbpStateCallback,
    user: *mut c_void,
) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        match inner.callback.lock() {
            Ok(mut slot) => {
                slot.callback = callback;
                slot.user = user;
                RGBP_OK
            }
            Err(_) => RGBP_ERR_INTERNAL,
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn rgbp_open_url(handle: *mut RgbpHandle, url: *const c_char) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        match require_string(url) {
            Ok(url) => send(inner, ServiceCommand::OpenUrl(url)),
            Err(code) => code,
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn rgbp_open_lep_file(handle: *mut RgbpHandle, path: *const c_char) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        match require_string(path) {
            Ok(path) if !path.is_empty() => {
                send(inner, ServiceCommand::OpenLepFile(PathBuf::from(path)))
            }
            Ok(_) => RGBP_ERR_INVALID_ARGUMENT,
            Err(code) => code,
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn rgbp_stop(handle: *mut RgbpHandle) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        send(inner, ServiceCommand::Stop)
    })
}

/// Consent to install the managed driver. Only valid in `NeedsDriver`.
#[no_mangle]
pub unsafe extern "C" fn rgbp_install_driver(handle: *mut RgbpHandle) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        let allowed = inner
            .shared
            .current_state()
            .is_some_and(|snapshot| snapshot.state == PlayerState::NeedsDriver);
        if !allowed {
            return RGBP_ERR_INVALID_ARGUMENT;
        }
        let installable = inner.driver.installable();
        let _ = send(inner, ServiceCommand::InstallDriver);
        if installable {
            RGBP_OK
        } else {
            // Fail closed when the current manifest has no hash. The worker
            // still records `driver_unverified` in diagnostics.
            RGBP_ERR_NOT_SUPPORTED
        }
    })
}

/// Replace the driver manifest used by the next install and launch. Valid
/// only while `Idle` or `NeedsDriver` and no install is running; the manifest
/// must carry a SHA-256 and pass the same URL rules as the built-in one.
#[no_mangle]
pub unsafe extern "C" fn rgbp_set_driver_manifest_json(
    handle: *mut RgbpHandle,
    json: *const c_char,
) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        let Ok(json) = require_string(json) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        let allowed = inner.shared.current_state().is_none_or(|snapshot| {
            matches!(snapshot.state, PlayerState::Idle | PlayerState::NeedsDriver)
                && snapshot.driver_progress < 0
        });
        if !allowed {
            return RGBP_ERR_INVALID_ARGUMENT;
        }
        let Ok(manifest) = Manifest::from_json(&json) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        if manifest.sha256.is_none() {
            return RGBP_ERR_INVALID_ARGUMENT;
        }
        if inner.driver.set_manifest(manifest) {
            RGBP_OK
        } else {
            RGBP_ERR_INVALID_ARGUMENT
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn rgbp_retry(handle: *mut RgbpHandle) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        send(inner, ServiceCommand::Retry)
    })
}

/// Restart the managed backend (or reconnect to the external one).
#[no_mangle]
pub unsafe extern "C" fn rgbp_restart_backend(handle: *mut RgbpHandle) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        let allowed = inner.shared.current_state().is_some_and(|snapshot| {
            matches!(
                snapshot.state,
                PlayerState::BackendUnresponsive
                    | PlayerState::Playing
                    | PlayerState::NoKeyboard
                    | PlayerState::VendorConflict
            )
        });
        if !allowed {
            return RGBP_ERR_INVALID_ARGUMENT;
        }
        send(inner, ServiceCommand::RestartBackend)
    })
}

/// The shell's HID hot-plug callback asks the core to rescan.
#[no_mangle]
pub unsafe extern "C" fn rgbp_notify_devices_changed(handle: *mut RgbpHandle) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        send(inner, ServiceCommand::DevicesChanged)
    })
}

/// Prefer an OpenRGB controller by name. Empty clears the preference.
#[no_mangle]
pub unsafe extern "C" fn rgbp_set_preferred_keyboard(
    handle: *mut RgbpHandle,
    name: *const c_char,
) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        let value = if name.is_null() {
            String::new()
        } else {
            match require_string(name) {
                Ok(value) => value,
                Err(code) => return code,
            }
        };
        send(inner, ServiceCommand::SelectKeyboard(value))
    })
}

/// Copy the latest limited 104 x RGB frame. Returns the sequence number.
#[no_mangle]
pub unsafe extern "C" fn rgbp_preview_frame(handle: *mut RgbpHandle, out: *mut u8) -> i64 {
    let result = catch_unwind(AssertUnwindSafe(|| -> i64 {
        let Some(inner) = inner(handle) else {
            return i64::from(RGBP_ERR_INVALID_ARGUMENT);
        };
        if out.is_null() {
            return i64::from(RGBP_ERR_INVALID_ARGUMENT);
        }
        let mut frame = [0u8; KEY_RGB_BYTES];
        let seq = inner.shared.preview.snapshot(&mut frame);
        std::ptr::copy_nonoverlapping(frame.as_ptr(), out, frame.len());
        seq as i64
    }));
    result.unwrap_or(i64::from(RGBP_ERR_INTERNAL))
}

/// Push interleaved f32 PCM. Never blocks or allocates on the shell thread.
#[no_mangle]
pub unsafe extern "C" fn rgbp_push_audio_pcm(
    handle: *mut RgbpHandle,
    interleaved: *const f32,
    frames: usize,
    channels: u16,
    sample_rate: f64,
) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        if interleaved.is_null()
            || frames == 0
            || channels == 0
            || sample_rate.is_nan()
            || sample_rate <= 0.0
        {
            return RGBP_ERR_INVALID_ARGUMENT;
        }
        let Some(length) = frames.checked_mul(usize::from(channels)) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        let samples = std::slice::from_raw_parts(interleaved, length);
        inner
            .shared
            .audio
            .push(samples, frames, channels, sample_rate);
        RGBP_OK
    })
}

/// Push a key event by ANSI104 key name. Unknown names are counted and ignored.
#[no_mangle]
pub unsafe extern "C" fn rgbp_push_key(
    handle: *mut RgbpHandle,
    key_name: *const c_char,
    down: bool,
) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        let name = match require_string(key_name) {
            Ok(name) => name,
            Err(code) => return code,
        };
        match inner.shared.key_cell(&name) {
            Some(cell) => {
                inner
                    .shared
                    .keys
                    .push(rgbprompt_player_core::KeyEvent { t: 0.0, down, cell });
                RGBP_OK
            }
            None => {
                inner.shared.unknown_keys.fetch_add(1, Ordering::Relaxed);
                RGBP_OK
            }
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn rgbp_input_wanted(handle: *mut RgbpHandle) -> u32 {
    let result = catch_unwind(AssertUnwindSafe(|| -> u32 {
        match inner(handle) {
            Some(inner) => inner.shared.input_wanted(),
            None => 0,
        }
    }));
    result.unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn rgbp_set_brightness(handle: *mut RgbpHandle, brightness: u8) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        if !(10..=100).contains(&brightness) {
            return RGBP_ERR_INVALID_ARGUMENT;
        }
        inner
            .shared
            .brightness
            .store(u32::from(brightness), Ordering::Relaxed);
        send(inner, ServiceCommand::SetBrightness(brightness))
    })
}

#[no_mangle]
pub unsafe extern "C" fn rgbp_set_language(
    handle: *mut RgbpHandle,
    language: *const c_char,
) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        match require_string(language) {
            Ok(language) => {
                *inner.shared.language.lock().expect("language") = language.clone();
                send(inner, ServiceCommand::SetLanguage(language))
            }
            Err(code) => code,
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn rgbp_set_audio_enabled(handle: *mut RgbpHandle, enabled: bool) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        inner.shared.audio_enabled.store(enabled, Ordering::Relaxed);
        send(inner, ServiceCommand::SetAudioEnabled(enabled))
    })
}

#[no_mangle]
pub unsafe extern "C" fn rgbp_set_key_reactive_enabled(
    handle: *mut RgbpHandle,
    enabled: bool,
) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        inner.shared.key_enabled.store(enabled, Ordering::Relaxed);
        send(inner, ServiceCommand::SetKeyReactiveEnabled(enabled))
    })
}

#[no_mangle]
pub unsafe extern "C" fn rgbp_set_protocol_registered(
    handle: *mut RgbpHandle,
    registered: bool,
) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        inner
            .shared
            .protocol_registered
            .store(registered, Ordering::Relaxed);
        send(inner, ServiceCommand::SetProtocolRegistered(registered))
    })
}

/// Write the diagnostics JSON, NUL-terminated. Returns its length or a status.
#[no_mangle]
pub unsafe extern "C" fn rgbp_diagnostics_json(
    handle: *mut RgbpHandle,
    out: *mut c_char,
    cap: usize,
) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        if out.is_null() {
            return RGBP_ERR_INVALID_ARGUMENT;
        }
        let json = inner.shared.diagnostics_json();
        let length = json.len();
        if length + 1 > cap {
            return RGBP_ERR_BUFFER_TOO_SMALL;
        }
        std::ptr::copy_nonoverlapping(json.as_ptr(), out as *mut u8, length);
        *out.add(length) = 0;
        match i32::try_from(length) {
            Ok(length) => length,
            Err(_) => RGBP_ERR_INTERNAL,
        }
    })
}

/// Write the driver manifest and install summary as JSON, NUL-terminated.
/// Same buffer rules as `rgbp_diagnostics_json`.
#[no_mangle]
pub unsafe extern "C" fn rgbp_driver_info_json(
    handle: *mut RgbpHandle,
    out: *mut c_char,
    cap: usize,
) -> i32 {
    guard(RGBP_ERR_INTERNAL, || {
        let Some(inner) = inner(handle) else {
            return RGBP_ERR_INVALID_ARGUMENT;
        };
        if out.is_null() {
            return RGBP_ERR_INVALID_ARGUMENT;
        }
        let json = inner.driver.info().to_json();
        let length = json.len();
        if length + 1 > cap {
            return RGBP_ERR_BUFFER_TOO_SMALL;
        }
        std::ptr::copy_nonoverlapping(json.as_ptr(), out as *mut u8, length);
        *out.add(length) = 0;
        match i32::try_from(length) {
            Ok(length) => length,
            Err(_) => RGBP_ERR_INTERNAL,
        }
    })
}
