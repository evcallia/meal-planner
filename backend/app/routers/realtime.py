import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.auth import get_current_user
from app.realtime import broadcaster

router = APIRouter(prefix="/api/stream", tags=["realtime"])


@router.get("")
async def stream_events(
    request: Request,
    user: dict = Depends(get_current_user),
):
    queue = broadcaster.subscribe()

    async def event_generator():
        try:
            yield 'data: {"type":"ready","payload":{}}\n\n'
            while True:
                if await request.is_disconnected():
                    break
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=15)
                    yield message
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            broadcaster.unsubscribe(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
