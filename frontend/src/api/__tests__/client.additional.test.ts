import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getGroceryList,
  replaceGroceryList,
  toggleGroceryItem,
  addGroceryItem,
  deleteGroceryItem,
  editGroceryItem,
  clearGroceryItems,
  reorderGrocerySections,
  reorderGroceryItems,
  renameGrocerySection,
  moveGroceryItem,
  getStores,
  createStore,
  updateStore,
  deleteStore,
  reorderStores,
  getHiddenCalendarEvents,
  hideCalendarEvent,
  unhideCalendarEvent,
  replacePantryList,
  clearPantryItems,
  reorderPantrySections,
  reorderPantryItems,
  renamePantrySection,
  movePantryItem,
  createPantrySection,
  deletePantrySection,
  updateNotes,
  toggleItemized,
  logout,
  getLoginUrl,
} from '../client';

const mockFetch = vi.fn();
global.fetch = mockFetch;

function mockOkResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  };
}

describe('API client - additional coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Grocery API', () => {
    it('getGroceryList fetches /api/grocery', async () => {
      const data = [{ id: 's1', name: 'Produce', position: 0, items: [] }];
      mockFetch.mockResolvedValue(mockOkResponse(data));

      const result = await getGroceryList();
      expect(result).toEqual(data);
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/grocery'), expect.any(Object));
    });

    it('replaceGroceryList sends PUT to /api/grocery', async () => {
      const sections = [{ name: 'Produce', items: [{ name: 'Bananas', quantity: '2' }] }];
      mockFetch.mockResolvedValue(mockOkResponse([]));

      await replaceGroceryList(sections);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/grocery'),
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ sections }) })
      );
    });

    it('toggleGroceryItem sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ id: 'i1', checked: true }));

      await toggleGroceryItem('i1', true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/grocery/items/i1'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ checked: true }) })
      );
    });

    it('addGroceryItem sends POST', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ id: 'new-1' }));

      await addGroceryItem('s1', 'Bananas', '2', 'store-1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/grocery/items'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ section_id: 's1', name: 'Bananas', quantity: '2', store_id: 'store-1' }),
        })
      );
    });

    it('deleteGroceryItem sends DELETE', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ status: 'ok' }));

      await deleteGroceryItem('i1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/grocery/items/i1'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('editGroceryItem sends PATCH with updates', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ id: 'i1', name: 'Updated' }));

      await editGroceryItem('i1', { name: 'Updated', quantity: '3' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/grocery/items/i1'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Updated', quantity: '3' }) })
      );
    });

    it('clearGroceryItems sends DELETE with mode', async () => {
      mockFetch.mockResolvedValue(mockOkResponse([]));

      await clearGroceryItems('checked');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/grocery/items?mode=checked'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('reorderGrocerySections sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ status: 'ok' }));

      await reorderGrocerySections(['s2', 's1']);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/grocery/reorder-sections'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ section_ids: ['s2', 's1'] }) })
      );
    });

    it('reorderGroceryItems sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ status: 'ok' }));

      await reorderGroceryItems('s1', ['i2', 'i1']);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/grocery/sections/s1/reorder-items'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ item_ids: ['i2', 'i1'] }) })
      );
    });

    it('renameGrocerySection sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ id: 's1', name: 'Fruits' }));

      await renameGrocerySection('s1', 'Fruits');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/grocery/sections/s1'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Fruits' }) })
      );
    });

    it('moveGroceryItem sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ id: 'i1' }));

      await moveGroceryItem('i1', 's2', 0);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/grocery/items/i1/move'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ to_section_id: 's2', to_position: 0 }) })
      );
    });
  });

  describe('Store API', () => {
    it('getStores fetches /api/stores', async () => {
      mockFetch.mockResolvedValue(mockOkResponse([{ id: 'st1', name: 'Costco' }]));

      const result = await getStores();
      expect(result).toEqual([{ id: 'st1', name: 'Costco' }]);
    });

    it('createStore sends POST', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ id: 'st1', name: 'Costco' }));

      await createStore('Costco');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/stores'),
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Costco' }) })
      );
    });

    it('updateStore sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ id: 'st1', name: 'New Name' }));

      await updateStore('st1', { name: 'New Name' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/stores/st1'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'New Name' }) })
      );
    });

    it('deleteStore sends DELETE', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ status: 'ok' }));

      await deleteStore('st1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/stores/st1'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('reorderStores sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ status: 'ok' }));

      await reorderStores(['st2', 'st1']);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/stores/reorder'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ store_ids: ['st2', 'st1'] }) })
      );
    });
  });

  describe('Calendar hidden events API', () => {
    it('getHiddenCalendarEvents fetches /api/calendar/hidden', async () => {
      mockFetch.mockResolvedValue(mockOkResponse([]));

      const result = await getHiddenCalendarEvents();
      expect(result).toEqual([]);
    });

    it('hideCalendarEvent sends POST', async () => {
      const payload = {
        event_uid: 'uid-1',
        calendar_name: 'Work',
        title: 'Meeting',
        start_time: '2026-01-01T10:00:00Z',
        end_time: '2026-01-01T11:00:00Z',
        all_day: false,
      };
      mockFetch.mockResolvedValue(mockOkResponse({ id: 'h1', ...payload }));

      await hideCalendarEvent(payload);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/calendar/hidden'),
        expect.objectContaining({ method: 'POST', body: JSON.stringify(payload) })
      );
    });

    it('unhideCalendarEvent sends DELETE', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ status: 'ok' }));

      await unhideCalendarEvent('h1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/calendar/hidden/h1'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('Additional Pantry API', () => {
    it('replacePantryList sends PUT', async () => {
      const sections = [{ name: 'Fridge', items: [{ name: 'Milk', quantity: 1 }] }];
      mockFetch.mockResolvedValue(mockOkResponse([]));

      await replacePantryList(sections);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/pantry'),
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ sections }) })
      );
    });

    it('clearPantryItems sends DELETE', async () => {
      mockFetch.mockResolvedValue(mockOkResponse([]));

      await clearPantryItems('all');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/pantry/items?mode=all'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('reorderPantrySections sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ status: 'ok' }));

      await reorderPantrySections(['s2', 's1']);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/pantry/reorder-sections'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    it('reorderPantryItems sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ status: 'ok' }));

      await reorderPantryItems('s1', ['i2', 'i1']);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/pantry/sections/s1/reorder-items'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    it('renamePantrySection sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ id: 's1', name: 'Freezer' }));

      await renamePantrySection('s1', 'Freezer');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/pantry/sections/s1'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Freezer' }) })
      );
    });

    it('movePantryItem sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ id: 'i1' }));

      await movePantryItem('i1', 's2', 0);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/pantry/items/i1/move'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ to_section_id: 's2', to_position: 0 }) })
      );
    });

    it('createPantrySection sends POST', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ id: 's3', name: 'Freezer', position: 2, items: [] }));

      await createPantrySection('Freezer');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/pantry/sections'),
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Freezer' }) })
      );
    });

    it('deletePantrySection sends DELETE', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ status: 'ok' }));

      await deletePantrySection('s1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/pantry/sections/s1'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('Days API additional', () => {
    it('updateNotes sends PUT with notes', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ id: 'n1', date: '2026-01-01', notes: 'test' }));

      await updateNotes('2026-01-01', 'test');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/days/2026-01-01/notes'),
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ notes: 'test' }) })
      );
    });

    it('toggleItemized sends PATCH', async () => {
      mockFetch.mockResolvedValue(mockOkResponse({ line_index: 0, itemized: true }));

      await toggleItemized('2026-01-01', 0, true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/days/2026-01-01/items/0'),
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ itemized: true }) })
      );
    });

    it('logout sends POST to /api/auth/logout', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await logout();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/logout'),
        expect.objectContaining({ method: 'POST', credentials: 'include' })
      );
    });

    it('getLoginUrl returns correct URL', () => {
      expect(getLoginUrl()).toBe('/api/auth/login');
    });
  });
});
