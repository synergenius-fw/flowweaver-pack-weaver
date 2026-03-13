import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  PipelineConfig,
  PipelineResult,
  PipelineStage,
  StageCondition,
  StageResult,
  StageStatus,
  WorkflowResult,
  WeaverConfig,
  ExecutionEvent,
} from './types.js';
import type { NotificationErrorHandler } from './notifications.js';
import { runWorkflow } from './runner.js';

export interface PipelineRunOptions {
  verbose?: boolean;
  dryRun?: boolean;
  config?: WeaverConfig;
  stage?: string;
  onStageEvent?: (stageId: string, status: StageStatus, result?: WorkflowResult) => void;
  onEvent?: (event: ExecutionEvent) => void;
  onNotificationError?: NotificationErrorHandler;
}

export class PipelineRunner {
  static load(configPath: string): PipelineConfig {
    const absPath = path.resolve(configPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Pipeline config not found: ${absPath}`);
    }

    let raw: PipelineConfig;
    try {
      raw = JSON.parse(fs.readFileSync(absPath, 'utf-8')) as PipelineConfig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON in pipeline config: ${absPath}\n  ${msg}`);
    }
    const configDir = path.dirname(absPath);

    // Resolve workflow paths relative to config file
    for (const stage of raw.stages) {
      if (!path.isAbsolute(stage.workflow)) {
        stage.workflow = path.resolve(configDir, stage.workflow);
      }
    }

    return raw;
  }

  async run(config: PipelineConfig, options?: PipelineRunOptions): Promise<PipelineResult> {
    this.validate(config);

    const stageMap = new Map(config.stages.map((s) => [s.id, s]));
    const waves = this.topologicalWaves(config.stages);
    const results: Record<string, StageResult> = {};
    const stageOrder: string[] = [];
    let aborted = false;
    const pipelineStart = Date.now();

    // If filtering to a single stage, compute transitive deps
    const activeIds = options?.stage
      ? this.transitiveDeps(options.stage, stageMap)
      : null;

    for (const wave of waves) {
      const waveStages = activeIds
        ? wave.filter((id) => activeIds.has(id))
        : wave;

      if (waveStages.length === 0) continue;

      const promises = waveStages.map(async (stageId) => {
        const stage = stageMap.get(stageId)!;
        const condition = stage.condition ?? 'on-success';

        if (aborted && condition !== 'always') {
          const sr: StageResult = { id: stageId, status: 'cancelled', workflowResult: null, durationMs: 0, wave: waves.indexOf(wave) };
          results[stageId] = sr;
          stageOrder.push(stageId);
          options?.onStageEvent?.(stageId, 'cancelled');
          return;
        }

        if (!this.shouldRun(stage, results)) {
          const sr: StageResult = { id: stageId, status: 'skipped', workflowResult: null, durationMs: 0, wave: waves.indexOf(wave) };
          results[stageId] = sr;
          stageOrder.push(stageId);
          options?.onStageEvent?.(stageId, 'skipped');
          return;
        }

        options?.onStageEvent?.(stageId, 'running');
        const stageStart = Date.now();

        // Merge params with upstream results
        const params: Record<string, unknown> = {
          ...(stage.params ?? {}),
          __stages: this.buildStageContext(stage, results),
        };

        try {
          const timeout = stage.timeoutSeconds ?? config.defaultTimeoutSeconds;
          const workflowPromise = runWorkflow(stage.workflow, {
            params,
            verbose: options?.verbose,
            dryRun: options?.dryRun,
            config: config.config ?? options?.config,
            onEvent: options?.onEvent,
            onNotificationError: options?.onNotificationError,
          });

          let workflowResult: WorkflowResult;
          if (timeout) {
            workflowResult = await Promise.race([
              workflowPromise,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Stage "${stageId}" timed out after ${timeout}s`)), timeout * 1000),
              ),
            ]);
          } else {
            workflowResult = await workflowPromise;
          }

          const status: StageStatus = workflowResult.success ? 'completed' : 'failed';
          const sr: StageResult = {
            id: stageId,
            status,
            workflowResult,
            durationMs: Date.now() - stageStart,
            wave: waves.indexOf(wave),
          };
          results[stageId] = sr;
          stageOrder.push(stageId);
          options?.onStageEvent?.(stageId, status, workflowResult);

          if (!workflowResult.success && config.failFast !== false) {
            aborted = true;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const sr: StageResult = {
            id: stageId,
            status: 'failed',
            workflowResult: null,
            durationMs: Date.now() - stageStart,
            error: msg,
            wave: waves.indexOf(wave),
          };
          results[stageId] = sr;
          stageOrder.push(stageId);
          options?.onStageEvent?.(stageId, 'failed');

          if (config.failFast !== false) {
            aborted = true;
          }
        }
      });

      await Promise.allSettled(promises);
    }

    const allResults = Object.values(results);
    const anyFailed = allResults.some((r) => r.status === 'failed');
    const anyCancelled = allResults.some((r) => r.status === 'cancelled');

    return {
      success: !anyFailed && !anyCancelled,
      outcome: anyFailed ? 'failed' : anyCancelled ? 'cancelled' : 'completed',
      durationMs: Date.now() - pipelineStart,
      stages: results,
      stageOrder,
    };
  }

  private validate(config: PipelineConfig): void {
    if (!config.stages || config.stages.length === 0) {
      throw new Error('Pipeline must have at least one stage');
    }

    const ids = new Set<string>();
    for (const stage of config.stages) {
      if (ids.has(stage.id)) {
        throw new Error(`Duplicate stage id: "${stage.id}"`);
      }
      ids.add(stage.id);
    }

    for (const stage of config.stages) {
      for (const dep of stage.dependsOn ?? []) {
        if (!ids.has(dep)) {
          throw new Error(`Stage "${stage.id}" depends on unknown stage "${dep}"`);
        }
      }
    }

    this.detectCycle(config.stages);
  }

  private detectCycle(stages: PipelineStage[]): void {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const parent = new Map<string, string>();
    const adj = new Map<string, string[]>();

    for (const s of stages) {
      color.set(s.id, WHITE);
      adj.set(s.id, s.dependsOn ?? []);
    }

    const dfs = (id: string): string | null => {
      color.set(id, GRAY);
      for (const dep of adj.get(id) ?? []) {
        if (color.get(dep) === GRAY) {
          // Reconstruct cycle
          const cycle = [dep, id];
          let cur = id;
          while (parent.has(cur) && parent.get(cur) !== dep) {
            cur = parent.get(cur)!;
            cycle.push(cur);
          }
          return cycle.reverse().join(' -> ');
        }
        if (color.get(dep) === WHITE) {
          parent.set(dep, id);
          const result = dfs(dep);
          if (result) return result;
        }
      }
      color.set(id, BLACK);
      return null;
    };

    for (const s of stages) {
      if (color.get(s.id) === WHITE) {
        const cycle = dfs(s.id);
        if (cycle) {
          throw new Error(`Circular dependency detected: ${cycle}`);
        }
      }
    }
  }

  private topologicalWaves(stages: PipelineStage[]): string[][] {
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const s of stages) {
      inDegree.set(s.id, (s.dependsOn ?? []).length);
      for (const dep of s.dependsOn ?? []) {
        const list = dependents.get(dep) ?? [];
        list.push(s.id);
        dependents.set(dep, list);
      }
    }

    const waves: string[][] = [];
    let remaining = stages.length;

    while (remaining > 0) {
      const wave: string[] = [];
      for (const [id, deg] of inDegree) {
        if (deg === 0) wave.push(id);
      }

      if (wave.length === 0) break; // should not happen after cycle check

      for (const id of wave) {
        inDegree.delete(id);
        for (const dep of dependents.get(id) ?? []) {
          inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
        }
      }

      waves.push(wave);
      remaining -= wave.length;
    }

    return waves;
  }

  private transitiveDeps(stageId: string, stageMap: Map<string, PipelineStage>): Set<string> {
    const result = new Set<string>();
    const visit = (id: string) => {
      if (result.has(id)) return;
      result.add(id);
      const stage = stageMap.get(id);
      if (!stage) throw new Error(`Unknown stage: "${id}"`);
      for (const dep of stage.dependsOn ?? []) {
        visit(dep);
      }
    };
    visit(stageId);
    return result;
  }

  private shouldRun(stage: PipelineStage, results: Record<string, StageResult>): boolean {
    const condition: StageCondition = stage.condition ?? 'on-success';
    const deps = stage.dependsOn ?? [];

    if (deps.length === 0) return true;

    const allSucceeded = deps.every((d) => results[d]?.status === 'completed');
    const someFailed = deps.some((d) => results[d]?.status === 'failed');

    switch (condition) {
      case 'on-success':
        return allSucceeded;
      case 'on-failure':
        return someFailed;
      case 'always':
        return true;
      default:
        return allSucceeded;
    }
  }

  private buildStageContext(
    stage: PipelineStage,
    results: Record<string, StageResult>,
  ): Record<string, WorkflowResult | null> {
    const ctx: Record<string, WorkflowResult | null> = {};
    for (const dep of stage.dependsOn ?? []) {
      ctx[dep] = results[dep]?.workflowResult ?? null;
    }
    return ctx;
  }
}
