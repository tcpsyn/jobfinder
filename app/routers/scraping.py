import asyncio
import json
import logging
import time as _time

from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.database import Database

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


@router.get("/health")
async def health(request: Request):
    db: Database = request.app.state.db

    db_ok = False
    try:
        cursor = await db.db.execute("SELECT 1")
        await cursor.fetchone()
        db_ok = True
    except Exception:
        pass

    scheduler = getattr(request.app.state, "scheduler", None)
    if scheduler is not None:
        scheduler_state = "running" if scheduler.running else "stopped"
    else:
        scheduler_state = "not_configured"

    last_scrape = None
    try:
        schedules = await db.get_all_scraper_schedules()
        times = [s["last_scraped_at"] for s in schedules if s.get("last_scraped_at")]
        if times:
            last_scrape = max(times)
    except Exception:
        pass

    ai_client = getattr(request.app.state, "ai_client", None)

    ai_status = "not_configured"
    ai_detail = ""
    if ai_client:
        from app.ai_client import check_ai_reachable
        reachable, ai_detail = await check_ai_reachable(ai_client)
        ai_status = "ok" if reachable else "unreachable"

    start = getattr(request.app.state, "start_time", None)
    uptime_seconds = round(_time.monotonic() - start, 1) if start else None

    body = {
        "status": "healthy" if db_ok else "unhealthy",
        "db": "ok" if db_ok else "error",
        "scheduler": scheduler_state,
        "last_scrape": last_scrape,
        "ai_provider": ai_client.provider if ai_client else None,
        "ai_configured": ai_client is not None,
        "ai_status": ai_status,
        "ai_detail": ai_detail if ai_status != "ok" else "",
        "uptime_seconds": uptime_seconds,
    }

    if not db_ok:
        return Response(
            content=json.dumps(body),
            media_type="application/json",
            status_code=503,
        )
    return body


@router.post("/scrape")
async def trigger_scrape(request: Request):
    app = request.app

    async def _scrape_and_score():
        async with app.state.scrape_lock:
            try:
                from app.scrapers import ALL_SCRAPERS
                from app.scheduler import run_scrape_cycle, run_enrichment_cycle
                from app.ai_client import check_ai_reachable

                db = app.state.db
                config = await db.get_search_config()
                terms = config["search_terms"] if config else []
                keys = await db.get_scraper_keys()
                scrapers = [s(search_terms=terms, scraper_keys=keys) for s in ALL_SCRAPERS]
                app.state.scrape_progress = {"completed": 0, "total": len(scrapers), "current": None, "new_jobs": 0, "active": True}
                await run_scrape_cycle(db, scrapers, search_terms=terms, progress=app.state.scrape_progress, scraper_keys=keys)

                await run_enrichment_cycle(db)

                ai_client = getattr(app.state, "ai_client", None)
                if ai_client:
                    reachable, detail = await check_ai_reachable(ai_client)
                    if reachable:
                        await app.state.score_unscored(db)
                    else:
                        logger.warning(f"Skipping scoring: {detail}")
                        if app.state.scrape_progress:
                            app.state.scrape_progress["scoring_skipped"] = detail
                else:
                    logger.warning("Skipping scoring: no AI provider configured")
                    if app.state.scrape_progress:
                        app.state.scrape_progress["scoring_skipped"] = "No AI provider configured"
            except Exception:
                logger.exception("Background scrape+score failed")
                if app.state.scrape_progress:
                    app.state.scrape_progress["active"] = False

    async def _scrape_with_timeout():
        try:
            await asyncio.wait_for(_scrape_and_score(), timeout=1800)
        except asyncio.TimeoutError:
            logger.error("Background scrape+score timed out after 30 minutes")
            if app.state.scrape_progress:
                app.state.scrape_progress["active"] = False

    asyncio.create_task(_scrape_with_timeout())
    return {"status": "triggered"}


@router.get("/scrape/progress")
async def scrape_progress(request: Request):
    progress = request.app.state.scrape_progress
    if not progress:
        return {"active": False, "completed": 0, "total": 0, "current": None, "new_jobs": 0}
    return progress


@router.post("/jobs/enrich")
async def enrich_jobs(request: Request):
    from app.scheduler import run_enrichment_cycle
    enriched = await run_enrichment_cycle(request.app.state.db, limit=50)
    return {"enriched": enriched}


@router.post("/score")
async def trigger_score(request: Request):
    app = request.app

    async def _run_scoring():
        try:
            await app.state.score_unscored(app.state.db)
        except Exception:
            logger.exception("Background scoring failed")

    asyncio.create_task(_run_scoring())
    return {"status": "scoring_triggered"}


@router.get("/score/progress")
async def score_progress(request: Request):
    progress = request.app.state.scoring_progress
    if not progress:
        return {"active": False, "scored": 0, "total": 0}
    return progress


@router.post("/clear-jobs")
async def clear_jobs(request: Request):
    await request.app.state.db.clear_jobs()
    return {"ok": True, "message": "All jobs, scores, and applications cleared"}


@router.post("/clear-all")
async def clear_all(request: Request):
    await request.app.state.db.clear_all()
    request.app.state.matcher = None
    request.app.state.tailor = None
    return {"ok": True, "message": "All data cleared"}
