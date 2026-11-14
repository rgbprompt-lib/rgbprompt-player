//! Shared Player vocabulary: states, results and failure codes (PLAYER §6,
//! §3.2; decisions fixed in M6-C3).
use crate::layout::Support;

/// Values fixed by PLAYER §6 / the C enum `RgbpState`.
#[repr(i32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlayerState {
    Idle = 0,
    Preparing = 1,
    NeedsDriver = 2,
    NoKeyboard = 3,
    Playing = 4,
    BackendUnresponsive = 5,
    VendorConflict = 6,
    Blocked = 7,
}

impl PlayerState {
    pub fn as_i32(self) -> i32 {
        self as i32
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Preparing => "preparing",
            Self::NeedsDriver => "needs_driver",
            Self::NoKeyboard => "no_keyboard",
            Self::Playing => "playing",
            Self::BackendUnresponsive => "backend_unresponsive",
            Self::VendorConflict => "vendor_conflict",
            Self::Blocked => "blocked",
        }
    }
}

/// `PlayResultSchema` from `@rgbprompt/contracts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlayResult {
    Playing,
    NeedsDriver,
    NoKeyboard,
    Failed,
}

impl PlayResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Playing => "playing",
            Self::NeedsDriver => "needs_driver",
            Self::NoKeyboard => "no_keyboard",
            Self::Failed => "failed",
        }
    }
}

/// `PlayFailureCodeSchema` from `@rgbprompt/contracts`, with the one-to-one C
/// status mapping from the brief (decision 7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureCode {
    UpdateRequired,
    DecodeFailed,
    UnsupportedPackage,
    LinkUnavailable,
    DriverDeclined,
    OpenRgbUnreachable,
    DeviceLost,
    Internal,
}

impl FailureCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UpdateRequired => "update_required",
            Self::DecodeFailed => "decode_failed",
            Self::UnsupportedPackage => "unsupported_package",
            Self::LinkUnavailable => "link_unavailable",
            Self::DriverDeclined => "driver_declined",
            Self::OpenRgbUnreachable => "openrgb_unreachable",
            Self::DeviceLost => "device_lost",
            Self::Internal => "internal",
        }
    }

    /// Negative status returned by the C ABI; `0` means "no failure".
    pub fn status_code(self) -> i32 {
        match self {
            Self::Internal => -1,
            Self::UpdateRequired => -2,
            Self::DecodeFailed => -3,
            Self::LinkUnavailable => -4,
            Self::UnsupportedPackage => -8,
            Self::DriverDeclined => -5,
            Self::OpenRgbUnreachable => -6,
            Self::DeviceLost => -7,
        }
    }
}

pub fn support_str(support: Support) -> &'static str {
    match support {
        Support::PerKey => "per_key",
        Support::Zones => "zones",
        Support::Single => "single",
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlayKeyboard {
    pub name: Option<String>,
    pub support: Support,
}
