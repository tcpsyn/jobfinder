import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import time as _time
from datetime import datetime, timezone

from app.database import Database
from app.ai_client import AIClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _build_ai_client(ai_settings: dict | None, env_key: str = "") -> AIClient | None:
    """Build an AIClient from DB settings or env fallback."""
    if ai_settings and ai_settings.get("provider"):
        provider = ai_settings["provider"]
        api_key = ai_settings.get("api_key", "")
        model = ai_settings.get("model", "")
        base_url = ai_settings.get("base_url", "")
        if provider == "ollama":
            return AIClient(provider, model=model, base_url=base_url)
        if api_key:
            return AIClient(provider, api_key=api_key, model=model, base_url=base_url)
    if env_key:
        return AIClient("anthropic", api_key=env_key)
    return None


async def _init_embedding_client(db):
    """Build an EmbeddingClient from saved DB settings, or None."""
    settings = await db.get_embedding_settings()
    if not settings or not settings.get("provider"):
        return None
    from app.embeddings import EmbeddingClient
    provider = settings["provider"]
    api_key = settings.get("api_key", "")
    model = settings.get("model", "")
    base_url = settings.get("base_url", "")
    dimensions = settings.get("dimensions", 256)
    if provider != "ollama" and not api_key:
        return None
    return EmbeddingClient(provider=provider, api_key=api_key, model=model,
                           base_url=base_url, dimensions=dimensions)


async def lifespan(app: FastAPI):
    db_path = app.state.db_path
    testing = getattr(app.state, "testing", False)
    os.makedirs(os.path.dirname(db_path) or "data", exist_ok=True)
    app.state.db = Database(db_path)
    await app.state.db.init()
    await app.state.db.migrate_resume_from_search_config()

    if not testing:
        from app.config import Settings
        from app.scrapers import ALL_SCRAPERS
        from app.scheduler import run_scrape_cycle, run_enrichment_cycle, run_maintenance_cycle, run_reminder_check, run_digest_cycle, run_alert_check, run_job_embedding_cycle, run_context_embedding_cycle

        settings = Settings()

        resume_text = ""
        if os.path.exists(settings.resume_path):
            with open(settings.resume_path) as f:
                resume_text = f.read()

        if not resume_text:
            config = await app.state.db.get_search_config()
            if config and config.get("resume_text"):
                resume_text = config["resume_text"]

        ai_settings = await app.state.db.get_ai_settings()
        client = _build_ai_client(ai_settings, settings.anthropic_api_key)

        logger.info(f"Lifespan: client={'yes' if client else 'no'}, resume={len(resume_text)} chars")
        if client and resume_text:
            from app.matcher import JobMatcher
            from app.tailoring import Tailor
            app.state.matcher = JobMatcher(client, resume_text)
            app.state.tailor = Tailor(client, resume_text)
            logger.info("Matcher and Tailor initialized")
        else:
            app.state.matcher = None
            app.state.tailor = None
            logger.warning("Matcher NOT initialized - client=%s, resume=%d chars",
                           bool(client), len(resume_text))

        app.state.ai_client = client
        app.state.settings = settings

        app.state.embedding_client = await _init_embedding_client(app.state.db)

        from apscheduler.schedulers.asyncio import AsyncIOScheduler

        scheduler = AsyncIOScheduler()

        async def scheduled_scrape():
            try:
                db = app.state.db
                config = await db.get_search_config()
                terms = config["search_terms"] if config else []
                keys = await db.get_scraper_keys()
                scrapers = [s(search_terms=terms, scraper_keys=keys) for s in ALL_SCRAPERS]
                await run_scrape_cycle(db, scrapers, search_terms=terms, scraper_keys=keys)
            except Exception:
                logger.exception("Scheduled scrape failed")

        async def scheduled_enrichment():
            try:
                await run_enrichment_cycle(app.state.db)
            except Exception:
                logger.exception("Scheduled enrichment failed")

        async def scheduled_scoring():
            try:
                await app.state.score_unscored(app.state.db)
            except Exception:
                logger.exception("Scheduled scoring failed")

        async def scheduled_maintenance():
            try:
                await run_maintenance_cycle(app.state.db)
            except Exception:
                logger.exception("Scheduled maintenance failed")

        async def scheduled_reminder_check():
            try:
                due = await run_reminder_check(app.state.db, embedding_client=app.state.embedding_client)
                for r in due:
                    await app.state.db.add_event(
                        r["job_id"], "reminder_due",
                        f"Follow-up reminder due for {r.get('company', 'unknown')}"
                    )
            except Exception:
                logger.exception("Scheduled reminder check failed")

        async def scheduled_digest():
            try:
                await run_digest_cycle(app.state.db)
            except Exception:
                logger.exception("Scheduled digest failed")

        async def scheduled_alert_check():
            try:
                await run_alert_check(app.state.db)
            except Exception:
                logger.exception("Scheduled alert check failed")

        async def scheduled_embedding():
            try:
                await run_job_embedding_cycle(app.state.db, app.state.embedding_client)
                await run_context_embedding_cycle(app.state.db, app.state.embedding_client)
            except Exception:
                logger.exception("Scheduled embedding failed")

        scheduler.add_job(
            scheduled_scrape, "interval",
            hours=settings.scrape_interval_hours,
            id="scrape_cycle",
        )
        scheduler.add_job(
            scheduled_enrichment, "interval",
            hours=2,
            id="enrichment_cycle",
        )
        scheduler.add_job(
            scheduled_scoring, "interval",
            hours=1,
            id="scoring_cycle",
        )
        scheduler.add_job(
            scheduled_maintenance, "interval",
            hours=24,
            id="maintenance_cycle",
        )
        scheduler.add_job(
            scheduled_reminder_check, "interval",
            hours=12,
            id="reminder_check",
        )
        scheduler.add_job(
            scheduled_digest, "cron",
            hour=8,
            id="digest_cycle",
        )
        scheduler.add_job(
            scheduled_alert_check, "interval",
            hours=1,
            id="alert_check",
        )
        scheduler.add_job(
            scheduled_embedding, "interval",
            hours=2,
            id="embedding_cycle",
        )
        scheduler.start()
        app.state.scheduler = scheduler
    else:
        app.state.matcher = None
        app.state.tailor = None
        app.state.ai_client = None
        app.state.embedding_client = None
        app.state.scheduler = None

    app.state.start_time = _time.monotonic()

    yield

    if getattr(app.state, "scheduler", None):
        app.state.scheduler.shutdown(wait=False)
    from app.browser_pool import shutdown_browser_pool
    await shutdown_browser_pool()
    await app.state.db.close()


def create_app(db_path: str = "data/jobfinder.db", testing: bool = False) -> FastAPI:
    app = FastAPI(title="CareerPulse", lifespan=lifespan)
    app.state.db_path = db_path
    app.state.testing = testing

    app.state.scoring_progress = None
    app.state.scrape_progress = None
    app.state.scoring_lock = asyncio.Lock()
    app.state.scrape_lock = asyncio.Lock()
    app.state.notification_subscribers: list[asyncio.Queue] = []
    app.state.notification_lock = asyncio.Lock()
    app.state.queue_subscribers: list[asyncio.Queue] = []
    app.state.alert_threshold = 80

    # --- Shared helpers attached to app.state for router access ---

    async def _broadcast_notification(notification: dict):
        async with app.state.notification_lock:
            for queue in list(app.state.notification_subscribers):
                try:
                    queue.put_nowait(notification)
                except asyncio.QueueFull:
                    pass

    async def _check_high_score_alerts(db, job_id: int, score: int, job_title: str, company: str):
        if score >= app.state.alert_threshold:
            title = f"High score: {job_title}"
            message = f"{company} — Score {score}"
            notif_id = await db.insert_notification(job_id, "high_score", title, message)
            notif = {"id": notif_id, "job_id": job_id, "type": "high_score", "title": title, "message": message, "read": 0}
            await _broadcast_notification(notif)

    async def _score_unscored(db):
        async with app.state.scoring_lock:
            matcher = app.state.matcher
            if not matcher:
                logger.warning("Matcher not available, skipping scoring")
                return
            all_unscored = await db.get_unscored_jobs(limit=10000)
            total = len(all_unscored)
            if total == 0:
                return
            app.state.scoring_progress = {"scored": 0, "total": total, "active": True}
            scored = 0
            batch_size = 5
            try:
                for i in range(0, total, batch_size):
                    batch = all_unscored[i:i + batch_size]
                    results = await matcher.score_batch(batch)
                    for r in results:
                        await db.insert_score(
                            r["job_id"], r["score"], r["reasons"],
                            r["concerns"], r["keywords"],
                        )
                        job = await db.get_job(r["job_id"])
                        if job:
                            await _check_high_score_alerts(db, r["job_id"], r["score"], job["title"], job["company"])
                    scored += len(results)
                    app.state.scoring_progress = {"scored": scored, "total": total, "active": True}
                    logger.info(f"Scored {scored}/{total} jobs")
            finally:
                app.state.scoring_progress = {"scored": scored, "total": total, "active": False}
                logger.info(f"Scoring complete: {scored}/{total} jobs")

    def _reinit_ai_services(client: AIClient | None, resume_text: str = ""):
        """Re-initialize matcher and tailor with new AI client."""
        app.state.ai_client = client
        if client and resume_text:
            from app.matcher import JobMatcher
            from app.tailoring import Tailor
            app.state.matcher = JobMatcher(client, resume_text)
            app.state.tailor = Tailor(client, resume_text)
        else:
            app.state.matcher = None
            app.state.tailor = None

    async def _save_parsed_profile(db, profile_data: dict):
        """Save AI-parsed resume data into profile tables, merging with existing."""
        try:
            personal = profile_data.get("personal", {})
            if personal:
                clean = {k: v for k, v in personal.items() if v is not None}
                if clean:
                    existing = await db.get_user_profile() or {}
                    merged = {}
                    for k, v in clean.items():
                        existing_val = existing.get(k)
                        if not existing_val or existing_val == "":
                            merged[k] = v
                    if "first_name" in clean and "last_name" in clean:
                        if not existing.get("full_name"):
                            merged["full_name"] = f"{clean['first_name']} {clean['last_name']}"
                    if merged:
                        await db.save_user_profile(**merged)

            for key, endpoint in [
                ("work_history", "save_work_history"),
                ("education", "save_education"),
                ("certifications", "save_certification"),
                ("skills", "save_skill"),
                ("languages", "save_language"),
            ]:
                items = profile_data.get(key, [])
                if not items:
                    continue
                full = await db.get_full_profile()
                existing_items = full.get(key, [])
                if existing_items:
                    continue
                save_fn = getattr(db, endpoint)
                for item in items:
                    clean_item = {k: v for k, v in item.items() if v is not None}
                    if clean_item:
                        await save_fn(clean_item)

            logger.info("Parsed profile data saved from resume")
        except Exception as e:
            logger.error(f"Failed to save parsed profile: {e}")

    # Expose shared helpers on app.state for routers and lifespan
    app.state.score_unscored = _score_unscored
    app.state.reinit_ai_services = _reinit_ai_services
    app.state.save_parsed_profile = _save_parsed_profile

    # --- Register routers ---
    from app.routers import jobs, tailoring, pipeline, queue, contacts, analytics, settings, alerts, scraping, autofill
    app.include_router(jobs.router)
    app.include_router(tailoring.router)
    app.include_router(pipeline.router)
    app.include_router(queue.router)
    app.include_router(contacts.router)
    app.include_router(analytics.router)
    app.include_router(settings.router)
    app.include_router(alerts.router)
    app.include_router(scraping.router)
    app.include_router(autofill.router)

    # --- Static files ---
    if not testing:
        static_dir = os.path.join(os.path.dirname(__file__), "static")
        if os.path.exists(static_dir):
            app.mount("/static", StaticFiles(directory=static_dir), name="static")

            @app.get("/")
            async def index():
                return FileResponse(os.path.join(static_dir, "index.html"))

    return app


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "****"
    return f"****{key[-4:]}"
