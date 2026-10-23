// backend/internal/recipekeeper/lists.go
package recipekeeper

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"

	"gorm.io/gorm"

	"mealplanner/internal/models"
)

// ShoppingListRef is one Recipe Keeper shopping list, as surfaced by the
// discovery endpoint. A list's id is a GUID that exists only inside the
// vendor's API — a user has no way to know it ahead of time — so this is how
// both a human and this app learn which lists exist and which one to mirror.
type ShoppingListRef struct {
	ID   string
	Name string
}

// rawShoppingList mirrors just the fields FetchLists needs from the
// ShoppingList bucket's vendor JSON (PascalCase on the wire, like every other
// entity this integration touches).
type rawShoppingList struct {
	ID        string `json:"Id"`
	Name      string `json:"Name"`
	IsDeleted bool   `json:"IsDeleted"`
}

// FetchLists pulls every non-deleted Recipe Keeper shopping list. It needs
// credentials only, NOT a selected list id — deliberately, since this is
// exactly the state a user is in while discovering which list to select, and
// the ONE thing this whole feature exists to solve is that the list id
// cannot be known ahead of time. The pull uses an epoch watermark (never
// "already seen" anything) and empty pushes; every bucket besides
// ShoppingList is left nil. Results are sorted by name for a stable UI.
func (s *Service) FetchLists(ctx context.Context) ([]ShoppingListRef, error) {
	resp, err := s.Client.Sync(ctx, SyncRequest{
		ShoppingList: &RawBucket{
			MaxLastModified: epochWatermark,
			SyncEntities:    []json.RawMessage{},
			LocalChangesIds: []string{},
		},
	})
	if err != nil {
		return nil, err
	}
	var out []ShoppingListRef
	if resp.ShoppingList != nil {
		for _, raw := range resp.ShoppingList.UpdatedServerItems {
			var rl rawShoppingList
			if err := json.Unmarshal(raw, &rl); err != nil {
				return nil, fmt.Errorf("recipekeeper: decode shopping list: %w", err)
			}
			if rl.IsDeleted || rl.ID == "" {
				continue
			}
			out = append(out, ShoppingListRef{ID: rl.ID, Name: rl.Name})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// UnknownListError is returned by SelectList when the requested id does not
// match any live list — most often a typo, which would otherwise silently
// sync nothing forever. Available carries the valid options so the caller
// (the HTTP handler) can name them in the error message.
type UnknownListError struct {
	ID        string
	Available []ShoppingListRef
}

func (e *UnknownListError) Error() string {
	return fmt.Sprintf("recipekeeper: unknown shopping list id %q", e.ID)
}

// SelectList validates id against the live list (so a typo is caught rather
// than silently importing nothing) and, if valid, persists the selection and
// updates the running Reconciler immediately — so the choice takes effect
// before the next poll cycle, without a restart. See state.go's SelectList
// for the reset-on-change behavior.
func (s *Service) SelectList(ctx context.Context, id string) ([]ShoppingListRef, error) {
	lists, err := s.FetchLists(ctx)
	if err != nil {
		return nil, err
	}
	var name string
	found := false
	for _, l := range lists {
		if l.ID == id {
			name, found = l.Name, true
			break
		}
	}
	if !found {
		return lists, &UnknownListError{ID: id, Available: lists}
	}
	if err := selectList(s.DB, id, name); err != nil {
		return lists, err
	}
	s.Rec.SetListID(id)
	return lists, nil
}

// selectList persists the household's chosen shopping list. On a genuine
// CHANGE from a previously-selected id (never on the first-ever selection),
// every existing RecipeKeeperLink/RecipeKeeperTombstone addresses a row in
// the OLD list, and the item watermark reflects the OLD list's sync history
// — carrying either forward would corrupt the new list's import (stale links
// would be swept as orphans by PendingPushes, and a non-epoch watermark would
// make the new list's initial pull skip everything the vendor considers
// "already seen"). The reset is deliberate and loud, not emergent: grocery
// rows themselves are NEVER deleted, only unlinked — they collapse back onto
// the new list's items by name as those get pulled in.
func selectList(db *gorm.DB, id, name string) error {
	prev := SelectedListID(db)
	if prev != "" && prev != id {
		log.Printf("recipekeeper: shopping list selection changed (%s -> %s): resetting all links, tombstones, and the item watermark so the new list imports cleanly (grocery items themselves are kept, just unlinked)", prev, id)
		if err := db.Where("1 = 1").Delete(&models.RecipeKeeperLink{}).Error; err != nil {
			return err
		}
		if err := db.Where("1 = 1").Delete(&models.RecipeKeeperTombstone{}).Error; err != nil {
			return err
		}
		setState(db, stateWatermarkItem, epochWatermark)
	}
	setState(db, stateSelectedList, id)
	setState(db, stateSelectedListName, name)
	return nil
}
