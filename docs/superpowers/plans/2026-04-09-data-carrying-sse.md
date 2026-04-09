# Data-Carrying SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace notification-only SSE events with data-carrying events so clients apply deltas directly without refetching from the API.

**Architecture:** Each `broadcast_event()` call gains an `action` field and serialized entity data. Frontend hooks switch on `action` to apply deltas to local state. Full server refreshes only happen on tab focus, reconnect, or deferred-load fallback. App.tsx background cache warming also uses SSE payloads instead of API calls.

**Tech Stack:** Python/FastAPI (backend), React/TypeScript (frontend), Pydantic schemas for serialization, Vitest for frontend tests, pytest for backend tests.

**Spec:** `docs/superpowers/specs/2026-04-09-data-carrying-sse-design.md`

---

## File Map

**Backend (modify):**
- `backend/app/routers/stores.py` — 4 broadcast calls
- `backend/app/routers/meal_ideas.py` — 3 broadcast calls
- `backend/app/routers/grocery.py` — 11 broadcast calls
- `backend/app/routers/pantry.py` — 11 broadcast calls

**Frontend (modify):**
- `frontend/src/hooks/useStores.ts` — SSE handler (lines 110-123)
- `frontend/src/hooks/useMealIdeas.ts` — SSE handler (lines 180-195)
- `frontend/src/hooks/useGroceryList.ts` — SSE handler (lines 184-198)
- `frontend/src/hooks/usePantry.ts` — SSE handler (lines 165-181)
- `frontend/src/App.tsx` — background cache warming (lines 566-689)

**Tests (modify/create):**
- `backend/tests/test_api.py` — add broadcast payload assertions
- `frontend/src/hooks/__tests__/useStores.test.ts` — SSE apply tests
- `frontend/src/hooks/__tests__/useMealIdeas.test.ts` — SSE apply tests
- `frontend/src/hooks/__tests__/useGroceryList.test.ts` — SSE apply tests
- `frontend/src/hooks/__tests__/usePantry.test.ts` — SSE apply tests

---

### Task 1: Backend — Stores Router Data-Carrying Events

**Files:**
- Modify: `backend/app/routers/stores.py:30-107`
- Modify: `backend/app/schemas.py` (import only — schemas already exist)

- [ ] **Step 1: Update create_store broadcast (line 49)**

Replace:
```python
await broadcast_event("stores.updated", {"id": str(store.id)}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("stores.updated", {
    "action": "added",
    "store": StoreSchema.model_validate(store).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 2: Update reorder_stores broadcast (line 63)**

Replace:
```python
await broadcast_event("stores.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
stores = db.query(Store).order_by(Store.position.asc()).all()
await broadcast_event("stores.updated", {
    "action": "reordered",
    "stores": [{"id": str(s.id), "position": s.position} for s in stores],
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 3: Update update_store broadcast (line 90)**

Replace:
```python
await broadcast_event("stores.updated", {"id": str(store.id)}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("stores.updated", {
    "action": "updated",
    "store": StoreSchema.model_validate(store).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 4: Update delete_store broadcast (line 106)**

Replace:
```python
await broadcast_event("stores.updated", {"id": str(store_id), "deleted": True}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("stores.updated", {
    "action": "deleted",
    "storeId": str(store_id),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/routers/stores.py
git commit -m "feat(sse): add data-carrying payloads to stores broadcasts"
```

---

### Task 2: Frontend — useStores SSE Apply Logic

**Files:**
- Modify: `frontend/src/hooks/useStores.ts:110-123`

- [ ] **Step 1: Define the SSE payload type**

Add above the `useStores` function (after the imports):

```typescript
interface StoresSSEPayload {
  action: string;
  store?: Store;
  storeId?: string;
  stores?: { id: string; position: number }[];
}
```

- [ ] **Step 2: Add applyRealtimeEvent function inside the hook**

Add inside `useStores`, after `settleMutation` and before the `useEffect(() => { loadStores(); }, ...)`:

```typescript
const applyRealtimeEvent = useCallback((payload: StoresSSEPayload) => {
  const { action } = payload;
  switch (action) {
    case 'added':
      if (payload.store) {
        setStores(prev => {
          if (prev.some(s => s.id === payload.store!.id)) return prev;
          return [...prev, payload.store!].sort((a, b) => a.position - b.position);
        });
      }
      break;
    case 'updated':
      if (payload.store) {
        setStores(prev => prev.map(s => s.id === payload.store!.id ? payload.store! : s));
      }
      break;
    case 'deleted':
      if (payload.storeId) {
        setStores(prev => prev.filter(s => s.id !== payload.storeId));
      }
      break;
    case 'reordered':
      if (payload.stores) {
        const posMap = new Map(payload.stores.map(s => [s.id, s.position]));
        setStores(prev => prev.map(s => {
          const pos = posMap.get(s.id);
          return pos !== undefined ? { ...s, position: pos } : s;
        }).sort((a, b) => a.position - b.position));
      }
      break;
  }
}, []);
```

- [ ] **Step 3: Update the SSE event handler**

Replace the existing handler (lines 110-123):

```typescript
useEffect(() => {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.type === 'stores.updated') {
      if (pendingRef.current > 0) {
        deferredRef.current = true;
      } else {
        applyRealtimeEvent(detail.payload as StoresSSEPayload);
      }
    }
  };
  window.addEventListener('meal-planner-realtime', handler);
  return () => window.removeEventListener('meal-planner-realtime', handler);
}, [applyRealtimeEvent]);
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useStores.ts
git commit -m "feat(sse): apply stores SSE deltas directly instead of refetching"
```

---

### Task 3: Backend — Meal Ideas Router Data-Carrying Events

**Files:**
- Modify: `backend/app/routers/meal_ideas.py:24-77`

- [ ] **Step 1: Update create_meal_idea broadcast (line 38)**

Replace:
```python
await broadcast_event("meal-ideas.updated", {"id": str(idea.id)}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("meal-ideas.updated", {
    "action": "added",
    "idea": MealIdeaSchema.model_validate(idea).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 2: Update update_meal_idea broadcast (line 60)**

Replace:
```python
await broadcast_event("meal-ideas.updated", {"id": str(idea.id)}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("meal-ideas.updated", {
    "action": "updated",
    "idea": MealIdeaSchema.model_validate(idea).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 3: Update delete_meal_idea broadcast (line 76)**

Replace:
```python
await broadcast_event("meal-ideas.updated", {"id": str(idea.id), "deleted": True}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("meal-ideas.updated", {
    "action": "deleted",
    "ideaId": str(idea.id),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 4: Commit**

```bash
git add backend/app/routers/meal_ideas.py
git commit -m "feat(sse): add data-carrying payloads to meal-ideas broadcasts"
```

---

### Task 4: Frontend — useMealIdeas SSE Apply Logic

**Files:**
- Modify: `frontend/src/hooks/useMealIdeas.ts:180-195`

- [ ] **Step 1: Define the SSE payload type**

Add near the top of the file (after imports):

```typescript
interface MealIdeasSSEPayload {
  action: string;
  idea?: MealIdea;
  ideaId?: string;
}
```

- [ ] **Step 2: Add applyRealtimeEvent function inside the hook**

Add inside the hook, after `settleMutation` and before the `useEffect(() => { refreshIdeas(); }, ...)`:

```typescript
const applyRealtimeEvent = useCallback((payload: MealIdeasSSEPayload) => {
  const { action } = payload;
  switch (action) {
    case 'added':
      if (payload.idea) {
        setIdeas(prev => {
          if (prev.some(i => i.id === payload.idea!.id)) return prev;
          return [payload.idea!, ...prev];
        });
      }
      break;
    case 'updated':
      if (payload.idea) {
        setIdeas(prev => prev.map(i => i.id === payload.idea!.id ? payload.idea! : i));
      }
      break;
    case 'deleted':
      if (payload.ideaId) {
        setIdeas(prev => prev.filter(i => i.id !== payload.ideaId));
      }
      break;
  }
}, []);
```

- [ ] **Step 3: Update the SSE event handler**

Replace the existing handler (lines 180-195):

```typescript
useEffect(() => {
  const handleRealtime = (event: Event) => {
    const detail = (event as CustomEvent).detail as { type?: string; payload?: unknown } | undefined;
    if (detail?.type === 'meal-ideas.updated') {
      if (pendingMutationsRef.current > 0) {
        deferredLoadRef.current = true;
      } else {
        applyRealtimeEvent(detail.payload as MealIdeasSSEPayload);
      }
    }
  };
  window.addEventListener('meal-planner-realtime', handleRealtime as EventListener);
  return () => {
    window.removeEventListener('meal-planner-realtime', handleRealtime as EventListener);
  };
}, [applyRealtimeEvent]);
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useMealIdeas.ts
git commit -m "feat(sse): apply meal-ideas SSE deltas directly instead of refetching"
```

---

### Task 5: Backend — Grocery Router Data-Carrying Events

**Files:**
- Modify: `backend/app/routers/grocery.py:43-361`

- [ ] **Step 1: Update replace_grocery broadcast (line 90)**

Replace:
```python
await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("grocery.updated", {
    "action": "replaced",
    "sections": [GrocerySectionSchema.model_validate(s).model_dump(mode="json") for s in result],
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 2: Update update_section broadcast (line 109)**

Replace:
```python
await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("grocery.updated", {
    "action": "section-renamed",
    "sectionId": str(section.id),
    "name": section.name,
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 3: Update delete_section broadcast (line 127)**

Replace:
```python
await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("grocery.updated", {
    "action": "section-deleted",
    "sectionId": str(section.id),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 4: Update create_section broadcast (line 146)**

Replace:
```python
await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("grocery.updated", {
    "action": "section-added",
    "section": GrocerySectionSchema.model_validate(section).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

Note: `section` was just created and committed — it has no items yet, but `GrocerySectionSchema` expects an `items` list. The newly created section has `items = []` after refresh because of the ORM relationship. Verify this works; if not, manually construct: `{"id": str(section.id), "name": section.name, "position": section.position, "items": []}`.

- [ ] **Step 5: Update reorder_sections broadcast (line 162)**

Replace:
```python
await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
sections = db.query(GrocerySection).order_by(GrocerySection.position.asc()).all()
await broadcast_event("grocery.updated", {
    "action": "section-reordered",
    "sections": [{"id": str(s.id), "position": s.position} for s in sections],
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 6: Update reorder_items broadcast (line 185)**

Replace:
```python
await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
items = db.query(GroceryItem).filter(
    GroceryItem.section_id == section_id
).order_by(GroceryItem.position.asc()).all()
await broadcast_event("grocery.updated", {
    "action": "items-reordered",
    "sectionId": str(section_id),
    "items": [{"id": str(i.id), "position": i.position} for i in items],
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 7: Update update_grocery_item broadcast (line 234)**

Replace:
```python
await broadcast_event("grocery.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("grocery.updated", {
    "action": "item-updated",
    "sectionId": str(item.section_id),
    "item": GroceryItemSchema.model_validate(item).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 8: Update add_grocery_item broadcast (line 273)**

Replace:
```python
await broadcast_event("grocery.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("grocery.updated", {
    "action": "item-added",
    "sectionId": str(item.section_id),
    "item": GroceryItemSchema.model_validate(item).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 9: Update move_grocery_item broadcast (line 312)**

Replace:
```python
await broadcast_event("grocery.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("grocery.updated", {
    "action": "item-moved",
    "fromSectionId": str(old_section_id),
    "toSectionId": str(item.section_id),
    "item": GroceryItemSchema.model_validate(item).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 10: Update delete_grocery_item broadcast (line 328)**

Replace:
```python
await broadcast_event("grocery.updated", {"id": str(item_id), "deleted": True}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("grocery.updated", {
    "action": "item-deleted",
    "sectionId": str(item.section_id),
    "itemId": str(item_id),
}, source_id=request.headers.get("x-source-id"))
```

Note: `item` is queried on line 323 and still in scope. Capture `section_id = item.section_id` before `db.delete(item)` to be safe.

- [ ] **Step 11: Update clear_grocery_items broadcast (line 360)**

Replace:
```python
await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
if mode == "all":
    await broadcast_event("grocery.updated", {
        "action": "cleared-all",
    }, source_id=request.headers.get("x-source-id"))
else:
    await broadcast_event("grocery.updated", {
        "action": "cleared-checked",
    }, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 12: Commit**

```bash
git add backend/app/routers/grocery.py
git commit -m "feat(sse): add data-carrying payloads to grocery broadcasts"
```

---

### Task 6: Frontend — useGroceryList SSE Apply Logic

**Files:**
- Modify: `frontend/src/hooks/useGroceryList.ts:184-198`

- [ ] **Step 1: Define the SSE payload type**

Add near the top of the file (after imports):

```typescript
interface GrocerySSEPayload {
  action: string;
  sectionId?: string;
  item?: GroceryItem;
  itemId?: string;
  fromSectionId?: string;
  toSectionId?: string;
  section?: GrocerySection;
  sections?: GrocerySection[] | { id: string; position: number }[];
  items?: { id: string; position: number }[];
  name?: string;
}
```

- [ ] **Step 2: Add applyRealtimeEvent function inside the hook**

Add inside the hook, after `settleMutation` and before the `useEffect(() => { loadGroceryList(); }, ...)`:

```typescript
const applyRealtimeEvent = useCallback((payload: GrocerySSEPayload) => {
  const { action } = payload;
  switch (action) {
    case 'item-added':
      if (payload.sectionId && payload.item) {
        setSections(prev => prev.map(s => {
          if (s.id !== payload.sectionId) return s;
          if (s.items.some(i => i.id === payload.item!.id)) return s;
          return { ...s, items: [...s.items, payload.item!] };
        }));
      }
      break;
    case 'item-updated':
      if (payload.sectionId && payload.item) {
        setSections(prev => prev.map(s => {
          if (s.id !== payload.sectionId) return s;
          return { ...s, items: s.items.map(i => i.id === payload.item!.id ? payload.item! : i) };
        }));
      }
      break;
    case 'item-deleted':
      if (payload.sectionId && payload.itemId) {
        setSections(prev => prev.map(s => {
          if (s.id !== payload.sectionId) return s;
          return { ...s, items: s.items.filter(i => i.id !== payload.itemId) };
        }));
      }
      break;
    case 'item-moved':
      if (payload.fromSectionId && payload.toSectionId && payload.item) {
        setSections(prev => prev.map(s => {
          if (s.id === payload.fromSectionId) {
            return { ...s, items: s.items.filter(i => i.id !== payload.item!.id) };
          }
          if (s.id === payload.toSectionId) {
            if (s.items.some(i => i.id === payload.item!.id)) return s;
            const items = [...s.items, payload.item!].sort((a, b) => a.position - b.position);
            return { ...s, items };
          }
          return s;
        }));
      }
      break;
    case 'section-added':
      if (payload.section) {
        setSections(prev => {
          if (prev.some(s => s.id === payload.section!.id)) return prev;
          return [...prev, payload.section!].sort((a, b) => a.position - b.position);
        });
      }
      break;
    case 'section-renamed':
      if (payload.sectionId && payload.name) {
        setSections(prev => prev.map(s =>
          s.id === payload.sectionId ? { ...s, name: payload.name! } : s
        ));
      }
      break;
    case 'section-deleted':
      if (payload.sectionId) {
        setSections(prev => prev.filter(s => s.id !== payload.sectionId));
      }
      break;
    case 'section-reordered':
      if (payload.sections) {
        const posMap = new Map((payload.sections as { id: string; position: number }[]).map(s => [s.id, s.position]));
        setSections(prev => prev.map(s => {
          const pos = posMap.get(s.id);
          return pos !== undefined ? { ...s, position: pos } : s;
        }).sort((a, b) => a.position - b.position));
      }
      break;
    case 'items-reordered':
      if (payload.sectionId && payload.items) {
        const posMap = new Map(payload.items.map(i => [i.id, i.position]));
        setSections(prev => prev.map(s => {
          if (s.id !== payload.sectionId) return s;
          return { ...s, items: s.items.map(i => {
            const pos = posMap.get(i.id);
            return pos !== undefined ? { ...i, position: pos } : i;
          }).sort((a, b) => a.position - b.position) };
        }));
      }
      break;
    case 'cleared-checked':
      setSections(prev => {
        const updated = prev.map(s => ({ ...s, items: s.items.filter(i => !i.checked) }));
        return updated.filter(s => s.items.length > 0);
      });
      break;
    case 'cleared-all':
      setSections([]);
      break;
    case 'replaced':
      if (payload.sections) {
        setSections(payload.sections as GrocerySection[]);
      }
      break;
  }
}, []);
```

- [ ] **Step 3: Update the SSE event handler**

Replace the existing handler (lines 184-198):

```typescript
useEffect(() => {
  const handler = (e: Event) => {
    const { detail } = e as CustomEvent;
    if (detail?.type === 'grocery.updated') {
      if (pendingMutationsRef.current > 0) {
        deferredLoadRef.current = true;
        return;
      }
      applyRealtimeEvent(detail.payload as GrocerySSEPayload);
    }
  };
  window.addEventListener('meal-planner-realtime', handler);
  return () => window.removeEventListener('meal-planner-realtime', handler);
}, [applyRealtimeEvent]);
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useGroceryList.ts
git commit -m "feat(sse): apply grocery SSE deltas directly instead of refetching"
```

---

### Task 7: Backend — Pantry Router Data-Carrying Events

**Files:**
- Modify: `backend/app/routers/pantry.py:42-308`

- [ ] **Step 1: Update replace_pantry broadcast (line 76)**

Replace:
```python
await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("pantry.updated", {
    "action": "replaced",
    "sections": [PantrySectionSchema.model_validate(s).model_dump(mode="json") for s in result],
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 2: Update update_section broadcast (line 95)**

Replace:
```python
await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("pantry.updated", {
    "action": "section-renamed",
    "sectionId": str(section.id),
    "name": section.name,
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 3: Update reorder_sections broadcast (line 111)**

Replace:
```python
await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
sections = db.query(PantrySection).order_by(PantrySection.position.asc()).all()
await broadcast_event("pantry.updated", {
    "action": "section-reordered",
    "sections": [{"id": str(s.id), "position": s.position} for s in sections],
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 4: Update reorder_items broadcast (line 134)**

Replace:
```python
await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
items = db.query(PantryItem).filter(
    PantryItem.section_id == section_id
).order_by(PantryItem.position.asc()).all()
await broadcast_event("pantry.updated", {
    "action": "items-reordered",
    "sectionId": str(section_id),
    "items": [{"id": str(i.id), "position": i.position} for i in items],
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 5: Update add_pantry_item broadcast (line 166)**

Replace:
```python
await broadcast_event("pantry.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("pantry.updated", {
    "action": "item-added",
    "sectionId": str(item.section_id),
    "item": PantryItemSchema.model_validate(item).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 6: Update update_pantry_item broadcast (line 190)**

Replace:
```python
await broadcast_event("pantry.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("pantry.updated", {
    "action": "item-updated",
    "sectionId": str(item.section_id),
    "item": PantryItemSchema.model_validate(item).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 7: Update move_pantry_item broadcast (line 229)**

Replace:
```python
await broadcast_event("pantry.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("pantry.updated", {
    "action": "item-moved",
    "fromSectionId": str(old_section_id),
    "toSectionId": str(item.section_id),
    "item": PantryItemSchema.model_validate(item).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 8: Update create_pantry_section broadcast (line 250)**

Replace:
```python
await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("pantry.updated", {
    "action": "section-added",
    "section": PantrySectionSchema.model_validate(section).model_dump(mode="json"),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 9: Update delete_pantry_section broadcast (line 266)**

Replace:
```python
await broadcast_event("pantry.updated", {"id": str(section_id), "deleted": True}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("pantry.updated", {
    "action": "section-deleted",
    "sectionId": str(section_id),
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 10: Update delete_pantry_item broadcast (line 282)**

Replace:
```python
await broadcast_event("pantry.updated", {"id": str(item_id), "deleted": True}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("pantry.updated", {
    "action": "item-deleted",
    "sectionId": str(item.section_id),
    "itemId": str(item_id),
}, source_id=request.headers.get("x-source-id"))
```

Note: `item` is queried on line 277. Capture `section_id = item.section_id` before `db.delete(item)`.

- [ ] **Step 11: Update clear_pantry_items broadcast (line 307)**

Replace:
```python
await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
```
With:
```python
await broadcast_event("pantry.updated", {
    "action": "cleared-all",
}, source_id=request.headers.get("x-source-id"))
```

- [ ] **Step 12: Commit**

```bash
git add backend/app/routers/pantry.py
git commit -m "feat(sse): add data-carrying payloads to pantry broadcasts"
```

---

### Task 8: Frontend — usePantry SSE Apply Logic

**Files:**
- Modify: `frontend/src/hooks/usePantry.ts:165-181`

- [ ] **Step 1: Define the SSE payload type**

Add near the top of the file (after imports):

```typescript
interface PantrySSEPayload {
  action: string;
  sectionId?: string;
  item?: PantryItem;
  itemId?: string;
  fromSectionId?: string;
  toSectionId?: string;
  section?: PantrySection;
  sections?: PantrySection[] | { id: string; position: number }[];
  items?: { id: string; position: number }[];
  name?: string;
}
```

- [ ] **Step 2: Add applyRealtimeEvent function inside the hook**

Add inside the hook, after `settleMutation` and before the `useEffect(() => { loadPantryList(); }, ...)`:

```typescript
const applyRealtimeEvent = useCallback((payload: PantrySSEPayload) => {
  const { action } = payload;
  switch (action) {
    case 'item-added':
      if (payload.sectionId && payload.item) {
        setSections(prev => prev.map(s => {
          if (s.id !== payload.sectionId) return s;
          if (s.items.some(i => i.id === payload.item!.id)) return s;
          return { ...s, items: [...s.items, payload.item!] };
        }));
      }
      break;
    case 'item-updated':
      if (payload.sectionId && payload.item) {
        setSections(prev => prev.map(s => {
          if (s.id !== payload.sectionId) return s;
          return { ...s, items: s.items.map(i => i.id === payload.item!.id ? payload.item! : i) };
        }));
      }
      break;
    case 'item-deleted':
      if (payload.sectionId && payload.itemId) {
        setSections(prev => prev.map(s => {
          if (s.id !== payload.sectionId) return s;
          return { ...s, items: s.items.filter(i => i.id !== payload.itemId) };
        }));
      }
      break;
    case 'item-moved':
      if (payload.fromSectionId && payload.toSectionId && payload.item) {
        setSections(prev => prev.map(s => {
          if (s.id === payload.fromSectionId) {
            return { ...s, items: s.items.filter(i => i.id !== payload.item!.id) };
          }
          if (s.id === payload.toSectionId) {
            if (s.items.some(i => i.id === payload.item!.id)) return s;
            const items = [...s.items, payload.item!].sort((a, b) => a.position - b.position);
            return { ...s, items };
          }
          return s;
        }));
      }
      break;
    case 'section-added':
      if (payload.section) {
        setSections(prev => {
          if (prev.some(s => s.id === payload.section!.id)) return prev;
          return [...prev, payload.section!].sort((a, b) => a.position - b.position);
        });
      }
      break;
    case 'section-renamed':
      if (payload.sectionId && payload.name) {
        setSections(prev => prev.map(s =>
          s.id === payload.sectionId ? { ...s, name: payload.name! } : s
        ));
      }
      break;
    case 'section-deleted':
      if (payload.sectionId) {
        setSections(prev => prev.filter(s => s.id !== payload.sectionId));
      }
      break;
    case 'section-reordered':
      if (payload.sections) {
        const posMap = new Map((payload.sections as { id: string; position: number }[]).map(s => [s.id, s.position]));
        setSections(prev => prev.map(s => {
          const pos = posMap.get(s.id);
          return pos !== undefined ? { ...s, position: pos } : s;
        }).sort((a, b) => a.position - b.position));
      }
      break;
    case 'items-reordered':
      if (payload.sectionId && payload.items) {
        const posMap = new Map(payload.items.map(i => [i.id, i.position]));
        setSections(prev => prev.map(s => {
          if (s.id !== payload.sectionId) return s;
          return { ...s, items: s.items.map(i => {
            const pos = posMap.get(i.id);
            return pos !== undefined ? { ...i, position: pos } : i;
          }).sort((a, b) => a.position - b.position) };
        }));
      }
      break;
    case 'cleared-all':
      setSections([]);
      break;
    case 'replaced':
      if (payload.sections) {
        setSections(payload.sections as PantrySection[]);
      }
      break;
  }
}, []);
```

- [ ] **Step 3: Update the SSE event handler**

Replace the existing handler (lines 165-181):

```typescript
useEffect(() => {
  const handler = (e: Event) => {
    const { detail } = e as CustomEvent;
    if (detail?.type === 'pantry.updated') {
      if (Object.keys(pendingUpdatesRef.current).length > 0) return;
      if (pendingMutationsRef.current > 0) {
        deferredLoadRef.current = true;
        return;
      }
      applyRealtimeEvent(detail.payload as PantrySSEPayload);
    }
  };
  window.addEventListener('meal-planner-realtime', handler);
  return () => window.removeEventListener('meal-planner-realtime', handler);
}, [applyRealtimeEvent]);
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/usePantry.ts
git commit -m "feat(sse): apply pantry SSE deltas directly instead of refetching"
```

---

### Task 9: App.tsx — Background Cache Warming With SSE Data

**Files:**
- Modify: `frontend/src/App.tsx:566-689`

The background cache warming handler in App.tsx currently refetches from API on SSE events for inactive tabs. Update it to apply SSE payloads directly to the local cache instead.

- [ ] **Step 1: Update grocery.updated handler (lines 579-591)**

Replace:
```typescript
if (detail.type === 'grocery.updated' && currentPageRef.current !== 'grocery') {
  if (pending.some(c => c.type.startsWith('grocery-'))) return;
  try {
    const data = await getGroceryList();
    try { localStorage.setItem('meal-planner-grocery', JSON.stringify(data)); } catch {}
    setGroceryCount(data.reduce((sum, s) => sum + s.items.filter(i => !i.checked).length, 0));
    await saveLocalGrocerySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
    await saveLocalGroceryItems(data.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
    }))));
  } catch {}
}
```

With:
```typescript
if (detail.type === 'grocery.updated' && currentPageRef.current !== 'grocery') {
  if (pending.some(c => c.type.startsWith('grocery-'))) return;
  // Data is carried in the SSE payload — apply to local cache
  // Full cache will be rebuilt on tab focus via broadcastFullRefresh
  const payload = detail.payload as { action?: string; sections?: GrocerySection[] };
  if (payload?.action === 'replaced' && payload.sections) {
    try {
      const data = payload.sections;
      try { localStorage.setItem('meal-planner-grocery', JSON.stringify(data)); } catch {}
      setGroceryCount(data.reduce((sum, s) => sum + s.items.filter(i => !i.checked).length, 0));
      await saveLocalGrocerySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
      await saveLocalGroceryItems(data.flatMap(s => s.items.map(i => ({
        id: i.id, section_id: i.section_id, name: i.name,
        quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
      }))));
    } catch {}
  }
  // For non-replaced actions, the tab-focus refresh will pick up changes
}
```

- [ ] **Step 2: Update pantry.updated handler (lines 593-604)**

Replace:
```typescript
if (detail.type === 'pantry.updated' && currentPageRef.current !== 'pantry') {
  if (pending.some(c => c.type.startsWith('pantry-'))) return;
  try {
    const data = await getPantryList();
    try { localStorage.setItem('meal-planner-pantry-sections', JSON.stringify(data)); } catch {}
    await saveLocalPantrySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
    await saveLocalPantryItems(data.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, position: i.position, updated_at: i.updated_at,
    }))));
  } catch {}
}
```

With:
```typescript
if (detail.type === 'pantry.updated' && currentPageRef.current !== 'pantry') {
  if (pending.some(c => c.type.startsWith('pantry-'))) return;
  const payload = detail.payload as { action?: string; sections?: PantrySection[] };
  if (payload?.action === 'replaced' && payload.sections) {
    try {
      const data = payload.sections;
      try { localStorage.setItem('meal-planner-pantry-sections', JSON.stringify(data)); } catch {}
      await saveLocalPantrySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
      await saveLocalPantryItems(data.flatMap(s => s.items.map(i => ({
        id: i.id, section_id: i.section_id, name: i.name,
        quantity: i.quantity, position: i.position, updated_at: i.updated_at,
      }))));
    } catch {}
  }
}
```

- [ ] **Step 3: Update stores.updated handler (lines 606-612)**

Replace:
```typescript
if (detail.type === 'stores.updated') {
  try {
    const stores = await getStoresAPI();
    await saveLocalStores(stores.map(s => ({ id: s.id, name: s.name, position: s.position })));
    try { localStorage.setItem('meal-planner-stores', JSON.stringify(stores)); } catch {}
  } catch {}
}
```

With:
```typescript
if (detail.type === 'stores.updated') {
  const payload = detail.payload as { action?: string; store?: Store; storeId?: string; stores?: { id: string; position: number }[] };
  try {
    const raw = localStorage.getItem('meal-planner-stores');
    let stores: Store[] = raw ? JSON.parse(raw) : [];
    switch (payload?.action) {
      case 'added':
        if (payload.store && !stores.some(s => s.id === payload.store!.id)) {
          stores = [...stores, payload.store].sort((a, b) => a.position - b.position);
        }
        break;
      case 'updated':
        if (payload.store) {
          stores = stores.map(s => s.id === payload.store!.id ? payload.store! : s);
        }
        break;
      case 'deleted':
        if (payload.storeId) {
          stores = stores.filter(s => s.id !== payload.storeId);
        }
        break;
      case 'reordered':
        if (payload.stores) {
          const posMap = new Map(payload.stores.map(s => [s.id, s.position]));
          stores = stores.map(s => {
            const pos = posMap.get(s.id);
            return pos !== undefined ? { ...s, position: pos } : s;
          }).sort((a, b) => a.position - b.position);
        }
        break;
    }
    await saveLocalStores(stores.map(s => ({ id: s.id, name: s.name, position: s.position })));
    try { localStorage.setItem('meal-planner-stores', JSON.stringify(stores)); } catch {}
  } catch {}
}
```

- [ ] **Step 4: Update meal-ideas.updated handler (lines 614-624)**

Replace:
```typescript
if (detail.type === 'meal-ideas.updated' && currentPageRef.current !== 'meals') {
  if (pending.some(c => c.type.startsWith('meal-idea-'))) return;
  try {
    const ideas = await getMealIdeas();
    await clearLocalMealIdeas();
    for (const idea of ideas) {
      await saveLocalMealIdea(idea);
    }
    try { localStorage.setItem('meal-planner-meal-ideas', JSON.stringify(ideas)); } catch {}
  } catch {}
}
```

With:
```typescript
if (detail.type === 'meal-ideas.updated' && currentPageRef.current !== 'meals') {
  if (pending.some(c => c.type.startsWith('meal-idea-'))) return;
  const payload = detail.payload as { action?: string; idea?: MealIdea; ideaId?: string };
  try {
    const raw = localStorage.getItem('meal-planner-meal-ideas');
    let ideas: MealIdea[] = raw ? JSON.parse(raw) : [];
    switch (payload?.action) {
      case 'added':
        if (payload.idea && !ideas.some(i => i.id === payload.idea!.id)) {
          ideas = [payload.idea, ...ideas];
          await saveLocalMealIdea(payload.idea);
        }
        break;
      case 'updated':
        if (payload.idea) {
          ideas = ideas.map(i => i.id === payload.idea!.id ? payload.idea! : i);
          await saveLocalMealIdea(payload.idea);
        }
        break;
      case 'deleted':
        if (payload.ideaId) {
          ideas = ideas.filter(i => i.id !== payload.ideaId);
          // deleteLocalMealIdea not available — full cache rebuilt on tab focus
        }
        break;
    }
    try { localStorage.setItem('meal-planner-meal-ideas', JSON.stringify(ideas)); } catch {}
  } catch {}
}
```

- [ ] **Step 5: Remove unused API imports**

After updating App.tsx, remove the API imports that are no longer called from the cache warming handler. Check which of `getGroceryList`, `getPantryList`, `getStoresAPI`, `getMealIdeas` are still used elsewhere in App.tsx (they are used in `fetchAllData`). If `fetchAllData` still uses them, keep the imports. Only remove imports that are completely unused.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(sse): update App.tsx cache warming to use SSE payloads instead of API refetches"
```

---

### Task 10: Backend Tests — Verify Broadcast Payloads

**Files:**
- Modify: `backend/tests/test_api.py`

Add tests that verify the broadcast payloads contain the correct action and data. Use `unittest.mock.patch` to capture `broadcast_event` calls.

- [ ] **Step 1: Add stores broadcast payload tests**

```python
class TestStoresSSEPayloads:
    """Test that store mutations broadcast correct SSE payloads."""

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_create_store_broadcasts_added(self, mock_broadcast, authenticated_client, db_session):
        response = authenticated_client.post("/api/stores", json={"name": "Costco"})
        assert response.status_code == 200
        mock_broadcast.assert_called_once()
        call_args = mock_broadcast.call_args
        assert call_args[0][0] == "stores.updated"
        payload = call_args[0][1]
        assert payload["action"] == "added"
        assert payload["store"]["name"] == "Costco"
        assert "id" in payload["store"]

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_update_store_broadcasts_updated(self, mock_broadcast, authenticated_client, db_session):
        store = Store(name="Old Name", position=0)
        db_session.add(store)
        db_session.commit()
        db_session.refresh(store)

        response = authenticated_client.patch(f"/api/stores/{store.id}", json={"name": "New Name"})
        assert response.status_code == 200
        mock_broadcast.assert_called_once()
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "updated"
        assert payload["store"]["name"] == "New Name"

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_delete_store_broadcasts_deleted(self, mock_broadcast, authenticated_client, db_session):
        store = Store(name="Target", position=0)
        db_session.add(store)
        db_session.commit()
        db_session.refresh(store)

        response = authenticated_client.delete(f"/api/stores/{store.id}")
        assert response.status_code == 200
        mock_broadcast.assert_called_once()
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "deleted"
        assert payload["storeId"] == str(store.id)

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_reorder_stores_broadcasts_reordered(self, mock_broadcast, authenticated_client, db_session):
        s1 = Store(name="A", position=0)
        s2 = Store(name="B", position=1)
        db_session.add_all([s1, s2])
        db_session.commit()
        db_session.refresh(s1)
        db_session.refresh(s2)

        response = authenticated_client.patch("/api/stores/reorder", json={"store_ids": [str(s2.id), str(s1.id)]})
        assert response.status_code == 200
        mock_broadcast.assert_called_once()
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "reordered"
        assert len(payload["stores"]) == 2
```

- [ ] **Step 2: Add grocery broadcast payload tests**

```python
class TestGrocerySSEPayloads:
    """Test that grocery mutations broadcast correct SSE payloads."""

    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    def test_add_item_broadcasts_item_added(self, mock_broadcast, authenticated_client, db_session):
        section = GrocerySection(name="Produce", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        response = authenticated_client.post("/api/grocery/items", json={
            "section_id": str(section.id), "name": "Apples", "quantity": "3"
        })
        assert response.status_code == 200
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "item-added"
        assert payload["sectionId"] == str(section.id)
        assert payload["item"]["name"] == "Apples"

    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    def test_delete_item_broadcasts_item_deleted(self, mock_broadcast, authenticated_client, db_session):
        section = GrocerySection(name="Produce", position=0)
        db_session.add(section)
        db_session.flush()
        item = GroceryItem(section_id=section.id, name="Milk", quantity="1", position=0)
        db_session.add(item)
        db_session.commit()
        db_session.refresh(item)

        response = authenticated_client.delete(f"/api/grocery/items/{item.id}")
        assert response.status_code == 200
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "item-deleted"
        assert payload["itemId"] == str(item.id)
        assert payload["sectionId"] == str(section.id)

    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    def test_clear_checked_broadcasts_cleared_checked(self, mock_broadcast, authenticated_client, db_session):
        section = GrocerySection(name="Produce", position=0)
        db_session.add(section)
        db_session.flush()
        item = GroceryItem(section_id=section.id, name="Milk", quantity="1", position=0, checked=True)
        db_session.add(item)
        db_session.commit()

        response = authenticated_client.delete("/api/grocery/items?mode=checked")
        assert response.status_code == 200
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "cleared-checked"

    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    def test_clear_all_broadcasts_cleared_all(self, mock_broadcast, authenticated_client, db_session):
        section = GrocerySection(name="Produce", position=0)
        db_session.add(section)
        db_session.commit()

        response = authenticated_client.delete("/api/grocery/items?mode=all")
        assert response.status_code == 200
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "cleared-all"

    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    def test_move_item_broadcasts_item_moved(self, mock_broadcast, authenticated_client, db_session):
        s1 = GrocerySection(name="Produce", position=0)
        s2 = GrocerySection(name="Dairy", position=1)
        db_session.add_all([s1, s2])
        db_session.flush()
        item = GroceryItem(section_id=s1.id, name="Milk", quantity="1", position=0)
        db_session.add(item)
        db_session.commit()
        db_session.refresh(item)

        response = authenticated_client.patch(f"/api/grocery/items/{item.id}/move", json={
            "to_section_id": str(s2.id), "to_position": 0
        })
        assert response.status_code == 200
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "item-moved"
        assert payload["fromSectionId"] == str(s1.id)
        assert payload["toSectionId"] == str(s2.id)
        assert payload["item"]["name"] == "Milk"
```

- [ ] **Step 3: Add pantry and meal-ideas broadcast payload tests**

```python
class TestPantrySSEPayloads:
    """Test that pantry mutations broadcast correct SSE payloads."""

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_add_item_broadcasts_item_added(self, mock_broadcast, authenticated_client, db_session):
        section = PantrySection(name="Spices", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        response = authenticated_client.post("/api/pantry/items", json={
            "section_id": str(section.id), "name": "Salt", "quantity": 1
        })
        assert response.status_code == 200
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "item-added"
        assert payload["sectionId"] == str(section.id)
        assert payload["item"]["name"] == "Salt"

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_delete_section_broadcasts_section_deleted(self, mock_broadcast, authenticated_client, db_session):
        section = PantrySection(name="Empty", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        response = authenticated_client.delete(f"/api/pantry/sections/{section.id}")
        assert response.status_code == 200
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "section-deleted"
        assert payload["sectionId"] == str(section.id)

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_clear_all_broadcasts_cleared_all(self, mock_broadcast, authenticated_client, db_session):
        section = PantrySection(name="Spices", position=0)
        db_session.add(section)
        db_session.commit()

        response = authenticated_client.delete("/api/pantry/items?mode=all")
        assert response.status_code == 200
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "cleared-all"


class TestMealIdeasSSEPayloads:
    """Test that meal idea mutations broadcast correct SSE payloads."""

    @patch("app.routers.meal_ideas.broadcast_event", new_callable=AsyncMock)
    def test_create_broadcasts_added(self, mock_broadcast, authenticated_client):
        response = authenticated_client.post("/api/meal-ideas", json={"title": "Tacos"})
        assert response.status_code == 200
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "added"
        assert payload["idea"]["title"] == "Tacos"

    @patch("app.routers.meal_ideas.broadcast_event", new_callable=AsyncMock)
    def test_update_broadcasts_updated(self, mock_broadcast, authenticated_client, db_session):
        idea = MealIdea(title="Old")
        db_session.add(idea)
        db_session.commit()
        db_session.refresh(idea)

        response = authenticated_client.put(f"/api/meal-ideas/{idea.id}", json={"title": "New"})
        assert response.status_code == 200
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "updated"
        assert payload["idea"]["title"] == "New"

    @patch("app.routers.meal_ideas.broadcast_event", new_callable=AsyncMock)
    def test_delete_broadcasts_deleted(self, mock_broadcast, authenticated_client, db_session):
        idea = MealIdea(title="Remove Me")
        db_session.add(idea)
        db_session.commit()
        db_session.refresh(idea)

        response = authenticated_client.delete(f"/api/meal-ideas/{idea.id}")
        assert response.status_code == 200
        payload = mock_broadcast.call_args[0][1]
        assert payload["action"] == "deleted"
        assert payload["ideaId"] == str(idea.id)
```

- [ ] **Step 4: Run backend tests**

Run: `.venv/bin/python -m pytest backend/tests/test_api.py -v -k "SSEPayload" 2>&1`
Expected: All new tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/test_api.py
git commit -m "test: add SSE broadcast payload assertions for all routers"
```

---

### Task 11: Frontend Tests — SSE Apply Logic

**Files:**
- Modify: `frontend/src/hooks/__tests__/useStores.test.ts`
- Modify: `frontend/src/hooks/__tests__/useGroceryList.test.ts`
- Modify: `frontend/src/hooks/__tests__/usePantry.test.ts`
- Modify: `frontend/src/hooks/__tests__/useMealIdeas.test.ts`

Add tests that dispatch `meal-planner-realtime` CustomEvents with data-carrying payloads and verify the hook state updates correctly.

- [ ] **Step 1: Read existing test files to understand mock patterns**

Read each test file to understand how they mock the API, set up state, and dispatch realtime events. Use the existing patterns.

- [ ] **Step 2: Add useStores SSE apply tests**

Add to the existing test file. The tests should:
1. Set up initial store state (mock API to return initial stores)
2. Dispatch a `meal-planner-realtime` CustomEvent with `type: 'stores.updated'` and a data-carrying payload
3. Verify the store state was updated correctly without any API refetch

Example test structure:
```typescript
it('applies added store from SSE without refetching', async () => {
  // Setup: render hook with initial stores
  // Dispatch: window.dispatchEvent(new CustomEvent('meal-planner-realtime', {
  //   detail: { type: 'stores.updated', payload: { action: 'added', store: { id: 'new-id', name: 'Costco', position: 2 } } }
  // }))
  // Assert: hook state includes the new store
  // Assert: getStoresAPI was NOT called again
});

it('applies deleted store from SSE without refetching', async () => { ... });
it('applies updated store from SSE without refetching', async () => { ... });
it('applies reordered stores from SSE without refetching', async () => { ... });
it('defers SSE apply when mutations are pending', async () => { ... });
```

- [ ] **Step 3: Add useGroceryList SSE apply tests**

Same pattern. Key tests:
```typescript
it('applies item-added from SSE', async () => { ... });
it('applies item-deleted from SSE', async () => { ... });
it('applies item-updated from SSE', async () => { ... });
it('applies item-moved from SSE', async () => { ... });
it('applies section-added from SSE', async () => { ... });
it('applies section-deleted from SSE', async () => { ... });
it('applies cleared-checked from SSE', async () => { ... });
it('applies cleared-all from SSE', async () => { ... });
it('applies replaced from SSE', async () => { ... });
```

- [ ] **Step 4: Add usePantry SSE apply tests**

Same pattern as grocery, adapted for pantry types (no `checked`/`store_id` fields).

- [ ] **Step 5: Add useMealIdeas SSE apply tests**

```typescript
it('applies added idea from SSE', async () => { ... });
it('applies updated idea from SSE', async () => { ... });
it('applies deleted idea from SSE', async () => { ... });
```

- [ ] **Step 6: Run frontend tests**

Run: `npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/__tests__/
git commit -m "test: add SSE apply logic tests for all hooks"
```

---

### Task 12: Verify Full Test Suite & Build

- [ ] **Step 1: Run all backend tests**

Run: `/Users/evan.callia/Desktop/meal-planner/.venv/bin/python -m pytest /Users/evan.callia/Desktop/meal-planner/backend/tests/ -v 2>&1`
Expected: All tests pass.

- [ ] **Step 2: Run all frontend tests**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: All tests pass.

- [ ] **Step 3: Run frontend build**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 4: Fix any failures and commit**

If any test failures or build errors, fix and commit.
