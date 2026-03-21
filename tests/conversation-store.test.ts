import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConversationStore } from '../src/bot/conversation-store.js';

describe('ConversationStore', () => {
  const testDir = path.join(os.tmpdir(), `weaver-test-convos-${Date.now()}`);
  let store: ConversationStore;

  beforeEach(() => {
    store = new ConversationStore(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates a conversation with unique id', () => {
    const c = store.create('/tmp/project');
    expect(c.id).toHaveLength(8);
    expect(c.projectDir).toBe('/tmp/project');
    expect(c.title).toBe('');
    expect(c.messageCount).toBe(0);
    expect(c.totalTokens).toBe(0);
    expect(c.botIds).toEqual([]);
  });

  it('lists conversations sorted by most recent', () => {
    const c1 = store.create('/tmp/a');
    const c2 = store.create('/tmp/b');
    const list = store.list();
    expect(list).toHaveLength(2);
    // c2 is most recent (created last)
    expect(list[0].id).toBe(c2.id);
    expect(list[1].id).toBe(c1.id);
  });

  it('gets a conversation by id', () => {
    const c = store.create('/tmp/project');
    const found = store.get(c.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(c.id);
  });

  it('returns null for unknown id', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('gets most recent conversation', () => {
    store.create('/tmp/a');
    const c2 = store.create('/tmp/b');
    const recent = store.getMostRecent();
    expect(recent!.id).toBe(c2.id);
  });

  it('returns null when no conversations', () => {
    expect(store.getMostRecent()).toBeNull();
  });

  it('deletes a conversation and its files', () => {
    const c = store.create('/tmp/project');
    store.appendMessages(c.id, [{ role: 'user', content: 'hello' }]);

    store.delete(c.id);

    expect(store.get(c.id)).toBeNull();
    expect(store.list()).toHaveLength(0);
    expect(fs.existsSync(path.join(testDir, c.id))).toBe(false);
  });

  it('persists and loads messages', () => {
    const c = store.create('/tmp/project');
    store.appendMessages(c.id, [
      { role: 'user', content: 'fix the bugs' },
      { role: 'assistant', content: 'I will fix them now.' },
    ]);
    store.appendMessages(c.id, [
      { role: 'user', content: 'what about tests?' },
    ]);

    const messages = store.loadMessages(c.id);
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('fix the bugs');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].content).toBe('what about tests?');
  });

  it('preserves tool calls in messages', () => {
    const c = store.create('/tmp/project');
    store.appendMessages(c.id, [{
      role: 'assistant',
      content: 'Let me check.',
      toolCalls: [{ id: 'tc1', name: 'bot_list', arguments: {} }],
    }]);
    store.appendMessages(c.id, [{
      role: 'tool',
      content: 'No bots running.',
      toolCallId: 'tc1',
    }]);

    const messages = store.loadMessages(c.id);
    expect(messages[0].toolCalls![0].name).toBe('bot_list');
    expect(messages[1].toolCallId).toBe('tc1');
  });

  it('returns empty array for conversation with no messages', () => {
    const c = store.create('/tmp/project');
    expect(store.loadMessages(c.id)).toEqual([]);
  });

  it('updates metadata after turn', async () => {
    const c = store.create('/tmp/project');
    await store.updateAfterTurn(c.id, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ], 500);

    const updated = store.get(c.id)!;
    expect(updated.messageCount).toBe(2);
    expect(updated.totalTokens).toBe(500);
    expect(updated.lastMessageAt).toBeGreaterThan(c.createdAt - 1);
  });

  it('moves updated conversation to front of list', async () => {
    const c1 = store.create('/tmp/a');
    store.create('/tmp/b');

    // c1 is second in list, update it
    await store.updateAfterTurn(c1.id, [{ role: 'user', content: 'hi' }], 100);

    const list = store.list();
    expect(list[0].id).toBe(c1.id); // now first
  });

  it('sets title', async () => {
    const c = store.create('/tmp/project');
    await store.setTitle(c.id, 'Fix validation errors in templates');

    const updated = store.get(c.id)!;
    expect(updated.title).toBe('Fix validation errors in templates');
  });

  it('truncates long titles', async () => {
    const c = store.create('/tmp/project');
    await store.setTitle(c.id, 'A'.repeat(200));

    const updated = store.get(c.id)!;
    expect(updated.title.length).toBeLessThanOrEqual(80);
  });

  it('adds bot ids', async () => {
    const c = store.create('/tmp/project');
    await store.addBotId(c.id, 'fix-templates');
    await store.addBotId(c.id, 'write-tests');
    await store.addBotId(c.id, 'fix-templates'); // duplicate

    const updated = store.get(c.id)!;
    expect(updated.botIds).toEqual(['fix-templates', 'write-tests']);
  });

  it('caps index at 20 conversations', async () => {
    for (let i = 0; i < 25; i++) {
      store.create(`/tmp/project-${i}`);
    }

    // Force a turn update to trigger cap enforcement
    const list = store.list();
    expect(list.length).toBeLessThanOrEqual(25); // create doesn't cap

    // Updating triggers cap
    await store.updateAfterTurn(list[0].id, [{ role: 'user', content: 'hi' }], 10);
    const capped = store.list();
    expect(capped.length).toBeLessThanOrEqual(20);
  });

  it('handles corrupt NDJSON gracefully', () => {
    const c = store.create('/tmp/project');
    const msgPath = path.join(testDir, c.id, 'messages.ndjson');
    fs.writeFileSync(msgPath, '{"role":"user","content":"good","timestamp":1}\n{corrupt\n{"role":"assistant","content":"ok","timestamp":2}\n');

    const messages = store.loadMessages(c.id);
    expect(messages).toHaveLength(2); // skips corrupt line
    expect(messages[0].content).toBe('good');
    expect(messages[1].content).toBe('ok');
  });
});
