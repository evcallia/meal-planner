import { describe, it, expect } from 'vitest';
import { recency, formatAgo, formatTarget, progressPercent, inSeason, seasonLabel, effectiveDate, computeStreak } from '../recency';

const DAY = 86400000;

describe('recency', () => {
  const now = Date.parse('2026-06-12T12:00:00Z');
  const ago = (days: number) => new Date(now - days * DAY).toISOString();

  it('treats a task with no target as neutral and low-priority', () => {
    const r = recency(ago(100), null, now);
    expect(r.level).toBe('none');
    expect(r.urgency).toBe(-1);
  });

  it('treats a never-done task with a target as most urgent', () => {
    const r = recency(null, 7, now);
    expect(r.level).toBe('due');
    expect(r.urgency).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('grades freshness by elapsed/target ratio', () => {
    expect(recency(ago(1), 7, now).level).toBe('fresh');   // 0.14
    expect(recency(ago(4), 7, now).level).toBe('ok');      // 0.57
    expect(recency(ago(6), 7, now).level).toBe('soon');    // 0.86
    expect(recency(ago(8), 7, now).level).toBe('due');     // 1.14
    expect(recency(ago(20), 7, now).level).toBe('over');   // 2.86
  });

  it('uses ratio as the urgency sort key so overdue floats up', () => {
    const fresh = recency(ago(1), 7, now);
    const over = recency(ago(20), 7, now);
    expect(over.urgency).toBeGreaterThan(fresh.urgency);
  });
});

describe('formatAgo', () => {
  const now = Date.parse('2026-06-12T12:00:00Z');
  it('handles never done', () => expect(formatAgo(null, now)).toBe('never done'));
  it('handles just now', () => expect(formatAgo(new Date(now - 10000).toISOString(), now)).toBe('just now'));
  it('formats hours and days', () => {
    expect(formatAgo(new Date(now - 3 * 3600000).toISOString(), now)).toBe('3h ago');
    expect(formatAgo(new Date(now - 3 * DAY).toISOString(), now)).toBe('3d ago');
    expect(formatAgo(new Date(now - 14 * DAY).toISOString(), now)).toBe('2w ago');
  });
});

describe('formatTarget', () => {
  it('formats common intervals', () => {
    expect(formatTarget(null)).toBeNull();
    expect(formatTarget(3)).toBe('every 3d');
    expect(formatTarget(7)).toBe('every 1w');
    expect(formatTarget(30)).toBe('every 1mo');
    expect(formatTarget(365)).toBe('every 1y');
  });
});

describe('progressPercent', () => {
  const now = Date.parse('2026-06-12T12:00:00Z');
  const ago = (d: number) => new Date(now - d * DAY).toISOString();
  it('is 0 for no-target tasks', () => {
    expect(progressPercent(recency(ago(50), null, now))).toBe(0);
  });
  it('is 100 for never-done-with-target (overdue)', () => {
    expect(progressPercent(recency(null, 7, now))).toBe(100);
  });
  it('scales with elapsed/target and caps at 100', () => {
    expect(progressPercent(recency(ago(3.5), 7, now))).toBeCloseTo(50, 1);
    expect(progressPercent(recency(ago(20), 7, now))).toBe(100); // overdue caps
  });
});

describe('inSeason / seasonLabel', () => {
  const june20 = new Date('2026-06-20T12:00:00Z');
  const january = new Date('2026-01-12T12:00:00Z');
  it('treats null bounds as all-year', () => {
    expect(inSeason(null, null, null, null, june20)).toBe(true);
  });
  it('handles a normal spring–summer range', () => {
    expect(inSeason(3, 1, 8, 31, june20)).toBe(true);
    expect(inSeason(3, 1, 8, 31, january)).toBe(false);
  });
  it('respects day boundaries', () => {
    expect(inSeason(6, 25, 8, 31, june20)).toBe(false); // June 20 is before June 25 start
    expect(inSeason(6, 1, 6, 15, june20)).toBe(false);  // ends June 15
  });
  it('handles a year-wrapping winter range', () => {
    expect(inSeason(11, 1, 2, 28, january)).toBe(true);
    expect(inSeason(11, 1, 2, 28, june20)).toBe(false);
  });
  it('labels seasons', () => {
    expect(seasonLabel(null, null, null, null)).toBeNull();
    expect(seasonLabel(3, 15, 5, 31)).toBe('Mar 15–May 31');
  });
});

describe('effectiveDate', () => {
  it('returns the later of done and snooze', () => {
    expect(effectiveDate('2026-06-01T00:00:00Z', '2026-06-05T00:00:00Z')).toBe('2026-06-05T00:00:00Z');
    expect(effectiveDate('2026-06-10T00:00:00Z', '2026-06-05T00:00:00Z')).toBe('2026-06-10T00:00:00Z');
    expect(effectiveDate(null, '2026-06-05T00:00:00Z')).toBe('2026-06-05T00:00:00Z');
    expect(effectiveDate('2026-06-01T00:00:00Z', null)).toBe('2026-06-01T00:00:00Z');
  });
});

describe('computeStreak', () => {
  const base = Date.parse('2026-06-01T00:00:00Z');
  const at = (d: number) => new Date(base + d * DAY).toISOString();
  it('counts consecutive on-time completions', () => {
    // gaps of 5,5,5 with target 7 → streak 4
    expect(computeStreak([at(0), at(5), at(10), at(15)], 7)).toBe(4);
  });
  it('breaks the streak on a too-large gap', () => {
    // newest two are 5 apart, then a 20-day gap → streak 2
    expect(computeStreak([at(40), at(45), at(20), at(0)], 7)).toBe(2);
  });
  it('is 0 with no target', () => {
    expect(computeStreak([at(0), at(5)], null)).toBe(0);
  });
});
