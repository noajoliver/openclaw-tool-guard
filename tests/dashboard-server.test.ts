import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsDatabase } from "../src/database.js";
import { DashboardServer } from "../src/dashboard-server.js";

let tmpDir: string;
let db: MetricsDatabase;
let server: DashboardServer;
let baseUrl: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "dash-test-"));
  db = new MetricsDatabase(join(tmpDir, "metrics.db"));
  // Use tmpDir as dashboardDir — no static files there, so static requests → 404
  server = new DashboardServer(db, { port: 0, bind: "127.0.0.1", dashboardDir: tmpDir });
  await server.start();
  baseUrl = `http://127.0.0.1:${server.actualPort}`;
});

afterEach(async () => {
  await server.stop();
  db.close();
  rmSync(tmpDir, { recursive: true });
});

async function getJson(path: string) {
  const res = await fetch(baseUrl + path);
  const body = await res.json();
  return { status: res.status, body };
}

describe("DashboardServer API", () => {
  it("GET /api/overview returns valid JSON with empty database", async () => {
    const { status, body } = await getJson("/api/overview");
    expect(status).toBe(200);
    expect(body).toHaveProperty("totalTokens");
    expect(body).toHaveProperty("totalCost");
    expect(body).toHaveProperty("topGateways");
    expect(body).toHaveProperty("topModels");
    expect(Array.isArray(body.topGateways)).toBe(true);
    expect(Array.isArray(body.topModels)).toBe(true);
  });

  it("GET /api/timeseries returns array with empty database", async () => {
    const { status, body } = await getJson("/api/timeseries?hours=24");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /api/gateways returns array with empty database", async () => {
    const { status, body } = await getJson("/api/gateways");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /api/models returns array with empty database", async () => {
    const { status, body } = await getJson("/api/models");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /api/gateway/:id returns object with empty database", async () => {
    const { status, body } = await getJson("/api/gateway/test-gw");
    expect(status).toBe(200);
    expect(body).toHaveProperty("id");
    expect(body.id).toBe("test-gw");
    expect(body).toHaveProperty("hourly");
    expect(Array.isArray(body.hourly)).toBe(true);
  });

  it("returns 404 JSON for unknown API routes", async () => {
    const { status, body } = await getJson("/api/nonexistent");
    expect(status).toBe(404);
    expect(body).toHaveProperty("error");
  });

  it("returns 404 for static files that do not exist", async () => {
    const res = await fetch(baseUrl + "/nonexistent-file.html");
    expect(res.status).toBe(404);
  });

  it("GET /api/overview honors hours query parameter", async () => {
    const { status } = await getJson("/api/overview?hours=12");
    expect(status).toBe(200);
  });

  it("GET /api/timeseries filters by gateway query parameter", async () => {
    const now = new Date().toISOString();
    db.recordUsage({ ts: now, gatewayId: "gw-a", model: "opus", totalTokens: 100 });
    db.recordUsage({ ts: now, gatewayId: "gw-b", model: "haiku", totalTokens: 50 });

    const { body: all } = await getJson("/api/timeseries?hours=1");
    const { body: filtered } = await getJson("/api/timeseries?gateway=gw-a&hours=1");

    // Unfiltered includes both gateways; filtered should only include gw-a tokens
    const totalAll = (all as any[]).reduce((s: number, r: any) => s + r.tokens, 0);
    const totalFiltered = (filtered as any[]).reduce((s: number, r: any) => s + r.tokens, 0);
    expect(totalAll).toBe(150);
    expect(totalFiltered).toBe(100);
  });

  it("returns correct overview data after recording usage", async () => {
    const now = new Date().toISOString();
    db.recordUsage({ ts: now, gatewayId: "gw1", model: "opus", totalTokens: 500, costUsd: 0.005 });
    db.recordUsage({ ts: now, gatewayId: "gw1", model: "haiku", totalTokens: 200, costUsd: 0.001 });

    const { body } = await getJson("/api/overview?hours=24");
    expect(body.totalTokens).toBe(700);
    expect(body.topGateways.length).toBeGreaterThan(0);
    expect(body.topGateways[0].id).toBe("gw1");
    expect(body.topModels.length).toBe(2);
  });

  it("GET /api/gateways returns gateway data after recording usage", async () => {
    const now = new Date().toISOString();
    db.recordUsage({ ts: now, gatewayId: "gw2", model: "haiku", totalTokens: 100 });

    const { body } = await getJson("/api/gateways");
    const gw = (body as any[]).find((g: any) => g.id === "gw2");
    expect(gw).toBeDefined();
    expect(gw.totalTokens24h).toBe(100);
    expect(gw).toHaveProperty("topModel");
    expect(gw.topModel).toBe("haiku");
  });

  it("GET /api/gateway/:id returns data for specific gateway", async () => {
    const now = new Date().toISOString();
    db.recordUsage({ ts: now, gatewayId: "gw3", model: "opus", totalTokens: 300 });
    db.recordUsage({ ts: now, gatewayId: "gw4", model: "haiku", totalTokens: 99 });

    const { body } = await getJson("/api/gateway/gw3?hours=24");
    expect(body.id).toBe("gw3");
    expect(body.stats.totalTokens).toBe(300);
    // Should not include gw4 data
    const totalInHourly = (body.hourly as any[]).reduce((s: number, r: any) => s + r.tokens, 0);
    expect(totalInHourly).toBe(300);
  });

  it("GET /api/models returns model distribution with correct shape", async () => {
    const now = new Date().toISOString();
    db.recordUsage({ ts: now, gatewayId: "g1", model: "claude-opus-4-6", totalTokens: 1000, costUsd: 0.01 });

    const { body } = await getJson("/api/models");
    const m = (body as any[]).find((x: any) => x.id === "claude-opus-4-6");
    expect(m).toBeDefined();
    expect(m.provider).toBe("anthropic");
    expect(m.totalTokens).toBe(1000);
    expect(typeof m.avgCostPer1K).toBe("number");
  });
});
