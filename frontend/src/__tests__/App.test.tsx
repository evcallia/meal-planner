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

vi.mock('../components/StatusBar', () => ({
  StatusBar: vi.fn(({ status, pendingCount }) => (
    <div data-testid="status-bar">
      Status: {status}, Pending: {pendingCount}
    </div>
  ))
}));

vi.mock('../components/SettingsModal', () => ({
  SettingsModal: vi.fn(({ onClose }) => (
    <div data-testid="settings-modal">
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
    settings: { showItemizedColumn: true, showPantry: true, showMealIdeas: true }, 
    updateSettings: vi.fn() 
  }))
}));

vi.mock('../hooks/useRealtime', () => ({
  useRealtime: vi.fn(),
}));

vi.mock('../api/client', () => ({
  getCurrentUser: vi.fn(),
  logout: vi.fn(),
  getLoginUrl: vi.fn(() => '/api/auth/login'),
  getPantryItems: vi.fn(() => Promise.resolve([])),
  getMealIdeas: vi.fn(() => Promise.resolve([])),
  createPantryItem: vi.fn(),
  updatePantryItem: vi.fn(),
  deletePantryItem: vi.fn(),
  createMealIdea: vi.fn(),
  updateMealIdea: vi.fn(),
  deleteMealIdea: vi.fn(),
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

describe('App', () => {
  const mockUseSync = vi.mocked(useSync);
  const mockUseDarkMode = vi.mocked(useDarkMode);
  const mockUseSettings = vi.mocked(useSettings);
  const mockGetCurrentUser = vi.mocked(getCurrentUser);
  const mockLogout = vi.mocked(logout);

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockUseSync.mockReturnValue({ status: 'online', pendingCount: 0 });
    
    const mockToggle = vi.fn();
    mockUseDarkMode.mockReturnValue({ isDark: false, toggle: mockToggle });
    
    const mockUpdateSettings = vi.fn();
    mockUseSettings.mockReturnValue({ 
      settings: { showItemizedColumn: true, showPantry: true, showMealIdeas: true }, 
      updateSettings: mockUpdateSettings 
    });
  });

  it('should render loading state initially', () => {
    mockGetCurrentUser.mockImplementation(() => new Promise(() => {})); // Never resolves

    render(<App />);

    expect(screen.getByTestId('app-loading')).toBeInTheDocument();
  });

  it('should render login screen when not authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

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

    mockGetCurrentUser.mockResolvedValue(mockUser);

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

    mockGetCurrentUser.mockResolvedValue(mockUser);
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

    mockGetCurrentUser.mockResolvedValue(mockUser);

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

    mockGetCurrentUser.mockResolvedValue(mockUser);

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
    mockGetCurrentUser.mockRejectedValue(new Error('Auth check failed'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/sign in/i)).toBeInTheDocument();
      expect(consoleSpy).toHaveBeenCalledWith('Auth check failed:', expect.any(Error));
    });

    consoleSpy.mockRestore();
  });

  it('should pass correct props to child components', async () => {
    const mockUser = {
      id: '123',
      name: 'Test User',
      email: 'test@example.com'
    };

    mockGetCurrentUser.mockResolvedValue(mockUser);
    
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
    mockGetCurrentUser.mockResolvedValue(mockUser);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('calendar-view')).toBeInTheDocument();
    });

    // Open settings
    // Toggle dark mode from header button
    fireEvent.click(screen.getByLabelText('Toggle dark mode'));

    expect(mockToggle).toHaveBeenCalled();
  });
});
