/**
 * Parse a datetime that may or may not carry a timezone.
 *
 * The API renders datetimes as naive UTC with NO suffix ("2026-08-17T18:09:00"
 * — see httpx.FormatDateTime), which `new Date()` interprets as LOCAL time.
 * Optimistic updates written on the client use `toISOString()`, which DOES
 * carry a "Z". Mixing the two silently offsets every server value by the
 * viewer's UTC offset — that's what scrambled the checked-grocery ordering.
 *
 * Always route server datetimes through this instead of `new Date(...)`.
 */
export function parseServerDate(iso: string): number {
  const hasTz = /([Zz]|[+-]\d{2}:?\d{2})$/.test(iso);
  return Date.parse(hasTz ? iso : `${iso}Z`);
}
