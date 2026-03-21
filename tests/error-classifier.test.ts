import { describe, it, expect } from 'vitest';
import { classifyError, isTransientError, getErrorGuidance } from '../src/bot/error-classifier.js';

describe('error-classifier', () => {
  describe('classifyError', () => {
    // --- Transient HTTP codes ---

    it('classifies 408 Request Timeout as transient/timeout', () => {
      const result = classifyError(new Error('HTTP 408 Request Timeout'));
      expect(result.isTransient).toBe(true);
      expect(result.category).toBe('timeout');
      expect(result.guidance).toContain('408');
    });

    it('classifies 500 Internal Server Error as transient/network', () => {
      const result = classifyError(new Error('500 Internal Server Error'));
      expect(result.isTransient).toBe(true);
      expect(result.category).toBe('network');
      expect(result.guidance).toContain('500');
    });

    it('classifies bare "500" in message as transient', () => {
      const result = classifyError(new Error('API returned status 500'));
      expect(result.isTransient).toBe(true);
    });

    it('classifies "request timeout" text as transient', () => {
      const result = classifyError(new Error('request timeout from upstream'));
      expect(result.isTransient).toBe(true);
      expect(result.category).toBe('timeout');
    });

    // --- Permanent HTTP codes ---

    it('classifies 400 Bad Request as permanent/parse', () => {
      const result = classifyError(new Error('400 Bad Request'));
      expect(result.isTransient).toBe(false);
      expect(result.category).toBe('parse');
      expect(result.guidance).toContain('400');
    });

    it('classifies "bad request" text as permanent', () => {
      const result = classifyError(new Error('Server returned bad request'));
      expect(result.isTransient).toBe(false);
      expect(result.category).toBe('parse');
    });

    it('classifies 404 Not Found as permanent/network', () => {
      const result = classifyError(new Error('HTTP 404 Not Found'));
      expect(result.isTransient).toBe(false);
      expect(result.category).toBe('network');
      expect(result.guidance).toContain('404');
    });

    it('classifies "not found" text as permanent', () => {
      const result = classifyError(new Error('Resource not found'));
      expect(result.isTransient).toBe(false);
      expect(result.category).toBe('network');
    });

    it('classifies 422 Unprocessable Entity as permanent/parse', () => {
      const result = classifyError(new Error('422 Unprocessable Entity'));
      expect(result.isTransient).toBe(false);
      expect(result.category).toBe('parse');
      expect(result.guidance).toContain('422');
    });

    it('classifies "unprocessable" text as permanent', () => {
      const result = classifyError(new Error('Request body unprocessable'));
      expect(result.isTransient).toBe(false);
      expect(result.category).toBe('parse');
    });

    // --- Existing codes still work ---

    it('classifies 429 as transient/rate-limit', () => {
      const result = classifyError(new Error('429 Too Many Requests'));
      expect(result.isTransient).toBe(true);
      expect(result.category).toBe('rate-limit');
    });

    it('classifies 502 as transient/network', () => {
      const result = classifyError(new Error('502 Bad Gateway'));
      expect(result.isTransient).toBe(true);
      expect(result.category).toBe('network');
    });

    it('classifies 503 as transient/network', () => {
      const result = classifyError(new Error('503 Service Unavailable'));
      expect(result.isTransient).toBe(true);
      expect(result.category).toBe('network');
    });

    it('classifies unknown errors as permanent/unknown with no guidance', () => {
      const result = classifyError(new Error('something weird happened'));
      expect(result.isTransient).toBe(false);
      expect(result.category).toBe('unknown');
      expect(result.guidance).toBeNull();
    });
  });

  describe('isTransientError', () => {
    it('returns true for 408', () => {
      expect(isTransientError(new Error('408'))).toBe(true);
    });

    it('returns true for 500', () => {
      expect(isTransientError(new Error('500'))).toBe(true);
    });

    it('returns false for 400', () => {
      expect(isTransientError(new Error('400'))).toBe(false);
    });

    it('returns false for 404', () => {
      expect(isTransientError(new Error('404'))).toBe(false);
    });

    it('returns false for 422', () => {
      expect(isTransientError(new Error('422'))).toBe(false);
    });
  });

  describe('getErrorGuidance', () => {
    it('returns guidance for 408', () => {
      expect(getErrorGuidance('408 Request Timeout')).toContain('408');
    });

    it('returns guidance for 500', () => {
      expect(getErrorGuidance('Internal Server Error 500')).toContain('500');
    });

    it('returns guidance for 400', () => {
      expect(getErrorGuidance('400 Bad Request')).toContain('400');
    });

    it('returns guidance for 404', () => {
      expect(getErrorGuidance('404 Not Found')).toContain('404');
    });

    it('returns guidance for 422', () => {
      expect(getErrorGuidance('422 Unprocessable')).toContain('422');
    });

    it('returns null for unknown errors', () => {
      expect(getErrorGuidance('bazinga')).toBeNull();
    });
  });
});
