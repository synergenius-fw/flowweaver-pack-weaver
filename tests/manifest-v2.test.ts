import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const manifestPath = path.resolve(__dirname, '..', 'flowweaver.manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

describe('manifest v2 fields', () => {
  it('has manifestVersion 2', () => {
    expect(manifest.manifestVersion).toBe(2);
  });

  describe('eventSubscriptions', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(manifest.eventSubscriptions)).toBe(true);
      expect(manifest.eventSubscriptions.length).toBeGreaterThan(0);
    });

    it('each subscription has required fields', () => {
      for (const sub of manifest.eventSubscriptions) {
        expect(sub.event).toBeDefined();
        expect(typeof sub.event).toBe('string');
        expect(sub.handler).toBeDefined();
        expect(typeof sub.handler).toBe('string');
        expect(sub.functionName).toBeDefined();
        expect(typeof sub.functionName).toBe('string');
      }
    });

    it('handler paths are within dist/', () => {
      for (const sub of manifest.eventSubscriptions) {
        expect(sub.handler).toMatch(/^dist\//);
        expect(sub.handler).not.toContain('..');
      }
    });

    it('functionName is a valid JS identifier', () => {
      const validIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
      for (const sub of manifest.eventSubscriptions) {
        expect(sub.functionName).toMatch(validIdentifier);
      }
    });

    it('capabilities are a subset of sandboxCapabilities', () => {
      const sandbox = new Set(manifest.sandboxCapabilities);
      for (const sub of manifest.eventSubscriptions) {
        if (sub.capabilities) {
          for (const cap of sub.capabilities) {
            expect(sandbox.has(cap)).toBe(true);
          }
        }
      }
    });

    it('schedule fields are valid cron expressions (5 fields)', () => {
      for (const sub of manifest.eventSubscriptions) {
        if (sub.schedule) {
          const fields = sub.schedule.trim().split(/\s+/);
          expect(fields.length).toBe(5);
        }
      }
    });
  });

  describe('webhooks', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(manifest.webhooks)).toBe(true);
      expect(manifest.webhooks.length).toBeGreaterThan(0);
    });

    it('each webhook has required fields', () => {
      for (const wh of manifest.webhooks) {
        expect(wh.id).toBeDefined();
        expect(typeof wh.id).toBe('string');
        expect(wh.name).toBeDefined();
        expect(Array.isArray(wh.events)).toBe(true);
        expect(wh.events.length).toBeGreaterThan(0);
      }
    });

    it('webhook ids are unique', () => {
      const ids = manifest.webhooks.map((w: any) => w.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('webhook events are from known taxonomy', () => {
      const known = new Set([
        'execution.started', 'execution.completed', 'execution.failed',
        'workflow.created', 'workflow.updated', 'workflow.deleted',
        'deployment.created', 'deployment.deleted',
        'pack.installed', 'pack.uninstalled',
        'bot.started', 'bot.completed',
        'schedule.tick',
      ]);
      for (const wh of manifest.webhooks) {
        for (const event of wh.events) {
          expect(known.has(event) || event.startsWith('pack.')).toBe(true);
        }
      }
    });
  });

  describe('uiContributions', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(manifest.uiContributions)).toBe(true);
      expect(manifest.uiContributions.length).toBeGreaterThan(0);
    });

    it('each contribution has required fields', () => {
      const validTypes = new Set(['dashboard-widget', 'result-renderer', 'panel']);
      for (const ui of manifest.uiContributions) {
        expect(validTypes.has(ui.type)).toBe(true);
        expect(ui.id).toBeDefined();
        expect(typeof ui.component).toBe('string');
      }
    });

    it('component paths are within dist/ui/', () => {
      for (const ui of manifest.uiContributions) {
        expect(ui.component).toMatch(/^dist\/ui\//);
        expect(ui.component).not.toContain('..');
      }
    });

    it('ids are unique', () => {
      const ids = manifest.uiContributions.map((u: any) => u.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('sandboxCapabilities', () => {
    it('is a non-empty array of strings', () => {
      expect(Array.isArray(manifest.sandboxCapabilities)).toBe(true);
      for (const cap of manifest.sandboxCapabilities) {
        expect(typeof cap).toBe('string');
      }
    });

    it('fetch capabilities have valid domain syntax', () => {
      for (const cap of manifest.sandboxCapabilities) {
        if (cap.startsWith('fetch:')) {
          const domain = cap.slice(6);
          expect(domain).toMatch(/^[a-zA-Z0-9*.-]+$/);
          // No wildcards for entire TLDs
          expect(domain).not.toMatch(/^\*\.[a-z]+$/);
        }
      }
    });
  });

  describe('backward compatibility', () => {
    it('still has all v1 fields', () => {
      expect(manifest.name).toBeDefined();
      expect(manifest.description).toBeDefined();
      expect(manifest.botRegistrations).toBeDefined();
      expect(manifest.nodeTypes).toBeDefined();
      expect(manifest.cliCommands).toBeDefined();
      expect(manifest.mcpTools).toBeDefined();
      expect(manifest.initContributions).toBeDefined();
      expect(manifest.docs).toBeDefined();
    });
  });
});
