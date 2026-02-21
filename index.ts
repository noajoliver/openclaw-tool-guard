import { ToolGuardTracker } from "./src/tracker.js";
import { classifyError, buildCorrectiveMessage, inferModelFromToolCallId } from "./src/classifier.js";
import { ToolGuardLogger } from "./src/logger.js";

interface PluginApi {
  config?: {
    plugins?: {
      entries?: Record<string, { config?: Record<string, unknown> }>;
    };
  };
  registerHook?(
    events: string | string[],
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
    opts?: { priority?: number; name?: string; description?: string },
  ): void;
  on?(
    hookName: string,
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
    opts?: { priority?: number },
  ): void;
}

interface ToolResultPersistEvent {
  toolName?: string;
  toolCallId?: string;
  message: {
    role: string;
    content?: string | Array<{ type: string; tool_use_id?: string; text?: string; content?: string | Array<{ type: string; text?: string }> }>;
  };
  isSynthetic?: boolean;
}

interface ToolResultPersistCtx {
  agentId?: string;
  sessionKey?: string;
  toolName?: string;
  toolCallId?: string;
}

export default function register(api: PluginApi) {

  // Delayed check to see if hooks are visible after registration
  const config = (api.config?.plugins?.entries?.["tool-guard"]?.config ?? {}) as Record<string, unknown>;
  if (config.enabled === false) return;

  const tracker = new ToolGuardTracker(config as { maxIdenticalFailures?: number; maxFailuresPerTurn?: number });
  const logger = new ToolGuardLogger(config.logPath as string | undefined);

  if (!api.on) return;

  // Reset failure tracking at the start of each agent turn
  // Use registerHook for visibility in `openclaw hooks list`
  api.registerHook?.("before_agent_start", () => {
    tracker.resetTurn();
  }, { name: "tool-guard-reset", description: "Reset failure tracking at turn start" });

  // Also register via api.on() which feeds into the typed hook runner
  api.on("before_agent_start", () => {
    tracker.resetTurn();
  });

  // Try before_tool_call and after_tool_call as diagnostic
  api.on("before_tool_call", (event: Record<string, unknown>) => {
  });

  api.on("after_tool_call", (event: Record<string, unknown>) => {
    const e = event as {toolName?: string; error?: string};
  });

  // Intercept tool results before they're persisted to the session transcript.
  // api.on() is required — registerHook goes to file-based hooks, not typed hooks.
  api.on("tool_result_persist", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
    const e = event as unknown as ToolResultPersistEvent;
    const c = ctx as unknown as ToolResultPersistCtx;
    const toolName = e.toolName ?? c.toolName ?? "";
    const toolCallId = e.toolCallId ?? c.toolCallId ?? "";


    // Extract error text from the message content
    const errorText = extractErrorFromMessage(e.message);
    if (!errorText) return; // Not an error result, pass through

    const classification = classifyError(errorText);
    const modelId = inferModelFromToolCallId(toolCallId);

    // Log asynchronously (fire and forget)
    logger.log({
      modelId,
      toolName,
      args: {}, // We don't have args in tool_result_persist, just the result
      errorType: classification,
      errorMessage: errorText,
    }).catch(() => {}); // Swallow logging errors

    // Track ALL errors for loop detection (even retryable ones can loop)
    const trackResult = tracker.recordFailure(toolName, {}, errorText, modelId);

    // For retryable errors with no loop/cap, let the original message through
    if (classification === "retryable" && trackResult.action === "continue") return;

    // Build corrective message
    const corrective = buildCorrectiveMessage(toolName, {}, errorText);

    let newContent: string;
    if (trackResult.action === "hard-cap") {
      newContent = trackResult.message!;
    } else if (trackResult.action === "loop-detected") {
      newContent = trackResult.message!;
    } else {
      newContent = corrective;
    }

    // Return a modified message with our enhanced error
    const modifiedMessage = rewriteMessageContent(e.message, newContent);
    return { message: modifiedMessage };
  });

  // Register for hooks list visibility (display only — real handler is via api.on above)
  api.registerHook?.("tool_result_persist_display", () => {}, { name: "tool-guard-intercept", description: "Intercept and classify tool errors" });
}

/**
 * Extract error text from a tool_result message.
 * Tool results can have various content shapes.
 */
function extractErrorFromMessage(message: ToolResultPersistEvent["message"]): string | null {
  if (!message?.content) return null;

  // String content that looks like an error
  if (typeof message.content === "string") {
    if (isErrorContent(message.content)) return message.content;
    return null;
  }

  // Array content — look for tool_result blocks with errors
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "tool_result" || block.type === "text") {
        // OpenClaw uses block.text for text blocks, block.content for nested
        const text = typeof block.text === "string"
          ? block.text
          : typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.filter((c: {type: string; text?: string}) => c.type === "text").map((c: {text?: string}) => c.text).join("\n")
              : "";
        if (text && isErrorContent(text)) return text;
      }
    }
  }

  return null;
}

/**
 * Check if content looks like a tool error.
 */
function isErrorContent(text: string): boolean {
  const errorPatterns = [
    /^Error:/i,
    /Missing required parameter/i,
    /failed:/i,
    /ENOENT/i,
    /Could not find/i,
    /No such file/i,
    /Command exited with code/i,
    /Permission denied/i,
  ];
  return errorPatterns.some((p) => p.test(text));
}

/**
 * Rewrite the message content with our enhanced error text.
 */
function rewriteMessageContent(
  original: ToolResultPersistEvent["message"],
  newContent: string,
): ToolResultPersistEvent["message"] {
  if (typeof original.content === "string") {
    return { ...original, content: newContent };
  }

  // For array content, replace the first text/tool_result block
  if (Array.isArray(original.content)) {
    const modified = original.content.map((block, i) => {
      if (i === 0 && (block.type === "tool_result" || block.type === "text")) {
        return { ...block, content: newContent };
      }
      return block;
    });
    return { ...original, content: modified };
  }

  return { ...original, content: newContent };
}
