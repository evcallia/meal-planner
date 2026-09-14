package recipekeeper

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"time"
)

// notifyTimeout must exceed the server's ~60s long-poll hold, or we abort our
// own polls.
const notifyTimeout = 90 * time.Second

// Generous: a full Recipe pull legitimately runs to hundreds of MB because
// recipe entities embed base64 photos. The cap exists to stop an unbounded
// or malformed response exhausting memory, not to bound normal traffic.
const maxSyncBody = 512 << 20 // 512 MiB

// ShoppingListItem is the only entity this integration reads in detail or ever
// writes. Note there is no quantity field: Recipe Keeper stores one row per
// recipe-ingredient occurrence instead.
type ShoppingListItem struct {
	Name                   string  `json:"Name"`
	ShoppingListID         string  `json:"ShoppingListId"`
	IsChecked              bool    `json:"IsChecked"`
	Position               int     `json:"Position"`
	RecipeID               *string `json:"RecipeId"`
	CheckedDate            *string `json:"CheckedDate"`
	IsSyncedToExternalList *bool   `json:"IsSyncedToExternalList"`
	LastModified           *string `json:"LastModified"`
	ID                     string  `json:"Id"`
	IsDeleted              bool    `json:"IsDeleted"`
}

type ItemBucket struct {
	MaxLastModified string             `json:"MaxLastModified"`
	SyncEntities    []ShoppingListItem `json:"SyncEntities"`
	LocalChangesIds []string           `json:"LocalChangesIds"`
}

type ItemBucketResponse struct {
	UpdatedLocalItems         []AckItem          `json:"UpdatedLocalItems"`
	UpdatedServerItems        []ShoppingListItem `json:"UpdatedServerItems"`
	HasMoreUpdatedServerItems bool               `json:"HasMoreUpdatedServerItems"`
	MaxLastModified           string             `json:"MaxLastModified"`
}

// AckItem is what the server returns for entities we pushed: the authoritative
// LastModified, which must be written back to the link.
type AckItem struct {
	ID           string `json:"Id"`
	LastModified string `json:"LastModified"`
}

// RawBucket is used for buckets we pull but do not model in detail.
// SyncEntities exists for pulling only; ShoppingListItem is the sole entity
// this integration ever pushes.
type RawBucket struct {
	MaxLastModified string            `json:"MaxLastModified"`
	SyncEntities    []json.RawMessage `json:"SyncEntities"`
	LocalChangesIds []string          `json:"LocalChangesIds"`
}

type RawBucketResponse struct {
	UpdatedLocalItems         []AckItem         `json:"UpdatedLocalItems"`
	UpdatedServerItems        []json.RawMessage `json:"UpdatedServerItems"`
	HasMoreUpdatedServerItems bool              `json:"HasMoreUpdatedServerItems"`
	MaxLastModified           string            `json:"MaxLastModified"`
}

// SyncRequest mirrors the twelve-bucket envelope. A nil bucket serializes to
// null and is skipped by the server — always null what you do not need, since
// the Recipe bucket alone can be hundreds of megabytes.
type SyncRequest struct {
	Recipe                   *RawBucket  `json:"RecipeSyncEntityRequest"`
	ShoppingListCategory     *RawBucket  `json:"ShoppingListCategorySyncEntityRequest"`
	ShoppingListCategoryItem *RawBucket  `json:"ShoppingListCategoryItemSyncEntityRequest"`
	ShoppingList             *RawBucket  `json:"ShoppingListSyncEntityRequest"`
	ShoppingListItem         *ItemBucket `json:"ShoppingListItemSyncEntityRequest"`
	Meal                     *RawBucket  `json:"MealSyncEntityRequest"`
	Course                   *RawBucket  `json:"CourseSyncEntityRequest"`
	Category                 *RawBucket  `json:"CategorySyncEntityRequest"`
	Collection               *RawBucket  `json:"CollectionSyncEntityRequest"`
	MealType                 *RawBucket  `json:"MealTypeSyncEntityRequest"`
	MealPlanner              *RawBucket  `json:"MealPlannerSyncEntityRequest"`
	Cookbook                 *RawBucket  `json:"CookbookSyncEntityRequest"`
}

// SyncResponse models only the five buckets this integration reads; the other
// seven are always null and never consumed.
type SyncResponse struct {
	Recipe                   *RawBucketResponse  `json:"RecipeSyncEntityResponse"`
	ShoppingListCategory     *RawBucketResponse  `json:"ShoppingListCategorySyncEntityResponse"`
	ShoppingListCategoryItem *RawBucketResponse  `json:"ShoppingListCategoryItemSyncEntityResponse"`
	ShoppingList             *RawBucketResponse  `json:"ShoppingListSyncEntityResponse"`
	ShoppingListItem         *ItemBucketResponse `json:"ShoppingListItemSyncEntityResponse"`
}

type Client struct {
	BaseURL string
	HTTP    *http.Client
	Auth    *Authenticator
	Hdr     Headers
}

// NewClient builds a client with a cookie jar, so the Azure ARRAffinity
// stickiness cookie is honoured across calls.
func NewClient(baseURL string, auth *Authenticator, hdr Headers) *Client {
	jar, _ := cookiejar.New(nil)
	return &Client{
		BaseURL: baseURL,
		HTTP:    &http.Client{Jar: jar, Timeout: notifyTimeout + 15*time.Second},
		Auth:    auth,
		Hdr:     hdr,
	}
}

func (c *Client) do(ctx context.Context, path string, body []byte) (*http.Response, error) {
	tok, err := c.Auth.Token(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	c.Hdr.apply(req)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	return c.HTTP.Do(req)
}

func (c *Client) Sync(ctx context.Context, sreq SyncRequest) (*SyncResponse, error) {
	body, err := json.Marshal(sreq)
	if err != nil {
		return nil, err
	}
	resp, err := c.do(ctx, "/api/sync", body)
	if err != nil {
		return nil, fmt.Errorf("recipekeeper: sync: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, fmt.Errorf("recipekeeper: sync status %d", resp.StatusCode)
	}
	var out SyncResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxSyncBody)).Decode(&out); err != nil {
		return nil, fmt.Errorf("recipekeeper: decode sync: %w", err)
	}
	return &out, nil
}

// Notify parks a long poll. It returns true when the server signals a change
// (200) and false when the poll simply expired (201). Both carry empty bodies —
// the status code is the entire message.
func (c *Client) Notify(ctx context.Context) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, notifyTimeout)
	defer cancel()

	resp, err := c.do(ctx, "/api/syncnotification", []byte(`""`))
	if err != nil {
		return false, fmt.Errorf("recipekeeper: notify: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	switch resp.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusCreated:
		return false, nil
	default:
		return false, fmt.Errorf("recipekeeper: notify status %d", resp.StatusCode)
	}
}
