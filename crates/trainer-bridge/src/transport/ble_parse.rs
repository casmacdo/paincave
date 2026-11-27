use ftms::measurement::{
    MeasurementField, MeasurementKind, MeasurementOptions, decode_measurement,
};
use ftms::{
    ControlOptions, ControlRequest, ControlResponse, ResistanceControlFormat,
    decode_control_response, encode_control_request,
};

pub const FTMS_SERVICE_UUID: &str = "00001826-0000-1000-8000-00805f9b34fb";
pub const FTMS_INDOOR_BIKE_DATA_UUID: &str = "00002ad2-0000-1000-8000-00805f9b34fb";
pub const FTMS_CONTROL_POINT_UUID: &str = "00002ad9-0000-1000-8000-00805f9b34fb";

pub const CYCLING_POWER_SERVICE_UUID: &str = "00001818-0000-1000-8000-00805f9b34fb";
pub const CYCLING_POWER_MEASUREMENT_UUID: &str = "00002a63-0000-1000-8000-00805f9b34fb";

pub const HR_SERVICE_UUID: &str = "0000180d-0000-1000-8000-00805f9b34fb";
pub const HR_MEASUREMENT_UUID: &str = "00002a37-0000-1000-8000-00805f9b34fb";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CyclingPowerSample {
    pub watts: u16,
    pub crank_revolutions: Option<u16>,
    pub crank_event_time: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct IndoorBikeSample {
    pub watts: Option<u16>,
    pub hr_bpm: Option<u8>,
    pub cadence_rpm: Option<u8>,
    pub speed_kph: Option<f64>,
}

fn has_valid_field(present: u32, unavailable: u32, field: MeasurementField) -> bool {
    let mask = field.mask();
    (present & mask) != 0 && (unavailable & mask) == 0
}

pub fn parse_indoor_bike_data(bytes: &[u8]) -> Result<IndoorBikeSample, ftms::Error> {
    let decoded = decode_measurement(
        MeasurementKind::IndoorBike,
        bytes,
        MeasurementOptions::default(),
    )?;

    let speed_kph = if has_valid_field(
        decoded.present,
        decoded.unavailable,
        MeasurementField::Speed,
    ) {
        let raw_speed = decoded.values[MeasurementField::Speed.index()];
        Some((raw_speed.max(0) as f64) / 100.0)
    } else {
        None
    };

    let cadence_rpm = if has_valid_field(
        decoded.present,
        decoded.unavailable,
        MeasurementField::Cadence,
    ) {
        let raw_cadence = decoded.values[MeasurementField::Cadence.index()];
        Some(((raw_cadence.max(0) / 2).clamp(0, i32::from(u8::MAX))) as u8)
    } else {
        None
    };

    let watts = if has_valid_field(
        decoded.present,
        decoded.unavailable,
        MeasurementField::Power,
    ) {
        let raw_power = decoded.values[MeasurementField::Power.index()];
        Some((raw_power.clamp(0, i32::from(u16::MAX))) as u16)
    } else {
        None
    };

    let hr_bpm = if has_valid_field(
        decoded.present,
        decoded.unavailable,
        MeasurementField::HeartRate,
    ) {
        let raw_hr = decoded.values[MeasurementField::HeartRate.index()];
        Some((raw_hr.clamp(0, i32::from(u8::MAX))) as u8)
    } else {
        None
    };

    Ok(IndoorBikeSample {
        watts,
        hr_bpm,
        cadence_rpm,
        speed_kph,
    })
}

pub fn parse_cycling_power_measurement(bytes: &[u8]) -> Option<CyclingPowerSample> {
    let flags = u16::from_le_bytes([*bytes.first()?, *bytes.get(1)?]);
    let power = i16::from_le_bytes([*bytes.get(2)?, *bytes.get(3)?]);
    let mut offset: usize = 4;

    for (flag, field_len) in [(0, 1), (2, 2), (4, 6)] {
        if flags & (1 << flag) != 0 {
            offset = offset.checked_add(field_len)?;
            bytes.get(4..offset)?;
        }
    }

    let (crank_revolutions, crank_event_time) = if flags & (1 << 5) != 0 {
        let revs = u16::from_le_bytes([*bytes.get(offset)?, *bytes.get(offset + 1)?]);
        let event_time = u16::from_le_bytes([*bytes.get(offset + 2)?, *bytes.get(offset + 3)?]);
        (Some(revs), Some(event_time))
    } else {
        (None, None)
    };

    Some(CyclingPowerSample {
        watts: power.max(0) as u16,
        crank_revolutions,
        crank_event_time,
    })
}

pub fn cadence_from_crank_events(previous: (u16, u16), current: (u16, u16)) -> Option<u8> {
    if current == previous {
        return None;
    }
    let revolutions = current.0.wrapping_sub(previous.0);
    let event_ticks = current.1.wrapping_sub(previous.1);
    if event_ticks == 0 {
        return None;
    }
    let rpm =
        (u32::from(revolutions) * 60 * 1024 + u32::from(event_ticks) / 2) / u32::from(event_ticks);
    Some(rpm.min(u32::from(u8::MAX)) as u8)
}

pub fn parse_heart_rate_measurement(bytes: &[u8]) -> Option<u8> {
    let flags = *bytes.first()?;
    let is_u16 = (flags & 0x01) != 0;
    if !is_u16 {
        let bpm = *bytes.get(1)?;
        return Some(bpm);
    }
    let lo = *bytes.get(1)?;
    let hi = *bytes.get(2)?;
    let bpm = u16::from_le_bytes([lo, hi]);
    Some(bpm.min(u16::from(u8::MAX)) as u8)
}

fn encode_control_payload(
    req: ControlRequest,
    options: ControlOptions,
) -> Result<Vec<u8>, ftms::Error> {
    let mut buf = [0u8; 16];
    let len = encode_control_request(req, options, &mut buf)?;
    Ok(buf[..len].to_vec())
}

pub fn encode_request_control() -> Result<Vec<u8>, ftms::Error> {
    encode_control_payload(
        ControlRequest {
            opcode: 0x00,
            operands: [0; 5],
            operand_count: 0,
        },
        ControlOptions::default(),
    )
}

pub fn encode_start_or_resume() -> Result<Vec<u8>, ftms::Error> {
    encode_control_payload(
        ControlRequest {
            opcode: 0x07,
            operands: [0; 5],
            operand_count: 0,
        },
        ControlOptions::default(),
    )
}

pub fn encode_set_target_power(watts: u16) -> Result<Vec<u8>, ftms::Error> {
    let clamped = i32::from(watts.min(i16::MAX as u16));
    encode_control_payload(
        ControlRequest {
            opcode: 0x05,
            operands: [clamped, 0, 0, 0, 0],
            operand_count: 1,
        },
        ControlOptions::default(),
    )
}

pub fn encode_set_resistance_pct(pct: f64) -> Result<Vec<u8>, ftms::Error> {
    let clamped = pct.clamp(0.0, 100.0).round() as i32;
    encode_control_payload(
        ControlRequest {
            opcode: 0x04,
            operands: [clamped, 0, 0, 0, 0],
            operand_count: 1,
        },
        ControlOptions {
            resistance_format: ResistanceControlFormat::Uint8Tenths,
        },
    )
}

pub fn encode_set_indoor_bike_simulation(grade_pct: f64) -> Result<Vec<u8>, ftms::Error> {
    // Wire units: wind speed = 0 m/s, grade = 0.01% signed16, crr = 0.0040 (40 * 1e-4), cw = 0.51 kg/m (51 * 1e-2)
    let grade_hundredths = (grade_pct.clamp(-40.0, 40.0) * 100.0).round() as i32;
    encode_control_payload(
        ControlRequest {
            opcode: 0x11,
            operands: [0, grade_hundredths, 40, 51, 0],
            operand_count: 4,
        },
        ControlOptions::default(),
    )
}

pub fn parse_control_point_response(bytes: &[u8]) -> Result<ControlResponse, ftms::Error> {
    decode_control_response(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ftms::decode_control_request;
    use ftms::measurement::{RawMeasurement, encode_measurement};

    #[test]
    fn parses_kickr_indoor_bike_data_with_speed_cadence_power_hr() -> anyhow::Result<()> {
        let mut raw = RawMeasurement::new(MeasurementKind::IndoorBike);
        raw.flags = (1 << 2) | (1 << 6) | (1 << 9); // More Data = 0 => Speed present, plus Cadence, Power, HR
        raw.present = MeasurementField::Speed.mask()
            | MeasurementField::Cadence.mask()
            | MeasurementField::Power.mask()
            | MeasurementField::HeartRate.mask();
        raw.values[MeasurementField::Speed.index()] = 3425; // 34.25 km/h
        raw.values[MeasurementField::Cadence.index()] = 180; // 90 rpm
        raw.values[MeasurementField::Power.index()] = 265; // 265 W
        raw.values[MeasurementField::HeartRate.index()] = 158; // 158 bpm

        let mut wire = [0u8; 16];
        let n = encode_measurement(&raw, MeasurementOptions::default(), &mut wire)?;
        let parsed = parse_indoor_bike_data(&wire[..n])?;

        assert_eq!(parsed.watts, Some(265));
        assert_eq!(parsed.cadence_rpm, Some(90));
        assert_eq!(parsed.hr_bpm, Some(158));
        assert_eq!(parsed.speed_kph, Some(34.25));
        Ok(())
    }

    #[test]
    fn parses_absent_fields_without_fabricating_zeroes() -> anyhow::Result<()> {
        // More Data = 1 (bit 0 set -> no Speed), Cadence present (bit 2), Power absent
        let wire = [0b0000_0101, 0x00, 170, 0]; // cadence raw 170 = 85 rpm
        let parsed = parse_indoor_bike_data(&wire)?;
        assert_eq!(parsed.speed_kph, None);
        assert_eq!(parsed.cadence_rpm, Some(85));
        assert_eq!(parsed.watts, None);
        assert_eq!(parsed.hr_bpm, None);
        Ok(())
    }

    #[test]
    fn parses_heart_rate_8bit_and_16bit_payloads() {
        assert_eq!(
            parse_heart_rate_measurement(&[0x06, 152, 0x30, 0x03]),
            Some(152)
        );
        assert_eq!(parse_heart_rate_measurement(&[0x01, 188, 0x00]), Some(188));
        assert_eq!(parse_heart_rate_measurement(&[0x01, 0x10]), None);
        assert_eq!(parse_heart_rate_measurement(&[]), None);
    }

    #[test]
    fn parses_cycling_power_and_crank_revolution_data() -> anyhow::Result<()> {
        let parsed = parse_cycling_power_measurement(&[
            0x20, 0x00, 0xfa, 0x00, // crank revolutions present, 250 W
            10, 0, 0, 4, // 10 revolutions, event time 1024
        ])
        .ok_or_else(|| anyhow::anyhow!("expected valid cycling power measurement"))?;
        assert_eq!(parsed.watts, 250);
        assert_eq!(parsed.crank_revolutions, Some(10));
        assert_eq!(parsed.crank_event_time, Some(1024));
        assert_eq!(cadence_from_crank_events((9, 0), (10, 1024)), Some(60));
        assert_eq!(
            cadence_from_crank_events((u16::MAX, 0), (0, 1024)),
            Some(60)
        );
        assert_eq!(cadence_from_crank_events((10, 1024), (10, 1024)), None);
        Ok(())
    }

    #[test]
    fn skips_optional_cycling_power_fields_and_rejects_truncated_data() -> anyhow::Result<()> {
        let parsed = parse_cycling_power_measurement(&[
            0x35, 0x00, 0xc8, 0x00, // balance, torque, wheel and crank data
            50, 100, 0, // balance and accumulated torque
            1, 0, 0, 0, 0, 0, // wheel data
            22, 0, 0, 4, // crank data
        ])
        .ok_or_else(|| anyhow::anyhow!("expected valid cycling power measurement"))?;
        assert_eq!(parsed.watts, 200);
        assert_eq!(parsed.crank_revolutions, Some(22));
        assert_eq!(parsed.crank_event_time, Some(1024));
        assert_eq!(parse_cycling_power_measurement(&[0x20, 0, 100, 0]), None);
        Ok(())
    }

    #[test]
    fn round_trips_control_point_commands_and_responses() -> anyhow::Result<()> {
        let req_ctrl = encode_request_control()?;
        assert_eq!(req_ctrl, vec![0x00]);

        let start = encode_start_or_resume()?;
        assert_eq!(start, vec![0x07]);

        let erg = encode_set_target_power(275)?;
        let decoded_erg = decode_control_request(&erg, ControlOptions::default())?;
        assert_eq!(decoded_erg.opcode, 0x05);
        assert_eq!(decoded_erg.operands[0], 275);

        let res = encode_set_resistance_pct(65.0)?;
        let decoded_res = decode_control_request(
            &res,
            ControlOptions {
                resistance_format: ResistanceControlFormat::Uint8Tenths,
            },
        )?;
        assert_eq!(decoded_res.opcode, 0x04);
        assert_eq!(decoded_res.operands[0], 65);

        let slope_pos = encode_set_indoor_bike_simulation(6.5)?;
        let decoded_pos = decode_control_request(&slope_pos, ControlOptions::default())?;
        assert_eq!(decoded_pos.opcode, 0x11);
        assert_eq!(decoded_pos.operands[1], 650);

        let slope_neg = encode_set_indoor_bike_simulation(-3.25)?;
        let decoded_neg = decode_control_request(&slope_neg, ControlOptions::default())?;
        assert_eq!(decoded_neg.opcode, 0x11);
        assert_eq!(decoded_neg.operands[1], -325);

        let ok_resp = parse_control_point_response(&[0x80, 0x05, 0x01])?;
        assert_eq!(ok_resp.request_opcode, 0x05);
        assert_eq!(ok_resp.result_code, 0x01);

        let rej_resp = parse_control_point_response(&[0x80, 0x11, 0x04])?;
        assert_eq!(rej_resp.request_opcode, 0x11);
        assert_eq!(rej_resp.result_code, 0x04);
        Ok(())
    }
}
