import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request, UploadFile, File
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import time as _time
from datetime import datetime, timezone

from app.database import Database
from app.ai_client import AIClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

AUTOFILL_ANALYZE_TIMEOUT = 45


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

        # Initialize embedding client from saved settings
        app.state.embedding_client = await _init_embedding_client(app.state.db)

        from apscheduler.schedulers.asyncio import AsyncIOScheduler

        scheduler = AsyncIOScheduler()

        async def scheduled_scrape():
            db = app.state.db
            config = await db.get_search_config()
            terms = config["search_terms"] if config else []
            keys = await db.get_scraper_keys()
            scrapers = [s(search_terms=terms, scraper_keys=keys) for s in ALL_SCRAPERS]
            await run_scrape_cycle(db, scrapers, search_terms=terms, scraper_keys=keys)

        async def scheduled_enrichment():
            await run_enrichment_cycle(app.state.db)

        async def scheduled_scoring():
            await _score_unscored(app.state.db)

        async def scheduled_maintenance():
            await run_maintenance_cycle(app.state.db)

        async def scheduled_reminder_check():
            due = await run_reminder_check(app.state.db, embedding_client=app.state.embedding_client)
            for r in due:
                await app.state.db.add_event(
                    r["job_id"], "reminder_due",
                    f"Follow-up reminder due for {r.get('company', 'unknown')}"
                )

        async def scheduled_digest():
            await run_digest_cycle(app.state.db)

        async def scheduled_alert_check():
            await run_alert_check(app.state.db)

        async def scheduled_embedding():
            await run_job_embedding_cycle(app.state.db, app.state.embedding_client)
            await run_context_embedding_cycle(app.state.db, app.state.embedding_client)

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


import re as _re


def _is_excluded(pattern: str, searchable: str) -> bool:
    """Check if a field should be excluded from a pattern match based on context."""
    s = searchable.lower()
    # Phone number pattern should not match country code or extension fields
    if "phone" in pattern and ("country" in s or "code" in s or "extension" in s):
        return True
    return False


def _deterministic_fill(fields: list[dict], profile: dict) -> tuple[list[dict], list[dict]]:
    """Match common form fields to profile data without AI. Returns (mappings, remaining_fields)."""
    if not fields or not profile:
        return [], fields or []

    full_name = profile.get("full_name", "")
    name_parts = full_name.split(None, 1) if full_name else ["", ""]
    first_name = name_parts[0] if name_parts else ""
    last_name = name_parts[1] if len(name_parts) > 1 else ""

    # Field patterns → profile value mappings
    # Each entry: (patterns_for_label_or_name, value, action)
    rules = [
        # Name fields
        (r"\bfirst[\s_-]?name\b", first_name, "fill_text"),
        (r"\bgiven[\s_-]?name\b", first_name, "fill_text"),
        (r"\blast[\s_-]?name\b", last_name, "fill_text"),
        (r"\bsurname\b|\bfamily[\s_-]?name\b", last_name, "fill_text"),
        (r"\bfull[\s_-]?name\b|\byour[\s_-]?name\b", full_name, "fill_text"),
        (r"\bmiddle[\s_-]?name\b", profile.get("middle_name", ""), "fill_text"),
        # Email
        (r"\bemail\b", profile.get("email", ""), "fill_text"),
        # Phone number
        (r"\bphone[\s_-]?number\b|\bmobile\b|\bcell\b|\btelephone\b", profile.get("phone", ""), "fill_text"),
        (r"\bphone[\s_-]?country[\s_-]?code\b|\bcountry[\s_-]?code\b|\bcountry[\s_-]?phone\b", profile.get("address_country_name", "United States") + " (" + profile.get("phone_country_code", "+1") + ")", "select_dropdown_safe"),
        # Phone extension — skip (user typically doesn't have one)
        (r"\bphone[\s_-]?ext(ension)?\b|\bext(ension)?\b", "", "skip"),
        # Address
        (r"\baddress[\s_-]?line[\s_-]?1\b|\bstreet[\s_-]?address\b|\baddress[\s_-]?1\b", profile.get("address_street1", ""), "fill_text"),
        (r"\baddress[\s_-]?line[\s_-]?2\b|\bapt\b|\bsuite\b|\baddress[\s_-]?2\b", profile.get("address_street2", ""), "fill_text"),
        (r"\bcity\b|\btown\b", profile.get("address_city", ""), "fill_text"),
        (r"\bpostal[\s_-]?code\b|\bzip[\s_-]?code\b|\bzip\b|\bpostcode\b", profile.get("address_zip", ""), "fill_text"),
        # State - always treat as dropdown
        (r"\bstate\b|\bprovince\b|\bregion\b", profile.get("address_state", ""), "select_dropdown"),
        # Country
        (r"\bcountry\b", profile.get("address_country_name", "United States"), None),
        # URLs
        (r"\blinkedin\b", profile.get("linkedin_url", ""), "fill_text"),
        (r"\bgithub\b", profile.get("github_url", ""), "fill_text"),
        (r"\bportfolio\b|\bwebsite\b|\bpersonal[\s_-]?url\b", profile.get("portfolio_url", "") or profile.get("website_url", ""), "fill_text"),
        # Work authorization
        (r"\bauthori[sz]ed[\s_-]?to[\s_-]?work\b", profile.get("authorized_to_work_us", ""), None),
        (r"\bsponsorship\b|\bvisa[\s_-]?sponsor\b", profile.get("requires_sponsorship", ""), None),
        # Salary
        (r"\bsalary\b|\bcompensation\b|\bdesired[\s_-]?pay\b", str(profile.get("desired_salary_min", "")), "fill_text"),
        # How heard
        (r"\bhow[\s_-]?did[\s_-]?you[\s_-]?(hear|find|learn)\b|\breferral[\s_-]?source\b|\bhow.{0,10}hear\b|\bsource\b.*\bhear\b|\bhear.{0,10}about\b", profile.get("how_heard_default", "Online Job Board"), None),
        # Date of birth
        (r"\bdate[\s_-]?of[\s_-]?birth\b|\bbirthday\b|\bdob\b", profile.get("date_of_birth", ""), "fill_text"),
    ]

    mappings = []
    remaining = []
    matched_selectors = set()

    for field in fields:
        # Skip fields that already have a value — don't re-fill them
        current = (field.get("currentValue") or "").strip()
        if current and current.lower() not in ("select one", "select", "choose", "-- select --", ""):
            continue

        label = (field.get("label") or "").lower()
        name = (field.get("name") or "").lower()
        placeholder = (field.get("placeholder") or "").lower()
        field_id = (field.get("id") or "").lower()
        searchable = f"{label} {name} {placeholder} {field_id}"
        heading = (field.get("nearbyHeading") or "").lower()

        matched = False
        for pattern, value, action in rules:
            if not value and action != "skip":
                continue
            # Check for explicit exclusions before matching
            if _re.search(pattern, searchable, _re.IGNORECASE) and not _is_excluded(pattern, searchable):
                tag = field.get("tag", "").lower()
                # Determine action based on field type
                if action is None:
                    if tag == "select" or field.get("options"):
                        action = "select_dropdown"
                    elif field.get("type") in ("radio", "checkbox"):
                        action = "click_radio" if field.get("type") == "radio" else "check_checkbox"
                    else:
                        action = "fill_text"

                # For dropdowns, try to match the value to available options
                if action == "select_dropdown" and field.get("options"):
                    options = field["options"]
                    best = _match_option(value, options)
                    if best:
                        value = best

                mappings.append({
                    "selector": field["selector"],
                    "value": value,
                    "action": action,
                    "confidence": 1.0,
                    "field_label": field.get("label", ""),
                })
                matched_selectors.add(field["selector"])
                matched = True
                break

        if not matched:
            # Check if it's a "phone" field by heading context
            if "phone" in heading and "country" not in searchable and "code" not in searchable:
                phone = profile.get("phone", "")
                if phone:
                    mappings.append({
                        "selector": field["selector"],
                        "value": phone,
                        "action": "fill_text",
                        "confidence": 0.9,
                        "field_label": field.get("label", ""),
                    })
                    matched_selectors.add(field["selector"])
                    matched = True

        if not matched:
            remaining.append(field)

    return mappings, remaining


_US_STATE_ABBREVS = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
    "vermont": "VT", "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY", "district of columbia": "DC",
}
_US_ABBREV_TO_STATE = {v: k for k, v in _US_STATE_ABBREVS.items()}


def _match_option(value: str, options) -> str | None:
    """Find the best matching option for a value in a dropdown."""
    value_lower = value.lower().strip()
    option_strs = []
    for opt in options:
        if isinstance(opt, dict):
            option_strs.append(opt.get("text", opt.get("value", "")))
        else:
            option_strs.append(str(opt))

    # Exact match
    for opt in option_strs:
        if opt.lower().strip() == value_lower:
            return opt

    # State abbreviation matching (e.g., "New Mexico" matches "NM" or vice versa)
    abbrev = _US_STATE_ABBREVS.get(value_lower, "")
    full_name = _US_ABBREV_TO_STATE.get(value_lower.upper(), "")
    for opt in option_strs:
        opt_lower = opt.lower().strip()
        if abbrev and opt_lower == abbrev.lower():
            return opt
        if full_name and opt_lower == full_name:
            return opt
        # Match "NM - New Mexico" or "New Mexico (NM)" patterns
        if abbrev and abbrev.lower() in opt_lower and value_lower in opt_lower:
            return opt

    # Contains match
    for opt in option_strs:
        if value_lower in opt.lower() or opt.lower() in value_lower:
            return opt

    return None


def _trim_profile_for_autofill(profile: dict) -> dict:
    """Trim profile to essential fields for autofill, reducing prompt size for smaller AI models."""
    trimmed = {}
    # Always include personal info
    personal_keys = [
        "full_name", "middle_name", "preferred_name", "email", "phone",
        "phone_country_code", "phone_type", "additional_phone",
        "address_street1", "address_street2", "address_city", "address_state",
        "address_zip", "address_country_code", "address_country_name",
        "location", "linkedin_url", "github_url", "portfolio_url", "website_url",
        "date_of_birth", "pronouns", "drivers_license", "drivers_license_class",
        "drivers_license_state", "country_of_citizenship", "authorized_to_work_us",
        "requires_sponsorship", "authorization_type", "security_clearance",
        "clearance_status", "desired_salary_min", "desired_salary_max",
        "salary_period", "availability_date", "notice_period", "willing_to_relocate",
        "how_heard_default", "background_check_consent",
    ]
    for key in personal_keys:
        if key in profile and profile[key]:
            trimmed[key] = profile[key]

    # Include work history but only titles/companies (not full descriptions)
    if profile.get("work_history"):
        trimmed["work_history"] = [
            {k: v for k, v in job.items() if k != "description"}
            for job in profile["work_history"][:5]
        ]

    # Include education (compact)
    if profile.get("education"):
        trimmed["education"] = profile["education"][:3]

    # Include certifications (names only)
    if profile.get("certifications"):
        trimmed["certifications"] = [
            {"name": c.get("name"), "issuing_org": c.get("issuing_org")}
            for c in profile["certifications"][:5]
        ]

    # Skills as a simple list
    if profile.get("skills"):
        trimmed["skills"] = [s.get("name") for s in profile["skills"][:10]]

    # Include languages, EEO, military if present
    for key in ["languages", "eeo", "military", "references"]:
        if profile.get(key):
            trimmed[key] = profile[key]

    return trimmed


def _build_form_analysis_prompt(
    profile_summary: str,
    qa_summary: str,
    fields_summary: str,
    form_html: str,
    page_url: str,
    profile: dict | None = None,
) -> str:
    """Build the AI prompt for form field analysis and autofill mapping."""

    # Include structured fields when available, fall back to form HTML
    if fields_summary:
        fields_section = f"""STRUCTURED FORM FIELDS (JSON with id, name, type, label, placeholder, options):
{fields_summary}"""
    else:
        fields_section = ""

    # Only include raw HTML if structured fields aren't available
    if form_html and not fields_summary:
        html_section = f"""RAW FORM HTML (use for additional context — labels, grouping, nearby text):
{form_html[:4000]}"""
    else:
        html_section = ""

    # Extract key values inline so the model can't miss them
    p = profile or {}
    full_name = p.get("full_name", "")
    name_parts = full_name.split(None, 1) if full_name else ["", ""]
    first_name = name_parts[0] if len(name_parts) > 0 else ""
    last_name = name_parts[1] if len(name_parts) > 1 else ""

    quick_ref = f"""IMPORTANT — The user's name is {full_name}. First name: {first_name}. Last name: {last_name}.
Email: {p.get('email', '')}. Phone: {p.get('phone_country_code', '')} {p.get('phone', '')}.
Address: {p.get('address_street1', '')}, {p.get('address_city', '')}, {p.get('address_state', '')} {p.get('address_zip', '')}, {p.get('address_country_name', '')}.
NEVER use "John Doe", "123 Main St", "Anytown", or any placeholder. Use ONLY the values above."""

    prompt = f"""You are a job application autofill assistant. Map form fields to the user's profile data.

{quick_ref}

=== FULL PROFILE DATA ===
{profile_summary}

=== CUSTOM Q&A BANK ===
{qa_summary}

=== FORM DATA ===
{fields_section}

{html_section}

PAGE URL: {page_url}

=== OUTPUT FORMAT ===
Return a JSON array of objects, one per field to fill:
[
  {{"selector": "#field-id-or-name", "value": "the value to fill", "action": "fill_text|select_dropdown|click_radio|check_checkbox|skip", "confidence": 0.0-1.0, "field_label": "human readable label"}}
]

=== RULES (follow strictly) ===

SELECTORS:
- Use CSS selector format: #id when id exists, otherwise [name="xxx"]
- Each selector must uniquely identify one field

OPTION MATCHING (CRITICAL):
- For dropdowns (select), radio buttons, and checkboxes: you MUST pick a value that EXACTLY matches one of the provided option values or option text. Do NOT invent option values.
- If the field has an "options" array, the value MUST be one of those option values exactly as written.
- If no option is a reasonable match, set action to "skip".

MULTI-PART DATES:
- Forms often split dates into separate month/year/day dropdowns.
- For month selects: match the format of the options (e.g. "1" vs "01" vs "January" vs "Jan").
- For year selects: use the 4-digit year from the profile data.
- For day selects: use the day number matching the option format.
- Map graduation dates from education entries, employment dates from work history.

Q&A MATCHING:
- For open-ended text fields with questions (textarea, long text inputs), FIRST check the Custom Q&A Bank for a matching question_pattern before generating a generic answer.
- Match by semantic similarity, not exact string match — e.g. "Why are you interested in this role?" matches a pattern like "interest in role" or "why this company".
- If a Q&A match is found, use that answer verbatim.

PHONE FORMAT:
- Check the field's placeholder or label for format hints (e.g. "(555) 555-5555", "+1", "xxx-xxx-xxxx").
- If the form has separate country code and phone number fields, split accordingly.
- Use phone_country_code from profile if available.

EEO / VOLUNTARY SELF-IDENTIFICATION:
- Use the stored EEO preferences from the profile (gender, race_ethnicity, disability_status, veteran_status, sexual_orientation).
- If a stored preference is empty, default to "Decline to self-identify" or the closest decline/prefer-not-to-answer option.
- MUST use exact option values from the dropdown/radio options.

SALARY & COMPENSATION:
- Use desired_salary_min or desired_salary_max as appropriate.
- If the form asks for a single expected salary, use desired_salary_min.
- Include salary_period context if the form asks for it.

START DATE / AVAILABILITY:
- Use availability_date from profile if set.
- If not set and the form requires an answer, use notice_period to suggest a date.

GENERAL:
- Skip fields you cannot confidently fill (set action to "skip").
- For "How did you hear about us?" questions, use how_heard_default from profile; if empty, use "Online Job Board".
- For file upload fields, always skip.
- For CAPTCHA or verification fields, always skip.
- Return ONLY the JSON array, no other text or explanation."""

    return prompt


def create_app(db_path: str = "data/jobfinder.db", testing: bool = False) -> FastAPI:
    app = FastAPI(title="CareerPulse", lifespan=lifespan)
    app.state.db_path = db_path
    app.state.testing = testing

    app.state.scoring_progress = None
    app.state.scrape_progress = None
    app.state.notification_subscribers: list[asyncio.Queue] = []
    app.state.queue_subscribers: list[asyncio.Queue] = []
    app.state.alert_threshold = 80

    async def _broadcast_notification(notification: dict):
        for queue in list(app.state.notification_subscribers):
            try:
                queue.put_nowait(notification)
            except asyncio.QueueFull:
                pass

    async def _broadcast_queue_event(event: dict):
        for queue in list(app.state.queue_subscribers):
            try:
                queue.put_nowait(event)
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

    async def _create_follow_up_reminder(db, job_id: int, days: int = 7):
        """Auto-create a follow-up reminder N days from now when a job is marked applied."""
        from datetime import timedelta
        existing = await db.get_reminders_for_job(job_id)
        pending = [r for r in existing if r["status"] == "pending"]
        if not pending:
            remind_at = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
            await db.create_reminder(job_id, remind_at, "follow_up")
            logger.info(f"Created follow-up reminder for job {job_id} in {days} days")

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
        db: Database = app.state.db

        db_ok = False
        try:
            cursor = await db.db.execute("SELECT 1")
            await cursor.fetchone()
            db_ok = True
        except Exception:
            pass

        scheduler = getattr(app.state, "scheduler", None)
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

        ai_client = getattr(app.state, "ai_client", None)

        start = getattr(app.state, "start_time", None)
        uptime_seconds = round(_time.monotonic() - start, 1) if start else None

        body = {
            "status": "healthy" if db_ok else "unhealthy",
            "db": "ok" if db_ok else "error",
            "scheduler": scheduler_state,
            "last_scrape": last_scrape,
            "ai_provider": ai_client.provider if ai_client else None,
            "ai_configured": ai_client is not None,
            "uptime_seconds": uptime_seconds,
        }

        if not db_ok:
            return Response(
                content=json.dumps(body),
                media_type="application/json",
                status_code=503,
            )
        return body

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
        posted_within: str | None = Query(None),
    ):
        config = await app.state.db.get_search_config()
        exclude_terms = config.get("exclude_terms", []) if config else []
        jobs = await app.state.db.list_jobs(
            sort_by=sort, limit=limit, offset=offset,
            min_score=min_score, search=search, source=source,
            work_type=work_type, employment_type=employment_type,
            location=location, exclude_terms=exclude_terms,
            region=region, clearance=clearance,
            posted_within=posted_within,
        )
        return {"jobs": jobs}

    # --- Save External Jobs + Lookup (before {job_id} routes) ---

    @app.post("/api/jobs/save-external")
    async def save_external_job(request: Request):
        body = await request.json()
        title = body.get("title", "").strip()
        company = body.get("company", "").strip()
        url = body.get("url", "").strip()
        if not title or not company or not url:
            raise HTTPException(400, "title, company, and url are required")
        description = body.get("description", "")
        source = body.get("source", "external")
        job_id = await app.state.db.insert_job(
            title=title, company=company, location=body.get("location", ""),
            salary_min=body.get("salary_min"), salary_max=body.get("salary_max"),
            description=description, url=url, posted_date=body.get("posted_date"),
            application_method=body.get("application_method", "url"),
            contact_email=body.get("contact_email"),
        )
        if job_id:
            await app.state.db.insert_source(job_id, source, url)
            await app.state.db.add_event(job_id, "saved_external", f"Saved from {source}")
        return {"ok": True, "job_id": job_id}

    @app.get("/api/jobs/lookup")
    async def lookup_job_by_url(url: str = Query(...)):
        job = await app.state.db.find_job_by_url(url)
        if not job:
            return {"found": False}
        score = await app.state.db.get_score(job["id"])
        application = await app.state.db.get_application(job["id"])
        return {
            "found": True,
            "job_id": job["id"],
            "title": job["title"],
            "company": job["company"],
            "score": score["match_score"] if score else None,
            "status": application["status"] if application else None,
        }

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: int):
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        score = await app.state.db.get_score(job_id)
        sources = await app.state.db.get_sources(job_id)
        application = await app.state.db.get_application(job_id)
        events = await app.state.db.get_events(job_id)
        similar = await app.state.db.find_similar_jobs(
            job["title"], job["company"], exclude_id=job_id,
            embedding_client=app.state.embedding_client,
        )
        interview_prep = await app.state.db.get_interview_prep(job_id)
        return {**job, "score": score, "sources": sources, "application": application, "events": events, "similar": similar, "interview_prep": interview_prep}

    @app.get("/api/jobs/{job_id}/similar")
    async def get_similar_jobs(job_id: int):
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        similar = await app.state.db.find_similar_jobs(
            job["title"], job["company"], exclude_id=job_id,
            embedding_client=app.state.embedding_client,
        )
        return {"similar": similar}

    @app.post("/api/jobs/{job_id}/dismiss")
    async def dismiss_job(job_id: int):
        await app.state.db.dismiss_job(job_id)
        return {"ok": True}

    @app.post("/api/jobs/{job_id}/prepare")
    async def prepare_application(job_id: int, request: Request):
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")

        tailor = app.state.tailor
        if not tailor:
            raise HTTPException(503, "Tailor not available (no AI provider configured or no resume)")

        # Optional resume_id override
        resume_text_override = None
        try:
            body = await request.json()
            resume_id = body.get("resume_id")
            if resume_id:
                resume = await app.state.db.get_resume(resume_id)
                if not resume:
                    raise HTTPException(404, "Resume not found")
                resume_text_override = resume["resume_text"]
        except Exception:
            pass

        score = await app.state.db.get_score(job_id)
        match_reasons = score["match_reasons"] if score else []
        suggested_keywords = score["suggested_keywords"] if score else []

        result = await tailor.prepare(
            job_description=job["description"] or "",
            match_reasons=match_reasons,
            suggested_keywords=suggested_keywords,
            resume_text=resume_text_override,
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

    @app.get("/api/jobs/{job_id}/resume.docx")
    async def download_resume_docx(job_id: int):
        from app.docx_generator import generate_resume_docx
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        application = await app.state.db.get_application(job_id)
        if not application or not application.get("tailored_resume"):
            raise HTTPException(404, "No tailored resume prepared for this job")
        docx_bytes = generate_resume_docx(application["tailored_resume"])
        await app.state.db.add_event(job_id, "docx_downloaded", "Resume DOCX downloaded")
        filename = f"Resume - {job['company']} - {job['title']}.docx".replace("/", "-")
        return Response(
            content=docx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.get("/api/jobs/{job_id}/cover-letter.docx")
    async def download_cover_letter_docx(job_id: int):
        from app.docx_generator import generate_cover_letter_docx
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        application = await app.state.db.get_application(job_id)
        if not application or not application.get("cover_letter"):
            raise HTTPException(404, "No cover letter prepared for this job")
        docx_bytes = generate_cover_letter_docx(
            application["cover_letter"],
            company=job.get("company", ""),
            position=job.get("title", ""),
        )
        await app.state.db.add_event(job_id, "docx_downloaded", "Cover letter DOCX downloaded")
        filename = f"Cover Letter - {job['company']} - {job['title']}.docx".replace("/", "-")
        return Response(
            content=docx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # --- Saved Views ---

    @app.get("/api/saved-views")
    async def list_saved_views():
        views = await app.state.db.get_saved_views()
        return {"views": views}

    @app.post("/api/saved-views")
    async def create_saved_view(request: Request):
        body = await request.json()
        name = body.get("name", "").strip()
        if not name:
            raise HTTPException(400, "View name is required")
        filters = body.get("filters", {})
        view_id = await app.state.db.create_saved_view(name, filters)
        view = await app.state.db.get_saved_view(view_id)
        return {"ok": True, "view": view}

    @app.put("/api/saved-views/{view_id}")
    async def update_saved_view(view_id: int, request: Request):
        body = await request.json()
        name = body.get("name")
        filters = body.get("filters")
        if name is not None and not name.strip():
            raise HTTPException(400, "View name cannot be empty")
        updated = await app.state.db.update_saved_view(
            view_id, name=name.strip() if name else name, filters=filters
        )
        if not updated:
            raise HTTPException(404, "View not found")
        view = await app.state.db.get_saved_view(view_id)
        return {"ok": True, "view": view}

    @app.delete("/api/saved-views/{view_id}")
    async def delete_saved_view(view_id: int):
        deleted = await app.state.db.delete_saved_view(view_id)
        if not deleted:
            raise HTTPException(404, "View not found")
        return {"ok": True}

    # --- Multiple Resumes ---

    @app.get("/api/resumes")
    async def list_resumes():
        resumes = await app.state.db.get_resumes()
        return {"resumes": resumes}

    @app.post("/api/resumes")
    async def create_resume(request: Request):
        body = await request.json()
        name = body.get("name", "").strip()
        if not name:
            raise HTTPException(400, "Resume name is required")
        resume_id = await app.state.db.create_resume(
            name=name,
            resume_text=body.get("resume_text", ""),
            is_default=body.get("is_default", False),
            search_terms=body.get("search_terms"),
            job_titles=body.get("job_titles"),
            key_skills=body.get("key_skills"),
            seniority=body.get("seniority", ""),
            summary=body.get("summary", ""),
        )
        resume = await app.state.db.get_resume(resume_id)
        return {"ok": True, "resume": resume}

    @app.put("/api/resumes/{resume_id}")
    async def update_resume(resume_id: int, request: Request):
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
        updated = await app.state.db.update_resume(resume_id, **fields)
        if not updated:
            raise HTTPException(404, "Resume not found")
        resume = await app.state.db.get_resume(resume_id)
        return {"ok": True, "resume": resume}

    @app.delete("/api/resumes/{resume_id}")
    async def delete_resume(resume_id: int):
        deleted = await app.state.db.delete_resume(resume_id)
        if not deleted:
            raise HTTPException(404, "Resume not found")
        return {"ok": True}

    @app.post("/api/resumes/{resume_id}/set-default")
    async def set_default_resume(resume_id: int):
        result = await app.state.db.set_default_resume(resume_id)
        if not result:
            raise HTTPException(404, "Resume not found")
        return {"ok": True}

    # --- Response Tracking ---

    @app.post("/api/jobs/{job_id}/response")
    async def record_job_response(job_id: int, request: Request):
        body = await request.json()
        response_type = body.get("response_type", "").strip()
        valid_types = ("interview_invite", "rejection", "ghosted", "callback")
        if response_type not in valid_types:
            raise HTTPException(400, f"response_type must be one of: {', '.join(valid_types)}")
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        try:
            result = await app.state.db.record_response(job_id, response_type)
        except ValueError as e:
            raise HTTPException(404, str(e))
        return {"ok": True, **result}

    @app.get("/api/analytics/response-rates")
    async def get_response_rates():
        return await app.state.db.get_response_analytics()

    # --- Auto-Track Applied Jobs ---

    @app.post("/api/jobs/mark-applied-by-url")
    async def mark_applied_by_url(request: Request):
        body = await request.json()
        url = body.get("url", "").strip()
        if not url:
            raise HTTPException(400, "url is required")
        job = await app.state.db.find_job_by_url(url)
        if not job:
            return {"found": False, "message": "Job not tracked"}
        await app.state.db.upsert_application(job["id"], "applied")
        await app.state.db.add_event(job["id"], "auto_applied", "Auto-tracked as applied")
        return {"found": True, "job_id": job["id"], "status": "applied"}

    # --- Job Alerts ---

    @app.get("/api/alerts")
    async def list_alerts():
        alerts = await app.state.db.get_job_alerts()
        return {"alerts": alerts}

    @app.post("/api/alerts")
    async def create_alert(request: Request):
        body = await request.json()
        name = body.get("name", "").strip()
        if not name:
            raise HTTPException(400, "Alert name is required")
        alert_id = await app.state.db.create_job_alert(
            name=name,
            filters=body.get("filters", {}),
            min_score=body.get("min_score", 0),
            notify_method=body.get("notify_method", "in_app"),
        )
        alert = await app.state.db.get_job_alert(alert_id)
        return {"ok": True, "alert": alert}

    @app.put("/api/alerts/{alert_id}")
    async def update_alert(alert_id: int, request: Request):
        body = await request.json()
        fields = {}
        for key in ("name", "filters", "min_score", "enabled", "notify_method"):
            if key in body:
                fields[key] = body[key]
        if not fields:
            raise HTTPException(400, "No fields to update")
        updated = await app.state.db.update_job_alert(alert_id, **fields)
        if not updated:
            raise HTTPException(404, "Alert not found")
        alert = await app.state.db.get_job_alert(alert_id)
        return {"ok": True, "alert": alert}

    @app.delete("/api/alerts/{alert_id}")
    async def delete_alert(alert_id: int):
        deleted = await app.state.db.delete_job_alert(alert_id)
        if not deleted:
            raise HTTPException(404, "Alert not found")
        return {"ok": True}

    # --- Application Queue ---

    @app.post("/api/queue/add")
    async def add_to_queue(request: Request):
        body = await request.json()
        job_id = body.get("job_id")
        if not job_id:
            raise HTTPException(400, "job_id is required")
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        queue_id = await app.state.db.add_to_queue(
            job_id=job_id,
            resume_id=body.get("resume_id"),
            priority=body.get("priority", 0),
        )
        return {"ok": True, "queue_id": queue_id}

    @app.get("/api/queue")
    async def get_queue(status: str | None = Query(None)):
        items = await app.state.db.get_queue(status=status)
        return {"queue": items}

    @app.post("/api/queue/prepare-all")
    async def prepare_all_queued():
        tailor = app.state.tailor
        if not tailor:
            raise HTTPException(503, "Tailor not available")
        queued = await app.state.db.get_queue(status="queued")
        prepared = 0
        failed = 0
        for item in queued:
            await app.state.db.update_queue_status(item["id"], "preparing")
            try:
                job = await app.state.db.get_job(item["job_id"])
                score = await app.state.db.get_score(item["job_id"])
                reasons = score["match_reasons"] if score else []
                keywords = score["suggested_keywords"] if score else []

                resume_override = None
                if item.get("resume_id"):
                    resume = await app.state.db.get_resume(item["resume_id"])
                    if resume:
                        resume_override = resume["resume_text"]

                result = await tailor.prepare(
                    job_description=job["description"] or "",
                    match_reasons=reasons,
                    suggested_keywords=keywords,
                    resume_text=resume_override,
                )

                application = await app.state.db.get_application(item["job_id"])
                if not application:
                    app_id = await app.state.db.insert_application(item["job_id"], "prepared")
                else:
                    app_id = application["id"]
                await app.state.db.update_application(
                    app_id,
                    status="prepared",
                    tailored_resume=result.get("tailored_resume", ""),
                    cover_letter=result.get("cover_letter", ""),
                )
                await app.state.db.update_queue_status(item["id"], "ready")
                prepared += 1
            except Exception as e:
                logger.error(f"Queue prepare failed for job {item['job_id']}: {e}")
                await app.state.db.update_queue_status(item["id"], "failed")
                failed += 1
        return {"ok": True, "prepared": prepared, "failed": failed, "total": len(queued)}

    @app.post("/api/queue/{queue_id}/submit-for-review")
    async def submit_queue_for_review(queue_id: int):
        item = await app.state.db.get_queue_item(queue_id)
        if not item:
            raise HTTPException(404, "Queue item not found")
        await app.state.db.update_queue_status(queue_id, "review")
        return {"ok": True}

    @app.post("/api/queue/{queue_id}/approve")
    async def approve_queue_item(queue_id: int):
        item = await app.state.db.get_queue_item(queue_id)
        if not item:
            raise HTTPException(404, "Queue item not found")
        await app.state.db.update_queue_status(queue_id, "approved")
        await app.state.db.add_event(item["job_id"], "queue_approved", "Approved from queue")
        return {"ok": True}

    @app.post("/api/queue/{queue_id}/reject")
    async def reject_queue_item(queue_id: int):
        item = await app.state.db.get_queue_item(queue_id)
        if not item:
            raise HTTPException(404, "Queue item not found")
        await app.state.db.update_queue_status(queue_id, "rejected")
        await app.state.db.add_event(item["job_id"], "queue_rejected", "Rejected from queue")
        return {"ok": True}

    @app.post("/api/queue/{queue_id}/fill-status")
    async def update_fill_status(queue_id: int, request: Request):
        item = await app.state.db.get_queue_item(queue_id)
        if not item:
            raise HTTPException(404, "Queue item not found")
        body = await request.json()
        status = body.get("status", "filling")
        progress = body.get("progress")
        await app.state.db.update_queue_fill_status(queue_id, status, progress)
        # Broadcast to SSE subscribers
        await _broadcast_queue_event({
            "queue_id": queue_id, "job_id": item["job_id"],
            "status": status, "progress": progress,
        })
        if status == "submitted":
            await app.state.db.upsert_application(item["job_id"], "applied")
            await app.state.db.add_event(item["job_id"], "auto_applied", "Submitted via queue")
        return {"ok": True}

    @app.post("/api/queue/approve-all")
    async def approve_all_queue():
        count = await app.state.db.bulk_update_queue_status("review", "approved")
        return {"ok": True, "approved": count}

    @app.post("/api/queue/reject-all")
    async def reject_all_queue():
        count = await app.state.db.bulk_update_queue_status("review", "rejected")
        return {"ok": True, "rejected": count}

    @app.get("/api/queue/events")
    async def queue_events():
        queue = asyncio.Queue(maxsize=50)
        app.state.queue_subscribers.append(queue)

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
                if queue in app.state.queue_subscribers:
                    app.state.queue_subscribers.remove(queue)

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    @app.delete("/api/queue/{queue_id}")
    async def remove_queue_item(queue_id: int):
        removed = await app.state.db.remove_from_queue(queue_id)
        if not removed:
            raise HTTPException(404, "Queue item not found")
        return {"ok": True}

    # --- Follow-Up Templates ---

    @app.get("/api/follow-up-templates")
    async def list_follow_up_templates():
        templates = await app.state.db.get_follow_up_templates()
        return {"templates": templates}

    @app.post("/api/follow-up-templates")
    async def create_follow_up_template(request: Request):
        body = await request.json()
        name = body.get("name", "").strip()
        if not name:
            raise HTTPException(400, "Template name is required")
        template_id = await app.state.db.create_follow_up_template(
            name=name,
            days_after=body.get("days_after", 7),
            template_text=body.get("template_text", ""),
            is_default=body.get("is_default", False),
        )
        template = await app.state.db.get_follow_up_template(template_id)
        return {"ok": True, "template": template}

    @app.put("/api/follow-up-templates/{template_id}")
    async def update_follow_up_template(template_id: int, request: Request):
        body = await request.json()
        fields = {}
        for key in ("name", "days_after", "template_text", "is_default"):
            if key in body:
                fields[key] = body[key]
        if not fields:
            raise HTTPException(400, "No fields to update")
        updated = await app.state.db.update_follow_up_template(template_id, **fields)
        if not updated:
            raise HTTPException(404, "Template not found")
        template = await app.state.db.get_follow_up_template(template_id)
        return {"ok": True, "template": template}

    @app.delete("/api/follow-up-templates/{template_id}")
    async def delete_follow_up_template(template_id: int):
        deleted = await app.state.db.delete_follow_up_template(template_id)
        if not deleted:
            raise HTTPException(404, "Template not found")
        return {"ok": True}

    # --- Application Success Prediction ---

    @app.get("/api/jobs/{job_id}/predict-success")
    async def predict_success(job_id: int):
        from app.predictor import predict_success as _predict
        client = getattr(app.state, "ai_client", None)
        if not client:
            raise HTTPException(503, "AI client not configured")
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        history = await app.state.db.get_application_history_summary()

        # Enrich with similar past applications via embeddings
        emb_client = getattr(app.state, "embedding_client", None)
        db = app.state.db
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

    # --- Contacts CRM ---

    @app.get("/api/contacts")
    async def list_contacts():
        contacts = await app.state.db.get_contacts()
        return {"contacts": contacts}

    @app.post("/api/contacts")
    async def create_contact(request: Request):
        body = await request.json()
        name = body.get("name", "").strip()
        if not name:
            raise HTTPException(400, "Contact name is required")
        fields = {}
        for key in ("email", "phone", "company", "role", "linkedin_url", "notes"):
            if key in body:
                fields[key] = body[key]
        contact_id = await app.state.db.create_contact(name, **fields)
        contact = await app.state.db.get_contact(contact_id)
        return {"ok": True, "contact": contact}

    @app.put("/api/contacts/{contact_id}")
    async def update_contact(contact_id: int, request: Request):
        body = await request.json()
        fields = {}
        for key in ("name", "email", "phone", "company", "role", "linkedin_url", "notes"):
            if key in body:
                fields[key] = body[key]
        if not fields:
            raise HTTPException(400, "No fields to update")
        updated = await app.state.db.update_contact(contact_id, **fields)
        if not updated:
            raise HTTPException(404, "Contact not found")
        contact = await app.state.db.get_contact(contact_id)
        return {"ok": True, "contact": contact}

    @app.delete("/api/contacts/{contact_id}")
    async def delete_contact(contact_id: int):
        deleted = await app.state.db.delete_contact(contact_id)
        if not deleted:
            raise HTTPException(404, "Contact not found")
        return {"ok": True}

    @app.get("/api/contacts/{contact_id}/interactions")
    async def get_contact_interactions(contact_id: int):
        contact = await app.state.db.get_contact(contact_id)
        if not contact:
            raise HTTPException(404, "Contact not found")
        interactions = await app.state.db.get_contact_interactions(contact_id)
        return {"interactions": interactions}

    @app.post("/api/contacts/{contact_id}/interactions")
    async def add_contact_interaction(contact_id: int, request: Request):
        contact = await app.state.db.get_contact(contact_id)
        if not contact:
            raise HTTPException(404, "Contact not found")
        body = await request.json()
        interaction_id = await app.state.db.add_contact_interaction(
            contact_id,
            type=body.get("type", "note"),
            notes=body.get("notes", ""),
            date=body.get("date", datetime.now(timezone.utc).isoformat()),
        )
        return {"ok": True, "interaction_id": interaction_id}

    @app.get("/api/jobs/{job_id}/contacts")
    async def get_job_contacts(job_id: int):
        job = await app.state.db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        contacts = await app.state.db.get_job_contacts(job_id)
        return {"contacts": contacts}

    @app.post("/api/jobs/{job_id}/contacts")
    async def link_job_contact(job_id: int, request: Request):
        body = await request.json()
        contact_id = body.get("contact_id")
        if not contact_id:
            raise HTTPException(400, "contact_id is required")
        await app.state.db.link_job_contact(
            job_id, contact_id, relationship=body.get("relationship", "")
        )
        return {"ok": True}

    @app.delete("/api/jobs/{job_id}/contacts/{contact_id}")
    async def unlink_job_contact(job_id: int, contact_id: int):
        removed = await app.state.db.unlink_job_contact(job_id, contact_id)
        if not removed:
            raise HTTPException(404, "Link not found")
        return {"ok": True}

    # --- Career Trajectory ---

    @app.post("/api/career/analyze")
    async def analyze_career(request: Request):
        from app.career_advisor import analyze_career as _analyze
        client = getattr(app.state, "ai_client", None)
        if not client:
            raise HTTPException(503, "AI client not configured")
        db = app.state.db
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

    @app.get("/api/career/suggestions")
    async def get_career_suggestions():
        suggestions = await app.state.db.get_career_suggestions()
        return {"suggestions": suggestions}

    @app.post("/api/career/suggestions/{suggestion_id}/accept")
    async def accept_career_suggestion(suggestion_id: int):
        suggestion = await app.state.db.accept_career_suggestion(suggestion_id)
        if not suggestion:
            raise HTTPException(404, "Suggestion not found")
        config = await app.state.db.get_search_config()
        if config:
            terms = config.get("search_terms", [])
            title = suggestion.get("title", "")
            if title and title not in terms:
                terms.append(title)
                await app.state.db.update_search_terms(terms)
        return {"ok": True, "suggestion": suggestion}

    # --- Offers ---

    @app.get("/api/offers")
    async def list_offers():
        offers = await app.state.db.get_offers()
        return {"offers": offers}

    @app.get("/api/offers/compare")
    async def compare_offers():
        from app.offer_calculator import compare_offers as _compare
        offers = await app.state.db.get_offers()
        comparison = _compare(offers)
        return {"comparison": comparison}

    @app.post("/api/offers")
    async def create_offer(request: Request):
        body = await request.json()
        fields = {}
        for key in ("job_id", "base", "equity", "bonus", "pto_days", "remote_days",
                     "health_value", "retirement_match", "relocation", "location", "notes"):
            if key in body:
                fields[key] = body[key]
        offer_id = await app.state.db.create_offer(**fields)
        offer = await app.state.db.get_offer(offer_id)
        return {"ok": True, "offer": offer}

    @app.put("/api/offers/{offer_id}")
    async def update_offer(offer_id: int, request: Request):
        body = await request.json()
        fields = {}
        for key in ("job_id", "base", "equity", "bonus", "pto_days", "remote_days",
                     "health_value", "retirement_match", "relocation", "location", "notes"):
            if key in body:
                fields[key] = body[key]
        if not fields:
            raise HTTPException(400, "No fields to update")
        updated = await app.state.db.update_offer(offer_id, **fields)
        if not updated:
            raise HTTPException(404, "Offer not found")
        offer = await app.state.db.get_offer(offer_id)
        return {"ok": True, "offer": offer}

    @app.delete("/api/offers/{offer_id}")
    async def delete_offer(offer_id: int):
        deleted = await app.state.db.delete_offer(offer_id)
        if not deleted:
            raise HTTPException(404, "Offer not found")
        return {"ok": True}

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
        await _create_follow_up_reminder(db, job_id)
        return {"url": apply_url, "status": "applied"}

    @app.post("/api/jobs/{job_id}/generate-cover-letter")
    async def generate_cover_letter_endpoint(job_id: int):
        db = app.state.db
        client = app.state.ai_client
        if not client:
            raise HTTPException(503, "AI client not configured")

        job = await db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")

        config = await db.get_search_config()
        resume_text = config["resume_text"] if config else ""
        profile = await db.get_user_profile() or {}
        score = await db.get_score(job_id)
        match_reasons = score["match_reasons"] if score else []

        from app.cover_letter import generate_cover_letter
        result = await generate_cover_letter(
            client=client,
            job_title=job["title"],
            company=job["company"],
            job_description=job.get("description") or "",
            resume_text=resume_text,
            profile=profile,
            match_reasons=match_reasons,
        )

        app_record = await db.get_application(job_id)
        if app_record:
            await db.update_application(app_record["id"], cover_letter=result["cover_letter"])
        else:
            app_id = await db.insert_application(job_id, status="interested")
            await db.update_application(app_id, cover_letter=result["cover_letter"])

        return result

    @app.put("/api/jobs/{job_id}/cover-letter")
    async def save_cover_letter(job_id: int, request: Request):
        db = app.state.db
        job = await db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")

        body = await request.json()
        cover_letter = body.get("cover_letter", "")

        app_record = await db.get_application(job_id)
        if app_record:
            await db.update_application(app_record["id"], cover_letter=cover_letter)
        else:
            app_id = await db.insert_application(job_id, status="interested")
            await db.update_application(app_id, cover_letter=cover_letter)

        return {"ok": True}

    @app.post("/api/jobs/{job_id}/interview-prep")
    async def generate_interview_prep(job_id: int):
        db = app.state.db
        client = app.state.ai_client
        if not client:
            raise HTTPException(503, "AI client not configured")

        job = await db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")

        score = await db.get_score(job_id)
        company = await db.get_company(job["company"])
        work_history = await db.get_work_history()
        config = await db.get_search_config()
        resume_text = config["resume_text"] if config else ""

        company_context = ""
        if company:
            parts = []
            if company.get("description"):
                parts.append(f"About: {company['description']}")
            if company.get("glassdoor_rating"):
                parts.append(f"Glassdoor: {company['glassdoor_rating']}")
            company_context = "\n".join(parts)

        work_context = ""
        if work_history:
            entries = []
            for w in work_history[:5]:
                entry = f"- {w.get('job_title', '')} at {w.get('company', '')}"
                if w.get("description"):
                    entry += f": {w['description'][:200]}"
                entries.append(entry)
            work_context = "\n".join(entries)

        match_context = ""
        if score:
            reasons = score.get("match_reasons", [])
            concerns = score.get("concerns", [])
            if reasons:
                match_context += "Match strengths: " + "; ".join(reasons) + "\n"
            if concerns:
                match_context += "Concerns: " + "; ".join(concerns)

        # Retrieve relevant context via embeddings
        rag_context = ""
        emb_client = getattr(app.state, "embedding_client", None)
        if emb_client and getattr(db, "_vec_loaded", False):
            from app.embeddings import retrieve_relevant_context
            query = f"{job['title']} at {job['company']} {(job.get('description') or '')[:500]}"
            context_items = await retrieve_relevant_context(db.db, emb_client, query, limit=5)
            if context_items:
                rag_context = "\n".join(f"- [{c['type']}] {c['text'][:300]}" for c in context_items)

        prompt = f"""You are an interview preparation coach. Generate interview prep materials for this candidate and job.

JOB: {job['title']} at {job['company']}
DESCRIPTION: {(job.get('description') or '')[:2000]}

{f'COMPANY INFO: {company_context}' if company_context else ''}
{f'MATCH ANALYSIS: {match_context}' if match_context else ''}
{f'WORK HISTORY: {work_context}' if work_context else ''}
{f'RELEVANT EXPERIENCE: {rag_context}' if rag_context else ''}
{f'RESUME: {resume_text[:1500]}' if resume_text else ''}

Return ONLY valid JSON with this structure:
{{
    "behavioral_questions": ["5 likely behavioral questions with brief tips"],
    "technical_questions": ["5 likely technical questions based on the job requirements"],
    "star_stories": ["3 STAR-format story outlines the candidate could prepare based on their experience"],
    "talking_points": ["5 key talking points to emphasize in the interview"]
}}"""

        from app.ai_client import parse_json_response
        raw = await client.chat(prompt, max_tokens=2048)
        prep = parse_json_response(raw)

        await db.save_interview_prep(job_id, prep)
        await db.add_event(job_id, "interview_prep", "Interview prep generated")

        return {"job_id": job_id, "prep": prep}

    @app.get("/api/jobs/{job_id}/interview-prep")
    async def get_interview_prep(job_id: int):
        prep = await app.state.db.get_interview_prep(job_id)
        if not prep:
            raise HTTPException(404, "No interview prep found")
        return {"prep": prep}

    @app.post("/api/jobs/{job_id}/application")
    async def update_application(job_id: int, status: str = Query(...), notes: str = Query("")):
        db = app.state.db
        app_row = await db.get_application(job_id)
        if not app_row:
            await db.insert_application(job_id, status)
        else:
            await db.update_application(app_row["id"], status=status, notes=notes)
        if status == "applied":
            now = datetime.now(timezone.utc).isoformat()
            app_row = await db.get_application(job_id)
            if app_row and not app_row.get("applied_at"):
                await db.update_application(app_row["id"], applied_at=now)
            await _create_follow_up_reminder(db, job_id)
        await db.add_event(job_id, "status_change", f"Status changed to {status}")
        return {"ok": True}

    @app.get("/api/reminders")
    async def get_reminders(status: str = Query(None)):
        reminders = await app.state.db.get_reminders(status=status, include_job=True)
        return {"reminders": reminders}

    @app.get("/api/reminders/due")
    async def get_due_reminders():
        due = await app.state.db.get_due_reminders()
        return {"reminders": due}

    @app.post("/api/jobs/{job_id}/reminders")
    async def create_reminder(job_id: int, request: Request):
        db = app.state.db
        job = await db.get_job(job_id)
        if not job:
            raise HTTPException(404, "Job not found")
        body = await request.json()
        remind_at = body.get("remind_at")
        reminder_type = body.get("type", "follow_up")
        if not remind_at:
            raise HTTPException(400, "remind_at is required")
        rid = await db.create_reminder(job_id, remind_at, reminder_type)
        return {"ok": True, "reminder_id": rid}

    @app.post("/api/reminders/{reminder_id}/complete")
    async def complete_reminder(reminder_id: int):
        await app.state.db.complete_reminder(reminder_id)
        return {"ok": True}

    @app.post("/api/reminders/{reminder_id}/dismiss")
    async def dismiss_reminder(reminder_id: int):
        await app.state.db.dismiss_reminder(reminder_id)
        return {"ok": True}

    @app.get("/api/stats")
    async def get_stats():
        return await app.state.db.get_stats()

    @app.get("/api/analytics")
    async def get_analytics():
        return await app.state.db.get_analytics()

    @app.get("/api/skill-gaps")
    async def get_skill_gaps():
        db = app.state.db
        gap_data = await db.get_skill_gap_data(min_score=50, max_score=80)
        user_skills = await db.get_skills()
        user_skill_names = {s["name"].lower().strip() for s in user_skills if s.get("name")}
        return {
            "job_count": gap_data["job_count"],
            "top_concerns": gap_data["top_concerns"],
            "top_keywords": gap_data["top_keywords"],
            "user_skills": [s["name"] for s in user_skills],
        }

    @app.post("/api/skill-gaps/analyze")
    async def analyze_skill_gaps():
        from app.ai_client import parse_json_response
        db = app.state.db
        client = getattr(app.state, "ai_client", None)
        if not client:
            raise HTTPException(503, "AI client not configured")

        gap_data = await db.get_skill_gap_data(min_score=50, max_score=80)
        if gap_data["job_count"] == 0:
            return {"skills": [], "message": "No jobs in the 50-80 score range to analyze"}

        user_skills = await db.get_skills()
        user_skill_names = [s["name"] for s in user_skills if s.get("name")]

        prompt = f"""You are a career advisor. Analyze the skill gaps between a job seeker's current skills and the jobs they almost qualify for (scored 50-80 out of 100).

CURRENT SKILLS: {', '.join(user_skill_names) if user_skill_names else 'Not specified'}

TOP CONCERNS FROM JOB MATCHES (concern, frequency):
{chr(10).join(f'- {c}: {n} jobs' for c, n in gap_data['top_concerns'][:15])}

SUGGESTED KEYWORDS/SKILLS FROM JOB MATCHES (keyword, frequency):
{chr(10).join(f'- {k}: {n} jobs' for k, n in gap_data['top_keywords'][:15])}

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

Rank by ROI (jobs unlocked relative to learning difficulty). Return top 5 skills."""

        raw = await client.chat(prompt, max_tokens=1024)
        result = parse_json_response(raw)
        return {
            "skills": result.get("skills", []),
            "job_count": gap_data["job_count"],
        }

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

    # === Notifications ===
    @app.get("/api/notifications")
    async def get_notifications(unread: bool = Query(False)):
        db = app.state.db
        notifications = await db.get_notifications(unread_only=unread)
        count = await db.get_unread_notification_count()
        return {"notifications": notifications, "unread_count": count}

    @app.post("/api/notifications/{notification_id}/read")
    async def mark_notification_read(notification_id: int):
        await app.state.db.mark_notification_read(notification_id)
        return {"ok": True}

    @app.post("/api/notifications/read-all")
    async def mark_all_read():
        await app.state.db.mark_all_notifications_read()
        return {"ok": True}

    @app.get("/api/notifications/stream")
    async def notification_stream():
        queue: asyncio.Queue = asyncio.Queue(maxsize=50)
        app.state.notification_subscribers.append(queue)

        async def event_generator():
            try:
                while True:
                    notif = await queue.get()
                    yield f"data: {json.dumps(notif)}\n\n"
            except asyncio.CancelledError:
                pass
            finally:
                app.state.notification_subscribers.remove(queue)

        return StreamingResponse(event_generator(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

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

    @app.post("/api/digest/send-test")
    async def send_digest_test():
        from app.digest import send_digest
        success = await send_digest(app.state.db)
        if not success:
            raise HTTPException(400, "Digest not sent — check email settings and digest configuration")
        return {"ok": True, "message": "Digest sent"}

    @app.get("/api/settings/email")
    async def get_email_settings():
        settings = await app.state.db.get_email_settings()
        if settings:
            settings.pop("smtp_password", None)
        return settings or {}

    @app.post("/api/settings/email")
    async def save_email_settings(request: Request):
        data = await request.json()
        existing = await app.state.db.get_email_settings()
        if data.get("smtp_password") == "" and existing:
            data["smtp_password"] = existing.get("smtp_password", "")
        await app.state.db.update_email_settings(data)

        # Update digest scheduler job time if changed
        scheduler = getattr(app.state, "scheduler", None)
        if scheduler and scheduler.running:
            digest_time = data.get("digest_time", "08:00")
            try:
                hour, minute = digest_time.split(":")
                scheduler.reschedule_job("digest_cycle", trigger="cron", hour=int(hour), minute=int(minute))
            except Exception:
                pass

        return {"ok": True}

    @app.post("/api/settings/email/test")
    async def test_email_settings(request: Request):
        from app.emailer import send_email
        data = await request.json()
        existing = await app.state.db.get_email_settings()
        if data.get("smtp_password") == "" and existing:
            data["smtp_password"] = existing.get("smtp_password", "")
        test_to = data.get("from_address", "")
        if not test_to:
            raise HTTPException(400, "From address required for test")
        success = await send_email(
            data,
            to=test_to,
            subject="CareerPulse SMTP Test",
            body_text="Your SMTP settings are configured correctly.",
            body_html="<p>Your SMTP settings are configured correctly.</p>",
        )
        if not success:
            raise HTTPException(500, "Failed to send test email — check SMTP settings")
        return {"ok": True, "message": f"Test email sent to {test_to}"}

    @app.post("/api/jobs/{job_id}/send-email")
    async def send_job_email(job_id: int):
        from app.emailer import send_application_email
        email_settings = await app.state.db.get_email_settings()
        if not email_settings or not email_settings.get("smtp_host"):
            raise HTTPException(400, "SMTP not configured")
        application = await app.state.db.get_application(job_id)
        if not application or not application.get("email_draft"):
            raise HTTPException(400, "No email draft for this job")
        email_draft = json.loads(application["email_draft"])
        success = await send_application_email(email_settings, email_draft)
        if not success:
            raise HTTPException(500, "Failed to send email")
        await app.state.db.add_event(job_id, "email_sent", f"Email sent to {email_draft.get('to', '')}")
        return {"ok": True, "message": "Email sent"}

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
                from app.scheduler import run_scrape_cycle, run_enrichment_cycle

                db = app.state.db
                config = await db.get_search_config()
                terms = config["search_terms"] if config else []
                keys = await db.get_scraper_keys()
                scrapers = [s(search_terms=terms, scraper_keys=keys) for s in ALL_SCRAPERS]
                app.state.scrape_progress = {"completed": 0, "total": len(scrapers), "current": None, "new_jobs": 0, "active": True}
                await run_scrape_cycle(db, scrapers, search_terms=terms, progress=app.state.scrape_progress, scraper_keys=keys)

                await run_enrichment_cycle(db)
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
        from app.scheduler import run_enrichment_cycle
        enriched = await run_enrichment_cycle(app.state.db, limit=50)
        return {"enriched": enriched}

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

        profile = await app.state.db.get_full_profile()

        # Phase 1: Deterministic matching for common fields (instant, reliable)
        deterministic_mappings, remaining_fields = _deterministic_fill(form_fields, profile)

        # If all fields handled deterministically, skip AI entirely
        if not remaining_fields:
            return {"mappings": deterministic_mappings}

        # Phase 2: AI for remaining complex fields
        client = getattr(app.state, "ai_client", None)
        if not client:
            return {"mappings": deterministic_mappings, "error": "No AI provider for remaining fields"}

        custom_qa = await app.state.db.get_custom_qa()
        trimmed_profile = _trim_profile_for_autofill(profile)
        profile_summary = json.dumps(trimmed_profile, default=str, indent=2)
        qa_summary = json.dumps(custom_qa, default=str) if custom_qa else "[]"
        fields_summary = json.dumps(remaining_fields[:200], default=str, indent=2)

        prompt = _build_form_analysis_prompt(
            profile_summary=profile_summary,
            qa_summary=qa_summary,
            fields_summary=fields_summary,
            form_html=form_html,
            page_url=page_url,
            profile=profile,
        )

        try:
            response = await asyncio.wait_for(
                client.chat(prompt, max_tokens=2000),
                timeout=AUTOFILL_ANALYZE_TIMEOUT,
            )
            text = response.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text[3:]
                text = text.rsplit("```", 1)[0]
            ai_mappings = json.loads(text)
            return {"mappings": deterministic_mappings + ai_mappings}
        except asyncio.TimeoutError:
            logger.warning("Autofill analyze timed out after %ds", AUTOFILL_ANALYZE_TIMEOUT)
            return {"mappings": [], "error": f"AI analysis timed out after {AUTOFILL_ANALYZE_TIMEOUT}s"}
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
            return {"ok": True, "response": (response or "").strip()[:50]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    @app.get("/api/settings/embeddings")
    async def get_embedding_settings():
        settings = await app.state.db.get_embedding_settings()
        if not settings:
            return {
                "provider": "",
                "api_key": "",
                "model": "",
                "base_url": "",
                "dimensions": 256,
                "has_key": False,
                "enabled": False,
                "updated_at": None,
            }
        return {
            "provider": settings["provider"],
            "api_key": _mask_key(settings["api_key"]),
            "model": settings["model"],
            "base_url": settings["base_url"],
            "dimensions": settings["dimensions"],
            "has_key": bool(settings["api_key"]),
            "enabled": bool(app.state.embedding_client),
            "updated_at": settings["updated_at"],
        }

    @app.post("/api/settings/embeddings")
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
            existing = await app.state.db.get_embedding_settings()
            if existing:
                api_key = existing["api_key"]

        await app.state.db.save_embedding_settings(provider, api_key, model, base_url, dimensions)

        # Re-initialize embedding client
        app.state.embedding_client = await _init_embedding_client(app.state.db)

        return {"ok": True, "provider": provider, "enabled": bool(app.state.embedding_client)}

    @app.post("/api/embeddings/backfill")
    async def backfill_embeddings(request: Request):
        client = app.state.embedding_client
        if not client:
            raise HTTPException(400, "Embeddings not configured")

        db = app.state.db
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
