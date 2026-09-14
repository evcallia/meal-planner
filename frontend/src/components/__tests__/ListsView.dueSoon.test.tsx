import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DueSoonPanel } from '../ListsView';
import type { TrackerTask, TrackerList } from '../../types';

// The Due Soon tab renders ONE header per group, with that group's tasks
// underneath it, and the groups in tab order.

const task = (id: string, name: string, listId: string): TrackerTask => ({
  id, list_id: listId, name, target_interval_days: 1, notes: null, position: 0,
  archived: false, last_done_at: null, last_event_at: null, last_done_by: null,
  last_note: null, total_count: 0, avg_interval_days: null, recent_logs: [],
  season_start_month: null, season_start_day: null, season_end_month: null,
  season_end_day: null, snooze_until: null,
} as unknown as TrackerTask);

const list = (id: string, name: string): TrackerList =>
  ({ id, name, color: 'blue', tasks: [] } as unknown as TrackerList);

const tracker = { markDone: vi.fn(), skipCycle: vi.fn(), deleteTask: vi.fn() } as never;

const renderPanel = (tasks: TrackerTask[], lists: TrackerList[]) =>
  render(<DueSoonPanel tasks={tasks} lists={lists} tracker={tracker} onOpenTask={vi.fn()} />);

describe('DueSoonPanel', () => {
  it('shows each group name once, not once per task', () => {
    renderPanel(
      [task('t1', 'Water plants', 'home'), task('t2', 'Vacuum', 'home')],
      [list('home', 'Home')],
    );
    expect(screen.getAllByText('Home')).toHaveLength(1);
  });

  it('groups tasks under their own header, in tab order', () => {
    renderPanel(
      [task('t1', 'Oil change', 'car'), task('t2', 'Water plants', 'home'), task('t3', 'Vacuum', 'home')],
      [list('home', 'Home'), list('car', 'Car')],
    );
    const groups = screen.getAllByTestId('due-soon-group');
    expect(groups.map(g => g.getAttribute('data-group-id'))).toEqual(['home', 'car']);
    expect(within(groups[0]).getByText('Water plants')).toBeInTheDocument();
    expect(within(groups[0]).getByText('Vacuum')).toBeInTheDocument();
    expect(within(groups[1]).getByText('Oil change')).toBeInTheDocument();
    // The Car task must NOT appear under Home.
    expect(within(groups[0]).queryByText('Oil change')).not.toBeInTheDocument();
  });

  it('follows a reordered tab strip', () => {
    renderPanel(
      [task('t1', 'Oil change', 'car'), task('t2', 'Water plants', 'home')],
      [list('car', 'Car'), list('home', 'Home')],
    );
    expect(screen.getAllByTestId('due-soon-group').map(g => g.getAttribute('data-group-id')))
      .toEqual(['car', 'home']);
  });

  it('still shows the all-caught-up message with nothing due', () => {
    renderPanel([], [list('home', 'Home')]);
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryAllByTestId('due-soon-group')).toHaveLength(0);
  });
});
