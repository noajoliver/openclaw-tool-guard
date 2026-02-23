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

  // ── Tool-Guard ────────────────────────────────────────────────────────────
  if (config.enabled !== false) {
    const tracker = new ToolGuardTracker(config);
    const logger = new ToolGuardLogger(config.logPath);

    if (api.on) {
      api.on("before_agent_start", () => {
        tracker.resetTurn();
      });

      // Use tool_result_persist to modify error messages before they reach the model
      // This hook is synchronous — no async allowed
      api.on("tool_result_persist", (event: any, ctx: any) => {
        const message = event.message;
        if (!message) return;

        // Extract error text from the tool result message
        const errorText = extractErrorFromMessage(message);
        if (!errorText) return; // No error — nothing to do

        const toolName = ctx.toolName ?? event.toolName ?? "unknown";
        const toolCallId = ctx.toolCallId ?? event.toolCallId ?? "";

        const classification = classifyError(errorText);

        // Log asynchronously (fire and forget — logger handles its own errors)
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

        // Track the failure
        const trackResult = tracker.recordFailure(toolName, {}, errorText, "");

        // Build the replacement message
        let newErrorText: string;
        if (trackResult.action === "hard-cap") {
          newErrorText = trackResult.message!;
        } else if (trackResult.action === "loop-detected") {
          newErrorText = trackResult.message!;
        } else {
          // First occurrence — provide corrective guidance
          newErrorText = buildCorrectiveMessage(toolName, {}, errorText);
        }

        // Replace error text in the message content
        return {
          message: replaceErrorInMessage(message, newErrorText),
        };
      });

      // Use after_tool_call for logging with full params (read-only)
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

  // ── Metrics ───────────────────────────────────────────────────────────────
  const metricsConfig = config.metrics ?? {};
  if (metricsConfig.enabled !== false && api.registerService) {
    const dbPath = expandPath(metricsConfig.dbPath ?? "~/.openclaw/metrics.db");
    const gatewayId =
      metricsConfig.gatewayId ??
      api.config?.identity?.name ??
      "unknown";
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
          } else {
            console.log("[metrics] Warning: onDiagnosticEvent not available. Token usage capture requires OpenClaw 2026.3+ or diagnostics-otel plugin enabled.");
          }

          const dashCfg = metricsConfig.dashboard ?? {};
          if (dashCfg.enabled !== false) {
            dashboard = new DashboardServer(db, {
              port: dashCfg.port ?? 8082,
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

/** Extract error text from an AgentMessage's content blocks */
function extractErrorFromMessage(message: any): string | null {
  if (!message?.content) return null;
  const content = message.content;

  // content can be string or array of blocks
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

/** Replace error text in message content blocks */
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
