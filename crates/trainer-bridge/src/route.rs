/// The fictional route is intentionally not tied to an athlete or any real training location.
/// Its coordinates are a neutral synthetic origin used only to produce route-shaped FIT records.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RoutePoint {
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub elevation_m: f64,
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
}

/// Deterministic fictional loop for indoor workouts.
/// It has no real-world navigation or athlete-location meaning.
#[derive(Debug, Clone)]
pub struct SyntheticRoute {
    points: Vec<RoutePoint>,
    segments: Vec<RouteSegment>,
    total_distance_m: f64,
    cumulative_distance_m: f64,
}

impl Default for SyntheticRoute {
    fn default() -> Self {
        let points = vec![
            RoutePoint {
                lat_deg: 0.0,
                lon_deg: 0.0,
                elevation_m: 100.0,
            },
            RoutePoint {
                lat_deg: 0.0045,
                lon_deg: 0.0,
                elevation_m: 118.0,
            },
            RoutePoint {
                lat_deg: 0.0045,
                lon_deg: 0.0045,
                elevation_m: 128.0,
            },
            RoutePoint {
                lat_deg: 0.0,
                lon_deg: 0.0045,
                elevation_m: 112.0,
            },
            RoutePoint {
                lat_deg: 0.0,
                lon_deg: 0.0,
                elevation_m: 100.0,
            },
        ];

        let mut segments = Vec::with_capacity(points.len() - 1);
        let mut cumulative = 0.0;
        for pair in points.windows(2) {
            let length = haversine_m(pair[0], pair[1]);
            segments.push(RouteSegment {
                start: pair[0],
                end: pair[1],
                start_distance_m: cumulative,
                end_distance_m: cumulative + length,
            });
            cumulative += length;
        }

        Self {
            points,
            segments,
            total_distance_m: cumulative,
            cumulative_distance_m: 0.0,
        }
    }
}

impl SyntheticRoute {
    pub fn reset(&mut self) {
        self.cumulative_distance_m = 0.0;
    }

    pub fn total_distance_m(&self) -> f64 {
        self.total_distance_m
    }

    pub fn distance_m(&self) -> f64 {
        self.cumulative_distance_m
    }

    /// Estimates route speed deterministically from power and route grade.
    pub fn estimate_speed_kph(effective_watts: Option<u16>, grade_pct: f64) -> f64 {
        let watts = f64::from(effective_watts.unwrap_or(0));
        (10.0 + watts / 12.0 - grade_pct * 1.1).clamp(5.0, 55.0)
    }

    pub fn position_at(&self, cumulative_distance_m: f64) -> SyntheticRoutePosition {
        let loop_distance = if self.total_distance_m > 0.0 {
            cumulative_distance_m.rem_euclid(self.total_distance_m)
        } else {
            0.0
        };

        let segment = self
            .segments
            .iter()
            .find(|segment| loop_distance < segment.end_distance_m)
            .or_else(|| self.segments.last());
        let Some(segment) = segment else {
            return SyntheticRoutePosition {
                synthetic_route: true,
                lat_deg: 0.0,
                lon_deg: 0.0,
                elevation_m: 100.0,
                distance_m: cumulative_distance_m,
                grade_pct: 0.0,
                speed_kph: 0.0,
            };
        };

        let segment_length = (segment.end_distance_m - segment.start_distance_m).max(1.0);
        let fraction =
            ((loop_distance - segment.start_distance_m) / segment_length).clamp(0.0, 1.0);

        let lat_deg =
            segment.start.lat_deg + (segment.end.lat_deg - segment.start.lat_deg) * fraction;
        let lon_deg =
            segment.start.lon_deg + (segment.end.lon_deg - segment.start.lon_deg) * fraction;
        let elevation_m = segment.start.elevation_m
            + (segment.end.elevation_m - segment.start.elevation_m) * fraction;
        let grade_pct =
            ((segment.end.elevation_m - segment.start.elevation_m) / segment_length) * 100.0;

        SyntheticRoutePosition {
            synthetic_route: true,
            lat_deg,
            lon_deg,
            elevation_m,
            distance_m: cumulative_distance_m,
            grade_pct,
            speed_kph: Self::estimate_speed_kph(None, grade_pct),
        }
    }

    /// Advances exactly one workout second of fictional route distance.
    pub fn advance_one_second(&mut self, effective_watts: Option<u16>) -> SyntheticRoutePosition {
        let grade_pct = self.position_at(self.cumulative_distance_m).grade_pct;
        let speed_kph = Self::estimate_speed_kph(effective_watts, grade_pct);
        self.cumulative_distance_m += speed_kph / 3.6;
        let mut position = self.position_at(self.cumulative_distance_m);
        position.speed_kph = speed_kph;
        position
    }

    #[allow(dead_code)]
    pub fn points(&self) -> &[RoutePoint] {
        &self.points
    }
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
        assert_eq!(start.lat_deg, 0.0);
        assert_eq!(start.lon_deg, 0.0);
        assert_eq!(start.elevation_m, 100.0);

        let first_segment_end = route.segments[0].end_distance_m;
        let end = route.position_at(first_segment_end);
        assert!((end.lat_deg - 0.0045).abs() < 1e-12);
        assert_eq!(end.lon_deg, 0.0);
        assert!((end.elevation_m - 118.0).abs() < 1e-9);

        let mid = route.position_at(first_segment_end / 2.0);
        assert!((mid.elevation_m - 109.0).abs() < 1e-9);
        assert!(mid.grade_pct > 3.0);
    }

    #[test]
    fn route_speed_changes_for_power_and_grade_and_advances_one_second() {
        let flat = SyntheticRoute::estimate_speed_kph(Some(200), 0.0);
        let climb = SyntheticRoute::estimate_speed_kph(Some(200), 8.0);
        assert!(flat > climb);
        assert!((flat - 26.666666666666668).abs() < 1e-9);

        let mut route = SyntheticRoute::default();
        let position = route.advance_one_second(Some(200));
        assert!(position.distance_m > 0.0);
        assert!(position.speed_kph >= 5.0);
        assert_eq!(route.distance_m(), position.distance_m);
    }
}
