// backend/internal/recipekeeper/recipes.go
package recipekeeper

import (
	"encoding/json"

	"github.com/google/uuid"

	"mealplanner/internal/models"
)

type RecipeRef struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// StoreRecipes caches id -> title from Recipe entities, discarding everything
// else. Recipe payloads embed base64 photos (~100-300 KB each), so nothing but
// the title is retained.
func (r *Reconciler) StoreRecipes(raw []json.RawMessage) error {
	for _, blob := range raw {
		var rec struct {
			ID           string `json:"Id"`
			Title        string `json:"Title"`
			IsDeleted    bool   `json:"IsDeleted"`
			LastModified string `json:"LastModified"`
		}
		if err := json.Unmarshal(blob, &rec); err != nil || rec.ID == "" {
			continue
		}
		if rec.IsDeleted {
			r.DB.Delete(&models.RecipeKeeperRecipe{}, "rk_recipe_id = ?", rec.ID)
			continue
		}
		row := models.RecipeKeeperRecipe{
			RKRecipeID: rec.ID, Title: rec.Title, RKLastModified: rec.LastModified,
		}
		if err := r.DB.Save(&row).Error; err != nil {
			return err
		}
	}
	return nil
}

// RecipeTitles returns the distinct recipes a grocery item came from. A
// collapsed item legitimately has several; an unknown id is skipped rather than
// rendered as a bare GUID.
func (r *Reconciler) RecipeTitles(name string, checked bool) ([]RecipeRef, error) {
	var links []models.RecipeKeeperLink
	if err := r.DB.Order("rk_position asc").Find(&links,
		"mp_name = ? AND mp_checked = ? AND rk_recipe_id IS NOT NULL",
		normalizeName(name), checked).Error; err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := []RecipeRef{}
	for _, link := range links {
		id := *link.RKRecipeID
		if seen[id] {
			continue
		}
		seen[id] = true
		var rec models.RecipeKeeperRecipe
		if err := r.DB.First(&rec, "rk_recipe_id = ?", id).Error; err != nil {
			continue
		}
		out = append(out, RecipeRef{ID: rec.RKRecipeID, Title: rec.Title})
	}
	return out, nil
}

// rkCategoryForItem maps an item name to RK's category name via the
// ShoppingListCategoryItem bucket, which joins by NAME, not by id.
func (r *Reconciler) rkCategoryForItem(name string) (string, bool) {
	var state models.RecipeKeeperState
	if err := r.DB.First(&state, "key = ?", "category:"+normalizeName(name)).Error; err != nil {
		return "", false
	}
	return state.Value, true
}

// StoreCategories caches the name -> category-name mapping used for the initial
// placement of newly imported items.
func (r *Reconciler) StoreCategories(cats, catItems []json.RawMessage) error {
	byID := map[string]string{}
	for _, blob := range cats {
		var c struct {
			ID        string `json:"Id"`
			Name      string `json:"Name"`
			IsDeleted bool   `json:"IsDeleted"`
		}
		if err := json.Unmarshal(blob, &c); err != nil || c.IsDeleted {
			continue
		}
		byID[c.ID] = c.Name
	}
	for _, blob := range catItems {
		var ci struct {
			Name       string `json:"Name"`
			CategoryID string `json:"ShoppingListCategoryId"`
			IsDeleted  bool   `json:"IsDeleted"`
		}
		if err := json.Unmarshal(blob, &ci); err != nil || ci.IsDeleted || ci.Name == "" {
			continue
		}
		catName, ok := byID[ci.CategoryID]
		if !ok {
			continue
		}
		row := models.RecipeKeeperState{Key: "category:" + normalizeName(ci.Name), Value: catName}
		if err := r.DB.Save(&row).Error; err != nil {
			return err
		}
	}
	return nil
}

// sectionFromRKCategory resolves RK's category to an EXISTING MP section.
// It never creates one: Meal Planner's sections are authoritative, so RK may
// only suggest a home that already exists.
func (r *Reconciler) sectionFromRKCategory(name string) (uuid.UUID, bool) {
	catName, ok := r.rkCategoryForItem(name)
	if !ok {
		return uuid.Nil, false
	}
	var sec models.GrocerySection
	if err := r.DB.First(&sec, "LOWER(name) = LOWER(?)", catName).Error; err != nil {
		return uuid.Nil, false
	}
	return sec.ID, true
}
