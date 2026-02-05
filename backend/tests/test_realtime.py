import asyncio
import json

import pytest

from app.realtime import EventBroadcaster, _format_sse, broadcast_event


@pytest.mark.asyncio
async def test_publish_enqueues_message() -> None:
    broadcaster = EventBroadcaster()
    queue = broadcaster.subscribe()

    await broadcaster.publish({"type": "test", "payload": {"value": 1}})

    message = await asyncio.wait_for(queue.get(), timeout=1)
    assert message is not None
    assert message.startswith("data: ")
    payload = json.loads(message[len("data: "):].strip())
    assert payload["type"] == "test"
    assert payload["payload"] == {"value": 1}

    broadcaster.unsubscribe(queue)


@pytest.mark.asyncio
async def test_close_inserts_sentinel_even_when_queue_full() -> None:
    broadcaster = EventBroadcaster(max_queue_size=1)
    queue = broadcaster.subscribe()
    queue.put_nowait("data: {\"type\":\"stale\"}\n\n")

    broadcaster.close()

    message = await asyncio.wait_for(queue.get(), timeout=1)
    assert message is None


def test_subscribe_after_close_returns_sentinel() -> None:
    broadcaster = EventBroadcaster()
    broadcaster.close()

    queue = broadcaster.subscribe()
    message = queue.get_nowait()
    assert message is None


def test_format_sse():
    """Test the _format_sse helper function."""
    result = _format_sse({"type": "test", "payload": {"value": 123}})
    assert result.startswith("data: ")
    assert result.endswith("\n\n")
    # Verify JSON is properly formatted (minimal separators)
    payload = json.loads(result[len("data: "):].strip())
    assert payload["type"] == "test"
    assert payload["payload"]["value"] == 123


@pytest.mark.asyncio
async def test_publish_to_multiple_subscribers() -> None:
    """Test publishing to multiple subscribers."""
    broadcaster = EventBroadcaster()
    queue1 = broadcaster.subscribe()
    queue2 = broadcaster.subscribe()

    await broadcaster.publish({"type": "test", "payload": {}})

    # Both queues should receive the message
    msg1 = await asyncio.wait_for(queue1.get(), timeout=1)
    msg2 = await asyncio.wait_for(queue2.get(), timeout=1)

    assert msg1 is not None
    assert msg2 is not None
    assert msg1 == msg2

    broadcaster.unsubscribe(queue1)
    broadcaster.unsubscribe(queue2)


@pytest.mark.asyncio
async def test_unsubscribe_removes_queue() -> None:
    """Test that unsubscribing removes the queue from the broadcaster."""
    broadcaster = EventBroadcaster()
    queue = broadcaster.subscribe()

    assert queue in broadcaster._queues

    broadcaster.unsubscribe(queue)

    assert queue not in broadcaster._queues


@pytest.mark.asyncio
async def test_publish_handles_queue_full() -> None:
    """Test that publish handles full queues by dropping old messages."""
    broadcaster = EventBroadcaster(max_queue_size=2)
    queue = broadcaster.subscribe()

    # Fill the queue
    await broadcaster.publish({"type": "msg1", "payload": {}})
    await broadcaster.publish({"type": "msg2", "payload": {}})

    # This should drop msg1 and add msg3
    await broadcaster.publish({"type": "msg3", "payload": {}})

    # Get messages - should get msg2 and msg3
    msg1 = await asyncio.wait_for(queue.get(), timeout=1)
    msg2 = await asyncio.wait_for(queue.get(), timeout=1)

    payload1 = json.loads(msg1[len("data: "):].strip())
    payload2 = json.loads(msg2[len("data: "):].strip())

    # msg1 was dropped, so we get msg2 and msg3
    assert payload1["type"] == "msg2"
    assert payload2["type"] == "msg3"


@pytest.mark.asyncio
async def test_publish_after_close_does_nothing() -> None:
    """Test that publishing after close does nothing."""
    broadcaster = EventBroadcaster()
    queue = broadcaster.subscribe()

    broadcaster.close()

    # This should be a no-op
    await broadcaster.publish({"type": "test", "payload": {}})

    # Queue should only have the sentinel from close
    msg = queue.get_nowait()
    assert msg is None


@pytest.mark.asyncio
async def test_close_idempotent() -> None:
    """Test that close can be called multiple times safely."""
    broadcaster = EventBroadcaster()
    queue = broadcaster.subscribe()

    broadcaster.close()
    broadcaster.close()  # Should not raise

    msg = queue.get_nowait()
    assert msg is None


@pytest.mark.asyncio
async def test_broadcast_event_helper() -> None:
    """Test the broadcast_event helper function."""
    from unittest.mock import patch, AsyncMock

    with patch("app.realtime.broadcaster") as mock_broadcaster:
        mock_broadcaster.publish = AsyncMock()

        await broadcast_event("test.event", {"data": "value"})

        mock_broadcaster.publish.assert_awaited_once()
        call_args = mock_broadcaster.publish.call_args[0][0]
        assert call_args["type"] == "test.event"
        assert call_args["payload"] == {"data": "value"}


@pytest.mark.asyncio
async def test_publish_removes_dead_queues() -> None:
    """Test that publish removes queues that can't receive messages."""
    broadcaster = EventBroadcaster(max_queue_size=1)

    # Subscribe a queue
    queue1 = broadcaster.subscribe()

    # Fill it completely
    queue1.put_nowait("dummy")

    # Create a scenario where the queue fails to receive
    # by making get_nowait fail when trying to drop old message
    original_get = queue1.get_nowait

    def failing_get():
        raise RuntimeError("Simulated failure")

    queue1.get_nowait = failing_get

    # Publish should handle the failure and remove the dead queue
    await broadcaster.publish({"type": "test", "payload": {}})

    # The dead queue should be removed
    assert queue1 not in broadcaster._queues


@pytest.mark.asyncio
async def test_subscribe_after_close_exception_handling() -> None:
    """Test that subscribe handles exceptions when putting sentinel."""
    broadcaster = EventBroadcaster()
    broadcaster._closed = True

    # Even with close, subscribe should work
    queue = broadcaster.subscribe()
    assert queue in broadcaster._queues

    # The queue should have the sentinel
    msg = queue.get_nowait()
    assert msg is None


def test_shutdown_event_exists():
    """Test that the shutdown_event exists and is an asyncio.Event."""
    from app.realtime import shutdown_event
    assert isinstance(shutdown_event, asyncio.Event)


@pytest.mark.asyncio
async def test_publish_handles_put_exception() -> None:
    """Test that publish handles exceptions when putting to queue."""
    broadcaster = EventBroadcaster()
    queue = broadcaster.subscribe()

    # Mock put_nowait to raise an exception
    original_put = queue.put_nowait

    def failing_put(msg):
        raise RuntimeError("Simulated put failure")

    queue.put_nowait = failing_put

    # Publish should handle the failure and remove the dead queue
    await broadcaster.publish({"type": "test", "payload": {}})

    # The dead queue should be removed
    assert queue not in broadcaster._queues
