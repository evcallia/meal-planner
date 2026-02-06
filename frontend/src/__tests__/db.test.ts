import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveLocalNote,
  getLocalNote,
  queueChange,
  getPendingChanges,
  removePendingChange,
  markNoteSynced,
  clearPendingChanges,
  getLocalNotesForRange,
  getAllLocalNotes,
  generateTempId,
  isTempId,
  saveLocalPantryItem,
  getLocalPantryItems,
  getLocalPantryItem,
  deleteLocalPantryItem,
  clearLocalPantryItems,
  saveLocalMealIdea,
  getLocalMealIdeas,
  getLocalMealIdea,
  deleteLocalMealIdea,
  clearLocalMealIdeas,
  saveTempIdMapping,
  getTempIdMapping,
  clearTempIdMappings,
  saveLocalCalendarEvents,
  getLocalCalendarEvents,
  getLocalCalendarEventsForRange,
  saveLocalHiddenEvent,
  saveLocalHiddenEvents,
  getLocalHiddenEvents,
  deleteLocalHiddenEvent,
  clearLocalHiddenEvents,
  updateLocalHiddenEventId,
  db
} from '../db';

// Mock Dexie
vi.mock('dexie', () => {
  const createMockTable = () => {
    const table = {
      put: vi.fn(),
      bulkPut: vi.fn(),
      get: vi.fn(),
      add: vi.fn(),
      toArray: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      where: vi.fn(),
    };
    table.where.mockImplementation(() => ({
      between: vi.fn(() => ({ toArray: table.toArray })),
    }));
    return table;
  };

  const tables: Record<string, ReturnType<typeof createMockTable>> = {};

  return {
    default: class MockDexie {
      version() {
        return {
          stores: vi.fn().mockReturnThis()
        };
      }

      table(name: string) {
        if (!tables[name]) {
          tables[name] = createMockTable();
        }
        return tables[name];
      }
    },
    Table: class {},
  };
});

describe('db utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveLocalNote', () => {
    it('should save a meal note with correct structure', async () => {
      const date = '2024-01-01';
      const notes = 'Test notes';
      const items = [{ line_index: 0, itemized: true }];

      await saveLocalNote(date, notes, items);

      expect(db.mealNotes.put).toHaveBeenCalledWith({
        date,
        notes,
        items,
        updatedAt: expect.any(Number),
        synced: false
      });
    });
  });

  describe('getLocalNote', () => {
    it('should retrieve a meal note by date', async () => {
      const date = '2024-01-01';
      const mockNote = {
        date,
        notes: 'Test notes',
        items: [],
        updatedAt: Date.now(),
        synced: false
      };

      vi.mocked(db.mealNotes.get).mockResolvedValue(mockNote);

      const result = await getLocalNote(date);

      expect(db.mealNotes.get).toHaveBeenCalledWith(date);
      expect(result).toEqual(mockNote);
    });

    it('should return undefined for non-existent note', async () => {
      vi.mocked(db.mealNotes.get).mockResolvedValue(undefined);

      const result = await getLocalNote('2024-01-01');

      expect(result).toBeUndefined();
    });
  });

  describe('queueChange', () => {
    it('should queue a notes change', async () => {
      const type = 'notes';
      const date = '2024-01-01';
      const payload = { notes: 'Updated notes' };

      await queueChange(type, date, payload);

      expect(db.pendingChanges.add).toHaveBeenCalledWith({
        type,
        date,
        payload,
        createdAt: expect.any(Number)
      });
    });

    it('should queue an itemized change', async () => {
      const type = 'itemized';
      const date = '2024-01-01';
      const payload = { lineIndex: 0, itemized: true };

      await queueChange(type, date, payload);

      expect(db.pendingChanges.add).toHaveBeenCalledWith({
        type,
        date,
        payload,
        createdAt: expect.any(Number)
      });
    });
  });

  describe('getPendingChanges', () => {
    it('should return all pending changes', async () => {
      const mockChanges = [
        { id: 1, type: 'notes' as const, date: '2024-01-01', payload: {}, createdAt: Date.now() }
      ];

      vi.mocked(db.pendingChanges.toArray).mockResolvedValue(mockChanges);

      const result = await getPendingChanges();

      expect(db.pendingChanges.toArray).toHaveBeenCalled();
      expect(result).toEqual(mockChanges);
    });
  });

  describe('removePendingChange', () => {
    it('should remove a pending change by id', async () => {
      const id = 123;

      await removePendingChange(id);

      expect(db.pendingChanges.delete).toHaveBeenCalledWith(id);
    });
  });

  describe('markNoteSynced', () => {
    it('should mark an existing note as synced', async () => {
      const date = '2024-01-01';
      const mockNote = {
        date,
        notes: 'Test notes',
        items: [],
        updatedAt: Date.now(),
        synced: false
      };

      vi.mocked(db.mealNotes.get).mockResolvedValue(mockNote);

      await markNoteSynced(date);

      expect(db.mealNotes.get).toHaveBeenCalledWith(date);
      expect(db.mealNotes.put).toHaveBeenCalledWith({
        ...mockNote,
        synced: true
      });
    });

    it('should not update if note does not exist', async () => {
      vi.mocked(db.mealNotes.get).mockResolvedValue(undefined);

      await markNoteSynced('2024-01-01');

      expect(db.mealNotes.put).not.toHaveBeenCalled();
    });
  });

  describe('clearPendingChanges', () => {
    it('should clear all pending changes', async () => {
      await clearPendingChanges();

      expect(db.pendingChanges.clear).toHaveBeenCalled();
    });
  });

  describe('range queries', () => {
    it('should get notes for a date range', async () => {
      const notes = [
        { date: '2024-01-01', notes: 'A', items: [], updatedAt: Date.now(), synced: false }
      ];
      vi.mocked(db.mealNotes.toArray).mockResolvedValue(notes);

      const result = await getLocalNotesForRange('2024-01-01', '2024-01-07');

      expect(db.mealNotes.where).toHaveBeenCalledWith('date');
      expect(result).toEqual(notes);
    });

    it('should return all local notes', async () => {
      const notes = [
        { date: '2024-01-02', notes: 'B', items: [], updatedAt: Date.now(), synced: false }
      ];
      vi.mocked(db.mealNotes.toArray).mockResolvedValue(notes);

      const result = await getAllLocalNotes();

      expect(db.mealNotes.toArray).toHaveBeenCalled();
      expect(result).toEqual(notes);
    });
  });

  describe('temp ids', () => {
    it('generates and detects temp ids', () => {
      const tempId = generateTempId();
      expect(tempId.startsWith('temp-')).toBe(true);
      expect(isTempId(tempId)).toBe(true);
      expect(isTempId('real-123')).toBe(false);
    });
  });

  describe('pantry items', () => {
    it('saves and fetches pantry items', async () => {
      const item = { id: '1', name: 'Rice', quantity: 2, updated_at: '2026-01-01T00:00:00Z' };
      await saveLocalPantryItem(item);
      expect(db.pantryItems.put).toHaveBeenCalledWith(item);

      vi.mocked(db.pantryItems.toArray).mockResolvedValue([item]);
      expect(await getLocalPantryItems()).toEqual([item]);

      vi.mocked(db.pantryItems.get).mockResolvedValue(item);
      expect(await getLocalPantryItem('1')).toEqual(item);
    });

    it('deletes and clears pantry items', async () => {
      await deleteLocalPantryItem('1');
      expect(db.pantryItems.delete).toHaveBeenCalledWith('1');

      await clearLocalPantryItems();
      expect(db.pantryItems.clear).toHaveBeenCalled();
    });
  });

  describe('meal ideas', () => {
    it('saves and fetches meal ideas', async () => {
      const idea = { id: '1', title: 'Pasta', updated_at: '2026-01-01T00:00:00Z' };
      await saveLocalMealIdea(idea);
      expect(db.mealIdeas.put).toHaveBeenCalledWith(idea);

      vi.mocked(db.mealIdeas.toArray).mockResolvedValue([idea]);
      expect(await getLocalMealIdeas()).toEqual([idea]);

      vi.mocked(db.mealIdeas.get).mockResolvedValue(idea);
      expect(await getLocalMealIdea('1')).toEqual(idea);
    });

    it('deletes and clears meal ideas', async () => {
      await deleteLocalMealIdea('1');
      expect(db.mealIdeas.delete).toHaveBeenCalledWith('1');

      await clearLocalMealIdeas();
      expect(db.mealIdeas.clear).toHaveBeenCalled();
    });
  });

  describe('temp id mappings', () => {
    it('stores and retrieves temp id mappings', async () => {
      await saveTempIdMapping('temp-1', 'real-1');
      expect(db.tempIdMap.put).toHaveBeenCalledWith({ tempId: 'temp-1', realId: 'real-1' });

      vi.mocked(db.tempIdMap.get).mockResolvedValue({ tempId: 'temp-1', realId: 'real-1' });
      expect(await getTempIdMapping('temp-1')).toBe('real-1');

      await clearTempIdMappings();
      expect(db.tempIdMap.clear).toHaveBeenCalled();
    });
  });

  describe('calendar events', () => {
    it('saves and gets calendar events', async () => {
      const events = [
        { title: 'Event', start_time: '2026-01-01T10:00:00Z', end_time: null, all_day: false },
      ];
      await saveLocalCalendarEvents('2026-01-01', events);
      expect(db.calendarDays.put).toHaveBeenCalledWith({
        date: '2026-01-01',
        events,
        updatedAt: expect.any(Number),
      });

      vi.mocked(db.calendarDays.get).mockResolvedValue({ date: '2026-01-01', events, updatedAt: Date.now() });
      expect(await getLocalCalendarEvents('2026-01-01')).toEqual(events);
    });

    it('builds event maps for ranges', async () => {
      const days = [
        { date: '2026-01-01', events: [{ title: 'A', start_time: '2026-01-01T10:00:00Z', end_time: null, all_day: false }], updatedAt: 1 },
        { date: '2026-01-02', events: [], updatedAt: 1 },
      ];
      vi.mocked(db.calendarDays.toArray).mockResolvedValue(days);

      const result = await getLocalCalendarEventsForRange('2026-01-01', '2026-01-02');

      expect(db.calendarDays.where).toHaveBeenCalledWith('date');
      expect(result['2026-01-01']).toHaveLength(1);
      expect(result['2026-01-02']).toHaveLength(0);
    });
  });

  describe('hidden calendar events', () => {
    it('saves and lists hidden events', async () => {
      const event = {
        id: 'hidden-1',
        event_uid: 'uid-1',
        event_date: '2026-01-01',
        calendar_name: 'Personal',
        title: 'Event',
        start_time: '2026-01-01T10:00:00Z',
        end_time: null,
        all_day: false,
      };

      await saveLocalHiddenEvent(event);
      expect(db.hiddenCalendarEvents.put).toHaveBeenCalledWith({
        ...event,
        updatedAt: expect.any(Number),
      });

      vi.mocked(db.hiddenCalendarEvents.toArray).mockResolvedValue([{ ...event, updatedAt: Date.now() }]);
      const result = await getLocalHiddenEvents();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('hidden-1');
    });

    it('bulk saves hidden events', async () => {
      const events = [
        {
          id: 'hidden-1',
          event_uid: 'uid-1',
          event_date: '2026-01-01',
          calendar_name: 'Personal',
          title: 'Event',
          start_time: '2026-01-01T10:00:00Z',
          end_time: null,
          all_day: false,
        },
      ];

      await saveLocalHiddenEvents(events);
      expect(db.hiddenCalendarEvents.bulkPut).toHaveBeenCalledWith([
        { ...events[0], updatedAt: expect.any(Number) },
      ]);
    });

    it('deletes and clears hidden events', async () => {
      await deleteLocalHiddenEvent('hidden-2');
      expect(db.hiddenCalendarEvents.delete).toHaveBeenCalledWith('hidden-2');

      await clearLocalHiddenEvents();
      expect(db.hiddenCalendarEvents.clear).toHaveBeenCalled();
    });

    it('updates hidden event ids', async () => {
      const event = {
        id: 'hidden-3',
        event_uid: 'uid-3',
        event_date: '2026-01-03',
        calendar_name: 'Work',
        title: 'Event',
        start_time: '2026-01-03T10:00:00Z',
        end_time: null,
        all_day: false,
      };

      await updateLocalHiddenEventId('temp-hidden', event);
      expect(db.hiddenCalendarEvents.delete).toHaveBeenCalledWith('temp-hidden');
      expect(db.hiddenCalendarEvents.put).toHaveBeenCalledWith({
        ...event,
        updatedAt: expect.any(Number),
      });
    });
  });
});
