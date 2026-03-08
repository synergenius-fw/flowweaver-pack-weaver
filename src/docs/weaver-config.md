# Weaver Bot Configuration Reference

The weaver bot runs workflows, executes tasks from natural language, and evolves autonomously. It auto-detects AI providers, manages approval gates, handles git operations, and sends notifications.

The bot has deep knowledge of the full flow-weaver ecosystem: annotation grammar, CLI tools, node patterns, error diagnosis, and the genesis protocol (loaded dynamically from `@synergenius/flow-weaver/doc-metadata`).

## Getting started

Run the bot directly via CLI:

```bash
flow-weaver weaver bot "Create a workflow that processes CSV files"
flow-weaver weaver run my-workflow.ts
flow-weaver weaver session
```

Or scaffold a project via `flow-weaver init` and select the "AI Workflow Runner" use case.

## .weaver.json

Place a `.weaver.json` in your project root to configure the weaver workflow:

```json
{
  "provider": "auto",
  "target": "scripts/my-pipeline.ts",
  "notify": [
    { "channel": "discord", "url": "https://discord.com/api/webhooks/ID/TOKEN" }
  ]
}
```

## Provider options

**Auto-detect** (tries each in order):
```json
{ "provider": "auto" }
```

**Anthropic API** (best quality, requires API key):
```json
{ "provider": "anthropic" }
```

**Claude CLI** (uses your CLI subscription, no API key needed):
```json
{ "provider": "claude-cli" }
```

**GitHub Copilot CLI** (uses your Copilot subscription):
```json
{ "provider": "copilot-cli" }
```

## Workflow nodes

The weaver workflow has 6 nodes, visible and editable in Studio:

1. **Load Config** - Reads `.weaver.json`, falls back to `{ provider: 'auto' }`
2. **Detect Provider** - Auto-detects installed CLIs and API keys
3. **Resolve Target** - Finds the workflow to run (from config or by scanning)
4. **Execute Target** - Runs the target with an AI agent channel
5. **Notify Result** - Sends Discord/Slack/webhook notifications
6. **Report** - Prints summary to console

You can customize any node, add pre/post-processing steps, or insert approval gates in Studio.

## Full .weaver.json reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string or object | `"auto"` | AI provider (see options above) |
| `target` | string | auto-scan | Path to target workflow file |
| `approval` | `"auto"` / `"timeout-auto"` / object | `"auto"` | Approval gate behavior |
| `notify` | array | `[]` | Webhook notification channels |

### Provider (verbose form)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `"anthropic"` / `"claude-cli"` / `"copilot-cli"` | required | Provider name |
| `model` | string | `"claude-sonnet-4-6"` | Model to use (Anthropic only) |
| `maxTokens` | number | `4096` | Max response tokens (Anthropic only) |

Shorthand values:

- `"anthropic"` requires `ANTHROPIC_API_KEY` env var and `@anthropic-ai/sdk` package
- `"claude-cli"` uses the Claude Code CLI (`claude -p`), requires Claude CLI installed
- `"copilot-cli"` uses GitHub Copilot CLI (`copilot -p`), requires Copilot CLI installed
- `"auto"` auto-detects in order: `ANTHROPIC_API_KEY` > `claude` CLI > `copilot` CLI

### Approval

How approval gates are handled.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `"auto"` / `"timeout-auto"` | `"auto"` | `auto`: approve immediately. `timeout-auto`: wait, then approve |
| `timeoutSeconds` | number | `300` | Seconds to wait before auto-approving (timeout-auto only) |

### Notifications

Webhook notifications. Array of notification targets. Supports Discord, Slack, and custom webhooks.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `channel` | `"discord"` / `"slack"` / `"webhook"` | required | Notification target |
| `url` | string | required | Webhook URL |
| `events` | array | all events | Event types to send: `workflow-start`, `workflow-complete`, `error` |
| `headers` | object | `{}` | Extra HTTP headers (custom webhooks only) |

Discord notifications use rich embeds with color-coded outcomes. Slack uses Block Kit formatting.

## Programmatic usage

The pack also exports library functions for building custom runners:

```typescript
import {
  createProvider,
  detectProvider,
  runWorkflow,
  BotAgentChannel,
} from '@synergenius/flow-weaver-pack-weaver';

// Auto-detect and run
const result = await runWorkflow('path/to/workflow.ts', { verbose: true });

// Or build a custom agent channel
const providerConfig = detectProvider();
const provider = createProvider(providerConfig);
const channel = new BotAgentChannel(provider, { ... });
```

Scheduling is left to the user: cron, GitHub Actions, git hooks, etc.
