import Dexie, { Table } from 'dexie';

export interface LocalMealNote {
  date: string;
  notes: string;
  items: { line_index: number; itemized: boolean }[];
  updatedAt: number;
  synced: boolean;
}

export type ChangeType =
  | 'notes'
  | 'itemized'
  | 'pantry-add'
  | 'pantry-update'
  | 'pantry-delete'
  | 'meal-idea-add'
  | 'meal-idea-update'
  | 'meal-idea-delete';

export interface PendingChange {
  id?: number;
  type: ChangeType;
  date: string;
  payload: unknown;
  createdAt: number;
}

export interface LocalPantryItem {
  id: string;
  name: string;
  quantity: number;
  updated_at: string;
}

export interface LocalMealIdea {
  id: string;
  title: string;
  updated_at: string;
}

export interface LocalCalendarEvent {
  title: string;
  start_time: string;
  end_time: string | null;
  all_day: boolean;
}

export interface LocalCalendarDay {
  date: string;
  events: LocalCalendarEvent[];
  updatedAt: number;
}

class MealPlannerDB extends Dexie {
  mealNotes!: Table<LocalMealNote, string>;
  pendingChanges!: Table<PendingChange, number>;
  pantryItems!: Table<LocalPantryItem, string>;
  mealIdeas!: Table<LocalMealIdea, string>;
  tempIdMap!: Table<{ tempId: string; realId: string }, string>;
  calendarDays!: Table<LocalCalendarDay, string>;

  constructor() {
    super('MealPlannerDB');
    this.version(1).stores({
      mealNotes: 'date',
      pendingChanges: '++id, date, type'
    });
    this.version(2).stores({
      mealNotes: 'date',
      pendingChanges: '++id, date, type',
      pantryItems: 'id',
      mealIdeas: 'id',
      tempIdMap: 'tempId'
    });
    this.version(3).stores({
      mealNotes: 'date',
      pendingChanges: '++id, date, type',
      pantryItems: 'id',
      mealIdeas: 'id',
      tempIdMap: 'tempId',
      calendarDays: 'date'
    });
    // Ensure table properties are initialized for both runtime and tests.
    this.mealNotes = this.table('mealNotes');
    this.pendingChanges = this.table('pendingChanges');
    this.pantryItems = this.table('pantryItems');
    this.mealIdeas = this.table('mealIdeas');
    this.tempIdMap = this.table('tempIdMap');
    this.calendarDays = this.table('calendarDays');
  }
}

export const db = new MealPlannerDB();

// Save meal note locally
export async function saveLocalNote(date: string, notes: string, items: { line_index: number; itemized: boolean }[]) {
  await db.mealNotes.put({
    date,
    notes,
    items,
    updatedAt: Date.now(),
    synced: false
  });
}

// Get local meal note
export async function getLocalNote(date: string): Promise<LocalMealNote | undefined> {
  return db.mealNotes.get(date);
}

// Get all local meal notes for a date range
export async function getLocalNotesForRange(startDate: string, endDate: string): Promise<LocalMealNote[]> {
  return db.mealNotes
    .where('date')
    .between(startDate, endDate, true, true)
    .toArray();
}

// Get all local meal notes
export async function getAllLocalNotes(): Promise<LocalMealNote[]> {
  return db.mealNotes.toArray();
}

// Queue a change for sync
export async function queueChange(type: ChangeType, date: string, payload: unknown) {
  await db.pendingChanges.add({
    type,
    date,
    payload,
    createdAt: Date.now()
  });
}

// Get all pending changes
export async function getPendingChanges(): Promise<PendingChange[]> {
  return db.pendingChanges.toArray();
}

// Remove a pending change after sync
export async function removePendingChange(id: number) {
  await db.pendingChanges.delete(id);
}

// Mark note as synced
export async function markNoteSynced(date: string) {
  const note = await db.mealNotes.get(date);
  if (note) {
    await db.mealNotes.put({ ...note, synced: true });
  }
}

// Clear all pending changes (after full sync)
export async function clearPendingChanges() {
  await db.pendingChanges.clear();
}

// Generate a temporary ID for offline-created items
export function generateTempId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Check if an ID is a temporary ID
export function isTempId(id: string): boolean {
  return id.startsWith('temp-');
}

// Pantry items local storage
export async function saveLocalPantryItem(item: LocalPantryItem) {
  await db.pantryItems.put(item);
}

export async function getLocalPantryItems(): Promise<LocalPantryItem[]> {
  return db.pantryItems.toArray();
}

export async function getLocalPantryItem(id: string): Promise<LocalPantryItem | undefined> {
  return db.pantryItems.get(id);
}

export async function deleteLocalPantryItem(id: string) {
  await db.pantryItems.delete(id);
}

export async function clearLocalPantryItems() {
  await db.pantryItems.clear();
}

// Meal ideas local storage
export async function saveLocalMealIdea(idea: LocalMealIdea) {
  await db.mealIdeas.put(idea);
}

export async function getLocalMealIdeas(): Promise<LocalMealIdea[]> {
  return db.mealIdeas.toArray();
}

export async function getLocalMealIdea(id: string): Promise<LocalMealIdea | undefined> {
  return db.mealIdeas.get(id);
}

export async function deleteLocalMealIdea(id: string) {
  await db.mealIdeas.delete(id);
}

export async function clearLocalMealIdeas() {
  await db.mealIdeas.clear();
}

// Temp ID mapping (for syncing offline-created items)
export async function saveTempIdMapping(tempId: string, realId: string) {
  await db.tempIdMap.put({ tempId, realId });
}

export async function getTempIdMapping(tempId: string): Promise<string | undefined> {
  const mapping = await db.tempIdMap.get(tempId);
  return mapping?.realId;
}

export async function clearTempIdMappings() {
  await db.tempIdMap.clear();
}

// Calendar events local storage
export async function saveLocalCalendarEvents(date: string, events: LocalCalendarEvent[]) {
  await db.calendarDays.put({
    date,
    events,
    updatedAt: Date.now()
  });
}

export async function getLocalCalendarEvents(date: string): Promise<LocalCalendarEvent[] | undefined> {
  const day = await db.calendarDays.get(date);
  return day?.events;
}

export async function getLocalCalendarEventsForRange(startDate: string, endDate: string): Promise<Record<string, LocalCalendarEvent[]>> {
  const days = await db.calendarDays
    .where('date')
    .between(startDate, endDate, true, true)
    .toArray();

  const result: Record<string, LocalCalendarEvent[]> = {};
  for (const day of days) {
    result[day.date] = day.events;
  }
  return result;
}
