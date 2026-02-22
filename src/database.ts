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
