import { DayData, MealNote, MealItem, UserInfo, CalendarEvent, PantryItem, MealIdea } from '../types';
import { logDuration, logPerf, perfNow } from '../utils/perf';
import { emitAuthFailure } from '../authEvents';

const API_BASE = '/api';
const API_TIMEOUT = 5000; // 5 second timeout for API requests

/** Check if a response is an HTML page (e.g. Cloudflare challenge) instead of JSON API */
function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('text/html');
}

export class AuthError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'AuthError';
  }
}

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

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      const reason = isHtmlResponse(response) ? 'cf-challenge' : 'session-expired';
      emitAuthFailure(reason);
      throw new AuthError(
        reason === 'cf-challenge' ? 'Access challenge required' : 'Unauthorized',
        response.status
      );
    }
    throw new Error(`API error: ${response.status}`);
  }

  // Guard against Cloudflare challenge pages that return 200 with HTML
  if (isHtmlResponse(response)) {
    emitAuthFailure('cf-challenge');
    throw new AuthError('Access challenge required', 403);
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

export async function getEvents(startDate: string, endDate: string, includeHidden: boolean = false): Promise<Record<string, CalendarEvent[]>> {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    include_hidden: String(includeHidden),
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

export type AuthCheckResult =
  | { status: 'authenticated'; user: UserInfo }
  | { status: 'auth-failed' }   // 401/403 — session or CF expired
  | { status: 'network-error' }; // fetch threw — truly offline

export async function getCurrentUser(): Promise<AuthCheckResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok && !isHtmlResponse(response)) {
      const user: UserInfo | null = await response.json();
      // /api/auth/me returns 200 with null body when session is expired
      if (!user) {
        return { status: 'auth-failed' };
      }
      return { status: 'authenticated', user };
    }

    // Got a response but not authenticated — emit so other listeners know
    if (response.status === 401 || response.status === 403 || isHtmlResponse(response)) {
      const reason = isHtmlResponse(response) ? 'cf-challenge' : 'session-expired';
      emitAuthFailure(reason);
      return { status: 'auth-failed' };
    }

    // Other error (500, etc) — treat as network-level issue
    return { status: 'network-error' };
  } catch {
    return { status: 'network-error' };
  }
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
}

export function getLoginUrl(): string {
  return `${API_BASE}/auth/login`;
}

export async function getPantryItems(): Promise<PantryItem[]> {
  return fetchAPI<PantryItem[]>('/pantry');
}

export async function createPantryItem(payload: { name: string; quantity: number }): Promise<PantryItem> {
  return fetchAPI<PantryItem>('/pantry', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updatePantryItem(itemId: string, payload: { name?: string; quantity?: number }): Promise<PantryItem> {
  return fetchAPI<PantryItem>(`/pantry/${itemId}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function deletePantryItem(itemId: string): Promise<void> {
  await fetchAPI(`/pantry/${itemId}`, {
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
