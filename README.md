# openclaw-tool-guard

An OpenClaw plugin that prevents malformed tool call loops. When models (especially non-Anthropic models like MiniMax M2.5) generate tool calls with missing required parameters, the current behavior is an infinite retry loop until timeout. This plugin detects and breaks those loops early.

Related issue: [openclaw/openclaw#14729](https://github.com/openclaw/openclaw/issues/14729)

## How it works

Tool Guard uses a 3-layer defense:

### Layer A: Corrective Error Messages

When a tool call fails with a deterministic validation error (missing required param, type mismatch), the generic error is replaced with a corrective message that tells the model what went wrong, what the correct call looks like, and what it actually sent.

Instead of:
> `Missing required parameter: path (path or file_path)`

The model sees:
> `[TOOL ERROR] read() requires 'path'. Correct usage: read({ path: "path/to/file" }). You sent: read({}). Fix your call and retry.`

### Layer B: Per-Turn Dedup Loop Breaker

Tracks `(toolName, args, errorSignature)` tuples within each assistant turn. After 2 identical failing calls (configurable), returns a terminal error:

```
[LOOP DETECTED] Tool "read" failed 2 times with identical arguments.
This is a non-retryable error. Do NOT retry this call.
Try a different approach or report the issue.
```

### Layer C: Hard Cap Per Turn

After 5 total tool failures (configurable) in a single assistant turn, stops tool execution:

```
[TOOL ERROR LIMIT] 5 tool failures in this turn.
Stopping tool execution. Review your approach before continuing.
```

### Layer D: Model Attribution Logging

Logs which model generated each malformed tool call to `~/.openclaw/tool-guard.log` (configurable) in JSON lines format, including model ID inferred from tool call ID prefix (`call_*` = Fireworks/OpenAI-compat, `toolu_*` = Anthropic).

## Install

Link for development (recommended — changes are live on restart):

```bash
openclaw plugins install -l /path/to/openclaw-tool-guard
```

Or add manually to your `openclaw.json`:

```json5
{
  plugins: {
    load: { paths: ["/path/to/openclaw-tool-guard"] },
    entries: {
      "tool-guard": { enabled: true }
    }
  }
}
```

Then restart the gateway.

## Configuration

Add to your `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "tool-guard": {
        enabled: true,
        config: {
          maxIdenticalFailures: 2,   // Loop break threshold (default: 2)
          maxFailuresPerTurn: 5,     // Hard cap per turn (default: 5)
          logPath: "~/.openclaw/tool-guard.log"  // Attribution log path
        }
      }
    }
  }
}
```

All config fields are optional and have sensible defaults.

## Supported tools

Corrective messages include usage hints for these tools:

- `read` — requires `path` (alias: `file_path`)
- `edit` — requires `path`, `old_string` (alias: `oldText`), `new_string` (alias: `newText`)
- `write` — requires `path`, `content`
- `exec` — requires `command`

Unknown tools get a generic corrective message.

## Development

```bash
npm install
npm test
npm run build
```

Requires Node 22+.

## Troubleshooting

**Plugin not activating:** Ensure the plugin is enabled in `openclaw.json` under `plugins.entries.tool-guard.enabled`. Restart the gateway after config changes.

**Log file not created:** The log directory is created automatically. Check that the configured `logPath` is writable.

**False positives:** If legitimate retries are being blocked, increase `maxIdenticalFailures`. Only deterministic validation errors (missing params, type mismatches) are treated as non-retryable — timeouts and network errors are always allowed to retry.

## OpenClaw Plugin API Notes

This plugin uses `api.on()` for runtime hook registration (typed hooks) and `api.registerHook()` for display in `openclaw hooks list`. Key hooks:

- `before_agent_start` — resets failure counters each turn
- `tool_result_persist` — intercepts tool results, classifies errors, injects corrective messages
- `before_tool_call` / `after_tool_call` — available for diagnostics

The `tool_result_persist` hook is **synchronous** — do not return Promises.

Tested on OpenClaw 2026.2.6-3 with MiniMax M2.5 (Fireworks) and Claude Sonnet 4.6.

## License

MIT

---

## Metrics Dashboard

The plugin includes a built-in token usage dashboard that captures `model.usage` events from all active gateways and stores them in a local SQLite database.

### Enabling

Add to `openclaw.json` for each gateway you want to monitor:

```json5
{
  plugins: {
    entries: {
      "tool-guard": {
        enabled: true,
        config: {
          metrics: {
            enabled: true,
            dbPath: "~/.openclaw/metrics.db",
            dashboard: {
              enabled: true,
              port: 8080,
              bind: "127.0.0.1"
            }
          }
        }
      }
    }
  }
}
```

All gateways write to the **same** `~/.openclaw/metrics.db` (WAL mode supports concurrent writes). Only one gateway needs `dashboard.enabled: true` to serve the UI.

### Accessing the Dashboard

Navigate to **http://127.0.0.1:8080** while any gateway is running.

**Tabs:**
- **Overview** — 24h/7d/30d token burn and cost, top gateways and models
- **Gateways** — Per-CEO breakdown with model distribution
- **Models** — Cost efficiency comparison across providers
- **Live** — Real-time event stream (last 50 calls)

### What It Tracks

| Field | Description |
|-------|-------------|
| Gateway ID | Which agent/CEO produced the call |
| Provider | `fireworks`, `anthropic`, etc. |
| Model | `kimi-k2p5`, `claude-opus-4-6`, etc. |
| Tokens | Input, output, cache read/write, total |
| Cost USD | Estimated cost per call |
| Duration | API response time (ms) |
| Channel | `discord`, `telegram`, etc. |

### Data Retention

Configurable via `metrics.retention`:

| Table | Default |
|-------|---------|
| Raw events | 30 days |
| Hourly aggregations | 90 days |
| Daily aggregations | 1 year |

Cleanup runs automatically at 4 AM UTC daily.
