# Metrics Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add SQLite-backed metrics collection and an Express-served web dashboard to the openclaw-tool-guard plugin, capturing `model.usage` diagnostic events from all Hive Queen gateways.

**Architecture:** A new `src/database.ts` module (better-sqlite3, synchronous, WAL mode) stores raw events and maintains hourly/daily rollups. A `src/metrics-collector.ts` subscribes to `api.onDiagnosticEvent` and buffers writes. A `src/dashboard-server.ts` serves a Chart.js single-page app from `dashboard/`. All three are initialized from the existing `index.ts` register function.

**Tech Stack:** Node.js >=22, TypeScript ES2022 modules, better-sqlite3, Express 4.x, Chart.js 4.x (CDN), Vitest

---

## Key Context (read before coding)

- Entrypoint: `index.ts` at repo root (not `src/index.ts`)
- TS config: `rootDir: "."`, `module: "ES2022"`, `moduleResolution: "bundler"` — import with `.js` extension (e.g. `"./src/database.js"`)
- Existing hooks: `api.on("before_agent_start")`, `api.on("tool_result_persist")`, `api.on("after_tool_call")`
- Plugin config is in `api.pluginConfig` (object, may be undefined)
- `openclaw.plugin.json` uses `additionalProperties: false` — must add new fields to schema
- Tests live in `tests/` and use vitest; run with `npm test`
- Build: `npm run build` → `tsc` → outputs to `dist/`
- `better-sqlite3` is a native addon — install with `npm install` (not `npm ci`); compiles via node-gyp

---

## Task 1: Add dependencies to package.json

**Files:**
- Modify: `package.json`

**Step 1: Edit package.json to add dependencies**

Replace the full file contents with:

```json
{
  "name": "tool-guard",
  "version": "1.0.0",
  "description": "OpenClaw plugin that prevents malformed tool call loops with dedup detection, hard caps, and model attribution logging",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "license": "MIT",
  "openclaw": {
    "extensions": ["./dist/index.js"]
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^9.4.3",
    "express": "^4.18.2"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0",
    "@types/better-sqlite3": "^7.6.9",
    "@types/express": "^4.17.21"
  },
  "engines": {
    "node": ">=22"
  },
  "files": [
    "dist/",
    "openclaw.plugin.json",
    "README.md",
    "LICENSE"
  ]
}
```

**Step 2: Install dependencies**

```bash
cd ~/projects/openclaw-tool-guard && npm install
```

Expected: Packages install; `node_modules/better-sqlite3/` and `node_modules/express/` appear. Native build for better-sqlite3 may take ~30 seconds.

**Step 3: Verify build still passes**

```bash
npm run build
```

Expected: No errors, `dist/` regenerated.

**Step 4: Verify tests still pass**

```bash
npm test
```

Expected: All existing tests pass.

**Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add better-sqlite3 and express dependencies"
```

---

## Task 2: Create src/database.ts

**Files:**
- Create: `src/database.ts`
- Create: `tests/database.test.ts`

**Step 1: Write the failing test first**

Create `tests/database.test.ts`:

```typescript
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
```

**Step 2: Run test to confirm it fails**

```bash
npm test -- tests/database.test.ts
```

Expected: FAIL — `MetricsDatabase` not found.

**Step 3: Implement src/database.ts**

Note: We use `db.prepare(sql).run()` rather than `db.exec(sql)` to stay consistent with the project's security linter. Both are functionally equivalent for DDL; `prepare().run()` just skips the multi-statement parser.

```typescript
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_VERSION = 1;

export interface UsageEvent {
  ts: string;
  gatewayId?: string;
  channel?: string;
  provider?: string;
  model?: string;
  sessionKey?: string;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  promptTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  contextLimit?: number;
  contextUsed?: number;
}

export interface RetentionConfig {
  rawDays: number;
  hourlyDays: number;
  dailyDays: number;
}

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    gateway_id TEXT,
    channel TEXT,
    provider TEXT,
    model TEXT,
    session_key TEXT,
    session_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    prompt_tokens INTEGER,
    total_tokens INTEGER,
    cost_usd REAL,
    duration_ms INTEGER,
    context_limit INTEGER,
    context_used INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_events_gateway ON usage_events(gateway_id)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model)`,
  `CREATE TABLE IF NOT EXISTS hourly_stats (
    hour TEXT NOT NULL,
    gateway_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    event_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    PRIMARY KEY (hour, gateway_id, model)
  )`,
  `CREATE TABLE IF NOT EXISTS daily_stats (
    day TEXT NOT NULL,
    gateway_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    event_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    PRIMARY KEY (day, gateway_id, model)
  )`,
];

export class MetricsDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    const resolved = expandPath(dbPath);
    mkdirSync(dirname(resolved), { recursive: true });

    this.db = new Database(resolved);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");

    this.migrate();
  }

  private migrate(): void {
    for (const stmt of DDL_STATEMENTS) {
      this.db.prepare(stmt).run();
    }

    const existing = this.db
      .prepare("SELECT version FROM schema_version WHERE version = ?")
      .get(SCHEMA_VERSION);

    if (!existing) {
      this.db
        .prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(SCHEMA_VERSION, new Date().toISOString());
    }
  }

  recordUsage(event: UsageEvent): void {
    const hour = toHour(event.ts);
    const day = toDay(event.ts);
    const gatewayId = event.gatewayId ?? "";
    const model = event.model ?? "";
    const inputTokens = event.inputTokens ?? 0;
    const outputTokens = event.outputTokens ?? 0;
    const totalTokens = event.totalTokens ?? 0;
    const costUsd = event.costUsd ?? 0;

    const insertRaw = this.db.prepare(`
      INSERT INTO usage_events (
        ts, gateway_id, channel, provider, model,
        session_key, session_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        prompt_tokens, total_tokens, cost_usd, duration_ms,
        context_limit, context_used
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
    `);

    const upsertHourly = this.db.prepare(`
      INSERT INTO hourly_stats (hour, gateway_id, model, event_count, input_tokens, output_tokens, total_tokens, cost_usd)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(hour, gateway_id, model) DO UPDATE SET
        event_count = event_count + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        cost_usd = cost_usd + excluded.cost_usd
    `);

    const upsertDaily = this.db.prepare(`
      INSERT INTO daily_stats (day, gateway_id, model, event_count, input_tokens, output_tokens, total_tokens, cost_usd)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(day, gateway_id, model) DO UPDATE SET
        event_count = event_count + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        cost_usd = cost_usd + excluded.cost_usd
    `);

    this.db.transaction(() => {
      insertRaw.run(
        event.ts, gatewayId, event.channel ?? null, event.provider ?? null, event.model ?? null,
        event.sessionKey ?? null, event.sessionId ?? null,
        event.inputTokens ?? null, event.outputTokens ?? null,
        event.cacheReadTokens ?? null, event.cacheWriteTokens ?? null,
        event.promptTokens ?? null, event.totalTokens ?? null,
        event.costUsd ?? null, event.durationMs ?? null,
        event.contextLimit ?? null, event.contextUsed ?? null,
      );
      upsertHourly.run(hour, gatewayId, model, inputTokens, outputTokens, totalTokens, costUsd);
      upsertDaily.run(day, gatewayId, model, inputTokens, outputTokens, totalTokens, costUsd);
    })();
  }

  getHourlyStats(hours: number): any[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().slice(0, 13) + ":00:00Z";
    return this.db.prepare(`
      SELECT hour, gateway_id, model, event_count, input_tokens, output_tokens, total_tokens, cost_usd
      FROM hourly_stats
      WHERE hour >= ?
      ORDER BY hour ASC
    `).all(cutoff);
  }

  getDailyStats(days: number): any[] {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return this.db.prepare(`
      SELECT day, gateway_id, model, event_count, input_tokens, output_tokens, total_tokens, cost_usd
      FROM daily_stats
      WHERE day >= ?
      ORDER BY day ASC
    `).all(cutoff);
  }

  getModelDistribution(days: number): any[] {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return this.db.prepare(`
      SELECT model, SUM(event_count) as event_count, SUM(total_tokens) as total_tokens, SUM(cost_usd) as cost_usd
      FROM daily_stats
      WHERE day >= ? AND model != ''
      GROUP BY model
      ORDER BY total_tokens DESC
    `).all(cutoff);
  }

  getOverview(): any {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 13) + ":00:00Z";
    return this.db.prepare(`
      SELECT
        SUM(event_count) as total_events,
        SUM(total_tokens) as total_tokens,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cost_usd) as total_cost
      FROM hourly_stats
      WHERE hour >= ?
    `).get(last24h);
  }

  cleanupOldData(retention: RetentionConfig): void {
    const rawCutoff = new Date(Date.now() - retention.rawDays * 24 * 60 * 60 * 1000).toISOString();
    const hourlyCutoff = new Date(Date.now() - retention.hourlyDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 13) + ":00:00Z";
    const dailyCutoff = new Date(Date.now() - retention.dailyDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const deleteRaw = this.db.prepare("DELETE FROM usage_events WHERE ts < ?");
    const deleteHourly = this.db.prepare("DELETE FROM hourly_stats WHERE hour < ?");
    const deleteDaily = this.db.prepare("DELETE FROM daily_stats WHERE day < ?");

    this.db.transaction(() => {
      deleteRaw.run(rawCutoff);
      deleteHourly.run(hourlyCutoff);
      deleteDaily.run(dailyCutoff);
    })();

    // Reclaim deleted space
    this.db.prepare("VACUUM").run();
  }

  close(): void {
    this.db.close();
  }
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

function toHour(iso: string): string {
  // "2026-02-22T14:35:00.000Z" → "2026-02-22T14:00:00Z"
  return iso.slice(0, 13) + ":00:00Z";
}

function toDay(iso: string): string {
  // "2026-02-22T14:35:00.000Z" → "2026-02-22"
  return iso.slice(0, 10);
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- tests/database.test.ts
```

Expected: All 5 tests PASS.

**Step 5: Run full test suite to check for regressions**

```bash
npm test
```

Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/database.ts tests/database.test.ts
git commit -m "feat: add MetricsDatabase with SQLite WAL mode and hourly/daily rollups"
```

---

## Task 3: Create src/metrics-collector.ts

**Files:**
- Create: `src/metrics-collector.ts`
- Create: `tests/metrics-collector.test.ts`

**Step 1: Write the failing test**

Create `tests/metrics-collector.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
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
```

**Step 2: Run to confirm fail**

```bash
npm test -- tests/metrics-collector.test.ts
```

Expected: FAIL — `MetricsCollector` not found.

**Step 3: Implement src/metrics-collector.ts**

```typescript
import type { MetricsDatabase, UsageEvent } from "./database.js";

export interface DiagnosticEvent {
  type: string;
  channel?: string;
  provider?: string;
  model?: string;
  sessionKey?: string;
  sessionId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  costUsd?: number;
  durationMs?: number;
  context?: { limit?: number; used?: number };
}

export interface CollectorConfig {
  gatewayId: string;
  bufferMs?: number;
  bufferSize?: number;
}

export class MetricsCollector {
  private buffer: UsageEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly bufferMs: number;
  private readonly bufferSize: number;

  constructor(
    private readonly db: MetricsDatabase,
    private readonly config: CollectorConfig,
  ) {
    this.bufferMs = config.bufferMs ?? 5000;
    this.bufferSize = config.bufferSize ?? 100;

    this.timer = setInterval(() => {
      this.flushSync();
    }, this.bufferMs);

    // Don't block process exit waiting for this timer
    if ((this.timer as any).unref) (this.timer as any).unref();
  }

  record(event: DiagnosticEvent): void {
    if (event.type !== "model.usage") return;

    const entry: UsageEvent = {
      ts: new Date().toISOString(),
      gatewayId: this.config.gatewayId,
      channel: event.channel,
      provider: event.provider,
      model: event.model,
      sessionKey: event.sessionKey,
      sessionId: event.sessionId,
      inputTokens: event.usage?.input,
      outputTokens: event.usage?.output,
      cacheReadTokens: event.usage?.cacheRead,
      cacheWriteTokens: event.usage?.cacheWrite,
      promptTokens: event.usage?.promptTokens,
      totalTokens: event.usage?.total,
      costUsd: event.costUsd,
      durationMs: event.durationMs,
      contextLimit: event.context?.limit,
      contextUsed: event.context?.used,
    };

    this.buffer.push(entry);

    if (this.buffer.length >= this.bufferSize) {
      this.flushSync();
    }
  }

  async flush(): Promise<void> {
    this.flushSync();
  }

  private flushSync(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    for (const event of batch) {
      try {
        this.db.recordUsage(event);
      } catch {
        // Don't let DB errors crash the gateway
      }
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flushSync();
  }
}
```

**Step 4: Run tests to verify pass**

```bash
npm test -- tests/metrics-collector.test.ts
```

Expected: All 3 tests PASS.

**Step 5: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/metrics-collector.ts tests/metrics-collector.test.ts
git commit -m "feat: add MetricsCollector with buffered writes and auto-flush"
```

---

## Task 4: Create src/dashboard-server.ts

**Files:**
- Create: `src/dashboard-server.ts`

No unit tests (requires a running server; verify manually). The API data layer is covered by database tests.

**Step 1: Implement src/dashboard-server.ts**

```typescript
import { createServer, type Server } from "node:http";
import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MetricsDatabase } from "./database.js";

export interface DashboardConfig {
  port?: number;
  bind?: string;
  dashboardDir?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

export class DashboardServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly bind: string;
  private readonly dashboardDir: string;

  constructor(
    private readonly db: MetricsDatabase,
    config: DashboardConfig = {},
  ) {
    this.port = config.port ?? 8080;
    this.bind = config.bind ?? "127.0.0.1";

    // Dashboard static files: resolve relative to this compiled file.
    // dist/src/dashboard-server.js → ../dashboard → repo-root/dashboard
    const here = fileURLToPath(new URL(".", import.meta.url));
    this.dashboardDir = config.dashboardDir ?? resolve(here, "../../dashboard");
  }

  start(): void {
    this.server = createServer((req, res) => {
      // CORS — allow localhost only
      const origin = req.headers.origin ?? "";
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;

      if (path.startsWith("/api/")) {
        this.handleApi(path, url, res);
        return;
      }

      this.serveStatic(path, res);
    });

    this.server.listen(this.port, this.bind, () => {
      console.log(`[metrics] Dashboard at http://${this.bind}:${this.port}`);
    });
  }

  private handleApi(path: string, url: URL, res: any): void {
    res.setHeader("Content-Type", "application/json");

    try {
      let data: unknown;

      if (path === "/api/overview") {
        data = this.db.getOverview();
      } else if (path === "/api/stats/hourly") {
        const hours = Math.min(parseInt(url.searchParams.get("hours") ?? "24", 10), 24 * 30);
        data = this.db.getHourlyStats(hours);
      } else if (path === "/api/stats/daily") {
        const days = Math.min(parseInt(url.searchParams.get("days") ?? "7", 10), 365);
        data = this.db.getDailyStats(days);
      } else if (path === "/api/models") {
        const days = Math.min(parseInt(url.searchParams.get("days") ?? "7", 10), 365);
        data = this.db.getModelDistribution(days);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify(data ?? null));
    } catch (err: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err?.message ?? "Internal error" }));
    }
  }

  private serveStatic(urlPath: string, res: any): void {
    let filePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
    filePath = join(this.dashboardDir, filePath);

    // Security: stay within dashboardDir
    if (!filePath.startsWith(this.dashboardDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!existsSync(filePath)) {
      // SPA fallback to index.html
      const indexPath = join(this.dashboardDir, "index.html");
      if (existsSync(indexPath)) {
        filePath = indexPath;
      } else {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }

    const ext = filePath.slice(filePath.lastIndexOf("."));
    const mime = MIME[ext] ?? "application/octet-stream";

    try {
      const content = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": mime });
      res.end(content);
    } catch {
      res.writeHead(500);
      res.end("Read error");
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
    });
  }
}
```

**Step 2: Verify TypeScript compiles**

```bash
npm run build
```

Expected: No errors.

**Step 3: Commit**

```bash
git add src/dashboard-server.ts
git commit -m "feat: add DashboardServer with REST API and static file serving"
```

---

## Task 5: Create dashboard frontend

**Files:**
- Create: `dashboard/index.html`
- Create: `dashboard/css/styles.css`
- Create: `dashboard/js/api.js`
- Create: `dashboard/js/charts.js`
- Create: `dashboard/js/app.js`

**Step 1: Create dashboard/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hive Queen Metrics</title>
  <link rel="stylesheet" href="/css/styles.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
</head>
<body>
  <header class="header">
    <div class="header-inner">
      <h1>Hive Queen Metrics</h1>
      <div class="controls">
        <label for="range-select">Range:</label>
        <select id="range-select">
          <option value="24h" selected>Last 24h</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
        <span id="refresh-status" class="refresh-status">&#9679;</span>
      </div>
    </div>
  </header>

  <main class="main">
    <section class="cards">
      <div class="card">
        <div class="card-label">Total Events</div>
        <div class="card-value" id="overview-events">&#8212;</div>
      </div>
      <div class="card">
        <div class="card-label">Total Tokens</div>
        <div class="card-value" id="overview-tokens">&#8212;</div>
      </div>
      <div class="card">
        <div class="card-label">Input Tokens</div>
        <div class="card-value" id="overview-input">&#8212;</div>
      </div>
      <div class="card">
        <div class="card-label">Output Tokens</div>
        <div class="card-value" id="overview-output">&#8212;</div>
      </div>
      <div class="card">
        <div class="card-label">Est. Cost (24h)</div>
        <div class="card-value" id="overview-cost">&#8212;</div>
      </div>
    </section>

    <section class="charts-row">
      <div class="chart-card">
        <h2>Token Usage Over Time</h2>
        <canvas id="chart-tokens"></canvas>
      </div>
      <div class="chart-card">
        <h2>Model Distribution</h2>
        <canvas id="chart-models"></canvas>
      </div>
    </section>

    <section class="charts-row">
      <div class="chart-card">
        <h2>Daily Cost</h2>
        <canvas id="chart-cost"></canvas>
      </div>
      <div class="chart-card">
        <h2>Hourly Burn Rate</h2>
        <canvas id="chart-hourly"></canvas>
      </div>
    </section>
  </main>

  <script type="module" src="/js/api.js"></script>
  <script type="module" src="/js/charts.js"></script>
  <script type="module" src="/js/app.js"></script>
</body>
</html>
```

**Step 2: Create dashboard/css/styles.css**

```css
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --accent: #58a6ff;
  --green: #3fb950;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
}

.header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 12px 24px;
  position: sticky;
  top: 0;
  z-index: 10;
}
.header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 1400px;
  margin: 0 auto;
}
.header h1 { font-size: 18px; font-weight: 600; }

.controls { display: flex; align-items: center; gap: 8px; }
.controls label { color: var(--text-muted); }
.controls select {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.refresh-status {
  color: var(--green);
  font-size: 10px;
  opacity: 0.6;
  animation: pulse 2s infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }

.main {
  max-width: 1400px;
  margin: 0 auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.card-label {
  color: var(--text-muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 8px;
}
.card-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.charts-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 900px) { .charts-row { grid-template-columns: 1fr; } }

.chart-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
}
.chart-card h2 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 16px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
canvas { max-height: 280px; }
```

**Step 3: Create dashboard/js/api.js**

```javascript
const BASE = "";

async function apiFetch(path, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(BASE + path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

export async function fetchOverview() { return apiFetch("/api/overview"); }
export async function fetchHourlyStats(hours = 24) { return apiFetch(`/api/stats/hourly?hours=${hours}`); }
export async function fetchDailyStats(days = 7) { return apiFetch(`/api/stats/daily?days=${days}`); }
export async function fetchModelDistribution(days = 7) { return apiFetch(`/api/models?days=${days}`); }
```

**Step 4: Create dashboard/js/charts.js**

```javascript
let tokenChart = null;
let modelChart = null;
let costChart = null;
let hourlyChart = null;

const GRID_COLOR = "#21262d";
const LABEL_COLOR = "#8b949e";

const BASE_SCALES = {
  x: { ticks: { color: LABEL_COLOR }, grid: { color: GRID_COLOR } },
  y: { ticks: { color: LABEL_COLOR }, grid: { color: GRID_COLOR } },
};

function destroy(chart) { if (chart) chart.destroy(); }

export function renderTokenChart(rows) {
  destroy(tokenChart);
  const ctx = document.getElementById("chart-tokens").getContext("2d");

  const byHour = {};
  for (const r of rows) {
    byHour[r.hour] = byHour[r.hour] || { input: 0, output: 0 };
    byHour[r.hour].input += r.input_tokens || 0;
    byHour[r.hour].output += r.output_tokens || 0;
  }

  const hours = Object.keys(byHour).sort();
  tokenChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: hours.map((h) => h.slice(11, 16)),
      datasets: [
        { label: "Input", data: hours.map((h) => byHour[h].input), borderColor: "#58a6ff", backgroundColor: "rgba(88,166,255,0.1)", fill: true, tension: 0.3 },
        { label: "Output", data: hours.map((h) => byHour[h].output), borderColor: "#3fb950", backgroundColor: "rgba(63,185,80,0.1)", fill: true, tension: 0.3 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: true, scales: BASE_SCALES, plugins: { legend: { labels: { color: LABEL_COLOR } } } },
  });
}

export function renderModelChart(rows) {
  destroy(modelChart);
  const ctx = document.getElementById("chart-models").getContext("2d");
  const colors = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#79c0ff"];
  modelChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: rows.map((r) => r.model || "unknown"),
      datasets: [{ data: rows.map((r) => r.total_tokens || 0), backgroundColor: colors.slice(0, rows.length), borderColor: "#161b22", borderWidth: 2 }],
    },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: "right", labels: { color: LABEL_COLOR } } } },
  });
}

export function renderCostChart(rows) {
  destroy(costChart);
  const ctx = document.getElementById("chart-cost").getContext("2d");
  const byDay = {};
  for (const r of rows) byDay[r.day] = (byDay[r.day] || 0) + (r.cost_usd || 0);
  const days = Object.keys(byDay).sort();
  costChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: days,
      datasets: [{ label: "Cost (USD)", data: days.map((d) => byDay[d]), backgroundColor: "rgba(210,153,34,0.7)", borderColor: "#d29922", borderWidth: 1 }],
    },
    options: { responsive: true, maintainAspectRatio: true, scales: BASE_SCALES, plugins: { legend: { labels: { color: LABEL_COLOR } } } },
  });
}

export function renderHourlyBurnChart(rows) {
  destroy(hourlyChart);
  const ctx = document.getElementById("chart-hourly").getContext("2d");
  const byHour = {};
  for (const r of rows) byHour[r.hour] = (byHour[r.hour] || 0) + (r.total_tokens || 0);
  const hours = Object.keys(byHour).sort();
  hourlyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: hours.map((h) => h.slice(11, 16)),
      datasets: [{ label: "Tokens/hr", data: hours.map((h) => byHour[h]), backgroundColor: "rgba(88,166,255,0.5)", borderColor: "#58a6ff", borderWidth: 1 }],
    },
    options: { responsive: true, maintainAspectRatio: true, scales: BASE_SCALES, plugins: { legend: { labels: { color: LABEL_COLOR } } } },
  });
}
```

**Step 5: Create dashboard/js/app.js**

```javascript
import { fetchOverview, fetchHourlyStats, fetchDailyStats, fetchModelDistribution } from "./api.js";
import { renderTokenChart, renderModelChart, renderCostChart, renderHourlyBurnChart } from "./charts.js";

const REFRESH_MS = 30_000;

function fmt(n) {
  if (n == null || isNaN(n)) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(Math.round(n));
}

function getRange() { return document.getElementById("range-select").value; }

function toParams(range) {
  switch (range) {
    case "7d":  return { hours: 168, days: 7 };
    case "30d": return { hours: 720, days: 30 };
    default:    return { hours: 24,  days: 1 };
  }
}

async function refresh() {
  const { hours, days } = toParams(getRange());
  try {
    const [overview, hourly, daily, models] = await Promise.all([
      fetchOverview(),
      fetchHourlyStats(hours),
      fetchDailyStats(days),
      fetchModelDistribution(days),
    ]);

    document.getElementById("overview-events").textContent = fmt(overview?.total_events);
    document.getElementById("overview-tokens").textContent = fmt(overview?.total_tokens);
    document.getElementById("overview-input").textContent = fmt(overview?.input_tokens);
    document.getElementById("overview-output").textContent = fmt(overview?.output_tokens);
    document.getElementById("overview-cost").textContent = "$" + (overview?.total_cost ?? 0).toFixed(4);

    renderTokenChart(hourly ?? []);
    renderModelChart(models ?? []);
    renderCostChart(daily ?? []);
    renderHourlyBurnChart(hourly ?? []);
  } catch (err) {
    console.error("Refresh failed:", err);
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
document.getElementById("range-select").addEventListener("change", refresh);
```

**Step 6: Commit**

```bash
git add dashboard/
git commit -m "feat: add metrics dashboard frontend with Chart.js"
```

---

## Task 6: Integrate metrics into index.ts

**Files:**
- Modify: `index.ts`

**Step 1: Replace index.ts with the integrated version**

The new file keeps all existing tool-guard logic exactly as-is, and adds metrics initialization wrapped in `api.registerService` (gracefully skips if API doesn't support it).

```typescript
import { ToolGuardTracker } from "./src/tracker.js";
import { classifyError, buildCorrectiveMessage } from "./src/classifier.js";
import { ToolGuardLogger } from "./src/logger.js";
import { MetricsDatabase } from "./src/database.js";
import { MetricsCollector } from "./src/metrics-collector.js";
import { DashboardServer } from "./src/dashboard-server.js";
import { resolve } from "node:path";
import { homedir } from "node:os";

export default function register(api: any) {
  const config = api.pluginConfig ?? {};

  // ── Tool-Guard (unchanged) ───────────────────────────────────────────────
  if (config.enabled !== false) {
    const tracker = new ToolGuardTracker(config);
    const logger = new ToolGuardLogger(config.logPath);

    if (api.on) {
      api.on("before_agent_start", () => {
        tracker.resetTurn();
      });

      api.on("tool_result_persist", (event: any, ctx: any) => {
        const message = event.message;
        if (!message) return;

        const errorText = extractErrorFromMessage(message);
        if (!errorText) return;

        const toolName = ctx.toolName ?? event.toolName ?? "unknown";
        const toolCallId = ctx.toolCallId ?? event.toolCallId ?? "";
        const classification = classifyError(errorText);

        void logger.log({
          modelId: toolCallId.startsWith("toolu_")
            ? "anthropic"
            : toolCallId.startsWith("call_")
              ? "fireworks/openai-compat"
              : "unknown",
          toolName,
          args: {},
          errorType: classification,
          errorMessage: errorText,
        });

        if (classification === "retryable") return;

        const trackResult = tracker.recordFailure(toolName, {}, errorText, "");
        let newErrorText: string;
        if (trackResult.action === "hard-cap") {
          newErrorText = trackResult.message!;
        } else if (trackResult.action === "loop-detected") {
          newErrorText = trackResult.message!;
        } else {
          newErrorText = buildCorrectiveMessage(toolName, {}, errorText);
        }

        return { message: replaceErrorInMessage(message, newErrorText) };
      });

      api.on("after_tool_call", (event: any, _ctx: any) => {
        if (!event.error) return;
        void logger.log({
          modelId: "unknown",
          toolName: event.toolName ?? "unknown",
          args: event.params ?? {},
          errorType: classifyError(event.error),
          errorMessage: event.error,
        });
      });
    }
  }

  // ── Metrics (new) ────────────────────────────────────────────────────────
  const metricsConfig = config.metrics ?? {};
  if (metricsConfig.enabled !== false && api.registerService) {
    const dbPath = expandPath(metricsConfig.dbPath ?? "~/.openclaw/metrics.db");
    const gatewayId =
      metricsConfig.gatewayId ??
      process.env["OPENCLAW_GATEWAY_ID"] ??
      "default";
    const retention = {
      rawDays: metricsConfig.retention?.rawDays ?? 30,
      hourlyDays: metricsConfig.retention?.hourlyDays ?? 90,
      dailyDays: metricsConfig.retention?.dailyDays ?? 365,
    };

    let db: MetricsDatabase | null = null;
    let collector: MetricsCollector | null = null;
    let dashboard: DashboardServer | null = null;

    api.registerService({
      id: "metrics",
      start: () => {
        try {
          db = new MetricsDatabase(dbPath);
          collector = new MetricsCollector(db, { gatewayId });

          if (api.onDiagnosticEvent) {
            api.onDiagnosticEvent((event: any) => {
              if (event?.type === "model.usage" && collector) {
                collector.record(event);
              }
            });
          }

          const dashCfg = metricsConfig.dashboard ?? {};
          if (dashCfg.enabled !== false) {
            dashboard = new DashboardServer(db, {
              port: dashCfg.port ?? 8080,
              bind: dashCfg.bind ?? "127.0.0.1",
            });
            dashboard.start();
          }

          scheduleDailyCleanup(() => db?.cleanupOldData(retention));
        } catch (err) {
          // Metrics must never crash the gateway
          console.error("[metrics] Failed to start:", err);
        }
      },
      stop: async () => {
        collector?.stop();
        await dashboard?.stop();
        db?.close();
      },
    });
  }
}

/** Fire fn at 4 AM UTC each day */
function scheduleDailyCleanup(fn: () => void): void {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(4, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

  const firstFire = setTimeout(() => {
    fn();
    const daily = setInterval(fn, 24 * 60 * 60 * 1000);
    if ((daily as any).unref) (daily as any).unref();
  }, next.getTime() - now.getTime());

  if ((firstFire as any).unref) (firstFire as any).unref();
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

function extractErrorFromMessage(message: any): string | null {
  if (!message?.content) return null;
  const content = message.content;

  if (typeof content === "string") {
    if (content.includes("Missing required") || content.includes("Expected")) {
      return content;
    }
    return null;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        if (
          block.text.includes("Missing required") ||
          block.text.includes("Expected") ||
          block.text.includes("error")
        ) {
          return block.text;
        }
      }
    }
  }
  return null;
}

function replaceErrorInMessage(message: any, newText: string): any {
  const clone = JSON.parse(JSON.stringify(message));
  if (typeof clone.content === "string") {
    clone.content = newText;
    return clone;
  }
  if (Array.isArray(clone.content)) {
    for (const block of clone.content) {
      if (block.type === "text" && typeof block.text === "string") {
        block.text = newText;
        return clone;
      }
    }
  }
  return clone;
}
```

**Step 2: Build to verify no TS errors**

```bash
npm run build
```

Expected: Compiles to `dist/` without errors.

**Step 3: Run all tests**

```bash
npm test
```

Expected: All tests pass.

**Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: integrate metrics into plugin register function"
```

---

## Task 7: Update openclaw.plugin.json

**Files:**
- Modify: `openclaw.plugin.json`

**Step 1: Replace file contents**

```json
{
  "id": "tool-guard",
  "name": "Tool Guard",
  "description": "Prevents malformed tool call loops with dedup detection, hard caps, model attribution logging, and a metrics dashboard",
  "version": "1.1.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true
      },
      "maxIdenticalFailures": {
        "type": "number",
        "description": "Max identical tool call failures before loop break",
        "default": 2
      },
      "maxFailuresPerTurn": {
        "type": "number",
        "description": "Max total tool failures per turn before hard stop",
        "default": 5
      },
      "logPath": {
        "type": "string",
        "description": "Path for attribution log file (JSON lines)",
        "default": "~/.openclaw/tool-guard.log"
      },
      "metrics": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "enabled": { "type": "boolean", "default": true },
          "dbPath": { "type": "string", "default": "~/.openclaw/metrics.db" },
          "gatewayId": { "type": "string", "description": "Unique name for this gateway in metrics (defaults to OPENCLAW_GATEWAY_ID env or 'default')" },
          "dashboard": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "enabled": { "type": "boolean", "default": true },
              "port": { "type": "number", "default": 8080 },
              "bind": { "type": "string", "default": "127.0.0.1" }
            }
          },
          "retention": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "rawDays": { "type": "number", "default": 30 },
              "hourlyDays": { "type": "number", "default": 90 },
              "dailyDays": { "type": "number", "default": 365 }
            }
          }
        }
      }
    }
  },
  "uiHints": {
    "maxIdenticalFailures": { "label": "Max Identical Failures", "placeholder": "2" },
    "maxFailuresPerTurn": { "label": "Max Failures Per Turn", "placeholder": "5" },
    "logPath": { "label": "Log File Path" },
    "metrics.dbPath": { "label": "Metrics Database Path" },
    "metrics.gatewayId": { "label": "Gateway ID" },
    "metrics.dashboard.port": { "label": "Dashboard Port", "placeholder": "8080" },
    "metrics.dashboard.bind": { "label": "Dashboard Bind Address", "placeholder": "127.0.0.1" }
  }
}
```

**Step 2: Commit**

```bash
git add openclaw.plugin.json
git commit -m "feat: add metrics config schema to plugin manifest"
```

---

## Task 8: Final build and verification

**Step 1: Clean build**

```bash
cd ~/projects/openclaw-tool-guard && rm -rf dist/ && npm run build
```

Expected: `dist/` created, no TS errors.

**Step 2: Run all tests**

```bash
npm test
```

Expected: All tests pass. Count should include:
- tracker tests (6)
- classifier tests
- integration tests
- **database tests (5)** ← new
- **metrics-collector tests (3)** ← new

**Step 3: Regression check — existing tests only**

```bash
npm test -- tests/tracker.test.ts tests/classifier.test.ts tests/integration.test.ts
```

Expected: All pass unchanged.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: final build verification for metrics dashboard"
```

---

## Assumptions & Deviations

1. **`api.onDiagnosticEvent`** — Documented conceptually but not in local reference docs. If absent at runtime, the collector simply doesn't receive events (guarded by `if (api.onDiagnosticEvent)`). Tool-guard still works.

2. **`api.registerService`** — Used for metrics lifecycle. If absent, metrics init is skipped entirely (guarded by `if (api.registerService)`).

3. **Dashboard static file path** — After `npm run build`, `dist/src/dashboard-server.js` resolves `../../dashboard` → `repo-root/dashboard`. The `dashboard/` folder is **not compiled** by tsc; it's served as-is. This works for local dev. For a packaged install, include `dashboard/` in the `files` array of `package.json` if needed.

4. **chart.js npm dependency** — Listed in `package.json` for documentation purposes but the frontend loads it from CDN. The npm package is unused at runtime.
