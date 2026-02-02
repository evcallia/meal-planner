import { DayData, MealNote, MealItem, UserInfo } from '../types';

const API_BASE = '/api';

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Unauthorized');
    }
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

export async function getDays(startDate: string, endDate: string): Promise<DayData[]> {
  return fetchAPI<DayData[]>(`/days?start_date=${startDate}&end_date=${endDate}`);
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
    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include',
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
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
