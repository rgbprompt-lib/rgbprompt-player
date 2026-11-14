//! Vendor software conflict detection (PLAYER §8, PLW-04).
//!
//! A small embedded process table runs only on a failure path. Process names
//! match case-insensitively; a trailing `*` is a prefix match. Nothing is
//! logged except the display names in diagnostics.
use std::sync::OnceLock;

use serde::Deserialize;

const EMBEDDED_TABLE: &str = include_str!("../data/vendor-conflicts.json");

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VendorConflictTable {
    pub schema: u32,
    pub apps: Vec<VendorConflictApp>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VendorConflictApp {
    pub name: String,
    pub platforms: Vec<String>,
    pub process: Vec<String>,
}

impl VendorConflictTable {
    pub fn embedded() -> &'static Self {
        static TABLE: OnceLock<VendorConflictTable> = OnceLock::new();
        TABLE.get_or_init(|| {
            Self::from_json(EMBEDDED_TABLE).expect("embedded vendor-conflicts.json is valid")
        })
    }

    pub fn from_json(json: &str) -> Result<Self, String> {
        let table: Self = serde_json::from_str(json).map_err(|error| error.to_string())?;
        if table.schema != 1 {
            return Err(format!(
                "vendor-conflicts schema must be 1, got {}",
                table.schema
            ));
        }
        for app in &table.apps {
            if app.name.is_empty() || app.process.is_empty() {
                return Err("vendor-conflicts entries need a name and a process".to_string());
            }
        }
        Ok(table)
    }
}

pub trait ProcessLister: Send + Sync {
    fn processes(&self) -> Vec<String>;
}

pub struct SysinfoLister;

impl ProcessLister for SysinfoLister {
    fn processes(&self) -> Vec<String> {
        let Ok(mut system) = sysinfo::System::new() else {
            return Vec::new();
        };
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        system
            .processes()
            .values()
            .map(|process| process.name().to_string_lossy().to_string())
            .collect()
    }
}

pub struct ConflictDetector {
    table: VendorConflictTable,
    lister: Box<dyn ProcessLister>,
}

impl ConflictDetector {
    pub fn new(lister: Box<dyn ProcessLister>) -> Self {
        Self {
            table: VendorConflictTable::embedded().clone(),
            lister,
        }
    }

    pub fn with_table(table: VendorConflictTable, lister: Box<dyn ProcessLister>) -> Self {
        Self { table, lister }
    }

    /// Display names of the matching apps, joined with ", ", or `None`.
    pub fn detect(&self, platform: &str) -> Option<String> {
        let platform = normalize_platform(platform);
        let processes = self.lister.processes();
        let processes: Vec<String> = processes.iter().map(|name| name.to_lowercase()).collect();
        let mut names: Vec<String> = Vec::new();
        for app in &self.table.apps {
            if !app
                .platforms
                .iter()
                .any(|value| normalize_platform(value) == platform)
            {
                continue;
            }
            let matched = app
                .process
                .iter()
                .any(|pattern| processes.iter().any(|name| matches(pattern, name)));
            if matched && !names.iter().any(|name| name == &app.name) {
                names.push(app.name.clone());
            }
        }
        if names.is_empty() {
            None
        } else {
            Some(names.join(", "))
        }
    }
}

fn normalize_platform(platform: &str) -> String {
    match platform.to_lowercase().as_str() {
        "mac" | "macos" | "darwin" => "macos".to_string(),
        "win" | "windows" => "windows".to_string(),
        other => other.to_string(),
    }
}

fn matches(pattern: &str, process_name_lower: &str) -> bool {
    let pattern = pattern.to_lowercase();
    match pattern.strip_suffix('*') {
        Some(prefix) => process_name_lower.starts_with(prefix),
        None => process_name_lower == pattern,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct FakeLister(Arc<Mutex<Vec<String>>>);

    impl ProcessLister for FakeLister {
        fn processes(&self) -> Vec<String> {
            self.0.lock().expect("processes").clone()
        }
    }

    fn detector(names: Arc<Mutex<Vec<String>>>) -> ConflictDetector {
        ConflictDetector::with_table(
            VendorConflictTable::embedded().clone(),
            Box::new(FakeLister(names)),
        )
    }

    #[test]
    fn matches_case_insensitively_and_with_prefixes() {
        let names = Arc::new(Mutex::new(vec![
            "ICUE.EXE".to_string(),
            "lghub_agent".to_string(),
        ]));
        let detector = detector(Arc::clone(&names));
        let found = detector.detect("win").expect("conflict");
        assert!(found.contains("Corsair iCUE"), "{found}");
        assert!(found.contains("Logitech G HUB"), "{found}");
    }

    #[test]
    fn platform_filters_entries() {
        let names = Arc::new(Mutex::new(vec!["iCUE.exe".to_string()]));
        let detector = detector(names);
        assert_eq!(detector.detect("mac"), None);
        assert!(detector.detect("macos").is_none());
    }

    #[test]
    fn no_processes_no_conflict() {
        let detector = detector(Arc::new(Mutex::new(Vec::new())));
        assert_eq!(detector.detect("windows"), None);
    }
}
