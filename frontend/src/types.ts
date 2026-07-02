export interface CalendarEvent {
  id: string;
  uid?: string | null;
  calendar_name?: string | null;
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

export type ConnectionStatus = 'online' | 'offline' | 'syncing' | 'auth-required';

export interface Store {
  id: string;
  name: string;
  position: number;
}

export interface PantryItem {
  id: string;
  section_id: string;
  name: string;
  quantity: number;
  position: number;
  updated_at: string;
}

export interface PantrySection {
  id: string;
  name: string;
  position: number;
  items: PantryItem[];
}

export interface MealIdea {
  id: string;
  title: string;
  updated_at: string;
}

export interface GroceryItem {
  id: string;
  section_id: string;
  name: string;
  quantity: string | null;
  checked: boolean;
  position: number;
  store_id: string | null;
  updated_at: string;
}

export interface GrocerySection {
  id: string;
  name: string;
  position: number;
  items: GroceryItem[];
}

// ----- Tracker / Lists -----

export interface TrackerLog {
  id: string;
  task_id: string;
  done_at: string;
  kind?: string; // "done" | "skip"
  note: string | null;
  created_by_sub?: string | null;
  created_by_name?: string | null;
}

export interface TrackerTask {
  id: string;
  list_id: string;
  name: string;
  target_interval_days: number | null;
  notes: string | null;
  position: number;
  archived: boolean;
  season_start_month: number | null;
  season_end_month: number | null;
  season_start_day: number | null;
  season_end_day: number | null;
  snooze_until: string | null;
  last_done_at: string | null;
  last_event_at: string | null;
  last_done_by: string | null;
  last_note: string | null;
  total_count: number;
  avg_interval_days: number | null;
  // The most recent few completion/skip entries, embedded so history is viewable
  // offline without an on-demand /logs fetch. Full history still loads on open.
  recent_logs?: TrackerLog[];
}

export interface TrackerShareUser {
  sub: string;
  email: string | null;
  name: string | null;
}

export interface TrackerList {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  position: number;
  owner_sub: string;
  owner_name: string | null;
  is_owner: boolean;
  shared_with: TrackerShareUser[];
  tasks: TrackerTask[];
}

export interface DirectoryUser {
  sub: string;
  email: string | null;
  name: string | null;
}
