import { describe, it, expect } from 'vitest';
import { computeStats } from '../useTracker';

const DAY = 86400000;

describe('computeStats', () => {
  it('returns empty stats for no completions', () => {
    expect(computeStats([])).toEqual({ last_done_at: null, total_count: 0, avg_interval_days: null });
  });

  it('returns count + last with no average for a single completion', () => {
    const iso = new Date().toISOString();
    const s = computeStats([iso]);
    expect(s.total_count).toBe(1);
    expect(s.last_done_at).toBe(iso);
    expect(s.avg_interval_days).toBeNull();
  });

  it('averages the gaps between consecutive completions', () => {
    const base = Date.parse('2026-06-01T00:00:00Z');
    const times = [base, base + 2 * DAY, base + 6 * DAY].map(t => new Date(t).toISOString());
    const s = computeStats(times);
    expect(s.total_count).toBe(3);
    // gaps: 2d and 4d → avg 3d
    expect(s.avg_interval_days).toBe(3);
    expect(s.last_done_at).toBe(new Date(base + 6 * DAY).toISOString());
  });

  it('ignores unparseable timestamps', () => {
    const iso = new Date().toISOString();
    const s = computeStats(['nonsense', iso]);
    expect(s.total_count).toBe(1);
  });
});
