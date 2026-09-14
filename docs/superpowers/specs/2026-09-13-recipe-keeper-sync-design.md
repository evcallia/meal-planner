# Recipe Keeper ↔ Meal Planner grocery sync — design

**Date:** 2026-09-13
**Status:** design approved, not yet implemented
**Protocol reference:** [`docs/recipe-keeper-api.md`](../../recipe-keeper-api.md)

## Goal

Replace the manual paste-import of Recipe Keeper shopping lists with a live two-way
sync, and surface **which recipe each grocery item came from** — context the paste
format drops entirely.

## Non-goals

- Importing recipes themselves into Meal Planner. Only recipe *titles* are stored, as
  labels for grocery items.
- Syncing meal plans, cookbooks, categories-as-entities, or any other Recipe Keeper
  bucket.
- A per-user Recipe Keeper connection. One household connection (see
  [Configuration](#configuration)).
- Editing Recipe Keeper data beyond the shopping-list fields listed in
  [Outbound](#outbound-mp--rk).

## Decisions

Settled during design; each closed a real fork in the implementation.

| Decision | Choice | Why |
|---|---|---|
| Duplicate rows | **Collapse by name, keep every FK** | RK stores one row per recipe-ingredient occurrence — `Lemon` exists 6× from 6 recipes. Collapsing matches both the existing paste behaviour and how people shop. |
| Collapse scope | **Across RK-linked *and* MP-only units** | Mirrors the grouping MP already does (`useGroceryList.ts:458`). Makes quantity authoritative and removes the need for a quantity-override flag. |
| Partial acquisition | **Decrement checks links, never deletes** | Reversible, preserves attribution, and reuses MP's existing checked/unchecked row split. |
| Error surfacing | **Pinned row in the bell, not a feed entry** | A failure is state, not an event; pinned avoids both retry-spam and staleness, and self-clears. |
| MP-only items | **Stay local** | Keeps the write surface to *updates of rows RK created*. We never create entities in RK. |
| Deletes | **Propagate, including bulk clears** | A local-only delete resurrects on the next pull. Backed by tombstones for the window where a push hasn't landed. |
| Credentials | **Server config** | The MP grocery list is already shared/global; one household connection matches it. |
| Source list | **The main list only** | MP has exactly one grocery list. |
| First run | **Same path as every sync** | Superseded: collapse across MP-only units means RK items merge into existing rows. No duplicates, no once-only logic (see [First run](#first-run)). |
| Group by recipe | **In scope for v1** | Answers "what do I need for the fig cocktail", complementing the per-item popover. |

## Architecture

Runs in the Go backend as `internal/recipekeeper/`, started from `cmd/server` beside
`RunDueLoop`. It cannot live in the frontend: something must hold a 60-second
long-poll and household credentials, and the frontend is offline-first — it is not a
reliable agent for a remote sync. The browser continues to talk only to this API.

```
Recipe Keeper API                Backend                          Frontend
─────────────────                ───────────────                  ─────────────
/api/syncnotification ──200──▶  recipekeeper.Loop
                                      │ pull (4 buckets)
/api/sync ◀───────────────────────────┤
                                      ▼
                                  reconciler ──▶ grocery_items ──▶ SSE grocery.updated ──▶ UI
                                      ▲                                (already exists)
/api/sync ◀──── push ─────────── reconciler ◀── grocery mutations
```

| File | Responsibility |
|---|---|
| `client.go` | Protocol only: `Token`, `Sync`, `Notify`. No business logic. |
| `auth.go` | Token cache, `exp` decoding, proactive renewal, backoff. |
| `reconcile.go` | All sync logic. Pure functions over DB state — **no HTTP**. |
| `loop.go` | Long-poll driver, scheduling, error containment. |
| `app/recipekeeper.go` | `GET /api/recipe-keeper/status`, `POST /api/recipe-keeper/sync`. |

Splitting HTTP from reconciliation is what lets the reconciler be tested exhaustively
against captured payloads without a network.

## Data model

Four new tables. **`grocery_items` is unchanged** — no new columns, no nullable RK
fields threaded through existing code. An item with no links is an ordinary MP item
and every current code path keeps working.

```
recipe_keeper_links              -- the FK. One row per RK row; many per grocery row.
  rk_item_id        text PK      -- RK's stable GUID
  mp_name           text         -- normalized collapse key: which MP row this
  mp_checked        bool         --   link belongs to. NOT a grocery_items FK.
  rk_recipe_id      text NULL    -- the attribution
  rk_name           text         -- last known RK state, for outbound diffing
  rk_checked        bool         -- last known RK state, for outbound diffing
  rk_last_modified  text         -- server value WITH Z; Z stripped when pushing
  rk_position       int          -- echoed back on push; never used for display

recipe_keeper_recipes            -- Id → Title cache
  rk_recipe_id      text PK
  title             text
  rk_last_modified  text

recipe_keeper_tombstones         -- resurrection guard + delete intent
  rk_item_id        text PK
  deleted_at        timestamp
  pushed_at         timestamp NULL   -- NULL = delete still pending
  ack_last_modified text NULL        -- server LastModified of the delete ack

recipe_keeper_state              -- watermarks, device id, last sync, last error
  key               text PK
  value             text
```

Created by GORM `AutoMigrate` on startup, consistent with the rest of the project.

**The link table is the entire "FK intact" requirement.** Collapse is a `GROUP BY` on
normalized name; quantity is `COUNT(links)`; recipe names are a join through
`rk_recipe_id`.

**Links deliberately do not reference `grocery_items.id`.** See
[Undo, redo, and id churn](#undo-redo-and-id-churn) — a FK there is not merely
inconvenient, it silently destroys the table on the first undo.

## Sync rules

### Collapse

The collapse key is `(normalized name, checked)` — name **lowercased and trimmed**.
RK names arrive roughly title-cased (`"Maple Syrup"`); MP applies `toTitleCase`.
Matching is case-insensitive in both directions.

This is **the grouping MP already does**: `useGroceryList.ts:458` merges same-name
*unchecked* items and sums their quantities. Checked and unchecked rows of the same
name coexist deliberately — that is how MP represents "I bought 1, I still need 3",
and the [decrement rules](#partial-acquisition-decrementing) below build directly on it.

**A grocery row is the group; links are a subset of its units.**

```
"Lemon"  quantity 4
   ├── link → RK row (Fig Cocktail)
   ├── link → RK row (Thai Curry)
   ├── link → RK row (Ceviche)
   └── 1 MP-only unit  — implicit: quantity − COUNT(links)
```

MP-only units are not rows; they are the remainder. **Invariant:
`quantity >= COUNT(live links)`.**

Grouping across RK-linked and MP-only units does **not** widen the write surface. An
MP-only unit never becomes an RK row — only linked units are ever pushed — so the
"MP-only items stay local" decision holds unchanged.

### Inbound (RK → MP)

Per `ShoppingListItem` in `UpdatedServerItems`:

| Condition | Action |
|---|---|
| `rk_item_id` in tombstones | Ignore — resurrection guard |
| `IsDeleted: true` | Drop the link. Other links remain → quantity decrements. Last link gone → delete the MP item. |
| Link exists, `LastModified` equals stored | **No-op — our own echo** |
| Link exists, `LastModified` newer | Apply `Name` and `IsChecked` |
| No link, live | Attach to any existing row with the same collapse key — RK-linked or MP-only — else create a new row |

Items whose `ShoppingListId` is not the configured list are ignored entirely.

### Outbound (MP → RK)

**Declarative, not a queue.** Each link stores the last known RK state (`rk_name`,
`rk_checked`). A reconcile pass diffs the grocery item against its links and pushes
the difference. Nothing to drain, nothing to lose across a restart, and a failed push
simply retries on the next pass.

| MP change | Pushed? | Detail |
|---|---|---|
| Check / uncheck | Yes | All links. `CheckedDate` = now (naive UTC) on check, `null` on uncheck. |
| Rename | Yes | All links get the MP name. |
| Delete, incl. clear-all / clear-checked | Yes | All links `IsDeleted: true`, plus a tombstone row each. |
| Quantity edit | **No** | RK has no quantity field. |
| Section move, reorder, store change | **No** | MP is authoritative. |
| MP-only item (no links) | **No** | Invisible to this subsystem. |

Every push sends the **complete entity** — the protocol has no partial-update
semantics. Pushes are built from the link's stored fields with only the changed
values replaced, and the acknowledgement's `LastModified` is written back to the link
immediately.

Deletes are driven by tombstones with `pushed_at IS NULL`, so a delete survives a
crash between the local delete and the push.

### Tombstone retention

A tombstone is needed only until RK can no longer re-send that row — precisely, until
the delete is acknowledged **and** our watermark has advanced past the ack. After that
the row can never reappear in `UpdatedServerItems`.

Pruned in the existing `db.CleanupOldData`, alongside activity-log retention — and the
link is pruned with it, since the link is kept alive after the delete push purely so
[an undo](#undo-redo-and-id-churn) can rebuild the entity:

```sql
DELETE FROM recipe_keeper_tombstones
 WHERE pushed_at IS NOT NULL
   AND ack_last_modified <= <watermark:ShoppingListItem>
-- and the matching recipe_keeper_links rows
```

Steady-state count is effectively zero — tombstones live seconds, not forever. Two
backstops guard the edges:

- Pushed tombstones older than **30 days** are pruned regardless, in case watermark
  bookkeeping ever goes wrong.
- An **unpushed** tombstone is retained (it is a pending delete) until 90 days, then
  dropped with a log line rather than retrying indefinitely against an endpoint that
  is evidently never coming back.

### Conflict resolution and rename edge cases

Two cases the rules above leave implicit:

**Inbound wins over an unpushed local change.** If RK renames an item while MP has an
unpushed rename of its own, applying the inbound value must update **both** the grocery
item *and* `link.rk_name`. Updating only the item would leave the outbound diff dirty,
and the next reconcile would push the local name straight back — an oscillation
between two devices that never settles. Same for `rk_checked`. Inbound application
always writes both sides.

**A rename can split a collapse group.** Renaming one of six `Lemon` rows in RK changes
its collapse key. That link must detach from the `Lemon` item (decrementing its
quantity) and attach to — or create — the item matching its new name. The reverse also
holds: a rename that makes two groups match merges them.

### Undo, redo, and id churn

Meal Planner's undo for item delete and for clear replays a full list snapshot
through `PUT /api/grocery` (`replaceGroceryListAPI`). That handler deletes **every**
section and recreates the list with **fresh ids** (`grocery.go:191-192`).

A link holding `grocery_item_id` with `ON DELETE CASCADE` would therefore be destroyed
en masse by a single undo: the whole table cascades away, the entire grocery list
silently becomes MP-only, and the tombstones left behind block everything from being
re-imported. It is a failure that shows up days later as "sync stopped working", with
no event to trace it back to.

So a link stores `(mp_name, mp_checked)` — the collapse key the model already groups
on — instead of a row id. Ids may churn freely; links re-resolve by key afterwards.
This stores what the model actually keys on rather than a proxy for it, and removes
the cascade hazard rather than defending against it.

Consequences:

- **Replace never creates tombstones.** It is an id churn, not a deletion. Only the
  explicit delete and clear endpoints tombstone.
- **Undo of a delete is handled by the same declarative pass.** If a tombstone exists
  and its collapse key resolves to a live row again, the item is back: drop the
  tombstone if it was never pushed, or push `IsDeleted: false` if it was. Recipe
  Keeper's deletes are soft, so un-deleting is an ordinary field update — no snapshot
  restore path and no special-case undo endpoint.
- **Links outlive the delete push.** `ApplyAcks` marks the tombstone rather than
  deleting the link, so an undo arriving after the push still has the entity to
  rebuild from. Link and tombstone are pruned together once settled.
- **An unresolvable link with no tombstone is an orphan**, logged and cleaned up but
  **never** pushed as a delete. Deletion is only ever expressed by a tombstone.

### Offline behaviour

Two independent offline domains, and only the first is new to this project:

```
client ──(IndexedDB queue, existing)──▶ MP backend ──(declarative reconcile)──▶ RK
```

A client being offline has no bearing on the RK connection, which lives in the
backend. Queued changes drain into the backend as usual and the next reconcile pushes
whatever now differs. **No offline-specific machinery is required** — because outbound
is a diff of current state rather than a queue of events, it does not matter when or
in what order changes arrived. A 4 → 3 → 2 decrement replayed from the queue converges
on the same push set as a single 4 → 2.

The one hazard is that Recipe Keeper is a writer the client cannot see. A queued edit
may land on a row that RK has since deleted or split. This is not a new class of
problem — another household member can already do it — but RK does it more often than
a person would, so **item-update handlers must treat a missing row as already-applied**
rather than returning 404. A 404 burns all 20 `MAX_SYNC_ATTEMPTS` retries before the
change is discarded, turning a benign race into a stuck queue.

### Echo suppression

Two layers, because either alone is insufficient:

1. **The inbound path does not trigger outbound.** Applying a delta runs in a context
   that skips the reconcile trigger.
2. **`LastModified` equality.** The doorbell *will* ring for our own push. An inbound
   entity whose `LastModified` matches the value already stored on the link is our own
   write and stops there.

### Checked state under collapse

Because the collapse key includes `checked`, a row is wholly checked or wholly
unchecked — there is no partially-checked row. Check state is expressed by **which row
a link belongs to**, and both directions move links between the two rows of a name:

| Event | Effect |
|---|---|
| RK checks a link | Move that link to the checked row (`quantity--` here, `++` there), creating it if absent |
| RK unchecks a link | Move it back to the unchecked row |
| User checks the whole MP row | All its links pushed `IsChecked: true`; the row merges into the checked row |
| User decrements | [Partial acquisition](#partial-acquisition-decrementing) — same movement, chosen units |

So RK checking 3 of 6 Lemons yields a checked `(3) Lemon` and an unchecked `(3) Lemon`,
which is both accurate and exactly what MP's merge logic already produces. Inbound
partial checks and local decrements converge on the same representation, so there is
one code path for both.

### Quantity

**Quantity is authoritative in MP**, not derived. It counts total units; links are a
subset of them. Rendered as MP's existing `Quantity` string when > 1 and `null`
otherwise, matching the paste format's `(N)`.

| Event | Effect |
|---|---|
| Inbound RK item, new link | `quantity++` |
| Inbound RK delete | drop link, `quantity--` |
| User increments | `quantity++` (a new MP-only unit; no RK traffic) |
| User decrements | see [Partial acquisition](#partial-acquisition-decrementing) |

Because quantity is authoritative rather than recomputed, **manual edits survive
reconcile** — reconcile only adjusts it as a side effect of links appearing or
disappearing.

### Partial acquisition (decrementing)

The real-world case: four lemons needed, the store has one. Decrementing moves units
from the unchecked row to the checked row of the same name, creating it if absent —
exactly the split MP's merge logic already assumes.

Units are consumed in priority order:

1. **MP-only units first** — a purely local change, no RK traffic
2. **then linked units**, lowest `rk_position` first — each pushed as
   `IsChecked: true`, its link moved to the checked row

So `4 → 3` yields a checked `(1) Lemon` and an unchecked `(3) Lemon`, with one RK row
checked off.

**Checked, never deleted.** Checking records what actually happened — acquired — is
reversible, and preserves the recipe attribution. Deleting would discard the
attribution irreversibly. Users who want them gone already have "clear checked", which
propagates deletes.

Incrementing always adds an MP-only unit; it never un-checks a link. To reverse a
specific recipe's item, use the [popover](#recipe-names-on-items), which is the
deliberate manual counterpart to this automatic rule.

**Tie-break:** lowest `rk_position` is chosen for determinism and predictability. It
does not attempt to finish one recipe before starting another — see
[Open questions](#open-questions).

### Section placement

Runs **once**, when an item first arrives. Nothing later moves it — that is what "MP is
authoritative" means operationally.

1. `item_defaults.section_name` for that name — MP's existing learned memory wins
2. else RK's category name (via `ShoppingListCategoryItem` → `ShoppingListCategory`),
   **only if a section with that name already exists in MP**
3. else `Uncategorized`

Store assignment follows the existing `item_defaults.store_id` path unchanged. RK has
no store concept, so stores never round-trip.

### When reconcile runs

- Doorbell `200`
- After any local grocery mutation
- A ~15-minute safety timer, catching anything missed while the backend was down

### First run

**Superseded by the collapse decision.** "Import alongside, no matching" was chosen
when collapse applied only among RK-linked items; extending collapse to MP-only units
changes what first run does, and the two cannot both hold.

Under the final model, an incoming RK item joins any existing row with the same
`(name, checked)` key, incrementing its quantity and attaching a link. So an existing
MP `Lemon` plus three RK lemons becomes one row of quantity 4 with three links — not
two rows.

This is the better outcome and is consistent rather than special-cased: no duplicates
to clean up by hand, and first run behaves exactly like every subsequent sync instead
of running once-only logic that is hard to test and impossible to re-run. The original
concern — silently adopting a user's item — does not apply, because the MP-only unit
is never pushed. Ownership is a property of links, and MP-only units have none.

The initial `Recipe` pull is a full 12-bucket sync and is **expensive** — recipe
entities embed base64 photos at roughly 100–300 KB each (see the protocol reference).
It runs once, in the background, and must not block startup or the first grocery sync.
Subsequent recipe updates arrive cheaply via the watermark.

## Token lifecycle

Holding the password means there is no re-auth UI to build — renewal is just re-running
the password grant.

- **Proactive renewal** at ~13 days, scheduled from the JWT's decoded `exp`. Never
  driven by failure: the 401 response shape was never observed.
- **Reactive fallback**: an unexpected non-2xx triggers one re-auth, then resumes.
- **Backoff on repeated auth failure**, exponential and capped, then stop. A loop
  retrying a wrong password is what trips account lockout on someone else's
  infrastructure.

Genuine error cases needing a human: the RK password changed, the account is locked,
or RK is down.

## Configuration

| Env var | Required | Notes |
|---|---|---|
| `RECIPE_KEEPER_ENABLED` | no | Default `false`. The whole subsystem is off unless set. |
| `RECIPE_KEEPER_USERNAME` | yes, if enabled | RK account email |
| `RECIPE_KEEPER_PASSWORD` | yes, if enabled | Stored like other backend secrets |
| `RECIPE_KEEPER_LIST_ID` | no | Defaults to the list with the most live items at first sync, logged on selection |
| `RECIPE_KEEPER_RECEIPT_ID` | no | `X-RK-ReceiptId`. Enforcement unknown; see [Risks](#risks) |

The device id is generated once and persisted in `recipe_keeper_state`. It must stay
stable — regenerating per request would present as an unbounded fleet of new devices.

## UI

### Recipe names on items

`groceryItemJSON` gains `recipes: [{id, title}]` — an array, because collapse means one
item can originate from six recipes.

```
☐ (6) Lemon
     Fig Cocktail, Thai Curry +4     ← tappable
```

Tapping opens a popover listing **all** of them. This is required, not decorative:
truncation without a way to see the rest defeats the feature.

**The popover is interactive.** Each recipe row carries a checkbox that checks that
specific link. It is the manual counterpart to
[decrement's automatic priority](#partial-acquisition-decrementing) — the fast path
guesses which unit you got, this is how you say which one you actually got. An item
with MP-only units shows them as a final unlabelled "No recipe (N)" row.

The recipe line **must `stopPropagation`** — the name area's `onClick` is
`startEditing` (`ChecklistParts.tsx:419`), so without it a tap opens the rename editor.

The popover **portals to `<body>`** with fixed coordinates, `z-[60]`, flipping upward
within 280px of the viewport bottom — the pattern the Travel per-section menu uses.
`.glass` makes every card its own stacking context, so a nested popover paints beneath
later sibling cards and the bottom nav, where it cannot be tapped.

Items with no links render exactly as today — no empty slot, no layout shift.

### Group by recipe

`groceryGroupBy` becomes `'category' | 'none' | 'recipe'` (`useSettings.ts:57`), with a
third option in the existing group-by menu.

A collapsed item appears under **every** recipe it belongs to — `Lemon` shows in all six
groups — because it genuinely belongs to all six. Checking it in one group checks it
everywhere, since it is one item. Items with no recipe group under "No recipe".

### Recipe filter chips

Mirrors the store filter: a chip row, multi-select, long-press to exclude, and a
"Hide recipes" toggle in the kebab matching "Hide stores". Reuses `StoreFilterBar` and
the chip vocabulary already made store-neutral by the Travel refactor. Settings keys
mirror the store ones: `grocerySelectedRecipeIds`, `groceryExcludedRecipeIds`, and
`hideRecipes` in display prefs.

One semantic difference matters: an item has **one store but many recipes**.

| Filter | Rule |
|---|---|
| Selected | Show the item if **any** of its recipes is selected |
| Excluded | Hide it only if **every** recipe is excluded **and** it has no MP-only units |

The exclusion rule is deliberately conservative. A lemon shared between an excluded
recipe and one you still intend to cook is a lemon you still have to buy — hiding it
would silently drop a needed item from the list, which is the one failure a shopping
list must not have.

"Hide recipes" drops the chips **and** the per-item recipe line, but does not change
what is filtered.

### Connection errors

Failures surface as a **pinned row at the top of `ActivityPanel`**, the same treatment
as "Update available", contributing `+1` to the bell badge while active.

Deliberately **not** an `activity_log` entry: a failure is current state, not an event.
As a feed entry it would either write a row per retry or scroll away and go stale. The
pinned row reads live from `recipe_keeper_state.last_error` and clears itself on
recovery, with nothing to clean up.

| Failure | Surfaces |
|---|---|
| Auth failure (bad password, locked account) | **Immediately** — it will never self-heal |
| Transient network / RK outage | Only after 3 consecutive failed attempts — most blips resolve on the next reconcile, and an alert that cries wolf gets ignored |

An optional push notification is gated behind a new opt-in pref
`notifyRecipeKeeperErrors` (default off, per the strictly-opt-in rule). **The bell is
never gated** — the feed is a per-user pull surface that already ignores the device
push toggle, and hiding "your integration is broken" behind a pref nobody enabled would
reproduce exactly the silent failure this section exists to prevent.

### Settings

One read-only row in a new "Recipe Keeper" section: connected / last sync / last error,
plus a "Sync now" button. **No credential fields** — they are env vars, and a password
box that cannot write env would be a lie.

### Everything else

Inbound deltas broadcast through the existing `grocery.updated` SSE using the actions
already handled (`item-added`, `item-updated`, `item-deleted`). `useGroceryList`, the
App.tsx cache warmer, and IndexedDB need no changes beyond carrying the new field.

## Failure handling

RK failures are contained: `last_error` is recorded in state, the loop backs off
exponentially, and Meal Planner is unaffected. The grocery list keeps working exactly
as it does today, without fresh RK data. This is a mode that **will** occur, so it is
a first-class path, not an afterthought.

## Testing

- **Client** — table tests against captured payloads as golden fixtures
  (`backend/internal/recipekeeper/testdata/`): the real `/token` response shape, the
  4-bucket and 12-bucket envelopes, `200` and `201` doorbells. Sanitized: bearer
  tokens, emails, and base64 photos stripped.
- **Reconciler** — pure unit tests, no HTTP. Where the real risk lives: collapse math,
  quantity decrement on partial delete, echo suppression, tombstone guard,
  all-links-checked semantics, section placement precedence.
- **Integration** — `harness_test.go` with a stubbed RK server, asserting resulting SSE
  events and DB state.
- **Required test**: a full round-trip that pushes a check, replays the doorbell, pulls
  the change back, and asserts **nothing further is pushed**. An echo loop would
  silently hammer a third party's API and looks fine in isolation.

## Risks

| Risk | Mitigation |
|---|---|
| Undocumented API changes without notice | Protocol isolated in `client.go`; `X-RK-APIVersion: 10` pinned and logged |
| Conflict resolution unobserved — concurrent edits are undefined | Write surface limited to `ShoppingListItem`; never `Recipe`. Check-state loss is cosmetic |
| Password stored in backend config | Same handling as existing secrets; never logged |
| Automated access likely outside RK's terms | Accepted deliberately: personal account, personal data, conservative request rate |
| Unknown rate limits | One parked long-poll, no polling loop, reconcile on change only |
| `X-RK-ReceiptId` enforcement unknown | Configurable; if sync fails auth with a valid token, this is the first suspect |

## Open questions

None blocking. Deferred by choice:

- **Decrement tie-break.** Currently lowest `rk_position`: deterministic and
  predictable, but arbitrary. An alternative is to prefer a recipe that is already
  partly satisfied, finishing one recipe before starting another — plausibly better,
  but it makes the rule harder to predict from the UI. Revisit after real use.
- Syncing more than one RK shopping list
- Deep-linking a recipe name into the Recipe Keeper app (no URL scheme known)
