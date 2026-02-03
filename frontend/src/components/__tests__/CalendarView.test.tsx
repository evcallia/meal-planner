import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CalendarView } from '../CalendarView';

vi.mock('../../api/client', () => ({
  getDays: vi.fn(),
  getEvents: vi.fn(),
  updateNotes: vi.fn(),
  toggleItemized: vi.fn(),
}));

vi.mock('../../db', () => ({
  saveLocalNote: vi.fn(),
  queueChange: vi.fn(),
}));

vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('../DayCard', () => ({
  DayCard: vi.fn(({ day, onNotesChange, onToggleItemized }) => (
    <div data-testid={`day-card-${day.date}`} data-date={day.date}>
      <span>{day.date}</span>
      {day.meal_note && (
        <span data-testid={`meal-notes-${day.date}`}>{day.meal_note.notes}</span>
      )}
      {day.events && day.events.length > 0 && (
        <span data-testid={`events-count-${day.date}`}>{day.events.length} events</span>
      )}
      <button
        data-testid={`update-notes-${day.date}`}
        onClick={() => onNotesChange?.('Updated notes')}
      >
        Update Notes
      </button>
      <button
        data-testid={`toggle-item-${day.date}`}
        onClick={() => onToggleItemized?.(0, true)}
      >
        Toggle Item
      </button>
    </div>
  )),
}));

import { getDays, getEvents, updateNotes, toggleItemized } from '../../api/client';
import { saveLocalNote, queueChange } from '../../db';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

const formatDate = (date: Date): string => date.toISOString().split('T')[0];
const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const today = new Date();
const todayStr = formatDate(today);
const day2Str = formatDate(addDays(today, 1));
const day3Str = formatDate(addDays(today, 2));

const mockDays = [
  {
    date: todayStr,
    meal_note: {
      id: '1',
      date: todayStr,
      notes: 'Breakfast notes',
      items: [],
      updated_at: '2024-01-01T00:00:00Z',
    },
    events: [],
  },
  {
    date: day2Str,
    meal_note: null,
    events: [],
  },
  {
    date: day3Str,
    meal_note: null,
    events: [],
  },
];

const mockEventsData = {
  [todayStr]: [
    {
      title: 'Morning Meeting',
      start_time: '2024-01-01T09:00:00Z',
      end_time: '2024-01-01T10:00:00Z',
      all_day: false,
    },
  ],
};

const mockOnTodayRefReady = vi.fn();

const mockGetDays = vi.mocked(getDays);
const mockGetEvents = vi.mocked(getEvents);
const mockUpdateNotes = vi.mocked(updateNotes);
const mockToggleItemized = vi.mocked(toggleItemized);
const mockSaveLocalNote = vi.mocked(saveLocalNote);
const mockQueueChange = vi.mocked(queueChange);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);

describe('CalendarView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetDays.mockResolvedValue(mockDays);
    mockGetEvents.mockResolvedValue(mockEventsData);
    mockUpdateNotes.mockResolvedValue({
      id: '1',
      date: todayStr,
      notes: 'Updated notes',
      items: [],
      updated_at: '2024-01-01T00:00:00Z',
    });
    mockToggleItemized.mockResolvedValue({
      line_index: 0,
      itemized: true,
    });
  });

  it('should render loading state initially', () => {
    mockGetDays.mockImplementationOnce(() => new Promise(() => {}));

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    expect(screen.getByTestId('calendar-loading')).toBeInTheDocument();
  });

  it('should render days after loading', async () => {
    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    expect(screen.getByText(todayStr)).toBeInTheDocument();
    expect(screen.getByTestId(`meal-notes-${todayStr}`)).toHaveTextContent('Breakfast notes');
  });

  it('should load previous week when button is clicked', async () => {
    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Load previous week'));

    await waitFor(() => {
      expect(mockGetDays).toHaveBeenCalledTimes(2);
    });
  });

  it('should load events after initial load', async () => {
    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(mockGetDays).toHaveBeenCalled();
      expect(mockGetEvents).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId(`events-count-${todayStr}`)).toBeInTheDocument();
    });
  });

  it('should call onTodayRefReady when today element is ready', async () => {
    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(mockOnTodayRefReady).toHaveBeenCalled();
    });
  });

  it('should update notes when online', async () => {
    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`update-notes-${todayStr}`));

    await waitFor(() => {
      expect(mockUpdateNotes).toHaveBeenCalledWith(todayStr, 'Updated notes');
    });
  });

  it('should queue notes changes when offline', async () => {
    mockUseOnlineStatus.mockReturnValue(false);

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`update-notes-${todayStr}`));

    await waitFor(() => {
      expect(mockSaveLocalNote).toHaveBeenCalledWith(todayStr, 'Updated notes', []);
      expect(mockQueueChange).toHaveBeenCalledWith('notes', todayStr, { notes: 'Updated notes' });
    });

    expect(mockUpdateNotes).not.toHaveBeenCalled();
  });

  it('should toggle itemized status when online', async () => {
    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} showItemizedColumn={true} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`toggle-item-${todayStr}`));

    await waitFor(() => {
      expect(mockToggleItemized).toHaveBeenCalledWith(todayStr, 0, true);
    });
  });

  it('should queue itemized changes when offline', async () => {
    mockUseOnlineStatus.mockReturnValue(false);

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} showItemizedColumn={true} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`toggle-item-${todayStr}`));

    await waitFor(() => {
      expect(mockQueueChange).toHaveBeenCalledWith('itemized', todayStr, { lineIndex: 0, itemized: true });
    });

    expect(mockToggleItemized).not.toHaveBeenCalled();
  });

  it('should show/hide itemized column based on prop', async () => {
    const { rerender } = render(
      <CalendarView onTodayRefReady={mockOnTodayRefReady} showItemizedColumn={false} />
    );

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    rerender(
      <CalendarView onTodayRefReady={mockOnTodayRefReady} showItemizedColumn={true} />
    );

    expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
  });

  it('should handle notes update errors', async () => {
    mockUpdateNotes.mockRejectedValueOnce(new Error('Network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`update-notes-${todayStr}`));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to save notes:', expect.any(Error));
    });

    consoleSpy.mockRestore();
  });

  it('should handle toggle itemized errors', async () => {
    mockToggleItemized.mockRejectedValueOnce(new Error('Network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`toggle-item-${todayStr}`));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to toggle itemized:', expect.any(Error));
    });

    consoleSpy.mockRestore();
  });

  it('should handle API errors gracefully', async () => {
    mockGetDays.mockRejectedValueOnce(new Error('API Error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to load days:', expect.any(Error));
    });

    consoleSpy.mockRestore();
  });

  it('should handle events loading errors gracefully', async () => {
    mockGetEvents.mockRejectedValueOnce(new Error('Events API Error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to load events:', expect.any(Error));
    });

    consoleSpy.mockRestore();
  });
});
