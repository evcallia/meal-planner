import { describe, it, expect } from 'vitest';
import { groupTasksByList } from '../recency';
import type { TrackerTask, TrackerList } from '../../types';

// The Due Soon tab used to repeat the group name above every single row. It
// now emits one header per group, with each group's tasks contiguous and the
// groups themselves in TAB order — the order of the `lists` array.

const task = (id: string, listId: string): TrackerTask => ({
  id, list_id: listId, name: id, target_interval_days: 1, notes: null, position: 0,
  archived: false, last_done_at: null, last_event_at: null, last_done_by: null,
  last_note: null, total_count: 0, avg_interval_days: null, recent_logs: [],
  season_start_month: null, season_start_day: null, season_end_month: null,
  season_end_day: null, snooze_until: null,
} as unknown as TrackerTask);

const list = (id: string, name: string): TrackerList =>
  ({ id, name, color: 'blue' } as unknown as TrackerList);

describe('groupTasksByList', () => {
  it('orders groups by the lists array, not by task order', () => {
    // Tasks arrive interleaved and urgency-sorted; lists give the tab order.
    const tasks = [task('t1', 'car'), task('t2', 'home'), task('t3', 'car'), task('t4', 'garage')];
    const lists = [list('home', 'Home'), list('car', 'Car'), list('garage', 'Garage')];
    expect(groupTasksByList(tasks, lists).map(g => g.list.id)).toEqual(['home', 'car', 'garage']);
  });

  it('reflects a reordered tab strip', () => {
    const tasks = [task('t1', 'car'), task('t2', 'home')];
    const reordered = [list('car', 'Car'), list('home', 'Home')];
    expect(groupTasksByList(tasks, reordered).map(g => g.list.id)).toEqual(['car', 'home']);
  });

  it('keeps each group contiguous and preserves the incoming order within it', () => {
    // t1 before t3 in the input (more urgent) must stay that way inside Car.
    const tasks = [task('t1', 'car'), task('t2', 'home'), task('t3', 'car')];
    const lists = [list('home', 'Home'), list('car', 'Car')];
    const groups = groupTasksByList(tasks, lists);
    expect(groups.map(g => g.tasks.map(t => t.id))).toEqual([['t2'], ['t1', 't3']]);
  });

  it('omits groups with nothing due', () => {
    const tasks = [task('t1', 'home')];
    const lists = [list('home', 'Home'), list('car', 'Car')];
    expect(groupTasksByList(tasks, lists).map(g => g.list.id)).toEqual(['home']);
  });

  it('drops tasks whose group is gone rather than crashing', () => {
    const tasks = [task('t1', 'home'), task('t2', 'deleted-list')];
    const groups = groupTasksByList(tasks, [list('home', 'Home')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tasks.map(t => t.id)).toEqual(['t1']);
  });

  it('returns nothing when there is nothing due', () => {
    expect(groupTasksByList([], [list('home', 'Home')])).toEqual([]);
  });
});
