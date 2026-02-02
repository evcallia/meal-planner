from datetime import date, datetime
from uuid import UUID
from pydantic import BaseModel


class MealItemSchema(BaseModel):
    line_index: int
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
