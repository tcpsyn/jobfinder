import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request, UploadFile, File
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

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
            keys = await db.get_scraper_keys()
            scrapers = [s(search_terms=terms, scraper_keys=keys) for s in ALL_SCRAPERS]
            await run_scrape_cycle(db, scrapers, search_terms=terms, scraper_keys=keys)
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
    app = FastAPI(title="CareerPulse", lifespan=lifespan)
    app.state.db_path = db_path
    app.state.testing = testing

    app.state.scoring_progress = None
    app.state.scrape_progress = None

    async def _score_unscored(db):
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
                    # Only fill in empty fields, don't overwrite user edits
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

            # For list tables, only add if table is currently empty
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
                    continue  # Don't overwrite existing data
                save_fn = getattr(db, endpoint)
                for item in items:
                    clean_item = {k: v for k, v in item.items() if v is not None}
                    if clean_item:
                        await save_fn(clean_item)

            logger.info("Parsed profile data saved from resume")
        except Exception as e:
            logger.error(f"Failed to save parsed profile: {e}")

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
        region: str | None = Query(None),
        clearance: str | None = Query(None),
    ):
        config = await app.state.db.get_search_config()
        exclude_terms = config.get("exclude_terms", []) if config else []
        jobs = await app.state.db.list_jobs(
            sort_by=sort, limit=limit, offset=offset,
            min_score=min_score, search=search, source=source,
            work_type=work_type, employment_type=employment_type,
            location=location, exclude_terms=exclude_terms,
            region=region, clearance=clearance,
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
        events = await app.state.db.get_events(job_id)
        similar = await app.state.db.find_similar_jobs(job["title"], job["company"], exclude_id=job_id)
        return {**job, "score": score, "sources": sources, "application": application, "events": events, "similar": similar}

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

        await app.state.db.add_event(job_id, "prepared", "Application prepared")

        return {
            "job_id": job_id,
            "status": "prepared",
            "tailored_resume": result.get("tailored_resume", ""),
            "cover_letter": result.get("cover_letter", ""),
        }

    @app.post("/api/jobs/{job_id}/estimate-salary")
    async def estimate_salary_endpoint(job_id: int):
        from app.salary_estimator import estimate_salary
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        client = getattr(app.state, "ai_client", None)
        if not client:
            raise HTTPException(503, "No AI provider configured")
        # Skip if salary already known from listing
        if job.get("salary_min") and job.get("salary_max"):
            return {"ok": True, "already_known": True,
                    "min": job["salary_min"], "max": job["salary_max"]}
        result = await estimate_salary(client, job)
        if result.get("min") and result["min"] > 0:
            await app.state.db.update_job_contact(job_id,
                salary_estimate_min=result["min"],
                salary_estimate_max=result["max"],
                salary_confidence=result.get("confidence", "low"),
            )
        return {"ok": True, **result}

    @app.post("/api/jobs/{job_id}/find-apply-link")
    async def find_apply_link(job_id: int):
        from app.apply_link_finder import find_apply_url
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        url = await find_apply_url(job["url"])
        if url:
            await app.state.db.update_job_contact(job_id, apply_url=url)
        return {"ok": True, "apply_url": url}

    @app.post("/api/jobs/{job_id}/find-contact")
    async def find_contact(job_id: int):
        from app.contact_finder import find_hiring_contact
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")

        result = await find_hiring_contact(
            job["company"], job["title"], job.get("location", "")
        )

        update = {"contact_lookup_done": 1}
        if result.get("email"):
            update["hiring_manager_email"] = result["email"]
        if result.get("name"):
            update["hiring_manager_name"] = result["name"]
        if result.get("title"):
            update["hiring_manager_title"] = result["title"]

        await app.state.db.update_job_contact(job_id, **update)

        await app.state.db.add_event(job_id, "note",
            f"Contact lookup: {'Found ' + result['email'] if result.get('email') else 'No contact found'}")

        return {"ok": True, "contact": result}

    @app.get("/api/jobs/{job_id}/resume.pdf")
    async def download_resume_pdf(job_id: int):
        from app.pdf_generator import generate_resume_pdf
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        application = await app.state.db.get_application(job_id)
        if not application or not application.get("tailored_resume"):
            raise HTTPException(404, "No tailored resume prepared for this job")
        pdf_bytes = generate_resume_pdf(application["tailored_resume"])
        await app.state.db.add_event(job_id, "pdf_downloaded", "Resume PDF downloaded")
        filename = f"Resume - {job['company']} - {job['title']}.pdf".replace("/", "-")
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.get("/api/jobs/{job_id}/cover-letter.pdf")
    async def download_cover_letter_pdf(job_id: int):
        from app.pdf_generator import generate_cover_letter_pdf
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        application = await app.state.db.get_application(job_id)
        if not application or not application.get("cover_letter"):
            raise HTTPException(404, "No cover letter prepared for this job")
        pdf_bytes = generate_cover_letter_pdf(
            application["cover_letter"],
            company=job.get("company", ""),
            position=job.get("title", ""),
        )
        await app.state.db.add_event(job_id, "pdf_downloaded", "Cover letter PDF downloaded")
        filename = f"Cover Letter - {job['company']} - {job['title']}.pdf".replace("/", "-")
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

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
            to=job.get("hiring_manager_email") or job.get("contact_email"),
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

        await app.state.db.add_event(job_id, "email_drafted", "Email drafted")

        return {"job_id": job_id, "email": email}

    @app.post("/api/jobs/{job_id}/events")
    async def add_event(job_id: int, request: Request):
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        body = await request.json()
        detail = body.get("detail", "")
        if not detail.strip():
            raise HTTPException(400, "Detail is required")
        await app.state.db.add_event(job_id, "note", detail)
        return {"ok": True}

    @app.post("/api/jobs/{job_id}/apply")
    async def apply_to_job(job_id: int):
        db = app.state.db
        job = await db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        apply_url = job.get("apply_url") or job["url"]
        await db.upsert_application(job_id, status="applied")
        await db.add_event(job_id, "applied", "Applied via CareerPulse")
        return {"url": apply_url, "status": "applied"}

    @app.post("/api/jobs/{job_id}/application")
    async def update_application(job_id: int, status: str = Query(...), notes: str = Query("")):
        app_row = await app.state.db.get_application(job_id)
        if not app_row:
            await app.state.db.insert_application(job_id, status)
        else:
            await app.state.db.update_application(app_row["id"], status=status, notes=notes)
        if status == "applied":
            now = datetime.now(timezone.utc).isoformat()
            app_row = await app.state.db.get_application(job_id)
            if app_row and not app_row.get("applied_at"):
                await app.state.db.update_application(app_row["id"], applied_at=now)
        await app.state.db.add_event(job_id, "status_change", f"Status changed to {status}")
        return {"ok": True}

    @app.get("/api/stats")
    async def get_stats():
        return await app.state.db.get_stats()

    @app.get("/api/pipeline")
    async def get_pipeline():
        db = app.state.db
        stats = await db.get_pipeline_stats()
        return {"stats": stats}

    @app.get("/api/pipeline/{status}")
    async def get_pipeline_jobs(status: str):
        db = app.state.db
        jobs = await db.get_pipeline_jobs(status)
        return {"jobs": jobs, "count": len(jobs)}

    @app.get("/api/export/csv")
    async def export_csv(
        min_score: int | None = Query(None),
        status: str | None = Query(None),
    ):
        import csv
        import io

        jobs = await app.state.db.list_jobs(sort_by="score", limit=10000)

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "Title", "Company", "Location", "Score", "Status",
            "Salary Min", "Salary Max", "URL", "Posted Date",
            "Contact Email", "Applied At", "Source"
        ])

        for job in jobs:
            app_row = job.get("app_status", "")
            if status and app_row != status:
                continue
            score = job.get("match_score") or 0
            if min_score and score < min_score:
                continue
            sources = await app.state.db.get_sources(job["id"])
            source_names = ", ".join(s["source_name"] for s in sources)
            application = await app.state.db.get_application(job["id"])
            writer.writerow([
                job["title"], job["company"], job.get("location", ""),
                job.get("match_score", ""), app_row,
                job.get("salary_min", ""), job.get("salary_max", ""),
                job["url"], job.get("posted_date", ""),
                job.get("contact_email", ""),
                application.get("applied_at", "") if application else "",
                source_names,
            ])

        return Response(
            content=output.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": 'attachment; filename="careerpulse-export.csv"'},
        )

    @app.get("/api/digest")
    async def get_digest(
        min_score: int = Query(60),
        hours: int = Query(24),
    ):
        from app.digest import generate_digest
        return await generate_digest(app.state.db, min_score, hours)

    @app.post("/api/clear-jobs")
    async def clear_jobs():
        await app.state.db.clear_jobs()
        return {"ok": True, "message": "All jobs, scores, and applications cleared"}

    @app.post("/api/clear-all")
    async def clear_all():
        await app.state.db.clear_all()
        app.state.matcher = None
        app.state.tailor = None
        return {"ok": True, "message": "All data cleared"}

    @app.post("/api/scrape")
    async def trigger_scrape():
        async def _scrape_and_score():
            try:
                from app.scrapers import ALL_SCRAPERS
                from app.scheduler import run_scrape_cycle

                db = app.state.db
                config = await db.get_search_config()
                terms = config["search_terms"] if config else []
                keys = await db.get_scraper_keys()
                scrapers = [s(search_terms=terms, scraper_keys=keys) for s in ALL_SCRAPERS]
                app.state.scrape_progress = {"completed": 0, "total": len(scrapers), "current": None, "new_jobs": 0, "active": True}
                await run_scrape_cycle(db, scrapers, search_terms=terms, progress=app.state.scrape_progress, scraper_keys=keys)

                await _score_unscored(db)
            except Exception:
                logger.exception("Background scrape+score failed")
                if app.state.scrape_progress:
                    app.state.scrape_progress["active"] = False

        asyncio.create_task(_scrape_and_score())
        return {"status": "triggered"}

    @app.get("/api/scrape/progress")
    async def scrape_progress():
        progress = app.state.scrape_progress
        if not progress:
            return {"active": False, "completed": 0, "total": 0, "current": None, "new_jobs": 0}
        return progress

    @app.post("/api/jobs/enrich")
    async def enrich_jobs():
        from app.enrichment import enrich_job_description
        db = app.state.db
        jobs = await db.get_jobs_needing_enrichment(limit=50)
        enriched = 0
        for job in jobs:
            sources = await db.get_sources(job["id"])
            source = sources[0]["source_name"] if sources else "unknown"
            desc = await enrich_job_description(job["url"], source)
            if desc and len(desc) > len(job.get("description") or ""):
                await db.update_job_description(job["id"], desc)
                enriched += 1
        return {"enriched": enriched, "total": len(jobs)}

    @app.post("/api/score")
    async def trigger_score():
        async def _run_scoring():
            try:
                await _score_unscored(app.state.db)
            except Exception:
                logger.exception("Background scoring failed")

        asyncio.create_task(_run_scoring())
        return {"status": "scoring_triggered"}

    @app.get("/api/score/progress")
    async def score_progress():
        progress = app.state.scoring_progress
        if not progress:
            return {"active": False, "scored": 0, "total": 0}
        return progress

    @app.get("/api/profile")
    async def get_profile():
        profile = await app.state.db.get_user_profile()
        return profile or {"full_name": "", "email": "", "phone": "", "location": "",
                            "linkedin_url": "", "github_url": "", "portfolio_url": ""}

    @app.post("/api/profile")
    async def update_profile(request: Request):
        body = await request.json()
        # save_user_profile dynamically checks table columns, so pass all fields
        body.pop("id", None)
        body.pop("updated_at", None)
        await app.state.db.save_user_profile(**body)
        return {"ok": True}

    @app.get("/api/profile/full")
    async def get_full_profile():
        return await app.state.db.get_full_profile()

    @app.put("/api/profile/full")
    async def update_full_profile(request: Request):
        body = await request.json()
        await app.state.db.save_full_profile(body)
        return {"ok": True}

    @app.post("/api/profile/learn")
    async def learn_from_autofill(request: Request):
        body = await request.json()
        job_url = body.get("job_url", "")
        job_title = body.get("job_title", "")
        company = body.get("company", "")
        new_data = body.get("new_data", {})

        if new_data:
            existing = await app.state.db.get_user_profile() or {}
            existing.pop("id", None)
            existing.pop("updated_at", None)
            updated = {k: v for k, v in new_data.items() if v}
            existing.update(updated)
            await app.state.db.save_user_profile(**existing)

        await app.state.db.save_autofill_history(
            job_url=job_url, job_title=job_title, company=company,
            new_data_saved=new_data,
        )
        return {"ok": True}

    @app.get("/api/custom-qa")
    async def list_custom_qa():
        return {"items": await app.state.db.get_custom_qa()}

    @app.post("/api/custom-qa")
    async def save_custom_qa(request: Request):
        body = await request.json()
        qa_id = await app.state.db.save_custom_qa(body)
        return {"ok": True, "id": qa_id}

    @app.delete("/api/custom-qa/{qa_id}")
    async def delete_custom_qa(qa_id: int):
        await app.state.db.delete_custom_qa(qa_id)
        return {"ok": True}

    @app.post("/api/autofill/analyze")
    async def analyze_form(request: Request):
        body = await request.json()
        form_html = body.get("form_html", "")
        form_fields = body.get("fields", [])
        page_url = body.get("page_url", "")

        client = getattr(app.state, "ai_client", None)
        if not client:
            return {"mappings": [], "error": "No AI provider configured"}

        profile = await app.state.db.get_full_profile()
        custom_qa = await app.state.db.get_custom_qa()

        profile_summary = json.dumps(profile, default=str, indent=2)
        qa_summary = json.dumps(custom_qa, default=str) if custom_qa else "[]"
        fields_summary = json.dumps(form_fields[:200], default=str, indent=2)

        prompt = f"""You are a job application autofill assistant. Analyze the form fields below and map them to the user's profile data.

USER PROFILE:
{profile_summary}

CUSTOM Q&A BANK:
{qa_summary}

FORM FIELDS (JSON array of field objects with id, name, type, label, placeholder, options):
{fields_summary}

PAGE URL: {page_url}

For each form field, determine the best value from the profile. Return a JSON array of objects:
[
  {{"selector": "#field-id-or-name", "value": "the value to fill", "action": "fill_text|select_dropdown|click_radio|check_checkbox|skip", "confidence": 0.0-1.0, "field_label": "human readable label"}}
]

Rules:
- Use CSS selector format (#id or [name="xxx"]) for selector
- For dropdowns, match the closest option text
- For radio/checkbox, set value to the option to select
- Skip fields you can't confidently fill (set action to "skip")
- For EEO/voluntary self-ID fields, use the user's stored preferences (default to "Decline" if not set)
- For "How did you hear about us?" type questions, use "Online Job Board" or similar generic answer
- Be smart about phone format, date format, and country codes based on what the form expects
- Return ONLY the JSON array, no other text"""

        try:
            response = await client.chat(prompt, max_tokens=4000)
            # Parse JSON from response
            text = response.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text[3:]
                text = text.rsplit("```", 1)[0]
            mappings = json.loads(text)
            return {"mappings": mappings}
        except json.JSONDecodeError:
            return {"mappings": [], "error": "Failed to parse AI response"}
        except Exception as e:
            logger.error(f"Autofill analyze failed: {e}")
            raise HTTPException(500, f"Analysis failed: {str(e)}")

    @app.get("/api/autofill/history")
    async def get_autofill_history(limit: int = Query(50)):
        return {"items": await app.state.db.get_autofill_history(limit=limit)}

    # Work History CRUD
    @app.post("/api/work-history")
    async def save_work_history(request: Request):
        body = await request.json()
        entry_id = await app.state.db.save_work_history(body)
        return {"ok": True, "id": entry_id}

    @app.delete("/api/work-history/{entry_id}")
    async def delete_work_history(entry_id: int):
        await app.state.db.delete_work_history(entry_id)
        return {"ok": True}

    # Education CRUD
    @app.post("/api/education")
    async def save_education(request: Request):
        body = await request.json()
        entry_id = await app.state.db.save_education(body)
        return {"ok": True, "id": entry_id}

    @app.delete("/api/education/{entry_id}")
    async def delete_education(entry_id: int):
        await app.state.db.delete_education(entry_id)
        return {"ok": True}

    # Certifications CRUD
    @app.post("/api/certifications")
    async def save_certification(request: Request):
        body = await request.json()
        entry_id = await app.state.db.save_certification(body)
        return {"ok": True, "id": entry_id}

    @app.delete("/api/certifications/{entry_id}")
    async def delete_certification(entry_id: int):
        await app.state.db.delete_certification(entry_id)
        return {"ok": True}

    # Skills CRUD
    @app.post("/api/skills")
    async def save_skill(request: Request):
        body = await request.json()
        entry_id = await app.state.db.save_skill(body)
        return {"ok": True, "id": entry_id}

    @app.delete("/api/skills/{entry_id}")
    async def delete_skill(entry_id: int):
        await app.state.db.delete_skill(entry_id)
        return {"ok": True}

    # Languages CRUD
    @app.post("/api/languages")
    async def save_language(request: Request):
        body = await request.json()
        entry_id = await app.state.db.save_language(body)
        return {"ok": True, "id": entry_id}

    @app.delete("/api/languages/{entry_id}")
    async def delete_language(entry_id: int):
        await app.state.db.delete_language(entry_id)
        return {"ok": True}

    # References CRUD
    @app.post("/api/references")
    async def save_reference(request: Request):
        body = await request.json()
        entry_id = await app.state.db.save_reference(body)
        return {"ok": True, "id": entry_id}

    @app.delete("/api/references/{entry_id}")
    async def delete_reference(entry_id: int):
        await app.state.db.delete_reference(entry_id)
        return {"ok": True}

    @app.get("/api/search-config")
    async def get_search_config():
        config = await app.state.db.get_search_config()
        if not config:
            return {"resume_text": "", "search_terms": [], "job_titles": [],
                    "key_skills": [], "seniority": "", "summary": "",
                    "ats_score": 0, "ats_issues": [], "ats_tips": [],
                    "exclude_terms": [], "updated_at": None}
        return config

    @app.post("/api/search-config/terms")
    async def update_search_terms(request: Request):
        body = await request.json()
        terms = body.get("search_terms", [])
        if not isinstance(terms, list):
            raise HTTPException(400, "search_terms must be a list")
        await app.state.db.update_search_terms(terms)
        return {"ok": True, "search_terms": terms}

    @app.post("/api/search-config/exclude-terms")
    async def update_exclude_terms(request: Request):
        body = await request.json()
        terms = body.get("exclude_terms", [])
        if not isinstance(terms, list):
            raise HTTPException(400, "exclude_terms must be a list")
        await app.state.db.update_exclude_terms(terms)
        return {"ok": True, "exclude_terms": terms}

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

        from app.ai_client import ALL_PROVIDERS
        if provider not in ALL_PROVIDERS:
            raise HTTPException(400, f"Provider must be one of: {', '.join(ALL_PROVIDERS)}")

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

    @app.get("/api/scraper-keys")
    async def get_scraper_keys():
        keys = await app.state.db.get_scraper_keys()
        result = {}
        for name, data in keys.items():
            result[name] = {
                "has_key": bool(data["api_key"]),
                "email": data["email"],
            }
        return result

    @app.post("/api/scraper-keys")
    async def save_scraper_keys(request: Request):
        body = await request.json()
        for name, data in body.items():
            api_key = data.get("api_key", "")
            email = data.get("email", "")
            if api_key.startswith("****"):
                existing = await app.state.db.get_scraper_key(name)
                if existing:
                    api_key = existing["api_key"]
                else:
                    api_key = ""
            await app.state.db.save_scraper_key(name, api_key, email)
        return {"ok": True}

    @app.get("/api/scraper-schedule")
    async def get_scraper_schedule():
        db = app.state.db
        schedules = await db.get_all_scraper_schedules()
        return {"schedules": schedules}

    @app.post("/api/scraper-schedule")
    async def update_scraper_schedule(request: Request):
        data = await request.json()
        db = app.state.db
        source_name = data.get("source_name")
        interval_hours = data.get("interval_hours")
        if not source_name or interval_hours is None:
            raise HTTPException(400, "source_name and interval_hours required")
        await db.update_scraper_schedule(source_name, int(interval_hours))
        return {"ok": True}

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
        profile_data = {}
        logger.info(f"Resume upload: {len(resume_text)} chars, client={'yes' if client else 'no'}")
        if client:
            from app.resume_analyzer import analyze_resume, parse_resume_to_profile
            analysis_task = analyze_resume(client, resume_text)
            profile_task = parse_resume_to_profile(client, resume_text)
            analysis, profile_data = await asyncio.gather(analysis_task, profile_task)
            logger.info(f"Analysis result: ats_score={analysis.get('ats_score')}, terms={len(analysis.get('search_terms', []))}")
            logger.info(f"Profile parse: {len(profile_data)} sections extracted")

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

        if profile_data:
            await _save_parsed_profile(app.state.db, profile_data)

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
            "profile_parsed": bool(profile_data),
        }

    @app.get("/api/companies/{company_name:path}")
    async def get_company_info(company_name: str):
        from app.company_research import research_company
        # Check cache first
        cached = await app.state.db.get_company(company_name)
        if cached:
            return cached
        # Fetch and cache
        info = await research_company(company_name)
        fields = {}
        if info.get("description"):
            fields["description"] = info["description"]
        if info.get("website"):
            fields["website"] = info["website"]
        if info.get("glassdoor_rating"):
            fields["glassdoor_rating"] = info["glassdoor_rating"]
        if info.get("size"):
            fields["size"] = info["size"]
        if info.get("industry"):
            fields["industry"] = info["industry"]
        if fields:
            await app.state.db.save_company(company_name, **fields)
        return await app.state.db.get_company(company_name) or info

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
