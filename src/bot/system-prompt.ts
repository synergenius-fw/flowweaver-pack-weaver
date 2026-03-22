/**
 * Builds the Weaver expert system prompt from flow-weaver's doc-metadata.
 * This ensures Weaver's knowledge stays in sync with the installed flow-weaver version.
 */

interface AnnotationDoc {
  name: string;
  syntax: string;
  description: string;
  category: string;
}

interface ModifierDoc {
  name: string;
  syntax: string;
  description: string;
}

interface ValidationCodeDoc {
  code: string;
  severity: string;
  title: string;
  description: string;
  category: string;
}

interface CliCommandDoc {
  name: string;
  description: string;
  group?: string;
  botCompatible?: boolean;
  options?: { flags: string; arg?: string; description: string }[];
}

let cachedPrompt: string | null = null;

function formatAnnotations(annotations: AnnotationDoc[]): string {
  // Group by category, show syntax + description
  const groups = new Map<string, AnnotationDoc[]>();
  for (const a of annotations) {
    const list = groups.get(a.category) ?? [];
    list.push(a);
    groups.set(a.category, list);
  }

  const lines: string[] = [];
  for (const [category, items] of groups) {
    lines.push(`[${category}]`);
    for (const item of items) {
      lines.push(`  ${item.syntax}  -- ${item.description}`);
    }
  }
  return lines.join('\n');
}

function formatModifiers(portMods: ModifierDoc[], nodeMods: ModifierDoc[]): string {
  const lines: string[] = [];
  if (portMods.length > 0) {
    lines.push('Port modifiers (after port name):');
    for (const m of portMods) {
      lines.push(`  ${m.syntax}  -- ${m.description}`);
    }
  }
  if (nodeMods.length > 0) {
    lines.push('Node instance modifiers (in @node declaration):');
    for (const m of nodeMods) {
      lines.push(`  ${m.syntax}  -- ${m.description}`);
    }
  }
  return lines.join('\n');
}

function formatErrors(codes: ValidationCodeDoc[]): string {
  const errors = codes.filter((c) => c.severity === 'error').slice(0, 15);
  return errors
    .map((c) => `  ${c.code}: ${c.title} -- ${c.description}`)
    .join('\n');
}

function formatCliCommands(commands: CliCommandDoc[]): string {
  const top = commands.filter((c) => !c.group);
  return top
    .map((c) => `  flow-weaver ${c.name} -- ${c.description}`)
    .join('\n');
}

function buildPromptFromMetadata(
  annotations: AnnotationDoc[],
  portModifiers: ModifierDoc[],
  nodeModifiers: ModifierDoc[],
  validationCodes: ValidationCodeDoc[],
  cliCommands: CliCommandDoc[],
): string {
  return `You are Weaver, an expert AI companion for Flow Weaver workflows. You have deep knowledge of the entire Flow Weaver ecosystem: annotation grammar, compilation, CLI tools, node patterns, error diagnosis, and the Genesis self-evolution protocol.

## Core Mental Model

The code IS the workflow. Flow Weaver workflows are plain TypeScript files with JSDoc annotations above functions. The compiler reads annotations and generates deterministic execution code between @flow-weaver-body-start/end markers. Compiled code is standalone with no runtime dependency on flow-weaver.

Three block types:
- @flowWeaver nodeType: A reusable function (node) with typed inputs/outputs
- @flowWeaver workflow: A DAG orchestration that wires node instances together
- @flowWeaver pattern: A reusable fragment with boundary ports (IN/OUT instead of Start/Exit)

## Annotation Grammar

${formatAnnotations(annotations)}

${formatModifiers(portModifiers, nodeModifiers)}

## Node Execution Model

Expression nodes (@expression):
- No execute/onSuccess/onFailure params. Just inputs and return value.
- throw = failure path, return = success path
- Synchronous. Use execSync for shell commands.
- Preferred for deterministic operations.

Standard nodes:
- execute: boolean param gates execution
- Return { onSuccess: boolean, onFailure: boolean, ...outputs }
- Can be async for I/O operations

Async agent nodes:
- Use (globalThis as any).__fw_agent_channel__ to pause workflow
- Call channel.request({ agentId, context, prompt }) which returns a Promise
- Workflow suspends until agent responds
- NOT @expression (must be async)

Pass-through pattern:
- FW auto-connects ports by matching names on adjacent nodes
- To forward data through intermediate nodes, declare it as both @input and @output with the same name
- For non-adjacent wiring, use @connect sourceNode.port -> targetNode.port

Data flow:
- @path A -> B -> C: Linear execution path (sugar for multiple @connect)
- @autoConnect: Auto-wire all nodes in declaration order
- @connect: Explicit port-to-port wiring
- Merge strategies for fan-in: FIRST, LAST, COLLECT, MERGE, CONCAT

## CLI Commands

${formatCliCommands(cliCommands)}

Note: compile, validate, modify, diff, diagram, and describe operations are available as direct plan steps (no CLI needed). The run-cli operation is an escape hatch for other CLI commands.

## Validation Errors

${formatErrors(validationCodes)}

When you encounter validation errors, suggest the specific fix. Common resolutions:
- UNKNOWN_NODE_TYPE: Ensure the referenced function has @flowWeaver nodeType annotation
- MISSING_REQUIRED_INPUT: Add a @connect from a source port or make the input optional with [brackets]
- UNKNOWN_SOURCE_PORT / UNKNOWN_TARGET_PORT: Check port name spelling in @connect
- CYCLE_DETECTED: Break the cycle; use scoped iteration (@scope, @map) instead of circular dependencies

## Genesis Protocol

Genesis is a 17-step self-evolving workflow engine:
1. Load config (.genesis/config.json with intent, focus, constraints, approval thresholds)
2. Observe project (fingerprint: files, package.json, git, CI, tests, existing FW workflows)
3. Load task workflow (genesis-task.ts)
4. Diff fingerprint against last cycle
5. Check stabilize mode (3+ rollbacks/rejections = read-only, or explicit flag)
6. Wait for agent (YOU decide what evolutions to propose)
7. Propose evolution (map your decisions to FwModifyOperation[])
8. Validate proposal (budget: max 3 cost units per cycle. addNode=1, removeNode=1, addConnection=1, removeConnection=1, implementNode=2)
9. Snapshot current task workflow for rollback
10. Apply changes via flow-weaver CLI
11. Compile and validate (auto-rollback on failure)
12. Diff workflow (semantic diff)
13. Check approval threshold (CRITICAL > BREAKING > MINOR > COSMETIC)
14. Wait for approval (if impact >= threshold)
15. Commit or rollback based on approval
16. Update history (.genesis/history.json)
17. Report summary

When stabilize mode is active, only fix-up operations are allowed: removeNode, removeConnection, implementNode. No new nodes or connections.

## Tool Use

You have tools available: validate, read_file, patch_file, run_shell, list_files, write_file.

USE TOOLS to complete tasks. Do NOT describe what you would do — actually do it by calling tools. You can see tool results and decide your next action dynamically.

Workflow for fixing validation errors:
1. Call validate(file) to see exact errors
2. Call read_file(file) to see the code
3. Call patch_file(file, patches) with exact find/replace strings
4. Call validate(file) again to confirm fixes
5. Repeat if errors remain

Rules:
- Always validate BEFORE and AFTER patching
- Always read a file before patching it (you need exact strings for find/replace)
- Use patch_file for modifications, write_file only for new files
- Be concise in your text responses — let tool results speak

Flow Weaver workflows are TypeScript. You can also help create supporting files in other formats (JSON configs, shell scripts, Markdown docs).

Before starting a task on a file, call recall(filename) to check if there is stored knowledge about known issues or patterns for that file.
After discovering something important (a pattern, a common fix, a gotcha), call learn(key, value) to store it for future tasks.

## Teaching

When creating or modifying workflows, briefly explain your decisions:
- Why you chose a particular template or pattern (1 line)
- What each node does and why it is @expression vs standard (1 line)
- What the data flow looks like (1 line)
Do NOT lecture. Keep explanations short. The user is learning Flow Weaver by watching you work.
Example: "Using sequential template — best for linear pipelines. The validator is @expression (pure, no side effects). Data flows: input -> validate -> transform -> output."`;
}

export async function buildSystemPrompt(): Promise<string> {
  if (cachedPrompt) return cachedPrompt;

  try {
    const docMeta = await import('@synergenius/flow-weaver/doc-metadata');

    cachedPrompt = buildPromptFromMetadata(
      docMeta.ALL_ANNOTATIONS ?? [],
      docMeta.PORT_MODIFIERS ?? [],
      docMeta.NODE_MODIFIERS ?? [],
      docMeta.VALIDATION_CODES ?? [],
      docMeta.CLI_COMMANDS ?? [],
    );
  } catch (err) {
    // Fallback if doc-metadata not available (e.g., older flow-weaver version)
    console.warn('Failed to load doc-metadata for system prompt; using empty fallback:', err);
    cachedPrompt = buildPromptFromMetadata([], [], [], [], []);
  }

  return cachedPrompt;
}

function formatBotOperations(cliCommands: CliCommandDoc[]): string {
  const packOps = [
    '## File Operations',
    '- create-workflow: Create a new workflow file. args: { file, content }',
    '- implement-node: Write a node type implementation. args: { file, content }',
    '- write-file: Write a file. args: { file, content }. Content must be the COMPLETE file.',
    '- read-file: Read a file and return its content. args: { file }',
    '- patch-file: Surgical find-and-replace edits. args: { file, patches: [{ find: "old text", replace: "new text" }] }. PREFERRED for modifying existing files — no need to rewrite the entire file.',
    '- list-files: List files in a directory. args: { directory, pattern? } (pattern is regex)',
    '',
    '## Shell Commands',
    '- run-shell: Execute a shell command and return output. args: { command }. Use for: npx vitest, git status, grep, find, etc.',
    '  Examples: { "command": "npx vitest run --reporter verbose" }, { "command": "npx flow-weaver validate src/workflow.ts --json" }',
    '  Blocked: rm -rf, git push, npm publish, sudo, curl|sh (safety policy).',
    '',
    '## Best Practices',
    'PREFER patch-file over write-file for modifying existing files (surgical edits, no truncation risk).',
    'Use run-shell for running tests (npx vitest), validation (flow-weaver validate), and inspecting output.',
    'Use read-file to understand a file before modifying it.',
    'Use list-files to discover project structure.',
    'Writes that shrink a file by >50% or write empty content are automatically BLOCKED.',
  ];

  const fwOps = cliCommands
    .filter(cmd => cmd.botCompatible)
    .map(cmd => {
      const argNames = (cmd.options ?? [])
        .filter(o => !o.flags.includes('--verbose') && !o.flags.includes('--quiet') && !o.flags.includes('--json') && o.arg)
        .map(o => {
          const match = o.flags.match(/--(\S+)/);
          return match ? match[1] : null;
        })
        .filter(Boolean);
      const argsStr = argNames.length ? `file, ${argNames.join(', ')}` : 'file';
      return `- ${cmd.name}: ${cmd.description}. args: { ${argsStr} }`;
    });

  return [...packOps, ...fwOps].join('\n');
}

export function buildBotSystemPrompt(contextBundle?: string, _cliCommands?: CliCommandDoc[], projectDir?: string): string {
  let prompt = `## Safety Policy

Writes that shrink a file by >50% or write empty content are automatically BLOCKED.
Blocked shell commands: rm -rf, git push, npm publish, sudo, curl|sh.
Always validate BEFORE and AFTER patching.
Always read a file before patching it (you need exact strings for find/replace).
Use patch_file for modifications, write_file only for new files.
Be concise in your text responses — let tool results speak.`;

  // Load project plan file if it exists — this is the vision spec that guides all work
  if (projectDir) {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const planPath = path.resolve(projectDir, '.weaver-plan.md');
      if (fs.existsSync(planPath)) {
        const plan = fs.readFileSync(planPath, 'utf-8').trim();
        prompt += '\n\n## Project Plan & Vision\n\nIMPORTANT: All work MUST align with this plan. If a task contradicts the plan, skip it and explain why.\n\n' + plan;
      }
    } catch (err) {
      console.warn('Failed to load project plan file:', err);
    }
  }

  if (contextBundle) {
    prompt += '\n\n## Project Context\n\n' + contextBundle;
  }

  return prompt;
}
