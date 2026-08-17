import { describe, it, expect } from 'vitest';
import { parseServerDate } from '../serverDate';

// These hold in every timezone, unlike a component test that only exposes the
// bug when the machine isn't on UTC.

describe('parseServerDate', () => {
  it('reads a suffix-less API timestamp as UTC, not local time', () => {
    expect(parseServerDate('2026-08-17T18:09:00')).toBe(Date.parse('2026-08-17T18:09:00Z'));
  });

  it('leaves an explicit UTC timestamp alone', () => {
    expect(parseServerDate('2026-08-17T18:09:00.000Z')).toBe(Date.parse('2026-08-17T18:09:00.000Z'));
  });

  it('honours an explicit offset', () => {
    expect(parseServerDate('2026-08-17T11:09:00-07:00')).toBe(Date.parse('2026-08-17T18:09:00Z'));
    expect(parseServerDate('2026-08-17T11:09:00-0700')).toBe(Date.parse('2026-08-17T18:09:00Z'));
  });

  it('keeps microseconds', () => {
    expect(parseServerDate('2026-08-17T18:09:00.123456'))
      .toBe(Date.parse('2026-08-17T18:09:00.123Z'));
  });

  // The comparison that was broken: the same instant written both ways must
  // compare equal, so a locally-checked item and a server-echoed one sort by
  // when they actually happened.
  it('compares the two encodings of one instant as equal', () => {
    expect(parseServerDate('2026-08-17T18:09:00'))
      .toBe(parseServerDate('2026-08-17T18:09:00Z'));
  });

  it('orders a mixed set correctly', () => {
    const sorted = [
      '2026-08-17T17:00:00',        // server, oldest
      '2026-08-17T18:00:00.000Z',   // optimistic, newest
      '2026-08-17T17:30:00',        // server, middle
    ].sort((a, b) => parseServerDate(b) - parseServerDate(a));
    expect(sorted).toEqual([
      '2026-08-17T18:00:00.000Z',
      '2026-08-17T17:30:00',
      '2026-08-17T17:00:00',
    ]);
  });
});
