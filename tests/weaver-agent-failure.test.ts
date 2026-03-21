import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all node-type modules before importing the workflow
vi.mock('../src/node-types/load-config.js', () => ({ weaverLoadConfig: vi.fn() }));
vi.mock('../src/node-types/detect-provider.js', () => ({ weaverDetectProvider: vi.fn() }));
vi.mock('../src/node-types/receive-task.js', () => ({ weaverReceiveTask: vi.fn() }));
vi.mock('../src/node-types/build-context.js', () => ({ weaverBuildContext: vi.fn() }));
vi.mock('../src/node-types/agent-execute.js', () => ({ weaverAgentExecute: vi.fn() }));
vi.mock('../src/node-types/git-ops.js', () => ({ weaverGitOps: vi.fn() }));
vi.mock('../src/node-types/send-notify.js', () => ({ weaverSendNotify: vi.fn() }));
vi.mock('../src/node-types/bot-report.js', () => ({ weaverBotReport: vi.fn() }));

import { weaverAgent } from '../src/workflows/weaver-agent.js';
import * as loadConfigMod from '../src/node-types/load-config.js';
import * as detectProviderMod from '../src/node-types/detect-provider.js';
import * as receiveTaskMod from '../src/node-types/receive-task.js';
import * as buildContextMod from '../src/node-types/build-context.js';
import * as agentExecuteMod from '../src/node-types/agent-execute.js';
import * as gitOpsMod from '../src/node-types/git-ops.js';
import * as sendNotifyMod from '../src/node-types/send-notify.js';
import * as botReportMod from '../src/node-types/bot-report.js';

const mockLoadConfig = vi.mocked(loadConfigMod.weaverLoadConfig);
const mockDetectProvider = vi.mocked(detectProviderMod.weaverDetectProvider);
const mockReceiveTask = vi.mocked(receiveTaskMod.weaverReceiveTask);
const mockBuildContext = vi.mocked(buildContextMod.weaverBuildContext);
const mockAgentExecute = vi.mocked(agentExecuteMod.weaverAgentExecute);
const mockGitOps = vi.mocked(gitOpsMod.weaverGitOps);
const mockSendNotify = vi.mocked(sendNotifyMod.weaverSendNotify);
const mockBotReport = vi.mocked(botReportMod.weaverBotReport);

const mockEnv = {
  projectDir: '/test',
  config: { provider: 'auto' as const },
  providerType: 'anthropic' as const,
  providerInfo: { type: 'anthropic' as const, apiKey: 'test-key' },
};

function setupCommonMocks() {
  mockLoadConfig.mockReturnValue({ projectDir: '/test', config: { provider: 'auto' } });
  mockDetectProvider.mockReturnValue({ env: mockEnv } as any);
  mockBotReport.mockResolvedValue({
    onSuccess: true,
    onFailure: false,
    summary: 'done',
    reportJson: '{}',
  } as any);
}

describe('weaverAgent — receive:fail path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setupCommonMocks();
    mockReceiveTask.mockResolvedValue({
      onSuccess: false,
      onFailure: true,
      ctx: JSON.stringify({ env: mockEnv, hasTask: false }),
    } as any);
  });

  it('calls weaverLoadConfig and weaverDetectProvider', async () => {
    await weaverAgent(true, {});
    expect(mockLoadConfig).toHaveBeenCalled();
    expect(mockDetectProvider).toHaveBeenCalled();
  });

  it('calls weaverReceiveTask', async () => {
    await weaverAgent(true, {});
    expect(mockReceiveTask).toHaveBeenCalled();
  });

  it('does not call weaverBuildContext when receive fails', async () => {
    await weaverAgent(true, {});
    expect(mockBuildContext).not.toHaveBeenCalled();
  });

  it('does not call weaverAgentExecute when receive fails', async () => {
    await weaverAgent(true, {});
    expect(mockAgentExecute).not.toHaveBeenCalled();
  });

  it('does not call weaverGitOps when receive fails', async () => {
    await weaverAgent(true, {});
    expect(mockGitOps).not.toHaveBeenCalled();
  });

  it('still calls weaverBotReport after receive failure', async () => {
    await weaverAgent(true, {});
    expect(mockBotReport).toHaveBeenCalled();
  });

  it('calls weaverBotReport with execute=false when receive fails', async () => {
    await weaverAgent(true, {});
    const [execute] = mockBotReport.mock.calls[0];
    expect(execute).toBe(false);
  });

  it('returns result without throwing', async () => {
    await expect(weaverAgent(true, {})).resolves.not.toThrow();
  });

  it('returns onFailure=false even when receive fails (report handles it)', async () => {
    const result = await weaverAgent(true, {});
    expect(result.onFailure).toBe(false);
  });

  it('returns summary from weaverBotReport', async () => {
    const result = await weaverAgent(true, {});
    expect(result.summary).toBe('done');
  });

  it('returns onSuccess from weaverBotReport', async () => {
    const result = await weaverAgent(true, {});
    expect(result.onSuccess).toBe(true);
  });

  it('propagates projectDir to weaverLoadConfig', async () => {
    await weaverAgent(true, { projectDir: '/my/project' });
    expect(mockLoadConfig).toHaveBeenCalledWith('/my/project');
  });
});

describe('weaverAgent — agent:fail path (soft failure, no throw)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setupCommonMocks();

    const taskCtx = JSON.stringify({ env: mockEnv, hasTask: true });
    mockReceiveTask.mockResolvedValue({
      onSuccess: true,
      onFailure: false,
      ctx: taskCtx,
    } as any);
    mockBuildContext.mockReturnValue({
      onSuccess: true,
      onFailure: false,
      ctx: taskCtx,
    } as any);
    mockAgentExecute.mockResolvedValue({
      onSuccess: false,
      onFailure: true,
      ctx: JSON.stringify({ env: mockEnv, error: 'agent failed' }),
    } as any);
  });

  it('calls weaverReceiveTask', async () => {
    await weaverAgent(true, {});
    expect(mockReceiveTask).toHaveBeenCalled();
  });

  it('calls weaverBuildContext when receive succeeds', async () => {
    await weaverAgent(true, {});
    expect(mockBuildContext).toHaveBeenCalled();
  });

  it('calls weaverAgentExecute when context succeeds', async () => {
    await weaverAgent(true, {});
    expect(mockAgentExecute).toHaveBeenCalled();
  });

  it('does not call weaverGitOps when agent fails', async () => {
    await weaverAgent(true, {});
    expect(mockGitOps).not.toHaveBeenCalled();
  });

  it('does not call weaverSendNotify when agent fails', async () => {
    await weaverAgent(true, {});
    expect(mockSendNotify).not.toHaveBeenCalled();
  });

  it('still calls weaverBotReport after agent failure', async () => {
    await weaverAgent(true, {});
    expect(mockBotReport).toHaveBeenCalled();
  });

  it('calls weaverBotReport with execute=false when agent fails (no notify/gitOps success)', async () => {
    await weaverAgent(true, {});
    const [execute] = mockBotReport.mock.calls[0];
    expect(execute).toBe(false);
  });

  it('returns result without throwing', async () => {
    await expect(weaverAgent(true, {})).resolves.not.toThrow();
  });

  it('returns onFailure=false (workflow-level always false)', async () => {
    const result = await weaverAgent(true, {});
    expect(result.onFailure).toBe(false);
  });

  it('returns onSuccess from weaverBotReport', async () => {
    const result = await weaverAgent(true, {});
    expect(result.onSuccess).toBe(true);
  });
});

describe('weaverAgent — dry-run (execute=false)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setupCommonMocks();
    mockReceiveTask.mockResolvedValue({
      onSuccess: false,
      onFailure: true,
      ctx: JSON.stringify({ env: mockEnv, hasTask: false }),
    } as any);
  });

  it('returns a result object without throwing', async () => {
    await expect(weaverAgent(false, {})).resolves.toBeDefined();
  });

  it('result has onSuccess, onFailure, summary keys', async () => {
    const result = await weaverAgent(false, {});
    expect(result).toHaveProperty('onSuccess');
    expect(result).toHaveProperty('onFailure');
    expect(result).toHaveProperty('summary');
  });

  it('onFailure is false', async () => {
    const result = await weaverAgent(false, {});
    expect(result.onFailure).toBe(false);
  });
});
