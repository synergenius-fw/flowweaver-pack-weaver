/**
 * Terminal renderer — centralizes all weaver CLI output through
 * a consistent visual grammar. Pipe-safe (stderr only for decoration).
 *
 * Icons: ✓ success · ✗ error · ⚠ warning · ◆ action · ● running
 * Colors: green/red/yellow/cyan/dim/bold — strict assignments
 */

import type { StreamEvent, ToolEvent } from '@synergenius/flow-weaver/agent';
import { c } from './ansi.js';
import { VERBOSE_TOOL_NAMES } from './tool-registry.js';

export interface RendererOptions {
  verbose?: boolean;
  quiet?: boolean;
  noColor?: boolean;
  /** Override stderr writer (for testing) */
  write?: (s: string) => void;
}

export interface TaskEndStats {
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  filesModified: number;
  elapsed: number;
  gitMessage?: string;
}

export interface SessionEndStats {
  tasks: number;
  completed: number;
  failed: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  elapsed: number;
}

export class TerminalRenderer {
  private verbose: boolean;
  private quiet: boolean;
  private out: (s: string) => void;
  private taskStartTime = 0;
  private lastToolStartTime = 0;
  private textBuffer = '';
  private hasActiveText = false;

  constructor(opts: RendererOptions = {}) {
    this.verbose = opts.verbose ?? false;
    this.quiet = opts.quiet ?? false;
    if (opts.noColor) {
      // Strip all color functions
      for (const key of Object.keys(c) as (keyof typeof c)[]) {
        (c as Record<string, (s: string) => string>)[key] = (s: string) => s;
      }
    }
    this.out = opts.write ?? ((s: string) => process.stderr.write(s));
  }

  // --- Session lifecycle ---

  sessionStart(info: { provider: string; parallel?: number; deadline?: string }): void {
    if (this.quiet) return;
    this.out(`${c.bold('[weaver]')} Session started ${c.dim('(Ctrl+C to stop)')}\n`);
    const parts = [`Provider: ${info.provider}`];
    if (info.parallel && info.parallel > 1) parts.push(`Parallel: ${info.parallel}`);
    if (info.deadline) parts.push(`Deadline: ${info.deadline}`);
    this.out(`${c.bold('[weaver]')} ${c.dim(parts.join(' · '))}\n`);
  }

  sessionEnd(stats: SessionEndStats): void {
    if (this.quiet) return;
    this.out('\n');
    const parts: string[] = [];
    parts.push(`${stats.tasks} task${stats.tasks === 1 ? '' : 's'}`);
    if (stats.completed > 0) parts.push(c.green(`${stats.completed} completed`));
    if (stats.failed > 0) parts.push(c.red(`${stats.failed} failed`));
    const skipped = stats.tasks - stats.completed - stats.failed;
    if (skipped > 0) parts.push(c.yellow(`${skipped} skipped`));
    this.out(`${c.bold('[weaver]')} Session complete: ${parts.join(' · ')}\n`);

    const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;
    if (totalTokens > 0) {
      this.out(`${c.bold('[weaver]')} ${c.dim(`Total: ${formatTokens(totalTokens)} tokens · $${stats.totalCost.toFixed(3)} · ${formatElapsed(stats.elapsed)}`)}\n`);
    }
  }

  // --- Task lifecycle ---

  taskStart(index: number, instruction: string): void {
    if (this.quiet) return;
    this.taskStartTime = Date.now();
    this.hasActiveText = false;
    this.textBuffer = '';
    const label = instruction.length > 70 ? instruction.slice(0, 67) + '...' : instruction;
    this.out(`\n${c.cyan('◆')} ${c.bold(`Task ${index}:`)} ${label}\n`);
  }

  taskEnd(success: boolean, stats: TaskEndStats): void {
    if (this.quiet) return;
    // Flush any remaining text
    this.flushText();

    const elapsed = formatElapsed(stats.elapsed);
    const icon = success ? c.green('✓') : c.red('✗');
    const status = success ? 'completed' : 'failed';
    this.out(`${icon} Task ${status} ${c.dim(elapsed)}\n`);

    // Summary line
    const parts: string[] = [];
    if (stats.toolCalls > 0) parts.push(`${stats.toolCalls} tool calls`);
    const totalTokens = stats.inputTokens + stats.outputTokens;
    if (totalTokens > 0) parts.push(`${formatTokens(totalTokens)} tokens`);
    if (stats.estimatedCost > 0) parts.push(`$${stats.estimatedCost.toFixed(3)}`);
    if (stats.filesModified > 0) parts.push(`${stats.filesModified} file${stats.filesModified === 1 ? '' : 's'} modified`);
    if (parts.length > 0) {
      this.out(`  ${c.dim(parts.join(' · '))}\n`);
    }

    if (stats.gitMessage) {
      this.out(`  ${c.dim('→ Git: ' + stats.gitMessage)}\n`);
    }
  }

  // --- Stream event handling ---

  onStreamEvent(event: StreamEvent): void {
    if (this.quiet) return;

    switch (event.type) {
      case 'thinking_delta':
        if (this.verbose) {
          // In verbose mode, stream thinking as dim text
          this.flushText();
          this.out(`  ${c.dim(event.text.replace(/\n/g, '\n  '))}`);
        }
        // In normal mode, thinking is completely hidden
        break;

      case 'text_delta':
        if (this.verbose) {
          this.flushText();
          this.out(event.text);
          this.hasActiveText = true;
        }
        // In normal mode, AI text is hidden (tool calls tell the story)
        break;

      case 'tool_result':
        // CLI internal tool result — show as result line
        break;

      default:
        break;
    }
  }

  onToolEvent(event: ToolEvent): void {
    if (this.quiet) return;

    if (event.type === 'tool_call_start') {
      this.flushText();
      this.lastToolStartTime = Date.now();
      const args = event.args ?? {};
      const preview = toolPreview(event.name, args);
      this.out(`  ${c.cyan('◆')} ${event.name}${preview ? c.dim(`(${preview})`) : ''}\n`);
    }

    if (event.type === 'tool_call_result') {
      const elapsed = Date.now() - this.lastToolStartTime;
      const raw = event.result ?? '';
      const icon = event.isError ? c.red('✗') : c.dim('→');
      // Show full multiline output for verbose tools; one-line summary for others
      const isVerboseTool = VERBOSE_TOOL_NAMES.has(event.name);
      if (isVerboseTool && raw.includes('\n') && raw.length > 120) {
        this.out(`  ${icon} ${c.dim(formatElapsed(elapsed))}\n${raw}\n`);
      } else {
        const result = raw.replace(/\n/g, ' ').slice(0, 200);
        this.out(`  ${icon} ${result} ${c.dim(formatElapsed(elapsed))}\n`);
      }
    }
  }

  // --- Direct messages ---

  info(msg: string): void {
    if (!this.quiet) this.out(`${c.bold('[weaver]')} ${msg}\n`);
  }

  warn(msg: string): void {
    if (!this.quiet) this.out(`${c.yellow('⚠')} ${msg}\n`);
  }

  error(title: string, detail?: string): void {
    this.out(`${c.redBold('✗')} ${c.red(title)}\n`);
    if (detail) this.out(`  ${c.red(detail)}\n`);
  }

  // --- Private ---

  private flushText(): void {
    if (this.hasActiveText) {
      this.out('\n');
      this.hasActiveText = false;
    }
  }
}

// --- Formatting helpers ---

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function toolPreview(name: string, args: Record<string, unknown>): string {
  if (args.file) return String(args.file).split('/').pop() ?? '';
  if (args.command) return String(args.command).slice(0, 50);
  if (args.directory) return String(args.directory).split('/').pop() ?? '';
  // For patch_file, show file + patch count
  if (name === 'patch_file' && args.patches) {
    const file = String(args.file ?? '').split('/').pop() ?? '';
    const count = Array.isArray(args.patches) ? args.patches.length : '?';
    return `${file}, ${count} patches`;
  }
  return '';
}
