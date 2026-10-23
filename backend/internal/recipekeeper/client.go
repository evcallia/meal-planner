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

// clientTimeout bounds the overall round trip (headers + body) for any
// request through Client.HTTP. Kept comfortably above the transport's own
// responseHeaderTimeout so it never fires first and mask that timeout's
// error with a less specific one.
const clientTimeout = responseHeaderTimeout + 15*time.Second

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
// stickiness cookie is honoured across calls. transport is the RoundTripper
// backing the client; pass nil to get a dedicated one via NewTransport. Pass
// the SAME *http.Transport used to build the Authenticator's http.Client so
// the token endpoint and the sync endpoint share one connection pool and one
// IdleConnTimeout (see NewTransport for why that matters).
func NewClient(baseURL string, auth *Authenticator, hdr Headers, transport *http.Transport) *Client {
	jar, _ := cookiejar.New(nil)
	if transport == nil {
		transport = NewTransport()
	}
	return &Client{
		BaseURL: baseURL,
		HTTP:    &http.Client{Jar: jar, Timeout: clientTimeout, Transport: transport},
		Auth:    auth,
		Hdr:     hdr,
	}
}

// do issues one Sync/Notify request. It implements the spec's "reactive
// fallback" for token lifecycle: renewal above (Authenticator.Token) is
// time-driven off the JWT's own exp, but the server can reject a token we
// still consider valid (e.g. a session revoked server-side) long before
// that. An unexpected 401/403 here invalidates the cached token and retries
// exactly once with a freshly fetched one; if the retry ALSO gets 401/403,
// the token wasn't the problem (or the new one was rejected too) — that is
// reported as an authError so IsAuthError matches and the caller's auth
// latch/alerting engages, rather than silently falling into the transient
// "can't reach" backoff path with the wrong diagnosis.
func (c *Client) do(ctx context.Context, path string, body []byte) (*http.Response, error) {
	return c.doAttempt(ctx, path, body, true)
}

func (c *Client) doAttempt(ctx context.Context, path string, body []byte, allowRetry bool) (*http.Response, error) {
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
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden {
		return resp, nil
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if !allowRetry {
		return nil, authError{fmt.Errorf("recipekeeper: request rejected after re-auth (%d)", resp.StatusCode)}
	}
	c.Auth.InvalidateToken()
	return c.doAttempt(ctx, path, body, false)
}

// normalizeSyncRequest fills in nil SyncEntities/LocalChangesIds slices on
// every present bucket.
//
// The server rejects a bucket whose SyncEntities or LocalChangesIds is
// JSON null with 500 "An unhandled exception occurred" — verified against
// the live API. Go marshals a nil slice as null, so normalize both to []
// here rather than trusting every caller to remember. Nil BUCKETS stay
// null: that is how a bucket is skipped.
func normalizeSyncRequest(sreq *SyncRequest) {
	normalizeRaw := func(b *RawBucket) {
		if b == nil {
			return
		}
		if b.SyncEntities == nil {
			b.SyncEntities = []json.RawMessage{}
		}
		if b.LocalChangesIds == nil {
			b.LocalChangesIds = []string{}
		}
	}
	normalizeRaw(sreq.Recipe)
	normalizeRaw(sreq.ShoppingListCategory)
	normalizeRaw(sreq.ShoppingListCategoryItem)
	normalizeRaw(sreq.ShoppingList)
	normalizeRaw(sreq.Meal)
	normalizeRaw(sreq.Course)
	normalizeRaw(sreq.Category)
	normalizeRaw(sreq.Collection)
	normalizeRaw(sreq.MealType)
	normalizeRaw(sreq.MealPlanner)
	normalizeRaw(sreq.Cookbook)

	if b := sreq.ShoppingListItem; b != nil {
		if b.SyncEntities == nil {
			b.SyncEntities = []ShoppingListItem{}
		}
		if b.LocalChangesIds == nil {
			b.LocalChangesIds = []string{}
		}
	}
}

func (c *Client) Sync(ctx context.Context, sreq SyncRequest) (*SyncResponse, error) {
	normalizeSyncRequest(&sreq)
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
