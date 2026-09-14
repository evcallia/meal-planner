import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ListsView } from '../ListsView';
import type { TrackerList, UserInfo } from '../../types';

// A muted group is marked on its tab. A Tasks group has TWO mutes — edits and
// due reminders — and each only counts while its own global toggle is on.

let mockLists: TrackerList[] = [];

vi.mock('../../hooks/useTracker', () => ({
  useTracker: () => ({ lists: mockLists, loading: false, createList: vi.fn() }),
  computeStats: () => ({ total: 0, streak: 0, avg: null }),
}));
vi.mock('../../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));
vi.mock('../../api/client', () => ({ getUsers: () => Promise.resolve([]) }));

const user: UserInfo = { sub: 'me', email: 'me@example.com', name: 'Me' };

const listFixture = (id: string, name: string): TrackerList => ({
  id, name, icon: null, color: 'blue', position: 0,
  owner_sub: 'me', owner_name: null, is_owner: true, shared_with: [], tasks: [],
} as unknown as TrackerList);

const renderView = (props: Partial<React.ComponentProps<typeof ListsView>> = {}) =>
  render(<ListsView user={user} {...props} />);

const icons = () => screen.queryAllByTestId('muted-icon');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockLists = [listFixture('g1', 'Home')];
});

describe('ListsView muted indicator', () => {
  it('marks a group whose edit notifications are muted', () => {
    renderView({ notifyDefaults: { edits: true, due: true }, listNotifyOverrides: { g1: { edits: false } } });
    expect(icons()).toHaveLength(1);
    expect(icons()[0]).toHaveAccessibleName('Edit notifications muted');
  });

  it('marks a group whose due reminders are muted', () => {
    renderView({ notifyDefaults: { edits: true, due: true }, listNotifyOverrides: { g1: { due: false } } });
    expect(icons()[0]).toHaveAccessibleName('Due reminders muted');
  });

  it('names both when both are muted', () => {
    renderView({
      notifyDefaults: { edits: true, due: true },
      listNotifyOverrides: { g1: { edits: false, due: false } },
    });
    expect(icons()[0]).toHaveAccessibleName('Edits and due reminders muted');
  });

  it('ignores a mute whose global toggle is off', () => {
    // Edits globally off, so only the due mute is meaningful.
    renderView({
      notifyDefaults: { edits: false, due: true },
      listNotifyOverrides: { g1: { edits: false, due: false } },
    });
    expect(icons()[0]).toHaveAccessibleName('Due reminders muted');
  });

  it('shows nothing when both globals are off', () => {
    renderView({
      notifyDefaults: { edits: false, due: false },
      listNotifyOverrides: { g1: { edits: false, due: false } },
    });
    expect(icons()).toHaveLength(0);
  });

  it('shows nothing for an unmuted group', () => {
    renderView({ notifyDefaults: { edits: true, due: true }, listNotifyOverrides: {} });
    expect(icons()).toHaveLength(0);
  });

  // Due Soon is a synthetic tab, not a real group — it can never be muted.
  it('never marks the Due Soon tab, even with a stray override under its id', () => {
    renderView({
      notifyDefaults: { edits: true, due: true },
      listNotifyOverrides: { __due_soon__: { edits: false, due: false } },
    });
    expect(screen.getAllByText('Due Soon').length).toBeGreaterThan(0);
    expect(icons()).toHaveLength(0);
  });

  it('marks only the muted group when several exist', () => {
    mockLists = [listFixture('g1', 'Home'), listFixture('g2', 'Car')];
    renderView({ notifyDefaults: { edits: true, due: true }, listNotifyOverrides: { g2: { edits: false } } });
    expect(icons()).toHaveLength(1);
  });
});
