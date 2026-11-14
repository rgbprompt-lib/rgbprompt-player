use std::cell::Cell;
use std::marker::PhantomData;
use std::rc::Rc;
use std::time::{Duration, Instant};

use rquickjs::function::Args;
use rquickjs::{
    Array, Constructor, Context, Ctx, Function, Null, Object, Persistent, Runtime, TypedArray,
    Value,
};

use crate::bundle::{
    ENGINE_BUNDLE, ENGINE_BUNDLE_SHA256, ENGINE_PACKAGE_VERSION, SAFETY_BUNDLE,
    SAFETY_BUNDLE_SHA256,
};

pub const FRAME_BYTES: usize = 6 * 22 * 4;

/// Keys in `ANSI104_KEYS` order, as the real-time limiter defines them.
pub const KEY_COUNT: usize = 104;
/// One sRGB triple per key, the limiter's input and output unit.
pub const KEY_RGB_BYTES: usize = KEY_COUNT * 3;
/// `analyzeAudioBands` always returns 22 bands (ENGINE §5.1).
pub const AUDIO_BAND_COUNT: usize = 22;

#[derive(Clone, Debug)]
pub struct HostLimits {
    pub memory_bytes: usize,
    pub max_stack_bytes: usize,
    pub step_budget: Duration,
    pub setup_budget: Duration,
}

impl Default for HostLimits {
    fn default() -> Self {
        Self {
            memory_bytes: 64 * 1024 * 1024,
            max_stack_bytes: 1024 * 1024,
            step_budget: Duration::from_millis(250),
            setup_budget: Duration::from_secs(2),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("engine call interrupted after its time budget")]
    Interrupted,
    #[error("bundle is missing required exports: {0}")]
    BundleShape(String),
    #[error("decode failed: {0}")]
    Decode(String),
    #[error("render failed: {0}")]
    Render(String),
    #[error(
        "frame has {0} bytes, expected {FRAME_BYTES} for engine frames or {KEY_RGB_BYTES} for key frames"
    )]
    FrameShape(usize),
    #[error("engine host error: {0}")]
    Js(String),
}

#[derive(Clone, Debug)]
pub struct KeyEvent {
    pub t: f64,
    pub down: bool,
    pub cell: String,
}

#[derive(Clone, Debug)]
pub struct AudioSample {
    pub t: f64,
    pub bands: Option<Vec<u8>>,
}

pub struct Program<'h> {
    value: Persistent<Value<'static>>,
    _host: PhantomData<&'h EngineHost>,
}

pub struct RendererHandle<'h> {
    value: Persistent<Object<'static>>,
    _host: PhantomData<&'h EngineHost>,
}

pub struct LimiterHandle<'h> {
    value: Persistent<Object<'static>>,
    _host: PhantomData<&'h EngineHost>,
}

struct SafetyTables {
    key_names: Vec<String>,
    key_cells: Vec<String>,
    key_centres_quarter: Vec<[i32; 2]>,
}

pub struct EngineHost {
    // Declaration order is drop order: context must drop before the runtime.
    context: Context,
    _runtime: Runtime,
    deadline: Rc<Cell<Option<Instant>>>,
    interrupted: Rc<Cell<bool>>,
    limits: HostLimits,
    safety: SafetyTables,
}

impl EngineHost {
    pub fn new(limits: HostLimits) -> Result<Self, HostError> {
        let runtime = Runtime::new().map_err(js_error)?;
        runtime.set_memory_limit(limits.memory_bytes);
        runtime.set_max_stack_size(limits.max_stack_bytes);

        let deadline = Rc::new(Cell::new(None));
        let interrupted = Rc::new(Cell::new(false));
        let handler_deadline = deadline.clone();
        let handler_interrupted = interrupted.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            let expired = handler_deadline
                .get()
                .is_some_and(|deadline| Instant::now() >= deadline);
            if expired {
                handler_interrupted.set(true);
            }
            expired
        })));

        let context = Context::full(&runtime).map_err(js_error)?;
        let mut host = Self {
            context,
            _runtime: runtime,
            deadline,
            interrupted,
            limits,
            safety: SafetyTables {
                key_names: Vec::new(),
                key_cells: Vec::new(),
                key_centres_quarter: Vec::new(),
            },
        };

        let setup_budget = host.limits.setup_budget;
        host.with_budget(setup_budget, |ctx| {
            ctx.eval::<Value, _>(ENGINE_BUNDLE)
                .map(|_| ())
                .map_err(js_error)
        })?;

        let shape_ok = host.with_budget(setup_budget, |ctx| {
            ctx.eval::<bool, _>(
                "(typeof RGBPromptEngine === 'object') && \
                 (typeof RGBPromptEngine.decode === 'function') && \
                 (typeof RGBPromptEngine.Renderer === 'function') && \
                 (typeof RGBPromptEngine.frameToBytes === 'function') && \
                 (typeof RGBPromptEngine.analyzeAudioBands === 'function') && \
                 (typeof RGBPromptEngine.getPrimitiveProduct === 'function')",
            )
            .map_err(js_error)
        })?;

        if !shape_ok {
            return Err(HostError::BundleShape(
                "RGBPromptEngine.decode, Renderer, frameToBytes, analyzeAudioBands and \
                 getPrimitiveProduct must all be functions"
                    .to_string(),
            ));
        }

        host.with_budget(setup_budget, |ctx| {
            ctx.eval::<Value, _>(SAFETY_BUNDLE)
                .map(|_| ())
                .map_err(js_error)
        })?;

        let safety_ok = host.with_budget(setup_budget, |ctx| {
            ctx.eval::<bool, _>(
                "(typeof RGBPromptSafety === 'object') && \
                 (typeof RGBPromptSafety.createLimiter === 'function') && \
                 (typeof RGBPromptSafety.frameToKeyRgb === 'function') && \
                 Array.isArray(RGBPromptSafety.KEY_NAMES) && \
                 Array.isArray(RGBPromptSafety.KEY_CELLS) && \
                 Array.isArray(RGBPromptSafety.KEY_CENTRES_QUARTER)",
            )
            .map_err(js_error)
        })?;

        if !safety_ok {
            return Err(HostError::BundleShape(
                "RGBPromptSafety.createLimiter, frameToKeyRgb, KEY_NAMES, KEY_CELLS and \
                 KEY_CENTRES_QUARTER are required"
                    .to_string(),
            ));
        }

        let safety = host.with_budget(setup_budget, |ctx| {
            read_safety_tables(&ctx).map_err(js_error)
        })?;
        if safety.key_names.len() != KEY_COUNT
            || safety.key_cells.len() != KEY_COUNT
            || safety.key_centres_quarter.len() != KEY_COUNT
            || safety.key_names.len() * 3 != KEY_RGB_BYTES
        {
            return Err(HostError::BundleShape(format!(
                "safety tables must describe {KEY_COUNT} keys, got {} names, {} cells and {} centres",
                safety.key_names.len(),
                safety.key_cells.len(),
                safety.key_centres_quarter.len()
            )));
        }
        host.safety = safety;

        host.with_budget(setup_budget, |ctx| {
            ctx.eval::<Value, _>(
                "globalThis.__rgbpFrameToArray = \
                 (frame) => Array.from(RGBPromptEngine.frameToBytes(frame));",
            )
            .map(|_| ())
            .map_err(js_error)
        })?;

        host.with_budget(setup_budget, |ctx| {
            ctx.eval::<Value, _>(
                "globalThis.__rgbpInputWanted = (program) => {\
                   let bits = 0;\
                   for (const layer of (program && program.layers) || []) {\
                     const inputs = RGBPromptEngine.getLayerInputs(layer);\
                     if (inputs.audio) bits |= 1;\
                     if (inputs.key) bits |= 2;\
                   }\
                   return bits;\
                 };",
            )
            .map(|_| ())
            .map_err(js_error)
        })?;

        Ok(host)
    }

    pub fn bundle_sha256() -> &'static str {
        ENGINE_BUNDLE_SHA256
    }

    pub fn safety_bundle_sha256() -> &'static str {
        SAFETY_BUNDLE_SHA256
    }

    pub fn bundle_hashes() -> (&'static str, &'static str) {
        (ENGINE_BUNDLE_SHA256, SAFETY_BUNDLE_SHA256)
    }

    pub fn engine_package_version() -> &'static str {
        ENGINE_PACKAGE_VERSION
    }

    pub fn key_names(&self) -> &[String] {
        &self.safety.key_names
    }

    pub fn key_cells(&self) -> &[String] {
        &self.safety.key_cells
    }

    /// Resolve an ANSI104 key name to the engine's `${row},${col}` cell.
    pub fn key_cell(&self, name: &str) -> Option<&str> {
        self.safety
            .key_names
            .iter()
            .position(|candidate| candidate == name)
            .and_then(|index| self.safety.key_cells.get(index))
            .map(String::as_str)
    }

    pub fn key_centres_quarter(&self) -> &[[i32; 2]] {
        &self.safety.key_centres_quarter
    }

    /// Which inputs the decoded effect needs: bit 0 audio, bit 1 keys.
    pub fn input_wanted(&self, program: &Program<'_>) -> Result<u32, HostError> {
        self.with_budget(self.limits.setup_budget, |ctx| {
            let helper: Function = ctx.globals().get("__rgbpInputWanted").map_err(js_error)?;
            let program_value = program.value.clone().restore(&ctx).map_err(js_error)?;
            let bits: u32 = helper
                .call((program_value,))
                .map_err(|error| render_error(&ctx, error))?;
            Ok(bits)
        })
    }

    /// Map a 1024-bin byte spectrum to the engine's 22 bands.
    pub fn bands(
        &self,
        spectrum: &[u8],
        sample_rate: f64,
    ) -> Result<[u8; AUDIO_BAND_COUNT], HostError> {
        self.with_budget(self.limits.step_budget, |ctx| {
            let engine: Object = ctx.globals().get("RGBPromptEngine").map_err(js_error)?;
            let analyze: Function = engine.get("analyzeAudioBands").map_err(js_error)?;
            let input = TypedArray::new(ctx.clone(), spectrum.to_vec()).map_err(js_error)?;
            let result: Value = analyze
                .call((input, sample_rate))
                .map_err(|error| render_error(&ctx, error))?;
            let values: Vec<u8> = result.get().map_err(js_error)?;
            if values.len() != AUDIO_BAND_COUNT {
                return Err(HostError::BundleShape(format!(
                    "analyzeAudioBands returned {} bands, expected {AUDIO_BAND_COUNT}",
                    values.len()
                )));
            }
            let mut bands = [0u8; AUDIO_BAND_COUNT];
            bands.copy_from_slice(&values);
            Ok(bands)
        })
    }

    pub fn decode(&self, lep: &[u8]) -> Result<Program<'_>, HostError> {
        self.with_budget(self.limits.setup_budget, |ctx| {
            let engine: Object = ctx.globals().get("RGBPromptEngine").map_err(js_error)?;
            let decode: Function = engine.get("decode").map_err(js_error)?;
            let bytes = TypedArray::new(ctx.clone(), lep.to_vec()).map_err(js_error)?;
            let result: Object = decode
                .call((bytes,))
                .map_err(|error| decode_error(&ctx, error))?;
            let program: Value = result.get("program").map_err(js_error)?;
            Ok(Program {
                value: Persistent::save(&ctx, program),
                _host: PhantomData,
            })
        })
    }

    pub fn renderer(&self, program: &Program<'_>) -> Result<RendererHandle<'_>, HostError> {
        self.with_budget(self.limits.setup_budget, |ctx| {
            let engine: Object = ctx.globals().get("RGBPromptEngine").map_err(js_error)?;
            let renderer_ctor: Constructor = engine.get("Renderer").map_err(js_error)?;
            let program_value = program.value.clone().restore(&ctx).map_err(js_error)?;
            let instance: Object = renderer_ctor
                .construct((program_value,))
                .map_err(|error| render_error(&ctx, error))?;
            Ok(RendererHandle {
                value: Persistent::save(&ctx, instance),
                _host: PhantomData,
            })
        })
    }

    /// Create a persistent real-time limiter in the same QuickJS context.
    pub fn limiter(&self) -> Result<LimiterHandle<'_>, HostError> {
        self.with_budget(self.limits.setup_budget, |ctx| {
            let safety: Object = ctx.globals().get("RGBPromptSafety").map_err(js_error)?;
            let create: Function = safety.get("createLimiter").map_err(js_error)?;
            let instance: Object = create.call(()).map_err(|error| render_error(&ctx, error))?;
            Ok(LimiterHandle {
                value: Persistent::save(&ctx, instance),
                _host: PhantomData,
            })
        })
    }

    pub fn step(
        &self,
        renderer: &RendererHandle<'_>,
        t_ms: f64,
        keys: &[KeyEvent],
        audio: &[AudioSample],
    ) -> Result<Vec<u8>, HostError> {
        self.with_budget(self.limits.step_budget, |ctx| {
            let frame = self.render_value(&ctx, renderer, t_ms, keys, audio)?;
            let frame_to_array: Function =
                ctx.globals().get("__rgbpFrameToArray").map_err(js_error)?;
            let result: Value = frame_to_array
                .call((frame,))
                .map_err(|error| render_error(&ctx, error))?;
            let bytes: Vec<u8> = result.get().map_err(js_error)?;
            if bytes.len() != FRAME_BYTES {
                return Err(HostError::FrameShape(bytes.len()));
            }
            Ok(bytes)
        })
    }

    /// Render one frame and convert it to 104 keys in `KEY_NAMES` order (312
    /// bytes), the limiter's input.
    pub fn step_keys(
        &self,
        renderer: &RendererHandle<'_>,
        t_ms: f64,
        keys: &[KeyEvent],
        audio: &[AudioSample],
    ) -> Result<Vec<u8>, HostError> {
        self.with_budget(self.limits.step_budget, |ctx| {
            let frame = self.render_value(&ctx, renderer, t_ms, keys, audio)?;
            let safety: Object = ctx.globals().get("RGBPromptSafety").map_err(js_error)?;
            let frame_to_keys: Function = safety.get("frameToKeyRgb").map_err(js_error)?;
            let result: Value = frame_to_keys
                .call((frame,))
                .map_err(|error| render_error(&ctx, error))?;
            let typed =
                TypedArray::<u8>::from_value(result).map_err(|error| render_error(&ctx, error))?;
            if typed.len() != KEY_RGB_BYTES {
                return Err(HostError::FrameShape(typed.len()));
            }
            // SAFETY: no JavaScript runs while the slice is alive.
            let bytes = unsafe { typed.as_slice() }.to_vec();
            Ok(bytes)
        })
    }

    /// Run one limiter step over a 312-byte key frame and return its output.
    pub fn limit(
        &self,
        limiter: &LimiterHandle<'_>,
        keys_rgb: &[u8],
        dt_ms: f64,
    ) -> Result<Vec<u8>, HostError> {
        if keys_rgb.len() != KEY_RGB_BYTES {
            return Err(HostError::FrameShape(keys_rgb.len()));
        }
        self.with_budget(self.limits.step_budget, |ctx| {
            let instance = limiter.value.clone().restore(&ctx).map_err(js_error)?;
            let step: Function = instance.get("step").map_err(js_error)?;
            let input = TypedArray::new(ctx.clone(), keys_rgb.to_vec()).map_err(js_error)?;
            let result: Value = step
                .call((input, dt_ms))
                .map_err(|error| render_error(&ctx, error))?;
            let typed =
                TypedArray::<u8>::from_value(result).map_err(|error| render_error(&ctx, error))?;
            if typed.len() != KEY_RGB_BYTES {
                return Err(HostError::FrameShape(typed.len()));
            }
            // SAFETY: no JavaScript runs while the slice is alive.
            let bytes = unsafe { typed.as_slice() }.to_vec();
            Ok(bytes)
        })
    }

    fn render_value<'js>(
        &self,
        ctx: &Ctx<'js>,
        renderer: &RendererHandle<'_>,
        t_ms: f64,
        keys: &[KeyEvent],
        audio: &[AudioSample],
    ) -> Result<Value<'js>, HostError> {
        let instance = renderer.value.clone().restore(ctx).map_err(js_error)?;
        let step: Function = instance.get("step").map_err(js_error)?;

        let io = Object::new(ctx.clone()).map_err(js_error)?;
        let key_array = Array::new(ctx.clone()).map_err(js_error)?;
        for (index, key) in keys.iter().enumerate() {
            let item = Object::new(ctx.clone()).map_err(js_error)?;
            item.set("t", key.t).map_err(js_error)?;
            item.set("type", if key.down { "down" } else { "up" })
                .map_err(js_error)?;
            item.set("cell", key.cell.as_str()).map_err(js_error)?;
            key_array.set(index, item).map_err(js_error)?;
        }
        io.set("keys", key_array).map_err(js_error)?;

        let audio_array = Array::new(ctx.clone()).map_err(js_error)?;
        for (index, sample) in audio.iter().enumerate() {
            let item = Object::new(ctx.clone()).map_err(js_error)?;
            item.set("t", sample.t).map_err(js_error)?;
            match &sample.bands {
                Some(values) => {
                    let bands = Array::new(ctx.clone()).map_err(js_error)?;
                    for (band_index, band) in values.iter().enumerate() {
                        bands.set(band_index, *band).map_err(js_error)?;
                    }
                    item.set("bands", bands).map_err(js_error)?;
                }
                None => item.set("bands", Null).map_err(js_error)?,
            }
            audio_array.set(index, item).map_err(js_error)?;
        }
        io.set("audio", audio_array).map_err(js_error)?;

        let mut args = Args::new(ctx.clone(), 2);
        args.this(instance).map_err(js_error)?;
        args.push_arg(t_ms).map_err(js_error)?;
        args.push_arg(io).map_err(js_error)?;
        step.call_arg(args)
            .map_err(|error| render_error(ctx, error))
    }

    fn with_budget<T>(
        &self,
        budget: Duration,
        run: impl FnOnce(Ctx<'_>) -> Result<T, HostError>,
    ) -> Result<T, HostError> {
        self.arm(budget);
        let result = self.context.with(run);
        let interrupted = self.interrupted.get();
        self.disarm();
        if interrupted {
            return Err(HostError::Interrupted);
        }
        result
    }

    fn arm(&self, budget: Duration) {
        self.interrupted.set(false);
        self.deadline.set(Some(Instant::now() + budget));
    }

    fn disarm(&self) {
        self.deadline.set(None);
    }

    #[cfg(test)]
    fn renderer_for_test(&self, source: &str) -> Result<RendererHandle<'_>, HostError> {
        self.with_budget(self.limits.setup_budget, |ctx| {
            let object: Object = ctx.eval(source).map_err(js_error)?;
            Ok(RendererHandle {
                value: Persistent::save(&ctx, object),
                _host: PhantomData,
            })
        })
    }
}

fn read_safety_tables(ctx: &Ctx<'_>) -> Result<SafetyTables, rquickjs::Error> {
    let safety: Object = ctx.globals().get("RGBPromptSafety")?;
    let names_array: Array = safety.get("KEY_NAMES")?;
    let mut key_names = Vec::with_capacity(names_array.len());
    for index in 0..names_array.len() {
        key_names.push(names_array.get::<String>(index)?);
    }
    let cells_array: Array = safety.get("KEY_CELLS")?;
    let mut key_cells = Vec::with_capacity(cells_array.len());
    for index in 0..cells_array.len() {
        key_cells.push(cells_array.get::<String>(index)?);
    }
    let centres_array: Array = safety.get("KEY_CENTRES_QUARTER")?;
    let mut key_centres_quarter = Vec::with_capacity(centres_array.len());
    for index in 0..centres_array.len() {
        let pair: Array = centres_array.get(index)?;
        let x: i32 = pair.get(0)?;
        let y: i32 = pair.get(1)?;
        key_centres_quarter.push([x, y]);
    }
    Ok(SafetyTables {
        key_names,
        key_cells,
        key_centres_quarter,
    })
}

fn js_error(error: rquickjs::Error) -> HostError {
    HostError::Js(error.to_string())
}

fn decode_error(ctx: &Ctx<'_>, error: rquickjs::Error) -> HostError {
    if let Some(exception) = ctx.catch().into_exception() {
        return HostError::Decode(exception.message().unwrap_or_default());
    }
    HostError::Js(error.to_string())
}

fn render_error(ctx: &Ctx<'_>, error: rquickjs::Error) -> HostError {
    if let Some(exception) = ctx.catch().into_exception() {
        return HostError::Render(exception.message().unwrap_or_default());
    }
    HostError::Render(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_rejects_garbage() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        match host.decode(&[0u8; 16]) {
            Err(error) => assert!(matches!(error, HostError::Decode(_)), "{error}"),
            Ok(_) => panic!("garbage must fail"),
        }
    }

    #[test]
    fn decode_rejects_unknown_package_version() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        // LEP1 header, package version 99; the decoder checks the version
        // before CRC or layer data.
        let mut lep = vec![0u8; 44];
        lep[0..4].copy_from_slice(b"LEP1");
                lep[4] = 99;
        lep[36] = 44; // totalSize, so CRC offset is in range
        match host.decode(&lep) {
            Err(HostError::Decode(message)) => {
                assert!(
                    message.contains("incompatible package"),
                    "{message}"
                )
            }
            Ok(_) => panic!("unknown package version must fail"),
            Err(error) => panic!("expected incompatible package, got {error}"),
        }
    }

    #[test]
    fn interrupt_handler_stops_infinite_loop() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let start = Instant::now();
        let error = host
            .with_budget(Duration::from_millis(100), |ctx| {
                ctx.eval::<Value, _>("for (;;) {}")
                    .map(|_| ())
                    .map_err(js_error)
            })
            .expect_err("infinite loop must be interrupted");
        assert!(matches!(error, HostError::Interrupted), "{error}");
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn memory_limit_returns_error_and_host_survives() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let result = host.with_budget(Duration::from_secs(2), |ctx| {
            ctx.eval::<Value, _>("new Uint8Array(256 * 1024 * 1024)")
                .map(|_| ())
                .map_err(js_error)
        });
        assert!(result.is_err());

        let sum: i32 = host
            .with_budget(Duration::from_secs(2), |ctx| {
                ctx.eval::<i32, _>("1 + 1").map_err(js_error)
            })
            .expect("host still usable");
        assert_eq!(sum, 2);
    }

    #[test]
    fn step_maps_js_exceptions_to_render() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let renderer = host
            .renderer_for_test("({ step() { throw new Error('boom'); } })")
            .expect("renderer");
        let error = host
            .step(&renderer, 0.0, &[], &[])
            .expect_err("step must fail");
        assert!(
            matches!(&error, HostError::Render(message) if message.contains("boom")),
            "{error}"
        );
    }

    #[test]
    fn exposes_safety_tables() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        assert_eq!(host.key_names().len(), KEY_COUNT);
        assert_eq!(host.key_cells().len(), KEY_COUNT);
        assert_eq!(host.key_centres_quarter().len(), KEY_COUNT);
        assert_eq!(host.key_names()[0], "ESC");
        assert_eq!(host.key_cell("ESC"), Some("0,0"));
        assert_eq!(host.key_cell("NOT_A_KEY"), None);
    }

    #[test]
    fn input_wanted_reports_audio_and_keys() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let audio = host
            .decode(include_bytes!("../tests/data/music-spectrum.lep"))
            .expect("audio lep");
        assert_eq!(host.input_wanted(&audio).expect("wanted"), 1);

        let party = host
            .decode(include_bytes!("../tests/data/party.lep"))
            .expect("party lep");
        assert_eq!(host.input_wanted(&party).expect("wanted"), 3);
    }

    #[test]
    fn black_frame_round_trips_black() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let limiter = host.limiter().expect("limiter");
        let out = host
            .limit(&limiter, &[0u8; KEY_RGB_BYTES], 40.0)
            .expect("limit");
        assert_eq!(out, vec![0u8; KEY_RGB_BYTES]);
    }

    #[test]
    fn wrong_length_input_is_frame_shape() {
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let limiter = host.limiter().expect("limiter");
        match host.limit(&limiter, &[0u8; 100], 40.0) {
            Err(HostError::FrameShape(100)) => {}
            other => panic!("expected FrameShape, got {other:?}"),
        }
    }

    #[test]
    fn output_stage_passes_a_10hz_strobe_through_unchanged() {
        // WYSIWYG: there is no flash-rate limit; every frame leaves exactly as
        // the engine computed it.
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let limiter = host.limiter().expect("limiter");
        let white = [255u8; KEY_RGB_BYTES];
        let black = [0u8; KEY_RGB_BYTES];
        for frame in 0..100 {
            let input = if frame % 2 == 0 { &white } else { &black };
            let out = host.limit(&limiter, input, 40.0).expect("limit");
            assert_eq!(out.as_slice(), input.as_slice(), "frame {frame} changed");
        }
    }

    #[test]
    fn four_hz_full_board_flash_reaches_full_dark_between_hits() {
        // 60 fps, 125 ms full white then 125 ms full black, for five seconds.
        let host = EngineHost::new(HostLimits::default()).expect("host");
        let limiter = host.limiter().expect("limiter");
        let white = [255u8; KEY_RGB_BYTES];
        let black = [0u8; KEY_RGB_BYTES];
        let dt_ms = 1000.0 / 60.0;
        let mut dark_after_warmup = 0;
        for frame in 0..300u32 {
            let t_ms = f64::from(frame) * dt_ms;
            let on = t_ms % 250.0 < 125.0;
            let input = if on { &white } else { &black };
            let out = host.limit(&limiter, input, dt_ms).expect("limit");
            assert_eq!(out.as_slice(), input.as_slice(), "frame {frame} changed");
            if frame >= 60 && !on {
                assert!(
                    out.iter().all(|&value| value == 0),
                    "frame {frame} not fully dark"
                );
                dark_after_warmup += 1;
            }
        }
        assert!(dark_after_warmup > 0);
    }
}
