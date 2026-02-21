import { TOOL_SCHEMAS, PARAM_ALIASES } from "./constants.js";

const NON_RETRYABLE_PATTERNS = [
  /Missing required parameter:/i,
  /Missing parameters for/i,
  /Expected .* but received/i,
  /Missing required/i,
  /type.*error/i,
];

export function classifyError(errorMessage: string): "retryable" | "non-retryable" {
  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return "non-retryable";
    }
  }
  return "retryable";
}

export function inferModelFromToolCallId(toolCallId: string): string {
  if (toolCallId.startsWith("toolu_")) return "anthropic";
  if (toolCallId.startsWith("call_")) return "fireworks/openai-compat";
  return "unknown";
}

export function buildCorrectiveMessage(
  toolName: string,
  args: Record<string, unknown>,
  originalError: string,
): string {
  const schema = TOOL_SCHEMAS[toolName];
  if (!schema) {
    return (
      `[TOOL ERROR] ${toolName}() failed: ${originalError}. ` +
      `Check required parameters and retry with correct arguments.`
    );
  }

  const sentArgs = JSON.stringify(args);
  const missingParams: string[] = [];

  for (const param of schema.required) {
    const aliases = PARAM_ALIASES[param] ?? [param];
    const hasParam = aliases.some((alias) => alias in args && args[alias] != null);
    if (!hasParam) {
      missingParams.push(param);
    }
  }

  const missing = missingParams.length > 0
    ? missingParams.map((p) => `'${p}'`).join(", ")
    : "valid values for its parameters";

  return (
    `[TOOL ERROR] ${toolName}() requires ${missing}. ` +
    `Correct usage: ${schema.usage}. ` +
    `You sent: ${toolName}(${sentArgs}). ` +
    `Fix your call and retry.`
  );
}
