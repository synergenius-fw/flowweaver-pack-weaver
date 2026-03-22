import { describe, it, expect } from 'vitest';
import { parseCron, matches, nextMatch } from '../src/bot/cron-parser.js';

// ---------------------------------------------------------------------------
// parseCron
// ---------------------------------------------------------------------------
describe('parseCron', () => {
  // ---- wildcards -----------------------------------------------------------
  describe('wildcards', () => {
    it('parses "* * * * *" as all-wildcard', () => {
      const p = parseCron('* * * * *');
      expect(p.minute.type).toBe('wildcard');
      expect(p.hour.type).toBe('wildcard');
      expect(p.dayOfMonth.type).toBe('wildcard');
      expect(p.month.type).toBe('wildcard');
      expect(p.dayOfWeek.type).toBe('wildcard');
      expect(p.source).toBe('* * * * *');
    });

    it('wildcard minute contains 0-59', () => {
      const p = parseCron('* * * * *');
      expect(p.minute.values).toHaveLength(60);
      expect(p.minute.values[0]).toBe(0);
      expect(p.minute.values[59]).toBe(59);
    });

    it('wildcard hour contains 0-23', () => {
      const p = parseCron('* * * * *');
      expect(p.hour.values).toHaveLength(24);
    });

    it('wildcard dayOfMonth contains 1-31', () => {
      const p = parseCron('* * * * *');
      expect(p.dayOfMonth.values).toHaveLength(31);
      expect(p.dayOfMonth.values[0]).toBe(1);
    });

    it('wildcard month contains 1-12', () => {
      const p = parseCron('* * * * *');
      expect(p.month.values).toHaveLength(12);
      expect(p.month.values[0]).toBe(1);
    });

    it('wildcard dayOfWeek contains 0-6', () => {
      const p = parseCron('* * * * *');
      expect(p.dayOfWeek.values).toHaveLength(7);
      expect(p.dayOfWeek.values[0]).toBe(0);
    });
  });

  // ---- simple values -------------------------------------------------------
  describe('simple values', () => {
    it('parses a single value per field', () => {
      const p = parseCron('30 9 15 6 3');
      expect(p.minute).toEqual({ type: 'list', values: [30] });
      expect(p.hour).toEqual({ type: 'list', values: [9] });
      expect(p.dayOfMonth).toEqual({ type: 'list', values: [15] });
      expect(p.month).toEqual({ type: 'list', values: [6] });
      expect(p.dayOfWeek).toEqual({ type: 'list', values: [3] });
    });

    it('parses minute = 0', () => {
      const p = parseCron('0 * * * *');
      expect(p.minute).toEqual({ type: 'list', values: [0] });
    });
  });

  // ---- lists ---------------------------------------------------------------
  describe('lists', () => {
    it('parses comma-separated values', () => {
      const p = parseCron('0,15,30,45 * * * *');
      expect(p.minute.values).toEqual([0, 15, 30, 45]);
      expect(p.minute.type).toBe('list');
    });

    it('deduplicates repeated values', () => {
      const p = parseCron('5,5,10,10 * * * *');
      expect(p.minute.values).toEqual([5, 10]);
    });

    it('sorts values', () => {
      const p = parseCron('45,15,30,0 * * * *');
      expect(p.minute.values).toEqual([0, 15, 30, 45]);
    });
  });

  // ---- ranges --------------------------------------------------------------
  describe('ranges', () => {
    it('parses a simple range', () => {
      const p = parseCron('1-5 * * * *');
      expect(p.minute.values).toEqual([1, 2, 3, 4, 5]);
      expect(p.minute.type).toBe('list');
    });

    it('parses hour range', () => {
      const p = parseCron('* 9-17 * * *');
      expect(p.hour.values).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    });

    it('clamps values within range bounds', () => {
      // Range extending beyond max is clamped by the for-loop condition i <= end
      // but values outside min..max are not added
      const p = parseCron('* * 28-31 * *');
      expect(p.dayOfMonth.values).toEqual([28, 29, 30, 31]);
    });

    it('single-value range (start == end)', () => {
      const p = parseCron('5-5 * * * *');
      expect(p.minute.values).toEqual([5]);
    });

    it('marks field as wildcard when range covers full span', () => {
      const p = parseCron('0-59 * * * *');
      expect(p.minute.type).toBe('wildcard');
      expect(p.minute.values).toHaveLength(60);
    });
  });

  // ---- steps ---------------------------------------------------------------
  describe('steps', () => {
    it('parses */5 for minutes', () => {
      const p = parseCron('*/5 * * * *');
      expect(p.minute.values).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    });

    it('parses */15 for minutes', () => {
      const p = parseCron('*/15 * * * *');
      expect(p.minute.values).toEqual([0, 15, 30, 45]);
    });

    it('parses */2 for hours', () => {
      const p = parseCron('* */2 * * *');
      expect(p.hour.values).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    });

    it('parses range with step: 1-10/2', () => {
      const p = parseCron('1-10/2 * * * *');
      expect(p.minute.values).toEqual([1, 3, 5, 7, 9]);
    });

    it('parses start/step without range: 5/10', () => {
      const p = parseCron('5/10 * * * *');
      expect(p.minute.values).toEqual([5, 15, 25, 35, 45, 55]);
    });

    it('*/1 is equivalent to wildcard', () => {
      const p = parseCron('*/1 * * * *');
      expect(p.minute.type).toBe('wildcard');
      expect(p.minute.values).toHaveLength(60);
    });
  });

  // ---- combined expressions ------------------------------------------------
  describe('combined expressions', () => {
    it('parses list with range: 0,30,45-50', () => {
      const p = parseCron('0,30,45-50 * * * *');
      expect(p.minute.values).toEqual([0, 30, 45, 46, 47, 48, 49, 50]);
    });

    it('parses list with step: 0,*/20', () => {
      const p = parseCron('0,*/20 * * * *');
      // */20 gives 0,20,40 plus the explicit 0 (deduped)
      expect(p.minute.values).toEqual([0, 20, 40]);
    });

    it('parses multiple ranges: 1-3,7-9', () => {
      const p = parseCron('1-3,7-9 * * * *');
      expect(p.minute.values).toEqual([1, 2, 3, 7, 8, 9]);
    });
  });

  // ---- whitespace ----------------------------------------------------------
  describe('whitespace handling', () => {
    it('trims leading/trailing whitespace', () => {
      const p = parseCron('  0 12 * * *  ');
      expect(p.minute.values).toEqual([0]);
      expect(p.hour.values).toEqual([12]);
    });

    it('handles multiple spaces between fields', () => {
      const p = parseCron('0  12  *  *  *');
      expect(p.minute.values).toEqual([0]);
      expect(p.hour.values).toEqual([12]);
    });
  });

  // ---- error cases ---------------------------------------------------------
  describe('error cases', () => {
    it('throws on too few fields', () => {
      expect(() => parseCron('* * *')).toThrow('expected 5 fields');
    });

    it('throws on too many fields', () => {
      expect(() => parseCron('* * * * * *')).toThrow('expected 5 fields');
    });

    it('throws on empty string', () => {
      expect(() => parseCron('')).toThrow('expected 5 fields');
    });

    it('throws on single field', () => {
      expect(() => parseCron('5')).toThrow('expected 5 fields');
    });

    it('throws on non-numeric value', () => {
      expect(() => parseCron('abc * * * *')).toThrow();
    });

    it('throws on out-of-range minute (60)', () => {
      expect(() => parseCron('60 * * * *')).toThrow();
    });

    it('throws on negative minute', () => {
      expect(() => parseCron('-1 * * * *')).toThrow();
    });

    it('throws on out-of-range hour (24)', () => {
      expect(() => parseCron('* 24 * * *')).toThrow();
    });

    it('throws on out-of-range month (13)', () => {
      expect(() => parseCron('* * * 13 *')).toThrow();
    });

    it('throws on out-of-range month (0)', () => {
      expect(() => parseCron('* * * 0 *')).toThrow();
    });

    it('throws on out-of-range day-of-week (7)', () => {
      expect(() => parseCron('* * * * 7')).toThrow();
    });

    it('throws on invalid step value (0)', () => {
      expect(() => parseCron('*/0 * * * *')).toThrow('Invalid step');
    });

    it('throws on invalid step value (negative)', () => {
      expect(() => parseCron('*/-1 * * * *')).toThrow('Invalid step');
    });

    it('throws on non-numeric step', () => {
      expect(() => parseCron('*/abc * * * *')).toThrow('Invalid step');
    });

    it('throws on invalid range values', () => {
      expect(() => parseCron('a-b * * * *')).toThrow('Invalid range');
    });

    it('throws on invalid range values in step expressions (e.g., a-b/2)', () => {
      expect(() => parseCron('a-b/2 * * * *')).toThrow('Invalid range');
    });

    it('throws on partially invalid range in step expressions (e.g., 1-x/3)', () => {
      expect(() => parseCron('1-x/3 * * * *')).toThrow('Invalid range');
    });
  });
});

// ---------------------------------------------------------------------------
// matches
// ---------------------------------------------------------------------------
describe('matches', () => {
  // Helper to build a Date easily (months are 1-based here for readability)
  function d(year: number, month: number, day: number, hour: number, minute: number): Date {
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  describe('every-minute wildcard', () => {
    const parsed = parseCron('* * * * *');

    it('matches any date', () => {
      expect(matches(parsed, d(2026, 1, 1, 0, 0))).toBe(true);
      expect(matches(parsed, d(2026, 6, 15, 12, 30))).toBe(true);
      expect(matches(parsed, d(2026, 12, 31, 23, 59))).toBe(true);
    });
  });

  describe('specific time', () => {
    const parsed = parseCron('30 9 * * *');

    it('matches at 09:30', () => {
      expect(matches(parsed, d(2026, 3, 13, 9, 30))).toBe(true);
    });

    it('does not match at 09:31', () => {
      expect(matches(parsed, d(2026, 3, 13, 9, 31))).toBe(false);
    });

    it('does not match at 10:30', () => {
      expect(matches(parsed, d(2026, 3, 13, 10, 30))).toBe(false);
    });
  });

  describe('specific day of month', () => {
    const parsed = parseCron('0 0 1 * *');

    it('matches first of month at midnight', () => {
      expect(matches(parsed, d(2026, 5, 1, 0, 0))).toBe(true);
    });

    it('does not match second of month', () => {
      expect(matches(parsed, d(2026, 5, 2, 0, 0))).toBe(false);
    });
  });

  describe('specific month', () => {
    const parsed = parseCron('0 0 * 6 *');

    it('matches in June', () => {
      expect(matches(parsed, d(2026, 6, 15, 0, 0))).toBe(true);
    });

    it('does not match in July', () => {
      expect(matches(parsed, d(2026, 7, 15, 0, 0))).toBe(false);
    });
  });

  describe('specific day of week', () => {
    // 2026-03-13 is a Friday (day 5)
    const parsed = parseCron('0 9 * * 5');

    it('matches on Friday', () => {
      expect(matches(parsed, d(2026, 3, 13, 9, 0))).toBe(true);
    });

    it('does not match on Saturday', () => {
      expect(matches(parsed, d(2026, 3, 14, 9, 0))).toBe(false);
    });
  });

  describe('Sunday is day 0', () => {
    const parsed = parseCron('0 0 * * 0');

    it('matches on Sunday', () => {
      // 2026-03-15 is a Sunday
      expect(matches(parsed, d(2026, 3, 15, 0, 0))).toBe(true);
    });

    it('does not match on Monday', () => {
      expect(matches(parsed, d(2026, 3, 16, 0, 0))).toBe(false);
    });
  });

  describe('step-based minutes', () => {
    const parsed = parseCron('*/15 * * * *');

    it('matches at minute 0', () => {
      expect(matches(parsed, d(2026, 1, 1, 0, 0))).toBe(true);
    });

    it('matches at minute 15', () => {
      expect(matches(parsed, d(2026, 1, 1, 0, 15))).toBe(true);
    });

    it('does not match at minute 7', () => {
      expect(matches(parsed, d(2026, 1, 1, 0, 7))).toBe(false);
    });
  });

  describe('Vixie cron OR logic for day-of-month + day-of-week', () => {
    // "on the 15th OR on Fridays at 10:00"
    // 2026-03-13 is a Friday (not the 15th)
    // 2026-03-15 is a Sunday (is the 15th)
    const parsed = parseCron('0 10 15 * 5');

    it('matches on Friday (day-of-week match, not day-of-month)', () => {
      expect(matches(parsed, d(2026, 3, 13, 10, 0))).toBe(true);
    });

    it('matches on 15th (day-of-month match, not day-of-week)', () => {
      expect(matches(parsed, d(2026, 3, 15, 10, 0))).toBe(true);
    });

    it('does not match on 14th Saturday (neither day-of-month nor day-of-week)', () => {
      // 2026-03-14 is Saturday (day 6)
      expect(matches(parsed, d(2026, 3, 14, 10, 0))).toBe(false);
    });

    it('does not match at wrong time even on matching day', () => {
      expect(matches(parsed, d(2026, 3, 13, 11, 0))).toBe(false);
    });
  });

  describe('both day fields wildcard means AND (always matches)', () => {
    const parsed = parseCron('0 0 * * *');

    it('matches any day', () => {
      expect(matches(parsed, d(2026, 3, 13, 0, 0))).toBe(true);
      expect(matches(parsed, d(2026, 3, 14, 0, 0))).toBe(true);
    });
  });

  describe('only dayOfMonth restricted (dayOfWeek is wildcard)', () => {
    const parsed = parseCron('0 0 1 * *');

    it('matches on 1st regardless of day-of-week', () => {
      expect(matches(parsed, d(2026, 1, 1, 0, 0))).toBe(true);
    });

    it('does not match on 2nd', () => {
      expect(matches(parsed, d(2026, 1, 2, 0, 0))).toBe(false);
    });
  });

  describe('only dayOfWeek restricted (dayOfMonth is wildcard)', () => {
    const parsed = parseCron('0 0 * * 1');

    it('matches on Monday regardless of date', () => {
      // 2026-03-16 is Monday
      expect(matches(parsed, d(2026, 3, 16, 0, 0))).toBe(true);
    });

    it('does not match on Tuesday', () => {
      expect(matches(parsed, d(2026, 3, 17, 0, 0))).toBe(false);
    });
  });

  describe('midnight edge case', () => {
    const parsed = parseCron('0 0 * * *');

    it('matches exactly at midnight', () => {
      expect(matches(parsed, d(2026, 1, 1, 0, 0))).toBe(true);
    });

    it('does not match at 00:01', () => {
      expect(matches(parsed, d(2026, 1, 1, 0, 1))).toBe(false);
    });
  });

  describe('end-of-day edge case', () => {
    const parsed = parseCron('59 23 * * *');

    it('matches at 23:59', () => {
      expect(matches(parsed, d(2026, 1, 1, 23, 59))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// nextMatch
// ---------------------------------------------------------------------------
describe('nextMatch', () => {
  function d(year: number, month: number, day: number, hour: number, minute: number): Date {
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  describe('next minute', () => {
    it('returns the very next minute for every-minute cron', () => {
      const parsed = parseCron('* * * * *');
      const result = nextMatch(parsed, d(2026, 3, 13, 10, 30));
      expect(result).toEqual(d(2026, 3, 13, 10, 31));
    });
  });

  describe('skipping to the right minute', () => {
    it('finds next :00 within the same hour', () => {
      const parsed = parseCron('0 * * * *');
      const result = nextMatch(parsed, d(2026, 3, 13, 10, 30));
      expect(result).toEqual(d(2026, 3, 13, 11, 0));
    });

    it('finds next :30 from :00', () => {
      const parsed = parseCron('30 * * * *');
      const result = nextMatch(parsed, d(2026, 3, 13, 10, 0));
      expect(result).toEqual(d(2026, 3, 13, 10, 30));
    });

    it('finds next :30 when currently at :30 (advances to next hour)', () => {
      const parsed = parseCron('30 * * * *');
      const result = nextMatch(parsed, d(2026, 3, 13, 10, 30));
      expect(result).toEqual(d(2026, 3, 13, 11, 30));
    });
  });

  describe('skipping hours', () => {
    it('skips to the next matching hour', () => {
      const parsed = parseCron('0 9 * * *');
      const result = nextMatch(parsed, d(2026, 3, 13, 10, 0));
      expect(result).toEqual(d(2026, 3, 14, 9, 0));
    });

    it('finds match later the same day', () => {
      const parsed = parseCron('0 17 * * *');
      const result = nextMatch(parsed, d(2026, 3, 13, 9, 0));
      expect(result).toEqual(d(2026, 3, 13, 17, 0));
    });
  });

  describe('skipping days', () => {
    it('skips to the next day when today is past the time', () => {
      const parsed = parseCron('0 8 * * *');
      const result = nextMatch(parsed, d(2026, 3, 13, 20, 0));
      expect(result).toEqual(d(2026, 3, 14, 8, 0));
    });

    it('skips to the correct day-of-week', () => {
      // Only Mondays at 9:00; 2026-03-13 is Friday, next Monday is 2026-03-16
      const parsed = parseCron('0 9 * * 1');
      const result = nextMatch(parsed, d(2026, 3, 13, 10, 0));
      expect(result).toEqual(d(2026, 3, 16, 9, 0));
    });

    it('finds next first-of-month', () => {
      const parsed = parseCron('0 0 1 * *');
      const result = nextMatch(parsed, d(2026, 3, 13, 0, 0));
      expect(result).toEqual(d(2026, 4, 1, 0, 0));
    });
  });

  describe('skipping months', () => {
    it('skips to a specific month', () => {
      // Only in December
      const parsed = parseCron('0 0 1 12 *');
      const result = nextMatch(parsed, d(2026, 3, 13, 0, 0));
      expect(result).toEqual(d(2026, 12, 1, 0, 0));
    });

    it('wraps to next year when month is past', () => {
      const parsed = parseCron('0 0 1 1 *');
      const result = nextMatch(parsed, d(2026, 3, 13, 0, 0));
      expect(result).toEqual(d(2027, 1, 1, 0, 0));
    });
  });

  describe('month boundary crossings', () => {
    it('crosses from Jan 31 to Feb 1', () => {
      const parsed = parseCron('0 0 1 2 *');
      const result = nextMatch(parsed, d(2026, 1, 31, 0, 0));
      expect(result).toEqual(d(2026, 2, 1, 0, 0));
    });

    it('crosses from short month (April 30) to May', () => {
      const parsed = parseCron('0 0 * * *');
      const result = nextMatch(parsed, d(2026, 4, 30, 0, 0));
      expect(result).toEqual(d(2026, 5, 1, 0, 0));
    });
  });

  describe('Feb 29 (leap year)', () => {
    it('finds Feb 29 in a leap year', () => {
      // 2028 is a leap year
      const parsed = parseCron('0 0 29 2 *');
      const result = nextMatch(parsed, d(2026, 3, 13, 0, 0));
      expect(result).toEqual(d(2028, 2, 29, 0, 0));
    });
  });

  describe('midnight transitions', () => {
    it('transitions from 23:59 to next day 00:00', () => {
      const parsed = parseCron('0 0 * * *');
      const result = nextMatch(parsed, d(2026, 3, 13, 23, 59));
      expect(result).toEqual(d(2026, 3, 14, 0, 0));
    });
  });

  describe('step-based cron', () => {
    it('finds next */15 minute from :07', () => {
      const parsed = parseCron('*/15 * * * *');
      const result = nextMatch(parsed, d(2026, 3, 13, 10, 7));
      expect(result).toEqual(d(2026, 3, 13, 10, 15));
    });

    it('finds next */15 minute from :45', () => {
      const parsed = parseCron('*/15 * * * *');
      const result = nextMatch(parsed, d(2026, 3, 13, 10, 45));
      expect(result).toEqual(d(2026, 3, 13, 11, 0));
    });
  });

  describe('Vixie OR logic with nextMatch', () => {
    it('finds next match on either day-of-month or day-of-week', () => {
      // 15th or Fridays at 12:00
      const parsed = parseCron('0 12 15 * 5');
      // Starting from 2026-03-13 (Friday) at 13:00 — already past 12:00
      // Next Friday is 2026-03-20, but 2026-03-15 (Sunday) is the 15th
      // 2026-03-15 at 12:00 comes first
      const result = nextMatch(parsed, d(2026, 3, 13, 13, 0));
      expect(result).toEqual(d(2026, 3, 15, 12, 0));
    });
  });

  describe('complex expression', () => {
    it('finds next match for weekday 9-to-5 every 30 min', () => {
      // Every 30 min, hours 9-17, Mon-Fri
      const parsed = parseCron('0,30 9-17 * * 1-5');
      // From Friday 2026-03-13 at 17:30 — next is Monday 2026-03-16 at 09:00
      const result = nextMatch(parsed, d(2026, 3, 13, 17, 30));
      expect(result).toEqual(d(2026, 3, 16, 9, 0));
    });
  });

  describe('no match within 2 years throws', () => {
    it('throws when expression can never match (e.g., Feb 31)', () => {
      const parsed = parseCron('0 0 31 2 *');
      expect(() => nextMatch(parsed, d(2026, 1, 1, 0, 0))).toThrow('No cron match found within 2 years');
    });
  });
});
