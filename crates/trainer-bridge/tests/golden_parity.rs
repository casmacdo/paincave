use std::path::Path;

use serde::Deserialize;

use paincave_bridge::physiology::{compute_ride_metrics, estimate_critical_power};
use paincave_bridge::protocol::{
    FlattenedStep, HrZoneSeconds, IntervalExecution, MmpPoint, PowerZoneSeconds, QualityFlags,
    TelemetrySample,
};

#[derive(Debug, Deserialize)]
struct ThresholdsFixture {
    ftp_watts: u16,
    lthr_bpm: Option<u16>,
    hrmax_bpm: Option<u16>,
    weight_kg: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ExpectedCp {
    cp_watts: u16,
    w_prime_j: u32,
    r_squared: f64,
    eftp_watts: u16,
}

#[derive(Debug, Deserialize)]
struct ExpectedMetrics {
    duration_s: u32,
    elapsed_s: u32,
    work_kj: f64,
    avg_power: Option<u16>,
    np_watts: Option<u16>,
    intensity_factor: Option<f64>,
    tss: f64,
    variability_index: Option<f64>,
    avg_hr: Option<u16>,
    max_hr: Option<u16>,
    efficiency_factor: Option<f64>,
    pw_hr_decoupling: Option<f64>,
    hrr_60s: Option<i32>,
    time_gt_90_hrmax_s: u32,
    avg_cadence: Option<u16>,
    compliance_pct: Option<f64>,
    power_zones: PowerZoneSeconds,
    hr_zones: HrZoneSeconds,
    quality_flags: QualityFlags,
    intervals: Vec<IntervalExecution>,
    peaks: Vec<MmpPoint>,
    cp_estimate: Option<ExpectedCp>,
}

#[derive(Debug, Deserialize)]
struct GoldenFixture {
    thresholds: ThresholdsFixture,
    planned_steps: Vec<FlattenedStep>,
    samples: Vec<TelemetrySample>,
    expected: ExpectedMetrics,
}

#[test]
fn rust_physiology_matches_typescript_golden_ride_fixture() -> anyhow::Result<()> {
    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/fixtures/golden-ride.json");
    let raw = std::fs::read_to_string(&fixture_path)?;
    let fixture: GoldenFixture = serde_json::from_str(&raw)?;

    let actual = compute_ride_metrics(
        &fixture.samples,
        fixture.thresholds.ftp_watts,
        fixture.thresholds.lthr_bpm,
        fixture.thresholds.hrmax_bpm,
        fixture.thresholds.weight_kg,
        Some(&fixture.planned_steps),
    );
    let exp = &fixture.expected;

    assert_eq!(actual.duration_s, exp.duration_s);
    assert_eq!(actual.elapsed_s, exp.elapsed_s);
    assert!((actual.work_kj - exp.work_kj).abs() < 0.05);
    assert_eq!(actual.avg_power, exp.avg_power);
    assert_eq!(actual.np_watts, exp.np_watts);
    assert_eq!(actual.intensity_factor, exp.intensity_factor);
    assert_eq!(actual.tss, exp.tss);
    assert_eq!(actual.variability_index, exp.variability_index);
    assert_eq!(actual.avg_hr, exp.avg_hr);
    assert_eq!(actual.max_hr, exp.max_hr);
    assert_eq!(actual.efficiency_factor, exp.efficiency_factor);
    assert_eq!(actual.pw_hr_decoupling, exp.pw_hr_decoupling);
    assert_eq!(actual.hrr_60s, exp.hrr_60s);
    assert_eq!(actual.time_gt_90_hrmax_s, exp.time_gt_90_hrmax_s);
    assert_eq!(actual.avg_cadence, exp.avg_cadence);
    assert_eq!(actual.compliance_pct, exp.compliance_pct);
    assert_eq!(actual.power_zones, exp.power_zones);
    assert_eq!(actual.hr_zones, exp.hr_zones);
    assert_eq!(actual.quality_flags, exp.quality_flags);
    assert_eq!(actual.intervals, exp.intervals);
    assert_eq!(actual.peaks, exp.peaks);

    let cp = estimate_critical_power(&actual.peaks);
    match (cp, &exp.cp_estimate) {
        (Some(a), Some(e)) => {
            assert_eq!(a.cp_watts, e.cp_watts);
            assert_eq!(a.w_prime_j, e.w_prime_j);
            assert!((a.r_squared - e.r_squared).abs() < 0.001);
            assert_eq!(a.eftp_watts, e.eftp_watts);
        }
        (a, e) => anyhow::bail!("CP estimate mismatch: actual={a:?}, expected={e:?}"),
    }

    Ok(())
}
