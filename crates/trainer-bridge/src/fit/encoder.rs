use chrono::{DateTime, Utc};

use crate::physiology::RideMetricsResult;
use crate::protocol::TelemetrySample;

const FIT_EPOCH_UNIX_S: i64 = 631_065_600;

const CRC_TABLE: [u16; 16] = [
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401,
    0x5000, 0x9C01, 0x8801, 0x4400,
];

fn fit_crc16(bytes: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &byte in bytes {
        let mut tmp = CRC_TABLE[usize::from(crc & 0x0F)];
        crc = (crc >> 4) & 0x0FFF;
        crc ^= tmp ^ CRC_TABLE[usize::from(byte & 0x0F)];

        tmp = CRC_TABLE[usize::from(crc & 0x0F)];
        crc = (crc >> 4) & 0x0FFF;
        crc ^= tmp ^ CRC_TABLE[usize::from((byte >> 4) & 0x0F)];
    }
    crc
}

fn to_fit_timestamp(utc: DateTime<Utc>) -> u32 {
    (utc.timestamp() - FIT_EPOCH_UNIX_S).max(0) as u32
}

fn push_def(buf: &mut Vec<u8>, local_id: u8, global_msg: u16, fields: &[(u8, u8, u8)]) {
    buf.push(0x40 | (local_id & 0x0F));
    buf.push(0x00); // reserved
    buf.push(0x00); // little endian
    buf.extend_from_slice(&global_msg.to_le_bytes());
    buf.push(fields.len() as u8);
    for &(field_num, size, base_type) in fields {
        buf.push(field_num);
        buf.push(size);
        buf.push(base_type);
    }
}

/// Encodes a standard FIT v2.0 Indoor Cycling Activity file containing
/// `file_id`, timer `event`s, 1Hz `record`s, `lap`, `session`, and `activity` messages.
pub fn encode_cycling_fit(
    started_at: DateTime<Utc>,
    samples: &[TelemetrySample],
    metrics: &RideMetricsResult,
) -> Vec<u8> {
    let has_synthetic_route = samples.iter().any(|sample| sample.synthetic_route);
    let mut data =
        Vec::with_capacity(256 + samples.len() * if has_synthetic_route { 26 } else { 16 });
    let start_fit_ts = to_fit_timestamp(started_at);
    let end_fit_ts = start_fit_ts.saturating_add(metrics.elapsed_s);
    // Product 65001 is a development-profile marker for PainCave fictional route data.
    let file_product = if has_synthetic_route { 65001u16 } else { 1u16 };
    // FIT SubSport: 58 = virtual_activity, 6 = indoor_cycling
    let sub_sport: u8 = if has_synthetic_route { 58 } else { 6 };

    // 1. file_id (global 0, local 0)
    push_def(
        &mut data,
        0,
        0,
        &[
            (0, 1, 0x00), // type = activity (4)
            (1, 2, 0x84), // manufacturer = development (255)
            (2, 2, 0x84), // product = 1 or synthetic-route marker 65001
            (3, 4, 0x8C), // serial_number
            (4, 4, 0x86), // time_created
        ],
    );
    data.push(0x00);
    data.push(4);
    data.extend_from_slice(&255u16.to_le_bytes());
    data.extend_from_slice(&file_product.to_le_bytes());
    data.extend_from_slice(&1001u32.to_le_bytes());
    data.extend_from_slice(&start_fit_ts.to_le_bytes());

    // 2. event definition (global 21, local 1) + timer start
    push_def(
        &mut data,
        1,
        21,
        &[
            (253, 4, 0x86), // timestamp
            (0, 1, 0x00),   // event = timer (0)
            (1, 1, 0x00),   // event_type = start (0) / stop_all (4)
            (4, 1, 0x02),   // event_group = 0
        ],
    );
    data.push(0x01);
    data.extend_from_slice(&start_fit_ts.to_le_bytes());
    data.push(0);
    data.push(0);
    data.push(0);

    // 3. record definition (global 20, local 2) + 1Hz samples
    if has_synthetic_route {
        push_def(
            &mut data,
            2,
            20,
            &[
                (0, 4, 0x85),   // position_lat (semicircles)
                (1, 4, 0x85),   // position_long (semicircles)
                (2, 2, 0x84),   // altitude (m * 5 + 500)
                (253, 4, 0x86), // timestamp
                (3, 1, 0x02),   // heart_rate (bpm)
                (4, 1, 0x02),   // cadence (rpm)
                (5, 4, 0x86),   // distance (m * 100)
                (6, 2, 0x84),   // speed (m/s * 1000)
                (7, 2, 0x84),   // power (watts)
            ],
        );
    } else {
        push_def(
            &mut data,
            2,
            20,
            &[
                (253, 4, 0x86), // timestamp
                (3, 1, 0x02),   // heart_rate (bpm)
                (4, 1, 0x02),   // cadence (rpm)
                (5, 4, 0x86),   // distance (m * 100)
                (6, 2, 0x84),   // speed (m/s * 1000)
                (7, 2, 0x84),   // power (watts)
            ],
        );
    }

    let mut cumulative_distance_m = 0.0_f64;
    let mut synthetic_distance_m: Option<f64> = None;
    let mut max_power: Option<u16> = None;
    let mut prev_elevation_m: Option<f64> = None;
    let mut total_ascent_m = 0.0_f64;
    let mut total_descent_m = 0.0_f64;

    for s in samples {
        let ts = start_fit_ts.saturating_add(s.t_s);
        let hr = s.hr_bpm.filter(|h| *h > 0).unwrap_or(0xFF);
        let cad = s.cadence_rpm.unwrap_or(0xFF);
        let speed_ms = s.speed_kph.map(|k| (k / 3.6).max(0.0));
        let dist_m = if s.synthetic_route {
            if let Some(distance_m) = s.distance_m {
                synthetic_distance_m = Some(distance_m.max(0.0));
                distance_m.max(0.0)
            } else {
                cumulative_distance_m
            }
        } else {
            if let Some(ms) = speed_ms {
                cumulative_distance_m += ms;
            }
            cumulative_distance_m
        };
        if let Some(elev) = s.elevation_m {
            if let Some(prev) = prev_elevation_m {
                let delta = elev - prev;
                if delta > 0.0 {
                    total_ascent_m += delta;
                } else if delta < 0.0 {
                    total_descent_m += -delta;
                }
            }
            prev_elevation_m = Some(elev);
        }
        let dist_cm = (dist_m * 100.0).round().clamp(0.0, u32::MAX as f64) as u32;
        let speed_mms = speed_ms.map_or(0xFFFF, |ms| (ms * 1000.0).round().min(65534.0) as u16);
        let power = s.watts.unwrap_or(0xFFFF);
        if let Some(w) = s.watts {
            max_power = Some(max_power.map_or(w, |m| m.max(w)));
        }

        data.push(0x02);
        if has_synthetic_route {
            let lat_semicircles = s
                .lat_deg
                .map(|lat| {
                    ((lat / 180.0) * 2_147_483_648.0)
                        .round()
                        .clamp(i32::MIN as f64, (i32::MAX - 1) as f64) as i32
                })
                .unwrap_or(i32::MAX);
            let lon_semicircles = s
                .lon_deg
                .map(|lon| {
                    ((lon / 180.0) * 2_147_483_648.0)
                        .round()
                        .clamp(i32::MIN as f64, (i32::MAX - 1) as f64) as i32
                })
                .unwrap_or(i32::MAX);
            let altitude_encoded = s
                .elevation_m
                .map(|elevation| ((elevation + 500.0) * 5.0).round().clamp(0.0, 65534.0) as u16)
                .unwrap_or(0xFFFF);
            data.extend_from_slice(&lat_semicircles.to_le_bytes());
            data.extend_from_slice(&lon_semicircles.to_le_bytes());
            data.extend_from_slice(&altitude_encoded.to_le_bytes());
        }
        data.extend_from_slice(&ts.to_le_bytes());
        data.push(hr);
        data.push(cad);
        data.extend_from_slice(&dist_cm.to_le_bytes());
        data.extend_from_slice(&speed_mms.to_le_bytes());
        data.extend_from_slice(&power.to_le_bytes());
    }

    // Timer stop event
    data.push(0x01);
    data.extend_from_slice(&end_fit_ts.to_le_bytes());
    data.push(0);
    data.push(4); // stop_all
    data.push(0);

    let total_elapsed_ms = metrics.elapsed_s.saturating_mul(1000);
    let total_timer_ms = metrics.duration_s.saturating_mul(1000);
    let total_dist_m = synthetic_distance_m.unwrap_or(cumulative_distance_m);
    let total_dist_cm = (total_dist_m * 100.0).round().clamp(0.0, u32::MAX as f64) as u32;
    let avg_hr_u8 = metrics.avg_hr.map_or(0xFF, |h| h.min(254) as u8);
    let max_hr_u8 = metrics.max_hr.map_or(0xFF, |h| h.min(254) as u8);
    let avg_cad_u8 = metrics.avg_cadence.map_or(0xFF, |c| c.min(254) as u8);
    let avg_pwr_u16 = metrics.avg_power.unwrap_or(0xFFFF);
    let max_pwr_u16 = max_power.unwrap_or(0xFFFF);
    let np_u16 = metrics.np_watts.unwrap_or(0xFFFF);
    let tss_tenths = (metrics.tss * 10.0).round().clamp(0.0, 65534.0) as u16;
    let if_thousandths = metrics
        .intensity_factor
        .map_or(0xFFFF, |v| (v * 1000.0).round().clamp(0.0, 65534.0) as u16);
    let total_work_j = (metrics.work_kj * 1000.0).round().max(0.0) as u32;
    let total_ascent_u16 = if has_synthetic_route {
        total_ascent_m.round().clamp(0.0, 65534.0) as u16
    } else {
        0xFFFF
    };
    let total_descent_u16 = if has_synthetic_route {
        total_descent_m.round().clamp(0.0, 65534.0) as u16
    } else {
        0xFFFF
    };

    // 4. lap (global 19, local 3)
    push_def(
        &mut data,
        3,
        19,
        &[
            (253, 4, 0x86),
            (2, 4, 0x86),
            (7, 4, 0x86),
            (8, 4, 0x86),
            (9, 4, 0x86),
            (15, 1, 0x02),
            (16, 1, 0x02),
            (17, 1, 0x02),
            (19, 2, 0x84),
            (20, 2, 0x84),
            (21, 2, 0x84), // total_ascent (m)
            (22, 2, 0x84), // total_descent (m)
            (25, 1, 0x00),
            (39, 1, 0x00),
        ],
    );
    data.push(0x03);
    data.extend_from_slice(&end_fit_ts.to_le_bytes());
    data.extend_from_slice(&start_fit_ts.to_le_bytes());
    data.extend_from_slice(&total_elapsed_ms.to_le_bytes());
    data.extend_from_slice(&total_timer_ms.to_le_bytes());
    data.extend_from_slice(&total_dist_cm.to_le_bytes());
    data.push(avg_hr_u8);
    data.push(max_hr_u8);
    data.push(avg_cad_u8);
    data.extend_from_slice(&avg_pwr_u16.to_le_bytes());
    data.extend_from_slice(&max_pwr_u16.to_le_bytes());
    data.extend_from_slice(&total_ascent_u16.to_le_bytes());
    data.extend_from_slice(&total_descent_u16.to_le_bytes());
    data.push(2); // cycling
    data.push(sub_sport);

    // 5. session (global 18, local 4)
    push_def(
        &mut data,
        4,
        18,
        &[
            (253, 4, 0x86),
            (2, 4, 0x86),
            (5, 1, 0x00),
            (6, 1, 0x00),
            (7, 4, 0x86),
            (8, 4, 0x86),
            (9, 4, 0x86),
            (16, 1, 0x02),
            (17, 1, 0x02),
            (18, 1, 0x02),
            (20, 2, 0x84),
            (21, 2, 0x84),
            (22, 2, 0x84), // total_ascent (m)
            (23, 2, 0x84), // total_descent (m)
            (26, 2, 0x84),
            (34, 2, 0x84),
            (35, 2, 0x84),
            (36, 2, 0x84),
            (48, 4, 0x86),
        ],
    );
    data.push(0x04);
    data.extend_from_slice(&end_fit_ts.to_le_bytes());
    data.extend_from_slice(&start_fit_ts.to_le_bytes());
    data.push(2);
    data.push(sub_sport);
    data.extend_from_slice(&total_elapsed_ms.to_le_bytes());
    data.extend_from_slice(&total_timer_ms.to_le_bytes());
    data.extend_from_slice(&total_dist_cm.to_le_bytes());
    data.push(avg_hr_u8);
    data.push(max_hr_u8);
    data.push(avg_cad_u8);
    data.extend_from_slice(&avg_pwr_u16.to_le_bytes());
    data.extend_from_slice(&max_pwr_u16.to_le_bytes());
    data.extend_from_slice(&total_ascent_u16.to_le_bytes());
    data.extend_from_slice(&total_descent_u16.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&np_u16.to_le_bytes());
    data.extend_from_slice(&tss_tenths.to_le_bytes());
    data.extend_from_slice(&if_thousandths.to_le_bytes());
    data.extend_from_slice(&total_work_j.to_le_bytes());

    // 6. activity (global 34, local 5)
    push_def(
        &mut data,
        5,
        34,
        &[
            (253, 4, 0x86),
            (0, 4, 0x86),
            (1, 2, 0x84),
            (2, 1, 0x00),
            (3, 1, 0x00),
            (4, 1, 0x00),
        ],
    );
    data.push(0x05);
    data.extend_from_slice(&end_fit_ts.to_le_bytes());
    data.extend_from_slice(&total_timer_ms.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.push(0); // manual
    data.push(26); // activity
    data.push(1); // stop

    // Assemble 14-byte FIT v2.0 header + data + trailing 2-byte CRC
    let data_size = data.len() as u32;
    let mut header = Vec::with_capacity(14);
    header.push(14);
    header.push(0x20); // protocol v2.0
    header.extend_from_slice(&21126u16.to_le_bytes());
    header.extend_from_slice(&data_size.to_le_bytes());
    header.extend_from_slice(b".FIT");
    let header_crc = fit_crc16(&header);
    header.extend_from_slice(&header_crc.to_le_bytes());

    let mut out = Vec::with_capacity(14 + data.len() + 2);
    out.extend_from_slice(&header);
    out.extend_from_slice(&data);
    let file_crc = fit_crc16(&out);
    out.extend_from_slice(&file_crc.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physiology::compute_ride_metrics;

    #[test]
    fn round_trip_fit_file_decodes_cleanly_with_fitparser() -> anyhow::Result<()> {
        let samples: Vec<TelemetrySample> = (0..60)
            .map(|t| TelemetrySample {
                t_s: t,
                watts: Some(220 + ((t % 5) as u16) * 3),
                hr_bpm: Some(145 + (t % 4) as u8),
                cadence_rpm: Some(90),
                speed_kph: Some(32.4),
                target_watts: Some(225),
                step_index: Some(0),
                erg_bias_pct: Some(100),
                synthetic_route: false,
                lat_deg: None,
                lon_deg: None,
                elevation_m: None,
                distance_m: None,
                grade_pct: None,
            })
            .collect();

        let metrics = compute_ride_metrics(&samples, 260, Some(172), Some(190), Some(72.0), None);
        let started = Utc::now();
        let fit_bytes = encode_cycling_fit(started, &samples, &metrics);

        let parsed = fitparser::from_bytes(&fit_bytes)?;
        let record_count = parsed
            .iter()
            .filter(|m| m.kind() == fitparser::profile::MesgNum::Record)
            .count();
        let has_session = parsed
            .iter()
            .any(|m| m.kind() == fitparser::profile::MesgNum::Session);
        let has_activity = parsed
            .iter()
            .any(|m| m.kind() == fitparser::profile::MesgNum::Activity);

        assert_eq!(record_count, 60);
        assert!(has_session);
        assert!(has_activity);

        let first_record = parsed
            .iter()
            .find(|m| m.kind() == fitparser::profile::MesgNum::Record)
            .ok_or_else(|| anyhow::anyhow!("missing record"))?;
        let field_names: Vec<&str> = first_record.fields().iter().map(|f| f.name()).collect();
        assert!(!field_names.contains(&"position_lat"));
        assert!(!field_names.contains(&"position_long"));
        Ok(())
    }

    #[test]
    fn encodes_synthetic_route_position_elevation_distance_and_speed() -> anyhow::Result<()> {
        let samples = vec![
            TelemetrySample {
                t_s: 0,
                watts: Some(200),
                hr_bpm: Some(145),
                cadence_rpm: Some(90),
                speed_kph: Some(26.0),
                target_watts: Some(200),
                step_index: Some(0),
                erg_bias_pct: Some(100),
                synthetic_route: true,
                lat_deg: Some(0.01),
                lon_deg: Some(0.01),
                elevation_m: Some(100.0),
                distance_m: Some(0.0),
                grade_pct: Some(3.6),
            },
            TelemetrySample {
                t_s: 1,
                watts: Some(200),
                hr_bpm: Some(145),
                cadence_rpm: Some(90),
                speed_kph: Some(26.0),
                target_watts: Some(200),
                step_index: Some(0),
                erg_bias_pct: Some(100),
                synthetic_route: true,
                lat_deg: Some(0.011),
                lon_deg: Some(0.01),
                elevation_m: Some(104.0),
                distance_m: Some(125.0),
                grade_pct: Some(3.6),
            },
            TelemetrySample {
                t_s: 2,
                watts: Some(200),
                hr_bpm: Some(145),
                cadence_rpm: Some(90),
                speed_kph: Some(26.0),
                target_watts: Some(200),
                step_index: Some(0),
                erg_bias_pct: Some(100),
                synthetic_route: true,
                lat_deg: Some(0.012),
                lon_deg: Some(0.01),
                elevation_m: Some(102.0),
                distance_m: Some(250.0),
                grade_pct: Some(-2.0),
            },
        ];

        let metrics = compute_ride_metrics(&samples, 260, Some(172), Some(190), Some(72.0), None);
        let fit_bytes = encode_cycling_fit(Utc::now(), &samples, &metrics);
        let parsed = fitparser::from_bytes(&fit_bytes)?;

        let file_id = parsed
            .iter()
            .find(|message| message.kind() == fitparser::profile::MesgNum::FileId)
            .ok_or_else(|| anyhow::anyhow!("FIT file_id is present"))?;
        let product = file_id
            .fields()
            .iter()
            .find(|field| field.name() == "product")
            .ok_or_else(|| anyhow::anyhow!("FIT file_id product is present"))?;
        assert_eq!(product.value().to_string(), "65001");

        let record = parsed
            .iter()
            .find(|message| message.kind() == fitparser::profile::MesgNum::Record)
            .ok_or_else(|| anyhow::anyhow!("synthetic route record is present"))?;
        let field_names: Vec<&str> = record.fields().iter().map(|field| field.name()).collect();
        assert!(field_names.contains(&"position_lat"));
        assert!(field_names.contains(&"position_long"));
        assert!(field_names.contains(&"enhanced_altitude"));
        assert!(field_names.contains(&"distance"));
        assert!(field_names.contains(&"enhanced_speed"));

        let session = parsed
            .iter()
            .find(|message| message.kind() == fitparser::profile::MesgNum::Session)
            .ok_or_else(|| anyhow::anyhow!("session message is present"))?;
        let sub_sport = session
            .fields()
            .iter()
            .find(|field| field.name() == "sub_sport")
            .ok_or_else(|| anyhow::anyhow!("session sub_sport is present"))?;
        assert_eq!(sub_sport.value().to_string(), "virtual_activity");
        let ascent = session
            .fields()
            .iter()
            .find(|field| field.name() == "total_ascent")
            .ok_or_else(|| anyhow::anyhow!("session total_ascent is present"))?;
        assert_eq!(ascent.value().to_string(), "4");
        let descent = session
            .fields()
            .iter()
            .find(|field| field.name() == "total_descent")
            .ok_or_else(|| anyhow::anyhow!("session total_descent is present"))?;
        assert_eq!(descent.value().to_string(), "2");
        Ok(())
    }
}
