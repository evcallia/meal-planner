// Recency model for the Lists/tracker feature, mirroring lastGLANCE: a task's
// freshness is how long since it was last done relative to its target interval.

export type RecencyLevel = 'none' | 'fresh' | 'ok' | 'soon' | 'due' | 'over';

// The backend serializes naive UTC datetimes (no timezone suffix). JS Date.parse
// reads a tz-less ISO string as LOCAL time, which would skew "time ago" by the
// viewer's offset — so treat a suffix-less timestamp as UTC.
export function parseServerDate(iso: string): number {
  const hasTz = /([Zz]|[+-]\d{2}:?\d{2})$/.test(iso);
  return Date.parse(hasTz ? iso : `${iso}Z`);
}

export interface Recency {
  level: RecencyLevel;
  ratio: number | null;       // elapsed / target (null when no target)
  elapsedDays: number | null; // days since last done (null when never done)
  urgency: number;            // sort key — higher floats to the top
}

export function recency(lastDoneAt: string | null, targetDays: number | null, now: number = Date.now()): Recency {
  const elapsedDays = lastDoneAt ? (now - parseServerDate(lastDoneAt)) / 86400000 : null;

  if (!targetDays) {
    // No target: it's a plain tracked item, never "overdue".
    return { level: 'none', ratio: null, elapsedDays, urgency: -1 };
  }
  if (elapsedDays === null) {
    // Has a target but never done → most in need of attention.
    return { level: 'due', ratio: null, elapsedDays: null, urgency: Number.MAX_SAFE_INTEGER };
  }
  const ratio = elapsedDays / targetDays;
  let level: RecencyLevel;
  if (ratio < 0.5) level = 'fresh';
  else if (ratio < 0.8) level = 'ok';
  else if (ratio < 1) level = 'soon';
  else if (ratio < 1.5) level = 'due';
  else level = 'over';
  return { level, ratio, elapsedDays, urgency: ratio };
}

// `fill` uses literal class strings so Tailwind's scanner generates them.
export const RECENCY_CLASSES: Record<RecencyLevel, { dot: string; text: string; bar: string; fill: string }> = {
  none:  { dot: 'bg-gray-300 dark:bg-gray-600',   text: 'text-gray-400 dark:text-gray-500',     bar: 'bg-gray-300 dark:bg-gray-600', fill: 'bg-gray-400/10' },
  fresh: { dot: 'bg-emerald-500',                 text: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500', fill: 'bg-emerald-500/15' },
  ok:    { dot: 'bg-lime-500',                     text: 'text-lime-600 dark:text-lime-400',       bar: 'bg-lime-500',    fill: 'bg-lime-500/15' },
  soon:  { dot: 'bg-amber-500',                    text: 'text-amber-600 dark:text-amber-400',     bar: 'bg-amber-500',   fill: 'bg-amber-500/20' },
  due:   { dot: 'bg-red-500',                      text: 'text-red-600 dark:text-red-400',         bar: 'bg-red-500',     fill: 'bg-red-500/25' },
  over:  { dot: 'bg-red-700',                      text: 'text-red-700 dark:text-red-300',         bar: 'bg-red-700',     fill: 'bg-red-700/30' },
};

/** How full the row's progress bar is: elapsed/target, 0–100. Never-done-with-target reads as overdue (100). */
export function progressPercent(r: Recency): number {
  if (r.level === 'none') return 0;            // no target — no meaningful progress
  if (r.ratio == null) return 100;             // has target but never done → overdue
  return Math.min(1, r.ratio) * 100;
}

export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A task is in season if today falls within the recurring [start, end] date range
 * (inclusive, wraps year-end). Null month bounds = all year. */
export function inSeason(startMonth: number | null, startDay: number | null, endMonth: number | null, endDay: number | null, now: Date = new Date()): boolean {
  if (!startMonth || !endMonth) return true;
  const ord = (m: number, d: number | null) => m * 100 + (d || 1);
  const cur = ord(now.getMonth() + 1, now.getDate());
  const s = ord(startMonth, startDay);
  const e = ord(endMonth, endDay ?? 31);
  if (s <= e) return cur >= s && cur <= e;
  return cur >= s || cur <= e;
}

export function seasonLabel(startMonth: number | null, startDay: number | null, endMonth: number | null, endDay: number | null): string | null {
  if (!startMonth || !endMonth) return null;
  const fmt = (m: number, d: number | null) => d ? `${MONTH_ABBR[m - 1]} ${d}` : MONTH_ABBR[m - 1];
  return `${fmt(startMonth, startDay)}–${fmt(endMonth, endDay)}`;
}

/** Recency baseline: the later of the last completion and any active skip/snooze. */
export function effectiveDate(lastDoneAt: string | null, snoozeUntil: string | null): string | null {
  if (!lastDoneAt) return snoozeUntil;
  if (!snoozeUntil) return lastDoneAt;
  return parseServerDate(snoozeUntil) > parseServerDate(lastDoneAt) ? snoozeUntil : lastDoneAt;
}

/** Current streak: most-recent run of completions whose consecutive gaps stayed within target. */
export function computeStreak(doneAtList: string[], targetDays: number | null): number {
  if (!targetDays) return 0;
  const times = doneAtList.map(parseServerDate).filter(n => !Number.isNaN(n)).sort((a, b) => b - a);
  if (times.length === 0) return 0;
  let streak = 1;
  for (let i = 1; i < times.length; i++) {
    const gapDays = (times[i - 1] - times[i]) / 86400000;
    if (gapDays <= targetDays + 0.5) streak++;
    else break;
  }
  return streak;
}

/** Human "time ago" label, e.g. "just now", "3d ago", "2w ago". */
export function formatAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never done';
  const ms = now - parseServerDate(iso);
  if (Number.isNaN(ms)) return 'never done';
  if (ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Short label for a target interval, e.g. "every 7d". */
export function formatTarget(days: number | null): string | null {
  if (!days) return null;
  if (days % 365 === 0) return `every ${days / 365}y`;
  if (days % 30 === 0) return `every ${days / 30}mo`;
  if (days % 7 === 0) return `every ${days / 7}w`;
  return `every ${days}d`;
}
