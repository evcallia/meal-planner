import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { PackingList, PackingSection, PackingItem, PackingBag, Store } from '../types';
import {
  getPackingLists,
  createPackingList as createPackingListAPI,
  restorePackingList as restorePackingListAPI,
  updatePackingList as updatePackingListAPI,
  deletePackingList as deletePackingListAPI,
  reorderPackingLists as reorderPackingListsAPI,
  addPackingShare as addPackingShareAPI,
  removePackingShare as removePackingShareAPI,
  leavePackingList as leavePackingListAPI,
  checkAllPackingItems as checkAllPackingItemsAPI,
  createPackingSection as createPackingSectionAPI,
  renamePackingSection as renamePackingSectionAPI,
  deletePackingSection as deletePackingSectionAPI,
  reorderPackingSections as reorderPackingSectionsAPI,
  reorderPackingItems as reorderPackingItemsAPI,
  addPackingItem as addPackingItemAPI,
  editPackingItem as editPackingItemAPI,
  deletePackingItem as deletePackingItemAPI,
  movePackingItem as movePackingItemAPI,
  createPackingBag as createPackingBagAPI,
  renamePackingBag as renamePackingBagAPI,
  deletePackingBag as deletePackingBagAPI,
  reorderPackingBags as reorderPackingBagsAPI,
} from '../api/client';
import {
  saveLocalPackingLists,
  saveLocalPackingBags,
  saveLocalPackingSections,
  saveLocalPackingItems,
  getLocalPackingLists,
  getLocalPackingBags,
  getLocalPackingSections,
  getLocalPackingItems,
  queueChange,
  generateTempId,
  saveTempIdMapping,
  removePendingChangesForTempId,
  isTempId,
} from '../db';
import { useOnlineStatus } from './useOnlineStatus';
import { useUndo } from '../contexts/UndoContext';
import { useIdRemap } from './useIdRemap';
import { toTitleCase } from '../utils/titleCase';
import { orderSectionItems } from '../utils/packing';

// Travel / packing lists. One hook owns every list the user can see (like
// useTracker) plus the sectioned-checklist mutations (like useGroceryList),
// each optimistic → IndexedDB → API-or-queue → undoable.
//
// Invariant that the whole feature rests on: an item's `position` is NEVER
// changed by checking it. Ordering is (checked, position), so unchecking
// restores the slot the user arranged.

// Survives remounts (tab switches) — SSE keeps the cache warm, so a remount
// reads the cache instead of refetching.
let packingSessionLoaded = false;
export function resetPackingSessionLoaded() { packingSessionLoaded = false; }
export function markPackingSessionLoaded() { packingSessionLoaded = true; }

// Module-level dispatch so undo closures from a previous mount still update
// the current mount's state (same pattern as the other undo-capable hooks).
let _livePackingDispatch: React.Dispatch<React.SetStateAction<PackingList[]>> | null = null;

export interface ItemSuggestion {
  bagName: string | null;
  sectionName: string | null;
}

interface PackingSSEPayload {
  action?: string;
  listId?: string;
  list?: PackingList;
  section?: PackingSection;
  sectionId?: string;
  item?: PackingItem;
  itemId?: string;
  fromSectionId?: string;
  toSectionId?: string;
  bag?: PackingBag;
  bagId?: string;
  bags?: { id: string; position: number }[];
  sections?: { id: string; position: number }[];
  items?: { id: string; position: number }[];
  name?: string;
  position?: number;
}

// ----- pure state transforms -----

const withList = (lists: PackingList[], listId: string, fn: (l: PackingList) => PackingList) =>
  lists.map(l => (l.id === listId ? fn(l) : l));

const withSection = (list: PackingList, sectionId: string, fn: (s: PackingSection) => PackingSection): PackingList => ({
  ...list,
  sections: list.sections.map(s => (s.id === sectionId ? fn(s) : s)),
});

const sortLists = (lists: PackingList[]) => [...lists].sort((a, b) => a.position - b.position);

const normalizeList = (list: PackingList): PackingList => ({
  ...list,
  bags: [...list.bags].sort((a, b) => a.position - b.position),
  sections: [...list.sections]
    .sort((a, b) => a.position - b.position)
    .map(s => ({ ...s, items: orderSectionItems(s.items) })),
});

export function usePacking() {
  const [lists, _setLists] = useState<PackingList[]>([]);
  _livePackingDispatch = _setLists;
  const [loading, setLoading] = useState(true);
  const isOnline = useOnlineStatus();
  const { pushAction } = useUndo();
  const { resolveId, resolveIdAsync, remapId } = useIdRemap();

  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  // listsRef is kept in sync SYNCHRONOUSLY by setLists, not just on render:
  // mutations chain across awaits (createSection → addItem, apply → sync) and
  // React hasn't re-rendered in between, so reading component state there
  // would miss the update that just happened.
  const listsRef = useRef(lists);
  listsRef.current = lists;

  const setLists = useCallback<typeof _setLists>((action) => {
    listsRef.current = typeof action === 'function'
      ? (action as (prev: PackingList[]) => PackingList[])(listsRef.current)
      : action;
    _livePackingDispatch?.(listsRef.current);
  }, []);

  // Discard server responses that landed after a newer local edit.
  const optimisticVersionRef = useRef(0);
  const pendingMutationsRef = useRef(0);
  const deferredLoadRef = useRef(false);
  // Don't let the persist effect wipe IndexedDB with the empty initial state.
  const hydratedRef = useRef(false);

  const loadPacking = useCallback(async (skipApi = false) => {
    const fetchVersion = optimisticVersionRef.current;
    try {
      const [localLists, localBags, localSections, localItems] = await Promise.all([
        getLocalPackingLists(), getLocalPackingBags(), getLocalPackingSections(), getLocalPackingItems(),
      ]);
      if (optimisticVersionRef.current !== fetchVersion) return;
      if (localLists.length > 0) {
        const assembled: PackingList[] = localLists.map(l => normalizeList({
          ...l,
          bags: localBags.filter(b => b.list_id === l.id),
          sections: localSections
            .filter(s => s.list_id === l.id)
            .map(s => ({ ...s, items: localItems.filter(i => i.section_id === s.id) })),
        }));
        hydratedRef.current = true;
        setLists(sortLists(assembled));
        setLoading(false);
      }
    } catch { /* cache miss — fall through to the API */ }

    if (!skipApi && isOnlineRef.current) {
      try {
        const data = await getPackingLists();
        if (optimisticVersionRef.current !== fetchVersion) return;
        hydratedRef.current = true;
        setLists(sortLists(data.map(normalizeList)));
        packingSessionLoaded = true;
      } catch { /* keep whatever the cache gave us */ }
    }
    hydratedRef.current = true;
    setLoading(false);
  }, [setLists]);

  const loadPackingRef = useRef(loadPacking);
  loadPackingRef.current = loadPacking;

  const settleMutation = useCallback(() => {
    pendingMutationsRef.current--;
    if (pendingMutationsRef.current === 0 && deferredLoadRef.current) {
      deferredLoadRef.current = false;
      loadPackingRef.current();
    }
  }, []);

  useEffect(() => {
    loadPacking(packingSessionLoaded);
  }, [loadPacking]);

  // Mirror state into IndexedDB so the tab works offline.
  useEffect(() => {
    if (!hydratedRef.current) return;
    void saveLocalPackingLists(lists.map(l => ({
      id: l.id, name: l.name, icon: l.icon, color: l.color, position: l.position,
      owner_sub: l.owner_sub, owner_name: l.owner_name, is_owner: l.is_owner, shared_with: l.shared_with,
    }))).catch(() => {});
    void saveLocalPackingBags(lists.flatMap(l => l.bags.map(b => ({
      id: b.id, list_id: l.id, name: b.name, position: b.position,
    })))).catch(() => {});
    void saveLocalPackingSections(lists.flatMap(l => l.sections.map(s => ({
      id: s.id, list_id: l.id, name: s.name, position: s.position,
    })))).catch(() => {});
    void saveLocalPackingItems(lists.flatMap(l => l.sections.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: s.id, name: i.name, quantity: i.quantity,
      checked: i.checked, position: i.position, bag_id: i.bag_id, updated_at: i.updated_at,
    }))))).catch(() => {});
  }, [lists]);

  // ----- realtime -----

  const applyRealtimeEvent = useCallback((payload: PackingSSEPayload) => {
    if (!payload?.action) {
      loadPackingRef.current();
      return;
    }
    const listId = payload.listId ?? '';
    switch (payload.action) {
      case 'list-added':
      case 'list-updated':
      case 'list-shared':
      case 'checked-all':
        if (payload.list) {
          const incoming = normalizeList(payload.list);
          setLists(prev => sortLists(
            prev.some(l => l.id === incoming.id)
              ? prev.map(l => (l.id === incoming.id ? incoming : l))
              : [...prev, incoming],
          ));
        }
        break;
      case 'list-deleted':
        setLists(prev => prev.filter(l => l.id !== listId));
        break;
      case 'list-reordered':
        if (payload.position !== undefined) {
          setLists(prev => sortLists(prev.map(l => (l.id === listId ? { ...l, position: payload.position! } : l))));
        }
        break;
      case 'section-added':
        if (payload.section) {
          setLists(prev => withList(prev, listId, l => (
            l.sections.some(s => s.id === payload.section!.id)
              ? l
              : { ...l, sections: [...l.sections, { ...payload.section!, items: payload.section!.items ?? [] }].sort((a, b) => a.position - b.position) }
          )));
        }
        break;
      case 'section-renamed':
        if (payload.sectionId && payload.name) {
          setLists(prev => withList(prev, listId, l => withSection(l, payload.sectionId!, s => ({ ...s, name: payload.name! }))));
        }
        break;
      case 'section-deleted':
        setLists(prev => withList(prev, listId, l => ({ ...l, sections: l.sections.filter(s => s.id !== payload.sectionId) })));
        break;
      case 'sections-reordered':
        if (payload.sections) {
          const pos = new Map(payload.sections.map(s => [s.id, s.position]));
          setLists(prev => withList(prev, listId, l => ({
            ...l,
            sections: l.sections.map(s => (pos.has(s.id) ? { ...s, position: pos.get(s.id)! } : s))
              .sort((a, b) => a.position - b.position),
          })));
        }
        break;
      case 'items-reordered':
        if (payload.sectionId && payload.items) {
          const pos = new Map(payload.items.map(i => [i.id, i.position]));
          setLists(prev => withList(prev, listId, l => withSection(l, payload.sectionId!, s => ({
            ...s,
            items: orderSectionItems(s.items.map(i => (pos.has(i.id) ? { ...i, position: pos.get(i.id)! } : i))),
          }))));
        }
        break;
      case 'item-added':
        if (payload.sectionId && payload.item) {
          setLists(prev => withList(prev, listId, l => withSection(l, payload.sectionId!, s => (
            s.items.some(i => i.id === payload.item!.id)
              ? s
              : { ...s, items: orderSectionItems([...s.items, payload.item!]) }
          ))));
        }
        break;
      case 'item-updated':
        if (payload.item) {
          setLists(prev => withList(prev, listId, l => ({
            ...l,
            sections: l.sections.map(s => (
              s.items.some(i => i.id === payload.item!.id)
                ? { ...s, items: orderSectionItems(s.items.map(i => (i.id === payload.item!.id ? payload.item! : i))) }
                : s
            )),
          })));
        }
        break;
      case 'item-deleted':
        setLists(prev => withList(prev, listId, l => ({
          ...l,
          sections: l.sections.map(s => ({ ...s, items: s.items.filter(i => i.id !== payload.itemId) })),
        })));
        break;
      case 'item-moved':
        if (payload.item && payload.fromSectionId && payload.toSectionId) {
          setLists(prev => withList(prev, listId, l => ({
            ...l,
            sections: l.sections.map(s => {
              if (s.id === payload.fromSectionId) return { ...s, items: s.items.filter(i => i.id !== payload.item!.id) };
              if (s.id === payload.toSectionId) {
                if (s.items.some(i => i.id === payload.item!.id)) return s;
                return { ...s, items: orderSectionItems([...s.items, payload.item!]) };
              }
              return s;
            }),
          })));
        }
        break;
      case 'bag-added':
        if (payload.bag) {
          setLists(prev => withList(prev, listId, l => (
            l.bags.some(b => b.id === payload.bag!.id)
              ? l
              : { ...l, bags: [...l.bags, payload.bag!].sort((a, b) => a.position - b.position) }
          )));
        }
        break;
      case 'bag-updated':
        if (payload.bag) {
          setLists(prev => withList(prev, listId, l => ({
            ...l, bags: l.bags.map(b => (b.id === payload.bag!.id ? payload.bag! : b)),
          })));
        }
        break;
      case 'bag-deleted':
        setLists(prev => withList(prev, listId, l => ({
          ...l,
          bags: l.bags.filter(b => b.id !== payload.bagId),
          sections: l.sections.map(s => ({
            ...s, items: s.items.map(i => (i.bag_id === payload.bagId ? { ...i, bag_id: null } : i)),
          })),
        })));
        break;
      case 'bags-reordered':
        if (payload.bags) {
          const pos = new Map(payload.bags.map(b => [b.id, b.position]));
          setLists(prev => withList(prev, listId, l => ({
            ...l,
            bags: l.bags.map(b => (pos.has(b.id) ? { ...b, position: pos.get(b.id)! } : b))
              .sort((a, b) => a.position - b.position),
          })));
        }
        break;
      default:
        loadPackingRef.current();
    }
  }, [setLists]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { detail } = e as CustomEvent;
      if (detail?.type !== 'packing.updated') return;
      if (pendingMutationsRef.current > 0) {
        deferredLoadRef.current = true;
        return;
      }
      applyRealtimeEvent(detail.payload as PackingSSEPayload);
    };
    window.addEventListener('meal-planner-realtime', handler);
    return () => window.removeEventListener('meal-planner-realtime', handler);
  }, [applyRealtimeEvent]);

  useEffect(() => {
    const handler = () => loadPacking();
    window.addEventListener('pending-changes-synced', handler);
    return () => window.removeEventListener('pending-changes-synced', handler);
  }, [loadPacking]);

  // ----- mutation plumbing -----

  /**
   * The single mutation shape: bump the optimistic version and raise the
   * pending-refetch guard SYNCHRONOUSLY (any await between them would let an
   * SSE-triggered refetch overwrite the optimistic state), apply locally, then
   * sync or queue. `settle` always runs.
   */
  const run = useCallback(async (
    apply: () => void,
    sync: () => Promise<void>,
    queue: () => Promise<void>,
  ) => {
    optimisticVersionRef.current++;
    pendingMutationsRef.current++;
    apply();
    try {
      if (isOnlineRef.current) {
        try { await sync(); } catch { await queue(); }
      } else {
        await queue();
      }
    } finally {
      settleMutation();
    }
  }, [settleMutation]);

  const findList = (listId: string) => listsRef.current.find(l => l.id === listId);

  // ----- lists -----

  const createList = useCallback(async (name: string, color: string | null = null): Promise<string> => {
    const tempId = generateTempId();
    const trimmed = name.trim();
    const position = listsRef.current.length;
    const optimistic: PackingList = {
      id: tempId, name: trimmed, icon: null, color, position,
      owner_sub: '', owner_name: null, is_owner: true, shared_with: [], bags: [], sections: [],
    };
    const ref = { id: tempId };
    await run(
      () => setLists(prev => [...prev, optimistic]),
      async () => {
        const created = await createPackingListAPI({ name: trimmed, color });
        ref.id = created.id;
        remapId(tempId, created.id);
        await saveTempIdMapping(tempId, created.id);
        setLists(prev => prev.map(l => (l.id === tempId ? normalizeList(created) : l)));
      },
      () => queueChange('packing-list-create', '', { tempId, name: trimmed, color }),
    );

    pushAction({
      type: 'packing-create-list',
      undo: async () => {
        const currentId = resolveId(ref.id);
        await run(
          () => setLists(prev => prev.filter(l => l.id !== currentId)),
          async () => { await deletePackingListAPI(await resolveIdAsync(currentId)); },
          async () => {
            // Never synced? Drop the queued create instead of queueing a delete.
            if (isTempId(currentId)) await removePendingChangesForTempId(currentId);
            else await queueChange('packing-list-delete', '', { id: currentId });
          },
        );
      },
      redo: async () => {
        await run(
          () => setLists(prev => [...prev, { ...optimistic, id: ref.id }]),
          async () => {
            const created = await createPackingListAPI({ name: trimmed, color });
            remapId(ref.id, created.id);
            const oldId = ref.id;
            ref.id = created.id;
            setLists(prev => prev.map(l => (l.id === oldId ? normalizeList(created) : l)));
          },
          () => queueChange('packing-list-create', '', { tempId: ref.id, name: trimmed, color }),
        );
      },
    });
    return ref.id;
  }, [run, setLists, pushAction, remapId, resolveId, resolveIdAsync]);

  const updateListCore = useCallback((listId: string, updates: { name?: string; color?: string | null }) =>
    run(
      () => setLists(prev => withList(prev, listId, l => ({ ...l, ...updates }))),
      async () => { await updatePackingListAPI(await resolveIdAsync(listId), updates); },
      () => queueChange('packing-list-update', '', { id: listId, ...updates }),
    ), [run, setLists, resolveIdAsync]);

  const updateList = useCallback(async (listId: string, updates: { name?: string; color?: string | null }) => {
    const list = findList(listId);
    if (!list) return;
    const before = {
      ...(updates.name !== undefined ? { name: list.name } : {}),
      ...(updates.color !== undefined ? { color: list.color } : {}),
    };
    await updateListCore(listId, updates);
    pushAction({
      type: 'packing-update-list',
      undo: () => updateListCore(resolveId(listId), before),
      redo: () => updateListCore(resolveId(listId), updates),
    });
  }, [updateListCore, pushAction, resolveId]);

  // A deleted list is restored from a full snapshot: the server reissues every
  // id, so the snapshot references bags by name and we remap ids afterwards.
  const restoreListFromSnapshot = useCallback(async (snapshot: PackingList) => {
    const bagNameById = new Map(snapshot.bags.map(b => [b.id, b.name]));
    const payload = {
      name: snapshot.name,
      icon: snapshot.icon,
      color: snapshot.color,
      position: snapshot.position,
      share_subs: snapshot.shared_with.map(u => u.sub),
      bags: snapshot.bags.map(b => ({ name: b.name, position: b.position })),
      sections: snapshot.sections.map(s => ({
        name: s.name,
        position: s.position,
        items: s.items.map(i => ({
          name: i.name, quantity: i.quantity, checked: i.checked, position: i.position,
          bag_name: i.bag_id ? bagNameById.get(i.bag_id) ?? null : null,
        })),
      })),
    };
    const tempListId = generateTempId();
    await run(
      () => setLists(prev => sortLists([...prev, { ...snapshot, id: tempListId }])),
      async () => {
        const restored = await restorePackingListAPI(payload);
        remapId(snapshot.id, restored.id);
        remapId(tempListId, restored.id);
        await saveTempIdMapping(tempListId, restored.id);
        // Chain old→new for bags/sections/items so older undo entries resolve.
        for (const bag of restored.bags) {
          const old = snapshot.bags.find(b => b.name === bag.name);
          if (old) remapId(old.id, bag.id);
        }
        for (const section of restored.sections) {
          const oldSection = snapshot.sections.find(s => s.position === section.position);
          if (!oldSection) continue;
          remapId(oldSection.id, section.id);
          for (const item of section.items) {
            const oldItem = oldSection.items.find(i => i.position === item.position && i.name === item.name);
            if (oldItem) remapId(oldItem.id, item.id);
          }
        }
        setLists(prev => sortLists(prev.map(l => (l.id === tempListId ? normalizeList(restored) : l))));
      },
      () => queueChange('packing-list-restore', '', { tempListId, ...payload }),
    );
  }, [run, setLists, remapId]);

  const deleteList = useCallback(async (listId: string) => {
    const snapshot = findList(listId);
    if (!snapshot) return;
    // Push undo first so the snackbar works immediately.
    pushAction({
      type: 'packing-delete-list',
      undo: () => restoreListFromSnapshot(snapshot),
      redo: async () => {
        const currentId = resolveId(snapshot.id);
        await run(
          () => setLists(prev => prev.filter(l => l.id !== currentId)),
          async () => { await deletePackingListAPI(await resolveIdAsync(currentId)); },
          () => queueChange('packing-list-delete', '', { id: currentId }),
        );
      },
    });
    await run(
      () => setLists(prev => prev.filter(l => l.id !== listId)),
      async () => { await deletePackingListAPI(await resolveIdAsync(listId)); },
      async () => {
        if (isTempId(listId)) await removePendingChangesForTempId(listId);
        else await queueChange('packing-list-delete', '', { id: listId });
      },
    );
  }, [run, setLists, pushAction, resolveId, resolveIdAsync, restoreListFromSnapshot]);

  const reorderListsCore = useCallback((orderedIds: string[]) =>
    run(
      () => setLists(prev => {
        const rank = new Map(orderedIds.map((id, i) => [id, i]));
        return sortLists(prev.map(l => (rank.has(l.id) ? { ...l, position: rank.get(l.id)! } : l)));
      }),
      async () => {
        const real = await Promise.all(orderedIds.map(id => resolveIdAsync(id)));
        await reorderPackingListsAPI(real);
      },
      () => queueChange('packing-list-reorder', '', { listIds: orderedIds }),
    ), [run, setLists, resolveIdAsync]);

  const reorderLists = useCallback(async (orderedIds: string[]) => {
    const prevOrder = sortLists(listsRef.current).map(l => l.id);
    await reorderListsCore(orderedIds);
    pushAction({
      type: 'packing-reorder-lists',
      undo: () => reorderListsCore(prevOrder.map(id => resolveId(id))),
      redo: () => reorderListsCore(orderedIds.map(id => resolveId(id))),
    });
  }, [reorderListsCore, pushAction, resolveId]);

  // Sharing needs the server (it resolves people), so there's no offline path.
  const shareList = useCallback(async (listId: string, target: { email?: string; sub?: string }) => {
    const updated = await addPackingShareAPI(await resolveIdAsync(listId), target);
    optimisticVersionRef.current++;
    setLists(prev => withList(prev, listId, () => normalizeList(updated)));
  }, [setLists, resolveIdAsync]);

  const unshareList = useCallback(async (listId: string, sub: string) => {
    const updated = await removePackingShareAPI(await resolveIdAsync(listId), sub);
    optimisticVersionRef.current++;
    setLists(prev => withList(prev, listId, () => normalizeList(updated)));
  }, [setLists, resolveIdAsync]);

  const leaveList = useCallback(async (listId: string) => {
    await run(
      () => setLists(prev => prev.filter(l => l.id !== listId)),
      async () => { await leavePackingListAPI(await resolveIdAsync(listId)); },
      () => queueChange('packing-list-leave', '', { id: listId }),
    );
  }, [run, setLists, resolveIdAsync]);

  // ----- bulk check -----

  const setAllChecked = useCallback(async (listId: string, checked: boolean) => {
    const list = findList(listId);
    if (!list) return;
    const snapshot = new Map(list.sections.flatMap(s => s.items.map(i => [i.id, i.checked] as const)));

    const applyAll = (value: boolean) => setLists(prev => withList(prev, listId, l => ({
      ...l,
      sections: l.sections.map(s => ({ ...s, items: orderSectionItems(s.items.map(i => ({ ...i, checked: value }))) })),
    })));

    await run(
      () => applyAll(checked),
      async () => { await checkAllPackingItemsAPI(await resolveIdAsync(listId), checked); },
      () => queueChange('packing-check-all', '', { listId, checked }),
    );

    pushAction({
      type: 'packing-check-all',
      undo: async () => {
        // Restore the exact prior mix: bulk-set the majority value, then patch
        // the minority item by item.
        const values = [...snapshot.values()];
        const majority = values.filter(Boolean).length * 2 >= values.length;
        const exceptions = [...snapshot.entries()].filter(([, v]) => v !== majority).map(([id]) => id);
        await run(
          () => setLists(prev => withList(prev, listId, l => ({
            ...l,
            sections: l.sections.map(s => ({
              ...s,
              items: orderSectionItems(s.items.map(i => (snapshot.has(i.id) ? { ...i, checked: snapshot.get(i.id)! } : i))),
            })),
          }))),
          async () => {
            const realListId = await resolveIdAsync(listId);
            await checkAllPackingItemsAPI(realListId, majority);
            for (const id of exceptions) {
              await editPackingItemAPI(await resolveIdAsync(id), { checked: !majority });
            }
          },
          async () => {
            await queueChange('packing-check-all', '', { listId, checked: majority });
            for (const id of exceptions) {
              await queueChange('packing-item-edit', '', { id, checked: !majority });
            }
          },
        );
      },
      redo: async () => {
        await run(
          () => applyAll(checked),
          async () => { await checkAllPackingItemsAPI(await resolveIdAsync(listId), checked); },
          () => queueChange('packing-check-all', '', { listId, checked }),
        );
      },
    });
  }, [run, setLists, pushAction, resolveIdAsync]);

  // ----- sections -----

  const createSectionCore = useCallback(async (
    listId: string, name: string, position: number, ref: { id: string },
  ) => {
    const tempId = ref.id;
    const optimistic: PackingSection = { id: tempId, list_id: listId, name, position, items: [] };
    await run(
      () => setLists(prev => withList(prev, listId, l => ({
        ...l, sections: [...l.sections, optimistic].sort((a, b) => a.position - b.position),
      }))),
      async () => {
        const created = await createPackingSectionAPI(await resolveIdAsync(listId), name, position);
        remapId(tempId, created.id);
        await saveTempIdMapping(tempId, created.id);
        ref.id = created.id;
        setLists(prev => withList(prev, listId, l => ({
          ...l, sections: l.sections.map(s => (s.id === tempId ? { ...created, items: s.items } : s)),
        })));
      },
      () => queueChange('packing-section-create', '', { tempId, listId, name, position }),
    );
  }, [run, setLists, remapId, resolveIdAsync]);

  /** Creates a section without an undo entry — callers that chain a further
   *  mutation (e.g. moving an item into a brand-new section) own the undo. */
  const createSection = useCallback(async (listId: string, name: string): Promise<PackingSection | null> => {
    const list = findList(listId);
    if (!list) return null;
    const trimmed = toTitleCase(name.trim());
    const existing = list.sections.find(s => s.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    const ref = { id: generateTempId() };
    const position = list.sections.length;
    await createSectionCore(listId, trimmed, position, ref);
    return findList(listId)?.sections.find(s => s.id === ref.id)
      ?? { id: ref.id, list_id: listId, name: trimmed, position, items: [] };
  }, [createSectionCore]);

  const addSection = useCallback(async (listId: string, name: string) => {
    const list = findList(listId);
    if (!list) return;
    const trimmed = toTitleCase(name.trim());
    if (!trimmed || list.sections.some(s => s.name.toLowerCase() === trimmed.toLowerCase())) return;
    const ref = { id: generateTempId() };
    const position = list.sections.length;
    await createSectionCore(listId, trimmed, position, ref);
    pushAction({
      type: 'packing-add-section',
      undo: async () => {
        const currentId = resolveId(ref.id);
        await run(
          () => setLists(prev => withList(prev, listId, l => ({ ...l, sections: l.sections.filter(s => s.id !== currentId) }))),
          async () => { await deletePackingSectionAPI(await resolveIdAsync(currentId)); },
          async () => {
            if (isTempId(currentId)) await removePendingChangesForTempId(currentId);
            else await queueChange('packing-section-delete', '', { sectionId: currentId });
          },
        );
      },
      redo: () => createSectionCore(resolveId(listId), trimmed, position, ref),
    });
  }, [createSectionCore, run, setLists, pushAction, resolveId, resolveIdAsync]);

  const renameSectionCore = useCallback((listId: string, sectionId: string, name: string) =>
    run(
      () => setLists(prev => withList(prev, listId, l => withSection(l, sectionId, s => ({ ...s, name })))),
      async () => { await renamePackingSectionAPI(await resolveIdAsync(sectionId), name); },
      () => queueChange('packing-section-rename', '', { sectionId, name }),
    ), [run, setLists, resolveIdAsync]);

  const renameSection = useCallback(async (listId: string, sectionId: string, name: string) => {
    const list = findList(listId);
    const section = list?.sections.find(s => s.id === sectionId);
    const trimmed = toTitleCase(name.trim());
    if (!section || !trimmed || trimmed === section.name) return;
    const prevName = section.name;
    await renameSectionCore(listId, sectionId, trimmed);
    pushAction({
      type: 'packing-rename-section',
      undo: () => renameSectionCore(listId, resolveId(sectionId), prevName),
      redo: () => renameSectionCore(listId, resolveId(sectionId), trimmed),
    });
  }, [renameSectionCore, pushAction, resolveId]);

  const deleteSectionCore = useCallback((listId: string, sectionId: string) =>
    run(
      () => setLists(prev => withList(prev, listId, l => ({ ...l, sections: l.sections.filter(s => s.id !== sectionId) }))),
      async () => { await deletePackingSectionAPI(await resolveIdAsync(sectionId)); },
      async () => {
        // Created and deleted before ever syncing? Drop the queued create.
        if (isTempId(sectionId)) await removePendingChangesForTempId(sectionId);
        else await queueChange('packing-section-delete', '', { sectionId });
      },
    ), [run, setLists, resolveIdAsync]);


  const reorderSectionsCore = useCallback((listId: string, orderedIds: string[]) =>
    run(
      () => setLists(prev => withList(prev, listId, l => {
        const rank = new Map(orderedIds.map((id, i) => [id, i]));
        return {
          ...l,
          sections: l.sections.map(s => (rank.has(s.id) ? { ...s, position: rank.get(s.id)! } : s))
            .sort((a, b) => a.position - b.position),
        };
      })),
      async () => {
        const realList = await resolveIdAsync(listId);
        const real = await Promise.all(orderedIds.map(id => resolveIdAsync(id)));
        await reorderPackingSectionsAPI(realList, real);
      },
      () => queueChange('packing-sections-reorder', '', { listId, sectionIds: orderedIds }),
    ), [run, setLists, resolveIdAsync]);

  const reorderSections = useCallback(async (listId: string, orderedIds: string[]) => {
    const list = findList(listId);
    if (!list) return;
    const prevOrder = [...list.sections].sort((a, b) => a.position - b.position).map(s => s.id);
    await reorderSectionsCore(listId, orderedIds);
    pushAction({
      type: 'packing-reorder-sections',
      undo: () => reorderSectionsCore(listId, prevOrder.map(id => resolveId(id))),
      redo: () => reorderSectionsCore(listId, orderedIds.map(id => resolveId(id))),
    });
  }, [reorderSectionsCore, pushAction, resolveId]);

  // ----- items -----

  const addItemCore = useCallback(async (
    listId: string, sectionId: string, name: string, quantity: string | null,
    bagId: string | null, position: number, checked: boolean, ref: { id: string },
  ) => {
    const tempId = ref.id;
    const optimistic: PackingItem = {
      id: tempId, section_id: sectionId, name, quantity, checked,
      position, bag_id: bagId, updated_at: new Date().toISOString(),
    };
    await run(
      () => setLists(prev => withList(prev, listId, l => withSection(l, sectionId, s => ({
        ...s, items: orderSectionItems([...s.items, optimistic]),
      })))),
      async () => {
        const created = await addPackingItemAPI(await resolveIdAsync(sectionId), name, quantity,
          bagId ? await resolveIdAsync(bagId) : null);
        remapId(tempId, created.id);
        await saveTempIdMapping(tempId, created.id);
        ref.id = created.id;
        // The server appends; restore the intended slot + checked state.
        const settled = { ...created, position, checked };
        setLists(prev => withList(prev, listId, l => withSection(l, sectionId, s => ({
          ...s, items: orderSectionItems(s.items.map(i => (i.id === tempId ? settled : i))),
        }))));
        if (checked) await editPackingItemAPI(created.id, { checked: true });
        // The server appends, so re-send the section's intended order.
        if (created.position !== position) {
          const section = listsRef.current.find(l => l.id === listId)?.sections.find(s => s.id === sectionId);
          if (section) {
            await reorderPackingItemsAPI(await resolveIdAsync(sectionId),
              await Promise.all(orderSectionItems(section.items).map(i => resolveIdAsync(i.id))));
          }
        }
      },
      () => queueChange('packing-item-add', '', { id: tempId, sectionId, name, quantity, bag_id: bagId, checked }),
    );
  }, [run, setLists, remapId, resolveIdAsync]);

  /**
   * Drop a section from local state only. The server prunes a section emptied
   * by an item delete/move on its own, so queueing a delete too would just
   * fail on a row that's already gone.
   */
  const removeSectionLocally = useCallback((listId: string, sectionId: string) => {
    optimisticVersionRef.current++;
    setLists(prev => withList(prev, listId, l => ({
      ...l, sections: l.sections.filter(s => s.id !== sectionId),
    })));
  }, [setLists]);

  const deleteItemCore = useCallback((listId: string, itemId: string) =>
    run(
      () => setLists(prev => withList(prev, listId, l => ({
        ...l, sections: l.sections.map(s => ({ ...s, items: s.items.filter(i => i.id !== itemId) })),
      }))),
      async () => { await deletePackingItemAPI(await resolveIdAsync(itemId)); },
      async () => {
        if (isTempId(itemId)) await removePendingChangesForTempId(itemId);
        else await queueChange('packing-item-delete', '', { id: itemId });
      },
    ), [run, setLists, resolveIdAsync]);

  /**
   * Restore a section and its items (undo of a section delete). Ids are
   * reissued, so old→new is remapped for both the section and every item and
   * the caller's refs are updated in place.
   */
  const restoreSection = useCallback(async (
    listId: string, snapshot: PackingSection, sectionRef: { id: string }, itemRefs: { id: string }[],
  ) => {
    const restoreRef = { id: generateTempId() };
    await createSectionCore(resolveId(listId), snapshot.name, snapshot.position, restoreRef);
    remapId(sectionRef.id, restoreRef.id);
    sectionRef.id = restoreRef.id;
    for (let i = 0; i < snapshot.items.length; i++) {
      const item = snapshot.items[i];
      const ref = { id: generateTempId() };
      await addItemCore(listId, resolveId(sectionRef.id), item.name, item.quantity,
        item.bag_id ? resolveId(item.bag_id) : null, item.position, item.checked, ref);
      if (itemRefs[i]) remapId(itemRefs[i].id, ref.id);
      itemRefs[i] = ref;
    }
  }, [createSectionCore, addItemCore, remapId, resolveId]);

  /** Delete a section AND everything in it; undo puts the whole thing back. */
  const deleteSection = useCallback(async (listId: string, sectionId: string) => {
    const list = findList(listId);
    const section = list?.sections.find(s => s.id === sectionId);
    if (!section) return;
    const snapshot: PackingSection = { ...section, items: orderSectionItems(section.items) };
    const sectionRef = { id: sectionId };
    const itemRefs = snapshot.items.map(i => ({ id: i.id }));
    pushAction({
      type: 'packing-delete-section',
      undo: () => restoreSection(listId, snapshot, sectionRef, itemRefs),
      redo: () => deleteSectionCore(listId, resolveId(sectionRef.id)),
    });
    await deleteSectionCore(listId, sectionId);
  }, [deleteSectionCore, restoreSection, pushAction, resolveId]);

  const addItem = useCallback(async (
    listId: string, sectionId: string, name: string,
    quantity: string | null = null, bagId: string | null = null,
  ) => {
    const list = findList(listId);
    const section = list?.sections.find(s => s.id === sectionId);
    if (!section) return;
    const trimmed = toTitleCase(name.trim());
    if (!trimmed) return;

    // Same name already on the list (unchecked)? Merge the quantities, like grocery.
    const existing = section.items.find(i => !i.checked && i.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      const merged = String((parseInt(existing.quantity || '1') || 1) + (parseInt(quantity || '1') || 1));
      await editItem(listId, existing.id, { quantity: merged });
      return;
    }

    const position = section.items.length > 0 ? Math.max(...section.items.map(i => i.position)) + 1 : 0;
    const ref = { id: generateTempId() };
    await addItemCore(listId, sectionId, trimmed, quantity, bagId, position, false, ref);
    pushAction({
      type: 'packing-add-item',
      undo: () => deleteItemCore(listId, resolveId(ref.id)),
      redo: () => addItemCore(listId, resolveId(sectionId), trimmed, quantity, bagId, position, false, ref),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addItemCore, deleteItemCore, pushAction, resolveId]);

  const editItemCore = useCallback((
    listId: string, itemId: string,
    updates: { name?: string; quantity?: string | null; bag_id?: string | null; checked?: boolean },
  ) => run(
    () => setLists(prev => withList(prev, listId, l => ({
      ...l,
      sections: l.sections.map(s => (
        s.items.some(i => i.id === itemId)
          ? { ...s, items: orderSectionItems(s.items.map(i => (i.id === itemId ? { ...i, ...updates, updated_at: new Date().toISOString() } : i))) }
          : s
      )),
    }))),
    async () => {
      const payload = { ...updates };
      if (payload.bag_id) payload.bag_id = await resolveIdAsync(payload.bag_id);
      await editPackingItemAPI(await resolveIdAsync(itemId), payload);
    },
    () => queueChange('packing-item-edit', '', { id: itemId, ...updates }),
  ), [run, setLists, resolveIdAsync]);

  const editItem = useCallback(async (
    listId: string, itemId: string,
    updates: { name?: string; quantity?: string | null; bag_id?: string | null },
  ) => {
    const list = findList(listId);
    const item = list?.sections.flatMap(s => s.items).find(i => i.id === itemId);
    if (!item) return;
    const applied = updates.name !== undefined ? { ...updates, name: toTitleCase(updates.name) } : updates;
    const before: typeof updates = {};
    if (applied.name !== undefined) before.name = item.name;
    if (applied.quantity !== undefined) before.quantity = item.quantity;
    if (applied.bag_id !== undefined) before.bag_id = item.bag_id;
    await editItemCore(listId, itemId, applied);
    pushAction({
      type: 'packing-edit-item',
      undo: () => editItemCore(listId, resolveId(itemId), before),
      redo: () => editItemCore(listId, resolveId(itemId), applied),
    });
  }, [editItemCore, pushAction, resolveId]);

  const toggleItem = useCallback(async (listId: string, itemId: string, checked: boolean) => {
    await editItemCore(listId, itemId, { checked });
    pushAction({
      type: 'packing-toggle-item',
      undo: () => editItemCore(listId, resolveId(itemId), { checked: !checked }),
      redo: () => editItemCore(listId, resolveId(itemId), { checked }),
    });
  }, [editItemCore, pushAction, resolveId]);

  const deleteItem = useCallback(async (listId: string, itemId: string) => {
    const list = findList(listId);
    const section = list?.sections.find(s => s.items.some(i => i.id === itemId));
    const item = section?.items.find(i => i.id === itemId);
    if (!section || !item) return;
    // The server drops a section its last item just left; mirror that locally
    // and fold both halves into ONE undo entry.
    const emptiesSection = section.items.length === 1;
    const ref = { id: itemId };
    const sectionRef = { id: section.id };
    const snapshot: PackingSection = { ...section, items: [item] };

    pushAction({
      type: 'packing-delete-item',
      undo: async () => {
        if (emptiesSection) {
          const refs = [ref];
          await restoreSection(listId, snapshot, sectionRef, refs);
          ref.id = refs[0].id;
          return;
        }
        const restoreRef = { id: generateTempId() };
        await addItemCore(listId, resolveId(sectionRef.id), item.name, item.quantity, item.bag_id,
          item.position, item.checked, restoreRef);
        remapId(ref.id, restoreRef.id);
        ref.id = restoreRef.id;
      },
      redo: async () => {
        await deleteItemCore(listId, resolveId(ref.id));
        if (emptiesSection) removeSectionLocally(listId, resolveId(sectionRef.id));
      },
    });

    await deleteItemCore(listId, itemId);
    if (emptiesSection) removeSectionLocally(listId, section.id);
  }, [addItemCore, deleteItemCore, restoreSection, removeSectionLocally, pushAction, remapId, resolveId]);

  const reorderItemsCore = useCallback((listId: string, sectionId: string, orderedIds: string[]) => {
    // Items outside the rendered subset (rows hidden by the show-packed or bag
    // filters) keep their relative order after the ones the user arranged.
    const section = listsRef.current.find(l => l.id === listId)?.sections.find(s => s.id === sectionId);
    const inOrder = new Set(orderedIds);
    const rest = section ? orderSectionItems(section.items.filter(i => !inOrder.has(i.id))).map(i => i.id) : [];
    const full = [...orderedIds, ...rest];
    const rank = new Map(full.map((id, i) => [id, i]));
    return run(
      () => setLists(prev => withList(prev, listId, l => withSection(l, sectionId, s => ({
        ...s, items: orderSectionItems(s.items.map(i => ({ ...i, position: rank.get(i.id) ?? i.position }))),
      })))),
      async () => {
        await reorderPackingItemsAPI(
          await resolveIdAsync(sectionId),
          await Promise.all(full.map(id => resolveIdAsync(id))),
        );
      },
      () => queueChange('packing-items-reorder', '', { sectionId, itemIds: full }),
    );
  }, [run, setLists, resolveIdAsync]);

  const reorderItems = useCallback(async (listId: string, sectionId: string, orderedIds: string[]) => {
    const section = findList(listId)?.sections.find(s => s.id === sectionId);
    if (!section) return;
    const prevOrder = orderSectionItems(section.items).map(i => i.id);
    await reorderItemsCore(listId, sectionId, orderedIds);
    pushAction({
      type: 'packing-reorder-items',
      undo: () => reorderItemsCore(listId, resolveId(sectionId), prevOrder.map(id => resolveId(id))),
      redo: () => reorderItemsCore(listId, resolveId(sectionId), orderedIds.map(id => resolveId(id))),
    });
  }, [reorderItemsCore, pushAction, resolveId]);

  const moveItemCore = useCallback((listId: string, itemId: string, toSectionId: string, toPosition: number) =>
    run(
      () => setLists(prev => withList(prev, listId, l => {
        const moved = l.sections.flatMap(s => s.items).find(i => i.id === itemId);
        if (!moved) return l;
        return {
          ...l,
          sections: l.sections.map(s => {
            if (s.items.some(i => i.id === itemId) && s.id !== toSectionId) {
              return { ...s, items: s.items.filter(i => i.id !== itemId).map((i, idx) => ({ ...i, position: idx })) };
            }
            if (s.id === toSectionId) {
              const others = orderSectionItems(s.items.filter(i => i.id !== itemId));
              others.splice(Math.min(toPosition, others.length), 0, { ...moved, section_id: toSectionId });
              return { ...s, items: orderSectionItems(others.map((i, idx) => ({ ...i, position: idx }))) };
            }
            return s;
          }),
        };
      })),
      async () => {
        await movePackingItemAPI(await resolveIdAsync(itemId), await resolveIdAsync(toSectionId), toPosition);
      },
      () => queueChange('packing-item-move', '', { id: itemId, toSectionId, toPosition }),
    ), [run, setLists, resolveIdAsync]);

  const moveItem = useCallback(async (listId: string, itemId: string, toSectionId: string, toPosition: number) => {
    const list = findList(listId);
    const fromSection = list?.sections.find(s => s.items.some(i => i.id === itemId));
    const item = fromSection?.items.find(i => i.id === itemId);
    if (!fromSection || !item || fromSection.id === toSectionId) return;
    const fromPosition = item.position;
    // Moving the last item out empties the source, which the server prunes.
    const emptiesSource = fromSection.items.length === 1;
    const sourceRef = { id: fromSection.id };
    const sourceSnapshot: PackingSection = { ...fromSection, items: [] };

    await moveItemCore(listId, itemId, toSectionId, toPosition);
    if (emptiesSource) removeSectionLocally(listId, fromSection.id);

    pushAction({
      type: 'packing-move-item',
      undo: async () => {
        // The source is gone — recreate it before moving the item home.
        if (emptiesSource) await restoreSection(listId, sourceSnapshot, sourceRef, []);
        await moveItemCore(listId, resolveId(itemId), resolveId(sourceRef.id), fromPosition);
      },
      redo: async () => {
        await moveItemCore(listId, resolveId(itemId), resolveId(toSectionId), toPosition);
        if (emptiesSource) removeSectionLocally(listId, resolveId(sourceRef.id));
      },
    });
  }, [moveItemCore, restoreSection, removeSectionLocally, pushAction, resolveId]);

  // ----- bags -----

  const createBagCore = useCallback(async (listId: string, name: string, position: number, ref: { id: string }) => {
    const tempId = ref.id;
    const optimistic: PackingBag = { id: tempId, list_id: listId, name, position };
    await run(
      () => setLists(prev => withList(prev, listId, l => ({ ...l, bags: [...l.bags, optimistic].sort((a, b) => a.position - b.position) }))),
      async () => {
        const created = await createPackingBagAPI(await resolveIdAsync(listId), name, position);
        remapId(tempId, created.id);
        await saveTempIdMapping(tempId, created.id);
        ref.id = created.id;
        setLists(prev => withList(prev, listId, l => ({ ...l, bags: l.bags.map(b => (b.id === tempId ? created : b)) })));
      },
      () => queueChange('packing-bag-create', '', { tempId, listId, name, position }),
    );
  }, [run, setLists, remapId, resolveIdAsync]);

  /** Returns the bag so it can back `StoreAutocomplete`'s create action. */
  const createBag = useCallback(async (listId: string, name: string): Promise<Store | null> => {
    const list = findList(listId);
    if (!list) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = list.bags.find(b => b.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    const ref = { id: generateTempId() };
    const position = list.bags.length;
    await createBagCore(listId, trimmed, position, ref);
    return { id: ref.id, name: trimmed, position };
  }, [createBagCore]);

  const renameBagCore = useCallback((listId: string, bagId: string, name: string) =>
    run(
      () => setLists(prev => withList(prev, listId, l => ({ ...l, bags: l.bags.map(b => (b.id === bagId ? { ...b, name } : b)) }))),
      async () => { await renamePackingBagAPI(await resolveIdAsync(bagId), name); },
      () => queueChange('packing-bag-rename', '', { bagId, name }),
    ), [run, setLists, resolveIdAsync]);

  const renameBag = useCallback(async (listId: string, bagId: string, name: string) => {
    const bag = findList(listId)?.bags.find(b => b.id === bagId);
    const trimmed = name.trim();
    if (!bag || !trimmed || trimmed === bag.name) return;
    const prevName = bag.name;
    await renameBagCore(listId, bagId, trimmed);
    pushAction({
      type: 'packing-rename-bag',
      undo: () => renameBagCore(listId, resolveId(bagId), prevName),
      redo: () => renameBagCore(listId, resolveId(bagId), trimmed),
    });
  }, [renameBagCore, pushAction, resolveId]);

  // Deleting a bag leaves its items in place; they just lose the assignment.
  const deleteBagCore = useCallback((listId: string, bagId: string) =>
    run(
      () => setLists(prev => withList(prev, listId, l => ({
        ...l,
        bags: l.bags.filter(b => b.id !== bagId),
        sections: l.sections.map(s => ({ ...s, items: s.items.map(i => (i.bag_id === bagId ? { ...i, bag_id: null } : i)) })),
      }))),
      async () => { await deletePackingBagAPI(await resolveIdAsync(bagId)); },
      async () => {
        if (isTempId(bagId)) await removePendingChangesForTempId(bagId);
        else await queueChange('packing-bag-delete', '', { bagId });
      },
    ), [run, setLists, resolveIdAsync]);

  const deleteBag = useCallback(async (listId: string, bagId: string) => {
    const list = findList(listId);
    const bag = list?.bags.find(b => b.id === bagId);
    if (!list || !bag) return;
    const assigned = list.sections.flatMap(s => s.items).filter(i => i.bag_id === bagId).map(i => i.id);
    const ref = { id: bagId };

    const removeBag = () => deleteBagCore(listId, resolveId(ref.id));

    pushAction({
      type: 'packing-delete-bag',
      undo: async () => {
        const restoreRef = { id: generateTempId() };
        await createBagCore(listId, bag.name, bag.position, restoreRef);
        remapId(ref.id, restoreRef.id);
        ref.id = restoreRef.id;
        // Re-attach the items that pointed at it.
        for (const itemId of assigned) {
          await editItemCore(listId, resolveId(itemId), { bag_id: restoreRef.id });
        }
      },
      redo: () => removeBag(),
    });
    await removeBag();
  }, [deleteBagCore, pushAction, createBagCore, editItemCore, remapId, resolveId]);

  const reorderBagsCore = useCallback((listId: string, orderedIds: string[]) =>
    run(
      () => setLists(prev => withList(prev, listId, l => {
        const rank = new Map(orderedIds.map((id, i) => [id, i]));
        return { ...l, bags: l.bags.map(b => (rank.has(b.id) ? { ...b, position: rank.get(b.id)! } : b)).sort((a, b) => a.position - b.position) };
      })),
      async () => {
        const realList = await resolveIdAsync(listId);
        await reorderPackingBagsAPI(realList, await Promise.all(orderedIds.map(id => resolveIdAsync(id))));
      },
      () => queueChange('packing-bags-reorder', '', { listId, bagIds: orderedIds }),
    ), [run, setLists, resolveIdAsync]);

  const reorderBags = useCallback(async (listId: string, orderedIds: string[]) => {
    const list = findList(listId);
    if (!list) return;
    const prevOrder = [...list.bags].sort((a, b) => a.position - b.position).map(b => b.id);
    await reorderBagsCore(listId, orderedIds);
    pushAction({
      type: 'packing-reorder-bags',
      undo: () => reorderBagsCore(listId, prevOrder.map(id => resolveId(id))),
      redo: () => reorderBagsCore(listId, orderedIds.map(id => resolveId(id))),
    });
  }, [reorderBagsCore, pushAction, resolveId]);

  // ----- copy a section to another trip -----

  /**
   * Copies a section and its items into another trip. Built entirely out of
   * the existing core primitives, so it inherits their optimistic updates,
   * IndexedDB writes and offline queueing for free — and because the cores
   * don't push undo entries of their own, the whole copy is ONE undo step.
   *
   * Semantics:
   *  - items arrive UNPACKED (a copied list is a fresh checklist);
   *  - bags are per-list, so the assignment carries across by NAME — a
   *    matching bag in the target is reused, otherwise it's created;
   *  - a same-named section in the target is merged into rather than
   *    duplicated, and item names already there are skipped, so copying twice
   *    is a no-op instead of doubling everything.
   *
   * Returns how many items landed (0 when the target already had them all).
   */
  const copySectionToList = useCallback(async (
    fromListId: string, sectionId: string, toListId: string,
  ): Promise<{ copied: number; skipped: number } | null> => {
    if (fromListId === toListId) return null;
    const from = findList(fromListId);
    const source = from?.sections.find(s => s.id === sectionId);
    const target = findList(toListId);
    if (!from || !source || !target) return null;

    const bagNameById = new Map(from.bags.map(b => [b.id, b.name]));
    const existingSection = target.sections.find(s => s.name.toLowerCase() === source.name.toLowerCase());
    const alreadyThere = new Set((existingSection?.items ?? []).map(i => i.name.toLowerCase()));

    // The plan is captured up front from the SOURCE, so redo replays exactly
    // the same copy even if the source has since changed.
    const plan = orderSectionItems(source.items)
      .filter(i => !alreadyThere.has(i.name.toLowerCase()))
      .map(i => ({
        name: i.name,
        quantity: i.quantity,
        bagName: i.bag_id ? bagNameById.get(i.bag_id) ?? null : null,
      }));
    const skipped = source.items.length - plan.length;
    if (plan.length === 0) return { copied: 0, skipped };

    const sectionName = source.name;
    const createdSection = !existingSection;
    const sectionRef = { id: existingSection?.id ?? '' };
    let createdBagRefs: { id: string; name: string }[] = [];
    let itemRefs: { id: string }[] = [];

    const applyCopy = async () => {
      createdBagRefs = [];
      itemRefs = [];

      if (createdSection) {
        sectionRef.id = generateTempId();
        const live = findList(toListId);
        await createSectionCore(toListId, sectionName, live?.sections.length ?? 0, sectionRef);
      }

      // Resolve each bag name against the target as it stands right now, so a
      // redo after undo re-creates whatever undo removed.
      const bagIdForName = async (name: string | null): Promise<string | null> => {
        if (!name) return null;
        const live = findList(toListId);
        const match = live?.bags.find(b => b.name.toLowerCase() === name.toLowerCase());
        if (match) return match.id;
        const ref = { id: generateTempId(), name };
        await createBagCore(toListId, name, live?.bags.length ?? 0, ref);
        createdBagRefs.push(ref);
        return ref.id;
      };

      const live = findList(toListId);
      const targetSection = live?.sections.find(s => s.id === resolveId(sectionRef.id));
      let position = targetSection && targetSection.items.length > 0
        ? Math.max(...targetSection.items.map(i => i.position)) + 1
        : 0;

      for (const entry of plan) {
        const bagId = await bagIdForName(entry.bagName);
        const ref = { id: generateTempId() };
        await addItemCore(toListId, resolveId(sectionRef.id), entry.name, entry.quantity, bagId, position++, false, ref);
        itemRefs.push(ref);
      }
    };

    const removeCopy = async () => {
      for (const ref of itemRefs) await deleteItemCore(toListId, resolveId(ref.id));
      for (const ref of createdBagRefs) await deleteBagCore(toListId, resolveId(ref.id));
      if (createdSection) await deleteSectionCore(toListId, resolveId(sectionRef.id));
    };

    await applyCopy();
    pushAction({ type: 'packing-copy-section', undo: removeCopy, redo: applyCopy });
    return { copied: plan.length, skipped };
  }, [createSectionCore, createBagCore, addItemCore, deleteItemCore, deleteBagCore, deleteSectionCore, pushAction, resolveId]);

  // Item-name suggestions come from EVERY list the user can see, so packing
  // knowledge ("Toothbrush lives in the Toiletry Bag") carries between trips.
  // There is no server-side defaults table for packing — bags are per-list, so
  // the bag is remembered by NAME and resolved against the active list.
  const itemSuggestions = useMemo(() => {
    const map = new Map<string, ItemSuggestion>();
    for (const list of lists) {
      const bagName = new Map(list.bags.map(b => [b.id, b.name]));
      for (const section of list.sections) {
        for (const item of section.items) {
          map.set(item.name.toLowerCase(), {
            bagName: item.bag_id ? bagName.get(item.bag_id) ?? null : null,
            sectionName: section.name,
          });
        }
      }
    }
    return map;
  }, [lists]);

  return {
    lists, loading,
    createList, updateList, deleteList, reorderLists, restoreListFromSnapshot,
    shareList, unshareList, leaveList,
    setAllChecked,
    addSection, createSection, renameSection, deleteSection, reorderSections,
    addItem, editItem, toggleItem, deleteItem, moveItem, reorderItems,
    createBag, renameBag, deleteBag, reorderBags,
    copySectionToList,
    itemSuggestions,
  };
}
