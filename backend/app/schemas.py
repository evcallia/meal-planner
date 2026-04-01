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


class GrocerySectionUpdate(BaseModel):
    name: str = Field(..., min_length=1)


class GroceryReorderSections(BaseModel):
    section_ids: list[UUID]


class GroceryReorderItems(BaseModel):
    item_ids: list[UUID]


class GroceryMoveItem(BaseModel):
    to_section_id: UUID
    to_position: int


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
