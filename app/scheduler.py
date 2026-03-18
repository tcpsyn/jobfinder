import asyncio
import logging

from app.circuit_breaker import CircuitBreaker
from app.database import Database, make_dedup_hash

logger = logging.getLogger(__name__)

_scraper_breaker = CircuitBreaker(failure_threshold=5, cooldown_seconds=300.0)
_enrichment_semaphore = asyncio.Semaphore(3)

# Track consecutive zero-result runs per scraper for health monitoring
_consecutive_zero_runs: dict[str, int] = {}
ZERO_RESULT_WARN_THRESHOLD = 3


async def run_scrape_cycle(db: Database, scrapers: list, search_terms: list[str] | None = None, progress: dict | None = None, scraper_keys: dict | None = None) -> int:
    """Scrape job boards and insert new listings. Scrape-only — no enrichment or scoring."""
    total_new = 0
    total_scrapers = len(scrapers)
    for i, scraper_instance in enumerate(scrapers):
        if isinstance(scraper_instance, type):
            scraper_instance = scraper_instance(search_terms=search_terms, scraper_keys=scraper_keys or {})
        source_name = scraper_instance.source_name
        # Check per-source schedule
        if not await db.should_scraper_run(source_name):
            logger.info(f"Skipping {source_name} — not yet due")
            if progress is not None:
                progress.update({"completed": i + 1, "total": total_scrapers, "current": source_name, "new_jobs": total_new, "active": True})
            continue
        if _scraper_breaker.is_open(f"scraper:{source_name}"):
            logger.info(f"Circuit breaker open for {source_name}, skipping")
            if progress is not None:
                progress.update({"completed": i + 1, "total": total_scrapers, "current": source_name, "new_jobs": total_new, "active": True})
            continue
        logger.info(f"Scraping {source_name}...")
        if progress is not None:
            progress.update({"completed": i, "total": total_scrapers, "current": source_name, "new_jobs": total_new, "active": True})
        try:
            listings = await scraper_instance.scrape()
            _scraper_breaker.record_success(f"scraper:{source_name}")
        except Exception as e:
            _scraper_breaker.record_failure(f"scraper:{source_name}")
            logger.error(f"Scraper {source_name} failed: {e}")
            continue

        for listing in listings:
            dedup = make_dedup_hash(listing.title, listing.company, listing.url)
            existing = await db.find_job_by_hash(dedup)
            if existing:
                await db.insert_source(existing["id"], source_name, listing.url)
            else:
                job_id = await db.insert_job(
                    title=listing.title,
                    company=listing.company,
                    location=listing.location,
                    salary_min=listing.salary_min,
                    salary_max=listing.salary_max,
                    description=listing.description,
                    url=listing.url,
                    posted_date=listing.posted_date,
                    application_method=listing.application_method,
                    contact_email=listing.contact_email,
                )
                if job_id:
                    # Check for cross-source duplicates
                    dupes = await db.find_cross_source_dupes(job_id, listing.title, listing.company)
                    if dupes:
                        # Merge: add source to oldest existing job, dismiss this new one
                        oldest = dupes[0]
                        await db.insert_source(oldest["id"], source_name, listing.url)
                        await db.dismiss_job(job_id)
                        logger.debug(f"Dedup: merged '{listing.title}' @ {listing.company} into job {oldest['id']}")
                    else:
                        await db.insert_source(job_id, source_name, listing.url)
                        total_new += 1

        logger.info(f"{source_name}: found {len(listings)} listings")

        # Health tracking: warn on consecutive zero-result runs
        if len(listings) == 0:
            _consecutive_zero_runs[source_name] = _consecutive_zero_runs.get(source_name, 0) + 1
            zeros = _consecutive_zero_runs[source_name]
            if zeros >= ZERO_RESULT_WARN_THRESHOLD:
                logger.warning(
                    f"SCRAPER HEALTH: {source_name} returned 0 results for "
                    f"{zeros} consecutive runs — may be broken or blocked"
                )
        else:
            _consecutive_zero_runs[source_name] = 0

        await db.mark_scraper_ran(source_name)

    if progress is not None:
        progress.update({"completed": total_scrapers, "total": total_scrapers, "current": None, "new_jobs": total_new, "active": False})
    logger.info(f"Scrape cycle complete. {total_new} new jobs added.")
    return total_new


async def run_enrichment_cycle(db: Database, limit: int = 30) -> int:
    """Enrich jobs with short/missing descriptions. Runs independently of scraping."""
    from app.enrichment import enrich_job_description

    async with _enrichment_semaphore:
        jobs_to_enrich = await db.get_jobs_needing_enrichment(limit=limit)
        enriched_count = 0
        for job in jobs_to_enrich:
            sources = await db.get_sources(job["id"])
            source = sources[0]["source_name"] if sources else "unknown"
            attempts = (job.get("enrichment_attempts") or 0) + 1
            desc = await enrich_job_description(job["url"], source)
            if desc and len(desc) > len(job.get("description") or ""):
                await db.update_job_description(job["id"], desc)
                await db.update_enrichment_status(job["id"], "enriched", attempts)
                enriched_count += 1
            else:
                await db.update_enrichment_status(job["id"], "failed", attempts)
        if enriched_count:
            logger.info(f"Enriched {enriched_count}/{len(jobs_to_enrich)} job descriptions")
        return enriched_count


async def run_maintenance_cycle(db: Database) -> int:
    """Auto-dismiss stale jobs. Runs independently on a daily schedule."""
    dismissed = await db.auto_dismiss_stale()
    if dismissed:
        logger.info(f"Auto-dismissed {dismissed} stale jobs")
    return dismissed


async def run_alert_check(db: Database) -> int:
    """Check enabled job alerts for new matching jobs. Creates notifications."""
    alerts = await db.get_job_alerts()
    total_notifications = 0
    for alert in alerts:
        if not alert.get("enabled"):
            continue
        new_jobs = await db.get_new_jobs_for_alert(alert)
        for job in new_jobs:
            title = f"Alert: {alert['name']}"
            message = f"{job['title']} at {job['company']}"
            score = job.get("match_score")
            if score:
                message += f" (Score: {score})"
            await db.insert_notification(job["id"], "alert", title, message)
            total_notifications += 1
        await db.mark_alert_checked(alert["id"])
    if total_notifications:
        logger.info(f"Job alerts: {total_notifications} notifications created")
    return total_notifications


async def run_reminder_check(db: Database, embedding_client=None) -> list[dict]:
    """Check for due follow-up reminders. Auto-drafts if configured. Returns list of due reminders."""
    due = await db.get_due_reminders()
    if due:
        logger.info(f"Found {len(due)} due follow-up reminders")
    for reminder in due:
        if reminder.get("auto_draft") and not reminder.get("draft_text"):
            try:
                from app.follow_up import draft_follow_up
                ai_settings = await db.get_ai_settings()
                if ai_settings and ai_settings.get("provider"):
                    from app.ai_client import AIClient
                    client = AIClient(
                        ai_settings["provider"],
                        api_key=ai_settings.get("api_key", ""),
                        model=ai_settings.get("model", ""),
                    )
                    app_data = await db.get_application(reminder["job_id"])
                    applied_at = app_data.get("applied_at", "") if app_data else ""
                    days = 0
                    if applied_at:
                        from datetime import datetime, timezone
                        try:
                            days = (datetime.now(timezone.utc) - datetime.fromisoformat(applied_at)).days
                        except (ValueError, TypeError):
                            pass

                    # Retrieve past contact interactions for this company via embeddings
                    template_text = None
                    if embedding_client and getattr(db, "_vec_loaded", False):
                        from app.embeddings import retrieve_relevant_context
                        company = reminder.get("company", "")
                        query = f"follow-up with {company} {reminder.get('title', '')}"
                        context_items = await retrieve_relevant_context(
                            db.db, embedding_client, query, limit=3
                        )
                        if context_items:
                            template_text = "Previous interactions:\n" + "\n".join(
                                f"- {c['text'][:200]}" for c in context_items
                            )

                    draft = await draft_follow_up(
                        client,
                        title=reminder.get("title", ""),
                        company=reminder.get("company", ""),
                        applied_at=applied_at,
                        days_since=days,
                        template_text=template_text,
                    )
                    if draft:
                        await db.update_reminder_draft(reminder["id"], draft)
                        logger.info(f"Auto-drafted follow-up for reminder {reminder['id']}")
            except Exception as e:
                logger.error(f"Auto-draft failed for reminder {reminder['id']}: {e}")
    return due


async def run_context_embedding_cycle(db: Database, embedding_client, batch_size: int = 20) -> int:
    """Sync context items (work history, contact interactions) and embed them."""
    if not embedding_client:
        return 0
    if not getattr(db, "_vec_loaded", False):
        return 0

    from app.embeddings import upsert_embedding

    # Sync work history descriptions into context_items
    cursor = await db.db.execute(
        """SELECT id, job_title, company, description FROM work_history
           WHERE description != ''"""
    )
    for row in await cursor.fetchall():
        text = f"{row['job_title']} at {row['company']}: {row['description']}"
        existing = await db.db.execute(
            "SELECT id FROM context_items WHERE type = 'work_history' AND source_id = ?",
            (row["id"],),
        )
        if not await existing.fetchone():
            await db.db.execute(
                "INSERT INTO context_items (type, source_id, text) VALUES (?, ?, ?)",
                ("work_history", row["id"], text),
            )

    # Sync contact interaction notes
    cursor = await db.db.execute(
        """SELECT ci.id, ci.notes, c.name, c.company
           FROM contact_interactions ci
           JOIN contacts c ON c.id = ci.contact_id
           WHERE ci.notes != ''"""
    )
    for row in await cursor.fetchall():
        text = f"Interaction with {row['name']} ({row['company']}): {row['notes']}"
        existing = await db.db.execute(
            "SELECT id FROM context_items WHERE type = 'contact_interaction' AND source_id = ?",
            (row["id"],),
        )
        if not await existing.fetchone():
            await db.db.execute(
                "INSERT INTO context_items (type, source_id, text) VALUES (?, ?, ?)",
                ("contact_interaction", row["id"], text),
            )

    await db.db.commit()

    # Embed unembedded context items
    cursor = await db.db.execute(
        "SELECT id, text FROM context_items WHERE embedded = 0 LIMIT ?",
        (batch_size,),
    )
    items = await cursor.fetchall()
    embedded = 0
    for item in items:
        try:
            vector = await embedding_client.embed(item["text"][:8000])
            await upsert_embedding(db.db, "vec_context", item["id"], vector)
            await db.db.execute(
                "UPDATE context_items SET embedded = 1 WHERE id = ?", (item["id"],)
            )
            embedded += 1
        except Exception as e:
            logger.warning("Failed to embed context item %d: %s", item["id"], e)

    if embedded:
        await db.db.commit()
        logger.info(f"Context embedding cycle: embedded {embedded}/{len(items)} items")
    return embedded


async def run_job_embedding_cycle(db: Database, embedding_client, batch_size: int = 20) -> int:
    """Embed jobs that don't have embeddings yet. Runs every 2 hours."""
    if not embedding_client:
        return 0
    if not getattr(db, "_vec_loaded", False):
        return 0

    from app.embeddings import upsert_embedding

    cursor = await db.db.execute(
        """SELECT j.id, j.title, j.company, j.description
           FROM jobs j
           LEFT JOIN vec_jobs v ON v.item_id = j.id
           WHERE j.dismissed = 0 AND v.item_id IS NULL
           LIMIT ?""",
        (batch_size,),
    )
    jobs = await cursor.fetchall()
    if not jobs:
        return 0

    embedded = 0
    for job in jobs:
        text = f"{job['title']} at {job['company']}\n{job['description'] or ''}"
        try:
            vector = await embedding_client.embed(text[:8000])
            await upsert_embedding(db.db, "vec_jobs", job["id"], vector)
            embedded += 1
        except Exception as e:
            logger.warning("Failed to embed job %d: %s", job["id"], e)

    if embedded:
        logger.info(f"Embedding cycle: embedded {embedded}/{len(jobs)} jobs")
    return embedded


async def run_digest_cycle(db: Database) -> bool:
    """Check if digest is enabled and send it. Called by APScheduler."""
    from app.digest import send_digest
    try:
        return await send_digest(db)
    except Exception as e:
        logger.error(f"Digest cycle failed: {e}")
        return False
