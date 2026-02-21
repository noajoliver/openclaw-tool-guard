import { describe, it, expect } from "vitest";
import { classifyError, inferModelFromToolCallId, buildCorrectiveMessage } from "../src/classifier.js";

describe("classifyError", () => {
  it("classifies 'Missing required parameter:' as non-retryable", () => {
    expect(classifyError("Missing required parameter: path")).toBe("non-retryable");
  });

  it("classifies 'Missing parameters for' as non-retryable", () => {
    expect(classifyError("Missing parameters for read")).toBe("non-retryable");
  });

  it("classifies 'Expected string but received undefined' as non-retryable", () => {
    expect(classifyError("Expected string but received undefined")).toBe("non-retryable");
  });

  it("classifies 'Missing required' as non-retryable", () => {
    expect(classifyError("Missing required field")).toBe("non-retryable");
  });

  it("classifies 'type error' as non-retryable", () => {
    expect(classifyError("type error in parameter")).toBe("non-retryable");
  });

  it("classifies timeout errors as retryable", () => {
    expect(classifyError("Request timed out after 30s")).toBe("retryable");
  });
});

describe("inferModelFromToolCallId", () => {
  it("identifies Anthropic model from toolu_ prefix", () => {
    expect(inferModelFromToolCallId("toolu_abc123")).toBe("anthropic");
  });

  it("identifies Fireworks/OpenAI-compat model from call_ prefix", () => {
    expect(inferModelFromToolCallId("call_xyz789")).toBe("fireworks/openai-compat");
  });

  it("returns 'unknown' for unrecognized prefixes", () => {
    expect(inferModelFromToolCallId("other_prefix")).toBe("unknown");
  });
});

describe("buildCorrectiveMessage", () => {
  it("builds corrective message for read() with missing path", () => {
    const msg = buildCorrectiveMessage("read", {}, "Missing required parameter: path");
    expect(msg).toContain("[TOOL ERROR]");
    expect(msg).toContain("read()");
    expect(msg).toContain("'path'");
    expect(msg).toContain("Fix your call and retry.");
  });

  it("builds generic message for unknown tools", () => {
    const msg = buildCorrectiveMessage("unknown_tool", {}, "some error");
    expect(msg).toContain("[TOOL ERROR]");
    expect(msg).toContain("unknown_tool()");
    expect(msg).toContain("Check required parameters");
  });

  it("recognizes path alias file_path", () => {
    const msg = buildCorrectiveMessage("read", { file_path: "/foo" }, "error");
    expect(msg).not.toContain("'path'");
  });

  it("builds corrective message for edit() with missing params", () => {
    const msg = buildCorrectiveMessage("edit", {}, "Missing required parameter: old_string");
    expect(msg).toContain("'path'");
    expect(msg).toContain("'old_string'");
    expect(msg).toContain("'new_string'");
  });

  it("builds corrective message for write() showing only missing content", () => {
    const msg = buildCorrectiveMessage("write", { path: "file.ts" }, "Missing required parameter: content");
    expect(msg).toContain("'content'");
    expect(msg).not.toContain("'path'");
  });

  it("builds corrective message for exec() with missing command", () => {
    const msg = buildCorrectiveMessage("exec", {}, "Missing required parameter: command");
    expect(msg).toContain("'command'");
    expect(msg).toContain("exec()");
  });
});
