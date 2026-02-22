import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsDatabase } from "../src/database.js";
import { MetricsCollector } from "../src/metrics-collector.js";

function makeDb() {
  const tmpDir = mkdtempSync(join(tmpdir(), "collector-test-"));
  return {
    db: new MetricsDatabase(join(tmpDir, "metrics.db")),
    cleanup: () => {
      rmSync(tmpDir, { recursive: true });
    },
  };
}

describe("MetricsCollector", () => {
  it("flushes buffered events to database", async () => {
    const { db, cleanup } = makeDb();
    const collector = new MetricsCollector(db, { gatewayId: "test-gw", bufferMs: 60_000, bufferSize: 100 });

    collector.record({
      type: "model.usage",
      model: "claude-opus-4-6",
      usage: { input: 10, output: 20, total: 30 },
      costUsd: 0.001,
    });

    await collector.flush();
    collector.stop();

    const stats = db.getHourlyStats(1);
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0].total_tokens).toBe(30);

    db.close();
    cleanup();
  });

  it("batches multiple events in one flush", async () => {
    const { db, cleanup } = makeDb();
    const collector = new MetricsCollector(db, { gatewayId: "test-gw", bufferMs: 60_000, bufferSize: 100 });

    for (let i = 0; i < 5; i++) {
      collector.record({ type: "model.usage", model: "haiku", usage: { total: 10 } });
    }

    await collector.flush();
    collector.stop();

    const stats = db.getHourlyStats(1);
    const row = stats.find((r: any) => r.model === "haiku");
    expect(row?.event_count).toBe(5);
    expect(row?.total_tokens).toBe(50);

    db.close();
    cleanup();
  });

  it("auto-flushes when buffer size is reached", async () => {
    const { db, cleanup } = makeDb();
    const collector = new MetricsCollector(db, { gatewayId: "test-gw", bufferMs: 60_000, bufferSize: 3 });

    for (let i = 0; i < 3; i++) {
      collector.record({ type: "model.usage", model: "auto", usage: { total: 5 } });
    }

    // Sync flush happens inline when bufferSize reached
    collector.stop();

    const stats = db.getHourlyStats(1);
    const row = stats.find((r: any) => r.model === "auto");
    expect(row?.total_tokens).toBe(15);

    db.close();
    cleanup();
  });
});
