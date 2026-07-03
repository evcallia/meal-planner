package app

// Port of test_api.py TestMealIdeasAPI + TestMealIdeasSSEPayloads.

import (
	"testing"

	"github.com/google/uuid"

	"mealplanner/internal/models"
)

func TestListMealIdeasEmpty(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.GET("/api/meal-ideas")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200", resp.Status)
	}
	if len(resp.List()) != 0 {
		t.Fatalf("expected empty list, got %v", resp.JSON())
	}
}

func TestCreateUpdateDeleteMealIdea(t *testing.T) {
	ta := newTestApp(t)
	col := ta.Collect(TestSub)

	created := ta.POST("/api/meal-ideas", map[string]any{"title": "Salmon Bites"})
	if created.Status != 200 {
		t.Fatalf("create status = %d: %s", created.Status, created.Body)
	}
	if created.Obj()["title"] != "Salmon Bites" {
		t.Fatalf("title = %v", created.Obj()["title"])
	}

	ideaID := created.Obj()["id"].(string)
	updated := ta.PUT("/api/meal-ideas/"+ideaID, map[string]any{"title": "Updated"})
	if updated.Status != 200 {
		t.Fatalf("update status = %d: %s", updated.Status, updated.Body)
	}
	if updated.Obj()["title"] != "Updated" {
		t.Fatalf("title = %v", updated.Obj()["title"])
	}

	deleted := ta.DELETE("/api/meal-ideas/" + ideaID)
	if deleted.Status != 200 {
		t.Fatalf("delete status = %d: %s", deleted.Status, deleted.Body)
	}
	if events := col.Events(); len(events) < 3 {
		t.Fatalf("expected >= 3 broadcasts, got %d", len(events))
	}

	var count int64
	ta.App.DB.Model(&models.MealIdea{}).Where("id = ?", uuid.MustParse(ideaID)).Count(&count)
	if count != 0 {
		t.Fatal("idea still present after delete")
	}
}

func TestCreateMealIdeaEmptyTitle(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.POST("/api/meal-ideas", map[string]any{"title": "  "})
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "Title is required" {
		t.Fatalf("detail = %q", detail)
	}
}

func TestUpdateMealIdeaNotFound(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/meal-ideas/00000000-0000-0000-0000-000000000001",
		map[string]any{"title": "New Title"})
	if resp.Status != 404 {
		t.Fatalf("status = %d, want 404: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "Idea not found" {
		t.Fatalf("detail = %q", detail)
	}
}

func TestUpdateMealIdeaEmptyTitle(t *testing.T) {
	ta := newTestApp(t)
	created := ta.POST("/api/meal-ideas", map[string]any{"title": "Test Idea"})
	ideaID := created.Obj()["id"].(string)

	resp := ta.PUT("/api/meal-ideas/"+ideaID, map[string]any{"title": "  "})
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400: %s", resp.Status, resp.Body)
	}
}

func TestDeleteMealIdeaNotFoundIdempotent(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.DELETE("/api/meal-ideas/00000000-0000-0000-0000-000000000001")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["status"] != "ok" {
		t.Fatalf("status field = %v", resp.Obj()["status"])
	}
}

// ---- SSE payloads ----

func TestMealIdeaCreateBroadcastsAdded(t *testing.T) {
	ta := newTestApp(t)
	col := ta.Collect(TestSub)
	resp := ta.POST("/api/meal-ideas", map[string]any{"title": "Tacos"})
	if resp.Status != 200 {
		t.Fatalf("status = %d", resp.Status)
	}
	payload := col.LastPayload("meal-ideas.updated")
	if payload == nil || payload["action"] != "added" {
		t.Fatalf("payload = %v", payload)
	}
	if payload["idea"].(map[string]any)["title"] != "Tacos" {
		t.Fatalf("idea = %v", payload["idea"])
	}
}

func TestMealIdeaUpdateBroadcastsUpdated(t *testing.T) {
	ta := newTestApp(t)
	idea := models.MealIdea{Title: "Old"}
	ta.App.DB.Create(&idea)
	col := ta.Collect(TestSub)
	resp := ta.PUT("/api/meal-ideas/"+idea.ID.String(), map[string]any{"title": "New"})
	if resp.Status != 200 {
		t.Fatalf("status = %d", resp.Status)
	}
	payload := col.LastPayload("meal-ideas.updated")
	if payload == nil || payload["action"] != "updated" {
		t.Fatalf("payload = %v", payload)
	}
	if payload["idea"].(map[string]any)["title"] != "New" {
		t.Fatalf("idea = %v", payload["idea"])
	}
}

func TestMealIdeaDeleteBroadcastsDeleted(t *testing.T) {
	ta := newTestApp(t)
	idea := models.MealIdea{Title: "Remove Me"}
	ta.App.DB.Create(&idea)
	col := ta.Collect(TestSub)
	resp := ta.DELETE("/api/meal-ideas/" + idea.ID.String())
	if resp.Status != 200 {
		t.Fatalf("status = %d", resp.Status)
	}
	payload := col.LastPayload("meal-ideas.updated")
	if payload == nil || payload["action"] != "deleted" {
		t.Fatalf("payload = %v", payload)
	}
	if payload["ideaId"] != idea.ID.String() {
		t.Fatalf("ideaId = %v", payload["ideaId"])
	}
}
