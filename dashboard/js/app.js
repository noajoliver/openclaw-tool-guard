/**
 * Main app logic for the Hive Queen metrics dashboard.
 * Handles view switching, data fetching, chart rendering, and auto-refresh.
 *
 * All DOM mutations use textContent / createElement — never innerHTML with
 * untrusted data — to prevent XSS.
 */

import {
  fetchOverview,
  fetchTimeseries,
  fetchGateways,
  fetchModels,
} from "./api.js";

import {
  renderTokenChart,
  renderModelChart,
  renderCostChart,
  renderHourlyBurnChart,
  renderLiveChart,
  renderModelDistChart,
} from "./charts.js";

const REFRESH_MS = 30_000;

let currentView = "overview";
let countdown = REFRESH_MS / 1000;

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null || isNaN(n)) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(Math.round(n));
}

function fmtCost(n) {
  if (n == null || isNaN(n)) return "$0.00000";
  return "$" + Number(n).toFixed(5);
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showEmpty(id, show) {
  const el = document.getElementById(id);
  if (el) el.style.display = show ? "flex" : "none";
}

function getRange() {
  return document.getElementById("range-select")?.value ?? "24h";
}

function toParams(range) {
  switch (range) {
    case "7d":  return { hours: 168, days: 7 };
    case "30d": return { hours: 720, days: 30 };
    default:    return { hours: 24,  days: 1 };
  }
}

/** Create a <span class="..."> with textContent safely. */
function makeSpan(className, text) {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text ?? "";
  return s;
}

/** Clear all children from a <tbody> and optionally add a "no data" row. */
function clearTbody(tbodyId, colSpan, message) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return null;
  tbody.replaceChildren();
  if (message) {
    const tr = tbody.insertRow();
    const td = tr.insertCell();
    td.colSpan = colSpan;
    td.className = "empty-row";
    td.textContent = message;
  }
  return tbody;
}

// ── View switching ─────────────────────────────────────────────────────────

function switchView(view) {
  if (currentView === view) return;
  currentView = view;

  document.querySelectorAll(".main").forEach((el) => el.classList.add("hidden"));
  document.querySelectorAll(".nav-btn").forEach((el) => el.classList.remove("active"));

  document.getElementById(`view-${view}`)?.classList.remove("hidden");
  document.querySelector(`.nav-btn[data-view="${view}"]`)?.classList.add("active");

  refresh();
}

// ── Overview ───────────────────────────────────────────────────────────────

async function refreshOverview() {
  const { hours, days } = toParams(getRange());

  const [overview, timeseries, models] = await Promise.all([
    fetchOverview(hours),
    fetchTimeseries(hours),
    fetchModels(days),
  ]);

  setEl("ov-events",    fmt(overview?.totalEvents));
  setEl("ov-tokens",    fmt(overview?.totalTokens));
  setEl("ov-input",     fmt(overview?.inputTokens));
  setEl("ov-output",    fmt(overview?.outputTokens));
  setEl("ov-cost",      fmtCost(overview?.totalCost));
  setEl("ov-top-gw",    overview?.topGateways?.[0]?.id ?? "—");
  setEl("ov-top-model", overview?.topModels?.[0]?.id   ?? "—");

  const hasSeries = Array.isArray(timeseries) && timeseries.length > 0;
  const hasModels = Array.isArray(models) && models.length > 0;

  showEmpty("empty-tokens", !hasSeries);
  showEmpty("empty-cost",   !hasSeries);
  showEmpty("empty-hourly", !hasSeries);
  showEmpty("empty-models", !hasModels);

  if (hasSeries) {
    renderTokenChart(timeseries);
    renderCostChart(timeseries);
    renderHourlyBurnChart(timeseries);
  }
  if (hasModels) {
    renderModelChart(models);
  }
}

// ── Gateways ───────────────────────────────────────────────────────────────

async function refreshGateways() {
  const gateways = await fetchGateways();

  if (!Array.isArray(gateways) || gateways.length === 0) {
    clearTbody("gw-tbody", 4, "No gateway data yet — waiting for events…");
    return;
  }

  const tbody = clearTbody("gw-tbody", 0);
  if (!tbody) return;

  for (const gw of gateways) {
    const tr = tbody.insertRow();

    const tdId = tr.insertCell();
    tdId.appendChild(makeSpan("gw-badge", gw.id));

    const tdTokens = tr.insertCell();
    tdTokens.className = "num";
    tdTokens.textContent = fmt(gw.totalTokens24h);

    const tdCost = tr.insertCell();
    tdCost.className = "num";
    tdCost.textContent = fmtCost(gw.totalCost24h);

    const tdModel = tr.insertCell();
    tdModel.textContent = gw.topModel || "—";
  }
}

// ── Models ─────────────────────────────────────────────────────────────────

async function refreshModels() {
  const { days } = toParams(getRange());
  const models = await fetchModels(days);

  if (!Array.isArray(models) || models.length === 0) {
    clearTbody("models-tbody", 5, "No model data yet — waiting for events…");
    showEmpty("empty-models-dist", true);
    return;
  }

  showEmpty("empty-models-dist", false);
  renderModelDistChart(models);

  const tbody = clearTbody("models-tbody", 0);
  if (!tbody) return;

  for (const m of models) {
    const tr = tbody.insertRow();

    const tdId = tr.insertCell();
    tdId.appendChild(makeSpan("model-name", m.id));

    const provider = m.provider ?? "unknown";
    const tdProv = tr.insertCell();
    tdProv.appendChild(makeSpan(`provider-badge provider-${provider}`, provider));

    const tdTokens = tr.insertCell();
    tdTokens.className = "num";
    tdTokens.textContent = fmt(m.totalTokens);

    const tdCost = tr.insertCell();
    tdCost.className = "num";
    tdCost.textContent = fmtCost(m.totalCost);

    const tdCostK = tr.insertCell();
    tdCostK.className = "num";
    tdCostK.textContent = Number(m.avgCostPer1K || 0).toFixed(4);
  }
}

// ── Live ───────────────────────────────────────────────────────────────────

async function refreshLive() {
  const [timeseries, gateways] = await Promise.all([
    fetchTimeseries(12),
    fetchGateways(),
  ]);

  const hasSeries = Array.isArray(timeseries) && timeseries.length > 0;
  showEmpty("empty-live", !hasSeries);
  if (hasSeries) renderLiveChart(timeseries);

  const container = document.getElementById("live-gw-cards");
  if (!container) return;
  container.replaceChildren();

  if (Array.isArray(gateways) && gateways.length > 0) {
    for (const gw of gateways) {
      const card = document.createElement("div");
      card.className = "card";

      const label = document.createElement("div");
      label.className = "card-label";
      label.textContent = gw.id;

      const valueWrap = document.createElement("div");
      valueWrap.className = "card-value";
      valueWrap.textContent = fmt(gw.totalTokens24h);
      const unit = document.createElement("span");
      unit.className = "unit";
      unit.textContent = "tok";
      valueWrap.appendChild(unit);

      const sub = document.createElement("div");
      sub.className = "card-sub";
      sub.textContent = fmtCost(gw.totalCost24h);

      card.append(label, valueWrap, sub);
      container.appendChild(card);
    }
  }
}

// ── Refresh orchestrator ───────────────────────────────────────────────────

async function refresh() {
  try {
    if      (currentView === "overview")  await refreshOverview();
    else if (currentView === "gateways")  await refreshGateways();
    else if (currentView === "models")    await refreshModels();
    else if (currentView === "live")      await refreshLive();
  } catch (err) {
    console.error("[metrics] Refresh failed:", err);
  }
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Navigation
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // Time range selector
  document.getElementById("range-select")?.addEventListener("change", refresh);

  // Countdown ticker + auto-refresh
  setInterval(() => {
    countdown--;
    setEl("refresh-countdown", countdown + "s");
    if (countdown <= 0) {
      countdown = REFRESH_MS / 1000;
      refresh();
    }
  }, 1000);

  // Initial data load
  refresh();
});
