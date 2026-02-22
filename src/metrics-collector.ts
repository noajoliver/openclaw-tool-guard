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
