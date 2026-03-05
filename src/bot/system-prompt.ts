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

Key workflows:
  flow-weaver compile <file>  -- Generate executable code (in-place)
  flow-weaver validate <file> -- Check for errors without compiling
  flow-weaver modify <op> --file <f> -- Structural changes (addNode, removeNode, addConnection, removeConnection)
  flow-weaver implement <file> -- Replace declare stubs with implementations
  flow-weaver diff <a> <b> -- Semantic diff between two workflow versions
  flow-weaver diagram <file> -f ascii-compact -- Generate ASCII diagram

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

## Response Format

Return ONLY valid JSON. No markdown, no code fences, no explanation outside the JSON structure. Your response must parse with JSON.parse() directly.`;
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
  } catch {
    // Fallback if doc-metadata not available (e.g., older flow-weaver version)
    cachedPrompt = buildPromptFromMetadata([], [], [], [], []);
  }

  return cachedPrompt;
}
