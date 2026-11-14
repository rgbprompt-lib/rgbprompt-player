//! Manual OpenRGB SDK server stub. Accepts both the test flags (`--port`,
//! `--preset`, `--protocol`) and the OpenRGB CLI shape used when this binary
//! stands in for the managed driver executable.
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

use openrgb_stub::{StubConfig, StubController, StubServer};

fn controller_for(name: &str) -> Option<StubController> {
    match name {
        "per-key" | "per_key" => Some(StubController::per_key_ansi104()),
        "tkl" => Some(StubController::per_key_tkl()),
        "zones" => Some(StubController::zones(3)),
        "single" => Some(StubController::single()),
        "mouse" => Some(StubController::mouse()),
        _ => None,
    }
}

fn parse_number<T: std::str::FromStr>(value: &str, flag: &str) -> Result<T, String> {
    value
        .parse()
        .map_err(|_| format!("openrgb-stub: invalid {flag} value {value:?}"))
}

fn main() -> ExitCode {
    let mut port = 0u16;
    let mut presets = vec!["per-key".to_string()];
    let mut protocol = 3u32;
    let mut exit_after_ms: Option<u64> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" | "--server-port" => {
                let Some(value) = args.next() else {
                    eprintln!("openrgb-stub: {arg} needs a number");
                    return ExitCode::from(2);
                };
                match parse_number(&value, arg.as_str()) {
                    Ok(value) => port = value,
                    Err(message) => {
                        eprintln!("{message}");
                        return ExitCode::from(2);
                    }
                }
            }
            "--preset" => {
                let Some(value) = args.next() else {
                    eprintln!("openrgb-stub: --preset needs a name");
                    return ExitCode::from(2);
                };
                presets = vec![value];
            }
            "--controllers" => {
                let Some(value) = args.next() else {
                    eprintln!("openrgb-stub: --controllers needs a list");
                    return ExitCode::from(2);
                };
                presets = value
                    .split(',')
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
                    .collect();
            }
            "--protocol" => {
                let Some(value) = args.next() else {
                    eprintln!("openrgb-stub: --protocol needs a number");
                    return ExitCode::from(2);
                };
                match parse_number(&value, arg.as_str()) {
                    Ok(value) => protocol = value,
                    Err(message) => {
                        eprintln!("{message}");
                        return ExitCode::from(2);
                    }
                }
            }
            "--exit-after-ms" => {
                let Some(value) = args.next() else {
                    eprintln!("openrgb-stub: --exit-after-ms needs a number");
                    return ExitCode::from(2);
                };
                match parse_number::<u64>(&value, arg.as_str()) {
                    Ok(value) => exit_after_ms = Some(value),
                    Err(message) => {
                        eprintln!("{message}");
                        return ExitCode::from(2);
                    }
                }
            }
            "--config" => {
                // OpenRGB CLI shape: consume the directory and ignore it.
                let _ = args.next();
            }
            "--server" | "--noautoconnect" | "--startminimized" => {}
            other if other.starts_with('-') => {
                // Unknown OpenRGB switches are ignored so this binary can
                // stand in for the real executable.
            }
            _ => {}
        }
    }

    let mut controllers = Vec::new();
    for name in &presets {
        match controller_for(name) {
            Some(controller) => controllers.push(controller),
            None => {
                eprintln!(
                    "openrgb-stub: unknown preset {name:?} (per-key, tkl, zones, single, mouse)"
                );
                return ExitCode::from(2);
            }
        }
    }

    let config = StubConfig {
        protocol_version: protocol,
        controllers,
    };
    let server = match StubServer::start_on(port, config) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("openrgb-stub: cannot listen: {error}");
            return ExitCode::FAILURE;
        }
    };
    println!("openrgb-stub: listening on 127.0.0.1:{}", server.port());
    let _ = std::io::Write::flush(&mut std::io::stdout());

    if let Some(ms) = exit_after_ms {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(ms));
            std::process::exit(1);
        });
    }

    loop {
        thread::sleep(Duration::from_secs(1));
    }
}
