import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException, Query, Request, UploadFile, File

from app.ai_client import AIClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "****"
    return f"****{key[-4:]}"


@router.get("/profile")
async def get_profile(request: Request):
    profile = await request.app.state.db.get_user_profile()
    return profile or {"full_name": "", "email": "", "phone": "", "location": "",
                        "linkedin_url": "", "github_url": "", "portfolio_url": ""}


@router.post("/profile")
async def update_profile(request: Request):
    body = await request.json()
    body.pop("id", None)
    body.pop("updated_at", None)
    await request.app.state.db.save_user_profile(**body)
    return {"ok": True}


@router.get("/profile/full")
async def get_full_profile(request: Request):
    return await request.app.state.db.get_full_profile()


@router.put("/profile/full")
async def update_full_profile(request: Request):
    body = await request.json()
    await request.app.state.db.save_full_profile(body)
    return {"ok": True}


@router.post("/profile/learn")
async def learn_from_autofill(request: Request):
    body = await request.json()
    job_url = body.get("job_url", "")
    job_title = body.get("job_title", "")
    company = body.get("company", "")
    new_data = body.get("new_data", {})
    db = request.app.state.db
    if new_data:
        existing = await db.get_user_profile() or {}
        existing.pop("id", None)
        existing.pop("updated_at", None)
        updated = {k: v for k, v in new_data.items() if v}
        existing.update(updated)
        await db.save_user_profile(**existing)
    await db.save_autofill_history(
        job_url=job_url, job_title=job_title, company=company,
        new_data_saved=new_data,
    )
    return {"ok": True}


@router.get("/custom-qa")
async def list_custom_qa(request: Request):
    return {"items": await request.app.state.db.get_custom_qa()}


@router.post("/custom-qa")
async def save_custom_qa(request: Request):
    body = await request.json()
    qa_id = await request.app.state.db.save_custom_qa(body)
    return {"ok": True, "id": qa_id}


@router.delete("/custom-qa/{qa_id}")
async def delete_custom_qa(request: Request, qa_id: int):
    await request.app.state.db.delete_custom_qa(qa_id)
    return {"ok": True}


@router.get("/autofill/history")
async def get_autofill_history(request: Request, limit: int = Query(50)):
    return {"items": await request.app.state.db.get_autofill_history(limit=limit)}


# Profile field CRUD
@router.post("/work-history")
async def save_work_history(request: Request):
    body = await request.json()
    entry_id = await request.app.state.db.save_work_history(body)
    return {"ok": True, "id": entry_id}


@router.delete("/work-history/{entry_id}")
async def delete_work_history(request: Request, entry_id: int):
    await request.app.state.db.delete_work_history(entry_id)
    return {"ok": True}


@router.post("/education")
async def save_education(request: Request):
    body = await request.json()
    entry_id = await request.app.state.db.save_education(body)
    return {"ok": True, "id": entry_id}


@router.delete("/education/{entry_id}")
async def delete_education(request: Request, entry_id: int):
    await request.app.state.db.delete_education(entry_id)
    return {"ok": True}


@router.post("/certifications")
async def save_certification(request: Request):
    body = await request.json()
    entry_id = await request.app.state.db.save_certification(body)
    return {"ok": True, "id": entry_id}


@router.delete("/certifications/{entry_id}")
async def delete_certification(request: Request, entry_id: int):
    await request.app.state.db.delete_certification(entry_id)
    return {"ok": True}


@router.post("/skills")
async def save_skill(request: Request):
    body = await request.json()
    entry_id = await request.app.state.db.save_skill(body)
    return {"ok": True, "id": entry_id}


@router.delete("/skills/{entry_id}")
async def delete_skill(request: Request, entry_id: int):
    await request.app.state.db.delete_skill(entry_id)
    return {"ok": True}


@router.post("/languages")
async def save_language(request: Request):
    body = await request.json()
    entry_id = await request.app.state.db.save_language(body)
    return {"ok": True, "id": entry_id}


@router.delete("/languages/{entry_id}")
async def delete_language(request: Request, entry_id: int):
    await request.app.state.db.delete_language(entry_id)
    return {"ok": True}


@router.post("/references")
async def save_reference(request: Request):
    body = await request.json()
    entry_id = await request.app.state.db.save_reference(body)
    return {"ok": True, "id": entry_id}


@router.delete("/references/{entry_id}")
async def delete_reference(request: Request, entry_id: int):
    await request.app.state.db.delete_reference(entry_id)
    return {"ok": True}


@router.get("/resumes")
async def list_resumes(request: Request):
    resumes = await request.app.state.db.get_resumes()
    return {"resumes": resumes}


@router.post("/resumes")
async def create_resume(request: Request):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "Resume name is required")
    db = request.app.state.db
    resume_id = await db.create_resume(
        name=name, resume_text=body.get("resume_text", ""),
        is_default=body.get("is_default", False),
        search_terms=body.get("search_terms"), job_titles=body.get("job_titles"),
        key_skills=body.get("key_skills"), seniority=body.get("seniority", ""),
        summary=body.get("summary", ""),
    )
    resume = await db.get_resume(resume_id)
    return {"ok": True, "resume": resume}


@router.put("/resumes/{resume_id}")
async def update_resume(request: Request, resume_id: int):
    body = await request.json()
    if "name" in body and not body["name"].strip():
        raise HTTPException(400, "Resume name cannot be empty")
    fields = {}
    for key in ("name", "resume_text", "is_default", "search_terms",
                 "job_titles", "key_skills", "seniority", "summary"):
        if key in body:
            fields[key] = body[key].strip() if isinstance(body[key], str) else body[key]
    if not fields:
        raise HTTPException(400, "No fields to update")
    db = request.app.state.db
    updated = await db.update_resume(resume_id, **fields)
    if not updated:
        raise HTTPException(404, "Resume not found")
    resume = await db.get_resume(resume_id)
    return {"ok": True, "resume": resume}


@router.delete("/resumes/{resume_id}")
async def delete_resume(request: Request, resume_id: int):
    deleted = await request.app.state.db.delete_resume(resume_id)
    if not deleted:
        raise HTTPException(404, "Resume not found")
    return {"ok": True}


@router.post("/resumes/{resume_id}/set-default")
async def set_default_resume(request: Request, resume_id: int):
    result = await request.app.state.db.set_default_resume(resume_id)
    if not result:
        raise HTTPException(404, "Resume not found")
    return {"ok": True}


@router.get("/saved-views")
async def list_saved_views(request: Request):
    views = await request.app.state.db.get_saved_views()
    return {"views": views}


@router.post("/saved-views")
async def create_saved_view(request: Request):
    body = await request.json()
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "View name is required")
    db = request.app.state.db
    filters = body.get("filters", {})
    view_id = await db.create_saved_view(name, filters)
    view = await db.get_saved_view(view_id)
    return {"ok": True, "view": view}


@router.put("/saved-views/{view_id}")
async def update_saved_view(request: Request, view_id: int):
    body = await request.json()
    name = body.get("name")
    filters = body.get("filters")
    if name is not None and not name.strip():
        raise HTTPException(400, "View name cannot be empty")
    db = request.app.state.db
    updated = await db.update_saved_view(
        view_id, name=name.strip() if name else name, filters=filters
    )
    if not updated:
        raise HTTPException(404, "View not found")
    view = await db.get_saved_view(view_id)
    return {"ok": True, "view": view}


@router.delete("/saved-views/{view_id}")
async def delete_saved_view(request: Request, view_id: int):
    deleted = await request.app.state.db.delete_saved_view(view_id)
    if not deleted:
        raise HTTPException(404, "View not found")
    return {"ok": True}


@router.get("/search-config")
async def get_search_config(request: Request):
    config = await request.app.state.db.get_search_config()
    if not config:
        return {"resume_text": "", "search_terms": [], "job_titles": [],
                "key_skills": [], "seniority": "", "summary": "",
                "ats_score": 0, "ats_issues": [], "ats_tips": [],
                "exclude_terms": [], "updated_at": None}
    return config


@router.post("/search-config/terms")
async def update_search_terms(request: Request):
    body = await request.json()
    terms = body.get("search_terms", [])
    if not isinstance(terms, list):
        raise HTTPException(400, "search_terms must be a list")
    await request.app.state.db.update_search_terms(terms)
    return {"ok": True, "search_terms": terms}


@router.post("/search-config/exclude-terms")
async def update_exclude_terms(request: Request):
    body = await request.json()
    terms = body.get("exclude_terms", [])
    if not isinstance(terms, list):
        raise HTTPException(400, "exclude_terms must be a list")
    await request.app.state.db.update_exclude_terms(terms)
    return {"ok": True, "exclude_terms": terms}


@router.get("/ai-settings")
async def get_ai_settings(request: Request):
    settings = await request.app.state.db.get_ai_settings()
    if not settings:
        env_key = getattr(getattr(request.app.state, "settings", None), "anthropic_api_key", "") or ""
        return {
            "provider": "anthropic" if env_key else "",
            "api_key": _mask_key(env_key),
            "model": "", "base_url": "",
            "has_key": bool(env_key), "updated_at": None,
        }
    return {
        "provider": settings["provider"],
        "api_key": _mask_key(settings["api_key"]),
        "model": settings["model"],
        "base_url": settings["base_url"],
        "has_key": bool(settings["api_key"]),
        "updated_at": settings["updated_at"],
    }


@router.post("/ai-settings")
async def update_ai_settings(request: Request):
    from app.ai_client import ALL_PROVIDERS
    body = await request.json()
    provider = body.get("provider", "anthropic")
    api_key = body.get("api_key", "")
    model = body.get("model", "")
    base_url = body.get("base_url", "")
    if provider not in ALL_PROVIDERS:
        raise HTTPException(400, f"Provider must be one of: {', '.join(ALL_PROVIDERS)}")
    if api_key.startswith("****"):
        existing = await request.app.state.db.get_ai_settings()
        if existing:
            api_key = existing["api_key"]
        else:
            env_key = getattr(getattr(request.app.state, "settings", None), "anthropic_api_key", "") or ""
            api_key = env_key
    await request.app.state.db.save_ai_settings(provider, api_key, model, base_url)
    from app.main import _build_ai_client
    client = _build_ai_client({"provider": provider, "api_key": api_key,
                                "model": model, "base_url": base_url})
    config = await request.app.state.db.get_search_config()
    resume_text = config.get("resume_text", "") if config else ""
    request.app.state.reinit_ai_services(client, resume_text)
    return {"ok": True, "provider": provider, "model": model}


@router.get("/ai-settings/models")
async def list_ollama_models(request: Request, base_url: str = Query("http://localhost:11434")):
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


@router.post("/ai-settings/test")
async def test_ai_connection(request: Request):
    body = await request.json()
    provider = body.get("provider", "anthropic")
    api_key = body.get("api_key", "")
    model = body.get("model", "")
    base_url = body.get("base_url", "")
    if api_key.startswith("****"):
        existing = await request.app.state.db.get_ai_settings()
        if existing:
            api_key = existing["api_key"]
        else:
            env_key = getattr(getattr(request.app.state, "settings", None), "anthropic_api_key", "") or ""
            api_key = env_key
    try:
        client = AIClient(provider, api_key=api_key, model=model, base_url=base_url)
        response = await client.chat("Reply with exactly: OK", max_tokens=10)
        return {"ok": True, "response": (response or "").strip()[:50]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/settings/embeddings")
async def get_embedding_settings(request: Request):
    settings = await request.app.state.db.get_embedding_settings()
    if not settings:
        return {
            "provider": "", "api_key": "", "model": "", "base_url": "",
            "dimensions": 256, "has_key": False, "enabled": False, "updated_at": None,
        }
    return {
        "provider": settings["provider"],
        "api_key": _mask_key(settings["api_key"]),
        "model": settings["model"],
        "base_url": settings["base_url"],
        "dimensions": settings["dimensions"],
        "has_key": bool(settings["api_key"]),
        "enabled": bool(request.app.state.embedding_client),
        "updated_at": settings["updated_at"],
    }


@router.post("/settings/embeddings")
async def save_embedding_settings(request: Request):
    body = await request.json()
    provider = body.get("provider", "openai")
    api_key = body.get("api_key", "")
    model = body.get("model", "")
    base_url = body.get("base_url", "")
    dimensions = body.get("dimensions", 256)
    if provider not in ("openai", "ollama"):
        raise HTTPException(400, "Provider must be 'openai' or 'ollama'")
    if api_key.startswith("****"):
        existing = await request.app.state.db.get_embedding_settings()
        if existing:
            api_key = existing["api_key"]
    db = request.app.state.db
    await db.save_embedding_settings(provider, api_key, model, base_url, dimensions)
    from app.main import _init_embedding_client
    request.app.state.embedding_client = await _init_embedding_client(db)
    return {"ok": True, "provider": provider, "enabled": bool(request.app.state.embedding_client)}


@router.post("/embeddings/backfill")
async def backfill_embeddings(request: Request):
    client = request.app.state.embedding_client
    if not client:
        raise HTTPException(400, "Embeddings not configured")
    db = request.app.state.db
    from app.embeddings import upsert_embedding
    cursor = await db.db.execute(
        "SELECT id, title, company, description FROM jobs WHERE dismissed = 0"
    )
    jobs = await cursor.fetchall()
    embedded = 0
    errors = 0
    for job in jobs:
        text = f"{job['title']} at {job['company']}\n{job['description'] or ''}"
        try:
            vector = await client.embed(text[:8000])
            await upsert_embedding(db.db, "vec_jobs", job["id"], vector)
            embedded += 1
        except Exception as e:
            logger.warning("Failed to embed job %d: %s", job["id"], e)
            errors += 1
    return {"ok": True, "embedded": embedded, "errors": errors, "total": len(jobs)}


@router.get("/settings/email")
async def get_email_settings(request: Request):
    settings = await request.app.state.db.get_email_settings()
    if settings:
        settings.pop("smtp_password", None)
    return settings or {}


@router.post("/settings/email")
async def save_email_settings(request: Request):
    data = await request.json()
    db = request.app.state.db
    existing = await db.get_email_settings()
    if data.get("smtp_password") == "" and existing:
        data["smtp_password"] = existing.get("smtp_password", "")
    await db.update_email_settings(data)
    scheduler = getattr(request.app.state, "scheduler", None)
    if scheduler and scheduler.running:
        digest_time = data.get("digest_time", "08:00")
        try:
            hour, minute = digest_time.split(":")
            scheduler.reschedule_job("digest_cycle", trigger="cron", hour=int(hour), minute=int(minute))
        except Exception:
            pass
    return {"ok": True}


@router.post("/settings/email/test")
async def test_email_settings(request: Request):
    from app.emailer import send_email
    data = await request.json()
    existing = await request.app.state.db.get_email_settings()
    if data.get("smtp_password") == "" and existing:
        data["smtp_password"] = existing.get("smtp_password", "")
    test_to = data.get("from_address", "")
    if not test_to:
        raise HTTPException(400, "From address required for test")
    success = await send_email(
        data, to=test_to, subject="CareerPulse SMTP Test",
        body_text="Your SMTP settings are configured correctly.",
        body_html="<p>Your SMTP settings are configured correctly.</p>",
    )
    if not success:
        raise HTTPException(500, "Failed to send test email — check SMTP settings")
    return {"ok": True, "message": f"Test email sent to {test_to}"}


@router.get("/scraper-keys")
async def get_scraper_keys(request: Request):
    keys = await request.app.state.db.get_scraper_keys()
    result = {}
    for name, data in keys.items():
        result[name] = {"has_key": bool(data["api_key"]), "email": data["email"]}
    return result


@router.post("/scraper-keys")
async def save_scraper_keys(request: Request):
    body = await request.json()
    db = request.app.state.db
    for name, data in body.items():
        api_key = data.get("api_key", "")
        email = data.get("email", "")
        if api_key.startswith("****"):
            existing = await db.get_scraper_key(name)
            if existing:
                api_key = existing["api_key"]
            else:
                api_key = ""
        await db.save_scraper_key(name, api_key, email)
    return {"ok": True}


@router.get("/scraper-schedule")
async def get_scraper_schedule(request: Request):
    schedules = await request.app.state.db.get_all_scraper_schedules()
    return {"schedules": schedules}


@router.post("/scraper-schedule")
async def update_scraper_schedule(request: Request):
    data = await request.json()
    source_name = data.get("source_name")
    interval_hours = data.get("interval_hours")
    if not source_name or interval_hours is None:
        raise HTTPException(400, "source_name and interval_hours required")
    await request.app.state.db.update_scraper_schedule(source_name, int(interval_hours))
    return {"ok": True}


_MAX_UPLOAD_SIZE = 10 * 1024 * 1024  # 10MB
_ALLOWED_EXTENSIONS = {".pdf", ".txt", ".md", ".doc", ".docx", ".rtf"}


@router.post("/resume/upload")
async def upload_resume(request: Request, file: UploadFile = File(...)):
    filename = (file.filename or "").lower()
    ext = "." + filename.rsplit(".", 1)[-1] if "." in filename else ""
    if ext not in _ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type: {ext}. Allowed: {', '.join(sorted(_ALLOWED_EXTENSIONS))}")
    content = await file.read()
    if len(content) > _MAX_UPLOAD_SIZE:
        raise HTTPException(400, f"File too large ({len(content)} bytes). Maximum: {_MAX_UPLOAD_SIZE // (1024*1024)}MB")
    if filename.endswith(".pdf"):
        import fitz
        doc = fitz.open(stream=content, filetype="pdf")
        resume_text = "\n".join(page.get_text() for page in doc)
        doc.close()
    else:
        resume_text = content.decode("utf-8", errors="replace")

    client = getattr(request.app.state, "ai_client", None)
    if not client and not getattr(request.app.state, "testing", False):
        from app.main import _build_ai_client
        ai_settings = await request.app.state.db.get_ai_settings()
        env_key = getattr(getattr(request.app.state, "settings", None), "anthropic_api_key", "") or ""
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
        request.app.state.reinit_ai_services(client, resume_text)

    db = request.app.state.db
    await db.save_search_config(
        resume_text, analysis["search_terms"],
        job_titles=analysis["job_titles"], key_skills=analysis["key_skills"],
        seniority=analysis.get("seniority", ""), summary=analysis.get("summary", ""),
        ats_score=analysis.get("ats_score", 0), ats_issues=analysis.get("ats_issues", []),
        ats_tips=analysis.get("ats_tips", []),
    )
    if profile_data:
        await request.app.state.save_parsed_profile(db, profile_data)

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
