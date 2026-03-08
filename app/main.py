import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request, UploadFile, File
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

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
        if provider == "anthropic" and api_key:
            return AIClient(provider, api_key=api_key, model=model)
    if env_key:
        return AIClient("anthropic", api_key=env_key)
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    db_path = app.state.db_path
    testing = getattr(app.state, "testing", False)
    os.makedirs(os.path.dirname(db_path) or "data", exist_ok=True)
    app.state.db = Database(db_path)
    await app.state.db.init()

    if not testing:
        from app.config import Settings
        from app.scrapers import ALL_SCRAPERS
        from app.scheduler import run_scrape_cycle

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

        from apscheduler.schedulers.asyncio import AsyncIOScheduler

        scheduler = AsyncIOScheduler()

        async def scheduled_scrape():
            db = app.state.db
            config = await db.get_search_config()
            terms = config["search_terms"] if config else []
            scrapers = [s(search_terms=terms) for s in ALL_SCRAPERS]
            await run_scrape_cycle(db, scrapers, search_terms=terms)
            await _score_unscored(db)

        scheduler.add_job(
            scheduled_scrape, "interval",
            hours=settings.scrape_interval_hours,
            id="scrape_cycle",
        )
        scheduler.start()
        app.state.scheduler = scheduler
    else:
        app.state.matcher = None
        app.state.tailor = None
        app.state.ai_client = None
        app.state.scheduler = None

    yield

    if getattr(app.state, "scheduler", None):
        app.state.scheduler.shutdown(wait=False)
    await app.state.db.close()


def create_app(db_path: str = "data/jobfinder.db", testing: bool = False) -> FastAPI:
    app = FastAPI(title="JobFinder", lifespan=lifespan)
    app.state.db_path = db_path
    app.state.testing = testing

    async def _score_unscored(db):
        matcher = app.state.matcher
        if not matcher:
            logger.warning("Matcher not available, skipping scoring")
            return
        while True:
            unscored = await db.get_unscored_jobs(limit=20)
            if not unscored:
                break
            logger.info(f"Scoring {len(unscored)} unscored jobs...")
            results = await matcher.batch_score(unscored, delay=1.0)
            for r in results:
                await db.insert_score(
                    r["job_id"], r["score"], r["reasons"],
                    r["concerns"], r["keywords"],
                )
            logger.info(f"Scored {len(results)} jobs")

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

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    @app.get("/api/jobs")
    async def list_jobs(
        sort: str = Query("score"),
        limit: int = Query(50),
        offset: int = Query(0),
        min_score: int | None = Query(None),
        search: str | None = Query(None),
        source: str | None = Query(None),
        work_type: str | None = Query(None),
        employment_type: str | None = Query(None),
        location: str | None = Query(None),
    ):
        jobs = await app.state.db.list_jobs(
            sort_by=sort, limit=limit, offset=offset,
            min_score=min_score, search=search, source=source,
            work_type=work_type, employment_type=employment_type,
            location=location,
        )
        return {"jobs": jobs}

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: int):
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        score = await app.state.db.get_score(job_id)
        sources = await app.state.db.get_sources(job_id)
        application = await app.state.db.get_application(job_id)
        return {**job, "score": score, "sources": sources, "application": application}

    @app.post("/api/jobs/{job_id}/dismiss")
    async def dismiss_job(job_id: int):
        await app.state.db.dismiss_job(job_id)
        return {"ok": True}

    @app.post("/api/jobs/{job_id}/prepare")
    async def prepare_application(job_id: int):
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")

        tailor = app.state.tailor
        if not tailor:
            raise HTTPException(503, "Tailor not available (no AI provider configured or no resume)")

        score = await app.state.db.get_score(job_id)
        match_reasons = score["match_reasons"] if score else []
        suggested_keywords = score["suggested_keywords"] if score else []

        result = await tailor.prepare(
            job_description=job["description"] or "",
            match_reasons=match_reasons,
            suggested_keywords=suggested_keywords,
        )

        application = await app.state.db.get_application(job_id)
        if not application:
            app_id = await app.state.db.insert_application(job_id, "prepared")
        else:
            app_id = application["id"]

        await app.state.db.update_application(
            app_id,
            status="prepared",
            tailored_resume=result.get("tailored_resume", ""),
            cover_letter=result.get("cover_letter", ""),
        )

        return {
            "job_id": job_id,
            "status": "prepared",
            "tailored_resume": result.get("tailored_resume", ""),
            "cover_letter": result.get("cover_letter", ""),
        }

    @app.post("/api/jobs/{job_id}/email")
    async def draft_email(job_id: int):
        from app.emailer import draft_application_email

        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")

        application = await app.state.db.get_application(job_id)
        cover_letter = application.get("cover_letter", "") if application else ""
        if not cover_letter:
            raise HTTPException(400, "No cover letter prepared for this job")

        email = draft_application_email(
            to=job.get("contact_email"),
            company=job["company"],
            position=job["title"],
            cover_letter=cover_letter,
            sender_name="Job Seeker",
            sender_email="",
        )

        if not email:
            raise HTTPException(400, "No contact email available for this job")

        if application:
            await app.state.db.update_application(
                application["id"],
                email_draft=json.dumps(email),
            )

        return {"job_id": job_id, "email": email}

    @app.post("/api/jobs/{job_id}/application")
    async def update_application(job_id: int, status: str = Query(...), notes: str = Query("")):
        app_row = await app.state.db.get_application(job_id)
        if not app_row:
            await app.state.db.insert_application(job_id, status)
        else:
            await app.state.db.update_application(app_row["id"], status=status, notes=notes)
        return {"ok": True}

    @app.get("/api/stats")
    async def get_stats():
        return await app.state.db.get_stats()

    @app.post("/api/scrape")
    async def trigger_scrape():
        async def _scrape_and_score():
            try:
                from app.scrapers import ALL_SCRAPERS
                from app.scheduler import run_scrape_cycle

                db = app.state.db
                config = await db.get_search_config()
                terms = config["search_terms"] if config else []
                scrapers = [s(search_terms=terms) for s in ALL_SCRAPERS]
                await run_scrape_cycle(db, scrapers, search_terms=terms)

                await _score_unscored(db)
            except Exception:
                logger.exception("Background scrape+score failed")

        asyncio.create_task(_scrape_and_score())
        return {"status": "triggered"}

    @app.post("/api/score")
    async def trigger_score():
        async def _run_scoring():
            try:
                await _score_unscored(app.state.db)
            except Exception:
                logger.exception("Background scoring failed")

        asyncio.create_task(_run_scoring())
        return {"status": "scoring_triggered"}

    @app.get("/api/search-config")
    async def get_search_config():
        config = await app.state.db.get_search_config()
        if not config:
            return {"resume_text": "", "search_terms": [], "job_titles": [],
                    "key_skills": [], "seniority": "", "summary": "",
                    "ats_score": 0, "ats_issues": [], "ats_tips": [],
                    "updated_at": None}
        return config

    @app.post("/api/search-config/terms")
    async def update_search_terms(request: Request):
        body = await request.json()
        terms = body.get("search_terms", [])
        if not isinstance(terms, list):
            raise HTTPException(400, "search_terms must be a list")
        await app.state.db.update_search_terms(terms)
        return {"ok": True, "search_terms": terms}

    @app.get("/api/ai-settings")
    async def get_ai_settings():
        settings = await app.state.db.get_ai_settings()
        if not settings:
            env_key = getattr(getattr(app.state, "settings", None), "anthropic_api_key", "") or ""
            return {
                "provider": "anthropic" if env_key else "",
                "api_key": _mask_key(env_key),
                "model": "",
                "base_url": "",
                "has_key": bool(env_key),
                "updated_at": None,
            }
        return {
            "provider": settings["provider"],
            "api_key": _mask_key(settings["api_key"]),
            "model": settings["model"],
            "base_url": settings["base_url"],
            "has_key": bool(settings["api_key"]),
            "updated_at": settings["updated_at"],
        }

    @app.post("/api/ai-settings")
    async def update_ai_settings(request: Request):
        body = await request.json()
        provider = body.get("provider", "anthropic")
        api_key = body.get("api_key", "")
        model = body.get("model", "")
        base_url = body.get("base_url", "")

        if provider not in ("anthropic", "ollama"):
            raise HTTPException(400, "Provider must be 'anthropic' or 'ollama'")

        # If api_key is masked (starts with ****), keep existing key
        if api_key.startswith("****"):
            existing = await app.state.db.get_ai_settings()
            if existing:
                api_key = existing["api_key"]
            else:
                env_key = getattr(getattr(app.state, "settings", None), "anthropic_api_key", "") or ""
                api_key = env_key

        await app.state.db.save_ai_settings(provider, api_key, model, base_url)

        # Re-initialize AI services
        client = _build_ai_client({"provider": provider, "api_key": api_key,
                                    "model": model, "base_url": base_url})
        config = await app.state.db.get_search_config()
        resume_text = config.get("resume_text", "") if config else ""
        _reinit_ai_services(client, resume_text)

        return {"ok": True, "provider": provider, "model": model}

    @app.get("/api/ai-settings/models")
    async def list_ollama_models(base_url: str = Query("http://localhost:11434")):
        """Fetch available models from an Ollama instance."""
        import httpx
        from app.ai_client import _resolve_ollama_url
        url = f"{_resolve_ollama_url(base_url).rstrip('/')}/api/tags"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url)
                resp.raise_for_status()
                data = resp.json()
                models = [m["name"] for m in data.get("models", [])]
                return {"ok": True, "models": models}
        except Exception as e:
            return {"ok": False, "models": [], "error": str(e)}

    @app.post("/api/ai-settings/test")
    async def test_ai_connection(request: Request):
        body = await request.json()
        provider = body.get("provider", "anthropic")
        api_key = body.get("api_key", "")
        model = body.get("model", "")
        base_url = body.get("base_url", "")

        if api_key.startswith("****"):
            existing = await app.state.db.get_ai_settings()
            if existing:
                api_key = existing["api_key"]
            else:
                env_key = getattr(getattr(app.state, "settings", None), "anthropic_api_key", "") or ""
                api_key = env_key

        try:
            client = AIClient(provider, api_key=api_key, model=model, base_url=base_url)
            response = await client.chat("Reply with exactly: OK", max_tokens=10)
            return {"ok": True, "response": response.strip()[:50]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    @app.post("/api/resume/upload")
    async def upload_resume(file: UploadFile = File(...)):
        content = await file.read()
        filename = (file.filename or "").lower()

        if filename.endswith(".pdf"):
            import fitz
            doc = fitz.open(stream=content, filetype="pdf")
            resume_text = "\n".join(page.get_text() for page in doc)
            doc.close()
        else:
            resume_text = content.decode("utf-8", errors="replace")

        client = getattr(app.state, "ai_client", None)
        if not client and not getattr(app.state, "testing", False):
            ai_settings = await app.state.db.get_ai_settings()
            env_key = getattr(getattr(app.state, "settings", None), "anthropic_api_key", "") or ""
            client = _build_ai_client(ai_settings, env_key)

        analysis = {"search_terms": [], "job_titles": [], "key_skills": [],
                    "seniority": "", "summary": "", "ats_score": 0, "ats_issues": [], "ats_tips": []}
        logger.info(f"Resume upload: {len(resume_text)} chars, client={'yes' if client else 'no'}")
        if client:
            from app.resume_analyzer import analyze_resume
            analysis = await analyze_resume(client, resume_text)
            logger.info(f"Analysis result: ats_score={analysis.get('ats_score')}, terms={len(analysis.get('search_terms', []))}")

            _reinit_ai_services(client, resume_text)

        await app.state.db.save_search_config(
            resume_text,
            analysis["search_terms"],
            job_titles=analysis["job_titles"],
            key_skills=analysis["key_skills"],
            seniority=analysis.get("seniority", ""),
            summary=analysis.get("summary", ""),
            ats_score=analysis.get("ats_score", 0),
            ats_issues=analysis.get("ats_issues", []),
            ats_tips=analysis.get("ats_tips", []),
        )

        return {
            "ok": True,
            "search_terms": analysis["search_terms"],
            "job_titles": analysis["job_titles"],
            "key_skills": analysis["key_skills"],
            "seniority": analysis.get("seniority", ""),
            "summary": analysis.get("summary", ""),
            "ats_score": analysis.get("ats_score", 0),
            "ats_issues": analysis.get("ats_issues", []),
            "ats_tips": analysis.get("ats_tips", []),
            "resume_length": len(resume_text),
        }

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
