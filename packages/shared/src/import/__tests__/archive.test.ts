import { describe, expect, it } from "vitest";
import {
  buildArchiveActivityItem,
  parseGarminWellnessExportJson,
  parseStravaActivitiesCsv,
} from "../../index.js";

describe("Bulk Archive Parsers (Strava & Garmin Exports)", () => {
  it("parses Strava activities.csv with quoted commas, sport mapping, and filenames", () => {
    const csv = [
      'Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Max Heart Rate,Relative Effort,Commute,Activity Private Note,Activity Gear,Filename,Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance,Max Speed,Average Speed,Elevation Gain,Elevation Loss,Elevation Low,Elevation High,Max Grade,Average Grade,Average Positive Grade,Average Negative Grade,Max Cadence,Average Cadence,Max Heart Rate,Average Heart Rate,Max Watts,Average Watts',
      '10001,"May 12, 2024, 1:15:00 PM","Sweet Spot, 2x20m",Virtual Ride,"Felt strong, steady cadence",3720,38.4,178,,false,,KICKR,activities/10001.fit.gz,,,,3600,38.4,,,420,,,,,,,,,,,156,,225',
      '10002,"May 14, 2024, 11:30:00 AM","Trail 10K",Trail Run,"Hilly loop",3120,10.2,172,,false,,Pegasus,activities/10002.fit.gz,,,,3050,10.2,,,215,,,,,,,,,,,152,,',
      '10003,"May 15, 2024, 5:00:00 PM","Lower Strength",Weight Training,"Squats and RDLs",2700,0,135,,false,,,activities/10003.fit.gz,,,,2700,0,,,0,,,,,,,,,,,118,,',
    ].join("\n");

    const parsed = parseStravaActivitiesCsv(csv);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      external_id: "10001",
      name: "Sweet Spot, 2x20m",
      sport: "cycling",
      sub_sport: "virtual_activity",
      duration_s: 3600,
      distance_m: 38400,
      filename: "activities/10001.fit.gz",
    });
    expect(parsed[1]).toMatchObject({
      external_id: "10002",
      sport: "running",
      sub_sport: "trail",
      distance_m: 10200,
    });
    expect(parsed[2]?.sport).toBe("strength");

    const batchItem = buildArchiveActivityItem({
      rideUuid: "550e8400-e29b-41d4-a716-446655449901",
      externalProvider: "strava_archive",
      externalId: parsed[1]!.external_id,
      name: parsed[1]!.name,
      startedAt: parsed[1]!.started_at,
      sport: parsed[1]!.sport,
      subSport: parsed[1]!.sub_sport,
      durationS: parsed[1]!.duration_s,
      distanceM: parsed[1]!.distance_m,
      elevationGainM: parsed[1]!.elevation_gain_m,
      avgHr: parsed[1]!.avg_hr,
      thresholdPaceSPerKm: 280,
    });
    expect(batchItem.sport).toBe("running");
    expect(batchItem.avg_pace_s_per_km).toBeCloseTo(299, 0);
    expect(batchItem.external_id).toBe("10002");
  });

  it("parses Garmin GDPR wellness JSON exports into daily biometrics rows", () => {
    const rows = parseGarminWellnessExportJson([
      {
        calendarDate: "2025-04-10",
        restingHeartRate: 49,
        totalSteps: 10450,
        averageStressLevel: 26,
        bodyBatteryHighestValue: 91,
        bodyBatteryLowestValue: 38,
        lastNightAvg: 61,
        status: "balanced",
        sleepTimeSeconds: 27900,
        sleepScores: { overallScore: 84 },
        weightInGrams: 68200,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2025-04-10",
      hrv_rmssd_ms: 61,
      resting_hr_bpm: 49,
      sleep_score: 84,
      weight_kg: 68.2,
    });
  });
});
