/**
 * Shared prompt helpers for genesis propose and revise steps.
 * Centralises context building so the AI always gets the CLI grammar,
 * operation syntax, and workflow structure it needs to produce valid proposals.
 */

import { buildSystemPrompt } from './system-prompt.js';
import type { GenesisConfig } from './types.js';

let cachedOpsContext: string | null = null;

/**
 * Full system prompt with annotation grammar, CLI commands, validation codes,
 * and genesis protocol. Cached after first call.
 */
export async function getGenesisSystemPrompt(
  config: GenesisConfig,
  stabilized: boolean,
  options?: { selfEvolveLocked?: boolean; graceRemaining?: number },
): Promise<string> {
  const base = await buildSystemPrompt();

  const stabilizeClause = stabilized
    ? '\n\nSTABILIZE MODE: Only removeNode, removeConnection, and implementNode operations are allowed. Do NOT propose addNode or addConnection.'
    : '';

  const selfEvolveClause = config.selfEvolve
    ? [
        '',
        '## Self-Evolution',
        `Self-evolution is ENABLED with a budget of ${config.selfEvolveBudget ?? 2} cost units.`,
        'Cost map: selfModifyWorkflow=3, selfModifyNodeType=2, selfModifyModule=2.',
        'Self-modify operations use { file: "relative/path.ts", content: "full file content" } in args.',
        'The file path is relative to the pack root (e.g. "src/workflows/genesis-task.ts").',
        'Content must be the complete replacement file, not a diff.',
      ].join('\n')
    : '';

  const lockClause = options?.selfEvolveLocked
    ? `\n\nSELF-EVOLUTION LOCKED: A migration is in grace period (${options.graceRemaining} cycles remaining). Do not propose selfModify operations.`
    : '';

  return [
    base,
    '',
    '## Genesis Cycle Config',
    `Intent: ${config.intent}`,
    config.focus.length > 0 ? `Focus areas: ${config.focus.join(', ')}` : '',
    config.constraints.length > 0 ? `Constraints: ${config.constraints.join(', ')}` : '',
    `Budget: ${config.budgetPerCycle} cost units per cycle.`,
    'Cost map: addNode=1, removeNode=1, addConnection=1, removeConnection=1, implementNode=2.',
    stabilizeClause,
    selfEvolveClause,
    lockClause,
  ].filter(Boolean).join('\n');
}

/**
 * Operation format reference with concrete examples.
 * Appended to both propose and revise prompts so the AI knows
 * the exact CLI arg format.
 */
export function getOperationExamples(targetPath: string): string {
  return `## Operation Format

Each operation is { type, args, costUnits, rationale }.

### addNode
args: { "nodeId": "myNode", "nodeType": "someFunction", "file": "${targetPath}" }

### removeNode
args: { "nodeId": "myNode", "file": "${targetPath}" }

### addConnection
args: { "from": "sourceNode.portName", "to": "targetNode.portName", "file": "${targetPath}" }
IMPORTANT: Connection format is "node.port" using a DOT separator. NOT "node:port", NOT "node:portName".

### removeConnection
args: { "from": "sourceNode.portName", "to": "targetNode.portName", "file": "${targetPath}" }

### implementNode
args: { "nodeId": "existingStubNodeId", "file": "${targetPath}" }
Only works on nodes declared with \`declare function\` (stubs). The nodeId must match an existing stub in the workflow.

### selfModifyWorkflow (cost: 3)
args: { "file": "src/workflows/genesis-task.ts", "content": "// full file content..." }
Replaces the genesis workflow file. File path is relative to pack root.

### selfModifyNodeType (cost: 2)
args: { "file": "src/node-types/genesis-propose.ts", "content": "// full file content..." }
Replaces a genesis node type implementation.

### selfModifyModule (cost: 2)
args: { "file": "src/bot/genesis-prompt-context.ts", "content": "// full file content..." }
Replaces a bot module file.

## Response Format
Return ONLY valid JSON with: { operations: [...], totalCost: number, impactLevel: "COSMETIC"|"MINOR"|"BREAKING"|"CRITICAL", summary: string, rationale: string }
No markdown, no code fences, no explanation outside the JSON.`;
}

/**
 * Ops context from flow-weaver docs (CLI reference, error codes, etc.).
 * Falls back gracefully if the context module is unavailable.
 */
export async function getOpsContext(): Promise<string> {
  if (cachedOpsContext) return cachedOpsContext;

  try {
    const { buildContext } = await import('@synergenius/flow-weaver/context');
    const result = buildContext({ preset: 'ops', includeGrammar: false });
    cachedOpsContext = result.content;
  } catch {
    cachedOpsContext = '(ops context unavailable)';
  }

  return cachedOpsContext!;
}

/**
 * Gets a text description of the workflow using the describe module.
 * Falls back to reading the raw file if describe isn't available.
 */
export async function getWorkflowDescription(filePath: string): Promise<string> {
  try {
    const { parseWorkflow } = await import('@synergenius/flow-weaver/api');
    const { describeWorkflow, formatTextOutput } = await import('@synergenius/flow-weaver/describe');

    const result = await parseWorkflow(filePath);
    const output = describeWorkflow(result.ast);
    return formatTextOutput(result.ast, output);
  } catch {
    return '(workflow description unavailable)';
  }
}

/**
 * Builds intelligence context from the project model for Genesis proposals.
 * Includes health scores, insights, operation effectiveness, and user preferences.
 */
export async function getGenesisInsightContext(projectDir: string): Promise<string> {
  try {
    const { ProjectModelStore } = await import('./project-model.js');
    const pms = new ProjectModelStore(projectDir);
    const model = await pms.getOrBuild();

    const lines: string[] = ['## Project Intelligence', ''];
    lines.push(`Health: ${model.health.overall}/100`);
    lines.push(`Trust Phase: ${model.trust.phase}`);
    lines.push('');

    // Top failure patterns as genesis candidates
    const candidates = model.failurePatterns
      .filter(f => !f.transient && f.occurrences >= 3)
      .slice(0, 3);
    if (candidates.length > 0) {
      lines.push('### Top Issues (Genesis Candidates)');
      for (const c of candidates) {
        lines.push(`- [${c.occurrences}x] ${c.pattern} (${c.category})`);
      }
      lines.push('');
    }

    // Operation effectiveness
    const ops = Object.entries(model.evolution.byOperationType);
    if (ops.length > 0) {
      lines.push('### Operation Effectiveness');
      for (const [op, stats] of ops) {
        lines.push(`- ${op}: ${Math.round(stats.effectiveness * 100)}% effective (${stats.applied}/${stats.proposed})`);
      }
      lines.push('');
    }

    // User preferences
    if (model.userPreferences.autoApprovePatterns.length > 0) {
      lines.push(`Auto-approve patterns: ${model.userPreferences.autoApprovePatterns.join(', ')}`);
    }
    if (model.userPreferences.neverApprovePatterns.length > 0) {
      lines.push(`Never-approve patterns: ${model.userPreferences.neverApprovePatterns.join(', ')}`);
    }

    // Bot performance
    const weakBots = model.bots.filter(b => b.successRate < 0.5 && b.totalTasksRun > 3);
    if (weakBots.length > 0) {
      lines.push('');
      lines.push('### Underperforming Bots');
      for (const b of weakBots) {
        lines.push(`- ${b.name}: ${Math.round(b.successRate * 100)}% success (${b.totalTasksRun} tasks)`);
      }
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}
