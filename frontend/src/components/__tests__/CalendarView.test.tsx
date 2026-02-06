import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { CalendarView } from '../CalendarView';

vi.mock('../../api/client', () => ({
  getDays: vi.fn(),
  getEvents: vi.fn(),
  updateNotes: vi.fn(),
  toggleItemized: vi.fn(),
  hideCalendarEvent: vi.fn(),
}));

vi.mock('../../db', () => ({
  saveLocalNote: vi.fn(),
  queueChange: vi.fn(),
  getLocalNotesForRange: vi.fn(() => Promise.resolve([])),
  saveLocalCalendarEvents: vi.fn(),
  getLocalCalendarEventsForRange: vi.fn(() => Promise.resolve({})),
  getLocalHiddenEvents: vi.fn(() => Promise.resolve([])),
  saveLocalHiddenEvent: vi.fn(),
  deleteLocalHiddenEvent: vi.fn(),
  generateTempId: vi.fn(() => 'temp-hidden'),
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

import { getDays, getEvents, updateNotes, toggleItemized, hideCalendarEvent } from '../../api/client';
import { saveLocalNote, queueChange, getLocalCalendarEventsForRange, getLocalHiddenEvents } from '../../db';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { DayCard } from '../DayCard';

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
      id: 'event-1',
      uid: 'uid-1',
      calendar_name: 'Primary',
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
const mockHideCalendarEvent = vi.mocked(hideCalendarEvent);
const mockSaveLocalNote = vi.mocked(saveLocalNote);
const mockQueueChange = vi.mocked(queueChange);
const mockGetLocalCalendarEventsForRange = vi.mocked(getLocalCalendarEventsForRange);
const mockGetLocalHiddenEvents = vi.mocked(getLocalHiddenEvents);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
const mockDayCard = vi.mocked(DayCard);

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
    mockHideCalendarEvent.mockResolvedValue({} as any);
    mockGetLocalCalendarEventsForRange.mockResolvedValue({});
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
    const prevDays = [
      {
        date: formatDate(addDays(today, -7)),
        meal_note: null,
        events: [],
      },
    ];
    mockGetDays.mockResolvedValueOnce(mockDays).mockResolvedValueOnce(prevDays);

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
      expect(consoleSpy).toHaveBeenCalledWith('Failed to load days from API, trying local cache:', expect.any(Error));
    });

    consoleSpy.mockRestore();
  });

  it('should handle events loading errors gracefully', async () => {
    mockGetEvents.mockRejectedValueOnce(new Error('Events API Error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Failed to load events from API, trying local cache:', expect.any(Error));
    });

    consoleSpy.mockRestore();
  });

  it('updates notes when receiving external events', async () => {
    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-notes-updated', {
        detail: { date: todayStr, notes: 'Dinner notes' },
      }));
    });

    await waitFor(() => {
      expect(screen.getByTestId(`meal-notes-${todayStr}`)).toHaveTextContent('Dinner notes');
    });
  });

  it('handles realtime updates for notes and events', async () => {
    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', {
        detail: {
          type: 'notes.updated',
          payload: {
            date: todayStr,
            meal_note: {
              id: '1',
              date: todayStr,
              notes: 'Realtime notes',
              items: [],
              updated_at: '2024-01-01T00:00:00Z',
            },
          },
        },
      }));
    });

    await waitFor(() => {
      expect(screen.getByTestId(`meal-notes-${todayStr}`)).toHaveTextContent('Realtime notes');
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', {
        detail: {
          type: 'calendar.refreshed',
          payload: {
            events_by_date: {
              [todayStr]: [
                { id: 'event-a', uid: 'uid-a', calendar_name: 'Primary', title: 'Event A', start_time: '2024-01-01T10:00:00Z', end_time: '2024-01-01T11:00:00Z', all_day: false },
                { id: 'event-b', uid: 'uid-b', calendar_name: 'Primary', title: 'Event B', start_time: '2024-01-01T12:00:00Z', end_time: '2024-01-01T13:00:00Z', all_day: false },
              ],
            },
          },
        },
      }));
    });

    await waitFor(() => {
      expect(screen.getByTestId(`events-count-${todayStr}`)).toHaveTextContent('2 events');
    });
  });

  it('updates itemized state from realtime events', async () => {
    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', {
        detail: {
          type: 'item.updated',
          payload: { date: todayStr, line_index: 2, itemized: true },
        },
      }));
    });

    await waitFor(() => {
      const calls = mockDayCard.mock.calls.filter(call => call[0].day.date === todayStr);
      const latest = calls[calls.length - 1]?.[0].day.meal_note?.items ?? [];
      expect(latest.some(item => item.line_index === 2 && item.itemized)).toBe(true);
    });
  });

  it('moves meals between days and updates itemized status', async () => {
    const sourceNotes = 'Breakfast<div>Lunch</div>';
    const customDays = [
      {
        date: todayStr,
        meal_note: {
          id: '1',
          date: todayStr,
          notes: sourceNotes,
          items: [{ line_index: 0, itemized: true }],
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
    mockGetDays.mockResolvedValueOnce(customDays);
    mockGetEvents.mockResolvedValueOnce({});
    mockUpdateNotes
      .mockResolvedValueOnce({
        id: '1',
        date: todayStr,
        notes: 'Lunch',
        items: [],
        updated_at: '2024-01-01T00:00:00Z',
      })
      .mockResolvedValueOnce({
        id: '2',
        date: day2Str,
        notes: 'Breakfast',
        items: [],
        updated_at: '2024-01-01T00:00:00Z',
      });

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    const targetCall = mockDayCard.mock.calls.find(call => call[0].day.date === day2Str);
    await act(async () => {
      await targetCall?.[0].onDrop?.(day2Str, todayStr, 0, 'Breakfast');
    });

    await waitFor(() => {
      expect(mockUpdateNotes).toHaveBeenCalledWith(todayStr, 'Lunch');
      expect(mockUpdateNotes).toHaveBeenCalledWith(day2Str, 'Breakfast');
      expect(mockToggleItemized).toHaveBeenCalledWith(day2Str, 0, true);
      expect(mockSaveLocalNote).toHaveBeenCalledWith(todayStr, 'Lunch', []);
      expect(mockSaveLocalNote).toHaveBeenCalledWith(day2Str, 'Breakfast', [{ line_index: 0, itemized: true }]);
    });
  });

  it('filters hidden events from the UI', async () => {
    mockGetLocalHiddenEvents.mockResolvedValue([
      {
        id: 'hidden-1',
        event_uid: 'uid-1',
        event_date: todayStr,
        calendar_name: 'Primary',
        title: 'Morning Meeting',
        start_time: '2024-01-01T09:00:00Z',
        end_time: null,
        all_day: false,
      },
    ])

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(mockGetEvents).toHaveBeenCalled();
    });

    expect(screen.queryByTestId(`events-count-${todayStr}`)).not.toBeInTheDocument();
  });

  it('loads events from IndexedDB when offline', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUseOnlineStatus.mockReturnValue(false);
    mockGetDays.mockRejectedValue(new Error('offline'));
    mockGetLocalCalendarEventsForRange.mockResolvedValue({
      [todayStr]: [
        {
          uid: 'offline-uid',
          calendar_name: 'Primary',
          title: 'Offline event',
          start_time: '2024-01-01T09:00:00Z',
          end_time: null,
          all_day: false,
        },
      ],
    });

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`events-count-${todayStr}`)).toBeInTheDocument();
    });

    expect(mockGetEvents).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('moves the last meal to another day and leaves source empty', async () => {
    const sourceNotes = 'OnlyOne';
    const customDays = [
      {
        date: todayStr,
        meal_note: {
          id: '1',
          date: todayStr,
          notes: sourceNotes,
          items: [],
          updated_at: '2024-01-01T00:00:00Z',
        },
        events: [],
      },
      {
        date: day2Str,
        meal_note: {
          id: '2',
          date: day2Str,
          notes: 'First',
          items: [],
          updated_at: '2024-01-01T00:00:00Z',
        },
        events: [],
      },
      {
        date: day3Str,
        meal_note: null,
        events: [],
      },
    ];
    mockGetDays.mockResolvedValueOnce(customDays);
    mockGetEvents.mockResolvedValueOnce({});
    mockUpdateNotes
      .mockResolvedValueOnce({
        id: '1',
        date: todayStr,
        notes: '',
        items: [],
        updated_at: '2024-01-01T00:00:00Z',
      })
      .mockResolvedValueOnce({
        id: '2',
        date: day2Str,
        notes: 'First<div>OnlyOne</div>',
        items: [],
        updated_at: '2024-01-01T00:00:00Z',
      });

    render(<CalendarView onTodayRefReady={mockOnTodayRefReady} />);

    await waitFor(() => {
      expect(screen.getByTestId(`day-card-${todayStr}`)).toBeInTheDocument();
    });

    const targetCall = mockDayCard.mock.calls.find(call => call[0].day.date === day2Str);
    await act(async () => {
      await targetCall?.[0].onDrop?.(day2Str, todayStr, 0, 'OnlyOne');
    });

    await waitFor(() => {
      expect(mockUpdateNotes).toHaveBeenCalledWith(todayStr, '');
      expect(mockUpdateNotes).toHaveBeenCalledWith(day2Str, 'First<div>OnlyOne</div>');
    });
  });
});
