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

  it('creates a conversation with unique id of 12+ chars', async () => {
    const c = await store.create('/tmp/project');
    expect(c.id.length).toBeGreaterThanOrEqual(12);
    expect(c.projectDir).toBe('/tmp/project');
    expect(c.title).toBe('');
    expect(c.messageCount).toBe(0);
    expect(c.totalTokens).toBe(0);
    expect(c.botIds).toEqual([]);
  });

  it('lists conversations sorted by most recent', async () => {
    const c1 = await store.create('/tmp/a');
    const c2 = await store.create('/tmp/b');
    const list = store.list();
    expect(list).toHaveLength(2);
    // c2 is most recent (created last)
    expect(list[0].id).toBe(c2.id);
    expect(list[1].id).toBe(c1.id);
  });

  it('gets a conversation by id', async () => {
    const c = await store.create('/tmp/project');
    const found = store.get(c.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(c.id);
  });

  it('returns null for unknown id', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('gets most recent conversation', async () => {
    await store.create('/tmp/a');
    const c2 = await store.create('/tmp/b');
    const recent = store.getMostRecent();
    expect(recent!.id).toBe(c2.id);
  });

  it('returns null when no conversations', () => {
    expect(store.getMostRecent()).toBeNull();
  });

  it('deletes a conversation and its files', async () => {
    const c = await store.create('/tmp/project');
    store.appendMessages(c.id, [{ role: 'user', content: 'hello' }]);

    await store.delete(c.id);

    expect(store.get(c.id)).toBeNull();
    expect(store.list()).toHaveLength(0);
    expect(fs.existsSync(path.join(testDir, c.id))).toBe(false);
  });

  it('persists and loads messages', async () => {
    const c = await store.create('/tmp/project');
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

  it('preserves tool calls in messages', async () => {
    const c = await store.create('/tmp/project');
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

  it('returns empty array for conversation with no messages', async () => {
    const c = await store.create('/tmp/project');
    expect(store.loadMessages(c.id)).toEqual([]);
  });

  it('updates metadata after turn', async () => {
    const c = await store.create('/tmp/project');
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
    const c1 = await store.create('/tmp/a');
    await store.create('/tmp/b');

    // c1 is second in list, update it
    await store.updateAfterTurn(c1.id, [{ role: 'user', content: 'hi' }], 100);

    const list = store.list();
    expect(list[0].id).toBe(c1.id); // now first
  });

  it('sets title', async () => {
    const c = await store.create('/tmp/project');
    await store.setTitle(c.id, 'Fix validation errors in templates');

    const updated = store.get(c.id)!;
    expect(updated.title).toBe('Fix validation errors in templates');
  });

  it('truncates long titles', async () => {
    const c = await store.create('/tmp/project');
    await store.setTitle(c.id, 'A'.repeat(200));

    const updated = store.get(c.id)!;
    expect(updated.title.length).toBeLessThanOrEqual(80);
  });

  it('adds bot ids', async () => {
    const c = await store.create('/tmp/project');
    await store.addBotId(c.id, 'fix-templates');
    await store.addBotId(c.id, 'write-tests');
    await store.addBotId(c.id, 'fix-templates'); // duplicate

    const updated = store.get(c.id)!;
    expect(updated.botIds).toEqual(['fix-templates', 'write-tests']);
  });

  it('caps index at 20 conversations', async () => {
    for (let i = 0; i < 25; i++) {
      await store.create(`/tmp/project-${i}`);
    }

    // Force a turn update to trigger cap enforcement
    const list = store.list();
    expect(list.length).toBeLessThanOrEqual(25); // create doesn't cap

    // Updating triggers cap
    await store.updateAfterTurn(list[0].id, [{ role: 'user', content: 'hi' }], 10);
    const capped = store.list();
    expect(capped.length).toBeLessThanOrEqual(20);
  });

  // --- Priority 1: Atomic writes ---

  it('uses atomic write (temp + rename) for index.json', async () => {
    const c = await store.create('/tmp/project');
    const indexContent = fs.readFileSync(path.join(testDir, 'index.json'), 'utf-8');
    const parsed = JSON.parse(indexContent);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(c.id);

    // Verify no leftover temp files
    const files = fs.readdirSync(testDir);
    const tempFiles = files.filter(f => f.startsWith('index.json.tmp'));
    expect(tempFiles).toHaveLength(0);
  });

  it('survives index.json write interrupted mid-write (temp file left behind)', async () => {
    const c = await store.create('/tmp/project');
    // Corrupt main index (simulating partial write)
    fs.writeFileSync(path.join(testDir, 'index.json'), '{truncated...');
    // The store should recover from the backup
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(c.id);
  });

  // --- Priority 1: File lock on create() and delete() ---

  it('create() uses file lock for concurrent safety', async () => {
    const [c1, c2] = await Promise.all([
      store.create('/tmp/a'),
      store.create('/tmp/b'),
    ]);
    const list = store.list();
    expect(list).toHaveLength(2);
    const ids = list.map(r => r.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id);
  });

  it('delete() uses file lock for concurrent safety', async () => {
    const c1 = await store.create('/tmp/a');
    const c2 = await store.create('/tmp/b');
    const c3 = await store.create('/tmp/c');

    await Promise.all([
      store.delete(c1.id),
      store.delete(c3.id),
    ]);

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(c2.id);
  });

  // --- Priority 1: Backup/restore for corrupt index ---

  it('restores from backup when index.json is corrupt', async () => {
    const c = await store.create('/tmp/project');
    const indexPath = path.join(testDir, 'index.json');
    const backupPath = indexPath + '.bak';

    // Verify backup exists after a write
    expect(fs.existsSync(backupPath)).toBe(true);

    // Corrupt the main index
    fs.writeFileSync(indexPath, 'not json!!!');

    // Should restore from backup
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(c.id);
  });

  it('returns empty array when both index and backup are corrupt', async () => {
    await store.create('/tmp/project');
    const indexPath = path.join(testDir, 'index.json');
    const backupPath = indexPath + '.bak';

    // Corrupt both
    fs.writeFileSync(indexPath, 'garbage');
    fs.writeFileSync(backupPath, 'also garbage');

    const list = store.list();
    expect(list).toEqual([]);
  });

  // --- Priority 1: Longer UUID ---

  it('generates IDs with at least 12 characters', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const c = await store.create('/tmp/project');
      expect(c.id.length).toBeGreaterThanOrEqual(12);
      ids.add(c.id);
    }
    // All unique
    expect(ids.size).toBe(50);
  });

  it('handles corrupt NDJSON gracefully', async () => {
    const c = await store.create('/tmp/project');
    const msgPath = path.join(testDir, c.id, 'messages.ndjson');
    fs.writeFileSync(msgPath, '{"role":"user","content":"good","timestamp":1}\n{corrupt\n{"role":"assistant","content":"ok","timestamp":2}\n');

    const messages = store.loadMessages(c.id);
    expect(messages).toHaveLength(2); // skips corrupt line
    expect(messages[0].content).toBe('good');
    expect(messages[1].content).toBe('ok');
  });
});
