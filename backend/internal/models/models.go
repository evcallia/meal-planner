// Package models mirrors backend/app/models.py. All DateTime columns hold
// naive UTC (TIMESTAMP WITHOUT TIME ZONE in Postgres) — the app's invariant.
// Date columns hold midnight-UTC time.Time values.
package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// NewID generates a v4 UUID primary key.
func NewID() uuid.UUID { return uuid.New() }

// NowUTC returns the current time in UTC truncated to microseconds (matching
// Python's datetime.utcnow() resolution so serialized values round-trip).
func NowUTC() time.Time { return time.Now().UTC().Truncate(time.Microsecond) }

type MealNote struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	Date      time.Time `gorm:"type:date;uniqueIndex;index"`
	Notes     string    `gorm:"type:text"`
	CreatedAt time.Time `gorm:"type:timestamp;autoCreateTime:false"`
	UpdatedAt time.Time `gorm:"type:timestamp;autoUpdateTime:false"`

	Items []MealItem `gorm:"foreignKey:MealNoteID;constraint:OnDelete:CASCADE"`
}

func (m *MealNote) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	if m.UpdatedAt.IsZero() {
		m.UpdatedAt = NowUTC()
	}
	return nil
}

func (m *MealNote) BeforeUpdate(tx *gorm.DB) error {
	m.UpdatedAt = NowUTC()
	return nil
}

type MealItem struct {
	ID         uuid.UUID `gorm:"type:uuid;primaryKey"`
	MealNoteID uuid.UUID `gorm:"type:uuid"`
	LineIndex  int
	Itemized   bool
	CreatedAt  time.Time `gorm:"type:timestamp;autoCreateTime:false"`
}

func (m *MealItem) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	return nil
}

type PantrySection struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	Name      string    `gorm:"type:text"`
	Position  int
	CreatedAt time.Time `gorm:"type:timestamp;autoCreateTime:false"`

	Items []PantryItem `gorm:"foreignKey:SectionID;constraint:OnDelete:CASCADE"`
}

func (m *PantrySection) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	return nil
}

type PantryItem struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	SectionID uuid.UUID `gorm:"type:uuid"`
	Name      string    `gorm:"type:text"`
	Quantity  int
	Position  int
	CreatedAt time.Time `gorm:"type:timestamp;autoCreateTime:false"`
	UpdatedAt time.Time `gorm:"type:timestamp;autoUpdateTime:false"`
}

func (m *PantryItem) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	if m.UpdatedAt.IsZero() {
		m.UpdatedAt = NowUTC()
	}
	return nil
}

func (m *PantryItem) BeforeUpdate(tx *gorm.DB) error {
	m.UpdatedAt = NowUTC()
	return nil
}

type MealIdea struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	Title     string    `gorm:"type:text"`
	CreatedAt time.Time `gorm:"type:timestamp;autoCreateTime:false"`
	UpdatedAt time.Time `gorm:"type:timestamp;autoUpdateTime:false"`
}

func (m *MealIdea) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	if m.UpdatedAt.IsZero() {
		m.UpdatedAt = NowUTC()
	}
	return nil
}

func (m *MealIdea) BeforeUpdate(tx *gorm.DB) error {
	m.UpdatedAt = NowUTC()
	return nil
}

type CachedCalendarEvent struct {
	ID           uuid.UUID  `gorm:"type:uuid;primaryKey"`
	EventDate    time.Time  `gorm:"type:date;index"`
	EventUID     string     `gorm:"column:event_uid;type:text"`
	CalendarName string     `gorm:"type:text"`
	Title        string     `gorm:"type:text"`
	StartTime    time.Time  `gorm:"type:timestamp"`
	EndTime      *time.Time `gorm:"type:timestamp"`
	AllDay       bool
	CreatedAt    time.Time `gorm:"type:timestamp;autoCreateTime:false"`
}

func (m *CachedCalendarEvent) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	return nil
}

type CalendarCacheMetadata struct {
	ID          int        `gorm:"primaryKey"`
	LastRefresh *time.Time `gorm:"type:timestamp"`
	CacheStart  *time.Time `gorm:"type:date"`
	CacheEnd    *time.Time `gorm:"type:date"`
}

func (CalendarCacheMetadata) TableName() string { return "calendar_cache_metadata" }

type GrocerySection struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	Name      string    `gorm:"type:text"`
	Position  int
	CreatedAt time.Time `gorm:"type:timestamp;autoCreateTime:false"`

	Items []GroceryItem `gorm:"foreignKey:SectionID;constraint:OnDelete:CASCADE"`
}

func (m *GrocerySection) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	return nil
}

type GroceryItem struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	SectionID uuid.UUID `gorm:"type:uuid"`
	Name      string    `gorm:"type:text"`
	Quantity  *string   `gorm:"type:text"`
	Checked   bool
	Position  int
	StoreID   *uuid.UUID `gorm:"type:uuid"`
	CreatedAt time.Time  `gorm:"type:timestamp;autoCreateTime:false"`
	UpdatedAt time.Time  `gorm:"type:timestamp;autoUpdateTime:false"`
}

func (m *GroceryItem) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	if m.UpdatedAt.IsZero() {
		m.UpdatedAt = NowUTC()
	}
	return nil
}

func (m *GroceryItem) BeforeUpdate(tx *gorm.DB) error {
	m.UpdatedAt = NowUTC()
	return nil
}

type Store struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	Name      string    `gorm:"type:text;unique"`
	Position  int
	CreatedAt time.Time `gorm:"type:timestamp;autoCreateTime:false"`
}

func (m *Store) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	return nil
}

type ItemDefault struct {
	ID          uuid.UUID  `gorm:"type:uuid;primaryKey"`
	ItemName    string     `gorm:"type:text;unique"`
	StoreID     *uuid.UUID `gorm:"type:uuid"`
	SectionName *string    `gorm:"type:text"`
}

func (m *ItemDefault) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	return nil
}

type HiddenCalendarEvent struct {
	ID uuid.UUID `gorm:"type:uuid;primaryKey"`
	// Sub scopes the hide to one user — hiding an event does not hide it for
	// other household members. Legacy rows (pre-per-user) are backfilled per
	// known user in db.RunMigrations.
	Sub          string     `gorm:"type:varchar(255);index"`
	EventUID     string     `gorm:"column:event_uid;type:text"`
	EventDate    time.Time  `gorm:"type:date;index"`
	CalendarName string     `gorm:"type:text"`
	Title        string     `gorm:"type:text"`
	StartTime    time.Time  `gorm:"type:timestamp"`
	EndTime      *time.Time `gorm:"type:timestamp"`
	AllDay       bool
	CreatedAt    time.Time `gorm:"type:timestamp;autoCreateTime:false"`
}

func (m *HiddenCalendarEvent) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	return nil
}

type UserSettings struct {
	Sub       string    `gorm:"type:varchar(255);primaryKey"`
	Settings  string    `gorm:"type:json"` // raw JSON blob
	UpdatedAt time.Time `gorm:"type:timestamp;autoUpdateTime:false"`
}

func (UserSettings) TableName() string { return "user_settings" }

type User struct {
	Sub      string    `gorm:"type:varchar(255);primaryKey"`
	Email    *string   `gorm:"type:text"`
	Name     *string   `gorm:"type:text"`
	LastSeen time.Time `gorm:"type:timestamp;autoUpdateTime:false"`
}

func (m *User) BeforeCreate(tx *gorm.DB) error {
	if m.LastSeen.IsZero() {
		m.LastSeen = NowUTC()
	}
	return nil
}

func (m *User) BeforeUpdate(tx *gorm.DB) error {
	m.LastSeen = NowUTC()
	return nil
}

type TrackerList struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	OwnerSub  string    `gorm:"type:varchar(255);index"`
	Name      string    `gorm:"type:text"`
	Icon      *string   `gorm:"type:text"`
	Color     *string   `gorm:"type:text"`
	Position  int
	CreatedAt time.Time `gorm:"type:timestamp;autoCreateTime:false"`
	UpdatedAt time.Time `gorm:"type:timestamp;autoUpdateTime:false"`

	Tasks     []TrackerTask         `gorm:"foreignKey:ListID;constraint:OnDelete:CASCADE"`
	Shares    []TrackerShare        `gorm:"foreignKey:ListID;constraint:OnDelete:CASCADE"`
	Positions []TrackerListPosition `gorm:"foreignKey:ListID;constraint:OnDelete:CASCADE"`
}

func (m *TrackerList) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	if m.UpdatedAt.IsZero() {
		m.UpdatedAt = NowUTC()
	}
	return nil
}

func (m *TrackerList) BeforeUpdate(tx *gorm.DB) error {
	m.UpdatedAt = NowUTC()
	return nil
}

type TrackerShare struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	ListID    uuid.UUID `gorm:"type:uuid"`
	Sub       string    `gorm:"type:varchar(255);index"`
	CreatedAt time.Time `gorm:"type:timestamp;autoCreateTime:false"`
	// Soft-delete marker: set when the member leaves. Null = active.
	LeftAt *time.Time `gorm:"type:timestamp"`
}

func (m *TrackerShare) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	return nil
}

// TrackerListPosition is each user's personal ordering of tracker lists.
type TrackerListPosition struct {
	Sub      string    `gorm:"type:varchar(255);primaryKey"`
	ListID   uuid.UUID `gorm:"type:uuid;primaryKey"`
	Position int
}

func (TrackerListPosition) TableName() string { return "tracker_list_positions" }

type TrackerTask struct {
	ID                 uuid.UUID `gorm:"type:uuid;primaryKey"`
	ListID             uuid.UUID `gorm:"type:uuid"`
	Name               string    `gorm:"type:text"`
	TargetIntervalDays *int
	Notes              *string `gorm:"type:text"`
	Position           int
	Archived           bool
	SeasonStartMonth   *int
	SeasonEndMonth     *int
	SeasonStartDay     *int
	SeasonEndDay       *int
	SnoozeUntil        *time.Time `gorm:"type:timestamp"`
	// When we last sent a "task is due" push for the current overdue cycle.
	// Reset implicitly: a new done/skip/snooze moves the recency baseline past it.
	DueNotifiedAt *time.Time `gorm:"type:timestamp"`
	CreatedAt     time.Time  `gorm:"type:timestamp;autoCreateTime:false"`
	UpdatedAt     time.Time  `gorm:"type:timestamp;autoUpdateTime:false"`

	Logs []TrackerLog `gorm:"foreignKey:TaskID;constraint:OnDelete:CASCADE"`
}

func (m *TrackerTask) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	if m.UpdatedAt.IsZero() {
		m.UpdatedAt = NowUTC()
	}
	return nil
}

func (m *TrackerTask) BeforeUpdate(tx *gorm.DB) error {
	m.UpdatedAt = NowUTC()
	return nil
}

type TrackerLog struct {
	ID           uuid.UUID `gorm:"type:uuid;primaryKey"`
	TaskID       uuid.UUID `gorm:"type:uuid"`
	DoneAt       time.Time `gorm:"type:timestamp;index"`
	Kind         string    `gorm:"type:varchar(16)"` // "done" | "skip"
	Note         *string   `gorm:"type:text"`
	CreatedBySub *string   `gorm:"type:varchar(255)"`
	CreatedAt    time.Time `gorm:"type:timestamp;autoCreateTime:false"`
}

func (m *TrackerLog) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.DoneAt.IsZero() {
		m.DoneAt = NowUTC()
	}
	if m.Kind == "" {
		m.Kind = "done"
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	return nil
}

// PushSubscription is a Web Push subscription for one browser/device of a
// signed-in user.
type PushSubscription struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	Sub       string    `gorm:"type:varchar(255);index"`
	Endpoint  string    `gorm:"type:text;unique"`
	P256dh    string    `gorm:"column:p256dh;type:text"`
	Auth      string    `gorm:"type:text"`
	CreatedAt time.Time `gorm:"type:timestamp;autoCreateTime:false"`
}

func (m *PushSubscription) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.CreatedAt.IsZero() {
		m.CreatedAt = NowUTC()
	}
	return nil
}

// VapidKeyPair is the server's VAPID keypair for Web Push (single row,
// generated on first use).
type VapidKeyPair struct {
	ID         int    `gorm:"primaryKey"`
	PrivateKey string `gorm:"type:text"`
	PublicKey  string `gorm:"type:text"`
}

func (VapidKeyPair) TableName() string { return "vapid_keys" }

// ActivityLog is one edit somebody made, phrased for humans — the backing
// store for the "what happened since I last looked" feed. Rows for tracker
// lists carry an audience snapshot so feed visibility matches list membership
// even after the list (and its share rows) are deleted.
type ActivityLog struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	At        time.Time `gorm:"type:timestamp;index"`
	ActorSub  string    `gorm:"type:varchar(255)"`
	ActorName string    `gorm:"type:text"`
	Category  string    `gorm:"type:varchar(32)"` // meals | pantry | grocery | lists
	Detail    string    `gorm:"type:text"`        // verb phrase, e.g. `completed “Water plants”`
	ListName  string    `gorm:"type:text"`        // tracker rows: list name for display
	// ListID (text; empty for non-tracker rows) lets the feed apply the same
	// per-list notification overrides as pushes. Kept separate from Audience:
	// no FK, so entries survive list deletion.
	ListID string `gorm:"type:text"`
	// TaskID (text; set on "list-due" rows) lets the feed apply per-task mutes.
	TaskID string `gorm:"type:text"`
	// Audience is a delimited sub snapshot ("|sub1|sub2|") for tracker rows;
	// empty = visible to every user (shared-global data).
	Audience string `gorm:"type:text"`
}

func (m *ActivityLog) BeforeCreate(tx *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = NewID()
	}
	if m.At.IsZero() {
		m.At = NowUTC()
	}
	return nil
}

// ActivitySeen is each user's "I've seen the feed up to here" marker.
type ActivitySeen struct {
	Sub    string    `gorm:"type:varchar(255);primaryKey"`
	SeenAt time.Time `gorm:"type:timestamp"`
}

func (ActivitySeen) TableName() string { return "activity_seen" }

// DueDigest tracks when each user's daily due-task summary was last sent,
// so restarts never double-send and each local day sends exactly once.
type DueDigest struct {
	Sub    string    `gorm:"type:varchar(255);primaryKey"`
	SentAt time.Time `gorm:"type:timestamp"`
}

func (DueDigest) TableName() string { return "due_digests" }

// AllModels is the create_all set, in FK-dependency order.
func AllModels() []any {
	return []any{
		&MealNote{}, &MealItem{},
		&PantrySection{}, &PantryItem{},
		&MealIdea{},
		&CachedCalendarEvent{}, &CalendarCacheMetadata{}, &HiddenCalendarEvent{},
		&Store{}, &GrocerySection{}, &GroceryItem{}, &ItemDefault{},
		&UserSettings{}, &User{},
		&TrackerList{}, &TrackerShare{}, &TrackerListPosition{}, &TrackerTask{}, &TrackerLog{},
		&PushSubscription{}, &VapidKeyPair{},
		&ActivityLog{}, &ActivitySeen{}, &DueDigest{},
	}
}
