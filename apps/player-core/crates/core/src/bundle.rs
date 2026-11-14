mod generated {
    include!(concat!(env!("OUT_DIR"), "/engine_bundle.rs"));
}

pub use generated::{
    ENGINE_BUNDLE, ENGINE_BUNDLE_SHA256, ENGINE_PACKAGE_VERSION, SAFETY_BUNDLE,
    SAFETY_BUNDLE_SHA256,
};
