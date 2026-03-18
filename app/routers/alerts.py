import asyncio
import json

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/api")


@router.get("/alerts")
async def list_alerts(request: Request):
    alerts = await request.app.state.db.get_job_alerts()
    return {"alerts": alerts}


@router.post("/alerts")
async def create_alert(request: Request):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "Alert name is required")
    db = request.app.state.db
    alert_id = await db.create_job_alert(
        name=name,
        filters=body.get("filters", {}),
        min_score=body.get("min_score", 0),
        notify_method=body.get("notify_method", "in_app"),
    )
    alert = await db.get_job_alert(alert_id)
    return {"ok": True, "alert": alert}


@router.put("/alerts/{alert_id}")
async def update_alert(request: Request, alert_id: int):
    body = await request.json()
    fields = {}
    for key in ("name", "filters", "min_score", "enabled", "notify_method"):
        if key in body:
            fields[key] = body[key]
    if not fields:
        raise HTTPException(400, "No fields to update")
    updated = await request.app.state.db.update_job_alert(alert_id, **fields)
    if not updated:
        raise HTTPException(404, "Alert not found")
    alert = await request.app.state.db.get_job_alert(alert_id)
    return {"ok": True, "alert": alert}


@router.delete("/alerts/{alert_id}")
async def delete_alert(request: Request, alert_id: int):
    deleted = await request.app.state.db.delete_job_alert(alert_id)
    if not deleted:
        raise HTTPException(404, "Alert not found")
    return {"ok": True}


# --- Notifications ---

@router.get("/notifications")
async def get_notifications(request: Request, unread: bool = Query(False)):
    db = request.app.state.db
    notifications = await db.get_notifications(unread_only=unread)
    count = await db.get_unread_notification_count()
    return {"notifications": notifications, "unread_count": count}


@router.post("/notifications/{notification_id}/read")
async def mark_notification_read(request: Request, notification_id: int):
    await request.app.state.db.mark_notification_read(notification_id)
    return {"ok": True}


@router.post("/notifications/read-all")
async def mark_all_read(request: Request):
    await request.app.state.db.mark_all_notifications_read()
    return {"ok": True}


@router.get("/notifications/stream")
async def notification_stream(request: Request):
    queue: asyncio.Queue = asyncio.Queue(maxsize=50)
    lock = request.app.state.notification_lock
    async with lock:
        request.app.state.notification_subscribers.append(queue)

    async def event_generator():
        try:
            while True:
                notif = await queue.get()
                yield f"data: {json.dumps(notif)}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            async with lock:
                if queue in request.app.state.notification_subscribers:
                    request.app.state.notification_subscribers.remove(queue)

    return StreamingResponse(
        event_generator(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
