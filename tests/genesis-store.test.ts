import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GenesisStore } from '../src/bot/genesis-store.js';
import type {
  GenesisCycleRecord,
  GenesisConfig,
  GenesisFingerprint,
  EscrowToken,
  GenesisSelfMigrationRecord,
} from '../src/bot/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCycleRecord(overrides: Partial<GenesisCycleRecord> = {}): GenesisCycleRecord {
  return {
    id: 'abc12345',
    timestamp: new Date().toISOString(),
    durationMs: 1200,
    fingerprint: {
      timestamp: new Date().toISOString(),
      files: {},
      packageJson: null,
      gitBranch: null,
      gitCommit: null,
      workflowHash: 'hash1',
      existingWorkflows: [],
    },
    proposal: null,
    outcome: 'applied',
    diffSummary: null,
    approvalRequired: false,
    approved: null,
    error: null,
    snapshotFile: null,
    ...overrides,
  };
}

function makeSelfMigration(overrides: Partial<GenesisSelfMigrationRecord> = {}): GenesisSelfMigrationRecord {
  return {
    migrationId: 'mig-1',
    cycleId: 'cyc-1',
    timestamp: new Date().toISOString(),
    affectedFiles: ['foo.ts'],
    outcome: 'migrated',
    graceCompleted: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GenesisStore', () => {
  let tmpDir: string;
  let store: GenesisStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-store-test-'));
    store = new GenesisStore(tmpDir);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  // =========================================================================
  // ensureDirs
  // =========================================================================
  describe('ensureDirs', () => {
    it('creates the .genesis/snapshots directory', () => {
      store.ensureDirs();
      expect(fs.existsSync(path.join(tmpDir, '.genesis', 'snapshots'))).toBe(true);
    });
  });

  // =========================================================================
  // loadConfig / saveConfig
  // =========================================================================
  describe('loadConfig', () => {
    it('returns default config and creates file when none exists', () => {
      const config = store.loadConfig();
      expect(config.approvalThreshold).toBe('MINOR');
      expect(config.budgetPerCycle).toBe(3);
      expect(fs.existsSync(path.join(tmpDir, '.genesis', 'config.json'))).toBe(true);
    });

    it('returns saved config merged with defaults', () => {
      store.saveConfig({ intent: 'custom intent' } as GenesisConfig);
      const config = store.loadConfig();
      expect(config.intent).toBe('custom intent');
      // defaults still present for unset fields
      expect(config.budgetPerCycle).toBe(3);
    });

    it('returns defaults when config file is corrupted JSON', () => {
      store.ensureDirs();
      fs.writeFileSync(path.join(tmpDir, '.genesis', 'config.json'), '{{{BROKEN', 'utf-8');
      const config = store.loadConfig();
      expect(config.approvalThreshold).toBe('MINOR');
    });

    // BUG TEST: readFileSync throws when file is unreadable (existsSync returns true)
    it('returns defaults when config file is unreadable', () => {
      store.loadConfig(); // creates file
      const configPath = path.join(tmpDir, '.genesis', 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);
      // Make file unreadable — existsSync still returns true but readFileSync throws EACCES
      fs.chmodSync(configPath, 0o000);
      try {
        // Current code has no try-catch around readFileSync, so EACCES propagates uncaught
        expect(() => store.loadConfig()).not.toThrow();
        const config = store.loadConfig();
        expect(config.approvalThreshold).toBe('MINOR');
      } finally {
        fs.chmodSync(configPath, 0o644);
      }
    });
  });

  // =========================================================================
  // loadHistory / appendCycle
  // =========================================================================
  describe('loadHistory', () => {
    it('returns empty history when no file exists', () => {
      const history = store.loadHistory();
      expect(history.cycles).toEqual([]);
      expect(history.configHash).toBe('');
    });

    it('returns saved history', () => {
      const cycle = makeCycleRecord();
      store.appendCycle(cycle);
      const history = store.loadHistory();
      expect(history.cycles).toHaveLength(1);
      expect(history.cycles[0]!.id).toBe('abc12345');
    });

    it('returns default when history file is corrupted', () => {
      store.ensureDirs();
      fs.writeFileSync(path.join(tmpDir, '.genesis', 'history.json'), 'NOT JSON', 'utf-8');
      const history = store.loadHistory();
      expect(history.cycles).toEqual([]);
    });

    // BUG TEST: readFileSync throws when history file is unreadable
    it('does not throw when history file is unreadable', () => {
      store.appendCycle(makeCycleRecord());
      const histPath = path.join(tmpDir, '.genesis', 'history.json');
      fs.chmodSync(histPath, 0o000);
      try {
        expect(() => store.loadHistory()).not.toThrow();
        const history = store.loadHistory();
        expect(history.cycles).toEqual([]);
      } finally {
        fs.chmodSync(histPath, 0o644);
      }
    });
  });

  describe('appendCycle', () => {
    it('appends multiple cycles', () => {
      store.appendCycle(makeCycleRecord({ id: 'a' }));
      store.appendCycle(makeCycleRecord({ id: 'b' }));
      store.appendCycle(makeCycleRecord({ id: 'c' }));
      const history = store.loadHistory();
      expect(history.cycles).toHaveLength(3);
      expect(history.cycles.map(c => c.id)).toEqual(['a', 'b', 'c']);
    });
  });

  // =========================================================================
  // getRecentOutcomes
  // =========================================================================
  describe('getRecentOutcomes', () => {
    it('returns last N outcomes', () => {
      store.appendCycle(makeCycleRecord({ id: 'a', outcome: 'applied' }));
      store.appendCycle(makeCycleRecord({ id: 'b', outcome: 'rolled-back' }));
      store.appendCycle(makeCycleRecord({ id: 'c', outcome: 'error' }));
      expect(store.getRecentOutcomes(2)).toEqual(['rolled-back', 'error']);
    });

    it('returns all when count exceeds history length', () => {
      store.appendCycle(makeCycleRecord({ outcome: 'applied' }));
      expect(store.getRecentOutcomes(100)).toEqual(['applied']);
    });
  });

  // =========================================================================
  // saveSnapshot / loadSnapshot
  // =========================================================================
  describe('snapshots', () => {
    it('saves and loads a snapshot', () => {
      const snapshotPath = store.saveSnapshot('cyc-001', 'export const x = 1;');
      expect(fs.existsSync(snapshotPath)).toBe(true);
      expect(store.loadSnapshot(snapshotPath)).toBe('export const x = 1;');
    });

    it('returns null for missing snapshot', () => {
      expect(store.loadSnapshot('/nonexistent/path.ts')).toBeNull();
    });
  });

  // =========================================================================
  // fingerprint
  // =========================================================================
  describe('fingerprint', () => {
    it('saves and loads fingerprint', () => {
      const fp: GenesisFingerprint = {
        timestamp: '2026-01-01T00:00:00Z',
        files: { 'a.ts': 'hash-a' },
        packageJson: null,
        gitBranch: 'main',
        gitCommit: 'abc123',
        workflowHash: 'wf-hash',
        existingWorkflows: ['flow1.ts'],
      };
      store.saveFingerprint(fp);
      const loaded = store.getLastFingerprint();
      expect(loaded).toEqual(fp);
    });

    it('returns null when no fingerprint exists', () => {
      expect(store.getLastFingerprint()).toBeNull();
    });

    // BUG TEST: readFileSync throws when fingerprint file is unreadable
    it('does not throw when fingerprint file is unreadable', () => {
      const fp: GenesisFingerprint = {
        timestamp: '2026-01-01T00:00:00Z',
        files: {},
        packageJson: null,
        gitBranch: null,
        gitCommit: null,
        workflowHash: 'wf',
        existingWorkflows: [],
      };
      store.saveFingerprint(fp);
      const fpPath = path.join(tmpDir, '.genesis', 'fingerprint.json');
      fs.chmodSync(fpPath, 0o000);
      try {
        expect(() => store.getLastFingerprint()).not.toThrow();
        expect(store.getLastFingerprint()).toBeNull();
      } finally {
        fs.chmodSync(fpPath, 0o644);
      }
    });
  });

  // =========================================================================
  // escrow
  // =========================================================================
  describe('escrow', () => {
    it('saves and loads escrow token', () => {
      const token: EscrowToken = {
        migrationId: 'mig-1',
        cycleId: 'cyc-1',
        stagedAt: '2026-01-01T00:00:00Z',
        phase: 'staged',
        affectedFiles: ['a.ts'],
        stagedFileHashes: { 'a.ts': 'h1' },
        backupFileHashes: { 'a.ts': 'h0' },
      };
      store.saveEscrowToken(token);
      const loaded = store.loadEscrowToken();
      expect(loaded).toEqual(token);
    });

    it('returns null when no escrow token', () => {
      expect(store.loadEscrowToken()).toBeNull();
    });

    it('clearEscrow removes escrow directory', () => {
      store.ensureEscrowDirs();
      const escrowDir = path.join(tmpDir, '.genesis', 'escrow');
      expect(fs.existsSync(escrowDir)).toBe(true);
      store.clearEscrow();
      expect(fs.existsSync(escrowDir)).toBe(false);
    });

    it('clearEscrow does not throw when no escrow exists', () => {
      expect(() => store.clearEscrow()).not.toThrow();
    });

    it('getEscrowStagedPath returns correct path', () => {
      const p = store.getEscrowStagedPath('src/foo.ts');
      expect(p).toBe(path.join(tmpDir, '.genesis', 'escrow', 'staged', 'src/foo.ts'));
    });

    it('getEscrowBackupPath returns correct path', () => {
      const p = store.getEscrowBackupPath('src/foo.ts');
      expect(p).toBe(path.join(tmpDir, '.genesis', 'escrow', 'backup', 'src/foo.ts'));
    });
  });

  // =========================================================================
  // self-evolution history
  // =========================================================================
  describe('self-evolution history', () => {
    it('returns empty array when no self-history', () => {
      expect(store.loadSelfHistory()).toEqual([]);
    });

    it('appends and loads self-migration records', () => {
      store.appendSelfMigration(makeSelfMigration({ migrationId: 'm1' }));
      store.appendSelfMigration(makeSelfMigration({ migrationId: 'm2' }));
      const records = store.loadSelfHistory();
      expect(records).toHaveLength(2);
      expect(records[0]!.migrationId).toBe('m1');
    });

    it('getSelfFailureCount counts trailing rolled-back records', () => {
      store.appendSelfMigration(makeSelfMigration({ outcome: 'migrated' }));
      store.appendSelfMigration(makeSelfMigration({ outcome: 'rolled-back' }));
      store.appendSelfMigration(makeSelfMigration({ outcome: 'rolled-back' }));
      expect(store.getSelfFailureCount()).toBe(2);
    });

    it('getSelfFailureCount stops at non-rolled-back', () => {
      store.appendSelfMigration(makeSelfMigration({ outcome: 'rolled-back' }));
      store.appendSelfMigration(makeSelfMigration({ outcome: 'migrated' }));
      store.appendSelfMigration(makeSelfMigration({ outcome: 'rolled-back' }));
      expect(store.getSelfFailureCount()).toBe(1);
    });

    it('getSelfFailureCount returns 0 when last is success', () => {
      store.appendSelfMigration(makeSelfMigration({ outcome: 'rolled-back' }));
      store.appendSelfMigration(makeSelfMigration({ outcome: 'migrated' }));
      expect(store.getSelfFailureCount()).toBe(0);
    });
  });

  // =========================================================================
  // static helpers
  // =========================================================================
  describe('static helpers', () => {
    it('newCycleId returns 8-char string', () => {
      const id = GenesisStore.newCycleId();
      expect(id).toHaveLength(8);
    });

    it('hashConfig produces deterministic hash', () => {
      const config = { intent: 'test' } as GenesisConfig;
      const h1 = GenesisStore.hashConfig(config);
      const h2 = GenesisStore.hashConfig(config);
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(12);
    });

    it('hashFile hashes file content', () => {
      const filePath = path.join(tmpDir, 'hashme.txt');
      fs.writeFileSync(filePath, 'hello world', 'utf-8');
      const hash = GenesisStore.hashFile(filePath);
      expect(hash).toHaveLength(64);
    });
  });
});
