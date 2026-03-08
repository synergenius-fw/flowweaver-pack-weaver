import { execFileSync } from 'node:child_process';
import type { WeaverConfig, WeaverEnv, ProviderInfo } from '../bot/types.js';

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which';

function whichSafe(cmd: string, cwd: string): string {
  try {
    return execFileSync(WHICH_CMD, [cmd], { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

/**
 * Auto-detect or resolve the configured AI provider.
 * Assembles the WeaverEnv bundle from projectDir, config, and detected provider.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Detect Provider
 * @input projectDir [order:0] - Project root directory
 * @input config [order:1] - Weaver configuration
 * @output env [order:0] - Weaver environment bundle
 * @output onFailure [hidden]
 */
export function weaverDetectProvider(projectDir: string, config: WeaverConfig): {
  env: WeaverEnv;
} {
  const providerSetting = config.provider ?? 'auto';

  let type: string;
  let model: string | undefined;
  let maxTokens: number | undefined;

  if (typeof providerSetting === 'object') {
    type = providerSetting.name;
    model = providerSetting.model;
    maxTokens = providerSetting.maxTokens;
  } else if (providerSetting !== 'auto') {
    type = providerSetting;
  } else {
    if ((globalThis as any).__fw_llm_provider__) {
      type = 'platform';
    } else if (process.env.ANTHROPIC_API_KEY) {
      type = 'anthropic';
    } else if (whichSafe('claude', projectDir)) {
      type = 'claude-cli';
    } else if (whichSafe('copilot', projectDir)) {
      type = 'copilot-cli';
    } else {
      throw new Error(
        'No AI provider found. Options:\n' +
        '  1. Set ANTHROPIC_API_KEY environment variable\n' +
        '  2. Install Claude CLI: https://docs.anthropic.com/claude-code\n' +
        '  3. Install GitHub Copilot CLI: https://github.com/features/copilot',
      );
    }
  }

  const providerInfo: ProviderInfo = {
    type: type as ProviderInfo['type'],
    model: model ?? (type === 'anthropic' ? 'claude-sonnet-4-6' : undefined),
    maxTokens: maxTokens ?? (type === 'anthropic' ? 4096 : undefined),
    apiKey: type === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined,
  };

  if (type === 'anthropic' && !providerInfo.apiKey) {
    throw new Error('Provider is "anthropic" but ANTHROPIC_API_KEY is not set');
  }

  const label = providerInfo.model ? `${type} (${providerInfo.model})` : type;
  console.log(`\x1b[36m→ Provider: ${label}\x1b[0m`);

  return {
    env: { projectDir, config, providerType: type, providerInfo },
  };
}
