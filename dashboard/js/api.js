/**
 * API client for the Hive Queen metrics dashboard.
 *
 * All functions return parsed JSON or throw an Error on failure.
 * Retries up to `retries` times with exponential backoff.
 */

async function apiFetch(path, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

/**
 * GET /api/overview?hours=N
 * Returns: { totalTokens, totalCost, totalEvents, inputTokens, outputTokens,
 *             topGateways: [{id, totalTokens, totalCost}],
 *             topModels:   [{id, totalTokens, totalCost}] }
 */
export async function fetchOverview(hours = 24) {
  return apiFetch(`/api/overview?hours=${hours}`);
}

/**
 * GET /api/timeseries?hours=N[&gateway=...][&model=...]
 * Returns: [{ timestamp, tokens, cost }]
 */
export async function fetchTimeseries(hours = 24, gateway, model) {
  let url = `/api/timeseries?hours=${hours}`;
  if (gateway) url += `&gateway=${encodeURIComponent(gateway)}`;
  if (model)   url += `&model=${encodeURIComponent(model)}`;
  return apiFetch(url);
}

/**
 * GET /api/gateways
 * Returns: [{ id, totalTokens24h, totalCost24h, topModel }]
 */
export async function fetchGateways() {
  return apiFetch("/api/gateways");
}

/**
 * GET /api/gateway/:id?hours=N
 * Returns: { id, stats: { totalTokens, totalCost, totalEvents }, hourly, sessions }
 */
export async function fetchGateway(id, hours = 24) {
  return apiFetch(`/api/gateway/${encodeURIComponent(id)}?hours=${hours}`);
}

/**
 * GET /api/models?days=N
 * Returns: [{ id, provider, totalTokens, totalCost, avgCostPer1K }]
 */
export async function fetchModels(days = 7) {
  return apiFetch(`/api/models?days=${days}`);
}
