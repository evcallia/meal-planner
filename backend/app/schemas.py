from datetime import date, datetime
from uuid import UUID
from pydantic import BaseModel, Field


class MealItemSchema(BaseModel):
    line_index: int = Field(..., ge=0)  # Must be >= 0
    itemized: bool

    class Config:
        from_attributes = True


class MealNoteSchema(BaseModel):
    id: UUID
    date: date
    notes: str
    items: list[MealItemSchema]
    updated_at: datetime

    class Config:
        from_attributes = True


class MealNoteUpdate(BaseModel):
    notes: str


class MealItemToggle(BaseModel):
    itemized: bool


class PantryItemSchema(BaseModel):
    id: UUID
    section_id: UUID
    name: str
    quantity: int
    position: int
    updated_at: datetime

    class Config:
        from_attributes = True


class PantrySectionSchema(BaseModel):
    id: UUID
    name: str
    position: int
    items: list[PantryItemSchema]

    class Config:
        from_attributes = True


class PantryItemCreate(BaseModel):
    section_id: UUID
    name: str = Field(..., min_length=1)
    quantity: int = Field(default=0, ge=0)


class PantryItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    quantity: int | None = Field(default=None, ge=0)


class PantryReplaceItem(BaseModel):
    name: str
    quantity: int = 0


class PantryReplaceSection(BaseModel):
    name: str
    items: list[PantryReplaceItem]


class PantryReplacePayload(BaseModel):
    sections: list[PantryReplaceSection]


class PantrySectionUpdate(BaseModel):
    name: str = Field(..., min_length=1)


class PantryReorderSections(BaseModel):
    section_ids: list[UUID]


class PantryReorderItems(BaseModel):
    item_ids: list[UUID]


class PantryMoveItem(BaseModel):
    to_section_id: UUID
    to_position: int


class MealIdeaSchema(BaseModel):
    id: UUID
    title: str
    updated_at: datetime

    class Config:
        from_attributes = True


class MealIdeaCreate(BaseModel):
    title: str = Field(..., min_length=1)


class MealIdeaUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1)


class CalendarEvent(BaseModel):
    id: str
    uid: str | None = None
    calendar_name: str | None = None
    title: str
    start_time: datetime
    end_time: datetime | None = None
    all_day: bool = False


class HiddenCalendarEventSchema(BaseModel):
    id: UUID
    event_uid: str
    event_date: date
    calendar_name: str
    title: str
    start_time: datetime
    end_time: datetime | None = None
    all_day: bool = False

    class Config:
        from_attributes = True


class GroceryItemSchema(BaseModel):
    id: UUID
    section_id: UUID
    name: str
    quantity: str | None = None
    checked: bool
    position: int
    store_id: UUID | None = None
    updated_at: datetime

    class Config:
        from_attributes = True


class GrocerySectionSchema(BaseModel):
    id: UUID
    name: str
    position: int
    items: list[GroceryItemSchema]

    class Config:
        from_attributes = True


class GroceryItemCreate(BaseModel):
    section_id: UUID
    name: str = Field(..., min_length=1)
    quantity: str | None = None
    store_id: UUID | None = None


class GroceryItemToggle(BaseModel):
    checked: bool


class GroceryItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    quantity: str | None = None
    checked: bool | None = None
    store_id: UUID | None = None


class GroceryReplaceItem(BaseModel):
    name: str
    quantity: str | None = None
    checked: bool = False
    store_id: UUID | None = None


class GroceryReplaceSection(BaseModel):
    name: str
    items: list[GroceryReplaceItem]


class GroceryReplacePayload(BaseModel):
    sections: list[GroceryReplaceSection]


class GrocerySectionCreate(BaseModel):
    name: str = Field(..., min_length=1)
    position: int | None = None


class GrocerySectionUpdate(BaseModel):
    name: str = Field(..., min_length=1)


class GroceryReorderSections(BaseModel):
    section_ids: list[UUID]


class GroceryReorderItems(BaseModel):
    item_ids: list[UUID]


class GroceryMoveItem(BaseModel):
    to_section_id: UUID
    to_position: int


class ItemDefaultSchema(BaseModel):
    item_name: str
    store_id: UUID | None = None
    section_name: str | None = None

    class Config:
        from_attributes = True


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


class DayData(BaseModel):
    date: date
    events: list[CalendarEvent]
    meal_note: MealNoteSchema | None


class UserInfo(BaseModel):
    sub: str
    email: str | None = None
    name: str | None = None


class UserSettingsResponse(BaseModel):
    settings: dict
    updated_at: datetime | None = None


class UserSettingsUpdate(BaseModel):
    settings: dict
    updated_at: datetime


# ----- Tracker / Lists -----

class TrackerLogSchema(BaseModel):
    id: UUID
    task_id: UUID
    done_at: datetime
    kind: str = "done"
    note: str | None = None
    created_by_sub: str | None = None
    created_by_name: str | None = None


class TrackerTaskSchema(BaseModel):
    id: UUID
    list_id: UUID
    name: str
    target_interval_days: int | None = None
    notes: str | None = None
    position: int
    archived: bool
    season_start_month: int | None = None
    season_end_month: int | None = None
    season_start_day: int | None = None
    season_end_day: int | None = None
    snooze_until: datetime | None = None
    last_done_at: datetime | None = None
    last_event_at: datetime | None = None
    last_done_by: str | None = None
    last_note: str | None = None
    total_count: int
    avg_interval_days: float | None = None
    recent_logs: list[TrackerLogSchema] = []


class TrackerShareUser(BaseModel):
    sub: str
    email: str | None = None
    name: str | None = None


class TrackerListSchema(BaseModel):
    id: UUID
    name: str
    icon: str | None = None
    color: str | None = None
    position: int
    owner_sub: str
    owner_name: str | None = None
    is_owner: bool
    shared_with: list[TrackerShareUser]
    tasks: list[TrackerTaskSchema]


class TrackerListCreate(BaseModel):
    name: str = Field(..., min_length=1)
    icon: str | None = None
    color: str | None = None


class TrackerListUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    icon: str | None = None
    color: str | None = None


class TrackerReorderLists(BaseModel):
    list_ids: list[UUID]


class TrackerShareCreate(BaseModel):
    # Identify the collaborator by email (preferred) or sub.
    email: str | None = None
    sub: str | None = None


class TrackerTaskCreate(BaseModel):
    list_id: UUID
    name: str = Field(..., min_length=1)
    target_interval_days: int | None = Field(default=None, ge=1)
    notes: str | None = None
    season_start_month: int | None = Field(default=None, ge=1, le=12)
    season_end_month: int | None = Field(default=None, ge=1, le=12)
    season_start_day: int | None = Field(default=None, ge=1, le=31)
    season_end_day: int | None = Field(default=None, ge=1, le=31)


class TrackerTaskUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    target_interval_days: int | None = Field(default=None, ge=1)
    notes: str | None = None
    archived: bool | None = None
    season_start_month: int | None = Field(default=None, ge=1, le=12)
    season_end_month: int | None = Field(default=None, ge=1, le=12)
    season_start_day: int | None = Field(default=None, ge=1, le=31)
    season_end_day: int | None = Field(default=None, ge=1, le=31)
    snooze_until: datetime | None = None


class TrackerReorderTasks(BaseModel):
    task_ids: list[UUID]


class TrackerLogCreate(BaseModel):
    done_at: datetime | None = None
    kind: str = "done"  # "done" | "skip"
    note: str | None = None
    created_by_sub: str | None = None  # attribute to a collaborator; defaults to current user


class TrackerLogRestore(BaseModel):
    done_at: datetime | None = None
    kind: str = "done"
    note: str | None = None
    created_by_sub: str | None = None


class TrackerTaskRestore(BaseModel):
    name: str = Field(..., min_length=1)
    target_interval_days: int | None = Field(default=None, ge=1)
    notes: str | None = None
    position: int = 0
    season_start_month: int | None = Field(default=None, ge=1, le=12)
    season_end_month: int | None = Field(default=None, ge=1, le=12)
    season_start_day: int | None = Field(default=None, ge=1, le=31)
    season_end_day: int | None = Field(default=None, ge=1, le=31)
    logs: list[TrackerLogRestore] = []


class TrackerListRestore(BaseModel):
    """Recreate a deleted list with its tasks, logs and shares in one shot, so undo
    restores it atomically (and other devices see one event, not a flickering rebuild)."""
    name: str = Field(..., min_length=1)
    icon: str | None = None
    color: str | None = None
    position: int | None = None
    share_subs: list[str] = []
    tasks: list[TrackerTaskRestore] = []


class TrackerDirectoryUser(BaseModel):
    sub: str
    email: str | None = None
    name: str | None = None
