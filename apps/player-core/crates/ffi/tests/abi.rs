//! ABI v2 surface: version, new functions and buffer rules (PLAYER §9.0.2).
use std::ffi::{c_char, CString};
use std::ptr;

use rgbprompt_player::*;

fn temp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rgbprompt-ffi-abi-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn abi_version_is_two() {
    assert_eq!(rgbp_abi_version(), 2);
}

#[test]
fn new_entry_points_are_null_safe() {
    let null: *mut RgbpHandle = ptr::null_mut();
    assert_eq!(
        unsafe { rgbp_install_driver(null) },
        RGBP_ERR_INVALID_ARGUMENT
    );
    assert_eq!(
        unsafe { rgbp_restart_backend(null) },
        RGBP_ERR_INVALID_ARGUMENT
    );
    assert_eq!(
        unsafe { rgbp_notify_devices_changed(null) },
        RGBP_ERR_INVALID_ARGUMENT
    );
    assert_eq!(
        unsafe { rgbp_set_preferred_keyboard(null, std::ptr::null()) },
        RGBP_ERR_INVALID_ARGUMENT
    );
    let mut buffer = [0 as c_char; 64];
    assert_eq!(
        unsafe { rgbp_driver_info_json(null, buffer.as_mut_ptr(), buffer.len()) },
        RGBP_ERR_INVALID_ARGUMENT
    );
}

#[test]
fn driver_info_uses_the_diagnostics_buffer_rules() {
    let dir = temp_dir();
    let data_dir = CString::new(dir.display().to_string()).expect("data dir");
    let api_base = CString::new("http://127.0.0.1:1").expect("api base");
    let platform = CString::new("mac").expect("platform");
    let language = CString::new("en").expect("language");
    let app_version = CString::new("0.3.0").expect("app version");
    let os_version = CString::new("macOS 14.2").expect("os version");
    let openrgb_addr = CString::new("127.0.0.1:9").expect("addr");
    let config = RgbpConfig {
        data_dir: data_dir.as_ptr(),
        api_base: api_base.as_ptr(),
        platform: platform.as_ptr(),
        language: language.as_ptr(),
        app_version: app_version.as_ptr(),
        os_version: os_version.as_ptr(),
        openrgb_addr: openrgb_addr.as_ptr(),
    };
    let handle = unsafe { rgbp_create(&config) };
    assert!(!handle.is_null(), "create must succeed");

    let mut small = [0 as c_char; 4];
    assert_eq!(
        unsafe { rgbp_driver_info_json(handle, small.as_mut_ptr(), small.len()) },
        RGBP_ERR_BUFFER_TOO_SMALL
    );
    assert_eq!(
        unsafe { rgbp_driver_info_json(handle, ptr::null_mut(), 128) },
        RGBP_ERR_INVALID_ARGUMENT
    );
    let mut buffer = [0 as c_char; 4096];
    let length = unsafe { rgbp_driver_info_json(handle, buffer.as_mut_ptr(), buffer.len()) };
    assert!(length > 0, "info length {length}");
    let text = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
        .to_str()
        .expect("utf8");
    assert_eq!(text.len(), length as usize);
    let value: serde_json::Value = serde_json::from_str(text).expect("json");
    for key in [
        "variant",
        "version",
        "sizeBytes",
        "installDir",
        "source",
        "license",
        "installed",
        "mode",
        "port",
        "executable",
    ] {
        assert!(value.get(key).is_some(), "missing {key}: {text}");
    }
    assert_eq!(value["mode"], "none");

    assert_eq!(
        unsafe { rgbp_install_driver(handle) },
        RGBP_ERR_INVALID_ARGUMENT,
        "install is only valid in NeedsDriver"
    );
    assert_eq!(
        unsafe { rgbp_restart_backend(handle) },
        RGBP_ERR_INVALID_ARGUMENT,
        "restart is not valid in Idle"
    );
    assert_eq!(
        unsafe { rgbp_notify_devices_changed(handle) },
        RGBP_OK,
        "a notification in Idle is a no-op"
    );

    unsafe { rgbp_destroy(handle) };
    let _ = std::fs::remove_dir_all(&dir);
}
