import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import App from '../App';

// Mock all the dependencies
vi.mock('../components/CalendarView', () => ({
  CalendarView: vi.fn(({ onTodayRefReady }) => {
    return (
      <div data-testid="calendar-view">
        <div 
          data-testid="today-element"
          ref={(el) => onTodayRefReady && onTodayRefReady(el)}
        >
          Today
        </div>
      </div>
    );
  })
}));

vi.mock('../components/MealIdeasPanel', () => ({
  MealIdeasPanel: vi.fn(({ onSchedule }) => (
    <button
      data-testid="schedule-meal"
      onClick={() => onSchedule?.('Pasta Night', '2026-02-05')}
    >
      Schedule Meal
    </button>
  )),
}));

vi.mock('../components/PantryPanel', () => ({
  PantryPanel: vi.fn(() => <div data-testid="pantry-panel" />),
}));

vi.mock('../components/StatusBar', () => ({
  StatusBar: vi.fn(({ status, pendingCount }) => (
    <div data-testid="status-bar">
      Status: {status}, Pending: {pendingCount}
    </div>
  ))
}));

vi.mock('../components/SettingsModal', () => ({
  SettingsModal: vi.fn(({ onClose, onToggleDarkMode }) => (
    <div data-testid="settings-modal">
      <button data-testid="toggle-dark-mode" onClick={onToggleDarkMode}>Toggle Dark Mode</button>
      <button data-testid="close-settings" onClick={onClose}>Close</button>
    </div>
  ))
}));

vi.mock('../hooks/useSync', () => ({
  useSync: vi.fn(() => ({ status: 'online', pendingCount: 0 }))
}));

vi.mock('../hooks/useDarkMode', () => ({
  useDarkMode: vi.fn(() => ({ isDark: false, toggle: vi.fn() }))
}));

vi.mock('../hooks/useSettings', () => ({
  useSettings: vi.fn(() => ({ 
    settings: { showItemizedColumn: true, showPantry: true, showMealIdeas: true, compactView: false, textScaleStandard: 1, textScaleCompact: 1 }, 
    updateSettings: vi.fn() 
  }))
}));

vi.mock('../hooks/useRealtime', () => ({
  useRealtime: vi.fn(),
}));

vi.mock('../hooks/useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('../authEvents', () => ({
  onAuthFailure: vi.fn(() => vi.fn()), // returns cleanup function
  emitAuthFailure: vi.fn(),
  AUTH_FAILURE_EVENT: 'meal-planner-auth-failure',
}));

vi.mock('../api/client', () => ({
  getCurrentUser: vi.fn(),
  logout: vi.fn(),
  getLoginUrl: vi.fn(() => '/api/auth/login'),
  getDays: vi.fn(),
  updateNotes: vi.fn(),
  getPantryItems: vi.fn(() => Promise.resolve([])),
  getMealIdeas: vi.fn(() => Promise.resolve([])),
  createPantryItem: vi.fn(),
  updatePantryItem: vi.fn(),
  deletePantryItem: vi.fn(),
  createMealIdea: vi.fn(),
  updateMealIdea: vi.fn(),
  deleteMealIdea: vi.fn(),
}));

vi.mock('../db', () => ({
  generateTempId: vi.fn(() => `temp-${Date.now()}`),
  isTempId: vi.fn((id: string) => id.startsWith('temp-')),
  queueChange: vi.fn(),
  getLocalNote: vi.fn(() => Promise.resolve(null)),
  saveLocalNote: vi.fn(() => Promise.resolve()),
  saveLocalPantryItem: vi.fn(() => Promise.resolve()),
  getLocalPantryItems: vi.fn(() => Promise.resolve([])),
  deleteLocalPantryItem: vi.fn(() => Promise.resolve()),
  clearLocalPantryItems: vi.fn(() => Promise.resolve()),
  saveLocalMealIdea: vi.fn(() => Promise.resolve()),
  getLocalMealIdeas: vi.fn(() => Promise.resolve([])),
  deleteLocalMealIdea: vi.fn(() => Promise.resolve()),
  clearLocalMealIdeas: vi.fn(() => Promise.resolve()),
}));

vi.mock('../utils/scroll', () => ({
  scrollToElementWithOffset: vi.fn(),
}));

// Mock intersection observer
const mockIntersectionObserver = vi.fn();
mockIntersectionObserver.mockReturnValue({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
});
window.IntersectionObserver = mockIntersectionObserver;

import { useSync } from '../hooks/useSync';
import { useDarkMode } from '../hooks/useDarkMode';
import { useSettings } from '../hooks/useSettings';
import { getCurrentUser, logout } from '../api/client';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { getDays, updateNotes } from '../api/client';
import { queueChange, getLocalNote, saveLocalNote } from '../db';
import { scrollToElementWithOffset } from '../utils/scroll';

describe('App', () => {
  const mockUseSync = vi.mocked(useSync);
  const mockUseDarkMode = vi.mocked(useDarkMode);
  const mockUseSettings = vi.mocked(useSettings);
  const mockGetCurrentUser = vi.mocked(getCurrentUser);
  const mockLogout = vi.mocked(logout);
  const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
  const mockGetDays = vi.mocked(getDays);
  const mockUpdateNotes = vi.mocked(updateNotes);
  const mockQueueChange = vi.mocked(queueChange);
  const mockGetLocalNote = vi.mocked(getLocalNote);
  const mockSaveLocalNote = vi.mocked(saveLocalNote);
  const mockScrollToElementWithOffset = vi.mocked(scrollToElementWithOffset);

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockUseSync.mockReturnValue({ status: 'online', pendingCount: 0 });
    
    const mockToggle = vi.fn();
    mockUseDarkMode.mockReturnValue({ isDark: false, toggle: mockToggle });
    
    const mockUpdateSettings = vi.fn();
    mockUseSettings.mockReturnValue({ 
      settings: { showItemizedColumn: true, showPantry: true, showMealIdeas: true, compactView: false, textScaleStandard: 1, textScaleCompact: 1 }, 
      updateSettings: mockUpdateSettings 
    });
    mockUseOnlineStatus.mockReturnValue(true);
  });

  it('should render loading state initially', () => {
    mockGetCurrentUser.mockImplementation(() => new Promise(() => {})); // Never resolves

    render(<App />);

    expect(screen.getByTestId('app-loading')).toBeInTheDocument();
  });

  it('should render login screen when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue({ status: 'auth-failed' });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/meal planner/i)).toBeInTheDocument();
      expect(screen.getByText(/sign in/i)).toBeInTheDocument();
    });
  });

  it('should render main app when authenticated', async () => {
    const mockUser = {
      id: '123',
      name: 'Test User',
      email: 'test@example.com'
    };

    mockGetCurrentUser.mockResolvedValue({ status: 'authenticated', user: mockUser });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('calendar-view')).toBeInTheDocument();
      expect(screen.getByTestId('status-bar')).toBeInTheDocument();
    });
  });

  it('should handle logout', async () => {
    const mockUser = {
      id: '123',
      name: 'Test User',
      email: 'test@example.com'
    };

    mockGetCurrentUser.mockResolvedValue({ status: 'authenticated', user: mockUser });
    mockLogout.mockResolvedValue(undefined);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('calendar-view')).toBeInTheDocument();
    });

    // Click logout button
    const logoutButton = screen.getByText(/logout/i);
    fireEvent.click(logoutButton);

    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalled();
      expect(screen.getByText(/sign in/i)).toBeInTheDocument();
    });
  });

  it('should toggle settings modal', async () => {
    const mockUser = {
      id: '123',
      name: 'Test User',
      email: 'test@example.com'
    };

    mockGetCurrentUser.mockResolvedValue({ status: 'authenticated', user: mockUser });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('calendar-view')).toBeInTheDocument();
    });

    // Open settings
    fireEvent.click(screen.getByLabelText('Settings'));

    await waitFor(() => {
      expect(screen.getByTestId('settings-modal')).toBeInTheDocument();
    });

    // Close settings
    const closeButton = screen.getByTestId('close-settings');
    fireEvent.click(closeButton);

    expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument();
  });

  it('should show jump to today button when today is not visible', async () => {
    const mockUser = {
      id: '123',
      name: 'Test User',
      email: 'test@example.com'
    };

    mockGetCurrentUser.mockResolvedValue({ status: 'authenticated', user: mockUser });

    // Mock intersection observer to report today as not intersecting
    mockIntersectionObserver.mockImplementation((callback) => ({
      observe: vi.fn((element) => {
        // Simulate today element going out of view
        setTimeout(() => {
          callback([{ isIntersecting: false }]);
        }, 100);
      }),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('calendar-view')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Jump to today')).toBeInTheDocument();
    });
  });

  it('should handle auth check errors gracefully', async () => {
    // Network error with no cached user — shows login
    mockGetCurrentUser.mockResolvedValue({ status: 'network-error' });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/sign in/i)).toBeInTheDocument();
    });
  });

  it('should pass correct props to child components', async () => {
    const mockUser = {
      id: '123',
      name: 'Test User',
      email: 'test@example.com'
    };

    mockGetCurrentUser.mockResolvedValue({ status: 'authenticated', user: mockUser });
    
    mockUseSync.mockReturnValue({ status: 'syncing', pendingCount: 5 });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Status: syncing, Pending: 5')).toBeInTheDocument();
    });
  });

  it('should toggle dark mode from settings', async () => {
    const mockUser = {
      id: '123',
      name: 'Test User',
      email: 'test@example.com'
    };

    const mockToggle = vi.fn();
    mockUseDarkMode.mockReturnValue({ isDark: false, toggle: mockToggle });
    mockGetCurrentUser.mockResolvedValue({ status: 'authenticated', user: mockUser });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('calendar-view')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Settings'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-modal')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-dark-mode'));

    expect(mockToggle).toHaveBeenCalled();
  });

  it('uses cached user when network error', async () => {
    const cachedUser = { id: '999', name: 'Cached User', email: 'cached@example.com' };
    localStorage.getItem = vi.fn(() => JSON.stringify(cachedUser));
    mockGetCurrentUser.mockResolvedValue({ status: 'network-error' });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('calendar-view')).toBeInTheDocument();
      expect(screen.getByText('Cached User')).toBeInTheDocument();
    });
  });

  it('shows login when auth failed even with cached user', async () => {
    // Previously this would use the cached user and show the app.
    // Now auth-failed should force re-login regardless of cache.
    localStorage.setItem('meal-planner-user', JSON.stringify({ id: '999', name: 'Cached User', email: 'cached@example.com' }));
    mockGetCurrentUser.mockResolvedValue({ status: 'auth-failed' });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/sign in/i)).toBeInTheDocument();
    });
    // Should NOT show the cached user's name — login screen instead
    expect(screen.queryByText('Cached User')).not.toBeInTheDocument();
  });

  it('schedules a meal online and updates notes', async () => {
    const mockUser = { id: '123', name: 'Test User', email: 'test@example.com' };
    mockGetCurrentUser.mockResolvedValue({ status: 'authenticated', user: mockUser });
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetDays.mockResolvedValue([
      {
        date: '2026-02-05',
        meal_note: {
          id: 'note-1',
          date: '2026-02-05',
          notes: 'Breakfast',
          items: [],
          updated_at: '2026-02-05T00:00:00Z',
        },
        events: [],
      },
    ]);
    mockUpdateNotes.mockResolvedValue({
      id: 'note-1',
      date: '2026-02-05',
      notes: 'Breakfast\nPasta Night',
      items: [],
      updated_at: '2026-02-05T00:00:00Z',
    });

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('calendar-view')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('schedule-meal'));

    await waitFor(() => {
      expect(mockGetDays).toHaveBeenCalledWith('2026-02-05', '2026-02-05');
      expect(mockUpdateNotes).toHaveBeenCalledWith('2026-02-05', 'Breakfast\nPasta Night');
      expect(dispatchSpy).toHaveBeenCalled();
    });
  });

  it('schedules a meal offline and queues changes', async () => {
    const mockUser = { id: '123', name: 'Test User', email: 'test@example.com' };
    mockGetCurrentUser.mockResolvedValue({ status: 'authenticated', user: mockUser });
    mockUseOnlineStatus.mockReturnValue(false);
    mockGetLocalNote.mockResolvedValue({
      id: 'note-2',
      date: '2026-02-05',
      notes: 'Lunch',
      items: [],
      updated_at: '2026-02-05T00:00:00Z',
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('calendar-view')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('schedule-meal'));

    await waitFor(() => {
      expect(mockSaveLocalNote).toHaveBeenCalledWith('2026-02-05', 'Lunch\nPasta Night', []);
      expect(mockQueueChange).toHaveBeenCalledWith('notes', '2026-02-05', { notes: 'Lunch\nPasta Night' });
    });
  });

  it('scrolls to pantry and today when buttons are clicked', async () => {
    const mockUser = { id: '123', name: 'Test User', email: 'test@example.com' };
    mockGetCurrentUser.mockResolvedValue({ status: 'authenticated', user: mockUser });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('calendar-view')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Jump to pantry'));
    fireEvent.click(screen.getByLabelText('Jump to today'));

    expect(mockScrollToElementWithOffset).toHaveBeenCalled();
  });
});
