# Lists tab (packing lists) — spec

A 5th tab, displayed as **"Lists"**, that combines the **multi-list,
private-until-shared** model of the Tasks (tracker) tab with the **sectioned
checklist + store chips** UX of the Grocery tab. "Stores" become **bags**,
displayed as **tags**.

> **Naming:** this feature was originally built as "Travel / packing lists" and
> every internal identifier still says so — the page id `travel`, the settings
> keys `featureTravel`/`notifyTravelEdits`/`packing*`, the `packing-*` change
> types, the `/api/packing` routes, the `Packing*` models and the `bags` table.
> Only the display vocabulary changed: **Travel → Lists**, **trip → list**,
> **bag → tag**, **packed → completed**. Likewise the tracker keeps the page id
> `lists` while being displayed as **Tasks**, and its lists are called
> **groups**.

## Data model (backend/internal/models/models.go)

```
PackingList        id, owner_sub, name, icon, color, position, created_at, updated_at
PackingShare       id, list_id, sub, created_at, left_at      (soft-leave, like TrackerShare)
PackingListPosition sub, list_id, position                    (per-user ordering)
PackingBag         id, list_id, name, position, created_at    (per-list "store")
PackingSection     id, list_id, name, position, created_at
PackingItem        id, section_id, name, quantity, checked, position, bag_id, created_at, updated_at
```

Bags/sections are **per list** (unlike grocery's global `stores`), so two lists can
have different tag sets without interference. Cascade deletes: list → sections →
items, list → bags (items' `bag_id` is nulled when a bag is deleted).

## Access control

Identical to the tracker: `owner_sub == me OR an active share row for me`.
Owner-only: delete list, add/remove shares. Everything else is collaborative.
`packingGetList(id, sub, ownerOnly)` mirrors `trackerGetList`.

## Checked-item behaviour (the key departure from grocery)

* Checking an item **never changes `position`**. Display order is
  `(checked ASC, position ASC)` — checked items sink to the bottom **of their own
  section**, and unchecking restores the item's original slot.
* Grocery instead lifts every checked item into one global "Checked" panel and
  orders it by `updated_at`; packing keeps them in place.
* `settings.packingShowChecked` (per-user, synced, default true) hides them
  entirely when off. It is the DEFAULT: `settings.packingShowCheckedOverrides`
  maps a list id to a pinned value, so one trip can hide its completed items
  while the rest keep showing them. The kebab toggle writes an override for the
  active list; "Use this for all lists" promotes the current value to the
  default and clears the overrides.
* `POST /api/packing/lists/{id}/check-all` with `{"checked": bool}` checks or
  unchecks every item in the list in one shot (menu action + single undo entry).

## Tag progress

The toolbar shows one progress row per tag plus a total:
`completed / total` and a percentage, derived **client-side** from the items
(`utils/packing.ts: bagProgress`). A 100 % tag renders struck through, matching
the spreadsheet this replaces. Tags with no items are omitted.

## API (`/api/packing`, all `auth()`-wrapped)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/packing` | every list the caller can see, full subtree |
| POST | `/api/packing/lists` | create |
| POST | `/api/packing/lists/restore` | full-subtree restore (offline undo of a delete) |
| PATCH | `/api/packing/lists/{listId}` | rename / icon / color |
| DELETE | `/api/packing/lists/{listId}` | owner-only |
| PATCH | `/api/packing/reorder-lists` | per-user ordering |
| POST/DELETE | `/api/packing/lists/{listId}/shares[/{sub}]` | owner-only sharing |
| POST | `/api/packing/lists/{listId}/leave`, `/rejoin` | membership |
| POST | `/api/packing/lists/{listId}/sections` | create section |
| PATCH/DELETE | `/api/packing/sections/{sectionId}` | rename / delete (empty only) |
| PATCH | `/api/packing/lists/{listId}/reorder-sections` | |
| PATCH | `/api/packing/sections/{sectionId}/reorder-items` | |
| POST | `/api/packing/items` | add |
| PATCH | `/api/packing/items/{itemId}` | name / quantity / checked / bag_id |
| PATCH | `/api/packing/items/{itemId}/move` | cross-section move |
| DELETE | `/api/packing/items/{itemId}` | |
| POST | `/api/packing/lists/{listId}/check-all` | `{checked}` bulk toggle |
| POST | `/api/packing/lists/{listId}/bags` | create tag |
| PATCH/DELETE | `/api/packing/bags/{bagId}` | rename / delete tag |
| PATCH | `/api/packing/lists/{listId}/reorder-bags` | |

All mutations broadcast `packing.updated` **per-user to the list's audience**
(`BroadcastToUser`), never globally — the same privacy rule as the tracker.
Delete endpoints are idempotent (204 when already gone).

## Notifications / activity feed

* Category `travel`, pref key `notifyTravelEdits` (opt-in, default off).
* Per-list mute reuses `settings.listNotifyOverrides[listId].edits` — the
  namespace is shared with the tracker but ids are UUIDs, so there's no clash.
* `queuePackingEditPush` mirrors `queueTrackerEditPush`: audience minus actor,
  reorders never notify, and the same phrase feeds `activity_log`
  (audience-snapshotted so entries stay private after a list is deleted).

## Removing sections

A section only exists to group items, so it never outlives them:

* deleting a section deletes its items too (one undo entry restores both);
* a section is pruned the moment its **last item leaves** — by delete or by
  move — server-side, with a `section-deleted` broadcast alongside the item
  event so every client drops the header;
* a section created **empty** is left alone: quick-add creates one before the
  first item lands, and pruning there would delete it out from under the add.

## Copying a section between lists

`usePacking.copySectionToList(fromListId, sectionId, toListId)` is built from
the hook's existing core primitives rather than a new endpoint, so it inherits
their optimistic updates, IndexedDB writes and offline queueing — and because
the cores don't push undo entries, the whole copy is a single undo step.

* items arrive **unchecked** (a copied list is a fresh checklist);
* tags are per-list, so the assignment carries across **by name** — a matching
  tag in the target is reused, otherwise it's created;
* a same-named section in the target is **merged into**, and item names already
  present are skipped, so copying the same section twice is a no-op.

## Frontend

* `usePackingLists()` — one hook owning **all** lists (mirrors `useTracker`'s
  shape): load/cache/SSE plus list CRUD, sharing, and every item/section/bag
  mutation, each with optimistic update → IndexedDB → API-or-queue → undo/redo.
* `PackingListsView.tsx` — list tabs, tag-progress toolbar, tag chips,
  quick-add, and the section cards. List tabs reorder by long-press drag and a
  list's name + color are edited together from the kebab ("Rename & color").
* `hooks/useTabReorder.ts` — the long-press tab-strip drag, extracted out of
  `ListsView` so both multi-list tabs share one gesture implementation.
* **Shared components** extracted from `GroceryListView` into
  `components/checklist/`: `ChecklistItemRow`, `ChecklistSectionCard`,
  `SectionCombobox`, `MenuRadioOption`. Grocery renders the same components, so
  swipe-to-delete, inline edit, drag handles and cross-section drag have exactly
  one implementation. `StoreFilterBar`, `StoreAutocomplete`, `ItemAutocomplete`
  and `useDragReorder` are reused as-is (a tag is structurally a `Store`).
* Item-name autocomplete has no server table for packing; the suggestion map is
  built client-side from **every** list the user can see, so "Toothbrush →
  Toiletry Bag" carries from one list to the next.
* IndexedDB v10 adds `packingLists`, `packingSections`, `packingItems`,
  `packingBags`. `ChangeType`s are prefixed `packing-`.
* Settings: `featureTravel` (Features section), `notifyTravelEdits`
  (Notifications section), plus per-list display prefs
  `packingShowChecked` / `packingHideBags` / `packingSortBy` / `packingGroupBy`.
