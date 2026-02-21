import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export interface LogEntry {
  timestamp: string;
  modelId: string;
  toolName: string;
  args: unknown;
  errorType: string;
  errorMessage: string;
}

export class ToolGuardLogger {
  private readonly logPath: string;
  private initialized = false;

  constructor(logPath?: string) {
    this.logPath = expandPath(logPath ?? "~/.openclaw/tool-guard.log");
  }

  async log(entry: Omit<LogEntry, "timestamp">): Promise<void> {
    const fullEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    try {
      if (!this.initialized) {
        await mkdir(dirname(this.logPath), { recursive: true });
        this.initialized = true;
      }
      await appendFile(this.logPath, JSON.stringify(fullEntry) + "\n", "utf-8");
    } catch {
      // Logging failures should not break tool execution
    }
  }

  getLogPath(): string {
    return this.logPath;
  }
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}
