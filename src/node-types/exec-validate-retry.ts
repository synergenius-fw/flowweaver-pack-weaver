import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

interface ProviderInfo {
  type: 'anthropic' | 'claude-cli' | 'copilot-cli';
  model?: string;
  maxTokens?: number;
  apiKey?: string;
}

function callCli(provider: string, prompt: string): string {
  if (provider === 'claude-cli') {
    return execSync('claude -p --output-format text', {
      input: prompt, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000,
    }).trim();
  }
  if (provider === 'copilot-cli') {
    return execSync('copilot -p --silent --allow-all-tools', {
      input: prompt, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000,
    }).trim();
  }
  throw new Error(`Unknown CLI provider: ${provider}`);
}

async function callApi(
  apiKey: string, model: string, maxTokens: number,
  systemPrompt: string, userPrompt: string,
): Promise<string> {
  const body = JSON.stringify({
    model, max_tokens: maxTokens, system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
  }
  const json = await response.json() as { content: Array<{ type: string; text: string }> };
  return json.content[0]?.text ?? '';
}

function parseJsonResponse(text: string): Record<string, unknown> {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try { return JSON.parse(cleaned); } catch { /* fallthrough */ }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error(`Failed to parse AI response as JSON: ${text.slice(0, 200)}`);
}

/**
 * Execute-validate-fix retry loop. Runs the plan, validates results,
 * and if validation fails, asks the AI for fixes. Up to 3 attempts.
 *
 * @flowWeaver nodeType
 * @label Execute & Validate
 * @input projectDir [order:0] - Project root directory
 * @input config [order:1] - Config (JSON)
 * @input providerType [order:2] - Provider type
 * @input providerInfo [order:3] - Provider info (JSON)
 * @input planJson [order:4] - Execution plan (JSON)
 * @input taskJson [order:5] - Task (JSON)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output config [order:1] - Config (pass-through)
 * @output providerType [order:2] - Provider type (pass-through)
 * @output providerInfo [order:3] - Provider info (pass-through)
 * @output resultJson [order:4] - Final execution result (JSON)
 * @output validationResultJson [order:5] - Final validation result (JSON)
 * @output filesModified [order:6] - All modified files (JSON array)
 * @output taskJson [order:7] - Task (pass-through)
 * @output allValid [order:8] - Whether all files are valid
 * @output onSuccess [order:-2] - On Success
 * @output onFailure [order:-1] - On Failure
 */
export async function weaverExecValidateRetry(
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
  resultJson: string; validationResultJson: string;
  filesModified: string; taskJson: string; allValid: boolean;
}> {
  const passthrough = { projectDir, config, providerType, providerInfo, taskJson };

  if (!execute) {
    return {
      onSuccess: true, onFailure: false, ...passthrough,
      resultJson: JSON.stringify({ success: true, stepsCompleted: 0, stepsTotal: 0 }),
      validationResultJson: '[]', filesModified: '[]', allValid: true,
    };
  }

  const pInfo: ProviderInfo = JSON.parse(providerInfo);
  const maxAttempts = 3;
  let currentPlan = JSON.parse(planJson);
  let allFilesModified: string[] = [];
  let lastExecResult: Record<string, unknown> = {};
  let lastValidation: Array<{ file: string; valid: boolean; errors: string[] }> = [];
  let allValid = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\x1b[36m→ Attempt ${attempt}/${maxAttempts}\x1b[0m`);

    // Execute plan steps
    const execResult = executePlanSteps(currentPlan, projectDir);
    lastExecResult = execResult;
    allFilesModified = [...new Set([...allFilesModified, ...execResult.filesModified])];

    // Validate results
    const validation = validateFiles(execResult.filesModified, projectDir);
    lastValidation = validation;
    allValid = validation.every(v => v.valid);

    if (allValid) {
      console.log('\x1b[32m→ All files valid\x1b[0m');
      break;
    }

    if (attempt < maxAttempts) {
      console.log(`\x1b[33m→ Validation errors found, requesting fix plan...\x1b[0m`);
      const errors = validation.filter(v => !v.valid).map(v => `${v.file}: ${v.errors.join(', ')}`).join('\n');

      try {
        let systemPrompt: string;
        try {
          const mod = await import('../bot/system-prompt.js');
          systemPrompt = await mod.buildSystemPrompt();
        } catch {
          systemPrompt = 'You are Weaver. Return ONLY valid JSON.';
        }

        const fixPrompt = `The following validation errors occurred:\n${errors}\n\nProvide a fix plan as JSON with steps and summary.`;

        let text: string;
        if (pInfo.type === 'anthropic') {
          text = await callApi(pInfo.apiKey!, pInfo.model ?? 'claude-sonnet-4-6', pInfo.maxTokens ?? 8192, systemPrompt, fixPrompt);
        } else {
          text = callCli(pInfo.type, systemPrompt + '\n\n' + fixPrompt);
        }

        currentPlan = parseJsonResponse(text);
        console.log(`\x1b[36m→ Fix plan: ${(currentPlan as { summary?: string }).summary ?? 'generated'}\x1b[0m`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\x1b[31m→ Fix planning failed: ${msg}\x1b[0m`);
        break;
      }
    }
  }

  return {
    onSuccess: allValid, onFailure: !allValid, ...passthrough,
    resultJson: JSON.stringify(lastExecResult),
    validationResultJson: JSON.stringify(lastValidation),
    filesModified: JSON.stringify(allFilesModified),
    allValid,
  };
}

function executePlanSteps(
  plan: { steps: Array<{ id: string; operation: string; description: string; args: Record<string, unknown> }> },
  projectDir: string,
): { success: boolean; filesModified: string[]; errors: string[]; stepsCompleted: number; stepsTotal: number } {
  const filesModified: string[] = [];
  const errors: string[] = [];
  let completed = 0;
  const steps = plan.steps ?? [];

  for (const step of steps) {
    // Check steering between steps
    const steering = checkSteeringSignal();
    if (steering === 'cancel') {
      errors.push(`Cancelled at step ${step.id}`);
      break;
    }

    try {
      const result = executeStep(step, projectDir);
      if (result.file) filesModified.push(result.file);
      if (result.files) filesModified.push(...result.files);
      completed++;
      console.log(`\x1b[32m  + ${step.id}: ${step.description}\x1b[0m`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${step.id}: ${msg}`);
      console.error(`\x1b[31m  x ${step.id}: ${msg}\x1b[0m`);
    }
  }

  return { success: errors.length === 0, filesModified: [...new Set(filesModified)], errors, stepsCompleted: completed, stepsTotal: steps.length };
}

function executeStep(
  step: { operation: string; args: Record<string, unknown> },
  projectDir: string,
): { file?: string; files?: string[] } {
  const args = step.args;
  const file = args.file as string | undefined;

  switch (step.operation) {
    case 'write-file':
    case 'create-workflow':
    case 'modify-source':
    case 'implement-node': {
      const filePath = path.resolve(projectDir, file!);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, (args.content as string) ?? (args.body as string) ?? '', 'utf-8');
      return { file: filePath };
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
      return { file: file! };
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

function validateFiles(
  files: string[],
  projectDir: string,
): Array<{ file: string; valid: boolean; errors: string[]; warnings: string[] }> {
  const results: Array<{ file: string; valid: boolean; errors: string[]; warnings: string[] }> = [];

  for (const file of files) {
    if (!file.endsWith('.ts')) continue;
    try {
      execSync(`flow-weaver validate "${file}"`, {
        cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
      });
      results.push({ file, valid: true, errors: [], warnings: [] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err as { stderr?: string }).stderr ?? err.message : String(err);
      results.push({ file, valid: false, errors: [msg], warnings: [] });
    }
  }

  return results;
}

function checkSteeringSignal(): 'cancel' | null {
  try {
    const controlPath = path.join(os.homedir(), '.weaver', 'control.json');
    if (!fs.existsSync(controlPath)) return null;
    const raw = fs.readFileSync(controlPath, 'utf-8');
    fs.unlinkSync(controlPath);
    const cmd = JSON.parse(raw) as { command: string };
    if (cmd.command === 'cancel') return 'cancel';
    return null;
  } catch {
    return null;
  }
}
