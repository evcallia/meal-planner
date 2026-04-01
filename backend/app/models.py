import uuid
from datetime import datetime, date
from sqlalchemy import String, Text, Boolean, Integer, Date, DateTime, ForeignKey, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class MealNote(Base):
    __tablename__ = "meal_notes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    date: Mapped[date] = mapped_column(Date, unique=True, index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    items: Mapped[list["MealItem"]] = relationship(
        "MealItem", back_populates="meal_note", cascade="all, delete-orphan"
    )


class MealItem(Base):
    __tablename__ = "meal_items"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    meal_note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("meal_notes.id", ondelete="CASCADE")
    )
    line_index: Mapped[int] = mapped_column(Integer)
    itemized: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    meal_note: Mapped["MealNote"] = relationship("MealNote", back_populates="items")


class PantrySection(Base):
    """Pantry sections (e.g., Fridge, Freezer, Dry Goods)."""
    __tablename__ = "pantry_sections"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    items: Mapped[list["PantryItem"]] = relationship(
        "PantryItem", back_populates="section", cascade="all, delete-orphan"
    )


class PantryItem(Base):
    __tablename__ = "pantry_items"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    section_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("pantry_sections.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(Text)
    quantity: Mapped[int] = mapped_column(Integer, default=0)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    section: Mapped["PantrySection"] = relationship("PantrySection", back_populates="items")


class MealIdea(Base):
    __tablename__ = "meal_ideas"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    title: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class CachedCalendarEvent(Base):
    """Cached calendar events from CalDAV to avoid slow API calls."""
    __tablename__ = "cached_calendar_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_date: Mapped[date] = mapped_column(Date, index=True)
    event_uid: Mapped[str] = mapped_column(Text, default="")
    calendar_name: Mapped[str] = mapped_column(Text, default="")  # Which calendar this event came from
    title: Mapped[str] = mapped_column(Text)
    start_time: Mapped[datetime] = mapped_column(DateTime)
    end_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CalendarCacheMetadata(Base):
    """Tracks when the calendar cache was last refreshed."""
    __tablename__ = "calendar_cache_metadata"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    last_refresh: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cache_start: Mapped[date | None] = mapped_column(Date, nullable=True)
    cache_end: Mapped[date | None] = mapped_column(Date, nullable=True)


class GrocerySection(Base):
    """Grocery list sections (e.g., Produce, Dairy)."""
    __tablename__ = "grocery_sections"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    items: Mapped[list["GroceryItem"]] = relationship(
        "GroceryItem", back_populates="section", cascade="all, delete-orphan"
    )


class GroceryItem(Base):
    """Individual grocery list items."""
    __tablename__ = "grocery_items"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    section_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("grocery_sections.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(Text)
    quantity: Mapped[str | None] = mapped_column(Text, nullable=True)
    checked: Mapped[bool] = mapped_column(Boolean, default=False)
    position: Mapped[int] = mapped_column(Integer, default=0)
    store_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stores.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    section: Mapped["GrocerySection"] = relationship("GrocerySection", back_populates="items")
    store: Mapped["Store | None"] = relationship("Store")


class Store(Base):
    """Grocery stores (e.g., Whole Foods, Trader Joe's)."""
    __tablename__ = "stores"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(Text, unique=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ItemDefault(Base):
    """Per-item defaults (e.g., default store for an item name)."""
    __tablename__ = "item_defaults"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    item_name: Mapped[str] = mapped_column(Text, unique=True)
    store_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stores.id", ondelete="SET NULL"), nullable=True
    )

    store: Mapped["Store | None"] = relationship("Store")


class HiddenCalendarEvent(Base):
    """Calendar events hidden from the UI."""
    __tablename__ = "hidden_calendar_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_uid: Mapped[str] = mapped_column(Text)
    event_date: Mapped[date] = mapped_column(Date, index=True)
    calendar_name: Mapped[str] = mapped_column(Text, default="")
    title: Mapped[str] = mapped_column(Text)
    start_time: Mapped[datetime] = mapped_column(DateTime)
    end_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class UserSettings(Base):
    __tablename__ = "user_settings"

    sub: Mapped[str] = mapped_column(String(255), primary_key=True)
    settings: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
