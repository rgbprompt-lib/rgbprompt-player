//! Global brightness and gamma applied before writing to the controller
//! (PLAYER §5: 10–100%, gamma 2.2, no way to turn gamma off).

const GAMMA: f64 = 2.2;
const MIN_BRIGHTNESS: u8 = 10;
const MAX_BRIGHTNESS: u8 = 100;

#[derive(Clone, Debug)]
pub struct OutputStage {
    table: [u8; 256],
    brightness_pct: u8,
}

impl OutputStage {
    /// Clamp `brightness_pct` to 10–100 and precompute the output table.
    /// `out = round(255 * ((v / 255) * (b / 100))^2.2)`.
    pub fn new(brightness_pct: u8) -> Self {
        let brightness_pct = brightness_pct.clamp(MIN_BRIGHTNESS, MAX_BRIGHTNESS);
        let scale = f64::from(brightness_pct) / 100.0;
        let mut table = [0u8; 256];
        for (value, slot) in table.iter_mut().enumerate() {
            let linear = (value as f64 / 255.0) * scale;
            *slot = (255.0 * linear.powf(GAMMA)).round().clamp(0.0, 255.0) as u8;
        }
        Self {
            table,
            brightness_pct,
        }
    }

    pub fn brightness_pct(&self) -> u8 {
        self.brightness_pct
    }

    /// Apply brightness and gamma in place to one colour per LED.
    pub fn apply(&self, colors: &mut [[u8; 3]]) {
        for color in colors {
            for channel in color {
                *channel = self.table[usize::from(*channel)];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expected(value: u8, brightness_pct: u8) -> u8 {
        let scale = f64::from(brightness_pct) / 100.0;
        (255.0 * ((f64::from(value) / 255.0) * scale).powf(GAMMA))
            .round()
            .clamp(0.0, 255.0) as u8
    }

    #[test]
    fn full_brightness_endpoints() {
        let stage = OutputStage::new(100);
        assert_eq!(stage.table[0], 0);
        assert_eq!(stage.table[255], 255);
        assert_eq!(stage.table[128], expected(128, 100));
        assert_eq!(stage.table[128], 56);
    }

    #[test]
    fn table_is_monotonic() {
        for brightness in [10, 50, 100] {
            let stage = OutputStage::new(brightness);
            for value in 1..256 {
                assert!(stage.table[value] >= stage.table[value - 1]);
            }
        }
    }

    #[test]
    fn fifty_percent_halves_before_gamma() {
        let stage = OutputStage::new(50);
        for value in [0u8, 64, 128, 255] {
            assert_eq!(stage.table[usize::from(value)], expected(value, 50));
        }
    }

    #[test]
    fn low_brightness_clamps_to_ten_percent() {
        let five = OutputStage::new(5);
        assert_eq!(five.brightness_pct(), 10);
        assert_eq!(five.table, OutputStage::new(10).table);
    }

    #[test]
    fn apply_is_in_place() {
        let stage = OutputStage::new(100);
        let mut colors = vec![[0, 128, 255]];
        stage.apply(&mut colors);
        assert_eq!(colors[0], [0, 56, 255]);
    }
}
