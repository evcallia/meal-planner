import asyncio
import json
from typing import Any, Dict, Optional, Set


def _format_sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"

shutdown_event = asyncio.Event()


class EventBroadcaster:
    def __init__(self, max_queue_size: int = 100) -> None:
        self._queues: Set[asyncio.Queue[Optional[str]]] = set()
        self._max_queue_size = max_queue_size
        self._closed = False

    def subscribe(self) -> asyncio.Queue[Optional[str]]:
        queue: asyncio.Queue[Optional[str]] = asyncio.Queue(maxsize=self._max_queue_size)
        if self._closed:
            try:
                queue.put_nowait(None)
            except Exception:
                pass
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[Optional[str]]) -> None:
        self._queues.discard(queue)

    async def publish(self, payload: Dict[str, Any]) -> None:
        if self._closed:
            return
        message = _format_sse(payload)
        dead: Set[asyncio.Queue[Optional[str]]] = set()
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

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for queue in list(self._queues):
            try:
                while True:
                    try:
                        queue.put_nowait(None)
                        break
                    except asyncio.QueueFull:
                        try:
                            _ = queue.get_nowait()
                        except Exception:
                            break
            except Exception:
                pass


broadcaster = EventBroadcaster()


async def broadcast_event(event_type: str, payload: Dict[str, Any]) -> None:
    await broadcaster.publish({"type": event_type, "payload": payload})
