import { execSync } from 'node:child_process';
import type { WeaverConfig } from '../bot/types.js';

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which';

interface ProviderInfo {
  type: 'anthropic' | 'claude-cli' | 'copilot-cli';
  model?: string;
  maxTokens?: number;
  apiKey?: string;
}

function whichSafe(cmd: string, cwd: string): string {
  try {
    return execSync(`${WHICH_CMD} ${cmd}`, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

/**
 * Auto-detect or resolve the configured AI provider.
 *
 * @flowWeaver nodeType
 * @expression
 * @label Detect Provider
 * @input projectDir [order:0] - Project root directory
 * @input config [order:1] - Weaver configuration (JSON)
 * @output projectDir [order:0] - Project root directory (pass-through)
 * @output config [order:1] - Config (pass-through)
 * @output providerType [order:2] - Resolved provider type
 * @output providerInfo [order:3] - Provider details (JSON)
 */
export function weaverDetectProvider(projectDir: string, config: string): {
  projectDir: string; config: string;
  providerType: string; providerInfo: string;
} {
  const cfg: WeaverConfig = JSON.parse(config);
  const providerSetting = cfg.provider ?? 'auto';

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
    if (process.env.ANTHROPIC_API_KEY) {
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
    projectDir, config,
    providerType: type,
    providerInfo: JSON.stringify(providerInfo),
  };
}
