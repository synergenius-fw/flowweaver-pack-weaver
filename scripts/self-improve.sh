#!/bin/bash
# Self-improvement overnight run for pack-weaver.
# Creates a branch, queues tasks, starts a continuous session until 10:00.
# The continuous improvement loop runs MAX_CYCLES times (default 5), not indefinitely.
#
# Usage:
#   bash scripts/self-improve.sh              # default: 5 cycles, until 10:00
#   bash scripts/self-improve.sh 10           # 10 cycles
#   bash scripts/self-improve.sh 5 08:00      # 5 cycles, until 08:00

set -e
cd "$(dirname "$0")/.."

MAX_CYCLES="${1:-5}"
DEADLINE="${2:-10:00}"
BRANCH="weaver/self-improve-$(date +%Y%m%d)"

echo "Creating branch: $BRANCH"
git checkout -B "$BRANCH"

echo "Queuing initial tasks..."

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

# Add the continuous improvement loop with a cycle cap
for i in $(seq 1 "$MAX_CYCLES"); do
  npx flow-weaver weaver queue add "CONTINUOUS IMPROVEMENT (cycle $i of $MAX_CYCLES): Run 'npx vitest run' to check current state. Run 'npx flow-weaver validate src/workflows/' to check workflows. Based on results, identify up to 5 improvements needed (missing tests, failing tests, validation errors, code quality). For each, use run_shell to queue it: npx flow-weaver weaver queue add '<description>'. Do NOT queue another CONTINUOUS IMPROVEMENT task — that is handled by the script."
done

TOTAL=$(npx flow-weaver weaver queue list 2>&1 | grep -c "pending")
echo ""
echo "Queued $TOTAL tasks ($MAX_CYCLES improvement cycles)."
echo ""
echo "Starting session until $DEADLINE..."
echo "  Branch: $BRANCH"
echo "  Plan: .weaver-plan.md"
echo "  Dedup: enabled (duplicate instructions are skipped)"
echo "  Logs: check 'npx flow-weaver weaver history' after"
echo ""

npx flow-weaver weaver session --continuous --auto-approve --until "$DEADLINE"
