import { describe, it, expect } from 'vitest';
import { formatUpdateNotification, compareVersions, type UpdateInfo } from '../src/bot/update-checker.js';

// ---------------------------------------------------------------------------
// Tests for update-checker.ts
// Focus: compareVersions bug with pre-release, formatUpdateNotification
// ---------------------------------------------------------------------------

describe('update-checker', () => {
  // =========================================================================
  // compareVersions: pre-release bug (BUG TESTS -- should fail before fix)
  // =========================================================================
  describe('compareVersions pre-release handling', () => {
    it('detects 2.0.0-beta.1 > 1.0.0', () => {
      // BUG: Number("0-beta") is NaN, NaN - 0 = NaN, comparison corrupted
      expect(compareVersions('2.0.0-beta.1', '1.0.0')).toBeGreaterThan(0);
    });

    it('detects 1.0.0 < 2.0.0-rc.1', () => {
      // BUG: Number("0-rc") is NaN
      expect(compareVersions('1.0.0', '2.0.0-rc.1')).toBeLessThan(0);
    });

    it('treats 1.2.3-alpha and 1.2.3 as equal (patch-level same)', () => {
      // Pre-release suffix is metadata, numeric part is 1.2.3 either way
      expect(compareVersions('1.2.3-alpha', '1.2.3')).toBe(0);
    });

    it('detects 1.2.4-beta > 1.2.3-alpha', () => {
      // Patch 4 > 3, regardless of suffix
      expect(compareVersions('1.2.4-beta.2', '1.2.3-alpha.1')).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // compareVersions: normal cases (should pass before and after fix)
  // =========================================================================
  describe('compareVersions normal', () => {
    it('equal versions return 0', () => {
      expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    });

    it('higher major wins', () => {
      expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    });

    it('higher minor wins', () => {
      expect(compareVersions('1.2.0', '1.1.9')).toBeGreaterThan(0);
    });

    it('higher patch wins', () => {
      expect(compareVersions('1.0.2', '1.0.1')).toBeGreaterThan(0);
    });

    it('lower version returns negative', () => {
      expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    });

    it('strips v prefix', () => {
      expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
      expect(compareVersions('v2.0.0', 'v1.0.0')).toBeGreaterThan(0);
    });

    it('handles missing patch (short versions)', () => {
      expect(compareVersions('1.0', '1.0.0')).toBe(0);
    });
  });

  // =========================================================================
  // formatUpdateNotification
  // =========================================================================
  describe('formatUpdateNotification', () => {
    it('returns null when no updates available', () => {
      const updates: UpdateInfo[] = [
        { packageName: 'foo', currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false },
      ];
      expect(formatUpdateNotification(updates)).toBeNull();
    });

    it('returns null for empty array', () => {
      expect(formatUpdateNotification([])).toBeNull();
    });

    it('formats single update notification', () => {
      const updates: UpdateInfo[] = [
        { packageName: 'foo', currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true },
      ];
      const result = formatUpdateNotification(updates);
      expect(result).toContain('Updates available');
      expect(result).toContain('foo');
      expect(result).toContain('1.0.0');
      expect(result).toContain('2.0.0');
      expect(result).toContain('npm update');
    });

    it('formats multiple updates, skips non-updates', () => {
      const updates: UpdateInfo[] = [
        { packageName: 'foo', currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true },
        { packageName: 'bar', currentVersion: '3.0.0', latestVersion: '4.0.0', updateAvailable: true },
        { packageName: 'baz', currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false },
      ];
      const result = formatUpdateNotification(updates);
      expect(result).toContain('foo');
      expect(result).toContain('bar');
      expect(result).not.toContain('baz');
    });
  });
});
