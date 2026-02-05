"""Tests for database module."""
import pytest
from unittest.mock import patch, MagicMock


class TestGetDb:
    """Test the get_db dependency."""

    def test_get_db_yields_and_closes(self):
        """Test that get_db yields a session and closes it."""
        from app.database import get_db

        # Create a mock session
        mock_session = MagicMock()

        # Patch SessionLocal to return our mock
        with patch("app.database.SessionLocal", return_value=mock_session):
            # Get the generator
            gen = get_db()

            # Get the session
            session = next(gen)
            assert session == mock_session

            # Close the generator (simulates exiting the with block)
            try:
                next(gen)
            except StopIteration:
                pass

            # Verify close was called
            mock_session.close.assert_called_once()

    def test_get_db_closes_on_exception(self):
        """Test that get_db closes the session even on exception."""
        from app.database import get_db

        mock_session = MagicMock()

        with patch("app.database.SessionLocal", return_value=mock_session):
            gen = get_db()
            session = next(gen)

            # Simulate an exception during use
            try:
                gen.throw(ValueError("Test exception"))
            except ValueError:
                pass

            # Session should still be closed
            mock_session.close.assert_called_once()
