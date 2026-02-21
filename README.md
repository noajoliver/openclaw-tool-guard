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

```bash
openclaw plugins install /path/to/openclaw-tool-guard
```

Or link for development:

```bash
openclaw plugins install -l /path/to/openclaw-tool-guard
```

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

## License

MIT
