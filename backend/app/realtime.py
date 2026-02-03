import asyncio
import json
from typing import Any, Dict, Set


def _format_sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


class EventBroadcaster:
    def __init__(self, max_queue_size: int = 100) -> None:
        self._queues: Set[asyncio.Queue[str]] = set()
        self._max_queue_size = max_queue_size

    def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self._max_queue_size)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        self._queues.discard(queue)

    async def publish(self, payload: Dict[str, Any]) -> None:
        message = _format_sse(payload)
        dead: Set[asyncio.Queue[str]] = set()
        for queue in self._queues:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                try:
                    _ = queue.get_nowait()
                    queue.put_nowait(message)
                except Exception:
                    dead.add(queue)
            except Exception:
                dead.add(queue)
        for queue in dead:
            self._queues.discard(queue)


broadcaster = EventBroadcaster()


async def broadcast_event(event_type: str, payload: Dict[str, Any]) -> None:
    await broadcaster.publish({"type": event_type, "payload": payload})
