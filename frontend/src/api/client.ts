import { DayData, MealNote, MealItem, UserInfo, CalendarEvent, PantryItem, PantrySection, MealIdea } from '../types';
import { logDuration, logPerf, perfNow } from '../utils/perf';

const API_BASE = '/api';
const API_TIMEOUT = 5000; // 5 second timeout for API requests
export const SOURCE_ID = crypto.randomUUID();

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const method = options?.method ?? 'GET';
  const requestStart = perfNow();
  let response: Response;

  // Create an AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Source-Id': SOURCE_ID,
        ...options?.headers,
      },
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    logDuration('api.request_error', requestStart, { path, method });
    throw error;
  }

  clearTimeout(timeoutId);

  logDuration('api.request', requestStart, { path, method, status: response.status });

  // Any successful response proves we're online — notify the status hook
  if (response.ok) {
    window.dispatchEvent(new Event('api-request-succeeded'));
  }

  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('auth-unauthorized'));
      throw new Error('Unauthorized');
    }
    throw new Error(`API error: ${response.status}`);
  }

  const parseStart = perfNow();
  const data = await response.json();
  logPerf('api.response', { path, method, status: response.status });
  logDuration('api.parse', parseStart, { path, method });
  return data;
}

export async function getDays(startDate: string, endDate: string): Promise<DayData[]> {
  return fetchAPI<DayData[]>(`/days?start_date=${startDate}&end_date=${endDate}`);
}

export async function getEvents(startDate: string, endDate: string, includeHidden: boolean = false, includeHolidays: boolean = true): Promise<Record<string, CalendarEvent[]>> {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    include_hidden: String(includeHidden),
    include_holidays: String(includeHolidays),
  });
  return fetchAPI<Record<string, CalendarEvent[]>>(`/days/events?${params}`);
}

export async function updateNotes(date: string, notes: string): Promise<MealNote> {
  return fetchAPI<MealNote>(`/days/${date}/notes`, {
    method: 'PUT',
    body: JSON.stringify({ notes }),
  });
}

export async function toggleItemized(date: string, lineIndex: number, itemized: boolean): Promise<MealItem> {
  return fetchAPI<MealItem>(`/days/${date}/items/${lineIndex}`, {
    method: 'PATCH',
    body: JSON.stringify({ itemized }),
  });
}

export async function getCurrentUser(): Promise<UserInfo | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export async function logout(): Promise<string | null> {
  const res = await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
  if (res.ok) {
    const data = await res.json();
    return data.end_session_url || null;
  }
  return null;
}

export function getLoginUrl(): string {
  return `${API_BASE}/auth/login`;
}

export async function getPantryList(): Promise<PantrySection[]> {
  return fetchAPI<PantrySection[]>('/pantry');
}

export async function replacePantryList(sections: { name: string; items: { name: string; quantity: number }[] }[]): Promise<PantrySection[]> {
  return fetchAPI<PantrySection[]>('/pantry', {
    method: 'PUT',
    body: JSON.stringify({ sections }),
  });
}

export async function addPantryItem(sectionId: string, name: string, quantity: number = 0): Promise<PantryItem> {
  return fetchAPI<PantryItem>('/pantry/items', {
    method: 'POST',
    body: JSON.stringify({ section_id: sectionId, name, quantity }),
  });
}

export async function updatePantryItem(itemId: string, payload: { name?: string; quantity?: number }): Promise<PantryItem> {
  return fetchAPI<PantryItem>(`/pantry/items/${itemId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function deletePantryItem(itemId: string): Promise<void> {
  await fetchAPI(`/pantry/items/${itemId}`, {
    method: 'DELETE',
  });
}

export async function reorderPantrySections(sectionIds: string[]): Promise<{ status: string }> {
  return fetchAPI<{ status: string }>('/pantry/reorder-sections', {
    method: 'PATCH',
    body: JSON.stringify({ section_ids: sectionIds }),
  });
}

export async function reorderPantryItems(sectionId: string, itemIds: string[]): Promise<{ status: string }> {
  return fetchAPI<{ status: string }>(`/pantry/sections/${sectionId}/reorder-items`, {
    method: 'PATCH',
    body: JSON.stringify({ item_ids: itemIds }),
  });
}

export async function renamePantrySection(sectionId: string, name: string): Promise<PantrySection> {
  return fetchAPI<PantrySection>(`/pantry/sections/${sectionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export async function clearPantryItems(mode: 'all'): Promise<PantrySection[]> {
  return fetchAPI<PantrySection[]>(`/pantry/items?mode=${mode}`, {
    method: 'DELETE',
  });
}

export async function getMealIdeas(): Promise<MealIdea[]> {
  return fetchAPI<MealIdea[]>('/meal-ideas');
}

export async function createMealIdea(payload: { title: string }): Promise<MealIdea> {
  return fetchAPI<MealIdea>('/meal-ideas', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateMealIdea(ideaId: string, payload: { title?: string }): Promise<MealIdea> {
  return fetchAPI<MealIdea>(`/meal-ideas/${ideaId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function deleteMealIdea(ideaId: string): Promise<void> {
  await fetchAPI(`/meal-ideas/${ideaId}`, {
    method: 'DELETE',
  });
}

export interface CalendarCacheStatus {
  last_refresh: string | null;
  cache_start: string | null;
  cache_end: string | null;
  is_refreshing: boolean;
}

export async function getCalendarCacheStatus(): Promise<CalendarCacheStatus> {
  return fetchAPI<CalendarCacheStatus>('/calendar/cache-status');
}

export async function refreshCalendarCache(): Promise<{ message: string }> {
  return fetchAPI<{ message: string }>('/calendar/refresh', {
    method: 'POST',
  });
}

export interface CalendarListResponse {
  available: string[];
  selected: string[];
}

export async function getCalendarList(): Promise<CalendarListResponse> {
  return fetchAPI<CalendarListResponse>('/calendar/list');
}

export interface HiddenCalendarEvent {
  id: string;
  event_uid: string;
  event_date: string;
  calendar_name: string;
  title: string;
  start_time: string;
  end_time: string | null;
  all_day: boolean;
}

export async function getHiddenCalendarEvents(): Promise<HiddenCalendarEvent[]> {
  return fetchAPI<HiddenCalendarEvent[]>('/calendar/hidden');
}

export async function hideCalendarEvent(payload: {
  event_uid: string;
  calendar_name: string;
  title: string;
  start_time: string;
  end_time: string | null;
  all_day: boolean;
}): Promise<HiddenCalendarEvent> {
  return fetchAPI<HiddenCalendarEvent>('/calendar/hidden', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function unhideCalendarEvent(hiddenId: string): Promise<{ status: string }> {
  return fetchAPI<{ status: string }>(`/calendar/hidden/${hiddenId}`, {
    method: 'DELETE',
  });
}

// Grocery API
import type { GrocerySection, GroceryItem } from '../types';

export async function getGroceryList(): Promise<GrocerySection[]> {
  return fetchAPI<GrocerySection[]>('/grocery');
}

export async function replaceGroceryList(sections: { name: string; items: { name: string; quantity: string | null; checked?: boolean; store_id?: string | null }[] }[]): Promise<GrocerySection[]> {
  return fetchAPI<GrocerySection[]>('/grocery', {
    method: 'PUT',
    body: JSON.stringify({ sections }),
  });
}

export async function toggleGroceryItem(itemId: string, checked: boolean): Promise<GroceryItem> {
  return fetchAPI<GroceryItem>(`/grocery/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ checked }),
  });
}

export async function addGroceryItem(sectionId: string, name: string, quantity: string | null = null, storeId: string | null = null): Promise<GroceryItem> {
  return fetchAPI<GroceryItem>('/grocery/items', {
    method: 'POST',
    body: JSON.stringify({ section_id: sectionId, name, quantity, store_id: storeId }),
  });
}

export async function deleteGroceryItem(itemId: string): Promise<{ status: string }> {
  return fetchAPI<{ status: string }>(`/grocery/items/${itemId}`, {
    method: 'DELETE',
  });
}

export async function reorderGrocerySections(sectionIds: string[]): Promise<{ status: string }> {
  return fetchAPI<{ status: string }>('/grocery/reorder-sections', {
    method: 'PATCH',
    body: JSON.stringify({ section_ids: sectionIds }),
  });
}

export async function reorderGroceryItems(sectionId: string, itemIds: string[]): Promise<{ status: string }> {
  return fetchAPI<{ status: string }>(`/grocery/sections/${sectionId}/reorder-items`, {
    method: 'PATCH',
    body: JSON.stringify({ item_ids: itemIds }),
  });
}

export async function renameGrocerySection(sectionId: string, name: string): Promise<GrocerySection> {
  return fetchAPI<GrocerySection>(`/grocery/sections/${sectionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export async function createGrocerySection(name: string, position?: number): Promise<GrocerySection> {
  return fetchAPI<GrocerySection>('/grocery/sections', {
    method: 'POST',
    body: JSON.stringify({ name, position }),
  });
}

export async function deleteGrocerySection(sectionId: string): Promise<void> {
  await fetchAPI(`/grocery/sections/${sectionId}`, { method: 'DELETE' });
}

export async function editGroceryItem(itemId: string, updates: { name?: string; quantity?: string | null; store_id?: string | null }): Promise<GroceryItem> {
  return fetchAPI<GroceryItem>(`/grocery/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function clearGroceryItems(mode: 'checked' | 'all'): Promise<GrocerySection[]> {
  return fetchAPI<GrocerySection[]>(`/grocery/items?mode=${mode}`, {
    method: 'DELETE',
  });
}

export async function moveGroceryItem(itemId: string, toSectionId: string, toPosition: number): Promise<GroceryItem> {
  return fetchAPI<GroceryItem>(`/grocery/items/${itemId}/move`, {
    method: 'PATCH',
    body: JSON.stringify({ to_section_id: toSectionId, to_position: toPosition }),
  });
}

export async function movePantryItem(itemId: string, toSectionId: string, toPosition: number): Promise<PantryItem> {
  return fetchAPI<PantryItem>(`/pantry/items/${itemId}/move`, {
    method: 'PATCH',
    body: JSON.stringify({ to_section_id: toSectionId, to_position: toPosition }),
  });
}

export async function createPantrySection(name: string): Promise<PantrySection> {
  return fetchAPI<PantrySection>('/pantry/sections', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function deletePantrySection(sectionId: string): Promise<{ status: string }> {
  return fetchAPI<{ status: string }>(`/pantry/sections/${sectionId}`, {
    method: 'DELETE',
  });
}

// Store API
import type { Store } from '../types';

export async function getStores(): Promise<Store[]> {
  return fetchAPI<Store[]>('/stores');
}

export async function createStore(name: string): Promise<Store> {
  return fetchAPI<Store>('/stores', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function updateStore(storeId: string, updates: { name?: string; position?: number }): Promise<Store> {
  return fetchAPI<Store>(`/stores/${storeId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function deleteStore(storeId: string): Promise<{ status: string }> {
  return fetchAPI<{ status: string }>(`/stores/${storeId}`, {
    method: 'DELETE',
  });
}

export async function reorderStores(storeIds: string[]): Promise<{ status: string }> {
  return fetchAPI<{ status: string }>('/stores/reorder', {
    method: 'PATCH',
    body: JSON.stringify({ store_ids: storeIds }),
  });
}

export async function getSettings(): Promise<{ settings: Record<string, unknown>; updated_at: string | null }> {
  return fetchAPI<{ settings: Record<string, unknown>; updated_at: string | null }>('/settings');
}

export async function putSettings(settings: Record<string, unknown>, updatedAt: string): Promise<{ settings: Record<string, unknown>; updated_at: string }> {
  return fetchAPI<{ settings: Record<string, unknown>; updated_at: string }>('/settings', {
    method: 'PUT',
    body: JSON.stringify({ settings, updated_at: updatedAt }),
  });
}
