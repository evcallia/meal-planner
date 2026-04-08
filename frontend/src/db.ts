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
  | 'pantry-replace'
  | 'pantry-create-section'
  | 'pantry-delete-section'
  | 'pantry-reorder-sections'
  | 'pantry-reorder-items'
  | 'pantry-rename-section'
  | 'meal-idea-add'
  | 'meal-idea-update'
  | 'meal-idea-delete'
  | 'calendar-hide'
  | 'calendar-unhide'
  | 'grocery-replace'
  | 'grocery-create-section'
  | 'grocery-check'
  | 'grocery-add'
  | 'grocery-delete'
  | 'grocery-edit'
  | 'grocery-clear'
  | 'grocery-reorder-sections'
  | 'grocery-reorder-items'
  | 'grocery-rename-section'
  | 'grocery-move-item'
  | 'grocery-delete-section'
  | 'pantry-move-item'
  | 'store-create'
  | 'store-rename'
  | 'store-delete'
  | 'store-reorder';

export interface PendingChange {
  id?: number;
  type: ChangeType;
  date: string;
  payload: unknown;
  createdAt: number;
}

export interface LocalPantrySection {
  id: string;
  name: string;
  position: number;
}

export interface LocalPantryItem {
  id: string;
  section_id: string;
  name: string;
  quantity: number;
  position: number;
  updated_at: string;
}

export interface LocalMealIdea {
  id: string;
  title: string;
  updated_at: string;
}

export interface LocalGrocerySection {
  id: string;
  name: string;
  position: number;
}

export interface LocalStore {
  id: string;
  name: string;
  position: number;
}

export interface LocalGroceryItem {
  id: string;
  section_id: string;
  name: string;
  quantity: string | null;
  checked: boolean;
  position: number;
  store_id: string | null;
  updated_at: string;
}

export interface LocalCalendarEvent {
  id?: string;
  uid?: string | null;
  calendar_name?: string | null;
  title: string;
  start_time: string;
  end_time: string | null;
  all_day: boolean;
}

export interface LocalHiddenCalendarEvent {
  id: string;
  event_uid: string;
  event_date: string;
  calendar_name: string;
  title: string;
  start_time: string;
  end_time: string | null;
  all_day: boolean;
  updatedAt: number;
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
  pantrySections!: Table<LocalPantrySection, string>;
  mealIdeas!: Table<LocalMealIdea, string>;
  tempIdMap!: Table<{ tempId: string; realId: string }, string>;
  calendarDays!: Table<LocalCalendarDay, string>;
  hiddenCalendarEvents!: Table<LocalHiddenCalendarEvent, string>;
  grocerySections!: Table<LocalGrocerySection, string>;
  groceryItems!: Table<LocalGroceryItem, string>;
  stores!: Table<LocalStore, string>;

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
    this.version(4).stores({
      mealNotes: 'date',
      pendingChanges: '++id, date, type',
      pantryItems: 'id',
      mealIdeas: 'id',
      tempIdMap: 'tempId',
      calendarDays: 'date',
      hiddenCalendarEvents: 'id'
    });
    this.version(5).stores({
      mealNotes: 'date',
      pendingChanges: '++id, date, type',
      pantryItems: 'id',
      mealIdeas: 'id',
      tempIdMap: 'tempId',
      calendarDays: 'date',
      hiddenCalendarEvents: 'id',
      grocerySections: 'id',
      groceryItems: 'id, section_id'
    });
    this.version(6).stores({
      mealNotes: 'date',
      pendingChanges: '++id, date, type',
      pantryItems: 'id, section_id',
      pantrySections: 'id',
      mealIdeas: 'id',
      tempIdMap: 'tempId',
      calendarDays: 'date',
      hiddenCalendarEvents: 'id',
      grocerySections: 'id',
      groceryItems: 'id, section_id'
    });
    this.version(7).stores({
      mealNotes: 'date',
      pendingChanges: '++id, date, type',
      pantryItems: 'id, section_id',
      pantrySections: 'id',
      mealIdeas: 'id',
      tempIdMap: 'tempId',
      calendarDays: 'date',
      hiddenCalendarEvents: 'id',
      grocerySections: 'id',
      groceryItems: 'id, section_id',
      stores: 'id',
    });
    // Ensure table properties are initialized for both runtime and tests.
    this.mealNotes = this.table('mealNotes');
    this.pendingChanges = this.table('pendingChanges');
    this.pantryItems = this.table('pantryItems');
    this.pantrySections = this.table('pantrySections');
    this.mealIdeas = this.table('mealIdeas');
    this.tempIdMap = this.table('tempIdMap');
    this.calendarDays = this.table('calendarDays');
    this.hiddenCalendarEvents = this.table('hiddenCalendarEvents');
    this.grocerySections = this.table('grocerySections');
    this.groceryItems = this.table('groceryItems');
    this.stores = this.table('stores');
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

// Remove pending changes that reference a specific temp ID in their payload
export async function removePendingChangesForTempId(tempId: string) {
  const all = await db.pendingChanges.toArray();
  for (const change of all) {
    const payload = change.payload as Record<string, unknown> | undefined;
    if (payload && payload.id === tempId && change.id) {
      await db.pendingChanges.delete(change.id);
    }
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

// Pantry sections local storage
export async function saveLocalPantrySections(sections: LocalPantrySection[]) {
  await db.pantrySections.clear();
  if (sections.length > 0) {
    await db.pantrySections.bulkPut(sections);
  }
}

export async function getLocalPantrySections(): Promise<LocalPantrySection[]> {
  return db.pantrySections.orderBy('position').toArray();
}

export async function saveLocalPantrySection(section: LocalPantrySection) {
  await db.pantrySections.put(section);
}

// Pantry items local storage
export async function saveLocalPantryItems(items: LocalPantryItem[]) {
  await db.pantryItems.clear();
  if (items.length > 0) {
    await db.pantryItems.bulkPut(items);
  }
}

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

// Get the most recent calendar cache timestamp
export async function getCalendarCacheTimestamp(): Promise<number | null> {
  const days = await db.calendarDays.toArray();
  if (days.length === 0) return null;
  return Math.max(...days.map(d => d.updatedAt));
}

// Hidden calendar events local storage
export async function saveLocalHiddenEvent(event: Omit<LocalHiddenCalendarEvent, 'updatedAt'> & { updatedAt?: number }) {
  await db.hiddenCalendarEvents.put({
    ...event,
    updatedAt: event.updatedAt ?? Date.now(),
  });
}

export async function saveLocalHiddenEvents(events: Array<Omit<LocalHiddenCalendarEvent, 'updatedAt'> & { updatedAt?: number }>) {
  const records = events.map(event => ({
    ...event,
    updatedAt: event.updatedAt ?? Date.now(),
  }));
  await db.hiddenCalendarEvents.bulkPut(records);
}

export async function getLocalHiddenEvents(): Promise<LocalHiddenCalendarEvent[]> {
  return db.hiddenCalendarEvents.toArray();
}

export async function deleteLocalHiddenEvent(id: string) {
  await db.hiddenCalendarEvents.delete(id);
}

export async function clearLocalHiddenEvents() {
  await db.hiddenCalendarEvents.clear();
}

export async function updateLocalHiddenEventId(
  tempId: string,
  event: Omit<LocalHiddenCalendarEvent, 'updatedAt'> & { updatedAt?: number },
) {
  await db.hiddenCalendarEvents.delete(tempId);
  await saveLocalHiddenEvent(event);
}

// Grocery local storage
export async function saveLocalGrocerySections(sections: LocalGrocerySection[]) {
  await db.grocerySections.clear();
  if (sections.length > 0) {
    await db.grocerySections.bulkPut(sections);
  }
}

export async function getLocalGrocerySections(): Promise<LocalGrocerySection[]> {
  return db.grocerySections.orderBy('position').toArray();
}

export async function saveLocalGroceryItems(items: LocalGroceryItem[]) {
  await db.groceryItems.clear();
  if (items.length > 0) {
    await db.groceryItems.bulkPut(items);
  }
}

export async function getLocalGroceryItems(): Promise<LocalGroceryItem[]> {
  return db.groceryItems.toArray();
}

export async function getLocalGroceryItemsBySection(sectionId: string): Promise<LocalGroceryItem[]> {
  return db.groceryItems.where('section_id').equals(sectionId).toArray();
}

export async function saveLocalGroceryItem(item: LocalGroceryItem) {
  await db.groceryItems.put(item);
}

export async function deleteLocalGroceryItem(id: string) {
  await db.groceryItems.delete(id);
}

export async function saveLocalGrocerySection(section: LocalGrocerySection) {
  await db.grocerySections.put(section);
}

// Store persistence
export async function saveLocalStores(stores: LocalStore[]): Promise<void> {
  await db.stores.clear();
  if (stores.length > 0) await db.stores.bulkPut(stores);
}

export async function getLocalStores(): Promise<LocalStore[]> {
  return db.stores.orderBy('position').toArray();
}

export async function clearAllLocalData(): Promise<void> {
  await Promise.all([
    db.mealNotes.clear(),
    db.pendingChanges.clear(),
    db.pantryItems.clear(),
    db.pantrySections.clear(),
    db.mealIdeas.clear(),
    db.tempIdMap.clear(),
    db.calendarDays.clear(),
    db.hiddenCalendarEvents.clear(),
    db.grocerySections.clear(),
    db.groceryItems.clear(),
    db.stores.clear(),
  ]);
}
