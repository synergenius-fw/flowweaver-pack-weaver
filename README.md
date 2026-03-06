# Weaver

Weaver is an autonomous AI bot that creates, runs, and evolves Flow Weaver workflows. It is itself built as a set of Flow Weaver workflows, so the bot that evolves workflows is a workflow. It ships as a marketplace pack (`@synergenius/flowweaver-pack-weaver`) and plugs into any Flow Weaver project.

Weaver understands the full Flow Weaver ecosystem: annotation grammar, compilation, validation, CLI tools, node patterns, error diagnosis, and the Genesis self-evolution protocol. This knowledge is loaded dynamically from `@synergenius/flow-weaver/doc-metadata`, so Weaver always stays current with the engine.

## How it works

Weaver connects to an AI provider (Anthropic API, Claude CLI, or GitHub Copilot CLI), detects the right one automatically or uses your `.weaver.json` config, and operates in one of four modes:

**Run mode** (`weaver run`) executes an existing workflow file with an AI agent channel attached. The agent channel lets nodes inside the target workflow pause and ask Weaver for decisions. This is how Genesis works: the genesis-task workflow asks Weaver what evolutions to propose, and Weaver responds with structured operations.

**Bot mode** (`weaver bot "create a greeting workflow"`) takes a task instruction and handles it end-to-end. It builds context from the project, sends the task to the AI for planning, presents the plan for approval, executes the plan steps (writing files, running CLI commands, compiling), validates the results, and retries with AI-generated fixes if validation fails. Git operations and notifications run in parallel after execution.

**Batch mode** (`weaver bot --batch`) processes multiple sub-tasks sequentially through the same plan-approve-execute cycle.

**Session mode** (`weaver session`) polls a task queue continuously, picking up tasks submitted via CLI or MCP and processing them one at a time through the full pipeline.

## The three workflows

Each mode maps to a workflow file that wires the same set of reusable node types differently:

`weaver.ts` is the runner. Six nodes in a line: load config, detect provider, find the target, execute it, notify, report.

`weaver-bot.ts` is the single-task bot. It adds task routing (read-only tasks skip to analysis, actionable tasks go through planning), an approval gate with an abort path, the execute-validate-retry loop, and parallel fan-out to git ops and notifications before merging at the report node. Session mode also uses this workflow, running it in a continuous loop that polls the task queue.

`weaver-bot-batch.ts` is the batch variant. Same pipeline as the bot but without read-only routing, since batch tasks are always actionable.

All three workflows are customizable. Run `weaver eject` to get a local copy you can modify in Studio: add nodes, change connections, insert custom approval logic, whatever you need.

## Installation

```bash
flow-weaver pack add @synergenius/flowweaver-pack-weaver
```

Or scaffold a new project with it:

```bash
flow-weaver init  # select "AI Workflow Runner"
```

## Configuration

Place a `.weaver.json` in your project root:

```json
{
  "provider": "auto",
  "target": "src/my-workflow.ts",
  "approval": "auto",
  "notify": [
    { "channel": "discord", "url": "https://discord.com/api/webhooks/..." }
  ]
}
```

### Provider

Controls which AI provider Weaver uses.

`"auto"` (default) tries in order: `ANTHROPIC_API_KEY` env var, `claude` CLI, `copilot` CLI.

Explicit string values: `"anthropic"`, `"claude-cli"`, `"copilot-cli"`.

Object form for full control:

```json
{
  "provider": {
    "name": "anthropic",
    "model": "claude-sonnet-4-6",
    "maxTokens": 8192
  }
}
```

### Approval

How the approval gate behaves in bot mode.

`"auto"` approves immediately. `"prompt"` asks interactively. `"timeout-auto"` waits N seconds then approves.

```json
{
  "approval": { "mode": "timeout-auto", "timeoutSeconds": 120 }
}
```

### Notifications

Array of webhook targets. Supports Discord (rich embeds), Slack (Block Kit), and raw webhooks.

```json
{
  "notify": [
    { "channel": "discord", "url": "...", "events": ["workflow-complete", "error"] },
    { "channel": "slack", "url": "..." }
  ]
}
```

## CLI commands

The pack adds these commands to `flow-weaver`:

| Command | Description |
|---------|-------------|
| `weaver run [file]` | Run a workflow with Weaver |
| `weaver bot <task>` | Give Weaver a task to execute |
| `weaver session` | Start continuous queue processing |
| `weaver eject` | Copy the managed workflow for customization |
| `weaver history [id]` | List recent runs |
| `weaver costs` | Show token usage and cost summary |
| `weaver providers` | List detected AI providers |
| `weaver steer <cmd>` | Send pause/resume/cancel to a running bot |
| `weaver queue <op>` | Manage the task queue (add, list, clear, remove) |
| `weaver watch <file>` | Re-run on file changes |
| `weaver cron <expr> <file>` | Run on a schedule |
| `weaver pipeline <config>` | Run a multi-stage pipeline |
| `weaver dashboard [file]` | Live execution dashboard |

## MCP tools

For IDE integration, the pack exposes MCP tools: `fw_weaver_run`, `fw_weaver_bot`, `fw_weaver_steer`, `fw_weaver_queue`, `fw_weaver_status`, `fw_weaver_history`, `fw_weaver_costs`, `fw_weaver_providers`.

## Node types

The pack ships 19 node types usable in any Flow Weaver workflow. The core ones:

`weaverLoadConfig` reads `.weaver.json` and outputs the parsed config object.

`weaverDetectProvider` resolves the AI provider and assembles a `WeaverEnv` bundle (project dir, config, provider type, provider info) that flows through the rest of the pipeline as a single typed object.

`weaverReceiveTask` picks up a task from CLI args, MCP, or the queue.

`weaverBuildContext` generates the knowledge bundle the AI needs for planning, pulling annotation grammar and docs from the Flow Weaver engine.

`weaverPlanTask` sends the task and context to the AI and gets back a structured execution plan.

`weaverApprovalGate` presents the plan for approval, branching to abort on rejection.

`weaverExecValidateRetry` runs the plan, validates with `flow-weaver validate`, and on failure asks the AI for fixes. Up to 3 attempts.

`weaverGitOps` stages and commits modified files.

`weaverSendNotify` dispatches webhook notifications.

## Programmatic usage

```typescript
import { runWorkflow, createProvider, detectProvider, BotAgentChannel } from '@synergenius/flowweaver-pack-weaver';

const result = await runWorkflow('path/to/workflow.ts', { verbose: true });
```

Or build a custom agent channel for more control:

```typescript
const providerConfig = detectProvider();
const provider = createProvider(providerConfig);
const channel = new BotAgentChannel(provider, { systemPrompt: '...' });
```

## License

See [LICENSE](./LICENSE).
