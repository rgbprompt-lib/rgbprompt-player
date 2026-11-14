//! Monotonic scheduling and wall-clock timestamps (PLAYER §5, §10).
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Monotonic clock with an arbitrary origin.
pub trait Clock: Send + Sync {
    fn now(&self) -> Duration;
    fn sleep_until(&self, deadline: Duration);
}

pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }

    fn sleep_until(&self, deadline: Duration) {
        let now = self.now();
        if deadline > now {
            std::thread::sleep(deadline - now);
        }
    }
}

/// Wall clock used for ack deadlines and diagnostics timestamps.
pub trait WallClock: Send + Sync {
    fn unix_ms(&self) -> u64;
}

pub struct SystemWallClock;

impl WallClock for SystemWallClock {
    fn unix_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }
}

/// Test clock: `sleep_until` advances time instead of blocking.
pub struct FakeClock {
    now: Mutex<Duration>,
}

impl FakeClock {
    pub fn new() -> Self {
        Self {
            now: Mutex::new(Duration::ZERO),
        }
    }

    pub fn advance(&self, by: Duration) {
        let mut now = self.now.lock().expect("fake clock");
        *now += by;
    }

    pub fn set(&self, at: Duration) {
        *self.now.lock().expect("fake clock") = at;
    }
}

impl Default for FakeClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Duration {
        *self.now.lock().expect("fake clock")
    }

    fn sleep_until(&self, deadline: Duration) {
        let mut now = self.now.lock().expect("fake clock");
        if deadline > *now {
            *now = deadline;
        }
    }
}

/// Wall clock with an adjustable unix timestamp for ack-window tests.
pub struct FakeWallClock {
    unix_ms: Mutex<u64>,
}

impl FakeWallClock {
    pub fn new(unix_ms: u64) -> Self {
        Self {
            unix_ms: Mutex::new(unix_ms),
        }
    }

    pub fn advance_ms(&self, by: u64) {
        let mut now = self.unix_ms.lock().expect("fake wall clock");
        *now += by;
    }
}

impl WallClock for FakeWallClock {
    fn unix_ms(&self) -> u64 {
        *self.unix_ms.lock().expect("fake wall clock")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_clock_advances_to_the_deadline() {
        let clock = FakeClock::new();
        clock.sleep_until(Duration::from_millis(40));
        assert_eq!(clock.now(), Duration::from_millis(40));
        clock.sleep_until(Duration::from_millis(10));
        assert_eq!(clock.now(), Duration::from_millis(40));
        clock.advance(Duration::from_millis(5));
        assert_eq!(clock.now(), Duration::from_millis(45));
    }

    #[test]
    fn system_clock_is_monotonic() {
        let clock = SystemClock::new();
        let first = clock.now();
        clock.sleep_until(first + Duration::from_millis(1));
        assert!(clock.now() >= first + Duration::from_millis(1));
    }
}
