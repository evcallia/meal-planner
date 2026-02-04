import asyncio
import json

import pytest

from app.realtime import EventBroadcaster


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
