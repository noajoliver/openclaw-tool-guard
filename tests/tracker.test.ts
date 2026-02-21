import { describe, it, expect } from "vitest";
import { ToolGuardTracker } from "../src/tracker.js";

describe("ToolGuardTracker", () => {
  it("returns 'continue' on first failure", () => {
    const tracker = new ToolGuardTracker();
    const result = tracker.recordFailure("read", {}, "Missing required parameter: path", "unknown");
    expect(result.action).toBe("continue");
  });

  it("detects loop after 2 identical failures", () => {
    const tracker = new ToolGuardTracker();
    tracker.recordFailure("read", {}, "Missing required parameter: path", "unknown");
    const result = tracker.recordFailure("read", {}, "Missing required parameter: path", "unknown");
    expect(result.action).toBe("loop-detected");
    expect(result.message).toContain("[LOOP DETECTED]");
  });

  it("triggers hard cap after 5 total failures", () => {
    const tracker = new ToolGuardTracker();
    for (let i = 0; i < 4; i++) {
      tracker.recordFailure(`tool${i}`, {}, `error${i}`, "unknown");
    }
    const result = tracker.recordFailure("tool4", {}, "error4", "unknown");
    expect(result.action).toBe("hard-cap");
    expect(result.message).toContain("[TOOL ERROR LIMIT]");
  });

  it("resets failure counts between turns", () => {
    const tracker = new ToolGuardTracker();
    tracker.recordFailure("read", {}, "error", "unknown");
    tracker.resetTurn();
    const result = tracker.recordFailure("read", {}, "error", "unknown");
    expect(result.action).toBe("continue");
  });

  it("respects custom maxIdenticalFailures config", () => {
    const tracker = new ToolGuardTracker({ maxIdenticalFailures: 3 });
    tracker.recordFailure("read", {}, "error", "unknown");
    const r2 = tracker.recordFailure("read", {}, "error", "unknown");
    expect(r2.action).toBe("continue");
    const r3 = tracker.recordFailure("read", {}, "error", "unknown");
    expect(r3.action).toBe("loop-detected");
  });

  it("does not count different tool/arg/error combos as identical", () => {
    const tracker = new ToolGuardTracker();
    tracker.recordFailure("read", {}, "error1", "unknown");
    const result = tracker.recordFailure("read", {}, "error2", "unknown");
    expect(result.action).toBe("continue");
  });
});
