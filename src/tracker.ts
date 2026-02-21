export class ToolGuardTracker {
  private failures: Map<string, number> = new Map();
  private totalFailures = 0;
  private maxIdentical: number;
  private maxPerTurn: number;

  constructor(config: { maxIdenticalFailures?: number; maxFailuresPerTurn?: number } = {}) {
    this.maxIdentical = config.maxIdenticalFailures ?? 2;
    this.maxPerTurn = config.maxFailuresPerTurn ?? 5;
  }

  recordFailure(toolName: string, args: unknown, error: string, modelId: string): { action: string; message?: string } {
    this.totalFailures++;

    if (this.totalFailures >= this.maxPerTurn) {
      return {
        action: "hard-cap",
        message: `[TOOL ERROR LIMIT] ${this.totalFailures} tool failures in this turn. Stopping tool execution. Review your approach before continuing.`,
      };
    }

    const errorNorm = error.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
    const argsStr = JSON.stringify(args ?? {});
    const key = `${toolName}:${argsStr}:${errorNorm}`;

    const count = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, count);

    if (count >= this.maxIdentical) {
      return {
        action: "loop-detected",
        message: `[LOOP DETECTED] Tool "${toolName}" failed ${count} times with identical arguments. This is a non-retryable error. Do NOT retry this call. Try a different approach or report the issue.`,
      };
    }

    return { action: "continue" };
  }

  resetTurn(): void {
    this.failures.clear();
    this.totalFailures = 0;
  }
}
