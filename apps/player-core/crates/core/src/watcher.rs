//! Periodic device rescan timer (PLAYER §5, PLY-08/PLY-10).
//!
//! Lives on the control-thread side: it posts `WatchTick` while the service
//! is Idle (so Settings can soft-probe the live keyboard), or in a retry
//! state (no keyboard / backend unresponsive / vendor conflict). There are
//! no ticks in `Playing`.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::service::ServiceCommand;

pub struct DeviceWatcher {
    active: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl DeviceWatcher {
    pub fn start(commands: Sender<ServiceCommand>, interval: Duration) -> Self {
        let active = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_active = Arc::clone(&active);
        let thread_stop = Arc::clone(&stop);
        let interval = interval.max(Duration::from_millis(10));
        let slice = interval.min(Duration::from_millis(100));
        let join = thread::spawn(move || {
            let mut elapsed = Duration::ZERO;
            let mut last = Instant::now();
            while !thread_stop.load(Ordering::Relaxed) {
                thread::sleep(slice);
                let now = Instant::now();
                let delta = now.saturating_duration_since(last);
                last = now;
                if !thread_active.load(Ordering::Relaxed) {
                    elapsed = Duration::ZERO;
                    continue;
                }
                elapsed += delta;
                if elapsed >= interval {
                    elapsed = Duration::ZERO;
                    if commands.send(ServiceCommand::WatchTick).is_err() {
                        break;
                    }
                }
            }
        });
        Self {
            active,
            stop,
            join: Some(join),
        }
    }

    pub fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::Relaxed);
    }

    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for DeviceWatcher {
    fn drop(&mut self) {
        self.shutdown();
    }
}
