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
  private readonly configPort: number;
  private readonly bind: string;
  private readonly dashboardDir: string;

  constructor(
    private readonly db: MetricsDatabase,
    config: DashboardConfig = {},
  ) {
    this.configPort = config.port ?? 8080;
    this.bind = config.bind ?? "127.0.0.1";

    // Resolve dashboard static files relative to this compiled file:
    // dist/src/dashboard-server.js → ../../dashboard → repo-root/dashboard
    const here = fileURLToPath(new URL(".", import.meta.url));
    this.dashboardDir = config.dashboardDir ?? resolve(here, "../../dashboard");
  }

  /** The actual bound port — only valid after start() resolves. */
  get actualPort(): number {
    if (!this.server) throw new Error("Server not started");
    const addr = this.server.address();
    if (!addr || typeof addr === "string") throw new Error("Server address unavailable");
    return addr.port;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        // CORS: allow localhost origins only
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

      this.server.listen(this.configPort, this.bind, () => {
        console.log(`[metrics] Dashboard at http://${this.bind}:${this.actualPort}`);
        resolve();
      });
    });
  }

  private handleApi(path: string, url: URL, res: ReturnType<typeof createServer> extends Server ? any : any): void {
    res.setHeader("Content-Type", "application/json");

    try {
      let data: unknown;

      if (path === "/api/overview") {
        const hours = clampInt(url.searchParams.get("hours"), 24, 1, 24 * 30);
        data = this.buildOverview(hours);

      } else if (path === "/api/timeseries") {
        const hours = clampInt(url.searchParams.get("hours"), 24, 1, 24 * 30);
        const gateway = url.searchParams.get("gateway") ?? undefined;
        const model = url.searchParams.get("model") ?? undefined;
        data = this.buildTimeseries(hours, gateway, model);

      } else if (path === "/api/gateways") {
        data = this.buildGateways();

      } else if (/^\/api\/gateway\/[^/]+$/.test(path)) {
        const id = decodeURIComponent(path.slice("/api/gateway/".length));
        const hours = clampInt(url.searchParams.get("hours"), 24, 1, 24 * 30);
        data = this.buildGateway(id, hours);

      } else if (path === "/api/models") {
        const days = clampInt(url.searchParams.get("days"), 7, 1, 365);
        data = this.buildModels(days);

      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (err: any) {
      console.error("[metrics] API error:", err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err?.message ?? "Internal error" }));
    }
  }

  private buildOverview(hours: number): object {
    const rows = this.db.getHourlyStats(hours);

    let totalTokens = 0;
    let totalCost = 0;
    let totalEvents = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    const gwMap = new Map<string, { tokens: number; cost: number }>();
    const modelMap = new Map<string, { tokens: number; cost: number }>();

    for (const row of rows) {
      const tokens = (row.total_tokens as number) || 0;
      const cost = (row.cost_usd as number) || 0;
      totalTokens += tokens;
      totalCost += cost;
      totalEvents += (row.event_count as number) || 0;
      inputTokens += (row.input_tokens as number) || 0;
      outputTokens += (row.output_tokens as number) || 0;

      const gw = row.gateway_id as string;
      if (gw) {
        const g = gwMap.get(gw) ?? { tokens: 0, cost: 0 };
        g.tokens += tokens;
        g.cost += cost;
        gwMap.set(gw, g);
      }

      const m = row.model as string;
      if (m) {
        const existing = modelMap.get(m) ?? { tokens: 0, cost: 0 };
        existing.tokens += tokens;
        existing.cost += cost;
        modelMap.set(m, existing);
      }
    }

    const topGateways = Array.from(gwMap.entries())
      .map(([id, s]) => ({ id, totalTokens: s.tokens, totalCost: s.cost }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 10);

    const topModels = Array.from(modelMap.entries())
      .map(([id, s]) => ({ id, totalTokens: s.tokens, totalCost: s.cost }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 10);

    return { totalTokens, totalCost, totalEvents, inputTokens, outputTokens, topGateways, topModels };
  }

  private buildTimeseries(hours: number, gateway?: string, model?: string): object[] {
    const rows = this.db.getHourlyStats(hours);
    const tsMap = new Map<string, { tokens: number; cost: number }>();

    for (const row of rows) {
      if (gateway && row.gateway_id !== gateway) continue;
      if (model && row.model !== model) continue;

      const ts = row.hour as string;
      const entry = tsMap.get(ts) ?? { tokens: 0, cost: 0 };
      entry.tokens += (row.total_tokens as number) || 0;
      entry.cost += (row.cost_usd as number) || 0;
      tsMap.set(ts, entry);
    }

    return Array.from(tsMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([timestamp, s]) => ({ timestamp, tokens: s.tokens, cost: s.cost }));
  }

  private buildGateways(): object[] {
    const rows = this.db.getHourlyStats(24);
    const gwMap = new Map<string, { tokens: number; cost: number; models: Map<string, number> }>();

    for (const row of rows) {
      const gw = (row.gateway_id as string) || "";
      if (!gw) continue;

      const entry = gwMap.get(gw) ?? { tokens: 0, cost: 0, models: new Map() };
      const tokens = (row.total_tokens as number) || 0;
      entry.tokens += tokens;
      entry.cost += (row.cost_usd as number) || 0;

      const m = row.model as string;
      if (m) entry.models.set(m, (entry.models.get(m) ?? 0) + tokens);

      gwMap.set(gw, entry);
    }

    return Array.from(gwMap.entries())
      .map(([id, s]) => ({
        id,
        totalTokens24h: s.tokens,
        totalCost24h: s.cost,
        topModel: s.models.size > 0
          ? [...s.models.entries()].sort((a, b) => b[1] - a[1])[0][0]
          : null,
      }))
      .sort((a, b) => b.totalTokens24h - a.totalTokens24h);
  }

  private buildGateway(id: string, hours: number): object {
    const hourly = this.db.getHourlyStats(hours)
      .filter((r: any) => r.gateway_id === id);

    let totalTokens = 0;
    let totalCost = 0;
    let totalEvents = 0;

    for (const r of hourly) {
      totalTokens += (r.total_tokens as number) || 0;
      totalCost += (r.cost_usd as number) || 0;
      totalEvents += (r.event_count as number) || 0;
    }

    return {
      id,
      stats: { totalTokens, totalCost, totalEvents },
      hourly: hourly.map((r: any) => ({
        timestamp: r.hour,
        tokens: r.total_tokens,
        cost: r.cost_usd,
        events: r.event_count,
        model: r.model,
      })),
      sessions: [],
    };
  }

  private buildModels(days: number): object[] {
    const rows = this.db.getModelDistribution(days);
    return rows.map((r: any) => ({
      id: r.model,
      provider: inferProvider(r.model),
      totalTokens: r.total_tokens ?? 0,
      totalCost: r.cost_usd ?? 0,
      avgCostPer1K: r.total_tokens > 0 ? ((r.cost_usd ?? 0) / r.total_tokens) * 1000 : 0,
    }));
  }

  private serveStatic(urlPath: string, res: any): void {
    let filePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
    filePath = join(this.dashboardDir, filePath);

    // Security: prevent path traversal outside dashboardDir
    if (!filePath.startsWith(this.dashboardDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!existsSync(filePath)) {
      // SPA fallback: try index.html
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

function clampInt(value: string | null, defaultVal: number, min: number, max: number): number {
  const n = value !== null ? parseInt(value, 10) : defaultVal;
  return isNaN(n) ? defaultVal : Math.max(min, Math.min(max, n));
}

function inferProvider(model: string): string {
  if (!model) return "unknown";
  if (model.includes("claude")) return "anthropic";
  if (model.includes("gpt") || model.includes("o1") || model.includes("o3")) return "openai";
  if (model.includes("kimi") || model.includes("moonshot")) return "moonshot";
  if (model.includes("glm")) return "zhipu";
  if (model.includes("minimax")) return "minimax";
  return "unknown";
}
