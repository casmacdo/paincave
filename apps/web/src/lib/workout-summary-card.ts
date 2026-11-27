import type { RideRecord } from "./api.js";
import type { RideTimeseriesPoint } from "../components/AnalyticsCharts.js";

function formatDuration(durationS: number): string {
  const totalMin = Math.round(durationS / 60);
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return hrs > 0 ? `${hrs}h ${String(mins).padStart(2, "0")}m` : `${totalMin}m`;
}

/**
 * Renders a 1200x630 dark-mode TrainerRoad-style workout summary PNG card
 * suitable for attaching manually to Strava or sharing.
 */
export function renderRideSummaryCardDataUrl(
  ride: RideRecord,
  points: readonly RideTimeseriesPoint[]
): string | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Background
  ctx.fillStyle = "#09090b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle card frame
  ctx.strokeStyle = "#27272a";
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);

  // Header
  ctx.fillStyle = "#f97316";
  ctx.font = "bold 20px system-ui, -apple-system, sans-serif";
  ctx.fillText("PAINCAVE", 56, 74);

  ctx.fillStyle = "#a1a1aa";
  ctx.font = "500 18px system-ui, -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`${ride.ride_day}  ·  ${formatDuration(ride.duration_s)}`, canvas.width - 56, 74);
  ctx.textAlign = "left";

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 36px system-ui, -apple-system, sans-serif";
  ctx.fillText(ride.name.slice(0, 48), 56, 122);

  // KPI strip
  const kpis: { label: string; value: string; color: string }[] = [
    { label: "NP", value: ride.np_watts !== null ? `${ride.np_watts} W` : "--", color: "#fb923c" },
    { label: "IF", value: ride.intensity_factor !== null ? ride.intensity_factor.toFixed(2) : "--", color: "#ffffff" },
    { label: "TSS", value: `${Math.round(ride.tss)}`, color: "#38bdf8" },
    { label: "AVG HR", value: ride.avg_hr !== null ? `${ride.avg_hr} bpm` : "--", color: "#fb7185" },
    { label: "WORK", value: `${Math.round(ride.work_kj)} kJ`, color: "#e4e4e7" },
    {
      label: "COMPLIANCE",
      value: ride.compliance_pct !== null ? `${Math.round(ride.compliance_pct)}%` : "--",
      color: "#34d399",
    },
  ];

  const boxW = (canvas.width - 112 - 5 * 14) / 6;
  kpis.forEach((kpi, idx) => {
    const x = 56 + idx * (boxW + 14);
    ctx.fillStyle = "#18181b";
    ctx.fillRect(x, 148, boxW, 84);
    ctx.strokeStyle = "#27272a";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, 148, boxW, 84);

    ctx.fillStyle = "#71717a";
    ctx.font = "600 13px system-ui, -apple-system, sans-serif";
    ctx.fillText(kpi.label, x + 16, 174);

    ctx.fillStyle = kpi.color;
    ctx.font = "bold 26px system-ui, -apple-system, sans-serif";
    ctx.fillText(kpi.value, x + 16, 212);
  });

  // Power & HR chart plot area
  const chartX = 56;
  const chartY = 262;
  const chartW = canvas.width - 112;
  const chartH = 300;
  ctx.fillStyle = "#121215";
  ctx.fillRect(chartX, chartY, chartW, chartH);
  ctx.strokeStyle = "#27272a";
  ctx.strokeRect(chartX, chartY, chartW, chartH);

  if (points.length > 1) {
    const maxT = Math.max(1, points.at(-1)?.t_s ?? 1);
    const maxW = Math.max(250, ...points.map((p) => p.watts ?? 0));
    const wCeil = Math.ceil(maxW / 50) * 50;
    const minHr = 70;
    const maxHr = Math.max(195, ...points.map((p) => p.hr_bpm ?? 0));

    // Horizontal grid lines
    ctx.strokeStyle = "#27272a";
    ctx.fillStyle = "#71717a";
    ctx.font = "12px system-ui, sans-serif";
    for (let i = 1; i <= 3; i++) {
      const y = chartY + (chartH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(chartX, y);
      ctx.lineTo(chartX + chartW, y);
      ctx.stroke();
      ctx.fillText(`${Math.round(wCeil * (1 - i / 4))}W`, chartX + 10, y - 6);
    }

    // Power filled curve
    const powerPts = points.filter((p) => p.watts !== null);
    if (powerPts.length > 1) {
      ctx.beginPath();
      powerPts.forEach((p, idx) => {
        const px = chartX + (p.t_s / maxT) * chartW;
        const py = chartY + chartH - ((p.watts ?? 0) / wCeil) * (chartH - 20) - 8;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = "#f97316";
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.lineTo(chartX + ((powerPts.at(-1)?.t_s ?? 0) / maxT) * chartW, chartY + chartH);
      ctx.lineTo(chartX + ((powerPts[0]?.t_s ?? 0) / maxT) * chartW, chartY + chartH);
      ctx.closePath();
      ctx.fillStyle = "rgba(249, 115, 22, 0.22)";
      ctx.fill();
    }

    // HR overlay line
    const hrPts = points.filter((p) => p.hr_bpm !== null);
    if (hrPts.length > 1) {
      ctx.beginPath();
      hrPts.forEach((p, idx) => {
        const px = chartX + (p.t_s / maxT) * chartW;
        const py =
          chartY +
          chartH -
          (((p.hr_bpm ?? minHr) - minHr) / Math.max(1, maxHr - minHr)) * (chartH - 20) -
          8;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = "#fb7185";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = "#71717a";
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillText("Summary metrics card (no 1Hz timeseries samples)", chartX + 24, chartY + 150);
  }

  return canvas.toDataURL("image/png");
}

export function downloadRideSummaryPng(
  ride: RideRecord,
  points: readonly RideTimeseriesPoint[]
): boolean {
  const dataUrl = renderRideSummaryCardDataUrl(ride, points);
  if (!dataUrl) return false;
  const slug = ride.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = `${ride.ride_day}-${slug || "ride"}-summary.png`;
  link.click();
  return true;
}
