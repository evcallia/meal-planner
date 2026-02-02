import Dexie, { Table } from 'dexie';

export interface LocalMealNote {
  date: string;
  notes: string;
  items: { line_index: number; itemized: boolean }[];
  updatedAt: number;
  synced: boolean;
}

export interface PendingChange {
  id?: number;
  type: 'notes' | 'itemized';
  date: string;
  payload: unknown;
  createdAt: number;
}

class MealPlannerDB extends Dexie {
  mealNotes!: Table<LocalMealNote, string>;
  pendingChanges!: Table<PendingChange, number>;

  constructor() {
    super('MealPlannerDB');
    this.version(1).stores({
      mealNotes: 'date',
      pendingChanges: '++id, date, type'
    });
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

// Queue a change for sync
export async function queueChange(type: 'notes' | 'itemized', date: string, payload: unknown) {
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
