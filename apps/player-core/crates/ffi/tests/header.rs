//! No-drift check for the cbindgen header (PLAYER §11). `RGBP_BLESS=1`
//! rewrites it; `pnpm player:header` runs this with the variable set.
use std::path::PathBuf;

#[test]
fn header_has_no_drift() {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let header_path = crate_dir.join("../../include/rgbprompt_player.h");
    let config_path = crate_dir.join("cbindgen.toml");
    let config = cbindgen::Config::from_file(&config_path).expect("read cbindgen.toml");
    let bindings = cbindgen::Builder::new()
        .with_crate(&crate_dir)
        .with_config(config)
        .generate()
        .expect("generate bindings");

    if std::env::var_os("RGBP_BLESS").is_some() {
        if let Some(parent) = header_path.parent() {
            std::fs::create_dir_all(parent).expect("create include directory");
        }
        bindings.write_to_file(&header_path);
        return;
    }

    let mut buffer = Vec::new();
    bindings.write(&mut buffer);
    let generated = String::from_utf8(buffer).expect("header is UTF-8");

    let existing = std::fs::read_to_string(&header_path).unwrap_or_else(|_| {
        panic!(
            "{} is missing; run `pnpm player:header`",
            header_path.display()
        )
    });
    assert_eq!(
        existing,
        generated,
        "{} drifted from the Rust API; run `pnpm player:header`",
        header_path.display()
    );
}
