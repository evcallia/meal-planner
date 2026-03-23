# Grocery Store Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ability to assign grocery stores to items, with persistent defaults, store subtext display, filter bar, and sort-by-store.

**Architecture:** New `Store` and `ItemDefault` models in the backend with a dedicated stores router. Frontend gets a `useStores` hook, store autocomplete in the item edit view, a filter chip bar, and a sort-by-store toggle. All changes follow existing optimistic update, SSE, and offline patterns.

**Tech Stack:** FastAPI, SQLAlchemy, PostgreSQL (backend); React, TypeScript, Tailwind CSS, Dexie/IndexedDB (frontend)

**Spec:** `docs/superpowers/specs/2026-03-23-grocery-store-assignment-design.md`

---

## File Structure

### Backend — New Files
- `backend/app/routers/stores.py` — Store CRUD endpoints (GET, POST, PATCH, DELETE, reorder)

### Backend — Modified Files
- `backend/app/models.py` — Add `Store`, `ItemDefault` models; add `store_id` FK to `GroceryItem`
- `backend/app/schemas.py` — Add store/item-default schemas; add `store_id` to grocery schemas
- `backend/app/routers/grocery.py` — Auto-populate `store_id` from defaults on create; upsert defaults on store assignment; handle `store_id` in update/replace
- `backend/app/main.py` — Register stores router, add migration for `store_id` column + new tables
- `backend/tests/test_api.py` — Store CRUD tests, auto-default tests, grocery store assignment tests

### Frontend — New Files
- `frontend/src/hooks/useStores.ts` — Hook for store CRUD, SSE sync, local caching
- `frontend/src/components/StoreAutocomplete.tsx` — Autocomplete input for store selection
- `frontend/src/components/StoreFilterBar.tsx` — Horizontally scrollable filter chips

### Frontend — Modified Files
- `frontend/src/types.ts` — Add `Store` type; add `store_id` to `GroceryItem`
- `frontend/src/api/client.ts` — Add store API functions; add `store_id` to grocery API functions
- `frontend/src/db.ts` — Add `stores` table to IndexedDB (v7); add `store_id` to `LocalGroceryItem`; add store local persistence functions
- `frontend/src/hooks/useGroceryList.ts` — Pass `store_id` through all mutation paths (add, edit, delete, replace, undo/redo)
- `frontend/src/components/GroceryListView.tsx` — Add filter bar, sort toggle, store subtext in item rows, store picker in edit mode

---

## Task 1: Backend — Store and ItemDefault Models

**Files:**
- Modify: `backend/app/models.py:136-156` (GroceryItem) and append new models
- Modify: `backend/app/schemas.py:133-196` (grocery schemas) and append new schemas

- [ ] **Step 1: Add Store model to models.py**

After the `GroceryItem` class (after line 156), add:

```python
class Store(Base):
    """Grocery stores (e.g., Whole Foods, Trader Joe's)."""
    __tablename__ = "stores"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(Text, unique=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ItemDefault(Base):
    """Per-item defaults (e.g., default store for an item name)."""
    __tablename__ = "item_defaults"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    item_name: Mapped[str] = mapped_column(Text, unique=True)
    store_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stores.id", ondelete="SET NULL"), nullable=True
    )

    store: Mapped["Store | None"] = relationship("Store")
```

- [ ] **Step 2: Add store_id FK to GroceryItem model**

In the `GroceryItem` class, after the `position` field (line 149), add:

```python
    store_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stores.id", ondelete="SET NULL"), nullable=True
    )
```

And add a relationship:

```python
    store: Mapped["Store | None"] = relationship("Store")
```

- [ ] **Step 3: Add schemas to schemas.py**

After the grocery schemas section (after line 196), add:

```python
class StoreSchema(BaseModel):
    id: UUID
    name: str
    position: int

    class Config:
        from_attributes = True


class StoreCreate(BaseModel):
    name: str = Field(..., min_length=1)
    position: int | None = None


class StoreUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    position: int | None = None


class StoreReorder(BaseModel):
    store_ids: list[UUID]
```

- [ ] **Step 4: Add store_id to existing grocery schemas**

Add `store_id: UUID | None = None` to:
- `GroceryItemSchema` (line 133)
- `GroceryItemCreate` (line 156)
- `GroceryItemUpdate` (line 166)
- `GroceryReplaceItem` (line 172)

- [ ] **Step 5: Commit**

```bash
git add backend/app/models.py backend/app/schemas.py
git commit -m "Add Store, ItemDefault models and store_id to grocery schemas"
```

---

## Task 2: Backend — Store Router (CRUD)

**Files:**
- Create: `backend/app/routers/stores.py`
- Modify: `backend/app/main.py:175-181` (router registration)

- [ ] **Step 1: Create stores router**

Create `backend/app/routers/stores.py`:

```python
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import Store
from app.schemas import StoreSchema, StoreCreate, StoreUpdate, StoreReorder
from app.realtime import broadcast_event

router = APIRouter(prefix="/api/stores", tags=["stores"])


def to_title_case(name: str) -> str:
    return name.strip().title()


@router.get("", response_model=list[StoreSchema])
async def list_stores(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    return db.query(Store).order_by(Store.position.asc(), Store.name.asc()).all()


@router.post("", response_model=StoreSchema)
async def create_store(
    payload: StoreCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    name = to_title_case(payload.name)
    # Case-insensitive duplicate check
    existing = db.query(Store).filter(Store.name.ilike(name)).first()
    if existing:
        return existing

    max_pos = db.query(Store.position).order_by(Store.position.desc()).first()
    next_pos = payload.position if payload.position is not None else ((max_pos[0] + 1) if max_pos else 0)

    store = Store(name=name, position=next_pos)
    db.add(store)
    db.commit()
    db.refresh(store)
    await broadcast_event("stores.updated", {"id": str(store.id)}, source_id=request.headers.get("x-source-id"))
    return store


@router.patch("/{store_id}", response_model=StoreSchema)
async def update_store(
    store_id: UUID,
    payload: StoreUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")

    if payload.name is not None:
        name = to_title_case(payload.name)
        # Check for case-insensitive duplicate (excluding self)
        existing = db.query(Store).filter(Store.name.ilike(name), Store.id != store_id).first()
        if existing:
            raise HTTPException(status_code=409, detail="Store name already exists")
        store.name = name
    if payload.position is not None:
        store.position = payload.position

    db.commit()
    db.refresh(store)
    await broadcast_event("stores.updated", {"id": str(store.id)}, source_id=request.headers.get("x-source-id"))
    return store


@router.patch("/reorder", response_model=dict)
async def reorder_stores(
    payload: StoreReorder,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    for i, store_id in enumerate(payload.store_ids):
        db.query(Store).filter(Store.id == store_id).update({"position": i})
    db.commit()
    await broadcast_event("stores.updated", {}, source_id=request.headers.get("x-source-id"))
    return {"status": "ok"}


@router.delete("/{store_id}")
async def delete_store(
    store_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")
    db.delete(store)
    db.commit()
    await broadcast_event("stores.updated", {"id": str(store_id), "deleted": True}, source_id=request.headers.get("x-source-id"))
    return {"status": "deleted"}
```

- [ ] **Step 2: Register stores router in main.py**

In `backend/app/main.py`, add import and include the router. Add before the grocery router line (line 181):

```python
from app.routers import stores
# ...
app.include_router(stores.router)
```

Note: The `/reorder` endpoint must be registered before `/{store_id}` in the router. Ensure `reorder_stores` is defined above `update_store` and `delete_store` in the file, OR use a more specific path like `/reorder-stores`. **Actually**, FastAPI matches routes in order, and since `reorder` doesn't look like a UUID, the current ordering should be fine. But to match the existing codebase pattern (`/grocery/reorder-sections`), consider keeping the flat path style.

- [ ] **Step 3: Commit**

```bash
git add backend/app/routers/stores.py backend/app/main.py
git commit -m "Add stores router with CRUD endpoints"
```

---

## Task 3: Backend — Auto-Default Logic in Grocery Router

**Files:**
- Modify: `backend/app/routers/grocery.py:1-19` (imports), `164-190` (add_grocery_item), `141-161` (update_grocery_item), `41-80` (replace_grocery)

- [ ] **Step 1: Update imports in grocery.py**

Add `Store` and `ItemDefault` to the models import (line 8):

```python
from app.models import GrocerySection, GroceryItem, Store, ItemDefault
```

- [ ] **Step 2: Add auto-populate to add_grocery_item**

In `add_grocery_item` (line 164-190), after creating the `GroceryItem` instance (line 180-185), add store_id logic:

```python
    # Auto-populate store from item_defaults if not provided
    store_id = payload.store_id
    if store_id is None:
        default = db.query(ItemDefault).filter(
            ItemDefault.item_name == payload.name.strip().lower()
        ).first()
        if default and default.store_id:
            store_id = default.store_id

    item = GroceryItem(
        section_id=payload.section_id,
        name=payload.name.strip(),
        quantity=payload.quantity,
        position=next_pos,
        store_id=store_id,
    )
```

- [ ] **Step 3: Add store_id handling to update_grocery_item**

In `update_grocery_item` (line 141-161), add handling for `store_id` after the existing field updates:

```python
    if 'store_id' in payload.model_fields_set:
        item.store_id = payload.store_id
        # Upsert item_defaults
        normalized_name = item.name.strip().lower()
        if payload.store_id is not None:
            default = db.query(ItemDefault).filter(
                ItemDefault.item_name == normalized_name
            ).first()
            if default:
                default.store_id = payload.store_id
            else:
                db.add(ItemDefault(item_name=normalized_name, store_id=payload.store_id))
        else:
            # Clearing store — also clear the default
            default = db.query(ItemDefault).filter(
                ItemDefault.item_name == normalized_name
            ).first()
            if default:
                default.store_id = None
```

- [ ] **Step 4: Add store_id to GroceryItemUpdate schema**

Already done in Task 1 Step 4. Verify `store_id: UUID | None = None` is in `GroceryItemUpdate`.

- [ ] **Step 5: Add store_id to replace_grocery**

In `replace_grocery` (line 41-80), when creating items from the payload, pass through `store_id`:

Find where `GroceryItem(...)` is constructed in the replace loop and add `store_id=item_data.store_id`:

```python
            item = GroceryItem(
                section_id=section.id,
                name=item_data.name,
                quantity=item_data.quantity,
                checked=item_data.checked,
                position=j,
                store_id=item_data.store_id,
            )
```

Note: `PUT` does NOT trigger item_defaults lookups per the spec.

- [ ] **Step 6: Commit**

```bash
git add backend/app/routers/grocery.py
git commit -m "Add store auto-populate and item_defaults upsert to grocery endpoints"
```

---

## Task 4: Backend — Migration for New Tables and Column

**Files:**
- Modify: `backend/app/main.py:66-124` (run_migrations function)

- [ ] **Step 1: Add migration for store_id column and new tables**

In `run_migrations()` in `backend/app/main.py`, add after the existing migrations (before line 124):

```python
    # Add store_id column to grocery_items if missing
    if inspector.has_table("grocery_items"):
        grocery_columns = [col["name"] for col in inspector.get_columns("grocery_items")]
        if "store_id" not in grocery_columns:
            print("Adding store_id column to grocery_items...")
            with engine.connect() as conn:
                conn.execute(text("ALTER TABLE grocery_items ADD COLUMN store_id UUID REFERENCES stores(id) ON DELETE SET NULL"))
                conn.commit()
            print("Migration complete: added store_id column")
```

Note: The `stores` and `item_defaults` tables are created automatically by `Base.metadata.create_all(bind=engine)` (line 129) since they're defined in models.py. Only the `store_id` column on the existing `grocery_items` table needs an ALTER.

- [ ] **Step 2: Add Store import to main.py**

Ensure `Store` and `ItemDefault` are imported (they'll be pulled in via `models.py` by the existing `from app.models import ...` or by `Base.metadata.create_all`). Verify `models.py` is imported in main.py so all models are registered with Base.

- [ ] **Step 3: Commit**

```bash
git add backend/app/main.py
git commit -m "Add migration for store_id column on grocery_items"
```

---

## Task 5: Backend — Tests for Stores and Auto-Defaults

**Files:**
- Modify: `backend/tests/test_api.py`
- Modify: `backend/tests/conftest.py` (if needed for store fixtures)

- [ ] **Step 1: Add store CRUD tests**

Add a new test class to `backend/tests/test_api.py`:

```python
class TestStoresAPI:
    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_create_and_list_stores(self, mock_broadcast, authenticated_client, db_session):
        # Create store
        resp = authenticated_client.post("/api/stores", json={"name": "trader joes"})
        assert resp.status_code == 200
        store = resp.json()
        assert store["name"] == "Trader Joes"  # title case
        assert store["position"] == 0

        # List stores
        resp = authenticated_client.get("/api/stores")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_create_duplicate_store_returns_existing(self, mock_broadcast, authenticated_client, db_session):
        resp1 = authenticated_client.post("/api/stores", json={"name": "Whole Foods"})
        resp2 = authenticated_client.post("/api/stores", json={"name": "whole foods"})
        assert resp1.json()["id"] == resp2.json()["id"]

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_rename_store(self, mock_broadcast, authenticated_client, db_session):
        resp = authenticated_client.post("/api/stores", json={"name": "Old Name"})
        store_id = resp.json()["id"]
        resp = authenticated_client.patch(f"/api/stores/{store_id}", json={"name": "New Name"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "New Name"

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_delete_store_nullifies_grocery_items(self, mock_broadcast, authenticated_client, db_session):
        # Create store
        resp = authenticated_client.post("/api/stores", json={"name": "Target"})
        store_id = resp.json()["id"]

        # Create section and item with store
        section = GrocerySection(name="Produce", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        resp = authenticated_client.post("/api/grocery/items", json={
            "section_id": str(section.id), "name": "Apples", "store_id": store_id
        })
        item_id = resp.json()["id"]

        # Delete store
        authenticated_client.delete(f"/api/stores/{store_id}")

        # Verify item's store_id is nullified
        db_session.expire_all()
        item = db_session.query(GroceryItem).filter(GroceryItem.id == item_id).first()
        assert item.store_id is None

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_reorder_stores(self, mock_broadcast, authenticated_client, db_session):
        r1 = authenticated_client.post("/api/stores", json={"name": "Store A"})
        r2 = authenticated_client.post("/api/stores", json={"name": "Store B"})
        id_a, id_b = r1.json()["id"], r2.json()["id"]

        resp = authenticated_client.patch("/api/stores/reorder", json={"store_ids": [id_b, id_a]})
        assert resp.status_code == 200

        stores = authenticated_client.get("/api/stores").json()
        assert stores[0]["name"] == "Store B"
        assert stores[1]["name"] == "Store A"
```

- [ ] **Step 2: Add auto-default tests**

```python
class TestGroceryStoreDefaults:
    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_assign_store_creates_default(self, mock_store_broadcast, mock_grocery_broadcast, authenticated_client, db_session):
        # Create store and section
        store = authenticated_client.post("/api/stores", json={"name": "Costco"}).json()
        section = GrocerySection(name="Dairy", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        # Create item
        item = authenticated_client.post("/api/grocery/items", json={
            "section_id": str(section.id), "name": "Milk"
        }).json()

        # Assign store
        authenticated_client.patch(f"/api/grocery/items/{item['id']}", json={
            "store_id": store["id"]
        })

        # Verify default was created
        default = db_session.query(ItemDefault).filter(ItemDefault.item_name == "milk").first()
        assert default is not None
        assert str(default.store_id) == store["id"]

    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_add_item_auto_populates_store(self, mock_store_broadcast, mock_grocery_broadcast, authenticated_client, db_session):
        # Create store, section, and set up a default
        store = authenticated_client.post("/api/stores", json={"name": "Trader Joes"}).json()
        section = GrocerySection(name="Produce", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        # Create and assign store to establish default
        item1 = authenticated_client.post("/api/grocery/items", json={
            "section_id": str(section.id), "name": "Bananas"
        }).json()
        authenticated_client.patch(f"/api/grocery/items/{item1['id']}", json={
            "store_id": store["id"]
        })

        # Delete item, then re-add — should auto-populate store
        authenticated_client.delete(f"/api/grocery/items/{item1['id']}")
        item2 = authenticated_client.post("/api/grocery/items", json={
            "section_id": str(section.id), "name": "Bananas"
        }).json()
        assert item2["store_id"] == store["id"]

    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_clear_store_clears_default(self, mock_store_broadcast, mock_grocery_broadcast, authenticated_client, db_session):
        store = authenticated_client.post("/api/stores", json={"name": "Aldi"}).json()
        section = GrocerySection(name="Snacks", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        item = authenticated_client.post("/api/grocery/items", json={
            "section_id": str(section.id), "name": "Chips"
        }).json()

        # Assign then clear
        authenticated_client.patch(f"/api/grocery/items/{item['id']}", json={"store_id": store["id"]})
        authenticated_client.patch(f"/api/grocery/items/{item['id']}", json={"store_id": None})

        default = db_session.query(ItemDefault).filter(ItemDefault.item_name == "chips").first()
        assert default.store_id is None
```

- [ ] **Step 3: Run backend tests**

```bash
cd /Users/evan.callia/Desktop/meal-planner/backend && .venv/bin/python -m pytest tests/ -v 2>&1
```

Expected: All tests pass, including new store tests.

- [ ] **Step 4: Commit**

```bash
git add backend/tests/test_api.py
git commit -m "Add tests for store CRUD and auto-default logic"
```

---

## Task 6: Frontend — Types, API Client, and IndexedDB Updates

**Files:**
- Modify: `frontend/src/types.ts:36,60-68,70-75`
- Modify: `frontend/src/api/client.ts:253-319`
- Modify: `frontend/src/db.ts:65-186,420-460`

- [ ] **Step 1: Add Store type and store_id to GroceryItem in types.ts**

In `frontend/src/types.ts`, add after line 36 (`ConnectionStatus`):

```typescript
export interface Store {
  id: string;
  name: string;
  position: number;
}
```

Add `store_id: string | null;` to the `GroceryItem` interface (after `position`).

- [ ] **Step 2: Add store API functions to client.ts**

Append to `frontend/src/api/client.ts`:

```typescript
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
```

- [ ] **Step 3: Update grocery API functions to include store_id**

In `replaceGroceryList` (line 260), update the type to include `store_id`:

```typescript
export async function replaceGroceryList(sections: { name: string; items: { name: string; quantity: string | null; checked?: boolean; store_id?: string | null }[] }[]): Promise<GrocerySection[]> {
```

In `addGroceryItem` (line 274), add `store_id` parameter:

```typescript
export async function addGroceryItem(sectionId: string, name: string, quantity: string | null = null, storeId: string | null = null): Promise<GroceryItem> {
  return fetchAPI<GroceryItem>('/grocery/items', {
    method: 'POST',
    body: JSON.stringify({ section_id: sectionId, name, quantity, store_id: storeId }),
  });
}
```

In `editGroceryItem` (line 308), update the updates type:

```typescript
export async function editGroceryItem(itemId: string, updates: { name?: string; quantity?: string | null; store_id?: string | null }): Promise<GroceryItem> {
```

- [ ] **Step 4: Update IndexedDB schema to v7 with stores table**

In `frontend/src/db.ts`, add a `LocalStore` interface near the other local interfaces (after line 69):

```typescript
export interface LocalStore {
  id: string;
  name: string;
  position: number;
}
```

Add `store_id: string | null;` to `LocalGroceryItem` interface (after `position` field).

Add `stores` table to the DB class (after line 119):

```typescript
  stores!: Table<LocalStore, string>;
```

Add version 7 after the version 6 block (after line 173):

```typescript
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
```

Add table initialization (after line 184):

```typescript
    this.stores = this.table('stores');
```

- [ ] **Step 5: Add store persistence functions to db.ts**

Append to `frontend/src/db.ts`:

```typescript
// Store persistence
export async function saveLocalStores(stores: LocalStore[]): Promise<void> {
  await db.stores.clear();
  if (stores.length > 0) await db.stores.bulkPut(stores);
}

export async function getLocalStores(): Promise<LocalStore[]> {
  return db.stores.orderBy('position').toArray();
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types.ts frontend/src/api/client.ts frontend/src/db.ts
git commit -m "Add store types, API functions, and IndexedDB schema v7"
```

---

## Task 7: Frontend — useStores Hook

**Files:**
- Create: `frontend/src/hooks/useStores.ts`

- [ ] **Step 1: Create the useStores hook**

Create `frontend/src/hooks/useStores.ts`:

```typescript
import { useState, useEffect, useCallback, useRef } from 'react';
import { Store } from '../types';
import {
  getStores as getStoresAPI,
  createStore as createStoreAPI,
  updateStore as updateStoreAPI,
  deleteStore as deleteStoreAPI,
  reorderStores as reorderStoresAPI,
} from '../api/client';
import { saveLocalStores, getLocalStores } from '../db';
import { useOnlineStatus } from './useOnlineStatus';

export function useStores() {
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const isOnline = useOnlineStatus();
  const pendingRef = useRef(0);
  const deferredRef = useRef(false);

  const loadStores = useCallback(async () => {
    try {
      if (isOnline) {
        const data = await getStoresAPI();
        setStores(data);
        await saveLocalStores(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
      } else {
        const local = await getLocalStores();
        setStores(local);
      }
    } catch {
      const local = await getLocalStores();
      setStores(local);
    } finally {
      setLoading(false);
    }
  }, [isOnline]);

  const loadStoresRef = useRef(loadStores);
  loadStoresRef.current = loadStores;

  const settleMutation = useCallback(() => {
    pendingRef.current--;
    if (pendingRef.current === 0 && deferredRef.current) {
      deferredRef.current = false;
      loadStoresRef.current();
    }
  }, []);

  // Load on mount and online status change
  useEffect(() => {
    loadStores();
  }, [loadStores]);

  // Listen for SSE stores.updated events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.type === 'stores.updated') {
        if (pendingRef.current > 0) {
          deferredRef.current = true;
        } else {
          loadStoresRef.current();
        }
      }
    };
    window.addEventListener('meal-planner-realtime', handler);
    return () => window.removeEventListener('meal-planner-realtime', handler);
  }, []);

  const createStore = useCallback(async (name: string): Promise<Store | null> => {
    try {
      pendingRef.current++;
      const store = await createStoreAPI(name);
      setStores(prev => {
        const exists = prev.find(s => s.id === store.id);
        if (exists) return prev;
        const updated = [...prev, store].sort((a, b) => a.position - b.position);
        saveLocalStores(updated.map(s => ({ id: s.id, name: s.name, position: s.position })));
        return updated;
      });
      return store;
    } catch {
      return null;
    } finally {
      settleMutation();
    }
  }, [settleMutation]);

  const renameStore = useCallback(async (storeId: string, name: string) => {
    pendingRef.current++;
    setStores(prev => prev.map(s => s.id === storeId ? { ...s, name } : s));
    try {
      await updateStoreAPI(storeId, { name });
    } catch { /* will sync on next load */ }
    finally { settleMutation(); }
  }, [settleMutation]);

  const removeStore = useCallback(async (storeId: string) => {
    pendingRef.current++;
    setStores(prev => {
      const updated = prev.filter(s => s.id !== storeId);
      saveLocalStores(updated.map(s => ({ id: s.id, name: s.name, position: s.position })));
      return updated;
    });
    try {
      await deleteStoreAPI(storeId);
    } catch { /* will sync on next load */ }
    finally { settleMutation(); }
  }, [settleMutation]);

  const reorderStoresLocal = useCallback(async (fromIndex: number, toIndex: number) => {
    pendingRef.current++;
    setStores(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);
      const reordered = updated.map((s, i) => ({ ...s, position: i }));
      saveLocalStores(reordered.map(s => ({ id: s.id, name: s.name, position: s.position })));

      reorderStoresAPI(reordered.map(s => s.id)).catch(() => {}).finally(() => settleMutation());
      // Don't settle here — the API call's finally handles it
      pendingRef.current--; // undo the increment since API call manages its own
      return reordered;
    });
  }, [settleMutation]);

  return { stores, loading, createStore, renameStore, removeStore, reorderStores: reorderStoresLocal };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/hooks/useStores.ts
git commit -m "Add useStores hook with CRUD, SSE sync, and local caching"
```

---

## Task 8: Frontend — Update useGroceryList for store_id

**Files:**
- Modify: `frontend/src/hooks/useGroceryList.ts`

This task threads `store_id` through all mutation paths. The key changes:

- [ ] **Step 1: Update addItem to pass store_id**

In `addItem` (line 346), the function creates items via `addGroceryItemAPI`. The backend now auto-populates `store_id` from defaults, so the frontend just needs to accept the response's `store_id` field (already handled since `GroceryItem` type now includes it).

For offline creation, when generating a temp item, set `store_id: null` (the default will be applied when synced online):

Find the `GroceryItem` construction in addItem (around line 440-450) and add `store_id: null`.

- [ ] **Step 2: Update editItem to support store_id changes**

In `editItem` (line 553), update the `updates` parameter type to include `store_id`:

```typescript
const editItem = useCallback(async (itemId: string, updates: { name?: string; quantity?: string | null; store_id?: string | null }) => {
```

Pass `store_id` through to `editGroceryItemAPI` and the local save. When saving locally, include `store_id` in the item data.

- [ ] **Step 3: Thread store_id through replace/undo/redo payloads**

In the `toPayload` helper used by undo/redo (appears in multiple places, e.g., line 583-586), add `store_id`:

```typescript
const toPayload = (secs: GrocerySection[]) => secs.map(s => ({
  name: s.name,
  items: s.items.map(i => ({ name: i.name, quantity: i.quantity, checked: i.checked, store_id: i.store_id })),
}));
```

Search for all occurrences of `toPayload` and similar inline payload constructions and ensure `store_id` is included.

- [ ] **Step 4: Update local save helpers to include store_id**

Anywhere `saveLocalGroceryItem` or `saveLocalGroceryItems` is called, ensure `store_id` is included in the object. Search for patterns like:

```typescript
{ id: i.id, section_id: i.section_id, name: i.name, quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at }
```

And add `store_id: i.store_id` to each.

- [ ] **Step 5: Update useSync.ts for store_id in queued changes**

In `frontend/src/hooks/useSync.ts`, the grocery change handlers need to pass `store_id` where applicable:
- `grocery-add`: pass `store_id` if present in the queued payload
- `grocery-edit`: pass `store_id` if present
- `grocery-replace`: already handled since replace passes full item objects

- [ ] **Step 6: Run frontend tests**

```bash
cd /Users/evan.callia/Desktop/meal-planner/frontend && npm run test:run 2>&1
```

Fix any failures caused by the new `store_id` field (mainly mock data missing the field).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useGroceryList.ts frontend/src/hooks/useSync.ts
git commit -m "Thread store_id through all grocery mutation paths"
```

---

## Task 9: Frontend — StoreAutocomplete Component

**Files:**
- Create: `frontend/src/components/StoreAutocomplete.tsx`

- [ ] **Step 1: Create StoreAutocomplete component**

Create `frontend/src/components/StoreAutocomplete.tsx`:

```typescript
import { useState, useRef, useEffect } from 'react';
import { Store } from '../types';

interface StoreAutocompleteProps {
  stores: Store[];
  selectedStoreId: string | null;
  onSelect: (storeId: string | null) => void;
  onCreate: (name: string) => Promise<Store | null>;
}

export function StoreAutocomplete({ stores, selectedStoreId, onSelect, onCreate }: StoreAutocompleteProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedStore = stores.find(s => s.id === selectedStoreId);
  const filtered = query
    ? stores.filter(s => s.name.toLowerCase().includes(query.toLowerCase()))
    : stores;
  const exactMatch = stores.some(s => s.name.toLowerCase() === query.toLowerCase());

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (store: Store) => {
    onSelect(store.id);
    setQuery('');
    setIsOpen(false);
  };

  const handleCreate = async () => {
    if (!query.trim()) return;
    const store = await onCreate(query.trim());
    if (store) {
      onSelect(store.id);
      setQuery('');
      setIsOpen(false);
    }
  };

  const handleClear = () => {
    onSelect(null);
    setQuery('');
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        {selectedStore && !isOpen ? (
          <div className="flex items-center gap-1 text-sm">
            <span className="text-gray-600 dark:text-gray-400">{selectedStore.name}</span>
            <button
              onClick={handleClear}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs ml-1"
            >
              ✕
            </button>
            <button
              onClick={() => { setIsOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
              className="text-blue-500 text-xs ml-1"
            >
              change
            </button>
          </div>
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }}
            onFocus={() => setIsOpen(true)}
            placeholder="Assign store..."
            className="w-full text-sm px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          />
        )}
      </div>
      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-white dark:bg-gray-800 border dark:border-gray-600 rounded shadow-lg max-h-40 overflow-y-auto">
          {filtered.map(store => (
            <button
              key={store.id}
              onClick={() => handleSelect(store)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {store.name}
            </button>
          ))}
          {query.trim() && !exactMatch && (
            <button
              onClick={handleCreate}
              className="w-full text-left px-3 py-2 text-sm text-blue-500 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Create "{query.trim()}"
            </button>
          )}
          {filtered.length === 0 && !query.trim() && (
            <div className="px-3 py-2 text-sm text-gray-400">No stores yet</div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/StoreAutocomplete.tsx
git commit -m "Add StoreAutocomplete component"
```

---

## Task 10: Frontend — Store Subtext and Edit View in GroceryItemRow

**Files:**
- Modify: `frontend/src/components/GroceryListView.tsx:561-812` (GroceryItemRow)

- [ ] **Step 1: Add store props to GroceryItemRow**

Update `GroceryItemRowProps` (line 561-569) to include:

```typescript
  stores: Store[];
  onStoreAssign: (itemId: string, storeId: string | null) => void;
  onCreateStore: (name: string) => Promise<Store | null>;
```

- [ ] **Step 2: Add store subtext in normal mode**

In the normal (non-editing) render of `GroceryItemRow`, after the item name/quantity display, add store subtext:

```tsx
{/* Store subtext */}
{storeName && (
  <div className="text-xs text-gray-400 dark:text-gray-500 leading-tight">
    {storeName}
  </div>
)}
```

Where `storeName` is derived at the top of the component:

```typescript
const storeName = props.stores.find(s => s.id === item.store_id)?.name;
```

Wrap the item name + subtext in a flex-col container so the subtext sits below the name.

- [ ] **Step 3: Add StoreAutocomplete in edit mode**

In the edit mode render (the `isEditing` block), after the name and quantity inputs, add:

```tsx
<StoreAutocomplete
  stores={stores}
  selectedStoreId={item.store_id}
  onSelect={(storeId) => onStoreAssign(item.id, storeId)}
  onCreate={onCreateStore}
/>
```

Import `StoreAutocomplete` at the top of the file.

- [ ] **Step 4: Update SectionCard to pass store props through**

Update `SectionCardProps` to include `stores`, `onStoreAssign`, and `onCreateStore`. Pass them through to each `GroceryItemRow`.

- [ ] **Step 5: Update GroceryListView to wire up store props**

The top-level `GroceryListView` needs access to `useStores()`. Add:

```typescript
const { stores, createStore } = useStores();
```

Wire `onStoreAssign` to call `editItem(itemId, { store_id: storeId })`.

Pass `stores`, `onStoreAssign`, and `createStore` to each `SectionCard`.

Also pass these props to the checked items section at the bottom (for consistency, though store assignment on checked items is less common).

- [ ] **Step 6: Run frontend tests and fix**

```bash
cd /Users/evan.callia/Desktop/meal-planner/frontend && npm run test:run 2>&1
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/GroceryListView.tsx frontend/src/components/StoreAutocomplete.tsx
git commit -m "Add store subtext display and store picker in item edit view"
```

---

## Task 11: Frontend — Store Filter Bar

**Files:**
- Create: `frontend/src/components/StoreFilterBar.tsx`
- Modify: `frontend/src/components/GroceryListView.tsx`

- [ ] **Step 1: Create StoreFilterBar component**

Create `frontend/src/components/StoreFilterBar.tsx`:

```typescript
import { Store } from '../types';

interface StoreFilterBarProps {
  stores: Store[];
  activeStoreId: string | null;
  onFilterChange: (storeId: string | null) => void;
}

export function StoreFilterBar({ stores, activeStoreId, onFilterChange }: StoreFilterBarProps) {
  if (stores.length === 0) return null;

  return (
    <div className="flex gap-2 overflow-x-auto pb-2 px-1 -mx-1 scrollbar-hide">
      {stores.map(store => (
        <button
          key={store.id}
          onClick={() => onFilterChange(activeStoreId === store.id ? null : store.id)}
          className={`
            flex-shrink-0 px-3 py-1 rounded-full text-sm font-medium transition-colors
            ${activeStoreId === store.id
              ? 'bg-blue-500 text-white'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }
          `}
        >
          {store.name}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Add filter state and logic to GroceryListView**

In `GroceryListView`, add state:

```typescript
const [filterStoreId, setFilterStoreId] = useState<string | null>(null);
```

Update `visibleSections` to apply the filter:

```typescript
const visibleSections = useMemo(() => {
  let filtered = sections.filter(s => s.items.some(i => !i.checked));
  if (filterStoreId) {
    filtered = filtered
      .map(s => ({
        ...s,
        items: s.items.filter(i => !i.checked && i.store_id === filterStoreId),
      }))
      .filter(s => s.items.length > 0);
  }
  return filtered;
}, [sections, filterStoreId]);
```

- [ ] **Step 3: Render StoreFilterBar**

Place `<StoreFilterBar>` between the action bar and the sections container:

```tsx
<StoreFilterBar
  stores={stores}
  activeStoreId={filterStoreId}
  onFilterChange={setFilterStoreId}
/>
```

Import `StoreFilterBar` at the top.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/StoreFilterBar.tsx frontend/src/components/GroceryListView.tsx
git commit -m "Add store filter bar with chip-based single-select filtering"
```

---

## Task 12: Frontend — Sort by Store Toggle

**Files:**
- Modify: `frontend/src/components/GroceryListView.tsx`

- [ ] **Step 1: Add sort state**

```typescript
const [sortByStore, setSortByStore] = useState(false);
```

- [ ] **Step 2: Apply sort to visibleSections**

Update the `visibleSections` memo to sort items by store when active:

```typescript
const visibleSections = useMemo(() => {
  let filtered = sections.filter(s => s.items.some(i => !i.checked));

  if (filterStoreId) {
    filtered = filtered
      .map(s => ({
        ...s,
        items: s.items.filter(i => !i.checked && i.store_id === filterStoreId),
      }))
      .filter(s => s.items.length > 0);
  }

  if (sortByStore) {
    // Sort items within each section by store position, then original position
    const storeOrder = new Map(stores.map(s => [s.id, s.position]));
    filtered = filtered.map(s => ({
      ...s,
      items: [...s.items].sort((a, b) => {
        const aPos = a.store_id ? (storeOrder.get(a.store_id) ?? Infinity) : Infinity;
        const bPos = b.store_id ? (storeOrder.get(b.store_id) ?? Infinity) : Infinity;
        if (aPos !== bPos) return aPos - bPos;
        return a.position - b.position;
      }),
    }));
  }

  return filtered;
}, [sections, filterStoreId, sortByStore, stores]);
```

- [ ] **Step 3: Add sort toggle button**

In the action bar area, add a sort toggle button (e.g., next to clear menu):

```tsx
{stores.length > 0 && (
  <button
    onClick={() => setSortByStore(prev => !prev)}
    className={`p-2 rounded ${sortByStore ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500'}`}
    title={sortByStore ? 'Unsort' : 'Sort by store'}
  >
    {/* Sort icon SVG */}
    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M3 3a1 1 0 000 2h11a1 1 0 100-2H3zM3 7a1 1 0 000 2h7a1 1 0 100-2H3zM3 11a1 1 0 100 2h4a1 1 0 100-2H3z" />
    </svg>
  </button>
)}
```

- [ ] **Step 4: Handle drag-reorder while sorted**

When `sortByStore` is active and a user reorders via drag, the visual order becomes the new permanent position order. The existing `reorderItems` function already writes new positions based on the dragged result. Since `visibleSections` applies the sort before rendering, the drag indices will naturally correspond to the sorted order, so no special handling is needed — the drag will write the sorted+dragged order as permanent positions.

Verify this works by testing manually. If the drag handler references `sections` directly instead of `visibleSections` for position calculation, adjust the mapping.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/GroceryListView.tsx
git commit -m "Add sort-by-store toggle with drag-reorder support"
```

---

## Task 13: Integration Test — Full Flow

**Files:**
- Run existing test suites

- [ ] **Step 1: Run all backend tests**

```bash
cd /Users/evan.callia/Desktop/meal-planner/backend && .venv/bin/python -m pytest tests/ -v 2>&1
```

- [ ] **Step 2: Run all frontend tests**

```bash
cd /Users/evan.callia/Desktop/meal-planner/frontend && npm run test:run 2>&1
```

- [ ] **Step 3: Run frontend build**

```bash
export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1
```

- [ ] **Step 4: Fix any failures and commit**

```bash
git add -A && git commit -m "Fix test and build issues for store assignment feature"
```

---

## Task Dependency Graph

```
Task 1 (Models/Schemas) ──┬──> Task 2 (Store Router) ──> Task 4 (Migration)
                          │
                          └──> Task 3 (Grocery Auto-Default) ──> Task 5 (Backend Tests)
                          │
                          └──> Task 6 (FE Types/API/DB) ──┬──> Task 7 (useStores Hook)
                                                          │
                                                          └──> Task 8 (useGroceryList store_id)
                                                          │
                                                          ├──> Task 9 (StoreAutocomplete)
                                                          │
                                                          └──> Task 10 (Item Row + Edit) ──> Task 11 (Filter Bar) ──> Task 12 (Sort Toggle)

Task 5 + Task 12 ──> Task 13 (Integration Test)
```

Tasks 2, 3, and 6 can run in parallel after Task 1 completes.
Tasks 7, 8, and 9 can run in parallel after Task 6 completes.
