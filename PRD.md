# PRD: openclaw-tool-guard

## Overview

An OpenClaw plugin that prevents malformed tool calls from looping indefinitely. When models (especially non-Anthropic models like MiniMax M2.5) generate tool calls with missing required parameters, the current behavior is an infinite retry loop until the turn timeout (180-600s) or context window exhaustion. This plugin detects and breaks those loops early.

**Repo:** `noajoliver/openclaw-tool-guard`  
**License:** MIT  
**Related issue:** [openclaw/openclaw#14729](https://github.com/openclaw/openclaw/issues/14729)

## Problem

1. Model calls `read({})` without required `path` parameter
2. OpenClaw returns error: "Missing required parameter: path"
3. Model retries identical broken call
4. Loop continues until timeout (minutes of wasted time/tokens)
5. No mechanism to distinguish retryable vs non-retryable tool errors

This affects any non-Anthropic model routed through OpenClaw's tool system. We observed it with MiniMax M2.5 via Fireworks on both `read` (missing `path`) and `edit` (missing `oldText`).

## Solution: 3-Layer Defense

### Layer A: Non-Retryable Error Tagging

When a tool call fails with a deterministic validation error (missing required param, type mismatch), append `[NON-RETRYABLE]` to the error message returned to the model. This gives the model a signal to try a different approach rather than retrying the same call.

**Detection patterns:**
- `Missing required parameter:`
- `Expected .* but received`
- `Missing parameters for`

### Layer B: Per-Turn Dedup Loop Breaker

Track `(toolName, normalizedArgs, errorSignature)` tuples within each assistant turn. After **2 identical failing calls**, return a terminal error:

```
[LOOP DETECTED] Tool "{name}" failed 2 times with identical arguments. 
This is a non-retryable error. Do NOT retry this call. 
Try a different approach or report the issue.
```

### Layer C: Hard Cap Per Turn

After **5 total tool failures** in a single assistant turn (regardless of uniqueness), return a terminal error and stop further tool execution for that turn:

```
[TOOL ERROR LIMIT] {count} tool failures in this turn. 
Stopping tool execution. Review your approach before continuing.
```

### Layer D: Model Attribution Logging

Log which model generated each malformed tool call, including:
- Model ID (from tool call ID prefix: `call_*` = Fireworks/MiniMax, `toolu_*` = Anthropic)
- Tool name + args attempted
- Error type
- Timestamp

Write to a configurable log file (default: `~/.openclaw/tool-guard.log`) in JSON lines format.

## Plugin Architecture

### File Structure

```
openclaw-tool-guard/
├── openclaw.plugin.json     # Plugin manifest
├── index.ts                  # Plugin entry point
├── src/
│   ├── tracker.ts           # Per-turn failure tracking
│   ├── classifier.ts        # Error classification (retryable vs not)
│   ├── logger.ts            # Model attribution logging
│   └── constants.ts         # Configurable limits
├── tests/
│   ├── tracker.test.ts
│   ├── classifier.test.ts
│   └── integration.test.ts
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

### Plugin Manifest (`openclaw.plugin.json`)

```json
{
  "id": "tool-guard",
  "name": "Tool Guard",
  "description": "Prevents malformed tool call loops with dedup detection, hard caps, and model attribution logging",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "maxIdenticalFailures": {
        "type": "number",
        "description": "Max identical tool call failures before loop break",
        "default": 2
      },
      "maxFailuresPerTurn": {
        "type": "number",
        "description": "Max total tool failures per turn before hard stop",
        "default": 5
      },
      "logPath": {
        "type": "string",
        "description": "Path for attribution log file (JSON lines)",
        "default": "~/.openclaw/tool-guard.log"
      },
      "enabled": {
        "type": "boolean",
        "default": true
      }
    }
  },
  "uiHints": {
    "maxIdenticalFailures": { "label": "Max Identical Failures", "placeholder": "2" },
    "maxFailuresPerTurn": { "label": "Max Failures Per Turn", "placeholder": "5" },
    "logPath": { "label": "Log File Path" }
  }
}
```

### Entry Point (`index.ts`)

```typescript
import { ToolGuardTracker } from "./src/tracker";
import { classifyError } from "./src/classifier";
import { ToolGuardLogger } from "./src/logger";

export default function register(api: any) {
  const config = api.config?.plugins?.entries?.["tool-guard"]?.config ?? {};
  const tracker = new ToolGuardTracker(config);
  const logger = new ToolGuardLogger(config.logPath);

  // Hook: after_tool_call — inspect errors and enforce limits
  // (Implementation depends on OpenClaw's plugin hook registration API)
  // The plugin intercepts tool results, classifies errors, 
  // tracks failures, and modifies error messages when limits are hit.
}
```

### Tracker (`src/tracker.ts`)

```typescript
interface FailureRecord {
  toolName: string;
  argsHash: string;
  errorSignature: string;
  count: number;
  modelId: string;
}

export class ToolGuardTracker {
  private failures: Map<string, FailureRecord> = new Map();
  private totalFailures: number = 0;
  private maxIdentical: number;
  private maxPerTurn: number;

  constructor(config: { maxIdenticalFailures?: number; maxFailuresPerTurn?: number }) {
    this.maxIdentical = config.maxIdenticalFailures ?? 2;
    this.maxPerTurn = config.maxFailuresPerTurn ?? 5;
  }

  // Track a failure, return action: "continue" | "loop-detected" | "hard-cap"
  recordFailure(toolName: string, args: any, error: string, modelId: string): string { ... }
  
  // Reset at start of each assistant turn
  resetTurn(): void { ... }
}
```

### Classifier (`src/classifier.ts`)

```typescript
const NON_RETRYABLE_PATTERNS = [
  /Missing required parameter:/,
  /Missing parameters for/,
  /Expected .* but received/,
  /Missing required/,
  /type.*error/i,
];

export function classifyError(errorMessage: string): "retryable" | "non-retryable" { ... }

export function inferModelFromToolCallId(toolCallId: string): string {
  if (toolCallId.startsWith("toolu_")) return "anthropic";
  if (toolCallId.startsWith("call_")) return "fireworks/openai-compat";
  return "unknown";
}
```

## Config Integration

Users enable via their `openclaw.json`:

```json5
{
  plugins: {
    load: { paths: ["~/.openclaw/extensions/openclaw-tool-guard"] },
    entries: {
      "tool-guard": {
        enabled: true,
        config: {
          maxIdenticalFailures: 2,
          maxFailuresPerTurn: 5,
          logPath: "~/.openclaw/tool-guard.log"
        }
      }
    }
  }
}
```

## Test Scenarios

1. **Identical failure loop** — `read({})` called 3x → breaks after 2nd with loop detection message
2. **Different failures** — 5 different tools fail → hard cap after 5th
3. **Mixed success/failure** — successes don't count toward failure limits
4. **Error classification** — "Missing required parameter" → non-retryable; "timeout" → retryable
5. **Model attribution** — `call_*` IDs logged as fireworks, `toolu_*` as anthropic
6. **Turn reset** — failure counts reset between assistant turns
7. **Config override** — custom limits respected

## Open Questions

1. **Hook availability:** Does OpenClaw expose `before_tool_call`/`after_tool_call` as plugin hooks, or only as internal hooks? Need to verify the exact registration API.
2. **Tool result interception:** Can we modify the error message returned to the model from a plugin hook, or is it read-only?
3. **Turn boundary detection:** How does the plugin detect when a new assistant turn starts to reset counters?

## Success Criteria

- MiniMax `read({})` loops break in <10 seconds instead of 180s
- Zero false positives on legitimate retries
- Attribution log correctly identifies model source
- Plugin installs cleanly via `openclaw plugins install`
- Tests pass on Node 22+
- README includes install instructions, config examples, and troubleshooting
