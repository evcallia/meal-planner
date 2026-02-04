import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.auth import get_current_user
from app.realtime import broadcaster, shutdown_event

router = APIRouter(prefix="/api/stream", tags=["realtime"])


@router.get("")
async def stream_events(
    request: Request,
    user: dict = Depends(get_current_user),
):
    queue = broadcaster.subscribe()

    async def event_generator():
        shutdown_task: asyncio.Task[bool] | None = None
        try:
            yield 'data: {"type":"ready","payload":{}}\n\n'
            shutdown_task = asyncio.create_task(shutdown_event.wait())
            while True:
                if await request.is_disconnected():
                    break
                try:
                    queue_task = asyncio.create_task(queue.get())
                    done, pending = await asyncio.wait(
                        {queue_task, shutdown_task},
                        timeout=15,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if shutdown_task in done:
                        break
                    if queue_task in done:
                        message = queue_task.result()
                        if message is None:
                            break
                        yield message
                    else:
                        queue_task.cancel()
                        yield ": ping\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            if shutdown_task:
                shutdown_task.cancel()
            broadcaster.unsubscribe(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
