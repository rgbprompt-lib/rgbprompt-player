use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .join("..")
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .expect("repository root");

    let engine_bundle_path = repo_root
        .join("packages")
        .join("engine")
        .join("dist")
        .join("player")
        .join("engine.iife.js");
    let engine_package_path = repo_root
        .join("packages")
        .join("engine")
        .join("package.json");
    let safety_bundle_path = repo_root
        .join("packages")
        .join("safety")
        .join("dist")
        .join("player")
        .join("safety.iife.js");

    if !engine_bundle_path.exists() {
        panic!(
            "missing {}; run `corepack pnpm --filter @rgbprompt/engine build` first",
            engine_bundle_path.display()
        );
    }
    if !safety_bundle_path.exists() {
        panic!(
            "missing {}; run `corepack pnpm --filter @rgbprompt/safety build` first",
            safety_bundle_path.display()
        );
    }

    let engine_bundle = fs::read(&engine_bundle_path).expect("read engine bundle");
    let engine_hash = hash_hex(&engine_bundle);
    let safety_bundle = fs::read(&safety_bundle_path).expect("read safety bundle");
    let safety_hash = hash_hex(&safety_bundle);

    let package_json = fs::read_to_string(&engine_package_path).expect("read engine package.json");
    let package: serde_json::Value =
        serde_json::from_str(&package_json).expect("parse engine package.json");
    let version = package
        .get("version")
        .and_then(serde_json::Value::as_str)
        .expect("engine package version")
        .to_string();

    let generated = format!(
        "pub const ENGINE_BUNDLE: &str = include_str!({engine_path:?});\n\
         pub const ENGINE_BUNDLE_SHA256: &str = {engine_hash:?};\n\
         pub const ENGINE_PACKAGE_VERSION: &str = {version:?};\n\
         pub const SAFETY_BUNDLE: &str = include_str!({safety_path:?});\n\
         pub const SAFETY_BUNDLE_SHA256: &str = {safety_hash:?};\n",
        engine_path = path_str(&engine_bundle_path),
        safety_path = path_str(&safety_bundle_path),
    );

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(out_dir.join("engine_bundle.rs"), generated).expect("write engine_bundle.rs");

    println!("cargo:rerun-if-changed={}", engine_bundle_path.display());
    println!("cargo:rerun-if-changed={}", engine_package_path.display());
    println!("cargo:rerun-if-changed={}", safety_bundle_path.display());
}

fn hash_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
