/**
 * Conversation Store — persistent conversation history for the assistant.
 * Mirrors the platform's aiConversations/aiChatMessages tables
 * using file-based storage for CLI use.
 *
 * Layout:
 *   ~/.weaver/conversations/
 *     index.json                  # ConversationRecord[]
 *     {id}/messages.ndjson        # StoredMessage[] (append-only)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { AgentMessage } from '@synergenius/flow-weaver/agent';
import { withFileLock } from './file-lock.js';
import { CHARS_PER_TOKEN } from './safety.js';

export interface ConversationRecord {
  id: string;
  title: string;
  projectDir: string;
  messageCount: number;
  totalTokens: number;
  createdAt: number;
  lastMessageAt: number;
  botIds: string[];
}

interface StoredMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolCallId?: string;
  timestamp: number;
  tokens?: number;
}

const MAX_INDEX_SIZE = 20;

export class ConversationStore {
  private baseDir: string;
  private indexPath: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.weaver', 'conversations');
    this.indexPath = path.join(this.baseDir, 'index.json');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  async create(projectDir: string): Promise<ConversationRecord> {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const now = Date.now();
    const record: ConversationRecord = {
      id,
      title: '',
      projectDir,
      messageCount: 0,
      totalTokens: 0,
      createdAt: now,
      lastMessageAt: now,
      botIds: [],
    };

    // Create conversation directory
    const convDir = path.join(this.baseDir, id);
    fs.mkdirSync(convDir, { recursive: true });

    // Add to index under file lock for concurrent safety
    await withFileLock(this.indexPath, () => {
      const index = this.readIndex();
      index.unshift(record);
      this.writeIndexAtomic(index);
    });

    return record;
  }

  list(): ConversationRecord[] {
    return this.readIndex();
  }

  get(id: string): ConversationRecord | null {
    const index = this.readIndex();
    return index.find(c => c.id === id) ?? null;
  }

  getMostRecent(): ConversationRecord | null {
    const index = this.readIndex();
    return index.length > 0 ? index[0] : null;
  }

  async delete(id: string): Promise<void> {
    // Remove from index under file lock for concurrent safety
    await withFileLock(this.indexPath, () => {
      const index = this.readIndex();
      const filtered = index.filter(c => c.id !== id);
      this.writeIndexAtomic(filtered);
    });

    // Remove files
    const convDir = path.join(this.baseDir, id);
    if (fs.existsSync(convDir)) {
      fs.rmSync(convDir, { recursive: true, force: true });
    }
  }

  loadMessages(id: string): AgentMessage[] {
    const msgPath = path.join(this.baseDir, id, 'messages.ndjson');
    if (!fs.existsSync(msgPath)) return [];

    const content = fs.readFileSync(msgPath, 'utf-8');
    const messages: AgentMessage[] = [];
    let corruptCount = 0;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const stored = JSON.parse(line) as StoredMessage;
        const msg: AgentMessage = {
          role: stored.role,
          content: stored.content,
        };
        if (stored.toolCalls) msg.toolCalls = stored.toolCalls;
        if (stored.toolCallId) msg.toolCallId = stored.toolCallId;
        messages.push(msg);
      } catch {
        corruptCount++;
      }
    }

    if (corruptCount > 0) {
      console.warn(`  (Warning: skipped ${corruptCount} corrupt message(s) in conversation ${id})`);
    }

    return messages;
  }

  appendMessages(id: string, messages: AgentMessage[]): void {
    if (messages.length === 0) return;

    const convDir = path.join(this.baseDir, id);
    fs.mkdirSync(convDir, { recursive: true });
    const msgPath = path.join(convDir, 'messages.ndjson');

    const lines = messages.map(m => {
      const stored: StoredMessage = {
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        timestamp: Date.now(),
        tokens: Math.ceil((typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length) / CHARS_PER_TOKEN),
      };
      if (m.toolCalls) stored.toolCalls = m.toolCalls;
      if (m.toolCallId) stored.toolCallId = m.toolCallId;
      return JSON.stringify(stored);
    });

    fs.appendFileSync(msgPath, lines.join('\n') + '\n');
  }

  async updateAfterTurn(id: string, newMessages: AgentMessage[], tokensUsed: number): Promise<void> {
    await withFileLock(this.indexPath, () => {
      const index = this.readIndex();
      const record = index.find(c => c.id === id);
      if (!record) return;

      record.messageCount += newMessages.length;
      record.totalTokens += tokensUsed;
      record.lastMessageAt = Date.now();

      // Move to front (most recent)
      const idx = index.indexOf(record);
      if (idx > 0) {
        index.splice(idx, 1);
        index.unshift(record);
      }

      // Cap index size
      if (index.length > MAX_INDEX_SIZE) {
        index.splice(MAX_INDEX_SIZE);
      }

      this.writeIndexAtomic(index);
    });
  }

  async syncToCloud(id: string, newMessages: AgentMessage[]): Promise<void> {
    try {
      const credPath = path.join(os.homedir(), '.fw', 'credentials.json');
      if (!fs.existsSync(credPath)) return;
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      if (!creds.token || !creds.platformUrl || creds.expiresAt <= Date.now()) return;

      const conversation = this.get(id);
      if (!conversation) return;

      // Fire-and-forget sync — don't block the conversation
      const lastMessage = newMessages.find(m => m.role === 'user');
      if (!lastMessage) return;

      const message = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content);

      fetch(`${creds.platformUrl}/ai-chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(creds.token.startsWith('fw_')
            ? { 'X-API-Key': creds.token }
            : { Authorization: `Bearer ${creds.token}` }),
        },
        body: JSON.stringify({
          message: `[Synced from CLI] ${message}`,
          conversationId: (conversation as any).cloudConversationId,
        }),
      }).catch(() => {}); // fire-and-forget
    } catch { /* sync not available */ }
  }

  async setTitle(id: string, title: string): Promise<void> {
    await withFileLock(this.indexPath, () => {
      const index = this.readIndex();
      const record = index.find(c => c.id === id);
      if (record) {
        record.title = title.slice(0, 80).replace(/\n/g, ' ').trim();
        this.writeIndexAtomic(index);
      }
    });
  }

  async addBotId(id: string, botId: string): Promise<void> {
    await withFileLock(this.indexPath, () => {
      const index = this.readIndex();
      const record = index.find(c => c.id === id);
      if (record && !record.botIds.includes(botId)) {
        record.botIds.push(botId);
        this.writeIndexAtomic(index);
      }
    });
  }

  // --- Private ---

  private readIndex(): ConversationRecord[] {
    if (!fs.existsSync(this.indexPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
    } catch (err) {
      if (process.env.WEAVER_VERBOSE) process.stderr.write(`[weaver] conversation index parse failed: ${err}\n`);
      // Try backup
      return this.readBackupIndex();
    }
  }

  private readBackupIndex(): ConversationRecord[] {
    const backupPath = this.indexPath + '.bak';
    if (!fs.existsSync(backupPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
      // Restore backup to main index
      try { this.writeIndexAtomic(data); } catch { /* best effort */ }
      return data;
    } catch (err) {
      if (process.env.WEAVER_VERBOSE) process.stderr.write(`[weaver] conversation backup parse failed: ${err}\n`);
      return [];
    }
  }

  /** Atomic write: serialize to temp file, backup existing, rename into place. */
  private writeIndexAtomic(index: ConversationRecord[]): void {
    const tmpPath = this.indexPath + `.tmp.${process.pid}`;
    const backupPath = this.indexPath + '.bak';
    const content = JSON.stringify(index, null, 2);

    // Write to temp file first
    fs.writeFileSync(tmpPath, content);

    // Backup current index if it exists
    if (fs.existsSync(this.indexPath)) {
      try { fs.copyFileSync(this.indexPath, backupPath); } catch { /* best effort */ }
    }

    // Atomic rename
    fs.renameSync(tmpPath, this.indexPath);

    // Always update backup after successful write
    try { fs.copyFileSync(this.indexPath, backupPath); } catch { /* best effort */ }
  }
}
