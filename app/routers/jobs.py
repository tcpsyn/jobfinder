import json
import logging

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


@router.get("/jobs")
async def list_jobs(
    request: Request,
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
    posted_within: str | None = Query(None),
    include_stale: bool = Query(False),
):
    db = request.app.state.db
    config = await db.get_search_config()
    exclude_terms = config.get("exclude_terms", []) if config else []
    # Default to 30 days if no filter specified and not explicitly requesting stale
    effective_posted_within = posted_within if posted_within or include_stale else "30d"
    jobs = await db.list_jobs(
        sort_by=sort, limit=limit, offset=offset,
        min_score=min_score, search=search, source=source,
        work_type=work_type, employment_type=employment_type,
        location=location, exclude_terms=exclude_terms,
        region=region, clearance=clearance,
        posted_within=effective_posted_within,
    )
    return {"jobs": jobs}


@router.post("/jobs/save-external")
async def save_external_job(request: Request):
    db = request.app.state.db
    body = await request.json()
    title = body.get("title", "").strip()
    company = body.get("company", "").strip()
    url = body.get("url", "").strip()
    if not title or not company or not url:
        raise HTTPException(400, "title, company, and url are required")
    description = body.get("description", "")
    source = body.get("source", "external")
    job_id = await db.insert_job(
        title=title, company=company, location=body.get("location", ""),
        salary_min=body.get("salary_min"), salary_max=body.get("salary_max"),
        description=description, url=url, posted_date=body.get("posted_date"),
        application_method=body.get("application_method", "url"),
        contact_email=body.get("contact_email"),
    )
    if job_id:
        await db.insert_source(job_id, source, url)
        await db.add_event(job_id, "saved_external", f"Saved from {source}")
    return {"ok": True, "job_id": job_id}


@router.get("/jobs/lookup")
async def lookup_job_by_url(request: Request, url: str = Query(...)):
    db = request.app.state.db
    job = await db.find_job_by_url(url)
    if not job:
        return {"found": False}
    score = await db.get_score(job["id"])
    application = await db.get_application(job["id"])
    return {
        "found": True,
        "job_id": job["id"],
        "title": job["title"],
        "company": job["company"],
        "score": score["match_score"] if score else None,
        "status": application["status"] if application else None,
    }


@router.get("/jobs/{job_id}")
async def get_job(request: Request, job_id: int):
    db = request.app.state.db
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    score = await db.get_score(job_id)
    sources = await db.get_sources(job_id)
    application = await db.get_application(job_id)
    events = await db.get_events(job_id)
    similar = await db.find_similar_jobs(
        job["title"], job["company"], exclude_id=job_id,
        embedding_client=request.app.state.embedding_client,
    )
    interview_prep = await db.get_interview_prep(job_id)
    return {**job, "score": score, "sources": sources, "application": application,
            "events": events, "similar": similar, "interview_prep": interview_prep}


@router.get("/jobs/{job_id}/similar")
async def get_similar_jobs(request: Request, job_id: int):
    db = request.app.state.db
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    similar = await db.find_similar_jobs(
        job["title"], job["company"], exclude_id=job_id,
        embedding_client=request.app.state.embedding_client,
    )
    return {"similar": similar}


@router.post("/jobs/{job_id}/dismiss")
async def dismiss_job(request: Request, job_id: int):
    await request.app.state.db.dismiss_job(job_id)
    return {"ok": True}


@router.post("/jobs/{job_id}/estimate-salary")
async def estimate_salary_endpoint(request: Request, job_id: int):
    from app.salary_estimator import estimate_salary
    db = request.app.state.db
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    client = getattr(request.app.state, "ai_client", None)
    if not client:
        raise HTTPException(503, "No AI provider configured. Go to Settings → AI to set one up.")
    if job.get("salary_min") and job.get("salary_max"):
        return {"ok": True, "already_known": True,
                "min": job["salary_min"], "max": job["salary_max"]}
    result = await estimate_salary(client, job)
    if result.get("min") and result["min"] > 0:
        await db.update_job_contact(job_id,
            salary_estimate_min=result["min"],
            salary_estimate_max=result["max"],
            salary_confidence=result.get("confidence", "low"),
        )
    return {"ok": True, **result}


@router.post("/jobs/{job_id}/find-apply-link")
async def find_apply_link(request: Request, job_id: int):
    from app.apply_link_finder import find_apply_url
    db = request.app.state.db
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    url = await find_apply_url(job["url"])
    if url:
        await db.update_job_contact(job_id, apply_url=url)
    return {"ok": True, "apply_url": url}


@router.post("/jobs/{job_id}/find-contact")
async def find_contact(request: Request, job_id: int):
    from app.contact_finder import find_hiring_contact
    db = request.app.state.db
    job = await db.get_job(job_id)
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
    await db.update_job_contact(job_id, **update)
    await db.add_event(job_id, "note",
        f"Contact lookup: {'Found ' + result['email'] if result.get('email') else 'No contact found'}")
    return {"ok": True, "contact": result}


@router.post("/jobs/{job_id}/events")
async def add_event(request: Request, job_id: int):
    db = request.app.state.db
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    body = await request.json()
    detail = body.get("detail", "")
    if not detail.strip():
        raise HTTPException(400, "Detail is required")
    await db.add_event(job_id, "note", detail)
    return {"ok": True}


@router.post("/jobs/mark-applied-by-url")
async def mark_applied_by_url(request: Request):
    body = await request.json()
    url = body.get("url", "").strip()
    if not url:
        raise HTTPException(400, "url is required")
    db = request.app.state.db
    job = await db.find_job_by_url(url)
    if not job:
        return {"found": False, "message": "Job not tracked"}
    await db.upsert_application(job["id"], "applied")
    await db.add_event(job["id"], "auto_applied", "Auto-tracked as applied")
    return {"found": True, "job_id": job["id"], "status": "applied"}


@router.get("/companies/{company_name:path}")
async def get_company_info(request: Request, company_name: str):
    from app.company_research import research_company
    db = request.app.state.db
    cached = await db.get_company(company_name)
    if cached:
        return cached
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
        await db.save_company(company_name, **fields)
    return await db.get_company(company_name) or info
