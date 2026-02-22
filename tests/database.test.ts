import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsDatabase } from "../src/database.js";

let tmpDir: string;
let db: MetricsDatabase;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "metrics-test-"));
  db = new MetricsDatabase(join(tmpDir, "metrics.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true });
});

describe("MetricsDatabase", () => {
  it("creates tables on init", () => {
    // If we get here without throwing, tables were created
    expect(db).toBeDefined();
  });

  it("records a usage event", () => {
    db.recordUsage({
      ts: new Date().toISOString(),
      gatewayId: "claudius",
      channel: "discord",
      provider: "anthropic",
      model: "claude-opus-4-6",
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      costUsd: 0.0015,
    });

    const stats = db.getHourlyStats(1);
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0].total_tokens).toBe(300);
  });

  it("aggregates hourly stats correctly", () => {
    const now = new Date().toISOString();
    db.recordUsage({ ts: now, gatewayId: "g1", model: "m1", totalTokens: 100 });
    db.recordUsage({ ts: now, gatewayId: "g1", model: "m1", totalTokens: 200 });

    const stats = db.getHourlyStats(1);
    const row = stats.find((r: any) => r.model === "m1");
    expect(row?.total_tokens).toBe(300);
    expect(row?.event_count).toBe(2);
  });

  it("aggregates daily stats correctly", () => {
    const now = new Date().toISOString();
    db.recordUsage({ ts: now, gatewayId: "g1", model: "m2", costUsd: 0.01 });
    db.recordUsage({ ts: now, gatewayId: "g1", model: "m2", costUsd: 0.02 });

    const stats = db.getDailyStats(7);
    const row = stats.find((r: any) => r.model === "m2");
    expect(row?.cost_usd).toBeCloseTo(0.03);
  });

  it("cleans up old raw data without error", () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.recordUsage({ ts: old, gatewayId: "g1", model: "old-model", totalTokens: 999 });

    // Should not throw
    expect(() =>
      db.cleanupOldData({ rawDays: 30, hourlyDays: 90, dailyDays: 365 })
    ).not.toThrow();
  });

  it("returns model distribution", () => {
    const now = new Date().toISOString();
    db.recordUsage({ ts: now, gatewayId: "g1", model: "opus", totalTokens: 100 });
    db.recordUsage({ ts: now, gatewayId: "g1", model: "haiku", totalTokens: 50 });

    const dist = db.getModelDistribution(7);
    expect(dist.length).toBe(2);
    const models = dist.map((r: any) => r.model);
    expect(models).toContain("opus");
    expect(models).toContain("haiku");
  });
});
