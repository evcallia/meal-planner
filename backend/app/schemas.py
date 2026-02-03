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
    name: str
    quantity: int
    updated_at: datetime

    class Config:
        from_attributes = True


class PantryItemCreate(BaseModel):
    name: str = Field(..., min_length=1)
    quantity: int = Field(default=0, ge=0)


class PantryItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    quantity: int | None = Field(default=None, ge=0)


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
    title: str
    start_time: datetime
    end_time: datetime | None = None
    all_day: bool = False


class DayData(BaseModel):
    date: date
    events: list[CalendarEvent]
    meal_note: MealNoteSchema | None


class UserInfo(BaseModel):
    sub: str
    email: str | None = None
    name: str | None = None
