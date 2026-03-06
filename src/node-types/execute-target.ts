import type { WeaverEnv, ProviderInfo } from '../bot/types.js';
import { callCli, callApi, parseJsonResponse } from '../bot/ai-client.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildWeaverPrompt(): Promise<string> {
  const FALLBACK = 'You are Weaver, an expert AI companion for Flow Weaver workflows. Respond ONLY with valid JSON. No markdown, no code fences, no explanation outside the JSON structure.';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docMeta: any = await import('@synergenius/flow-weaver/doc-metadata');

    const annotations: Array<{ name: string; syntax: string; description: string; category: string }> = docMeta.ALL_ANNOTATIONS ?? [];
    const portMods: Array<{ syntax: string; description: string }> = docMeta.PORT_MODIFIERS ?? [];
    const nodeMods: Array<{ syntax: string; description: string }> = docMeta.NODE_MODIFIERS ?? [];
    const codes: Array<{ code: string; severity: string; title: string; description: string }> = docMeta.VALIDATION_CODES ?? [];
    const commands: Array<{ name: string; description: string; group?: string }> = docMeta.CLI_COMMANDS ?? [];

    const groups = new Map<string, typeof annotations>();
    for (const a of annotations) {
      const list = groups.get(a.category) ?? [];
      list.push(a);
      groups.set(a.category, list);
    }
    const annotationLines: string[] = [];
    for (const [category, items] of groups) {
      annotationLines.push('[' + category + ']');
      for (const item of items) annotationLines.push('  ' + item.syntax + '  -- ' + item.description);
    }

    const modLines: string[] = [];
    if (portMods.length > 0) {
      modLines.push('Port modifiers (after port name):');
      for (const m of portMods) modLines.push('  ' + m.syntax + '  -- ' + m.description);
    }
    if (nodeMods.length > 0) {
      modLines.push('Node instance modifiers (in @node declaration):');
      for (const m of nodeMods) modLines.push('  ' + m.syntax + '  -- ' + m.description);
    }

    const errors = codes.filter(c => c.severity === 'error').slice(0, 15);
    const errorLines = errors.map(c => '  ' + c.code + ': ' + c.title + ' -- ' + c.description);

    const topCmds = commands.filter(c => !c.group);
    const cmdLines = topCmds.map(c => '  flow-weaver ' + c.name + ' -- ' + c.description);

    return `You are Weaver, an expert AI companion for Flow Weaver workflows. You have deep knowledge of the entire Flow Weaver ecosystem: annotation grammar, compilation, CLI tools, node patterns, error diagnosis, and the Genesis self-evolution protocol.

## Core Mental Model

The code IS the workflow. Flow Weaver workflows are plain TypeScript files with JSDoc annotations above functions. The compiler reads annotations and generates deterministic execution code between @flow-weaver-body-start/end markers. Compiled code is standalone with no runtime dependency on flow-weaver.

Three block types:
- @flowWeaver nodeType: A reusable function (node) with typed inputs/outputs
- @flowWeaver workflow: A DAG orchestration that wires node instances together
- @flowWeaver pattern: A reusable fragment with boundary ports (IN/OUT instead of Start/Exit)

## Annotation Grammar

${annotationLines.join('\n')}

${modLines.join('\n')}

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

${cmdLines.join('\n')}

Key workflows:
  flow-weaver compile <file>  -- Generate executable code (in-place)
  flow-weaver validate <file> -- Check for errors without compiling
  flow-weaver modify <op> --file <f> -- Structural changes (addNode, removeNode, addConnection, removeConnection)
  flow-weaver implement <file> -- Replace declare stubs with implementations
  flow-weaver diff <a> <b> -- Semantic diff between two workflow versions
  flow-weaver diagram <file> -f ascii-compact -- Generate ASCII diagram

## Validation Errors

${errorLines.join('\n')}

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

Return ONLY valid JSON. No markdown, no code fences, no explanation outside the JSON structure.`;
  } catch {
    return FALLBACK;
  }
}

/**
 * Run the target workflow via the flow-weaver executor with an AI agent channel.
 *
 * @flowWeaver nodeType
 * @label Execute Target
 * @input env [order:0] - Weaver environment bundle
 * @input targetPath [order:1] - Absolute path to target workflow
 * @output env [order:0] - Weaver environment bundle (pass-through)
 * @output targetPath [order:1] - Target path (pass-through)
 * @output resultJson [order:2] - Workflow execution result (JSON)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverExecuteTarget(
  execute: boolean,
  env: WeaverEnv,
  targetPath: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  env: WeaverEnv; targetPath: string; resultJson: string;
}> {
  if (!execute) {
    return {
      onSuccess: true, onFailure: false,
      env, targetPath,
      resultJson: JSON.stringify({ success: true, summary: 'Dry run', outcome: 'skipped' }),
    };
  }

  const { config, providerInfo: pInfo } = env;
  const systemPrompt = await buildWeaverPrompt();

  const approvalSetting = config.approval ?? 'auto';
  const approvalMode = typeof approvalSetting === 'string' ? approvalSetting : approvalSetting.mode;

  const agentChannel = {
    request: async (req: { agentId: string; context: Record<string, unknown>; prompt: string }) => {
      if (req.agentId.includes('approval')) {
        if (approvalMode === 'auto') {
          console.log('\x1b[36m→ Auto-approving\x1b[0m');
          return { approved: true, reason: 'auto-approved' };
        }
        if (approvalMode === 'timeout-auto') {
          const timeout = typeof approvalSetting === 'object' ? (approvalSetting.timeoutSeconds ?? 300) : 300;
          console.log(`\x1b[36m→ Waiting ${timeout}s before auto-approving...\x1b[0m`);
          await new Promise(resolve => setTimeout(resolve, timeout * 1000));
          return { approved: true, reason: 'timeout-auto-approved' };
        }
        return { approved: true, reason: 'default-approved' };
      }

      const contextStr = typeof req.context === 'string'
        ? req.context
        : JSON.stringify(req.context, null, 2);
      const userPrompt = `Context:\n${contextStr}\n\nInstructions:\n${req.prompt}`;

      let text: string;
      if (pInfo.type === 'anthropic') {
        text = await callApi(
          pInfo.apiKey!,
          pInfo.model ?? 'claude-sonnet-4-6',
          pInfo.maxTokens ?? 4096,
          systemPrompt,
          userPrompt,
        );
      } else {
        text = callCli(pInfo.type, systemPrompt + '\n\n' + userPrompt);
      }

      return parseJsonResponse(text);
    },
    onPause: () => new Promise<never>(() => {}),
    resume: () => {},
    fail: () => {},
  };

  try {
    console.log(`\x1b[36m→ Executing: ${targetPath}\x1b[0m`);
    const startTime = Date.now();

    const mod = '@synergenius/flow-weaver/executor';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeWorkflowFromFile } = await (import(mod) as Promise<any>);
    const execResult = await executeWorkflowFromFile(targetPath, {}, {
      agentChannel,
      includeTrace: false,
      production: true,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const result = execResult.result as Record<string, unknown> | null;
    const ok = (result?.onSuccess as boolean) ?? false;

    let summary: string;
    if (typeof result?.summary === 'string') {
      summary = result.summary;
    } else if (result) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(result)) {
        if (k === 'onSuccess' || k === 'onFailure' || v == null) continue;
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        parts.push(k + ': ' + (s.length > 80 ? s.slice(0, 80) + '...' : s));
      }
      summary = parts.length > 0 ? parts.join(', ') : 'completed';
    } else {
      summary = 'completed';
    }

    if (ok) console.log(`\x1b[32m✓ Completed in ${elapsed}s: ${summary}\x1b[0m`);
    else console.log(`\x1b[33m! Failed after ${elapsed}s: ${summary}\x1b[0m`);

    const resultObj = {
      success: ok, summary, outcome: ok ? 'completed' : 'failed',
      functionName: execResult.functionName,
      executionTime: Number(elapsed),
    };

    return {
      onSuccess: ok, onFailure: !ok,
      env, targetPath,
      resultJson: JSON.stringify(resultObj),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\x1b[33m! Error: ${msg}\x1b[0m`);
    return {
      onSuccess: false, onFailure: true,
      env, targetPath,
      resultJson: JSON.stringify({ success: false, summary: msg, outcome: 'error' }),
    };
  }
}
