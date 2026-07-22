import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SettingsModal } from '../SettingsModal';
import type { Settings } from '../../hooks/useSettings';

vi.mock('../../api/client', () => ({
  getCalendarCacheStatus: vi.fn(() => Promise.resolve({ is_refreshing: false, last_refresh: '2026-01-01T00:00:00Z', cache_start: null, cache_end: null })),
  refreshCalendarCache: vi.fn(() => Promise.resolve({ message: 'ok' })),
  getHiddenCalendarEvents: vi.fn(() => Promise.resolve([])),
  unhideCalendarEvent: vi.fn(() => Promise.resolve({ status: 'ok' })),
  getCalendarList: vi.fn(() => Promise.resolve({ available: ['Work', 'Personal'], selected: ['Work'] })),
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
  getLocalGroceryItems: vi.fn(() => Promise.resolve([])),
  getLocalPantryItems: vi.fn(() => Promise.resolve([])),
  getLocalMealIdeas: vi.fn(() => Promise.resolve([])),
  getLocalGrocerySections: vi.fn(() => Promise.resolve([])),
  getLocalPantrySections: vi.fn(() => Promise.resolve([])),
}));

import { refreshCalendarCache, getHiddenCalendarEvents, unhideCalendarEvent } from '../../api/client';
import { getPendingChanges } from '../../db';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

const mockRefreshCalendarCache = vi.mocked(refreshCalendarCache);
const mockGetHiddenCalendarEvents = vi.mocked(getHiddenCalendarEvents);
const mockUnhideCalendarEvent = vi.mocked(unhideCalendarEvent);
const mockGetPendingChanges = vi.mocked(getPendingChanges);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);

const defaultSettings: Settings = {
  showItemizedColumn: true,
  showMealIdeas: true,
  compactView: false,
  textScaleStandard: 1,
  textScaleCompact: 1,
};

describe('SettingsModal - additional coverage', () => {
  const mockOnUpdate = vi.fn();
  const mockOnClose = vi.fn();
  const mockOnToggleDarkMode = vi.fn();

  const expandSections = () => {
    screen.getAllByTestId('settings-section-toggle').forEach(btn => fireEvent.click(btn));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseOnlineStatus.mockReturnValue(true);
  });

  it('renders settings modal with all toggles', async () => {
    render(
      <SettingsModal settings={defaultSettings} onUpdate={mockOnUpdate} onClose={mockOnClose} isDark={false} onToggleDarkMode={mockOnToggleDarkMode} />
    );
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
    expandSections();
    expect(screen.getByText('Dark Mode')).toBeInTheDocument();
  });

  it('toggling dark mode calls onToggleDarkMode', async () => {
    render(
      <SettingsModal settings={defaultSettings} onUpdate={mockOnUpdate} onClose={mockOnClose} isDark={false} onToggleDarkMode={mockOnToggleDarkMode} />
    );
    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
    expandSections();

    const darkModeToggle = screen.getByText('Dark Mode').closest('div')?.querySelector('button[role="switch"]');
    if (darkModeToggle) {
      fireEvent.click(darkModeToggle);
      expect(mockOnToggleDarkMode).toHaveBeenCalled();
    }
  });

  it('toggling showItemizedColumn calls onUpdate', async () => {
    await act(async () => {
      render(
        <SettingsModal settings={defaultSettings} onUpdate={mockOnUpdate} onClose={mockOnClose} isDark={false} onToggleDarkMode={mockOnToggleDarkMode} />
      );
      await Promise.resolve();
    });

    expandSections();
    const toggle = screen.getByRole('switch', { name: /show itemized column/i });
    fireEvent.click(toggle);
    expect(mockOnUpdate).toHaveBeenCalledWith({ showItemizedColumn: false });
  });

  it('toggling showMealIdeas calls onUpdate', async () => {
    await act(async () => {
      render(
        <SettingsModal settings={defaultSettings} onUpdate={mockOnUpdate} onClose={mockOnClose} isDark={false} onToggleDarkMode={mockOnToggleDarkMode} />
      );
      await Promise.resolve();
    });

    expandSections();
    const toggle = screen.getByRole('switch', { name: /show future meals/i });
    fireEvent.click(toggle);
    expect(mockOnUpdate).toHaveBeenCalledWith({ showMealIdeas: false });
  });

  it('toggling compactView calls onUpdate', async () => {
    await act(async () => {
      render(
        <SettingsModal settings={defaultSettings} onUpdate={mockOnUpdate} onClose={mockOnClose} isDark={false} onToggleDarkMode={mockOnToggleDarkMode} />
      );
      await Promise.resolve();
    });

    expandSections();
    const toggle = screen.getByRole('switch', { name: /compact view/i });
    fireEvent.click(toggle);
    expect(mockOnUpdate).toHaveBeenCalledWith({ compactView: true });
  });

  it('shows offline state properly', async () => {
    mockUseOnlineStatus.mockReturnValue(false);

    await act(async () => {
      render(
        <SettingsModal settings={defaultSettings} onUpdate={mockOnUpdate} onClose={mockOnClose} isDark={false} onToggleDarkMode={mockOnToggleDarkMode} />
      );
      await Promise.resolve();
    });

    expect(screen.getByText('Settings')).toBeInTheDocument();
  });
});

describe('Features section', () => {
  const baseProps = {
    onUpdate: vi.fn(),
    onClose: vi.fn(),
    isDark: false,
    onToggleDarkMode: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  const renderWith = async (settings: Partial<Settings>) => {
    await act(async () => {
      render(<SettingsModal settings={settings as Settings} {...baseProps} />);
      await Promise.resolve();
    });
    screen.getAllByTestId('settings-section-toggle').forEach(btn => fireEvent.click(btn));
  };

  it('toggles a feature off', async () => {
    await renderWith({ featureMeals: true, featurePantry: true, featureGrocery: true, featureLists: true });
    fireEvent.click(screen.getByRole('switch', { name: /pantry inventory/i }));
    expect(baseProps.onUpdate).toHaveBeenCalledWith({ featurePantry: false });
  });

  it('locks the last enabled feature', async () => {
    await renderWith({ featureMeals: true, featurePantry: false, featureGrocery: false, featureLists: false });
    const mealsToggle = screen.getByRole('switch', { name: /at least one tab must stay enabled/i });
    expect(mealsToggle).toBeDisabled();
    expect(screen.getByText('At least one tab must stay enabled')).toBeInTheDocument();
    // The off ones can still be turned on
    fireEvent.click(screen.getByRole('switch', { name: /shared grocery list/i }));
    expect(baseProps.onUpdate).toHaveBeenCalledWith({ featureGrocery: true });
  });
});
