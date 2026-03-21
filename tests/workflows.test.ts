import { vi } from 'vitest';
import * as path from 'node:path';
import { parseWorkflow, validateWorkflow, compileWorkflow } from '@synergenius/flow-weaver';

// ── Mock node-type modules for the dry-run smoke test ─────────────────────────
// These are hoisted by Vitest and do not affect the validate/compile tests above
// (those use the Flow Weaver parse/compile API, not the runtime node modules).

vi.mock('../src/node-types/load-config.js', () => ({ weaverLoadConfig: vi.fn() }));
vi.mock('../src/node-types/detect-provider.js', () => ({ weaverDetectProvider: vi.fn() }));
vi.mock('../src/node-types/receive-task.js', () => ({ weaverReceiveTask: vi.fn() }));
vi.mock('../src/node-types/route-task.js', () => ({ weaverRouteTask: vi.fn() }));
vi.mock('../src/node-types/read-workflow.js', () => ({ weaverReadWorkflow: vi.fn() }));
vi.mock('../src/node-types/build-context.js', () => ({ weaverBuildContext: vi.fn() }));
vi.mock('../src/node-types/plan-task.js', () => ({ weaverPlanTask: vi.fn() }));
vi.mock('../src/node-types/approval-gate.js', () => ({ weaverApprovalGate: vi.fn() }));
vi.mock('../src/node-types/abort-task.js', () => ({ weaverAbortTask: vi.fn() }));
vi.mock('../src/node-types/exec-validate-retry.js', () => ({ weaverExecValidateRetry: vi.fn() }));
vi.mock('../src/node-types/git-ops.js', () => ({ weaverGitOps: vi.fn() }));
vi.mock('../src/node-types/send-notify.js', () => ({ weaverSendNotify: vi.fn() }));
vi.mock('../src/node-types/bot-report.js', () => ({ weaverBotReport: vi.fn() }));

const workflowsDir = path.join(__dirname, '..', 'src', 'workflows');

async function validateFile(filename: string) {
  const filePath = path.join(workflowsDir, filename);
  const parseResult = await parseWorkflow(filePath);
  if (parseResult.errors.length > 0) {
    throw new Error(
      `Parse failed for ${filename}:\n${parseResult.errors.join('\n')}`,
    );
  }
  return validateWorkflow(parseResult.ast);
}

async function compileFile(filename: string) {
  const filePath = path.join(workflowsDir, filename);
  return compileWorkflow(filePath, { write: false });
}

describe('workflow validation', () => {
  it('weaver-bot.ts validates without errors', async () => {
    const result = await validateFile('weaver-bot.ts');
    expect(result.errors).toEqual([]);
  });

  it('weaver-bot-batch.ts validates without errors', async () => {
    const result = await validateFile('weaver-bot-batch.ts');
    expect(result.errors).toEqual([]);
  });

  it('genesis-task.ts validates without errors', async () => {
    const result = await validateFile('genesis-task.ts');
    expect(result.errors).toEqual([]);
  });

  it('weaver-agent.ts validates without errors', async () => {
    const result = await validateFile('weaver-agent.ts');
    expect(result.errors).toEqual([]);
  });
});

// ── Lazy imports for the smoke test (after mocks are hoisted) ─────────────────

let weaverBot: typeof import('../src/workflows/weaver-bot.js').weaverBot;
let loadConfigMod: typeof import('../src/node-types/load-config.js');
let detectProviderMod: typeof import('../src/node-types/detect-provider.js');
let receiveTaskMod: typeof import('../src/node-types/receive-task.js');
let botReportMod: typeof import('../src/node-types/bot-report.js');

beforeAll(async () => {
  weaverBot = (await import('../src/workflows/weaver-bot.js')).weaverBot;
  loadConfigMod = await import('../src/node-types/load-config.js');
  detectProviderMod = await import('../src/node-types/detect-provider.js');
  receiveTaskMod = await import('../src/node-types/receive-task.js');
  botReportMod = await import('../src/node-types/bot-report.js');
});

describe('workflow compilation', () => {
  it('weaver-bot.ts compiles successfully', async () => {
    const result = await compileFile('weaver-bot.ts');
    expect(result.code).toBeTruthy();
    expect(result.code.length).toBeGreaterThan(0);
  });

  it('weaver-bot-batch.ts compiles successfully', async () => {
    const result = await compileFile('weaver-bot-batch.ts');
    expect(result.code).toBeTruthy();
    expect(result.code.length).toBeGreaterThan(0);
  });

  it('genesis-task.ts compiles successfully', async () => {
    const result = await compileFile('genesis-task.ts');
    expect(result.code).toBeTruthy();
    expect(result.code.length).toBeGreaterThan(0);
  });

  it('weaver-agent.ts compiles successfully', async () => {
    const result = await compileFile('weaver-agent.ts');
    expect(result.code).toBeTruthy();
    expect(result.code.length).toBeGreaterThan(0);
  });
});

// ── Dry-run smoke test ────────────────────────────────────────────────────────

describe('weaverBot dry-run smoke test', () => {
  const mockEnv = {
    projectDir: '/test',
    config: { provider: 'auto' as const },
    providerType: 'anthropic' as const,
    providerInfo: { type: 'anthropic' as const, apiKey: 'test-key' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.mocked(loadConfigMod.weaverLoadConfig).mockReturnValue({
      projectDir: '/test',
      config: { provider: 'auto' },
    });

    vi.mocked(detectProviderMod.weaverDetectProvider).mockReturnValue({ env: mockEnv } as any);

    vi.mocked(receiveTaskMod.weaverReceiveTask).mockResolvedValue({
      onSuccess: false,
      onFailure: true,
      ctx: JSON.stringify({ env: mockEnv, taskJson: '{}', hasTask: false }),
    });

    vi.mocked(botReportMod.weaverBotReport).mockResolvedValue({
      onSuccess: true,
      onFailure: false,
      summary: 'no tasks pending',
      reportJson: '{}',
    });
  });

  it('returns a result object with the expected shape without throwing', async () => {
    const result = await weaverBot(false, {});
    expect(result).toHaveProperty('onSuccess');
    expect(result).toHaveProperty('onFailure');
    expect(result).toHaveProperty('summary');
    expect(result.onFailure).toBe(false);
  });

  it('calls weaverLoadConfig and weaverDetectProvider to set up the provider env', async () => {
    await weaverBot(false, {});
    expect(vi.mocked(loadConfigMod.weaverLoadConfig)).toHaveBeenCalled();
    expect(vi.mocked(detectProviderMod.weaverDetectProvider)).toHaveBeenCalled();
  });

  it('propagates projectDir param to weaverLoadConfig', async () => {
    await weaverBot(false, { projectDir: '/my/project' });
    expect(vi.mocked(loadConfigMod.weaverLoadConfig)).toHaveBeenCalledWith('/my/project');
  });
});
