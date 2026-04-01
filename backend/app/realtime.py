import asyncio
import json
from typing import Any, Dict, Optional, Set


def _format_sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


shutdown_event = asyncio.Event()


class EventBroadcaster:
    def __init__(self, max_queue_size: int = 100) -> None:
        self._queues: Set[asyncio.Queue[Optional[str]]] = set()
        self._queue_subs: Dict[asyncio.Queue[Optional[str]], str | None] = {}
        self._max_queue_size = max_queue_size
        self._closed = False

    def subscribe(self, sub: str | None = None) -> asyncio.Queue[Optional[str]]:
        queue: asyncio.Queue[Optional[str]] = asyncio.Queue(maxsize=self._max_queue_size)
        if self._closed:
            try:
                queue.put_nowait(None)
            except Exception:
                pass
        self._queues.add(queue)
        self._queue_subs[queue] = sub
        return queue

    def unsubscribe(self, queue: asyncio.Queue[Optional[str]]) -> None:
        self._queues.discard(queue)
        self._queue_subs.pop(queue, None)

    def _send_to_queue(self, queue: asyncio.Queue[Optional[str]], message: str, dead: Set[asyncio.Queue[Optional[str]]]) -> None:
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

    def _cleanup_dead(self, dead: Set[asyncio.Queue[Optional[str]]]) -> None:
        for queue in dead:
            self._queues.discard(queue)
            self._queue_subs.pop(queue, None)

    async def publish(self, payload: Dict[str, Any]) -> None:
        if self._closed:
            return
        message = _format_sse(payload)
        dead: Set[asyncio.Queue[Optional[str]]] = set()
        for queue in self._queues:
            self._send_to_queue(queue, message, dead)
        self._cleanup_dead(dead)

    async def publish_to_user(self, sub: str, payload: Dict[str, Any], exclude_queue: asyncio.Queue[Optional[str]] | None = None) -> None:
        if self._closed:
            return
        message = _format_sse(payload)
        dead: Set[asyncio.Queue[Optional[str]]] = set()
        for queue in self._queues:
            if self._queue_subs.get(queue) == sub and queue is not exclude_queue:
                self._send_to_queue(queue, message, dead)
        self._cleanup_dead(dead)

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


async def broadcast_event(event_type: str, payload: Dict[str, Any], source_id: str | None = None) -> None:
    msg: Dict[str, Any] = {"type": event_type, "payload": payload}
    if source_id:
        msg["source_id"] = source_id
    await broadcaster.publish(msg)


async def broadcast_to_user(sub: str, event_type: str, payload: Dict[str, Any], source_id: str | None = None) -> None:
    msg: Dict[str, Any] = {"type": event_type, "payload": payload}
    if source_id:
        msg["source_id"] = source_id
    await broadcaster.publish_to_user(sub, msg)
