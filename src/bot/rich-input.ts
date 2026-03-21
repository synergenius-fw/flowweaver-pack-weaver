import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';

export interface RichInputOptions {
  historyFile?: string;
  prompt?: string;
  completionProvider?: (partial: string) => string[];
  maxHistorySize?: number;
}

export class RichInput {
  private history: string[] = [];
  private historyIndex = -1;
  private currentLine = '';
  private cursorPos = 0;
  private multiLineBuffer: string[] = [];
  private searchMode = false;
  private searchQuery = '';
  private ctrlCCount = 0;
  private prompt: string;
  private historyFile: string;
  private completionProvider?: (partial: string) => string[];
  private maxHistory: number;

  constructor(opts: RichInputOptions = {}) {
    this.prompt = opts.prompt ?? '❯ ';
    this.historyFile = opts.historyFile ?? path.join(os.homedir(), '.weaver', 'input-history.txt');
    this.completionProvider = opts.completionProvider;
    this.maxHistory = opts.maxHistorySize ?? 500;
    this.loadHistory();
  }

  async getInput(): Promise<string | null> {
    // Non-TTY fallback
    if (!process.stdin.isTTY) {
      return this.getInputReadline();
    }

    return new Promise((resolve) => {
      this.ctrlCCount = 0;
      this.historyIndex = -1;
      this.currentLine = '';
      this.cursorPos = 0;
      this.searchMode = false;

      process.stdin.setRawMode(true);
      process.stdin.resume();

      const handler = (key: Buffer) => {
        this.handleKey(key, (result) => {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', handler);
          resolve(result);
        });
      };

      process.stdin.on('data', handler);
      this.renderPrompt();
    });
  }

  resetCtrlC(): void {
    this.ctrlCCount = 0;
  }

  private handleKey(key: Buffer, resolve: (value: string | null) => void): void {
    const s = key.toString();

    // Handle search mode separately
    if (this.searchMode) {
      this.handleSearchKey(s, resolve);
      return;
    }

    if (s === '\r' || s === '\n') {
      this.handleEnter(resolve);
    } else if (s === '\x03') { // Ctrl+C
      this.ctrlCCount++;
      if (this.ctrlCCount >= 2 || this.currentLine === '') {
        process.stderr.write('\n');
        resolve(null);
      } else {
        this.currentLine = '';
        this.cursorPos = 0;
        process.stderr.write('\n');
        this.renderPrompt();
      }
    } else if (s === '\x0c') { // Ctrl+L
      process.stderr.write('\x1b[2J\x1b[H'); // clear screen + move to top
      this.renderPrompt();
    } else if (s === '\x12') { // Ctrl+R
      this.searchMode = true;
      this.searchQuery = '';
      this.renderSearchPrompt();
    } else if (s === '\x09') { // Tab
      this.handleTab();
    } else if (s === '\x1b[A') { // Arrow Up
      this.historyUp();
    } else if (s === '\x1b[B') { // Arrow Down
      this.historyDown();
    } else if (s === '\x1b[C') { // Arrow Right
      if (this.cursorPos < this.currentLine.length) {
        this.cursorPos++;
        process.stderr.write('\x1b[C');
      }
    } else if (s === '\x1b[D') { // Arrow Left
      if (this.cursorPos > 0) {
        this.cursorPos--;
        process.stderr.write('\x1b[D');
      }
    } else if (s === '\x7f' || s === '\b') { // Backspace
      if (this.cursorPos > 0) {
        this.currentLine = this.currentLine.slice(0, this.cursorPos - 1) + this.currentLine.slice(this.cursorPos);
        this.cursorPos--;
        this.renderPrompt();
      }
    } else if (s === '\x1b[3~') { // Delete
      if (this.cursorPos < this.currentLine.length) {
        this.currentLine = this.currentLine.slice(0, this.cursorPos) + this.currentLine.slice(this.cursorPos + 1);
        this.renderPrompt();
      }
    } else if (s === '\x01') { // Ctrl+A (home)
      this.cursorPos = 0;
      this.renderPrompt();
    } else if (s === '\x05') { // Ctrl+E (end)
      this.cursorPos = this.currentLine.length;
      this.renderPrompt();
    } else if (s === '\x15') { // Ctrl+U (clear line)
      this.currentLine = '';
      this.cursorPos = 0;
      this.renderPrompt();
    } else if (s >= ' ' && s.length === 1) { // Printable
      this.ctrlCCount = 0;
      this.currentLine = this.currentLine.slice(0, this.cursorPos) + s + this.currentLine.slice(this.cursorPos);
      this.cursorPos++;
      this.renderPrompt();
    } else if (s.length > 1 && !s.startsWith('\x1b')) {
      // Pasted text (multiple chars at once)
      this.ctrlCCount = 0;
      this.currentLine = this.currentLine.slice(0, this.cursorPos) + s + this.currentLine.slice(this.cursorPos);
      this.cursorPos += s.length;
      this.renderPrompt();
    }
  }

  private handleEnter(resolve: (value: string | null) => void): void {
    const fullLine = this.multiLineBuffer.length > 0
      ? [...this.multiLineBuffer, this.currentLine].join('\n')
      : this.currentLine;

    // Check for multi-line continuation
    if (this.isIncomplete(fullLine)) {
      this.multiLineBuffer.push(this.currentLine);
      this.currentLine = '';
      this.cursorPos = 0;
      process.stderr.write('\n');
      process.stderr.write('  ... ');
      return;
    }

    process.stderr.write('\n');

    const trimmed = fullLine.trim();
    if (trimmed) {
      this.addToHistory(trimmed);
    }

    this.multiLineBuffer = [];
    this.currentLine = '';
    this.cursorPos = 0;

    resolve(trimmed || null);
  }

  private isIncomplete(text: string): boolean {
    const backticks = (text.match(/```/g) || []).length;
    if (backticks % 2 !== 0) return true;
    if (text.endsWith('\\')) return true;
    return false;
  }

  private historyUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.currentLine = this.history[this.history.length - 1 - this.historyIndex];
      this.cursorPos = this.currentLine.length;
      this.renderPrompt();
    }
  }

  private historyDown(): void {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.currentLine = this.history[this.history.length - 1 - this.historyIndex];
      this.cursorPos = this.currentLine.length;
      this.renderPrompt();
    } else if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this.currentLine = '';
      this.cursorPos = 0;
      this.renderPrompt();
    }
  }

  private handleTab(): void {
    if (!this.completionProvider) return;
    const candidates = this.completionProvider(this.currentLine);
    if (candidates.length === 0) return;
    if (candidates.length === 1) {
      this.currentLine = candidates[0];
      this.cursorPos = this.currentLine.length;
      this.renderPrompt();
    } else {
      // Show candidates below, then redraw prompt
      process.stderr.write('\n  ' + candidates.join('  ') + '\n');
      this.renderPrompt();
    }
  }

  private handleSearchKey(s: string, resolve: (value: string | null) => void): void {
    if (s === '\x1b' || s === '\x03') { // Esc or Ctrl+C — cancel search
      this.searchMode = false;
      this.renderPrompt();
    } else if (s === '\r' || s === '\n') { // Enter — accept match
      this.searchMode = false;
      const match = this.searchHistory(this.searchQuery);
      if (match) {
        this.currentLine = match;
        this.cursorPos = this.currentLine.length;
      }
      this.renderPrompt();
    } else if (s === '\x7f' || s === '\b') { // Backspace
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.renderSearchPrompt();
    } else if (s >= ' ' && s.length === 1) {
      this.searchQuery += s;
      this.renderSearchPrompt();
    }
  }

  private searchHistory(query: string): string | null {
    if (!query) return null;
    const lower = query.toLowerCase();
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].toLowerCase().includes(lower)) return this.history[i];
    }
    return null;
  }

  private renderPrompt(): void {
    process.stderr.write(`\r\x1b[K${this.prompt}${this.currentLine}`);
    // Move cursor to correct position
    const offset = this.currentLine.length - this.cursorPos;
    if (offset > 0) process.stderr.write(`\x1b[${offset}D`);
  }

  private renderSearchPrompt(): void {
    const match = this.searchHistory(this.searchQuery) ?? '';
    process.stderr.write(`\r\x1b[K\x1b[2m(search): ${this.searchQuery}\x1b[0m  ${match}`);
  }

  private addToHistory(line: string): void {
    // Don't add duplicates of the last entry
    if (this.history.length > 0 && this.history[this.history.length - 1] === line) return;
    this.history.push(line);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.saveHistory();
  }

  private loadHistory(): void {
    try {
      if (fs.existsSync(this.historyFile)) {
        this.history = fs.readFileSync(this.historyFile, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .slice(-this.maxHistory);
      }
    } catch { /* history not available */ }
  }

  private saveHistory(): void {
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.historyFile, this.history.join('\n') + '\n');
    } catch { /* non-fatal */ }
  }

  private async getInputReadline(): Promise<string | null> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: this.prompt });
    return new Promise<string | null>((resolve) => {
      rl.prompt();
      rl.once('line', (line) => { rl.close(); resolve(line.trim() || null); });
      rl.once('close', () => resolve(null));
    });
  }

  destroy(): void {
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
  }
}
