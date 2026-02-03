import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveLocalNote, getLocalNote, queueChange, getPendingChanges, removePendingChange, markNoteSynced, clearPendingChanges, db } from '../db';

// Mock Dexie
vi.mock('dexie', () => {
  const mockTable = {
    put: vi.fn(),
    get: vi.fn(),
    add: vi.fn(),
    toArray: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  };

  return {
    default: class MockDexie {
      version() {
        return {
          stores: vi.fn().mockReturnThis()
        };
      }

      table() {
        return mockTable;
      }
      
      mealNotes = mockTable;
      pendingChanges = mockTable;
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
});
