import csv
import io
import logging
import re

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


@router.get("/stats")
async def get_stats(request: Request):
    return await request.app.state.db.get_stats()


@router.get("/analytics")
async def get_analytics(request: Request):
    return await request.app.state.db.get_analytics()


@router.get("/skill-gaps")
async def get_skill_gaps(request: Request):
    db = request.app.state.db
    gap_data = await db.get_skill_gap_data(min_score=50, max_score=80)
    user_skills = await db.get_skills()
    return {
        "job_count": gap_data["job_count"],
        "top_concerns": gap_data["top_concerns"],
        "top_keywords": gap_data["top_keywords"],
        "user_skills": [s["name"] for s in user_skills],
    }


@router.post("/skill-gaps/analyze")
async def analyze_skill_gaps(request: Request):
    from app.ai_client import parse_json_response
    db = request.app.state.db
    client = getattr(request.app.state, "ai_client", None)
    if not client:
        raise HTTPException(503, "AI client not configured")
    gap_data = await db.get_skill_gap_data(min_score=50, max_score=80)
    if gap_data["job_count"] == 0:
        return {"skills": [], "message": "No jobs in the 50-80 score range to analyze"}
    user_skills = await db.get_skills()
    flat_skills = set()
    for s in user_skills:
        name = s.get("name", "")
        if not name:
            continue
        if ": " in name:
            name = name.split(": ", 1)[1]
        name = re.sub(r'\s*\([^)]*\)', '', name)
        for part in name.replace(" / ", ", ").replace(" & ", ", ").split(","):
            part = part.strip()
            if part and len(part) > 1:
                flat_skills.add(part)
    flat_skill_list = sorted(flat_skills)
    user_skills_lower = {s.lower() for s in flat_skill_list}
    filtered_keywords = [
        (k, n) for k, n in gap_data['top_keywords']
        if k.lower() not in user_skills_lower
    ]
    prompt = f"""You are a career advisor. Analyze the skill gaps between a job seeker's current skills and the jobs they almost qualify for (scored 50-80 out of 100).

CURRENT SKILLS (the candidate ALREADY HAS these — do NOT suggest these as gaps):
{', '.join(flat_skill_list) if flat_skill_list else 'Not specified'}

TOP CONCERNS FROM JOB MATCHES (reasons jobs scored below 80):
{chr(10).join(f'- {c}: {n} jobs' for c, n in gap_data['top_concerns'][:15])}

SKILLS FREQUENTLY REQUIRED BY NEAR-MATCH JOBS (already filtered to exclude skills the candidate has):
{chr(10).join(f'- {k}: {n} jobs' for k, n in filtered_keywords[:15]) if filtered_keywords else '- None (candidate has all frequently required skills)'}

TOTAL NEAR-MATCH JOBS: {gap_data['job_count']}

Return ONLY valid JSON with this structure:
{{
    "skills": [
        {{
            "name": "skill name",
            "jobs_unlocked": estimated number of additional jobs this would unlock,
            "difficulty": "low/medium/high" (how hard to learn),
            "time_estimate": "estimated time to become proficient",
            "reason": "brief explanation of why this skill matters"
        }}
    ]
}}

IMPORTANT: Do NOT suggest skills the candidate already has. Only suggest genuinely NEW skills.
Rank by ROI (jobs unlocked relative to learning difficulty). Return top 5 skills."""

    try:
        raw = await client.chat(prompt, max_tokens=1024)
        result = parse_json_response(raw)
    except Exception as e:
        logger.error(f"Skill gap analysis failed: {e}")
        raise HTTPException(502, f"AI analysis failed: {e}")
    return {
        "skills": result.get("skills", []),
        "job_count": gap_data["job_count"],
    }


@router.get("/jobs/{job_id}/predict-success")
async def predict_success(request: Request, job_id: int):
    from app.predictor import predict_success as _predict
    client = getattr(request.app.state, "ai_client", None)
    if not client:
        raise HTTPException(503, "AI client not configured")
    db = request.app.state.db
    job = await db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    history = await db.get_application_history_summary()
    emb_client = getattr(request.app.state, "embedding_client", None)
    if emb_client and getattr(db, "_vec_loaded", False):
        from app.embeddings import retrieve_relevant_context
        query = f"{job['title']} at {job['company']}"
        context_items = await retrieve_relevant_context(db.db, emb_client, query, limit=3)
        if context_items:
            history += "\n\nRelevant past context:\n" + "\n".join(
                f"- {c['text'][:200]}" for c in context_items
            )
    result = await _predict(
        client, history=history,
        title=job["title"], company=job["company"],
        description=job.get("description") or "",
    )
    return result


@router.post("/career/analyze")
async def analyze_career(request: Request):
    from app.career_advisor import analyze_career as _analyze
    client = getattr(request.app.state, "ai_client", None)
    if not client:
        raise HTTPException(503, "AI client not configured")
    db = request.app.state.db
    profile = await db.get_full_profile()
    work = profile.get("work_history", [])
    skills_list = profile.get("skills", [])
    config = await db.get_search_config()
    work_text = "\n".join(
        f"- {w.get('job_title', '')} at {w.get('company', '')} ({w.get('start_year', '')}-{w.get('end_year', 'present')})"
        for w in work
    ) or "No work history provided"
    skills_text = ", ".join(s.get("name", "") for s in skills_list) or "No skills listed"
    terms = ", ".join(config.get("search_terms", [])) if config else ""
    suggestions = await _analyze(client, work_text, skills_text, terms)
    if suggestions:
        await db.save_career_suggestions(suggestions)
    return {"ok": True, "suggestions": suggestions}


@router.get("/career/suggestions")
async def get_career_suggestions(request: Request):
    suggestions = await request.app.state.db.get_career_suggestions()
    return {"suggestions": suggestions}


@router.post("/career/suggestions/{suggestion_id}/accept")
async def accept_career_suggestion(request: Request, suggestion_id: int):
    db = request.app.state.db
    suggestion = await db.accept_career_suggestion(suggestion_id)
    if not suggestion:
        raise HTTPException(404, "Suggestion not found")
    config = await db.get_search_config()
    if config:
        terms = config.get("search_terms", [])
        title = suggestion.get("title", "")
        if title and title not in terms:
            terms.append(title)
            await db.update_search_terms(terms)
    return {"ok": True, "suggestion": suggestion}


@router.get("/export/csv")
async def export_csv(
    request: Request,
    min_score: int | None = Query(None),
    status: str | None = Query(None),
):
    db = request.app.state.db
    jobs = await db.list_jobs(sort_by="score", limit=10000)

    # Prefetch all sources and applications to avoid N+1
    all_sources_cursor = await db.db.execute(
        "SELECT job_id, source_name FROM sources")
    all_sources = await all_sources_cursor.fetchall()
    sources_by_job = {}
    for row in all_sources:
        sources_by_job.setdefault(row[0], []).append(row[1])

    all_apps_cursor = await db.db.execute(
        "SELECT job_id, applied_at FROM applications")
    all_apps = await all_apps_cursor.fetchall()
    apps_by_job = {row[0]: row[1] for row in all_apps}

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
        source_names = ", ".join(sources_by_job.get(job["id"], []))
        applied_at = apps_by_job.get(job["id"], "")
        writer.writerow([
            job["title"], job["company"], job.get("location", ""),
            job.get("match_score", ""), app_row,
            job.get("salary_min", ""), job.get("salary_max", ""),
            job["url"], job.get("posted_date", ""),
            job.get("contact_email", ""),
            applied_at or "",
            source_names,
        ])
    return Response(
        content=output.getvalue(), media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="careerpulse-export.csv"'},
    )


@router.get("/offers")
async def list_offers(request: Request):
    offers = await request.app.state.db.get_offers()
    return {"offers": offers}


@router.get("/offers/compare")
async def compare_offers(request: Request):
    from app.offer_calculator import compare_offers as _compare
    offers = await request.app.state.db.get_offers()
    comparison = _compare(offers)
    return {"comparison": comparison}


@router.post("/offers")
async def create_offer(request: Request):
    body = await request.json()
    fields = {}
    for key in ("job_id", "base", "equity", "bonus", "pto_days", "remote_days",
                 "health_value", "retirement_match", "relocation", "location", "notes"):
        if key in body:
            fields[key] = body[key]
    db = request.app.state.db
    offer_id = await db.create_offer(**fields)
    offer = await db.get_offer(offer_id)
    return {"ok": True, "offer": offer}


@router.put("/offers/{offer_id}")
async def update_offer(request: Request, offer_id: int):
    body = await request.json()
    fields = {}
    for key in ("job_id", "base", "equity", "bonus", "pto_days", "remote_days",
                 "health_value", "retirement_match", "relocation", "location", "notes"):
        if key in body:
            fields[key] = body[key]
    if not fields:
        raise HTTPException(400, "No fields to update")
    db = request.app.state.db
    updated = await db.update_offer(offer_id, **fields)
    if not updated:
        raise HTTPException(404, "Offer not found")
    offer = await db.get_offer(offer_id)
    return {"ok": True, "offer": offer}


@router.delete("/offers/{offer_id}")
async def delete_offer(request: Request, offer_id: int):
    deleted = await request.app.state.db.delete_offer(offer_id)
    if not deleted:
        raise HTTPException(404, "Offer not found")
    return {"ok": True}


@router.get("/digest")
async def get_digest(
    request: Request,
    min_score: int = Query(60),
    hours: int = Query(24),
):
    from app.digest import generate_digest
    return await generate_digest(request.app.state.db, min_score, hours)


@router.post("/digest/send-test")
async def send_digest_test(request: Request):
    from app.digest import send_digest
    success = await send_digest(request.app.state.db)
    if not success:
        raise HTTPException(400, "Digest not sent — check email settings and digest configuration")
    return {"ok": True, "message": "Digest sent"}
