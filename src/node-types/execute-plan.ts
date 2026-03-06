import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Executes plan steps via the flow-weaver CLI. Checks steering
 * between steps.
 *
 * @flowWeaver nodeType
 * @label Execute Plan
 * @input projectDir [order:0] - Project root directory
 * @input config [order:1] - Config (JSON, pass-through)
 * @input providerType [order:2] - Provider type (pass-through)
 * @input providerInfo [order:3] - Provider info (pass-through)
 * @input planJson [order:4] - Plan (JSON)
 * @input taskJson [order:5] - Task (JSON)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output config [order:1] - Config (pass-through)
 * @output providerType [order:2] - Provider type (pass-through)
 * @output providerInfo [order:3] - Provider info (pass-through)
 * @output executionResultJson [order:4] - Execution result (JSON)
 * @output taskJson [order:5] - Task (pass-through)
 * @output filesModified [order:6] - Files modified (JSON array)
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverExecutePlan(
  execute: boolean,
  projectDir: string,
  config: string,
  providerType: string,
  providerInfo: string,
  planJson: string,
  taskJson: string,
): Promise<{
  onSuccess: boolean; onFailure: boolean;
  projectDir: string; config: string; providerType: string; providerInfo: string;
  executionResultJson: string; taskJson: string; filesModified: string;
}> {
  const passthrough = { projectDir, config, providerType, providerInfo, taskJson };

  if (!execute) {
    return {
      onSuccess: true, onFailure: false, ...passthrough,
      executionResultJson: JSON.stringify({ success: true, stepsCompleted: 0, stepsTotal: 0, filesModified: [], filesCreated: [], errors: [], output: 'dry run' }),
      filesModified: '[]',
    };
  }

  const plan = JSON.parse(planJson) as { steps: Array<{ id: string; operation: string; description: string; args: Record<string, unknown> }> };
  const filesModified: string[] = [];
  const filesCreated: string[] = [];
  const errors: string[] = [];
  const output: string[] = [];
  let completed = 0;

  // Check steering before starting
  const steeringCheck = checkSteering();
  if (steeringCheck === 'cancel') {
    return {
      onSuccess: false, onFailure: true, ...passthrough,
      executionResultJson: JSON.stringify({ success: false, stepsCompleted: 0, stepsTotal: plan.steps.length, filesModified: [], filesCreated: [], errors: ['Cancelled via steering'], output: '' }),
      filesModified: '[]',
    };
  }

  for (const step of plan.steps) {
    // Check steering between steps
    const steering = checkSteering();
    if (steering === 'cancel') {
      output.push(`Cancelled at step ${step.id}`);
      break;
    }
    if (steering === 'pause') {
      console.log('\x1b[33m→ Paused. Waiting for resume...\x1b[0m');
      await waitForResume();
    }

    try {
      const result = executeStep(step, projectDir);
      if (result.file) {
        if (result.created) filesCreated.push(result.file);
        else filesModified.push(result.file);
      }
      completed++;
      output.push(`${step.id}: ${step.description} - done`);
      console.log(`\x1b[32m  + ${step.id}: ${step.description}\x1b[0m`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${step.id}: ${msg}`);
      output.push(`${step.id}: FAILED - ${msg}`);
      console.error(`\x1b[31m  x ${step.id}: ${msg}\x1b[0m`);
    }
  }

  const allFiles = [...new Set([...filesModified, ...filesCreated])];
  const success = errors.length === 0;

  return {
    onSuccess: success, onFailure: !success, ...passthrough,
    executionResultJson: JSON.stringify({
      success, stepsCompleted: completed, stepsTotal: plan.steps.length,
      filesModified, filesCreated, errors, output: output.join('\n'),
    }),
    filesModified: JSON.stringify(allFiles),
  };
}

function executeStep(
  step: { operation: string; args: Record<string, unknown> },
  projectDir: string,
): { file?: string; created?: boolean } {
  const args = step.args;
  const file = args.file as string | undefined;

  switch (step.operation) {
    case 'write-file':
    case 'create-workflow':
    case 'modify-source':
    case 'implement-node': {
      const filePath = path.resolve(projectDir, file!);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const existed = fs.existsSync(filePath);
      fs.writeFileSync(filePath, (args.content as string) ?? (args.body as string) ?? '', 'utf-8');
      return { file: filePath, created: !existed };
    }
    case 'compile':
      execSync(`flow-weaver compile "${file}"`, { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file! };
    case 'validate':
      execSync(`flow-weaver validate "${file}"`, { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return {};
    case 'add-node':
      execSync(`flow-weaver modify addNode --file "${file}" --nodeId "${args.nodeId}" --nodeType "${args.nodeType}"`, { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file! };
    case 'remove-node':
      execSync(`flow-weaver modify removeNode --file "${file}" --nodeId "${args.nodeId}"`, { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file! };
    case 'add-connection':
      execSync(`flow-weaver modify addConnection --file "${file}" --from "${args.from}" --to "${args.to}"`, { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file! };
    case 'remove-connection':
      execSync(`flow-weaver modify removeConnection --file "${file}" --from "${args.from}" --to "${args.to}"`, { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file! };
    case 'scaffold':
      execSync(`flow-weaver create workflow "${args.template}" "${file}"`, { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return { file: file!, created: true };
    case 'read-file':
      return {};
    case 'run-cli': {
      const cmd = args.command as string;
      const cliArgs = (args.args as string[])?.join(' ') ?? '';
      execSync(`flow-weaver ${cmd} ${cliArgs}`, { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
      return {};
    }
    default:
      throw new Error(`Unknown operation: ${step.operation}`);
  }
}

function checkSteering(): 'cancel' | 'pause' | null {
  try {
    const controlPath = path.join(os.homedir(), '.weaver', 'control.json');
    if (!fs.existsSync(controlPath)) return null;
    const raw = fs.readFileSync(controlPath, 'utf-8');
    fs.unlinkSync(controlPath);
    const cmd = JSON.parse(raw) as { command: string };
    if (cmd.command === 'cancel') return 'cancel';
    if (cmd.command === 'pause') return 'pause';
    return null;
  } catch {
    return null;
  }
}

async function waitForResume(): Promise<void> {
  const controlPath = path.join(os.homedir(), '.weaver', 'control.json');
  while (true) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      if (fs.existsSync(controlPath)) {
        const raw = fs.readFileSync(controlPath, 'utf-8');
        fs.unlinkSync(controlPath);
        const cmd = JSON.parse(raw) as { command: string };
        if (cmd.command === 'resume' || cmd.command === 'cancel') {
          console.log(`\x1b[36m→ ${cmd.command === 'resume' ? 'Resumed' : 'Cancelled'}\x1b[0m`);
          return;
        }
      }
    } catch { /* retry */ }
  }
}
