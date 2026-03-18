import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


@router.post("/queue/add")
async def add_to_queue(request: Request):
    body = await request.json()
    job_id = body.get("job_id")
    if not job_id:
        raise HTTPException(400, "job_id is required")
    db = request.app.state.db
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    queue_id = await db.add_to_queue(
        job_id=job_id, resume_id=body.get("resume_id"), priority=body.get("priority", 0),
    )
    return {"ok": True, "queue_id": queue_id}


@router.get("/queue")
async def get_queue(request: Request, status: str | None = Query(None)):
    items = await request.app.state.db.get_queue(status=status)
    return {"queue": items}


@router.post("/queue/prepare-all")
async def prepare_all_queued(request: Request):
    tailor = request.app.state.tailor
    if not tailor:
        if not getattr(request.app.state, "ai_client", None):
            raise HTTPException(503, "No AI provider configured. Go to Settings → AI to set one up.")
        raise HTTPException(503, "No resume uploaded. Go to Settings → Resume to upload one.")
    db = request.app.state.db
    queued = await db.get_queue(status="queued")
    prepared = 0
    failed = 0
    for item in queued:
        await db.update_queue_status(item["id"], "preparing")
        try:
            job = await db.get_job(item["job_id"])
            score = await db.get_score(item["job_id"])
            reasons = score["match_reasons"] if score else []
            keywords = score["suggested_keywords"] if score else []
            resume_override = None
            if item.get("resume_id"):
                resume = await db.get_resume(item["resume_id"])
                if resume:
                    resume_override = resume["resume_text"]
            result = await tailor.prepare(
                job_description=job["description"] or "",
                match_reasons=reasons, suggested_keywords=keywords,
                resume_text=resume_override,
            )
            application = await db.get_application(item["job_id"])
            if not application:
                app_id = await db.insert_application(item["job_id"], "prepared")
            else:
                app_id = application["id"]
            await db.update_application(
                app_id, status="prepared",
                tailored_resume=result.get("tailored_resume", ""),
                cover_letter=result.get("cover_letter", ""),
            )
            await db.update_queue_status(item["id"], "ready")
            prepared += 1
        except Exception as e:
            logger.error(f"Queue prepare failed for job {item['job_id']}: {e}")
            await db.update_queue_status(item["id"], "failed")
            failed += 1
    return {"ok": True, "prepared": prepared, "failed": failed, "total": len(queued)}


@router.post("/queue/{queue_id}/submit-for-review")
async def submit_queue_for_review(request: Request, queue_id: int):
    db = request.app.state.db
    item = await db.get_queue_item(queue_id)
    if not item:
        raise HTTPException(404, "Queue item not found")
    await db.update_queue_status(queue_id, "review")
    return {"ok": True}


@router.post("/queue/{queue_id}/approve")
async def approve_queue_item(request: Request, queue_id: int):
    db = request.app.state.db
    item = await db.get_queue_item(queue_id)
    if not item:
        raise HTTPException(404, "Queue item not found")
    await db.update_queue_status(queue_id, "approved")
    await db.add_event(item["job_id"], "queue_approved", "Approved from queue")
    return {"ok": True}


@router.post("/queue/{queue_id}/reject")
async def reject_queue_item(request: Request, queue_id: int):
    db = request.app.state.db
    item = await db.get_queue_item(queue_id)
    if not item:
        raise HTTPException(404, "Queue item not found")
    await db.update_queue_status(queue_id, "rejected")
    await db.add_event(item["job_id"], "queue_rejected", "Rejected from queue")
    return {"ok": True}


@router.post("/queue/{queue_id}/fill-status")
async def update_fill_status(request: Request, queue_id: int):
    db = request.app.state.db
    item = await db.get_queue_item(queue_id)
    if not item:
        raise HTTPException(404, "Queue item not found")
    body = await request.json()
    status = body.get("status", "filling")
    progress = body.get("progress")
    await db.update_queue_fill_status(queue_id, status, progress)
    for queue in list(request.app.state.queue_subscribers):
        try:
            queue.put_nowait({
                "queue_id": queue_id, "job_id": item["job_id"],
                "status": status, "progress": progress,
            })
        except asyncio.QueueFull:
            pass
    if status == "submitted":
        await db.upsert_application(item["job_id"], "applied")
        await db.add_event(item["job_id"], "auto_applied", "Submitted via queue")
    return {"ok": True}


@router.post("/queue/approve-all")
async def approve_all_queue(request: Request):
    count = await request.app.state.db.bulk_update_queue_status("review", "approved")
    return {"ok": True, "approved": count}


@router.post("/queue/reject-all")
async def reject_all_queue(request: Request):
    count = await request.app.state.db.bulk_update_queue_status("review", "rejected")
    return {"ok": True, "rejected": count}


@router.get("/queue/events")
async def queue_events(request: Request):
    queue = asyncio.Queue(maxsize=50)
    request.app.state.queue_subscribers.append(queue)

    async def event_generator():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            if queue in request.app.state.queue_subscribers:
                request.app.state.queue_subscribers.remove(queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.delete("/queue/{queue_id}")
async def remove_queue_item(request: Request, queue_id: int):
    removed = await request.app.state.db.remove_from_queue(queue_id)
    if not removed:
        raise HTTPException(404, "Queue item not found")
    return {"ok": True}
