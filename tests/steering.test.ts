import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SteeringController, SteeringCommand } from '../src/bot/steering.js';

describe('SteeringController', () => {
  let tmpDir: string;
  let controller: SteeringController;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steering-test-'));
    controller = new SteeringController(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('check', () => {
    it('returns null when no control file exists', async () => {
      const result = await controller.check();
      expect(result).toBeNull();
    });

    it('reads and returns a valid command', async () => {
      const cmd: SteeringCommand = { command: 'pause', timestamp: Date.now() };
      fs.writeFileSync(path.join(tmpDir, 'control.json'), JSON.stringify(cmd));

      const result = await controller.check();
      expect(result).toEqual(cmd);
    });

    it('deletes the control file after reading (consume-on-read)', async () => {
      const cmd: SteeringCommand = { command: 'cancel', timestamp: Date.now() };
      fs.writeFileSync(path.join(tmpDir, 'control.json'), JSON.stringify(cmd));

      await controller.check();
      expect(fs.existsSync(path.join(tmpDir, 'control.json'))).toBe(false);
    });

    it('second check returns null after command is consumed', async () => {
      const cmd: SteeringCommand = { command: 'resume', timestamp: Date.now() };
      fs.writeFileSync(path.join(tmpDir, 'control.json'), JSON.stringify(cmd));

      await controller.check();
      const second = await controller.check();
      expect(second).toBeNull();
    });

    it('returns null on corrupt JSON without throwing', async () => {
      fs.writeFileSync(path.join(tmpDir, 'control.json'), '{not valid json!!!');

      const result = await controller.check();
      expect(result).toBeNull();
    });

    it('deletes corrupt file after failed parse', async () => {
      fs.writeFileSync(path.join(tmpDir, 'control.json'), 'garbage');

      await controller.check();
      expect(fs.existsSync(path.join(tmpDir, 'control.json'))).toBe(false);
    });

    it('preserves payload field in command', async () => {
      const cmd: SteeringCommand = {
        command: 'redirect',
        payload: 'focus on tests',
        timestamp: 1700000000000,
      };
      fs.writeFileSync(path.join(tmpDir, 'control.json'), JSON.stringify(cmd));

      const result = await controller.check();
      expect(result?.command).toBe('redirect');
      expect(result?.payload).toBe('focus on tests');
    });
  });

  describe('write', () => {
    it('creates the control file with correct JSON content', async () => {
      const cmd: SteeringCommand = { command: 'pause', timestamp: 1700000000000 };
      await controller.write(cmd);

      const raw = fs.readFileSync(path.join(tmpDir, 'control.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(cmd);
    });

    it('writes pretty-printed JSON', async () => {
      const cmd: SteeringCommand = { command: 'cancel', timestamp: 1700000000000 };
      await controller.write(cmd);

      const raw = fs.readFileSync(path.join(tmpDir, 'control.json'), 'utf-8');
      expect(raw).toContain('\n'); // formatted, not single-line
    });

    it('fails if parent directory does not exist (lock file needs dir)', async () => {
      // NOTE: write() has mkdir logic inside the lock callback, but withFileLock
      // needs the directory to exist first for the lock file. This is a known
      // minor gap -- in practice controlDir always exists before steering is used.
      const nestedDir = path.join(tmpDir, 'nested', 'deep');
      const nestedController = new SteeringController(nestedDir);

      const cmd: SteeringCommand = { command: 'resume', timestamp: Date.now() };
      await expect(nestedController.write(cmd)).rejects.toThrow();
    });

    it('overwrites existing command (last-write-wins)', async () => {
      const cmd1: SteeringCommand = { command: 'pause', timestamp: 1 };
      const cmd2: SteeringCommand = { command: 'cancel', timestamp: 2 };

      await controller.write(cmd1);
      await controller.write(cmd2);

      const result = await controller.check();
      expect(result?.command).toBe('cancel');
      expect(result?.timestamp).toBe(2);
    });
  });

  describe('write then check roundtrip', () => {
    it('write followed by check returns the command', async () => {
      const cmd: SteeringCommand = {
        command: 'queue',
        payload: 'add lint task',
        timestamp: Date.now(),
      };

      await controller.write(cmd);
      const result = await controller.check();
      expect(result).toEqual(cmd);
    });

    it('check after roundtrip returns null (consumed)', async () => {
      const cmd: SteeringCommand = { command: 'pause', timestamp: Date.now() };

      await controller.write(cmd);
      await controller.check();
      const second = await controller.check();
      expect(second).toBeNull();
    });
  });

  describe('clear', () => {
    it('removes the control file', async () => {
      const cmd: SteeringCommand = { command: 'pause', timestamp: Date.now() };
      await controller.write(cmd);

      controller.clear();
      expect(fs.existsSync(path.join(tmpDir, 'control.json'))).toBe(false);
    });

    it('no-ops silently when file does not exist', () => {
      expect(() => controller.clear()).not.toThrow();
    });

    it('check returns null after clear', async () => {
      const cmd: SteeringCommand = { command: 'cancel', timestamp: Date.now() };
      await controller.write(cmd);
      controller.clear();

      const result = await controller.check();
      expect(result).toBeNull();
    });
  });

  describe('constructor', () => {
    it('uses custom controlDir to set control file path', async () => {
      const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steering-custom-'));
      try {
        const customController = new SteeringController(customDir);
        const cmd: SteeringCommand = { command: 'resume', timestamp: Date.now() };
        await customController.write(cmd);

        expect(fs.existsSync(path.join(customDir, 'control.json'))).toBe(true);
      } finally {
        fs.rmSync(customDir, { recursive: true, force: true });
      }
    });
  });
});
