import { ToolGuardTracker } from "./src/tracker.js";
import { classifyError, buildCorrectiveMessage } from "./src/classifier.js";
import { ToolGuardLogger } from "./src/logger.js";

export default function register(api: any) {
  const config = api.pluginConfig ?? {};
  if (config.enabled === false) return;

  const tracker = new ToolGuardTracker(config);
  const logger = new ToolGuardLogger(config.logPath);

  // Reset tracker at the start of each agent turn
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
      // Additional logging with actual params available
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
