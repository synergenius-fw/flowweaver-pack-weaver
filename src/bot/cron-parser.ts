import type { ParsedCron, CronField } from './types.js';

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expression}": expected 5 fields (minute hour day-of-month month day-of-week)`,
    );
  }

  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dayOfMonth: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dayOfWeek: parseField(parts[4]!, 0, 6),
    source: expression,
  };
}

function parseField(token: string, min: number, max: number): CronField {
  if (token === '*') {
    return { type: 'wildcard', values: range(min, max) };
  }

  const values = new Set<number>();

  for (const part of token.split(',')) {
    if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/');
      const step = parseInt(stepStr!, 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step in "${part}"`);

      let start: number;
      let end: number;
      if (rangeStr === '*') {
        start = min;
        end = max;
      } else if (rangeStr!.includes('-')) {
        [start, end] = rangeStr!.split('-').map(Number) as [number, number];
      } else {
        start = parseInt(rangeStr!, 10);
        end = max;
      }

      for (let i = start; i <= end; i += step) {
        if (i >= min && i <= max) values.add(i);
      }
    } else if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);
      if (isNaN(start) || isNaN(end)) throw new Error(`Invalid range in "${part}"`);
      for (let i = start; i <= end; i++) {
        if (i >= min && i <= max) values.add(i);
      }
    } else {
      const val = parseInt(part, 10);
      if (isNaN(val) || val < min || val > max) {
        throw new Error(`Invalid value "${part}" (expected ${min}-${max})`);
      }
      values.add(val);
    }
  }

  return {
    type: values.size === max - min + 1 ? 'wildcard' : 'list',
    values: [...values].sort((a, b) => a - b),
  };
}

function range(min: number, max: number): number[] {
  const result: number[] = [];
  for (let i = min; i <= max; i++) result.push(i);
  return result;
}

export function matches(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  if (!includes(parsed.minute, minute)) return false;
  if (!includes(parsed.hour, hour)) return false;
  if (!includes(parsed.month, month)) return false;

  // Vixie cron: if both dayOfMonth and dayOfWeek are restricted, match on EITHER
  const domRestricted = parsed.dayOfMonth.type === 'list';
  const dowRestricted = parsed.dayOfWeek.type === 'list';

  if (domRestricted && dowRestricted) {
    return includes(parsed.dayOfMonth, dayOfMonth) || includes(parsed.dayOfWeek, dayOfWeek);
  }

  if (!includes(parsed.dayOfMonth, dayOfMonth)) return false;
  if (!includes(parsed.dayOfWeek, dayOfWeek)) return false;

  return true;
}

function includes(field: CronField, value: number): boolean {
  if (field.type === 'wildcard') return true;
  return field.values.includes(value);
}

export function nextMatch(parsed: ParsedCron, after: Date): Date {
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Safety cap: 2 years
  const limit = after.getTime() + 2 * 365 * 24 * 60 * 60 * 1000;

  while (candidate.getTime() < limit) {
    if (matches(parsed, candidate)) return candidate;

    // Skip non-matching months
    if (!includes(parsed.month, candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Skip non-matching days
    const dayOfMonth = candidate.getDate();
    const dayOfWeek = candidate.getDay();
    const domRestricted = parsed.dayOfMonth.type === 'list';
    const dowRestricted = parsed.dayOfWeek.type === 'list';

    const dayMatches = domRestricted && dowRestricted
      ? includes(parsed.dayOfMonth, dayOfMonth) || includes(parsed.dayOfWeek, dayOfWeek)
      : includes(parsed.dayOfMonth, dayOfMonth) && includes(parsed.dayOfWeek, dayOfWeek);

    if (!dayMatches) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Skip non-matching hours
    if (!includes(parsed.hour, candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    // Advance by one minute
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`No cron match found within 2 years for "${parsed.source}"`);
}
