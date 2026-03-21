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
const CHARS_PER_TOKEN = 4;

export class ConversationStore {
  private baseDir: string;
  private indexPath: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), '.weaver', 'conversations');
    this.indexPath = path.join(this.baseDir, 'index.json');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  create(projectDir: string): ConversationRecord {
    const id = crypto.randomUUID().slice(0, 8);
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

    // Add to index (sync write — no lock needed for create, index is new or we're the only writer)
    const index = this.readIndex();
    index.unshift(record);
    this.writeIndexUnsafe(index);

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

  delete(id: string): void {
    // Remove from index (sync — delete doesn't need lock)
    const index = this.readIndex();
    const filtered = index.filter(c => c.id !== id);
    this.writeIndexUnsafe(filtered);

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
        // Skip corrupt lines
      }
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

      this.writeIndexUnsafe(index);
    });
  }

  async setTitle(id: string, title: string): Promise<void> {
    await withFileLock(this.indexPath, () => {
      const index = this.readIndex();
      const record = index.find(c => c.id === id);
      if (record) {
        record.title = title.slice(0, 80).replace(/\n/g, ' ').trim();
        this.writeIndexUnsafe(index);
      }
    });
  }

  async addBotId(id: string, botId: string): Promise<void> {
    await withFileLock(this.indexPath, () => {
      const index = this.readIndex();
      const record = index.find(c => c.id === id);
      if (record && !record.botIds.includes(botId)) {
        record.botIds.push(botId);
        this.writeIndexUnsafe(index);
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
      return [];
    }
  }

  private async writeIndex(index: ConversationRecord[]): Promise<void> {
    await withFileLock(this.indexPath, () => {
      this.writeIndexUnsafe(index);
    });
  }

  private writeIndexUnsafe(index: ConversationRecord[]): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
  }
}
