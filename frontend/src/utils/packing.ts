import { PackingItem, PackingList, PackingSection } from '../types';
import { NONE_STORE_ID } from '../components/ChecklistParts';

// The "no bag assigned" pseudo-chip. Shares the grocery constant so the chip
// bar behaves identically on both tabs.
export const NONE_BAG_ID = NONE_STORE_ID;

export interface BagProgress {
  id: string;
  name: string;
  packed: number;
  total: number;
  /** 0–100, rounded to one decimal. 100 when there's nothing to pack. */
  percent: number;
}

function percentOf(packed: number, total: number): number {
  if (total === 0) return 100;
  return Math.round((packed / total) * 1000) / 10;
}

export function allItems(list: Pick<PackingList, 'sections'>): PackingItem[] {
  return list.sections.flatMap(s => s.items);
}

/**
 * Per-bag packing progress plus an overall total — the header table from the
 * spreadsheet this replaces. Bags with no items are omitted; unassigned items
 * are grouped under a "None" row so nothing is silently excluded from the
 * total.
 */
export function bagProgress(list: Pick<PackingList, 'bags' | 'sections'>): {
  bags: BagProgress[];
  total: BagProgress;
} {
  const items = allItems(list);
  const counts = new Map<string, { packed: number; total: number }>();
  for (const item of items) {
    const key = item.bag_id ?? NONE_BAG_ID;
    const entry = counts.get(key) ?? { packed: 0, total: 0 };
    entry.total += 1;
    if (item.checked) entry.packed += 1;
    counts.set(key, entry);
  }

  const bags: BagProgress[] = [];
  for (const bag of [...list.bags].sort((a, b) => a.position - b.position)) {
    const c = counts.get(bag.id);
    if (!c) continue;
    bags.push({ id: bag.id, name: bag.name, packed: c.packed, total: c.total, percent: percentOf(c.packed, c.total) });
  }
  const none = counts.get(NONE_BAG_ID);
  if (none) {
    bags.push({ id: NONE_BAG_ID, name: 'None', packed: none.packed, total: none.total, percent: percentOf(none.packed, none.total) });
  }

  const packed = items.filter(i => i.checked).length;
  return {
    bags,
    total: { id: '__total__', name: 'Total', packed, total: items.length, percent: percentOf(packed, items.length) },
  };
}

/** Unchecked items keep their arranged order; checked ones sink to the bottom
 *  of the section without losing their slot (see docs/packing-lists.md). */
export function orderSectionItems(items: PackingItem[]): PackingItem[] {
  return [...items].sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? 1 : -1;
    return a.position - b.position;
  });
}

/** The rows a section actually renders, honoring the show-checked setting and
 *  the alphabetical sort option. */
export function visibleSectionItems(
  section: Pick<PackingSection, 'items'>,
  opts: { showChecked: boolean; sortBy: 'manual' | 'alphabetical' },
): PackingItem[] {
  const base = opts.showChecked ? section.items : section.items.filter(i => !i.checked);
  if (opts.sortBy === 'alphabetical') {
    return [...base].sort((a, b) => {
      if (a.checked !== b.checked) return a.checked ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }
  return orderSectionItems(base);
}
