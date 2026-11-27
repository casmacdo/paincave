use serde::{Deserialize, Serialize};

const BIKE_MASS_KG: f64 = 8.0;
const DEFAULT_RIDER_MASS_KG: f64 = 75.0;
const CDA_M2: f64 = 0.32;
const CRR: f64 = 0.004;
const AIR_DENSITY_KG_M3: f64 = 1.225;
const GRAVITY_M_S2: f64 = 9.80665;
const DRIVETRAIN_EFFICIENCY: f64 = 0.97;
const MAX_SPEED_KPH: f64 = 75.0;
const MIN_GRADE_PCT: f64 = -15.0;
const MAX_GRADE_PCT: f64 = 22.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RoutePoint {
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub elevation_m: f64,
}

fn default_loop_route() -> bool {
    true
}

fn default_trainer_difficulty_pct() -> u8 {
    100
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoutePayload {
    pub name: String,
    pub points: Vec<RoutePoint>,
    #[serde(default = "default_loop_route")]
    pub loop_route: bool,
    #[serde(default)]
    pub sim_mode: bool,
    #[serde(default = "default_trainer_difficulty_pct")]
    pub trainer_difficulty_pct: u8,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SyntheticRoutePosition {
    pub synthetic_route: bool,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub elevation_m: f64,
    pub distance_m: f64,
    pub grade_pct: f64,
    pub speed_kph: f64,
}

#[derive(Debug, Clone)]
struct RouteSegment {
    start: RoutePoint,
    end: RoutePoint,
    start_distance_m: f64,
    end_distance_m: f64,
    grade_pct: f64,
}

/// Virtual or GPX-imported cycling route with steady-state cycling physics
/// (gravity, rolling resistance, aerodynamic drag, and coasting inertia).
#[derive(Debug, Clone)]
pub struct SyntheticRoute {
    points: Vec<RoutePoint>,
    segments: Vec<RouteSegment>,
    total_distance_m: f64,
    cumulative_distance_m: f64,
    current_speed_ms: f64,
    loop_route: bool,
}

impl Default for SyntheticRoute {
    fn default() -> Self {
        // Slightly offset from exact (0.0, 0.0) so GPS parsers do not discard coordinates
        // as an uninitialized Null Island fix, while staying in neutral open ocean away
        // from any real cycling segments or personal locations.
        let points = vec![
            RoutePoint {
                lat_deg: 0.01,
                lon_deg: 0.01,
                elevation_m: 100.0,
            },
            RoutePoint {
                lat_deg: 0.0145,
                lon_deg: 0.01,
                elevation_m: 118.0,
            },
            RoutePoint {
                lat_deg: 0.0145,
                lon_deg: 0.0145,
                elevation_m: 128.0,
            },
            RoutePoint {
                lat_deg: 0.01,
                lon_deg: 0.0145,
                elevation_m: 112.0,
            },
            RoutePoint {
                lat_deg: 0.01,
                lon_deg: 0.01,
                elevation_m: 100.0,
            },
        ];

        Self::build_segments(points, true)
    }
}

impl SyntheticRoute {
    /// Constructs a route from user-supplied GPS/elevation points, applying duplicate-point
    /// filtering and 3-point weighted elevation smoothing for clean SIM-mode grades.
    pub fn from_points(
        raw_points: Vec<RoutePoint>,
        loop_route: bool,
    ) -> Result<Self, &'static str> {
        if raw_points.len() < 2 {
            return Err("Route must contain at least 2 points");
        }

        let mut filtered: Vec<RoutePoint> = Vec::with_capacity(raw_points.len());
        for pt in raw_points {
            if !pt.lat_deg.is_finite()
                || !pt.lon_deg.is_finite()
                || !pt.elevation_m.is_finite()
                || !(-90.0..=90.0).contains(&pt.lat_deg)
                || !(-180.0..=180.0).contains(&pt.lon_deg)
                || !(-500.0..=9000.0).contains(&pt.elevation_m)
            {
                return Err("Route contains invalid coordinates or elevation");
            }
            if let Some(&prev) = filtered.last()
                && haversine_m(prev, pt) < 0.5
            {
                continue;
            }
            filtered.push(pt);
        }

        if filtered.len() < 2 {
            return Err("Route must span a non-zero horizontal distance");
        }

        let smoothed = smooth_elevations(&filtered);
        let route = Self::build_segments(smoothed, loop_route);
        if route.total_distance_m <= 0.0 {
            return Err("Route must have positive total distance");
        }
        Ok(route)
    }

    fn build_segments(points: Vec<RoutePoint>, loop_route: bool) -> Self {
        let mut segments = Vec::with_capacity(points.len().saturating_sub(1));
        let mut cumulative = 0.0;
        for pair in points.windows(2) {
            let length = haversine_m(pair[0], pair[1]);
            if length < 0.5 {
                continue;
            }
            let raw_grade = ((pair[1].elevation_m - pair[0].elevation_m) / length) * 100.0;
            let grade_pct = raw_grade.clamp(MIN_GRADE_PCT, MAX_GRADE_PCT);
            segments.push(RouteSegment {
                start: pair[0],
                end: pair[1],
                start_distance_m: cumulative,
                end_distance_m: cumulative + length,
                grade_pct,
            });
            cumulative += length;
        }

        Self {
            points,
            segments,
            total_distance_m: cumulative,
            cumulative_distance_m: 0.0,
            current_speed_ms: 0.0,
            loop_route,
        }
    }

    pub fn reset(&mut self) {
        self.cumulative_distance_m = 0.0;
        self.current_speed_ms = 0.0;
    }

    pub fn total_distance_m(&self) -> f64 {
        self.total_distance_m
    }

    pub fn distance_m(&self) -> f64 {
        self.cumulative_distance_m
    }

    /// Solves steady-state road cycling speed (kph) from measured power, road grade,
    /// and rider weight using gravity, rolling resistance, and aerodynamic drag.
    /// Returns 0.0 kph when no pedaling power is measured.
    pub fn estimate_speed_kph_with_weight(
        measured_watts: Option<u16>,
        grade_pct: f64,
        rider_weight_kg: f64,
    ) -> f64 {
        let Some(watts) = measured_watts.filter(|&w| w > 0) else {
            return 0.0;
        };
        let total_mass_kg = rider_weight_kg.clamp(35.0, 200.0) + BIKE_MASS_KG;
        let wheel_power_w = f64::from(watts) * DRIVETRAIN_EFFICIENCY;
        let grade = (grade_pct / 100.0).clamp(-0.20, 0.25);
        let theta = grade.atan();
        let linear_force_n = total_mass_kg * GRAVITY_M_S2 * (theta.sin() + CRR * theta.cos());
        let aero_k = 0.5 * AIR_DENSITY_KG_M3 * CDA_M2;

        // P(v) = v * (linear_force_n + aero_k * v^2) is strictly increasing for v >= v_min
        let mut lo = if linear_force_n < 0.0 {
            (-linear_force_n / aero_k).sqrt()
        } else {
            0.0
        };
        let mut hi = (MAX_SPEED_KPH / 3.6).max(lo + 1.0);

        for _ in 0..40 {
            let mid = 0.5 * (lo + hi);
            let p_mid = mid * (linear_force_n + aero_k * mid * mid);
            if p_mid < wheel_power_w {
                lo = mid;
            } else {
                hi = mid;
            }
        }

        (0.5 * (lo + hi) * 3.6).clamp(1.0, MAX_SPEED_KPH)
    }

    /// Estimates route speed deterministically using default 75 kg rider mass.
    pub fn estimate_speed_kph(measured_watts: Option<u16>, grade_pct: f64) -> f64 {
        Self::estimate_speed_kph_with_weight(measured_watts, grade_pct, DEFAULT_RIDER_MASS_KG)
    }

    pub fn position_at(&self, cumulative_distance_m: f64) -> SyntheticRoutePosition {
        let mapped_distance = if self.total_distance_m > 0.0 {
            if self.loop_route {
                cumulative_distance_m.rem_euclid(self.total_distance_m)
            } else {
                cumulative_distance_m.clamp(0.0, self.total_distance_m)
            }
        } else {
            0.0
        };

        let segment = self
            .segments
            .iter()
            .find(|segment| mapped_distance < segment.end_distance_m)
            .or_else(|| self.segments.last());
        let Some(segment) = segment else {
            return SyntheticRoutePosition {
                synthetic_route: true,
                lat_deg: 0.01,
                lon_deg: 0.01,
                elevation_m: 100.0,
                distance_m: cumulative_distance_m,
                grade_pct: 0.0,
                speed_kph: 0.0,
            };
        };

        let segment_length = (segment.end_distance_m - segment.start_distance_m).max(1.0);
        let fraction =
            ((mapped_distance - segment.start_distance_m) / segment_length).clamp(0.0, 1.0);

        let lat_deg =
            segment.start.lat_deg + (segment.end.lat_deg - segment.start.lat_deg) * fraction;
        let lon_deg =
            segment.start.lon_deg + (segment.end.lon_deg - segment.start.lon_deg) * fraction;
        let elevation_m = segment.start.elevation_m
            + (segment.end.elevation_m - segment.start.elevation_m) * fraction;

        SyntheticRoutePosition {
            synthetic_route: true,
            lat_deg,
            lon_deg,
            elevation_m,
            distance_m: cumulative_distance_m,
            grade_pct: segment.grade_pct,
            speed_kph: self.current_speed_ms * 3.6,
        }
    }

    /// Advances exactly one workout second of route distance with physics and rider weight.
    pub fn advance_one_second_with_weight(
        &mut self,
        measured_watts: Option<u16>,
        rider_weight_kg: f64,
    ) -> SyntheticRoutePosition {
        let grade_pct = self.position_at(self.cumulative_distance_m).grade_pct;
        let total_mass_kg = rider_weight_kg.clamp(35.0, 200.0) + BIKE_MASS_KG;
        let max_speed_ms = MAX_SPEED_KPH / 3.6;

        let next_speed_ms = if let Some(watts) = measured_watts.filter(|&w| w > 0) {
            let target_ms =
                Self::estimate_speed_kph_with_weight(Some(watts), grade_pct, rider_weight_kg) / 3.6;
            // Smooth first-order inertia (~3s response) when already rolling; jump cleanly on start
            if self.current_speed_ms < 0.1 {
                target_ms
            } else {
                (self.current_speed_ms + (target_ms - self.current_speed_ms) * 0.45)
                    .clamp(0.0, max_speed_ms)
            }
        } else if self.current_speed_ms <= 0.3 {
            0.0
        } else {
            // Realistic coasting deceleration under gravity + rolling resistance + air drag
            let grade = (grade_pct / 100.0).clamp(-0.20, 0.25);
            let theta = grade.atan();
            let aero_k = 0.5 * AIR_DENSITY_KG_M3 * CDA_M2;
            let resist_force_n = total_mass_kg * GRAVITY_M_S2 * (theta.sin() + CRR * theta.cos())
                + aero_k * self.current_speed_ms * self.current_speed_ms;
            let accel_ms2 = -resist_force_n / total_mass_kg;
            let coasted = (self.current_speed_ms + accel_ms2).clamp(0.0, max_speed_ms);
            if coasted < 0.3 { 0.0 } else { coasted }
        };

        self.current_speed_ms = next_speed_ms;
        if self.loop_route || self.cumulative_distance_m < self.total_distance_m {
            self.cumulative_distance_m += next_speed_ms;
            if !self.loop_route && self.cumulative_distance_m > self.total_distance_m {
                self.cumulative_distance_m = self.total_distance_m;
            }
        }

        let mut position = self.position_at(self.cumulative_distance_m);
        position.speed_kph = next_speed_ms * 3.6;
        position
    }

    /// Advances exactly one workout second using default 75 kg rider mass.
    pub fn advance_one_second(&mut self, measured_watts: Option<u16>) -> SyntheticRoutePosition {
        self.advance_one_second_with_weight(measured_watts, DEFAULT_RIDER_MASS_KG)
    }

    #[allow(dead_code)]
    pub fn points(&self) -> &[RoutePoint] {
        &self.points
    }
}

fn smooth_elevations(points: &[RoutePoint]) -> Vec<RoutePoint> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut out = points.to_vec();
    for i in 1..(points.len() - 1) {
        out[i].elevation_m = 0.25 * points[i - 1].elevation_m
            + 0.5 * points[i].elevation_m
            + 0.25 * points[i + 1].elevation_m;
    }
    out
}

fn haversine_m(start: RoutePoint, end: RoutePoint) -> f64 {
    const EARTH_RADIUS_M: f64 = 6_371_000.0;
    let lat1 = start.lat_deg.to_radians();
    let lat2 = end.lat_deg.to_radians();
    let delta_lat = (end.lat_deg - start.lat_deg).to_radians();
    let delta_lon = (end.lon_deg - start.lon_deg).to_radians();
    let a =
        (delta_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (delta_lon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * a.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_has_deterministic_cumulative_loop_distance() {
        let route = SyntheticRoute::default();
        assert!(route.total_distance_m() > 1_900.0);
        assert!(route.total_distance_m() < 2_300.0);
    }

    #[test]
    fn route_interpolates_position_elevation_and_grade() {
        let route = SyntheticRoute::default();
        let start = route.position_at(0.0);
        assert_eq!(start.lat_deg, 0.01);
        assert_eq!(start.lon_deg, 0.01);
        assert_eq!(start.elevation_m, 100.0);

        let first_segment_end = route.segments[0].end_distance_m;
        let end = route.position_at(first_segment_end);
        assert!((end.lat_deg - 0.0145).abs() < 1e-12);
        assert_eq!(end.lon_deg, 0.01);
        assert!((end.elevation_m - 118.0).abs() < 1e-9);

        let mid = route.position_at(first_segment_end / 2.0);
        assert!((mid.elevation_m - 109.0).abs() < 1e-9);
        assert!(mid.grade_pct > 3.0);
    }

    #[test]
    fn cycling_physics_produces_realistic_flat_climb_descent_and_coasting_speeds() {
        assert_eq!(SyntheticRoute::estimate_speed_kph(None, 0.0), 0.0);
        assert_eq!(SyntheticRoute::estimate_speed_kph(Some(0), 5.0), 0.0);

        // 200W at 75kg on flat road should be ~33-35 kph
        let flat = SyntheticRoute::estimate_speed_kph_with_weight(Some(200), 0.0, 75.0);
        assert!((32.0..=36.0).contains(&flat), "flat speed was {flat}");

        // 200W at 75kg on an 8% climb should be ~9-12 kph
        let climb = SyntheticRoute::estimate_speed_kph_with_weight(Some(200), 8.0, 75.0);
        assert!((8.5..=12.0).contains(&climb), "climb speed was {climb}");

        // Lighter rider climbs faster at identical power
        let light_climb = SyntheticRoute::estimate_speed_kph_with_weight(Some(200), 8.0, 60.0);
        assert!(light_climb > climb);

        // Descent is faster than flat
        let descent = SyntheticRoute::estimate_speed_kph_with_weight(Some(200), -5.0, 75.0);
        assert!(descent > flat + 12.0);

        // From rest, 0W stays stopped
        let mut route = SyntheticRoute::default();
        let stopped = route.advance_one_second(Some(0));
        assert_eq!(stopped.distance_m, 0.0);
        assert_eq!(stopped.speed_kph, 0.0);

        // Pedal up to speed, then coast -> speed decelerates smoothly on uphill/flat
        let rolling = route.advance_one_second(Some(250));
        assert!(rolling.speed_kph > 12.0);
        let coast1 = route.advance_one_second(Some(0));
        assert!(coast1.speed_kph < rolling.speed_kph);
        for _ in 0..40 {
            route.advance_one_second(Some(0));
        }
        assert_eq!(route.advance_one_second(Some(0)).speed_kph, 0.0);
    }

    #[test]
    fn custom_points_smooth_noisy_elevation_and_support_non_looping_finish() -> anyhow::Result<()> {
        let raw = vec![
            RoutePoint {
                lat_deg: 45.0,
                lon_deg: 6.0,
                elevation_m: 1000.0,
            },
            RoutePoint {
                lat_deg: 45.001,
                lon_deg: 6.0,
                elevation_m: 1020.0, // noisy spike
            },
            RoutePoint {
                lat_deg: 45.002,
                lon_deg: 6.0,
                elevation_m: 1012.0,
            },
        ];
        let route =
            SyntheticRoute::from_points(raw, false).map_err(|err| anyhow::anyhow!("{err}"))?;
        // Smoothed middle point: 0.25*1000 + 0.5*1020 + 0.25*1012 = 1013.0
        assert!((route.points()[1].elevation_m - 1013.0).abs() < 1e-6);

        let beyond_end = route.position_at(route.total_distance_m() + 500.0);
        assert!((beyond_end.lat_deg - 45.002).abs() < 1e-9);
        Ok(())
    }
}
