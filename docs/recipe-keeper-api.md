# Recipe Keeper API (reverse-engineered)

Unofficial specification for the private sync API used by the **Recipe Keeper** app
(Tudorspan Ltd, `com.tudorspan.recipekeeper`). Written so this project can import a
Recipe Keeper shopping list *with the recipe each item came from* — context the app's
own text export drops.

> **Status: reverse-engineered, not documented by the vendor.** Everything here was
> derived by observing traffic from Recipe Keeper **iOS 3.46.2 (build 231)** speaking
> **`X-RK-APIVersion: 10`**. There is no public documentation and no vendor contract.
> Assume it can change without notice on any app update.

## How this was captured

iPhone proxied through mitmproxy on a Mac, with the mitmproxy CA trusted on the device
(Settings → General → About → Certificate Trust Settings).

**The app does not pin certificates** — a stock mitmproxy CA decrypts everything. This
is what made the protocol observable at all.

Traffic was captured across two sessions covering: add / edit / delete item, move item
between categories, check and uncheck, clear list, create and delete a shopping list,
rename a list, create and hide a category, reorder categories, create and delete a
recipe, edit a recipe, add and remove a meal-planner entry, and a full logout / login.

## Transport

| | |
|---|---|
| Base URL | `https://recipekeeper.azurewebsites.net` |
| Stack | Azure App Service — `Microsoft-IIS/10.0`, `X-Powered-By: ASP.NET` |
| Encoding | JSON request/response; `Accept-Encoding: gzip, deflate, br` (responses come back gzipped) |
| Endpoints | `POST /token`, `POST /api/sync`, `POST /api/syncnotification` |

> **Warning:** do not set the `Accept-Encoding` header explicitly in Go client code. Go's
> `http.Transport` only decompresses gzip automatically when it sets that header itself —
> setting it yourself hands back the raw gzipped body, which fails JSON parsing. `httptest`
> doesn't compress, so this passes every test and only breaks against the real service.

Only these three endpoints were ever observed. In particular **no REST-style resource
routes exist** — there is no `GET /api/recipes/{id}`. Everything flows through one
batched sync endpoint.

### Session affinity

The server sets an `ARRAffinity` cookie (Azure load-balancer stickiness) and the app
echoes it on subsequent calls. Not known to be required, but a client should keep a
cookie jar and return it — the sync protocol is stateful enough that pinning to one
backend instance is prudent.

## Authentication

### Obtaining a token

```http
POST /token HTTP/1.1
Host: recipekeeper.azurewebsites.net
Content-Type: application/x-www-form-urlencoded

username=<email>&password=<password>&grant_type=password
```

A standard ASP.NET OWIN resource-owner password grant.

**Response** (`200 OK`):

```json
{
  "access_token": "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9...",
  "token_type": null,
  "expires_in": 0,
  "userName": null,
  ".issued": null,
  ".expires": null
}
```

**Only `access_token` is usable.** `token_type` is `null`, `expires_in` is `0`, and the
OWIN metadata fields are `null`. A client must hard-code the `Bearer` scheme rather
than reading `token_type`, and must take the real expiry from the JWT's `exp` claim.

### Token shape

Header:

```json
{"alg": "HS512", "typ": "JWT"}
```

Payload:

```json
{
  "nameid":      "<user id>",
  "unique_name": "<email>",
  "nbf":         1788258383,
  "exp":         1789467983,
  "iat":         1788258383
}
```

**`exp - iat` = 1,209,600 seconds = exactly 14 days.**

### Consequences for a client

- **There is no refresh token.** Re-authentication means replaying username and
  password against `/token`. A long-lived integration must therefore store the user's
  actual Recipe Keeper password, not a revocable credential. This is the single
  biggest security cost of using this API.
- Cache the access token and decode `exp` to schedule renewal; do not trust
  `expires_in`.
- Renew early (e.g. at 13 days) rather than reacting to a failure — the 401 response
  shape is **unverified** (never observed; our token stayed valid throughout capture).

### Authenticated requests

```http
Authorization: Bearer <access_token>
```

## Required headers

Sent by the app on every call, including `/token`:

| Header | Example | Notes |
|---|---|---|
| `X-RK-APIVersion` | `10` | Protocol version. The server almost certainly branches on this. |
| `X-RK-AppOS` | `iOS` | |
| `X-RK-AppOSVersion` | `26.6.2` | |
| `X-RK-AppVersion` | `3.46.2` | |
| `X-RK-DeviceId` | `<UUID>` | Stable per install. Likely how the server tracks per-device sync watermarks. |
| `X-RK-ReceiptId` | `<App Store receipt id>` | Presumably validates the paid/pro licence. |
| `X-RK-Analytics` | *(empty)* | Sent empty in all captures. |
| `User-Agent` | `RecipeKeeper/231 CFNetwork/3860.700.2 Darwin/25.6.0` | |

**Unverified:** which of these the server actually enforces. A client should send a
plausible full set rather than probe for the minimum — probing risks tripping
server-side validation, and the cost of sending them all is zero. Reuse a single
stable `X-RK-DeviceId` for the lifetime of an integration; generating a fresh one per
request would look like an unbounded fleet of new devices.

## The sync protocol

`POST /api/sync` is a **bidirectional delta sync** over twelve independent entity
buckets, batched into one request.

### Envelope

Request — one key per bucket, named `<Entity>SyncEntityRequest`:

```json
{
  "ShoppingListItemSyncEntityRequest": {
    "MaxLastModified": "2026-09-13T19:24:14.2403093Z",
    "SyncEntities":    [ /* local changes to push */ ],
    "LocalChangesIds": [ /* ids of those entities */ ]
  },
  "RecipeSyncEntityRequest": null,
  "...": null
}
```

Response — mirrors it, `<Entity>SyncEntityResponse`:

```json
{
  "ShoppingListItemSyncEntityResponse": {
    "UpdatedLocalItems":         [ {"Id": "...", "LastModified": "..."} ],
    "UpdatedServerItems":        [ /* entities the client doesn't have */ ],
    "HasMoreUpdatedServerItems": false,
    "MaxLastModified":           "2026-09-13T19:24:14.2403093Z"
  },
  "RecipeSyncEntityResponse": null,
  "...": null
}
```

### Field semantics

| Field | Direction | Meaning |
|---|---|---|
| `MaxLastModified` | both | The client's watermark: "I have everything modified up to here." The server returns anything newer. The response's value becomes the client's next watermark. |
| `SyncEntities` | → | Full entity bodies the client is pushing. |
| `LocalChangesIds` | → | Ids of the entities in `SyncEntities`. Redundant with them, but always sent in agreement. |
| `UpdatedLocalItems` | ← | **Acknowledgements only** — `{Id, LastModified}` pairs. The server's authoritative timestamp for each entity you just pushed; write it back locally. |
| `UpdatedServerItems` | ← | **Full entity bodies** changed elsewhere that the client lacks — same shape as `SyncEntities`. |
| `HasMoreUpdatedServerItems` | ← | Pagination flag: call again with the advanced watermark. Page size unknown. |

Confirmed inbound entity (an item added on a second device, arriving here):

```json
{
  "Name": "sample",
  "ShoppingListId": "123fa458-8676-4a4b-9060-0a932d2dbaa4",
  "IsChecked": false,
  "Position": 565,
  "RecipeId": null,
  "CheckedDate": null,
  "IsSyncedToExternalList": null,
  "LastModified": "2026-09-13T23:55:28.3967144Z",
  "Id": "1fe8c051-1937-4c8e-b83a-52c42218f1fb",
  "IsDeleted": false
}
```

### The `LastModified` Z-suffix rule

The two directions use **different encodings of the same instant**, and a client must
convert between them:

| Direction | Format | Example |
|---|---|---|
| Server → client (`UpdatedServerItems`, `UpdatedLocalItems`) | UTC **with** `Z` | `2026-09-13T23:55:28.3967144Z` |
| Client → server (`SyncEntities`, update) | same value, **`Z` stripped** | `2026-09-13T23:55:28.3967144` |
| Client → server (`SyncEntities`, create) | `null` | |

Observed without exception: 190 pushed updates carried no `Z`, 10 creates sent `null`,
and all 200 acknowledgements came back with `Z`.

So the round-trip is: take the server's `LastModified`, strip the trailing `Z`, send
that back on your next update of that entity. **Echo the server's value — never
generate your own timestamp.** After each push, overwrite your cached value with the
one in `UpdatedLocalItems`, or your next update will carry a stale timestamp.

> This is the same naive-UTC hazard this codebase already documents for its own server
> datetimes (see `utils/serverDate.ts` and the `parseServerDate()` rule in CLAUDE.md):
> a value with no `Z` parses as *local* time in JavaScript. Parse Recipe Keeper
> timestamps deliberately, in Go or JS, rather than handing them to a default parser.

**A `null` bucket is skipped entirely** and echoes back `null`. The app uses this
aggressively — shopping-list screens send only the four `ShoppingList*` buckets and
null the rest. A client should do the same: it is the difference between a ~1 KB call
and a multi-megabyte one (see [Recipe](#recipe)).

### Watermark bootstrapping

To pull everything for a bucket, send a watermark old enough that everything is
newer, with empty `SyncEntities` / `LocalChangesIds`, then follow
`HasMoreUpdatedServerItems`. Timestamps are .NET round-trip format, UTC, with up to
7 fractional digits — note **pushed** entities carry no `Z` suffix while **server**
values do.

**Do not use .NET's `DateTime.MinValue` (`"0001-01-01T00:00:00Z"`) for this.**
Verified against the live API: it 500s, with an error body that is literally
`An unhandled exception occurred` (both with and without the `Z` suffix), almost
certainly a timezone-conversion underflow on their side. A 1970 epoch works —
we send `"1970-01-01T00:00:00.0000000Z"`.

### `SyncEntities` / `LocalChangesIds` must be `[]`, never `null`

**Every present bucket's `SyncEntities` and `LocalChangesIds` must serialize as JSON
`[]`, even when there is nothing to push.** A `null` in either field 500s with the
same generic `An unhandled exception occurred` body as the watermark bug above.
Measured against the live API, holding everything else constant:

| `SyncEntities` | `LocalChangesIds` | Result |
|---|---|---|
| `[]` | `[]` | 200 (4142 bytes of data) |
| `null` | `null` | 500 |
| `null` | `[]` | 500 |
| `[]` | `null` | 500 |

This is an easy mistake in Go specifically: `json.Marshal` renders a nil slice as
`null`, not `[]`, so any bucket built by appending to a slice that's never had
anything appended to it (the overwhelmingly common "nothing to push this cycle"
case) silently sends `null` and 500s. This client normalizes both fields on every
present bucket centrally, inside `Client.Sync` (`backend/internal/recipekeeper/client.go`),
rather than relying on every call site to remember to initialize them — do the same
in any reimplementation.

> **Unverified:** `UpdatedServerItems` was empty in every captured exchange — the
> device was always the sole writer. Its contents are *inferred* to be full entity
> bodies in the same shape as `SyncEntities`. Confirm this against a real pull before
> relying on it.

### Pages cap at ~10k, and `MaxLastModified` is a GLOBAL watermark, not a page one

Verified against the live API: pulling `ShoppingListItem` from the 1970 epoch
watermark on an account with more changes than that returned:

```
HasMoreUpdatedServerItems: true
entities in page:          10000          <- the server-side page cap
MaxLastModified returned:  2026-09-15T03:14:21.04Z
```

**That returned timestamp is "now" — the instant of the newest change anywhere in
the account — not the last entity actually included in the page.** A client that
persists `MaxLastModified` after processing page 1, rather than following
`HasMoreUpdatedServerItems` to the end, advances its watermark past every entity
sitting in pages 2..N. The next sync asks for changes after "now" and those
entities are **never fetched again** — silent, permanent data loss, not a delay.

**The fix is drain-before-persist:** loop, applying each page's
`UpdatedServerItems` as it arrives, and only write the bucket's watermark to
durable storage once `HasMoreUpdatedServerItems` comes back `false`. If the
process dies mid-drain, the persisted watermark is untouched, so the next run
re-reads the same pages — harmless, since inbound apply is idempotent on an
unchanged `LastModified`. Losing pages by persisting early is not recoverable
the same way. Send `SyncEntities`/`LocalChangesIds` only on the drain's first
request; a bucket's own local-changes push must not be repeated on later pages.
This applies to every bucket independently — the category buckets ride along in
the same request and are just as capable of paginating, even though they are
normally small.

**Corollary — `MaxLastModified` must never be used as the PAGE CURSOR either,
only as the final persisted watermark.** Draining correctly means each request
after the first must carry a watermark that actually advances past the page
just received: the value to send is the **last entity's own `LastModified`
field** (the last element of that page's `UpdatedServerItems`), never the
response's `MaxLastModified`. Sending the global value as the next request's
watermark reproduces the exact same bug the drain loop above exists to
prevent, just one request later: since `MaxLastModified` is already "now", the
very next request asks for changes after now, gets back an empty page with
`HasMoreUpdatedServerItems: false`, and the loop concludes it has drained
everything after only page 1. Verified against the live API on an account with
22,800 pending entities: cursoring by the last entity's `LastModified` yields
the correct 3 pages (10000 / 10000 / 2800); cursoring by `MaxLastModified`
yields 1. Only once `HasMoreUpdatedServerItems` is `false` does
`MaxLastModified` become safe to use — at that point it and the last entity's
`LastModified` are (by construction) the same watermark going forward.

## Entity catalog

Twelve buckets: `Recipe`, `ShoppingList`, `ShoppingListItem`, `ShoppingListCategory`,
`ShoppingListCategoryItem`, `Meal`, `MealType`, `MealPlanner`, `Course`, `Category`,
`Collection`, `Cookbook`.

Every entity carries three common fields:

| Field | Type | Notes |
|---|---|---|
| `Id` | GUID string | Client-generated on create. Lowercase for app-created rows; **uppercase** for built-in seeded rows (e.g. stock categories) — compare case-insensitively. |
| `IsDeleted` | bool | **Soft delete.** Deletion is a push with `IsDeleted: true`, never a DELETE verb. |
| `LastModified` | timestamp or null | `null` on first push of a new entity; server assigns and returns it. |

### ShoppingListItem

The entity this integration exists for.

```json
{
  "Name":                   "Maple Syrup",
  "ShoppingListId":         "123fa458-8676-4a4b-9060-0a932d2dbaa4",
  "IsChecked":              false,
  "Position":               651,
  "RecipeId":               "59b86e5d-4126-48bb-9d15-b3cd82d8df08",
  "CheckedDate":            null,
  "IsSyncedToExternalList": true,
  "LastModified":           null,
  "Id":                     "13cdaec2-3cc8-4cd1-b7da-359c6e952d63",
  "IsDeleted":              false
}
```

| Field | Type | Notes |
|---|---|---|
| `Name` | string | Ingredient name only — **no quantity**. Quantities live in the recipe's `Ingredients`/`Directions` text, not here. |
| `ShoppingListId` | GUID | FK → [`ShoppingList`](#shoppinglist). |
| `RecipeId` | GUID or null | **FK → [`Recipe`](#recipe). The attribution field.** Non-null when the item was added from a recipe; `null` when typed in by hand. |
| `IsChecked` | bool | |
| `CheckedDate` | timestamp or null | Set when checked, back to `null` when unchecked — the two move together. |
| `Position` | int | Sort order within the list. Monotonically increasing on append (…, 655, 656, 657); not densely packed. |
| `IsSyncedToExternalList` | bool | Relates to the external-list integration (see `ShoppingList.ExternalListType`). |

**There is no category field.** An item's aisle is resolved *by name* through
[`ShoppingListCategoryItem`](#shoppinglistcategoryitem) — see
[Resolving an item's category](#resolving-an-items-category).

**Observed attribution rate: 173 of 183 items (95%) carried a non-null `RecipeId`,**
spanning ~20 distinct recipes. Only 10 were manual entries.

### Recipe

40 fields. Abridged (nutrition fields omitted):

```json
{
  "Id":              "59b86e5d-4126-48bb-9d15-b3cd82d8df08",
  "Title":           "Fig Cocktail",
  "Ingredients":     "Fig\nFig Jam\nLemon\nApple Cider\nGinger\nCinnamon\nMaple Syrup",
  "Directions":      "1 fresh fig, quartered\n1/2 tablespoon fig jam...",
  "Notes":           "",
  "Source":          "Instagram - themindfulmocktail",
  "Course":          "",
  "Courses":         ["Beverage"],
  "Categories":      ["Mocktail"],
  "Collections":     ["Headache Friendly"],
  "ServingSize":     "",
  "PreparationTime": 0,
  "CookingTime":     0,
  "Rating":          0,
  "IsFavourite":     false,
  "ShareId":         null,
  "LinkedRecipeIds": [],
  "AddedDate":       "...",
  "Photo":           "<base64 JPEG>",
  "Photo1":          "<base64 JPEG>",
  "Photo2":          "<base64 JPEG>",
  "Photo3".."Photo9": null,
  "NutServingSize":  "",
  "NutCalories":     null,
  "NutTotalFat":     null, "NutSaturatedFat": null, "NutCholesterol": null,
  "NutSodium":       null, "NutTotalCarbohydrate": null, "NutDietaryFiber": null,
  "NutSugars":       null, "NutProtein": null
}
```

Notable:

- `Ingredients` is a **newline-separated plain-text list of names** that matches
  `ShoppingListItem.Name` values closely — useful as a fallback when an item was
  renamed after being added.
- `Courses` / `Categories` / `Collections` are **string arrays**, denormalised — they
  do not reference the `Course` / `Category` / `Collection` bucket ids.
- `Course` (singular, string) coexists with `Courses` (array). Legacy field; observed
  empty while `Courses` was populated.

> ### ⚠ Photos are inline base64 and dominate the payload
>
> `Photo` through `Photo9` embed full JPEGs directly in the JSON. **One recipe with
> three photos was a 291 KB sync entity.** There is no field projection in the
> protocol — you get the whole entity or nothing.
>
> A full `Recipe` pull therefore costs roughly *(recipe count × 100–300 KB)*. Do it
> once, cache `Id → Title`, and keep it fresh via the `MaxLastModified` watermark so
> only changed recipes re-download.

### ShoppingList

Multiple named lists are supported (two were present in the captured account).

```json
{
  "Name":                   "Thrive",
  "Position":               5,
  "ExternalListType":       null,
  "IsSyncedToExternalList": null,
  "Id":                     "e07fe37e-3c65-4438-b815-3dc42794dddf",
  "IsDeleted":              false
}
```

`ExternalListType` was `null` throughout — presumably an integration with a
third-party shopping app. Unmapped.

### ShoppingListCategory

The aisle/section vocabulary (global, not per-list).

```json
{"Name": "Produce", "Position": 22, "IsHidden": false,
 "Id": "877F1BD0-02F3-43F7-B923-1CAC3C873C6A", "IsDeleted": false}
```

- `IsHidden` — hiding a category is distinct from deleting it (`IsDeleted` stayed
  `false` when a category was hidden).
- Built-in categories have **uppercase** GUIDs; user-created ones are lowercase.
- **Reordering pushes only the affected rows.** Swapping Produce and Cooking & Baking
  pushed exactly those two entities with exchanged `Position` values — not the whole
  set.

### ShoppingListCategoryItem

Maps an ingredient **name** to a category — this is how the app remembers that
"Maple Syrup" belongs in "Cooking & Baking", and it is the source of the `[Section]`
headers in the text export.

```json
{"Name": "Maple Syrup", "ShoppingListCategoryId": "3737377E-A0BE-40C9-8F61-9BF3224941E5",
 "IsUserItem": true, "UsedCount": 1, "IsHidden": false,
 "Id": "b40bb2de-d17a-465d-a31a-a2169d85f23f", "IsDeleted": false}
```

| Field | Notes |
|---|---|
| `Name` | Matches `ShoppingListItem.Name`. **The join key is the name string, not an id.** |
| `ShoppingListCategoryId` | FK → [`ShoppingListCategory`](#shoppinglistcategory). |
| `IsUserItem` | `true` for names the user introduced, vs. the app's shipped dictionary. |
| `UsedCount` | Incremented as the name is reused; the app's learning signal. |

Moving an item to a different category **rewrites this row** (same `Id`, new
`ShoppingListCategoryId`) rather than touching the `ShoppingListItem`.

### Meal

Meal-planner entries.

```json
{
  "MealDate":     "2026-09-07T00:00:00",
  "MealType":     2,
  "MealTypeName": "Dinner",
  "MealTime":     1080,
  "Title":        "Acorn Squash",
  "Position":     0,
  "Colour":       0,
  "Scale":        "1",
  "Notes":        "",
  "Id":           "ac7c9b02-3ccc-4d0c-a206-ea850f52373c",
  "IsDeleted":    false
}
```

- `MealTime` is **minutes past midnight** (1080 = 18:00).
- `MealType` is an int paired with the denormalised `MealTypeName` (2 = Dinner).
- **`Meal` carries a `Title` string, not a `RecipeId`** — the meal-planner link to a
  recipe is by name in the captured data. Do not assume a FK.

### Unmapped buckets

`MealType`, `MealPlanner`, `Course`, `Category`, `Collection`, `Cookbook` were present
in every envelope but never carried entities during capture. Their field shapes are
unknown. They are irrelevant to shopping-list import — null them.

## Operation semantics

### Deletion is always a soft-delete push

There is no DELETE verb. Deleting anything means pushing the full entity with
`IsDeleted: true`.

**Clearing a shopping list pushed 176 individual `ShoppingListItem` entities with
`IsDeleted: true` in a single request.** There is no bulk-clear operation. Size
request buffers accordingly, and expect the same volume inbound when another device
clears a list.

### Check / uncheck

`IsChecked: true` + `CheckedDate: <timestamp>` → `IsChecked: false` + `CheckedDate: null`.
`Position` is not touched by checking.

### Resolving an item's category

1. Take `ShoppingListItem.Name`
2. Find the `ShoppingListCategoryItem` with a matching `Name` (case-insensitively)
3. Follow `ShoppingListCategoryId` → `ShoppingListCategory.Name`

Unmatched names are uncategorised. Because the join is by string, an item renamed
after creation can orphan itself from its category.

### Resolving an item's recipe

1. Take `ShoppingListItem.RecipeId` (skip if `null` — manual entry)
2. Look up `Recipe.Id` → `Recipe.Title`

Verified end to end: seven items (Fig, Fig Jam, Lemon, Apple Cider, Ginger, Cinnamon,
Maple Syrup) → `59b86e5d-4126-48bb-9d15-b3cd82d8df08` → `"Fig Cocktail"`.

## POST /api/syncnotification — real-time change notification

This is how a change made on one device appears on another within seconds. It is a
**long-poll doorbell**: it tells you *that* something changed, never *what*.

```http
POST /api/syncnotification
Authorization: Bearer <token>
Content-Type: application/json; charset=utf-8

""
```

The request body is the JSON string `""` (2 bytes). The server holds the connection
open and answers with an **empty body** in both cases — the meaning is entirely in the
status code:

| Status | Meaning | Observed hold time |
|---|---|---|
| `200` | **Something changed.** Run a sync now, then re-open the poll. | 8.3s (fired when the other device wrote) |
| `201` | **Nothing changed; poll expired.** Re-open it immediately. | 60.1s |

So the server-side timeout is **~60 seconds**, and `201` is the idle path, not an
error. There is no payload to parse and no event type — the only correct reaction to
`200` is an ordinary `/api/sync` call.

### Verified end-to-end sequence

An item added on a second device, observed arriving on the captured device:

```
t+726.1s   POST /api/sync              → nothing new; long-poll opened
t+726.1s   POST /api/syncnotification  ┄┄ held open ┄┄
t+734.4s   ← 200 (empty)                  doorbell: the other device wrote
t+734.5s   POST /api/syncnotification     poll re-opened
t+734.9s   POST /api/sync              → UpdatedServerItems: 1 ShoppingListItem
                                          {"Name":"sample", ...}
```

**End-to-end latency was ~8 seconds**, essentially all of it the other device's own
sync delay rather than notification overhead.

### Implementing it

A client mirrors the app: keep one long-poll in flight at all times; on `200` issue a
sync then re-poll; on `201` re-poll immediately. Because the connection is held for up
to 60s, use a read timeout comfortably above that (90s+) or you will abort your own
polls — which is exactly what the aborted requests in our capture were.

This makes a *push*-driven importer possible: no periodic polling of `/api/sync`, just
one cheap parked connection that wakes you when something actually changes.

### Status in this project: implemented, then removed

This project built exactly the client described above — one long-poll parked at all
times, `200` → sync, `201` → re-poll — and then deleted it. The endpoint itself behaves
exactly as documented above (`200`/`201`, empty bodies, ~60s hold): that part is a real,
verified finding about the vendor API and is safe to build from. What doesn't hold is
the assumption that *this* client would ever see a `200`.

Measured live against the real Recipe Keeper server: three changes were made in the
Recipe Keeper phone app, confirmed present on the RK server (a subsequent `/api/sync`
call returned them), and three consecutive 60-second doorbell polls in a row all
returned `201` — "nothing changed" — while those changes were sitting there. The
doorbell never fired. The strong suspicion is that it is scoped to devices registered
through the vendor's own app (this project authenticates as a bare API client, never
performs whatever device-registration handshake the app does) — nothing in the protocol
confirms or rules this out, since there's no visibility into what makes a device
eligible. Given that, sync in this project is entirely poll-driven (see "Staying
current" below) rather than depending on a signal that, for this client, never arrives.

A future attempt at reviving this would need to:

1. Park one long-poll on `/api/syncnotification` at all times (request body `""`,
   `Content-Type: application/json; charset=utf-8`).
2. On `200`, run a sync (the four `ShoppingList*` buckets), then immediately re-open
   the poll.
3. On `201`, immediately re-open the poll — this is the expected idle path, not an
   error.
4. Set the read timeout on that connection comfortably above the ~60s hold (this
   project used ~100s) or the client aborts its own poll.
5. Before relying on it, re-verify against a live account that `200` is actually
   reachable — e.g. by making a change through some *other* channel and confirming it
   arrives, or by digging into what device-registration step the vendor app performs
   that a bare API client does not.

## Observed client sync behaviour

Worth mirroring, since it reflects how the vendor expects the API to be driven.

**The app scopes each sync to the screen you're on**, by nulling irrelevant buckets:

| Non-null buckets | Count observed | When |
|---|---|---|
| 4 — `ShoppingList`, `ShoppingListItem`, `ShoppingListCategory`, `ShoppingListCategoryItem` | 27 | Shopping-list screen, and every list mutation |
| 12 — all of them | 2 | Full sync, on app open / foreground |
| 1 — `Recipe` or `Meal` alone | 4 | Editing a single recipe or meal-planner entry |

**Yes — the app syncs on open.** The all-bucket calls appear at app foreground, and a
4-bucket shopping-list sync fires on entering the list screen. Between those, it does
not poll `/api/sync` on a timer at all — freshness comes from the
[long-poll doorbell](#post-apisyncnotification--real-time-change-notification).

**Mutations sync immediately**, one call per user action (~0.3–0.4s round trip), rather
than being batched. Pushes of 1–2 entities dominate; the 168-entity outlier was a
list clear.

For an importer whose doorbell actually fires, the equivalent recipe is: full sync once
at startup, 4-bucket sync whenever the doorbell rings, and no timer in between. See
["Status in this project: implemented, then removed"](#status-in-this-project-implemented-then-removed)
for why this project's importer cannot assume that and polls instead.

## Writing back to Recipe Keeper

Everything above is equally usable in reverse — pushing is just populating
`SyncEntities` and `LocalChangesIds`. The payload for checking an item off is
well-observed:

```json
{
  "ShoppingListItemSyncEntityRequest": {
    "MaxLastModified": "<your current watermark>",
    "SyncEntities": [{
      "Name":                   "Fig",
      "ShoppingListId":         "123fa458-8676-4a4b-9060-0a932d2dbaa4",
      "IsChecked":              true,
      "Position":               657,
      "RecipeId":               "59b86e5d-4126-48bb-9d15-b3cd82d8df08",
      "CheckedDate":            "2026-09-13T23:43:17.537601",
      "IsSyncedToExternalList": true,
      "LastModified":           "2026-09-13T23:24:53.7115541",
      "Id":                     "284055d7-f534-4aff-affd-0a0cc13a6fcf",
      "IsDeleted":              false
    }],
    "LocalChangesIds": ["284055d7-f534-4aff-affd-0a0cc13a6fcf"]
  }
}
```

Unchecking is the same entity with `IsChecked: false` and `CheckedDate: null`.

### Rules that make writing safe

1. **Send the complete entity, never a patch.** The protocol has no partial-update
   semantics — every field you send is authoritative. Omitting or stale-ing `Name`,
   `Position`, or `RecipeId` overwrites the server's values with yours. Always build
   the push from a freshly-synced copy of the entity, mutating only the check fields.
2. **Echo `LastModified` correctly** — the server's value with the `Z` stripped (see
   [the Z-suffix rule](#the-lastmodified-z-suffix-rule)) — and write the
   acknowledgement's new value back to your cache immediately.
3. **Never send `IsDeleted: true`.** Nothing about mirroring check state requires
   deletion, and a soft-delete push is the one mistake that destroys data.
4. **Restrict the writable surface to `ShoppingListItem`.** Null every other bucket on
   any call that pushes. A write bug then cannot reach your recipes, which are the
   irreplaceable data here.
5. **Echo, don't originate, `Id`.** Only ever push ids that came from Recipe Keeper.

### Unresolved risk

**Conflict resolution is unobserved.** Both devices in our capture were writing
sequentially, never concurrently, so what the server does when your push carries a
`LastModified` older than its current row is unknown — silently last-write-wins is
likely, rejection is possible. If you and the app check the same item at nearly the
same moment, the outcome is undefined. For check state that is a cosmetic loss; it is
the reason rules 3 and 4 matter, because the same uncertainty applied to a delete or
a recipe edit would not be cosmetic.

## Known unknowns

Do not treat these as specified:

- **Pagination page size** behind `HasMoreUpdatedServerItems`.
- **Error responses** — no 4xx/5xx ever observed. 401 shape on token expiry unknown.
- **Conflict resolution** when two devices edit one entity concurrently — see
  [Unresolved risk](#unresolved-risk).
- **Which `X-RK-*` headers are enforced**, and whether `X-RK-ReceiptId` gates features.
- **`ExternalListType`** semantics.
- Field shapes for the six unmapped buckets.
- Whether the long-poll's 60s timeout is fixed or negotiated.

## Implementation guidance for this project

Goal: shopping-list items annotated with their source recipe.

**Keep the write surface as narrow as the feature requires.** A read-only client is
safest, and if you only need imported lists that is what to build. Mirroring check
state back requires writes — in which case restrict them to `ShoppingListItem` and
follow [the rules above](#rules-that-make-writing-safe). The asymmetry to respect:
recipes are irreplaceable and check state is not, so no code path that writes should
be able to reach the `Recipe` bucket.

Sketch:

1. `POST /token` with stored credentials → cache token, decode `exp`, renew ~day 13.
2. Full 12-bucket sync once at startup to establish watermarks.
3. `POST /api/sync` with **only** the four `ShoppingList*` buckets non-null and empty
   push arrays → items (with `RecipeId`), lists, categories, category-items. Cheap
   (~0.4s, ~1 KB).
4. Separately and infrequently, pull the `Recipe` bucket to build an `Id → Title`
   cache. Expensive on first run (see [Photos](#recipe)); cheap thereafter via the
   watermark.
5. Join: item → `RecipeId` → title; item → name → category → section.
6. Persist watermarks per bucket so subsequent syncs are deltas.

### Staying current

The doorbell would have been the natural fit here — it maps cleanly onto this
project's existing SSE model, since a `200` could become a `grocery.updated` broadcast
once the delta is applied — but it was built and then removed: verified live, it never
returns `200` for this client even when the server-side data genuinely changed (see
["Status in this project: implemented, then removed"](#status-in-this-project-implemented-then-removed)).

Sync is therefore entirely poll-driven, and adaptive rather than fixed-interval:
`RECIPE_KEEPER_POLL_SECONDS` (default 60s, floor 30s) while at least one browser tab has
an SSE connection open, `RECIPE_KEEPER_IDLE_POLL_SECONDS` (default 30 minutes) once the
last one disconnects, and *any* tab connecting fires an immediate sync rather than
waiting for the next tick — every subscribe, not just the first, so a second device
opening the app refreshes too, floored at 15s so a reconnect storm costs one sync
(`internal/recipekeeper.Service.Run`). No parked connection, no timer-free freshness —
just a cadence that backs off when nobody's watching and snaps to attention when
someone looks.

### Mapping to local items

`ShoppingListItem.Id` is a **stable, client-generated GUID** that survives rename,
check, uncheck, move between categories, and soft delete — the same `Id` was observed
across all of those. It is therefore a reliable foreign key: store it on the imported
local item and you can reconcile state in both directions without name matching.

`IsChecked` and `CheckedDate` arrive on every inbound item, so mirroring Recipe
Keeper's check state into this app needs no extra calls — it is already in the payload
you are pulling for the import.

### Risks to accept deliberately

- **Credential storage.** No refresh token means the user's Recipe Keeper password
  lives in your server's config. That is a real, permanent cost, not a detail.
- **Terms of service.** Automated access is near-certainly outside Recipe Keeper's
  terms, even for your own data in your own account.
- **Fragility.** `X-RK-APIVersion: 10` shows the vendor versions this deliberately.
  Any app update can change entity shapes or bump the version.
- **Rate limiting** is unknown. Sync conservatively — minutes, not seconds.

### The lighter alternative

The entire expensive, credential-holding half of this (step 3) exists only to turn a
GUID into a recipe name. Importing recipe titles and their ingredient lists **once**
from the app's own export, then attributing pasted items by matching names against
those ingredient lists, needs no credentials, no token refresh, and cannot break when
the vendor ships an update. It trades exactness for durability — worth weighing before
committing to the API.
