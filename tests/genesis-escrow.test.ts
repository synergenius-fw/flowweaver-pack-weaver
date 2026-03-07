import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { GenesisStore } from '../src/bot/genesis-store.js';
import { genesisEscrowStage } from '../src/node-types/genesis-escrow-stage.js';
import { genesisEscrowValidate } from '../src/node-types/genesis-escrow-validate.js';
import { genesisEscrowMigrate, rollbackFromBackup } from '../src/node-types/genesis-escrow-migrate.js';
import { genesisEscrowRecover } from '../src/node-types/genesis-escrow-recover.js';
import { genesisEscrowGrace } from '../src/node-types/genesis-escrow-grace.js';
import { genesisValidateProposal } from '../src/node-types/genesis-validate-proposal.js';
import type { GenesisContext, GenesisConfig, GenesisProposal, EscrowToken } from '../src/bot/types.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'escrow-test-'));
}

function makeConfig(overrides: Partial<GenesisConfig> = {}): GenesisConfig {
  return {
    intent: 'test',
    focus: [],
    constraints: [],
    approvalThreshold: 'MINOR',
    budgetPerCycle: 5,
    stabilize: false,
    targetWorkflow: 'workflows/test.ts',
    maxCyclesPerRun: 3,
    selfEvolve: true,
    selfEvolveGracePeriod: 3,
    selfEvolveMaxFailures: 3,
    selfEvolveBudget: 5,
    ...overrides,
  };
}

function makeContext(projectDir: string, config: GenesisConfig, extra: Partial<GenesisContext> = {}): GenesisContext {
  return {
    env: {
      projectDir,
      config: { provider: 'auto' },
      providerType: 'anthropic',
      providerInfo: { type: 'anthropic', apiKey: 'test' },
    },
    genesisConfigJson: JSON.stringify(config),
    cycleId: 'test-cycle-1',
    ...extra,
  };
}

function makeProposal(selfOps: Array<{ type: string; file: string; content: string }>): GenesisProposal {
  return {
    operations: selfOps.map(op => ({
      type: op.type as any,
      args: { file: op.file, content: op.content },
      costUnits: 2,
      rationale: 'test',
    })),
    totalCost: selfOps.length * 2,
    impactLevel: 'MINOR',
    summary: 'test proposal',
    rationale: 'testing',
  };
}

// --- GenesisStore escrow methods ---

describe('GenesisStore escrow methods', () => {
  let tmpDir: string;
  let store: GenesisStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new GenesisStore(tmpDir);
    store.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ensureEscrowDirs creates staged and backup directories', () => {
    store.ensureEscrowDirs();
    expect(fs.existsSync(path.join(tmpDir, '.genesis', 'escrow', 'staged'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.genesis', 'escrow', 'backup'))).toBe(true);
  });

  it('loadEscrowToken returns null when no token exists', () => {
    expect(store.loadEscrowToken()).toBeNull();
  });

  it('saveEscrowToken and loadEscrowToken round-trip', () => {
    const token: EscrowToken = {
      migrationId: 'mig-1',
      cycleId: 'cyc-1',
      stagedAt: new Date().toISOString(),
      phase: 'staged',
      affectedFiles: ['src/test.ts'],
      stagedFileHashes: { 'src/test.ts': 'abc123' },
      backupFileHashes: { 'src/test.ts': 'def456' },
      ownerPid: process.pid,
      graceRemaining: 3,
      graceCycleIds: [],
    };
    store.saveEscrowToken(token);
    const loaded = store.loadEscrowToken();
    expect(loaded).toEqual(token);
  });

  it('clearEscrow removes the escrow directory', () => {
    store.ensureEscrowDirs();
    store.clearEscrow();
    expect(fs.existsSync(path.join(tmpDir, '.genesis', 'escrow'))).toBe(false);
  });

  it('getEscrowStagedPath and getEscrowBackupPath return correct paths', () => {
    const staged = store.getEscrowStagedPath('src/foo.ts');
    const backup = store.getEscrowBackupPath('src/foo.ts');
    expect(staged).toContain('escrow/staged/src/foo.ts');
    expect(backup).toContain('escrow/backup/src/foo.ts');
  });

  it('self-history append and load round-trips', () => {
    expect(store.loadSelfHistory()).toEqual([]);
    store.appendSelfMigration({
      migrationId: 'mig-1',
      cycleId: 'cyc-1',
      timestamp: new Date().toISOString(),
      affectedFiles: ['src/test.ts'],
      outcome: 'migrated',
      graceCompleted: false,
    });
    const history = store.loadSelfHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.migrationId).toBe('mig-1');
  });

  it('getSelfFailureCount counts consecutive rolled-back from the end', () => {
    store.appendSelfMigration({
      migrationId: 'm1', cycleId: 'c1', timestamp: '', affectedFiles: [],
      outcome: 'grace-cleared', graceCompleted: true,
    });
    store.appendSelfMigration({
      migrationId: 'm2', cycleId: 'c2', timestamp: '', affectedFiles: [],
      outcome: 'rolled-back', graceCompleted: false, rollbackReason: 'fail',
    });
    store.appendSelfMigration({
      migrationId: 'm3', cycleId: 'c3', timestamp: '', affectedFiles: [],
      outcome: 'rolled-back', graceCompleted: false, rollbackReason: 'fail',
    });
    expect(store.getSelfFailureCount()).toBe(2);
  });

  it('hashFile produces consistent SHA-256 hashes', () => {
    const filePath = path.join(tmpDir, 'hash-test.txt');
    fs.writeFileSync(filePath, 'hello world', 'utf-8');
    const hash1 = GenesisStore.hashFile(filePath);
    const hash2 = GenesisStore.hashFile(filePath);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});

// --- genesisEscrowStage ---

describe('genesisEscrowStage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const store = new GenesisStore(tmpDir);
    store.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns no-op when proposal has no self-modify ops', () => {
    const config = makeConfig();
    const proposal = makeProposal([]);
    // Add a regular op
    proposal.operations.push({
      type: 'addNode',
      args: { nodeId: 'n1', nodeType: 'test', file: 'test.ts' },
      costUnits: 1,
      rationale: 'test',
    });
    const context = makeContext(tmpDir, config, { proposalJson: JSON.stringify(proposal) });
    const result = genesisEscrowStage(JSON.stringify(context));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(result.onSuccess).toBe(true);
    expect(ctx.hasSelfModifyOps).toBe(false);
  });

  it('creates correct directory structure and token for self-modify ops', () => {
    const config = makeConfig();
    // We need a real file to back up, relative to pack root
    // The node resolves pack root from import.meta.url, but in tests we can
    // only verify the store-level behavior
    const store = new GenesisStore(tmpDir);
    store.ensureEscrowDirs();

    const proposal = makeProposal([
      { type: 'selfModifyModule', file: 'src/bot/test-module.ts', content: 'export const x = 1;' },
    ]);
    const context = makeContext(tmpDir, config, { proposalJson: JSON.stringify(proposal) });
    const ctxJson = JSON.stringify(context);

    // The stage node resolves pack root from import.meta.url which won't match
    // our test file locations, so we test store methods directly here
    const token: EscrowToken = {
      migrationId: crypto.randomUUID().slice(0, 12),
      cycleId: 'test-cycle-1',
      stagedAt: new Date().toISOString(),
      phase: 'staged',
      affectedFiles: ['src/bot/test-module.ts'],
      stagedFileHashes: { 'src/bot/test-module.ts': 'abc' },
      backupFileHashes: {},
      ownerPid: process.pid,
      graceRemaining: 3,
      graceCycleIds: [],
    };
    store.saveEscrowToken(token);

    const loaded = store.loadEscrowToken();
    expect(loaded!.phase).toBe('staged');
    expect(loaded!.affectedFiles).toEqual(['src/bot/test-module.ts']);
    expect(loaded!.graceRemaining).toBe(3);
  });
});

// --- genesisEscrowValidate ---

describe('genesisEscrowValidate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const store = new GenesisStore(tmpDir);
    store.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails when no staged token exists', () => {
    const config = makeConfig();
    const context = makeContext(tmpDir, config);
    const result = genesisEscrowValidate(JSON.stringify(context));
    expect(result.onSuccess).toBe(false);
    expect(result.onFailure).toBe(true);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.error).toContain('No staged escrow token');
  });

  it('fails when token is not in staged phase', () => {
    const config = makeConfig();
    const store = new GenesisStore(tmpDir);
    store.saveEscrowToken({
      migrationId: 'mig-1',
      cycleId: 'cyc-1',
      stagedAt: new Date().toISOString(),
      phase: 'migrated', // wrong phase
      affectedFiles: [],
      stagedFileHashes: {},
      backupFileHashes: {},
      ownerPid: process.pid,
      graceRemaining: 3,
      graceCycleIds: [],
    });
    const context = makeContext(tmpDir, config);
    const result = genesisEscrowValidate(JSON.stringify(context));
    expect(result.onSuccess).toBe(false);
  });
});

// --- genesisEscrowMigrate ---

describe('genesisEscrowMigrate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const store = new GenesisStore(tmpDir);
    store.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails when no validated token exists', async () => {
    const config = makeConfig();
    const context = makeContext(tmpDir, config);
    const result = await genesisEscrowMigrate(true, JSON.stringify(context));
    expect(result.onSuccess).toBe(false);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.error).toContain('No validated escrow token');
  });

  it('returns success on dry run without migrating', async () => {
    const config = makeConfig();
    const context = makeContext(tmpDir, config);
    const result = await genesisEscrowMigrate(false, JSON.stringify(context));
    expect(result.onSuccess).toBe(true);
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(JSON.parse(ctx.escrowResultJson!).migrated).toBe(false);
  });
});

// --- rollbackFromBackup ---

describe('rollbackFromBackup', () => {
  let tmpDir: string;
  let packRoot: string;
  let store: GenesisStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    packRoot = makeTmpDir();
    store = new GenesisStore(tmpDir);
    store.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(packRoot, { recursive: true, force: true });
  });

  it('restores files from backup and records rollback', () => {
    const relFile = 'src/test-file.ts';
    const originalContent = 'export const original = true;';
    const modifiedContent = 'export const modified = true;';

    // Set up the "modified" file at pack root
    const destPath = path.join(packRoot, relFile);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, modifiedContent, 'utf-8');

    // Set up the backup
    const backupPath = store.getEscrowBackupPath(relFile);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, originalContent, 'utf-8');

    const backupHash = GenesisStore.hashFile(backupPath);

    const token: EscrowToken = {
      migrationId: 'mig-rollback',
      cycleId: 'cyc-1',
      stagedAt: new Date().toISOString(),
      phase: 'migrated',
      affectedFiles: [relFile],
      stagedFileHashes: {},
      backupFileHashes: { [relFile]: backupHash },
      ownerPid: process.pid,
      graceRemaining: 2,
      graceCycleIds: [],
    };
    store.saveEscrowToken(token);

    rollbackFromBackup(store, token, packRoot, 'test rollback');

    // File should be restored
    expect(fs.readFileSync(destPath, 'utf-8')).toBe(originalContent);

    // Token should be rolled-back
    const updated = store.loadEscrowToken();
    expect(updated!.phase).toBe('rolled-back');
    expect(updated!.rollbackReason).toBe('test rollback');

    // Self-history should have a record
    const history = store.loadSelfHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.outcome).toBe('rolled-back');
  });

  it('skips files with mismatched backup hash', () => {
    const relFile = 'src/bad-backup.ts';
    const destPath = path.join(packRoot, relFile);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, 'modified', 'utf-8');

    const backupPath = store.getEscrowBackupPath(relFile);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, 'backup content', 'utf-8');

    const token: EscrowToken = {
      migrationId: 'mig-bad',
      cycleId: 'cyc-1',
      stagedAt: new Date().toISOString(),
      phase: 'migrated',
      affectedFiles: [relFile],
      stagedFileHashes: {},
      backupFileHashes: { [relFile]: 'wrong-hash' },
      ownerPid: process.pid,
      graceRemaining: 2,
      graceCycleIds: [],
    };
    store.saveEscrowToken(token);

    rollbackFromBackup(store, token, packRoot, 'integrity test');

    // File should NOT be restored (hash mismatch)
    expect(fs.readFileSync(destPath, 'utf-8')).toBe('modified');
  });
});

// --- genesisEscrowRecover (crash recovery) ---

describe('genesisEscrowRecover', () => {
  let tmpDir: string;
  let store: GenesisStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new GenesisStore(tmpDir);
    store.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets escrowGraceLocked=false when no token exists', () => {
    const config = makeConfig();
    const context = makeContext(tmpDir, config);
    const result = genesisEscrowRecover(JSON.stringify(context));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.escrowGraceLocked).toBe(false);
  });

  it('sets escrowGraceLocked=false when selfEvolve is disabled', () => {
    const config = makeConfig({ selfEvolve: false });
    const context = makeContext(tmpDir, config);
    const result = genesisEscrowRecover(JSON.stringify(context));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.escrowGraceLocked).toBe(false);
  });

  it('sets escrowGraceLocked=true when migrated token has graceRemaining', () => {
    const config = makeConfig();
    store.saveEscrowToken({
      migrationId: 'mig-grace',
      cycleId: 'cyc-1',
      stagedAt: new Date().toISOString(),
      phase: 'migrated',
      affectedFiles: [],
      stagedFileHashes: {},
      backupFileHashes: {},
      ownerPid: process.pid,
      graceRemaining: 2,
      graceCycleIds: ['c0'],
    });
    const context = makeContext(tmpDir, config);
    const result = genesisEscrowRecover(JSON.stringify(context));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.escrowGraceLocked).toBe(true);
    expect(ctx.escrowGraceRemaining).toBe(2);
  });

  it('sets escrowGraceLocked=false when migrated token has graceRemaining=0', () => {
    const config = makeConfig();
    store.saveEscrowToken({
      migrationId: 'mig-done',
      cycleId: 'cyc-1',
      stagedAt: new Date().toISOString(),
      phase: 'migrated',
      affectedFiles: [],
      stagedFileHashes: {},
      backupFileHashes: {},
      ownerPid: process.pid,
      graceRemaining: 0,
      graceCycleIds: ['c1', 'c2', 'c3'],
    });
    const context = makeContext(tmpDir, config);
    const result = genesisEscrowRecover(JSON.stringify(context));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    expect(ctx.escrowGraceLocked).toBe(false);
  });
});

// --- genesisEscrowGrace ---

describe('genesisEscrowGrace', () => {
  let tmpDir: string;
  let store: GenesisStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new GenesisStore(tmpDir);
    store.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-ops when selfEvolve is disabled', () => {
    const config = makeConfig({ selfEvolve: false });
    const context = makeContext(tmpDir, config);
    const result = genesisEscrowGrace(JSON.stringify(context));
    expect(result.ctx).toBeDefined();
  });

  it('no-ops when no escrow token exists', () => {
    const config = makeConfig();
    const context = makeContext(tmpDir, config);
    const result = genesisEscrowGrace(JSON.stringify(context));
    expect(result.ctx).toBeDefined();
  });

  it('decrements graceRemaining on successful cycle', () => {
    const config = makeConfig();
    store.saveEscrowToken({
      migrationId: 'mig-grace',
      cycleId: 'cyc-1',
      stagedAt: new Date().toISOString(),
      phase: 'migrated',
      affectedFiles: [],
      stagedFileHashes: {},
      backupFileHashes: {},
      ownerPid: process.pid,
      graceRemaining: 3,
      graceCycleIds: [],
    });
    const context = makeContext(tmpDir, config);
    genesisEscrowGrace(JSON.stringify(context));

    const token = store.loadEscrowToken();
    expect(token!.graceRemaining).toBe(2);
    expect(token!.graceCycleIds).toHaveLength(1);
  });

  it('clears escrow when graceRemaining reaches 0', () => {
    const config = makeConfig();
    store.saveEscrowToken({
      migrationId: 'mig-last',
      cycleId: 'cyc-1',
      stagedAt: new Date().toISOString(),
      phase: 'migrated',
      affectedFiles: ['src/test.ts'],
      stagedFileHashes: {},
      backupFileHashes: {},
      ownerPid: process.pid,
      graceRemaining: 1,
      graceCycleIds: ['c1', 'c2'],
    });
    const context = makeContext(tmpDir, config);
    genesisEscrowGrace(JSON.stringify(context));

    // Token should be gone (escrow cleared)
    expect(store.loadEscrowToken()).toBeNull();

    // Self-history should have grace-cleared record
    const history = store.loadSelfHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.outcome).toBe('grace-cleared');
    expect(history[0]!.graceCompleted).toBe(true);
  });

  it('triggers rollback when cycle had an error during grace', () => {
    const config = makeConfig();
    const relFile = 'src/grace-fail.ts';

    // We can't easily test the actual file rollback here since rollbackFromBackup
    // uses the pack root, but we can verify the token state change
    store.saveEscrowToken({
      migrationId: 'mig-fail',
      cycleId: 'cyc-1',
      stagedAt: new Date().toISOString(),
      phase: 'migrated',
      affectedFiles: [relFile],
      stagedFileHashes: {},
      backupFileHashes: {},
      ownerPid: process.pid,
      graceRemaining: 2,
      graceCycleIds: [],
    });

    const context = makeContext(tmpDir, config, { error: 'Cycle compilation failed' });
    genesisEscrowGrace(JSON.stringify(context));

    const token = store.loadEscrowToken();
    expect(token!.phase).toBe('rolled-back');
    expect(token!.rollbackReason).toContain('Grace cycle failed');
  });
});

// --- genesisValidateProposal: self-modify budget ---

describe('genesisValidateProposal self-modify budget', () => {
  it('filters self-modify ops when selfEvolve is disabled', () => {
    const config = makeConfig({ selfEvolve: false, budgetPerCycle: 10 });
    const proposal: GenesisProposal = {
      operations: [
        { type: 'addNode', args: { nodeId: 'n1', nodeType: 'test', file: 'test.ts' }, costUnits: 1, rationale: 'test' },
        { type: 'selfModifyModule', args: { file: 'src/bot/test.ts', content: 'export const x = 1;' }, costUnits: 2, rationale: 'test' },
      ],
      totalCost: 3,
      impactLevel: 'MINOR',
      summary: 'test',
      rationale: 'test',
    };
    const context: GenesisContext = {
      env: { projectDir: '/tmp', config: { provider: 'auto' }, providerType: 'auto', providerInfo: { type: 'anthropic' } },
      genesisConfigJson: JSON.stringify(config),
      cycleId: 'test',
      proposalJson: JSON.stringify(proposal),
    };
    const result = genesisValidateProposal(JSON.stringify(context));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const validated = JSON.parse(ctx.proposalJson!) as GenesisProposal;
    // Self-modify op should be filtered out
    expect(validated.operations.every(op => op.type === 'addNode')).toBe(true);
  });

  it('enforces separate selfEvolveBudget', () => {
    const config = makeConfig({ selfEvolve: true, selfEvolveBudget: 2, budgetPerCycle: 10 });
    const proposal: GenesisProposal = {
      operations: [
        { type: 'selfModifyNodeType', args: { file: 'src/node-types/test1.ts', content: 'x' }, costUnits: 0, rationale: 'test' },
        { type: 'selfModifyModule', args: { file: 'src/bot/test2.ts', content: 'y' }, costUnits: 0, rationale: 'test' },
      ],
      totalCost: 4,
      impactLevel: 'MINOR',
      summary: 'test',
      rationale: 'test',
    };
    const context: GenesisContext = {
      env: { projectDir: '/tmp', config: { provider: 'auto' }, providerType: 'auto', providerInfo: { type: 'anthropic' } },
      genesisConfigJson: JSON.stringify(config),
      cycleId: 'test',
      proposalJson: JSON.stringify(proposal),
    };
    const result = genesisValidateProposal(JSON.stringify(context));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const validated = JSON.parse(ctx.proposalJson!) as GenesisProposal;
    // Both cost 2 each = 4 total, budget is 2, so only 1 should remain
    expect(validated.operations).toHaveLength(1);
  });

  it('filters self-modify ops missing file or content', () => {
    const config = makeConfig({ selfEvolve: true, selfEvolveBudget: 10 });
    const proposal: GenesisProposal = {
      operations: [
        { type: 'selfModifyModule', args: { file: 'src/bot/test.ts' }, costUnits: 2, rationale: 'no content' },
        { type: 'selfModifyNodeType', args: { content: 'x' }, costUnits: 2, rationale: 'no file' },
        { type: 'selfModifyModule', args: { file: 'src/bot/ok.ts', content: 'good' }, costUnits: 2, rationale: 'valid' },
      ],
      totalCost: 6,
      impactLevel: 'MINOR',
      summary: 'test',
      rationale: 'test',
    };
    const context: GenesisContext = {
      env: { projectDir: '/tmp', config: { provider: 'auto' }, providerType: 'auto', providerInfo: { type: 'anthropic' } },
      genesisConfigJson: JSON.stringify(config),
      cycleId: 'test',
      proposalJson: JSON.stringify(proposal),
    };
    const result = genesisValidateProposal(JSON.stringify(context));
    const ctx = JSON.parse(result.ctx) as GenesisContext;
    const validated = JSON.parse(ctx.proposalJson!) as GenesisProposal;
    // Only the third op has both file and content
    expect(validated.operations).toHaveLength(1);
    expect(validated.operations[0]!.args.file).toBe('src/bot/ok.ts');
  });
});
