import { describe, it, expect } from "vitest";
import { ToolGuardLogger } from "../src/logger.js";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ToolGuardLogger", () => {
  it("writes a JSON line to the log file", async () => {
    const logPath = join(tmpdir(), `tool-guard-test-${Date.now()}.log`);
    const logger = new ToolGuardLogger(logPath);
    await logger.log({
      modelId: "fireworks/openai-compat",
      toolName: "read",
      args: {},
      errorType: "non-retryable",
      errorMessage: "Missing required parameter: path",
    });
    const content = readFileSync(logPath, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.modelId).toBe("fireworks/openai-compat");
    expect(entry.toolName).toBe("read");
    expect(entry.timestamp).toBeDefined();
    rmSync(logPath, { force: true });
  });

  it("expands ~ in default log path", () => {
    const logger = new ToolGuardLogger();
    expect(logger.getLogPath()).not.toContain("~");
    expect(logger.getLogPath()).toContain("tool-guard.log");
  });
});

describe("end-to-end: 3-layer defense", () => {
  it("Layer A corrects, Layer B breaks loop on identical calls", async () => {
    const { ToolGuardTracker } = await import("../src/tracker.js");
    const { classifyError, buildCorrectiveMessage } = await import("../src/classifier.js");

    const tracker = new ToolGuardTracker();
    const error = "Missing required parameter: path";

    // Layer A: corrective message
    const classification = classifyError(error);
    expect(classification).toBe("non-retryable");
    const corrective = buildCorrectiveMessage("read", {}, error);
    expect(corrective).toContain("[TOOL ERROR]");

    // Layer B: first call continues, second triggers loop detection
    const r1 = tracker.recordFailure("read", {}, error, "unknown");
    expect(r1.action).toBe("continue");
    const r2 = tracker.recordFailure("read", {}, error, "unknown");
    expect(r2.action).toBe("loop-detected");
  });
});

describe("plugin entry point", () => {
  it("exports a register function", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.default).toBe("function");
  });

  it("register function accepts an api object without throwing", async () => {
    const mod = await import("../index.js");
    const api = {
      pluginConfig: {},
      registerHook: (_name: string, _handler: Function) => {},
      on: (_name: string, _handler: Function) => {},
    };
    expect(() => mod.default(api)).not.toThrow();
  });

  it("registers tool_result_persist and before_agent_start hooks", async () => {
    const mod = await import("../index.js");
    const hooks: Record<string, Function> = {};
    const api = {
      pluginConfig: {},
      registerHook: (name: string, handler: Function) => { hooks[name] = handler; },
      on: (name: string, handler: Function) => { hooks[name] = handler; },
    };
    mod.default(api);
    expect(hooks["tool_result_persist"]).toBeDefined();
    expect(hooks["before_agent_start"]).toBeDefined();
  });

  it("hook rewrites non-retryable error with corrective message", async () => {
    const mod = await import("../index.js");
    const hooks: Record<string, Function> = {};
    const api = {
      pluginConfig: { logPath: join(tmpdir(), `tg-test-${Date.now()}.log`) },
      registerHook: (name: string, handler: Function) => { hooks[name] = handler; },
      on: (name: string, handler: Function) => { hooks[name] = handler; },
    };
    mod.default(api);
    const event = {
      toolName: "read",
      toolCallId: "call_abc",
      message: {
        role: "tool",
        content: "Error: Missing required parameter: path",
      },
    };
    const ctx = { toolName: "read", toolCallId: "call_abc" };
    const result = await hooks["tool_result_persist"](event, ctx);
    expect(result).toBeDefined();
    expect(result.message.content).toContain("[TOOL ERROR]");
    expect(result.message.content).toContain("read()");
  });

  it("hook triggers loop detection after 2 identical non-retryable failures", async () => {
    const mod = await import("../index.js");
    const hooks: Record<string, Function> = {};
    const api = {
      pluginConfig: { logPath: join(tmpdir(), `tg-loop-${Date.now()}.log`) },
      registerHook: (name: string, handler: Function) => { hooks[name] = handler; },
      on: (name: string, handler: Function) => { hooks[name] = handler; },
    };
    mod.default(api);

    const makeEvent = () => ({
      toolName: "read",
      toolCallId: "call_abc",
      message: {
        role: "tool",
        content: "Error: Missing required parameter: path",
      },
    });
    const ctx = { toolName: "read", toolCallId: "call_abc" };

    const r1 = await hooks["tool_result_persist"](makeEvent(), ctx);
    expect(r1.message.content).toContain("[TOOL ERROR]");

    const r2 = await hooks["tool_result_persist"](makeEvent(), ctx);
    expect(r2.message.content).toContain("[LOOP DETECTED]");
  });

  it("hook triggers hard cap after 5 total failures", async () => {
    const mod = await import("../index.js");
    const hooks: Record<string, Function> = {};
    const api = {
      pluginConfig: { logPath: join(tmpdir(), `tg-cap-${Date.now()}.log`) },
      registerHook: (name: string, handler: Function) => { hooks[name] = handler; },
      on: (name: string, handler: Function) => { hooks[name] = handler; },
    };
    mod.default(api);

    const ctx = { toolName: "read", toolCallId: "call_x" };
    for (let i = 0; i < 4; i++) {
      const event = {
        toolName: `tool${i}`,
        toolCallId: "call_x",
        message: { role: "tool", content: "Error: Missing required parameter: x" },
      };
      await hooks["tool_result_persist"](event, { ...ctx, toolName: `tool${i}` });
    }
    const event5 = {
      toolName: "tool4",
      toolCallId: "call_x",
      message: { role: "tool", content: "Error: Missing required parameter: x" },
    };
    const r5 = await hooks["tool_result_persist"](event5, { ...ctx, toolName: "tool4" });
    expect(r5.message.content).toContain("[TOOL ERROR LIMIT]");
  });

  it("hook logs failures with model attribution", async () => {
    const mod = await import("../index.js");
    const hooks: Record<string, Function> = {};
    const logPath = join(tmpdir(), `tg-attr-${Date.now()}.log`);
    const api = {
      pluginConfig: { logPath },
      registerHook: (name: string, handler: Function) => { hooks[name] = handler; },
      on: (name: string, handler: Function) => { hooks[name] = handler; },
    };
    mod.default(api);
    const event = {
      toolName: "read",
      toolCallId: "call_fireworks_123",
      message: { role: "tool", content: "Error: Missing required parameter: path" },
    };
    const ctx = { toolName: "read", toolCallId: "call_fireworks_123" };
    await hooks["tool_result_persist"](event, ctx);
    // Give async logger a moment
    await new Promise((r) => setTimeout(r, 100));
    const content = readFileSync(logPath, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.modelId).toBe("fireworks/openai-compat");
    expect(entry.toolName).toBe("read");
    rmSync(logPath, { force: true });
  });

  it("passes through retryable errors unchanged", async () => {
    const mod = await import("../index.js");
    const hooks: Record<string, Function> = {};
    const api = {
      pluginConfig: { logPath: join(tmpdir(), `tg-ret-${Date.now()}.log`) },
      registerHook: (name: string, handler: Function) => { hooks[name] = handler; },
      on: (name: string, handler: Function) => { hooks[name] = handler; },
    };
    mod.default(api);
    const event = {
      toolName: "exec",
      toolCallId: "call_abc",
      message: { role: "tool", content: "Error: Command exited with code 1" },
    };
    const ctx = { toolName: "exec", toolCallId: "call_abc" };
    const result = await hooks["tool_result_persist"](event, ctx);
    // Command exit code 1 matches "Command exited with code" pattern so it IS caught
    // But it's a retryable error... wait, let me check
    expect(result).toBeUndefined(); // retryable errors pass through
  });

  it("passes through non-error results unchanged", async () => {
    const mod = await import("../index.js");
    const hooks: Record<string, Function> = {};
    const api = {
      pluginConfig: {},
      registerHook: (name: string, handler: Function) => { hooks[name] = handler; },
      on: (name: string, handler: Function) => { hooks[name] = handler; },
    };
    mod.default(api);
    const event = {
      toolName: "read",
      toolCallId: "call_abc",
      message: { role: "tool", content: "File contents here..." },
    };
    const ctx = { toolName: "read", toolCallId: "call_abc" };
    const result = await hooks["tool_result_persist"](event, ctx);
    expect(result).toBeUndefined();
  });

  it("does not register hooks when enabled is false", async () => {
    const mod = await import("../index.js");
    const hooks: Record<string, Function> = {};
    const api = {
      pluginConfig: { enabled: false },
      registerHook: (name: string, handler: Function) => { hooks[name] = handler; },
      on: (name: string, handler: Function) => { hooks[name] = handler; },
    };
    mod.default(api);
    expect(hooks["tool_result_persist"]).toBeUndefined();
  });
});
