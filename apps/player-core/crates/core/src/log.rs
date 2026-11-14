//! Local Player log (PLAYER §2, §10).
//!
//! `<data_dir>/logs/player.log`, one line per event, rolled once at the cap.
//! Callers must never pass key names, audio, tokens, prompts or email; the
//! service only logs state names, failure codes, device names and driver
//! events.
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const DEFAULT_LOG_CAP: u64 = 5 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 1024;

struct LogState {
    file: Option<File>,
    written: u64,
}

pub struct LocalLog {
    path: PathBuf,
    cap: u64,
    state: Mutex<LogState>,
}

impl LocalLog {
    pub fn open(dir: &Path) -> Option<Self> {
        Self::with_cap(dir, DEFAULT_LOG_CAP)
    }

    pub fn with_cap(dir: &Path, cap: u64) -> Option<Self> {
        fs::create_dir_all(dir).ok()?;
        let path = dir.join("player.log");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()?;
        let written = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        Some(Self {
            path,
            cap: cap.max(1),
            state: Mutex::new(LogState {
                file: Some(file),
                written,
            }),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn write_line(&self, line: &str) {
        let mut line: String = line
            .chars()
            .map(|ch| if ch == '\n' || ch == '\r' { ' ' } else { ch })
            .collect();
        if line.len() > MAX_LINE_BYTES {
            line.truncate(MAX_LINE_BYTES);
        }
        line.push('\n');
        let bytes = line.as_bytes();

        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.written + bytes.len() as u64 > self.cap {
            self.roll(&mut state);
        }
        if let Some(file) = state.file.as_mut() {
            if file.write_all(bytes).is_ok() {
                state.written += bytes.len() as u64;
            }
        }
    }

    fn roll(&self, state: &mut LogState) {
        state.file.take();
        let rolled = self.path.with_extension("log.1");
        let _ = fs::remove_file(&rolled);
        let _ = fs::rename(&self.path, &rolled);
        state.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .ok();
        state.written = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolls_once_at_the_cap() {
        let dir = std::env::temp_dir().join(format!(
            "rgbprompt-log-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let log = LocalLog::with_cap(&dir, 120).expect("log");
        for index in 0..20 {
            log.write_line(&format!("state=idle code=0 line={index}"));
        }
        let rolled = dir.join("player.log.1");
        assert!(rolled.exists(), "the first generation must be kept");
        assert!(fs::metadata(log.path()).expect("current").len() <= 120);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_lines_single_line() {
        let dir = std::env::temp_dir().join(format!("rgbprompt-log-single-{}", std::process::id()));
        let log = LocalLog::with_cap(&dir, DEFAULT_LOG_CAP).expect("log");
        log.write_line("a\nb\r\nc");
        let text = fs::read_to_string(log.path()).expect("read");
        assert_eq!(text, "a b  c\n");
        let _ = fs::remove_dir_all(&dir);
    }
}
