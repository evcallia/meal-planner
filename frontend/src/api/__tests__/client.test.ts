import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDays, getEvents, updateNotes, toggleItemized, getCurrentUser, logout, getLoginUrl } from '../client';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('API client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchAPI error handling', () => {
    it('should handle 401 unauthorized errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
      });

      await expect(getDays('2024-01-01', '2024-01-07')).rejects.toThrow('Unauthorized');
    });

    it('should handle other API errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(getDays('2024-01-01', '2024-01-07')).rejects.toThrow('API error: 500');
    });
  });

  describe('getDays', () => {
    it('should fetch days data for date range', async () => {
      const mockDays = [
        {
          date: '2024-01-01',
          meal_notes: null,
          calendar_events: []
        }
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockDays),
      });

      const result = await getDays('2024-01-01', '2024-01-07');

      expect(mockFetch).toHaveBeenCalledWith('/api/days?start_date=2024-01-01&end_date=2024-01-07', {
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });
      expect(result).toEqual(mockDays);
    });
  });

  describe('getEvents', () => {
    it('should fetch calendar events for date range', async () => {
      const mockEvents = {
        '2024-01-01': [
          {
            title: 'Test Event',
            start_time: '2024-01-01T10:00:00Z',
            end_time: '2024-01-01T11:00:00Z',
            all_day: false
          }
        ]
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockEvents),
      });

      const result = await getEvents('2024-01-01', '2024-01-07');

      expect(mockFetch).toHaveBeenCalledWith('/api/days/events?start_date=2024-01-01&end_date=2024-01-07', {
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });
      expect(result).toEqual(mockEvents);
    });
  });

  describe('updateNotes', () => {
    it('should update meal notes for a date', async () => {
      const mockNote = {
        id: '123',
        date: '2024-01-01',
        notes: 'Updated notes'
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockNote),
      });

      const result = await updateNotes('2024-01-01', 'Updated notes');

      expect(mockFetch).toHaveBeenCalledWith('/api/days/2024-01-01/notes', {
        method: 'PUT',
        body: JSON.stringify({ notes: 'Updated notes' }),
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });
      expect(result).toEqual(mockNote);
    });
  });

  describe('toggleItemized', () => {
    it('should toggle itemized status for a meal item', async () => {
      const mockItem = {
        id: '456',
        line_index: 0,
        itemized: true
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockItem),
      });

      const result = await toggleItemized('2024-01-01', 0, true);

      expect(mockFetch).toHaveBeenCalledWith('/api/days/2024-01-01/items/0', {
        method: 'PATCH',
        body: JSON.stringify({ itemized: true }),
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });
      expect(result).toEqual(mockItem);
    });
  });

  describe('getCurrentUser', () => {
    it('should return user info when authenticated', async () => {
      const mockUser = {
        id: '123',
        name: 'Test User',
        email: 'test@example.com'
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockUser),
      });

      const result = await getCurrentUser();

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/me', {
        credentials: 'include',
      });
      expect(result).toEqual(mockUser);
    });

    it('should return null when not authenticated', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
      });

      const result = await getCurrentUser();

      expect(result).toBeNull();
    });

    it('should return null when fetch fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await getCurrentUser();

      expect(result).toBeNull();
    });
  });

  describe('logout', () => {
    it('should call logout endpoint', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      });

      await logout();

      expect(mockFetch).toHaveBeenCalledWith('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    });
  });

  describe('getLoginUrl', () => {
    it('should return the login URL', () => {
      const result = getLoginUrl();
      expect(result).toBe('/api/auth/login');
    });
  });
});
