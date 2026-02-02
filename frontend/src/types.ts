export interface CalendarEvent {
  title: string;
  start_time: string;
  end_time: string | null;
  all_day: boolean;
}

export interface MealItem {
  line_index: number;
  itemized: boolean;
}

export interface MealNote {
  id: string;
  date: string;
  notes: string;
  items: MealItem[];
  updated_at: string;
}

export interface DayData {
  date: string;
  events: CalendarEvent[];
  meal_note: MealNote | null;
}

export interface UserInfo {
  sub: string;
  email: string | null;
  name: string | null;
}

export type ConnectionStatus = 'online' | 'offline' | 'syncing';
