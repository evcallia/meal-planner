import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SettingsModal } from '../SettingsModal';
import type { Settings } from '../../hooks/useSettings';
import type { RecipeKeeperStatus } from '../../api/client';

vi.mock('../../api/client', () => ({
  getCalendarCacheStatus: vi.fn(() => Promise.resolve({ is_refreshing: false, last_refresh: null })),
  refreshCalendarCache: vi.fn(() => Promise.resolve({ message: 'ok' })),
  getHiddenCalendarEvents: vi.fn(() => Promise.resolve([])),
  unhideCalendarEvent: vi.fn(() => Promise.resolve({ status: 'ok' })),
  sendTestPushNotification: vi.fn(() => Promise.resolve({ sent: 0, results: [] })),
  getRecipeKeeperLists: vi.fn(() => Promise.resolve([
    { id: 'list-1', name: 'Groceries' },
    { id: 'list-2', name: 'Party Supplies' },
  ])),
  selectRecipeKeeperList: vi.fn((listId: string) => Promise.resolve({
    enabled: true, last_sync: null, last_error: '', auth_failed: false, paused: false,
    selected_list_id: listId, selected_list_name: listId === 'list-2' ? 'Party Supplies' : 'Groceries',
  })),
  syncRecipeKeeperNow: vi.fn(() => Promise.resolve({
    enabled: true, last_sync: '2026-01-01T00:00:00Z', last_error: '', auth_failed: false, paused: false,
    selected_list_id: 'list-1', selected_list_name: 'Groceries',
  })),
  getRecipeKeeperStatus: vi.fn(() => Promise.resolve({
    enabled: true, last_sync: '2026-01-01T00:00:00Z', last_error: '', auth_failed: false, paused: false,
    selected_list_id: 'list-1', selected_list_name: 'Groceries', syncing: false,
  })),
  setRecipeKeeperPaused: vi.fn((paused: boolean) => Promise.resolve({
    enabled: true, last_sync: null, last_error: '', auth_failed: false, paused,
    selected_list_id: 'list-1', selected_list_name: 'Groceries',
  })),
}));

vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('../../db', () => ({
  getLocalHiddenEvents: vi.fn(() => Promise.resolve([])),
  saveLocalHiddenEvent: vi.fn(),
  saveLocalHiddenEvents: vi.fn(),
  clearLocalHiddenEvents: vi.fn(),
  deleteLocalHiddenEvent: vi.fn(),
  queueChange: vi.fn(),
  getPendingChanges: vi.fn(() => Promise.resolve([])),
  removePendingChange: vi.fn(),
  getCalendarCacheTimestamp: vi.fn(() => Promise.resolve(null)),
}));

import { getRecipeKeeperLists, getRecipeKeeperStatus, selectRecipeKeeperList, syncRecipeKeeperNow, setRecipeKeeperPaused } from '../../api/client';

const mockGetLists = vi.mocked(getRecipeKeeperLists);
const mockSelectList = vi.mocked(selectRecipeKeeperList);
const mockSyncNow = vi.mocked(syncRecipeKeeperNow);
const mockGetStatus = vi.mocked(getRecipeKeeperStatus);
const mockSetPaused = vi.mocked(setRecipeKeeperPaused);

const defaultSettings: Settings = {
  showItemizedColumn: true,
  showMealIdeas: true,
  compactView: false,
  textScaleStandard: 1,
  textScaleCompact: 1,
} as Settings;

const expandSections = () => {
  screen.getAllByTestId('settings-section-toggle').forEach(btn => fireEvent.click(btn));
};

const enabledStatus = (overrides: Partial<RecipeKeeperStatus> = {}): RecipeKeeperStatus => ({
  enabled: true,
  last_sync: null,
  last_error: '',
  auth_failed: false,
  paused: false,
  selected_list_id: '',
  selected_list_name: '',
  ...overrides,
});

describe('SettingsModal - Recipe Keeper section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when recipeKeeperStatus is not enabled', async () => {
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={{ enabled: false, last_sync: null, last_error: '', auth_failed: false, paused: false, selected_list_id: '', selected_list_name: '' }}
        onRecipeKeeperStatusChange={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expect(screen.queryByText('Recipe Keeper')).not.toBeInTheDocument();
  });

  it('renders nothing when recipeKeeperStatus is absent', async () => {
    render(
      <SettingsModal settings={defaultSettings} onUpdate={vi.fn()} onClose={vi.fn()} isDark={false} onToggleDarkMode={vi.fn()} />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expect(screen.queryByText('Recipe Keeper')).not.toBeInTheDocument();
  });

  it('shows the list picker populated from GET /lists, with names not ids', async () => {
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={enabledStatus({ selected_list_id: 'list-1', selected_list_name: 'Groceries' })}
        onRecipeKeeperStatusChange={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();
    expect(screen.getByText('Recipe Keeper')).toBeInTheDocument();

    await waitFor(() => expect(mockGetLists).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Party Supplies')).toBeInTheDocument());
    expect(screen.queryByText('list-1')).not.toBeInTheDocument();
    expect(screen.queryByText('list-2')).not.toBeInTheDocument();
  });

  it('first-ever selection calls PUT /list with the chosen id, no warning', async () => {
    const onStatusChange = vi.fn();
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={enabledStatus()} // no list selected yet
        onRecipeKeeperStatusChange={onStatusChange}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();
    await waitFor(() => expect(mockGetLists).toHaveBeenCalled());

    const select = await screen.findByLabelText('Recipe Keeper shopping list');
    await act(async () => {
      fireEvent.change(select, { target: { value: 'list-1' } });
      await Promise.resolve();
    });

    expect(mockSelectList).toHaveBeenCalledWith('list-1');
    expect(screen.queryByText(/re-imports everything/)).not.toBeInTheDocument();
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ selected_list_id: 'list-1' })));
  });

  it('switching an already-selected list warns before calling PUT /list', async () => {
    const onStatusChange = vi.fn();
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={enabledStatus({ selected_list_id: 'list-1', selected_list_name: 'Groceries' })}
        onRecipeKeeperStatusChange={onStatusChange}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();
    await waitFor(() => expect(mockGetLists).toHaveBeenCalled());

    const select = await screen.findByLabelText('Recipe Keeper shopping list');
    fireEvent.change(select, { target: { value: 'list-2' } });

    // Warned, not yet switched.
    expect(screen.getByText(/re-imports everything/)).toBeInTheDocument();
    expect(mockSelectList).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText('Switch anyway'));
      await Promise.resolve();
    });

    expect(mockSelectList).toHaveBeenCalledWith('list-2');
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ selected_list_id: 'list-2' })));
  });

  it('"Sync now" calls POST /sync and applies the returned status', async () => {
    const onStatusChange = vi.fn();
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={enabledStatus({ selected_list_id: 'list-1', selected_list_name: 'Groceries' })}
        onRecipeKeeperStatusChange={onStatusChange}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();
    await waitFor(() => expect(mockGetLists).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByText('Sync now'));
      await Promise.resolve();
    });

    expect(mockSyncNow).toHaveBeenCalled();
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ last_sync: '2026-01-01T00:00:00Z' })));
  });

  // POST /sync answers 202 as soon as the drain is KICKED, never when it
  // finishes — a full drain runs ~14s, far past fetchAPI's 5s abort, which
  // is exactly why blocking on it could never work. So the button has to
  // keep watching the status until the drain clears and then report what it
  // recorded, rather than treating the 202 as the outcome.
  it('"Sync now" waits for the kicked drain to finish and surfaces its error', async () => {
    mockSyncNow.mockResolvedValueOnce({
      enabled: true, last_sync: null, last_error: '', auth_failed: false, paused: false,
      selected_list_id: 'list-1', selected_list_name: 'Groceries', syncing: true,
    });
    mockGetStatus.mockResolvedValueOnce({
      enabled: true, last_sync: null, last_error: '', auth_failed: false, paused: false,
      selected_list_id: 'list-1', selected_list_name: 'Groceries', syncing: true,
    });
    mockGetStatus.mockResolvedValueOnce({
      enabled: true, last_sync: '2026-02-02T00:00:00Z', last_error: 'upstream exploded',
      auth_failed: false, paused: false,
      selected_list_id: 'list-1', selected_list_name: 'Groceries', syncing: false,
    });
    const onStatusChange = vi.fn();
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={enabledStatus({ selected_list_id: 'list-1', selected_list_name: 'Groceries' })}
        onRecipeKeeperStatusChange={onStatusChange}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();
    await waitFor(() => expect(mockGetLists).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByText('Sync now'));
      await Promise.resolve();
    });

    // Two polls: the drain was still running on the first.
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ last_sync: '2026-02-02T00:00:00Z' })));
    await waitFor(() => expect(screen.getByText(/upstream exploded/)).toBeInTheDocument());
  });

  it('calls the refresh callback when "Sync now" fails, so the status does not sit stale', async () => {
    mockSyncNow.mockRejectedValueOnce(new Error('API error: 502'));
    const onStatusChange = vi.fn();
    const onRefresh = vi.fn();
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={enabledStatus({ selected_list_id: 'list-1', selected_list_name: 'Groceries' })}
        onRecipeKeeperStatusChange={onStatusChange}
        onRefreshRecipeKeeperStatus={onRefresh}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();
    await waitFor(() => expect(mockGetLists).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByText('Sync now'));
      await Promise.resolve();
    });

    expect(mockSyncNow).toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalled();
  });

  it('shows the last error and auth-failed state', async () => {
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={enabledStatus({ auth_failed: true, last_error: 'bad password' })}
        onRecipeKeeperStatusChange={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();
    expect(screen.getByText(/Sign-in failed/)).toBeInTheDocument();
  });

  it('the pause toggle reflects the current paused state', async () => {
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={enabledStatus({ paused: true, selected_list_id: 'list-1', selected_list_name: 'Groceries' })}
        onRecipeKeeperStatusChange={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();

    const toggle = screen.getByRole('switch', { name: /pause sync/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    // The paused state must be visible even before reading the toggle
    // itself — the section title and a dedicated status line both call it
    // out, so someone glancing mid-shop can tell instantly.
    expect(screen.getByText('Recipe Keeper — Paused')).toBeInTheDocument();
    expect(screen.getByText(/Sync is paused\. Resume/)).toBeInTheDocument();
  });

  it('toggling pause on calls PUT /paused with true and applies the returned status', async () => {
    const onStatusChange = vi.fn();
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={enabledStatus({ paused: false, selected_list_id: 'list-1', selected_list_name: 'Groceries' })}
        onRecipeKeeperStatusChange={onStatusChange}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();

    const toggle = screen.getByRole('switch', { name: /pause sync/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });

    expect(mockSetPaused).toHaveBeenCalledWith(true);
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ paused: true })));
  });

  it('toggling pause off calls PUT /paused with false', async () => {
    const onStatusChange = vi.fn();
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={enabledStatus({ paused: true, selected_list_id: 'list-1', selected_list_name: 'Groceries' })}
        onRecipeKeeperStatusChange={onStatusChange}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();

    const toggle = screen.getByRole('switch', { name: /pause sync/i });
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });

    expect(mockSetPaused).toHaveBeenCalledWith(false);
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ paused: false })));
  });

  it('"Sync now" is disabled while paused', async () => {
    render(
      <SettingsModal
        settings={defaultSettings}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
        isDark={false}
        onToggleDarkMode={vi.fn()}
        recipeKeeperStatus={enabledStatus({ paused: true, selected_list_id: 'list-1', selected_list_name: 'Groceries' })}
        onRecipeKeeperStatusChange={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();

    const button = screen.getByText('Paused').closest('button');
    expect(button).toBeDisabled();
    if (button) fireEvent.click(button);
    expect(mockSyncNow).not.toHaveBeenCalled();
  });
});
