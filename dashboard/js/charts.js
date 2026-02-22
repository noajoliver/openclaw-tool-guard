/**
 * Chart rendering module for the Hive Queen metrics dashboard.
 * Requires Chart.js 4.x loaded globally via CDN.
 *
 * Data formats expected (matching dashboard-server.ts responses):
 *   timeseries  — [{ timestamp: ISO string, tokens: number, cost: number }]
 *   models      — [{ id, provider, totalTokens, totalCost, avgCostPer1K }]
 *   gateways    — [{ id, totalTokens24h, totalCost24h, topModel }]
 */

// Active chart instances — destroyed before re-rendering
const charts = {
  tokens: null,
  models: null,
  cost: null,
  hourly: null,
  live: null,
  modelsDist: null,
};

// Shared palette
const C = {
  accent:  "#22d3ee",
  green:   "#34d399",
  yellow:  "#fbbf24",
  red:     "#f87171",
  purple:  "#a78bfa",
  orange:  "#fb923c",
  grid:    "#1a2638",
  label:   "#4a5a72",
};

const PALETTE = [C.accent, C.green, C.yellow, C.red, C.purple, C.orange];

function baseOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: true,
    animation: { duration: 200 },
    plugins: {
      legend: { labels: { color: C.label, boxWidth: 12, font: { size: 11 } } },
      ...extra.plugins,
    },
    scales: {
      x: {
        ticks: { color: C.label, maxRotation: 0, font: { size: 10 } },
        grid: { color: C.grid },
      },
      y: {
        ticks: { color: C.label, font: { size: 10 } },
        grid: { color: C.grid },
        beginAtZero: true,
      },
      ...extra.scales,
    },
    ...extra,
  };
}

function destroy(key) {
  if (charts[key]) { charts[key].destroy(); charts[key] = null; }
}

function fmtLabel(ts) {
  // "2026-02-22T14:00:00Z" → "14:00"
  return typeof ts === "string" ? ts.slice(11, 16) : String(ts);
}

// ── Token usage line chart ─────────────────────────────────────────────────
// timeseries: [{ timestamp, tokens, cost }]
export function renderTokenChart(timeseries) {
  destroy("tokens");
  const ctx = document.getElementById("chart-tokens")?.getContext("2d");
  if (!ctx || !timeseries?.length) return;

  charts.tokens = new Chart(ctx, {
    type: "line",
    data: {
      labels: timeseries.map((r) => fmtLabel(r.timestamp)),
      datasets: [{
        label: "Tokens",
        data: timeseries.map((r) => r.tokens || 0),
        borderColor: C.accent,
        backgroundColor: "rgba(34,211,238,0.07)",
        fill: true,
        tension: 0.4,
        pointRadius: 2,
        pointHoverRadius: 5,
        borderWidth: 1.5,
      }],
    },
    options: baseOpts(),
  });
}

// ── Model distribution doughnut ────────────────────────────────────────────
// models: [{ id, provider, totalTokens, totalCost }]
export function renderModelChart(models) {
  destroy("models");
  const ctx = document.getElementById("chart-models")?.getContext("2d");
  if (!ctx || !models?.length) return;

  charts.models = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: models.map((r) => r.id || "unknown"),
      datasets: [{
        data: models.map((r) => r.totalTokens || 0),
        backgroundColor: PALETTE.slice(0, models.length),
        borderColor: "#0a0e16",
        borderWidth: 2,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      animation: { duration: 200 },
      plugins: {
        legend: {
          position: "right",
          labels: { color: C.label, boxWidth: 12, font: { size: 11 }, padding: 10 },
        },
      },
    },
  });
}

// ── Daily cost bar chart ───────────────────────────────────────────────────
// timeseries: [{ timestamp, tokens, cost }] — grouped by day in JS
export function renderCostChart(timeseries) {
  destroy("cost");
  const ctx = document.getElementById("chart-cost")?.getContext("2d");
  if (!ctx || !timeseries?.length) return;

  // Aggregate cost per calendar day
  const byDay = {};
  for (const r of timeseries) {
    const day = typeof r.timestamp === "string" ? r.timestamp.slice(0, 10) : "?";
    byDay[day] = (byDay[day] || 0) + (r.cost || 0);
  }
  const days = Object.keys(byDay).sort();

  charts.cost = new Chart(ctx, {
    type: "bar",
    data: {
      labels: days,
      datasets: [{
        label: "Cost (USD)",
        data: days.map((d) => byDay[d]),
        backgroundColor: "rgba(251,191,36,0.55)",
        borderColor: C.yellow,
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: baseOpts({
      plugins: {
        legend: { labels: { color: C.label, boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (item) => ` $${Number(item.raw).toFixed(5)}`,
          },
        },
      },
    }),
  });
}

// ── Hourly burn rate bar chart ─────────────────────────────────────────────
// timeseries: [{ timestamp, tokens, cost }]
export function renderHourlyBurnChart(timeseries) {
  destroy("hourly");
  const ctx = document.getElementById("chart-hourly")?.getContext("2d");
  if (!ctx || !timeseries?.length) return;

  charts.hourly = new Chart(ctx, {
    type: "bar",
    data: {
      labels: timeseries.map((r) => fmtLabel(r.timestamp)),
      datasets: [{
        label: "Tokens/hr",
        data: timeseries.map((r) => r.tokens || 0),
        backgroundColor: "rgba(34,211,238,0.35)",
        borderColor: C.accent,
        borderWidth: 1,
        borderRadius: 2,
      }],
    },
    options: baseOpts(),
  });
}

// ── Live view line chart (last 12h) ────────────────────────────────────────
export function renderLiveChart(timeseries) {
  destroy("live");
  const ctx = document.getElementById("chart-live")?.getContext("2d");
  if (!ctx || !timeseries?.length) return;

  charts.live = new Chart(ctx, {
    type: "line",
    data: {
      labels: timeseries.map((r) => fmtLabel(r.timestamp)),
      datasets: [{
        label: "Tokens/hr",
        data: timeseries.map((r) => r.tokens || 0),
        borderColor: C.green,
        backgroundColor: "rgba(52,211,153,0.07)",
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6,
        borderWidth: 1.5,
      }],
    },
    options: baseOpts(),
  });
}

// ── Models view doughnut (separate canvas) ────────────────────────────────
export function renderModelDistChart(models) {
  destroy("modelsDist");
  const ctx = document.getElementById("chart-models-dist")?.getContext("2d");
  if (!ctx || !models?.length) return;

  charts.modelsDist = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: models.map((r) => r.id || "unknown"),
      datasets: [{
        data: models.map((r) => r.totalTokens || 0),
        backgroundColor: PALETTE.slice(0, models.length),
        borderColor: "#0a0e16",
        borderWidth: 2,
        hoverOffset: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      animation: { duration: 200 },
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: C.label, boxWidth: 12, font: { size: 11 }, padding: 8 },
        },
      },
    },
  });
}
