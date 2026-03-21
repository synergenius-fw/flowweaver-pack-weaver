#!/bin/bash
# Self-improvement overnight run for pack-weaver.
# Creates a branch, queues tasks, starts a continuous session until 10:00.
# Run: bash scripts/self-improve.sh

set -e
cd "$(dirname "$0")/.."

BRANCH="weaver/self-improve-$(date +%Y%m%d)"
echo "Creating branch: $BRANCH"
git checkout -B "$BRANCH"

echo "Queuing tasks..."

npx flow-weaver weaver queue add "Run 'npx vitest run' and report the full results. List every passing and failing test file."

npx flow-weaver weaver queue add "Add comprehensive tests for src/bot/bot-manager.ts. Test spawn metadata, per-bot queue isolation, per-bot steering isolation, log capture, stop/kill lifecycle. Use os.tmpdir for test dirs."

npx flow-weaver weaver queue add "Add comprehensive tests for src/bot/assistant-core.ts. Mock the provider and executor. Test conversation history accumulation, token compression, plan file loading, input/output flow."

npx flow-weaver weaver queue add "Add comprehensive tests for src/bot/assistant-tools.ts. Test every tool in the executor: bot_spawn error on duplicate, bot_list empty, bot_status not found, queue_add/list/retry, fw_validate, read_file, list_files with pattern, run_shell blocked commands, conversation_list/delete/summary."

npx flow-weaver weaver queue add "Add comprehensive tests for src/bot/terminal-renderer.ts. Test every method: sessionStart/End, taskStart/End, onStreamEvent thinking hidden/shown, onToolEvent formatting, quiet mode, verbose mode, formatTokens edge cases, formatElapsed edge cases."

npx flow-weaver weaver queue add "Add comprehensive tests for src/bot/retry-utils.ts. Test isTransientError with every pattern (502, 429, ETIMEDOUT, rate limit, exit code 143). Test withRetry with mock functions that fail then succeed."

npx flow-weaver weaver queue add "Run 'npx vitest run' again. If any tests fail, read the failing test file, understand the error, and fix it with patch_file. Then run vitest again to confirm."

npx flow-weaver weaver queue add "Run 'npx flow-weaver validate src/workflows/weaver-agent.ts' and fix any validation errors found. Also validate weaver-bot.ts, weaver-bot-batch.ts, genesis-task.ts."

npx flow-weaver weaver queue add "Read src/cli-handlers.ts and add the 'assistant' command to the printHelp function output, with description 'AI-powered assistant for managing bots and workflows'."

npx flow-weaver weaver queue add "Review all catch blocks in src/bot/*.ts files. For any catch block that silently swallows errors (empty catch or just '/* ignore */'), add a meaningful error message or at minimum a debug log. Use process.env.WEAVER_VERBOSE check."

echo ""
echo "Queued $(npx flow-weaver weaver queue list 2>&1 | grep -c pending) tasks."
echo ""
echo "Starting session until 10:00..."
echo "Branch: $BRANCH"
echo "Plan: .weaver-plan.md"
echo "Logs: check 'npx flow-weaver weaver history' after"
echo ""

npx flow-weaver weaver session --continuous --auto-approve --until 10:00
