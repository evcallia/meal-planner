import { describe, it, expect } from 'vitest';
import { bagProgress, orderSectionItems, visibleSectionItems, NONE_BAG_ID } from '../packing';
import type { PackingItem, PackingList } from '../../types';

const item = (over: Partial<PackingItem>): PackingItem => ({
  id: 'i', section_id: 's', name: 'Item', quantity: null, checked: false,
  position: 0, bag_id: null, updated_at: '2026-01-01T00:00:00', ...over,
});

const list = (over: Partial<PackingList> = {}): PackingList => ({
  id: 'l1', name: 'Paris', icon: null, color: null, position: 0,
  owner_sub: 'me', owner_name: null, is_owner: true, shared_with: [],
  bags: [], sections: [], ...over,
});

describe('orderSectionItems', () => {
  it('sinks checked items below unchecked ones without touching position', () => {
    const items = [
      item({ id: 'a', name: 'Boots', position: 0, checked: true }),
      item({ id: 'b', name: 'Poles', position: 1 }),
      item({ id: 'c', name: 'Helmet', position: 2 }),
    ];
    expect(orderSectionItems(items).map(i => i.id)).toEqual(['b', 'c', 'a']);
    // Positions are the ordering key, never rewritten by the sort.
    expect(orderSectionItems(items).map(i => i.position)).toEqual([1, 2, 0]);
  });

  it('restores the original slot when an item is unchecked', () => {
    const items = [
      item({ id: 'a', position: 0, checked: true }),
      item({ id: 'b', position: 1 }),
      item({ id: 'c', position: 2 }),
    ];
    const unchecked = items.map(i => (i.id === 'a' ? { ...i, checked: false } : i));
    expect(orderSectionItems(unchecked).map(i => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('visibleSectionItems', () => {
  const section = {
    items: [
      item({ id: 'a', name: 'Zebra', position: 0 }),
      item({ id: 'b', name: 'Apple', position: 1, checked: true }),
      item({ id: 'c', name: 'Mango', position: 2 }),
    ],
  };

  it('hides packed items when showChecked is off', () => {
    const got = visibleSectionItems(section, { showChecked: false, sortBy: 'manual' });
    expect(got.map(i => i.id)).toEqual(['a', 'c']);
  });

  it('keeps packed items at the bottom when shown', () => {
    const got = visibleSectionItems(section, { showChecked: true, sortBy: 'manual' });
    expect(got.map(i => i.id)).toEqual(['a', 'c', 'b']);
  });

  it('sorts alphabetically but still keeps packed items last', () => {
    const got = visibleSectionItems(section, { showChecked: true, sortBy: 'alphabetical' });
    expect(got.map(i => i.name)).toEqual(['Mango', 'Zebra', 'Apple']);
  });
});

describe('bagProgress', () => {
  it('reports packed/total per bag plus an overall total', () => {
    const l = list({
      bags: [
        { id: 'bag1', list_id: 'l1', name: 'Carry On', position: 0 },
        { id: 'bag2', list_id: 'l1', name: 'Checked Bag', position: 1 },
      ],
      sections: [{
        id: 's1', list_id: 'l1', name: 'Clothes', position: 0,
        items: [
          item({ id: '1', bag_id: 'bag1', checked: true }),
          item({ id: '2', bag_id: 'bag1', checked: true }),
          item({ id: '3', bag_id: 'bag2' }),
          item({ id: '4', bag_id: 'bag2', checked: true }),
        ],
      }],
    });
    const { bags, total } = bagProgress(l);
    expect(bags).toEqual([
      { id: 'bag1', name: 'Carry On', packed: 2, total: 2, percent: 100 },
      { id: 'bag2', name: 'Checked Bag', packed: 1, total: 2, percent: 50 },
    ]);
    expect(total).toMatchObject({ packed: 3, total: 4, percent: 75 });
  });

  it('groups unassigned items under a None row so the total stays honest', () => {
    const l = list({
      bags: [{ id: 'bag1', list_id: 'l1', name: 'Carry On', position: 0 }],
      sections: [{
        id: 's1', list_id: 'l1', name: 'Clothes', position: 0,
        items: [item({ id: '1', bag_id: 'bag1' }), item({ id: '2' })],
      }],
    });
    const { bags, total } = bagProgress(l);
    expect(bags.map(b => b.id)).toEqual(['bag1', NONE_BAG_ID]);
    expect(total.total).toBe(2);
  });

  it('omits bags with no items and treats an empty list as complete', () => {
    const l = list({ bags: [{ id: 'bag1', list_id: 'l1', name: 'Unused', position: 0 }] });
    const { bags, total } = bagProgress(l);
    expect(bags).toEqual([]);
    expect(total).toMatchObject({ packed: 0, total: 0, percent: 100 });
  });
});
