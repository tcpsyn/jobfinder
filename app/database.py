import asyncio
import hashlib
import json
import logging
import re
import struct
from datetime import datetime, timedelta, timezone

import aiosqlite

logger = logging.getLogger(__name__)


def make_dedup_hash(title: str, company: str, url: str) -> str:
    normalized = f"{title.lower().strip()}|{company.lower().strip()}|{url.lower().strip().rstrip('/')}"
    return hashlib.sha256(normalized.encode()).hexdigest()


def _normalize_company(name: str) -> str:
    """Normalize company name for fuzzy comparison."""
    name = name.lower().strip()
    for suffix in [" inc.", " inc", " llc", " ltd", " ltd.", " corp", " corporation",
                   " co.", " co", " company", " group", " technologies", " technology"]:
        if name.endswith(suffix):
            name = name[:-len(suffix)].strip()
    return re.sub(r"[^a-z0-9 ]", "", name).strip()


def _title_similarity(t1: str, t2: str) -> float:
    """Word overlap ratio between two job titles."""
    w1 = set(t1.lower().split())
    w2 = set(t2.lower().split())
    if not w1 or not w2:
        return 0.0
    intersection = w1 & w2
    return len(intersection) / max(len(w1), len(w2))


_COLUMN_ALLOWLISTS = {
    "applications": {
        "status", "tailored_resume", "cover_letter", "email_draft", "applied_at",
        "notes", "rejected_at", "offered_at", "withdrawn_at",
        "response_received_at", "response_type", "days_to_response",
    },
    "work_history": {
        "user_id", "company", "job_title", "location_city", "location_state",
        "location_country", "start_month", "start_year", "end_month", "end_year",
        "is_current", "description", "salary_at_position", "sort_order",
    },
    "education": {
        "user_id", "school", "degree_type", "field_of_study", "minor",
        "start_month", "start_year", "grad_month", "grad_year", "gpa", "honors",
        "sort_order",
    },
    "certifications": {
        "user_id", "name", "issuing_org", "cert_type", "license_number",
        "state", "date_obtained", "expiration_date",
    },
    "skills": {
        "user_id", "name", "years_experience", "proficiency",
    },
    "languages": {
        "user_id", "language", "proficiency",
    },
    "user_references": {
        "user_id", "name", "title", "company", "phone", "email",
        "relationship", "years_known",
    },
    "military_service": {
        "user_id", "branch", "rank", "specialty", "start_date", "end_date",
    },
    "eeo_responses": {
        "gender", "race_ethnicity", "disability_status", "veteran_status",
        "veteran_categories", "sexual_orientation",
    },
    "companies": {
        "name", "normalized_name", "website", "description", "size",
        "industry", "glassdoor_rating", "updated_at",
    },
    "jobs": {
        "title", "company", "location", "salary_min", "salary_max",
        "description", "url", "posted_date", "application_method",
        "contact_email", "dismissed", "hiring_manager_name",
        "hiring_manager_email", "hiring_manager_title",
        "contact_lookup_done", "apply_url", "salary_estimate_min",
        "salary_estimate_max", "salary_confidence",
        "description_enriched", "enrichment_status", "enrichment_attempts",
    },
    "custom_qa": {
        "question_pattern", "category", "answer", "times_used", "last_used",
    },
    "resumes": {
        "name", "resume_text", "is_default", "search_terms", "job_titles",
        "key_skills", "seniority", "summary", "updated_at",
    },
    "job_alerts": {
        "name", "filters", "min_score", "enabled", "notify_method",
        "last_checked_at",
    },
    "follow_up_templates": {
        "name", "days_after", "template_text", "is_default",
    },
    "contacts": {
        "name", "email", "phone", "company", "role", "linkedin_url",
        "notes", "updated_at",
    },
    "offers": {
        "job_id", "base", "equity", "bonus", "pto_days", "remote_days",
        "health_value", "retirement_match", "relocation", "location", "notes",
    },
}

_VALID_REPLACE_TABLES = {
    "work_history", "education", "certifications", "skills",
    "languages", "user_references",
}


def _validate_columns(table: str, columns):
    allowed = _COLUMN_ALLOWLISTS.get(table)
    if allowed is None:
        raise ValueError(f"No column allowlist for table: {table}")
    bad = set(columns) - allowed
    if bad:
        raise ValueError(f"Invalid columns for {table}: {bad}")


class Database:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.db = None

    async def init(self):
        self.db = await aiosqlite.connect(self.db_path)
        self.db.row_factory = aiosqlite.Row
        await self.db.execute("PRAGMA foreign_keys = ON")
        await self.db.execute("PRAGMA journal_mode = WAL")
        await self._load_vec_extension()
        await self._create_tables()

    async def _load_vec_extension(self):
        try:
            import sqlite_vec
            db = self.db

            def _load():
                db._connection.enable_load_extension(True)
                sqlite_vec.load(db._connection)
                db._connection.enable_load_extension(False)

            await db._execute(_load)
            self._vec_loaded = True
        except Exception as e:
            logger.warning("sqlite-vec extension not available: %s", e)
            self._vec_loaded = False

    async def _ensure_vec_tables(self, dimensions: int = 256):
        if not self._vec_loaded:
            return
        from app.embeddings import ensure_vec_tables
        await ensure_vec_tables(self.db, dimensions=dimensions)

    async def close(self):
        if self.db:
            await self.db.close()

    async def _create_tables(self):
        await self.db.executescript("""
            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                company TEXT NOT NULL,
                location TEXT,
                salary_min INTEGER,
                salary_max INTEGER,
                description TEXT,
                url TEXT NOT NULL,
                posted_date TEXT,
                application_method TEXT DEFAULT 'url',
                contact_email TEXT,
                dedup_hash TEXT UNIQUE NOT NULL,
                dismissed INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                source_name TEXT NOT NULL,
                source_url TEXT,
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS job_scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER UNIQUE NOT NULL,
                match_score INTEGER NOT NULL,
                match_reasons TEXT NOT NULL,
                concerns TEXT NOT NULL,
                suggested_keywords TEXT NOT NULL,
                scored_at TEXT NOT NULL,
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS applications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER UNIQUE NOT NULL,
                status TEXT NOT NULL DEFAULT 'interested',
                tailored_resume TEXT,
                cover_letter TEXT,
                email_draft TEXT,
                applied_at TEXT,
                notes TEXT,
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS search_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                resume_text TEXT NOT NULL DEFAULT '',
                search_terms TEXT NOT NULL DEFAULT '[]',
                job_titles TEXT NOT NULL DEFAULT '[]',
                key_skills TEXT NOT NULL DEFAULT '[]',
                seniority TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                ats_score INTEGER NOT NULL DEFAULT 0,
                ats_issues TEXT NOT NULL DEFAULT '[]',
                ats_tips TEXT NOT NULL DEFAULT '[]',
                exclude_terms TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS ai_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                provider TEXT NOT NULL DEFAULT 'anthropic',
                api_key TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                base_url TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_dedup ON jobs(dedup_hash);
            CREATE INDEX IF NOT EXISTS idx_scores_job ON job_scores(job_id);
            CREATE INDEX IF NOT EXISTS idx_sources_job ON sources(job_id);
            CREATE TABLE IF NOT EXISTS user_profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                full_name TEXT NOT NULL DEFAULT '',
                email TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                location TEXT NOT NULL DEFAULT '',
                linkedin_url TEXT NOT NULL DEFAULT '',
                github_url TEXT NOT NULL DEFAULT '',
                portfolio_url TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_job ON app_events(job_id);
            CREATE TABLE IF NOT EXISTS work_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 1,
                company TEXT NOT NULL DEFAULT '',
                job_title TEXT NOT NULL DEFAULT '',
                location_city TEXT NOT NULL DEFAULT '',
                location_state TEXT NOT NULL DEFAULT '',
                location_country TEXT NOT NULL DEFAULT '',
                start_month INTEGER,
                start_year INTEGER,
                end_month INTEGER,
                end_year INTEGER,
                is_current INTEGER DEFAULT 0,
                description TEXT NOT NULL DEFAULT '',
                salary_at_position TEXT NOT NULL DEFAULT '',
                sort_order INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS education (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 1,
                school TEXT NOT NULL DEFAULT '',
                degree_type TEXT NOT NULL DEFAULT '',
                field_of_study TEXT NOT NULL DEFAULT '',
                minor TEXT NOT NULL DEFAULT '',
                start_month INTEGER,
                start_year INTEGER,
                grad_month INTEGER,
                grad_year INTEGER,
                gpa TEXT NOT NULL DEFAULT '',
                honors TEXT NOT NULL DEFAULT '',
                sort_order INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS certifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 1,
                name TEXT NOT NULL DEFAULT '',
                issuing_org TEXT NOT NULL DEFAULT '',
                cert_type TEXT NOT NULL DEFAULT 'certification',
                license_number TEXT NOT NULL DEFAULT '',
                state TEXT NOT NULL DEFAULT '',
                date_obtained TEXT NOT NULL DEFAULT '',
                expiration_date TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS skills (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 1,
                name TEXT NOT NULL DEFAULT '',
                years_experience INTEGER,
                proficiency TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS languages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 1,
                language TEXT NOT NULL DEFAULT '',
                proficiency TEXT NOT NULL DEFAULT 'conversational'
            );
            CREATE TABLE IF NOT EXISTS user_references (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 1,
                name TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                company TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                email TEXT NOT NULL DEFAULT '',
                relationship TEXT NOT NULL DEFAULT '',
                years_known INTEGER
            );
            CREATE TABLE IF NOT EXISTS military_service (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 1 CHECK (user_id = 1),
                branch TEXT NOT NULL DEFAULT '',
                rank TEXT NOT NULL DEFAULT '',
                specialty TEXT NOT NULL DEFAULT '',
                start_date TEXT NOT NULL DEFAULT '',
                end_date TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS eeo_responses (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                gender TEXT NOT NULL DEFAULT '',
                race_ethnicity TEXT NOT NULL DEFAULT '',
                disability_status TEXT NOT NULL DEFAULT '',
                veteran_status TEXT NOT NULL DEFAULT '',
                veteran_categories TEXT NOT NULL DEFAULT '[]',
                sexual_orientation TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS custom_qa (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_pattern TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT '',
                answer TEXT NOT NULL DEFAULT '',
                times_used INTEGER DEFAULT 0,
                last_used TEXT
            );
            CREATE TABLE IF NOT EXISTS autofill_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_url TEXT NOT NULL DEFAULT '',
                job_title TEXT NOT NULL DEFAULT '',
                company TEXT NOT NULL DEFAULT '',
                fields_filled TEXT NOT NULL DEFAULT '[]',
                fields_skipped TEXT NOT NULL DEFAULT '[]',
                new_data_saved TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scraper_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                api_key TEXT NOT NULL DEFAULT '',
                email TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS companies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                normalized_name TEXT UNIQUE NOT NULL,
                website TEXT,
                description TEXT,
                size TEXT,
                industry TEXT,
                glassdoor_rating REAL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scraper_schedule (
                source_name TEXT PRIMARY KEY,
                interval_hours INTEGER NOT NULL DEFAULT 6,
                last_scraped_at TEXT
            );
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                type TEXT NOT NULL DEFAULT 'high_score',
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                read INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS email_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                smtp_host TEXT NOT NULL DEFAULT '',
                smtp_port INTEGER NOT NULL DEFAULT 587,
                smtp_username TEXT NOT NULL DEFAULT '',
                smtp_password TEXT NOT NULL DEFAULT '',
                smtp_use_tls INTEGER NOT NULL DEFAULT 1,
                from_address TEXT NOT NULL DEFAULT '',
                to_address TEXT NOT NULL DEFAULT '',
                digest_enabled INTEGER NOT NULL DEFAULT 0,
                digest_schedule TEXT NOT NULL DEFAULT 'daily',
                digest_time TEXT NOT NULL DEFAULT '08:00',
                digest_min_score INTEGER NOT NULL DEFAULT 60,
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS saved_views (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                filters TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS resumes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                resume_text TEXT NOT NULL DEFAULT '',
                is_default INTEGER NOT NULL DEFAULT 0,
                search_terms TEXT NOT NULL DEFAULT '[]',
                job_titles TEXT NOT NULL DEFAULT '[]',
                key_skills TEXT NOT NULL DEFAULT '[]',
                seniority TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_url ON jobs(url);
            CREATE TABLE IF NOT EXISTS job_alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                filters TEXT NOT NULL DEFAULT '{}',
                min_score INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                notify_method TEXT NOT NULL DEFAULT 'in_app',
                last_checked_at TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS application_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER UNIQUE NOT NULL,
                resume_id INTEGER,
                status TEXT NOT NULL DEFAULT 'queued',
                priority INTEGER NOT NULL DEFAULT 0,
                queued_at TEXT NOT NULL,
                prepared_at TEXT,
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
                FOREIGN KEY (resume_id) REFERENCES resumes(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS follow_up_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                days_after INTEGER NOT NULL DEFAULT 7,
                template_text TEXT NOT NULL DEFAULT '',
                is_default INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL DEFAULT '',
                phone TEXT NOT NULL DEFAULT '',
                company TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL DEFAULT '',
                linkedin_url TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS contact_interactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                contact_id INTEGER NOT NULL,
                type TEXT NOT NULL DEFAULT 'note',
                notes TEXT NOT NULL DEFAULT '',
                date TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS job_contacts (
                job_id INTEGER NOT NULL,
                contact_id INTEGER NOT NULL,
                relationship TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (job_id, contact_id),
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
                FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS career_suggestions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                reasoning TEXT NOT NULL DEFAULT '',
                transferable_skills TEXT NOT NULL DEFAULT '[]',
                gaps TEXT NOT NULL DEFAULT '[]',
                accepted INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS offers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER,
                base INTEGER NOT NULL DEFAULT 0,
                equity INTEGER NOT NULL DEFAULT 0,
                bonus INTEGER NOT NULL DEFAULT 0,
                pto_days INTEGER NOT NULL DEFAULT 0,
                remote_days INTEGER NOT NULL DEFAULT 0,
                health_value INTEGER NOT NULL DEFAULT 0,
                retirement_match REAL NOT NULL DEFAULT 0,
                relocation INTEGER NOT NULL DEFAULT 0,
                location TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS context_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                source_id INTEGER NOT NULL,
                text TEXT NOT NULL,
                embedded INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_context_type_source ON context_items(type, source_id);
            CREATE TABLE IF NOT EXISTS embedding_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                provider TEXT NOT NULL DEFAULT 'openai',
                api_key TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                base_url TEXT NOT NULL DEFAULT '',
                dimensions INTEGER NOT NULL DEFAULT 256,
                updated_at TEXT NOT NULL DEFAULT ''
            );
        """)
        await self._migrate()
        await self.db.commit()
        await self._ensure_vec_tables()

    async def _migrate(self):
        cursor = await self.db.execute("PRAGMA table_info(search_config)")
        columns = {row[1] for row in await cursor.fetchall()}
        if not columns:
            return
        migrations = {
            "job_titles": "ALTER TABLE search_config ADD COLUMN job_titles TEXT NOT NULL DEFAULT '[]'",
            "key_skills": "ALTER TABLE search_config ADD COLUMN key_skills TEXT NOT NULL DEFAULT '[]'",
            "seniority": "ALTER TABLE search_config ADD COLUMN seniority TEXT NOT NULL DEFAULT ''",
            "summary": "ALTER TABLE search_config ADD COLUMN summary TEXT NOT NULL DEFAULT ''",
            "ats_score": "ALTER TABLE search_config ADD COLUMN ats_score INTEGER NOT NULL DEFAULT 0",
            "ats_issues": "ALTER TABLE search_config ADD COLUMN ats_issues TEXT NOT NULL DEFAULT '[]'",
            "ats_tips": "ALTER TABLE search_config ADD COLUMN ats_tips TEXT NOT NULL DEFAULT '[]'",
            "exclude_terms": "ALTER TABLE search_config ADD COLUMN exclude_terms TEXT NOT NULL DEFAULT '[]'",
        }
        for col, sql in migrations.items():
            if col not in columns:
                await self.db.execute(sql)

        # Jobs table migrations
        jobs_cursor = await self.db.execute("PRAGMA table_info(jobs)")
        jobs_columns = {row[1] for row in await jobs_cursor.fetchall()}
        jobs_migrations = {
            "hiring_manager_name": "ALTER TABLE jobs ADD COLUMN hiring_manager_name TEXT",
            "hiring_manager_email": "ALTER TABLE jobs ADD COLUMN hiring_manager_email TEXT",
            "hiring_manager_title": "ALTER TABLE jobs ADD COLUMN hiring_manager_title TEXT",
            "contact_lookup_done": "ALTER TABLE jobs ADD COLUMN contact_lookup_done INTEGER DEFAULT 0",
            "apply_url": "ALTER TABLE jobs ADD COLUMN apply_url TEXT",
            "salary_estimate_min": "ALTER TABLE jobs ADD COLUMN salary_estimate_min INTEGER",
            "salary_estimate_max": "ALTER TABLE jobs ADD COLUMN salary_estimate_max INTEGER",
            "salary_confidence": "ALTER TABLE jobs ADD COLUMN salary_confidence TEXT",
            "description_enriched": "ALTER TABLE jobs ADD COLUMN description_enriched INTEGER DEFAULT 0",
            "enrichment_status": "ALTER TABLE jobs ADD COLUMN enrichment_status TEXT DEFAULT 'pending'",
            "enrichment_attempts": "ALTER TABLE jobs ADD COLUMN enrichment_attempts INTEGER DEFAULT 0",
        }
        for col, sql in jobs_migrations.items():
            if col not in jobs_columns:
                await self.db.execute(sql)

        # user_profile migrations - add new columns
        profile_cursor = await self.db.execute("PRAGMA table_info(user_profile)")
        profile_columns = {row[1] for row in await profile_cursor.fetchall()}
        profile_migrations = {
            "middle_name": "ALTER TABLE user_profile ADD COLUMN middle_name TEXT NOT NULL DEFAULT ''",
            "preferred_name": "ALTER TABLE user_profile ADD COLUMN preferred_name TEXT NOT NULL DEFAULT ''",
            "phone_country_code": "ALTER TABLE user_profile ADD COLUMN phone_country_code TEXT NOT NULL DEFAULT ''",
            "phone_type": "ALTER TABLE user_profile ADD COLUMN phone_type TEXT NOT NULL DEFAULT ''",
            "additional_phone": "ALTER TABLE user_profile ADD COLUMN additional_phone TEXT NOT NULL DEFAULT ''",
            "address_street1": "ALTER TABLE user_profile ADD COLUMN address_street1 TEXT NOT NULL DEFAULT ''",
            "address_street2": "ALTER TABLE user_profile ADD COLUMN address_street2 TEXT NOT NULL DEFAULT ''",
            "address_city": "ALTER TABLE user_profile ADD COLUMN address_city TEXT NOT NULL DEFAULT ''",
            "address_state": "ALTER TABLE user_profile ADD COLUMN address_state TEXT NOT NULL DEFAULT ''",
            "address_zip": "ALTER TABLE user_profile ADD COLUMN address_zip TEXT NOT NULL DEFAULT ''",
            "address_country_code": "ALTER TABLE user_profile ADD COLUMN address_country_code TEXT NOT NULL DEFAULT ''",
            "address_country_name": "ALTER TABLE user_profile ADD COLUMN address_country_name TEXT NOT NULL DEFAULT ''",
            "perm_address_street1": "ALTER TABLE user_profile ADD COLUMN perm_address_street1 TEXT NOT NULL DEFAULT ''",
            "perm_address_street2": "ALTER TABLE user_profile ADD COLUMN perm_address_street2 TEXT NOT NULL DEFAULT ''",
            "perm_address_city": "ALTER TABLE user_profile ADD COLUMN perm_address_city TEXT NOT NULL DEFAULT ''",
            "perm_address_state": "ALTER TABLE user_profile ADD COLUMN perm_address_state TEXT NOT NULL DEFAULT ''",
            "perm_address_zip": "ALTER TABLE user_profile ADD COLUMN perm_address_zip TEXT NOT NULL DEFAULT ''",
            "perm_address_country_code": "ALTER TABLE user_profile ADD COLUMN perm_address_country_code TEXT NOT NULL DEFAULT ''",
            "perm_address_country_name": "ALTER TABLE user_profile ADD COLUMN perm_address_country_name TEXT NOT NULL DEFAULT ''",
            "date_of_birth": "ALTER TABLE user_profile ADD COLUMN date_of_birth TEXT NOT NULL DEFAULT ''",
            "pronouns": "ALTER TABLE user_profile ADD COLUMN pronouns TEXT NOT NULL DEFAULT ''",
            "website_url": "ALTER TABLE user_profile ADD COLUMN website_url TEXT NOT NULL DEFAULT ''",
            "drivers_license": "ALTER TABLE user_profile ADD COLUMN drivers_license TEXT NOT NULL DEFAULT ''",
            "drivers_license_class": "ALTER TABLE user_profile ADD COLUMN drivers_license_class TEXT NOT NULL DEFAULT ''",
            "drivers_license_state": "ALTER TABLE user_profile ADD COLUMN drivers_license_state TEXT NOT NULL DEFAULT ''",
            "country_of_citizenship": "ALTER TABLE user_profile ADD COLUMN country_of_citizenship TEXT NOT NULL DEFAULT ''",
            "authorized_to_work_us": "ALTER TABLE user_profile ADD COLUMN authorized_to_work_us TEXT NOT NULL DEFAULT ''",
            "requires_sponsorship": "ALTER TABLE user_profile ADD COLUMN requires_sponsorship TEXT NOT NULL DEFAULT ''",
            "authorization_type": "ALTER TABLE user_profile ADD COLUMN authorization_type TEXT NOT NULL DEFAULT ''",
            "security_clearance": "ALTER TABLE user_profile ADD COLUMN security_clearance TEXT NOT NULL DEFAULT ''",
            "clearance_status": "ALTER TABLE user_profile ADD COLUMN clearance_status TEXT NOT NULL DEFAULT ''",
            "desired_salary_min": "ALTER TABLE user_profile ADD COLUMN desired_salary_min INTEGER",
            "desired_salary_max": "ALTER TABLE user_profile ADD COLUMN desired_salary_max INTEGER",
            "salary_period": "ALTER TABLE user_profile ADD COLUMN salary_period TEXT NOT NULL DEFAULT ''",
            "availability_date": "ALTER TABLE user_profile ADD COLUMN availability_date TEXT NOT NULL DEFAULT ''",
            "notice_period": "ALTER TABLE user_profile ADD COLUMN notice_period TEXT NOT NULL DEFAULT ''",
            "willing_to_relocate": "ALTER TABLE user_profile ADD COLUMN willing_to_relocate TEXT NOT NULL DEFAULT ''",
            "how_heard_default": "ALTER TABLE user_profile ADD COLUMN how_heard_default TEXT NOT NULL DEFAULT ''",
            "cover_letter_template": "ALTER TABLE user_profile ADD COLUMN cover_letter_template TEXT NOT NULL DEFAULT ''",
            "background_check_consent": "ALTER TABLE user_profile ADD COLUMN background_check_consent TEXT NOT NULL DEFAULT ''",
        }
        if profile_columns:
            for col, sql in profile_migrations.items():
                if col not in profile_columns:
                    await self.db.execute(sql)

        # Applications table migrations
        app_cursor = await self.db.execute("PRAGMA table_info(applications)")
        app_columns = {row[1] for row in await app_cursor.fetchall()}
        app_migrations = {
            "rejected_at": "ALTER TABLE applications ADD COLUMN rejected_at TEXT",
            "offered_at": "ALTER TABLE applications ADD COLUMN offered_at TEXT",
            "withdrawn_at": "ALTER TABLE applications ADD COLUMN withdrawn_at TEXT",
            "response_received_at": "ALTER TABLE applications ADD COLUMN response_received_at TEXT",
            "response_type": "ALTER TABLE applications ADD COLUMN response_type TEXT",
            "days_to_response": "ALTER TABLE applications ADD COLUMN days_to_response INTEGER",
        }
        for col, sql in app_migrations.items():
            if col not in app_columns:
                await self.db.execute(sql)

        # One-time migration: move notes from applications to app_events
        cursor = await self.db.execute(
            "SELECT job_id, notes FROM applications WHERE notes IS NOT NULL AND notes != ''"
        )
        rows = await cursor.fetchall()
        for row in rows:
            job_id, notes = row[0], row[1]
            existing = await self.db.execute(
                "SELECT 1 FROM app_events WHERE job_id = ? AND event_type = 'note' AND detail = ?",
                (job_id, notes)
            )
            if not await existing.fetchone():
                now = datetime.now(timezone.utc).isoformat()
                await self.db.execute(
                    "INSERT INTO app_events (job_id, event_type, detail, created_at) VALUES (?, 'note', ?, ?)",
                    (job_id, notes, now)
                )

        # Create reminders table if not exists
        await self.db.execute("""
            CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                remind_at TEXT NOT NULL,
                reminder_type TEXT NOT NULL DEFAULT 'follow_up',
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                completed_at TEXT,
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
            )
        """)
        await self.db.execute(
            "CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status, remind_at)"
        )

        # Create interview_prep table if not exists
        await self.db.execute("""
            CREATE TABLE IF NOT EXISTS interview_prep (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER UNIQUE NOT NULL,
                behavioral_questions TEXT NOT NULL DEFAULT '[]',
                technical_questions TEXT NOT NULL DEFAULT '[]',
                star_stories TEXT NOT NULL DEFAULT '[]',
                talking_points TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
            )
        """)

        # Reminders table migrations for follow-up automation
        rem_cursor = await self.db.execute("PRAGMA table_info(reminders)")
        rem_columns = {row[1] for row in await rem_cursor.fetchall()}
        if rem_columns:
            rem_migrations = {
                "auto_draft": "ALTER TABLE reminders ADD COLUMN auto_draft INTEGER DEFAULT 0",
                "auto_send": "ALTER TABLE reminders ADD COLUMN auto_send INTEGER DEFAULT 0",
                "draft_text": "ALTER TABLE reminders ADD COLUMN draft_text TEXT",
                "sent_at": "ALTER TABLE reminders ADD COLUMN sent_at TEXT",
            }
            for col, sql in rem_migrations.items():
                if col not in rem_columns:
                    await self.db.execute(sql)

        # Add missing indexes for common query patterns
        for idx_sql in [
            "CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id)",
            "CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status)",
            "CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_jobs_dismissed ON jobs(dismissed)",
            "CREATE INDEX IF NOT EXISTS idx_queue_status ON application_queue(status)",
            "CREATE INDEX IF NOT EXISTS idx_notifications_job ON notifications(job_id)",
            "CREATE INDEX IF NOT EXISTS idx_reminders_job ON reminders(job_id)",
            "CREATE INDEX IF NOT EXISTS idx_contact_interactions_contact ON contact_interactions(contact_id)",
        ]:
            await self.db.execute(idx_sql)

        await self.db.commit()

        # Clean HTML entities from existing job titles/companies
        await self._clean_html_entities()

    async def _clean_html_entities(self):
        """Fix double-encoded HTML entities in existing job data."""
        import html as _html
        cursor = await self.db.execute(
            "SELECT id, title, company FROM jobs WHERE title LIKE '%&%' OR company LIKE '%&%'"
        )
        rows = await cursor.fetchall()
        for row in rows:
            job_id, title, company = row[0], row[1], row[2]
            clean_title = _html.unescape(_html.unescape(title))
            clean_company = _html.unescape(_html.unescape(company))
            if clean_title != title or clean_company != company:
                await self.db.execute(
                    "UPDATE jobs SET title = ?, company = ? WHERE id = ?",
                    (clean_title, clean_company, job_id)
                )
        if rows:
            await self.db.commit()

    async def insert_job(self, title, company, location, salary_min, salary_max,
                         description, url, posted_date, application_method, contact_email):
        dedup = make_dedup_hash(title, company, url)
        now = datetime.now(timezone.utc).isoformat()
        cursor = await self.db.execute(
            """INSERT OR IGNORE INTO jobs
               (title, company, location, salary_min, salary_max, description, url,
                posted_date, application_method, contact_email, dedup_hash, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (title, company, location, salary_min, salary_max, description, url,
             posted_date, application_method, contact_email, dedup, now)
        )
        await self.db.commit()
        if cursor.rowcount == 0:
            existing = await self.find_job_by_hash(dedup)
            return existing["id"] if existing else None
        return cursor.lastrowid

    async def get_job(self, job_id):
        cursor = await self.db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def find_job_by_hash(self, dedup_hash):
        cursor = await self.db.execute("SELECT * FROM jobs WHERE dedup_hash = ?", (dedup_hash,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def find_job_by_url(self, url: str) -> dict | None:
        cursor = await self.db.execute("SELECT * FROM jobs WHERE url = ?", (url,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def insert_source(self, job_id, source_name, source_url):
        await self.db.execute(
            "INSERT INTO sources (job_id, source_name, source_url) VALUES (?, ?, ?)",
            (job_id, source_name, source_url)
        )
        await self.db.commit()

    async def get_sources(self, job_id):
        cursor = await self.db.execute("SELECT * FROM sources WHERE job_id = ?", (job_id,))
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_jobs_needing_enrichment(self, limit: int = 50) -> list[dict]:
        cursor = await self.db.execute(
            """SELECT j.id, j.url, j.description, j.enrichment_attempts FROM jobs j
               INNER JOIN sources s ON s.job_id = j.id
               WHERE j.description_enriched = 0
               AND (j.description IS NULL OR length(j.description) < 200)
               AND j.dismissed = 0
               AND NOT (j.enrichment_status = 'failed' AND j.enrichment_attempts >= 3)
               GROUP BY j.id
               ORDER BY j.created_at DESC LIMIT ?""",
            (limit,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def update_enrichment_status(self, job_id: int, status: str, attempts: int):
        await self.db.execute(
            "UPDATE jobs SET enrichment_status = ?, enrichment_attempts = ? WHERE id = ?",
            (status, attempts, job_id),
        )
        await self.db.commit()

    async def update_job_description(self, job_id: int, description: str):
        await self.db.execute(
            "UPDATE jobs SET description = ?, description_enriched = 1, enrichment_status = 'enriched' WHERE id = ?",
            (description, job_id),
        )
        await self.db.commit()

    async def insert_score(self, job_id, match_score, match_reasons, concerns, suggested_keywords):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            """INSERT OR REPLACE INTO job_scores
               (job_id, match_score, match_reasons, concerns, suggested_keywords, scored_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (job_id, match_score, json.dumps(match_reasons), json.dumps(concerns),
             json.dumps(suggested_keywords), now)
        )
        await self.db.commit()

    async def get_score(self, job_id):
        cursor = await self.db.execute("SELECT * FROM job_scores WHERE job_id = ?", (job_id,))
        row = await cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["match_reasons"] = json.loads(d["match_reasons"])
        d["concerns"] = json.loads(d["concerns"])
        d["suggested_keywords"] = json.loads(d["suggested_keywords"])
        return d

    async def get_analytics(self) -> dict:
        # Funnel conversion rates — single GROUP BY instead of per-status COUNT
        cursor = await self.db.execute(
            "SELECT status, COUNT(*) FROM applications GROUP BY status")
        funnel_rows = {row[0]: row[1] for row in await cursor.fetchall()}
        funnel = {s: funnel_rows.get(s, 0) for s in
                  ["interested", "prepared", "applied", "interviewing", "offered", "rejected"]}

        # Score calibration — single GROUP BY instead of per-status AVG
        cursor = await self.db.execute(
            """SELECT a.status, AVG(js.match_score)
               FROM applications a JOIN job_scores js ON js.job_id = a.job_id
               WHERE a.status IN ('interested', 'applied', 'interviewing', 'rejected')
               GROUP BY a.status""")
        cal_rows = {row[0]: row[1] for row in await cursor.fetchall()}
        calibration = {s: round(cal_rows[s], 1) if cal_rows.get(s) else None
                       for s in ["interested", "applied", "interviewing", "rejected"]}

        # Source effectiveness: jobs per source, avg score per source
        cursor = await self.db.execute(
            """SELECT s.source_name,
                      COUNT(DISTINCT s.job_id) as job_count,
                      AVG(js.match_score) as avg_score
               FROM sources s
               LEFT JOIN job_scores js ON js.job_id = s.job_id
               GROUP BY s.source_name
               ORDER BY job_count DESC""")
        source_rows = await cursor.fetchall()
        sources = [{"source": r["source_name"], "jobs": r["job_count"],
                    "avg_score": round(r["avg_score"], 1) if r["avg_score"] else None}
                   for r in source_rows]

        # Weekly velocity: jobs added per week (last 8 weeks)
        cursor = await self.db.execute(
            """SELECT strftime('%Y-W%W', created_at) as week,
                      COUNT(*) as count
               FROM jobs
               WHERE created_at >= date('now', '-56 days')
               GROUP BY week
               ORDER BY week""")
        velocity = [{"week": r[0], "count": r[1]} for r in await cursor.fetchall()]

        return {
            "funnel": funnel,
            "score_calibration": calibration,
            "sources": sources,
            "weekly_velocity": velocity,
        }

    async def get_skill_gap_data(self, min_score: int = 50, max_score: int = 80) -> dict:
        cursor = await self.db.execute(
            """SELECT js.concerns, js.suggested_keywords, j.title, j.company
               FROM job_scores js
               JOIN jobs j ON j.id = js.job_id
               WHERE js.match_score >= ? AND js.match_score <= ? AND j.dismissed = 0""",
            (min_score, max_score),
        )
        rows = await cursor.fetchall()
        all_concerns = []
        all_keywords = []
        job_count = len(rows)
        for row in rows:
            d = dict(row)
            concerns = json.loads(d.get("concerns", "[]"))
            keywords = json.loads(d.get("suggested_keywords", "[]"))
            all_concerns.extend(concerns)
            all_keywords.extend(keywords)

        concern_counts = {}
        for c in all_concerns:
            c_lower = c.lower().strip()
            if c_lower:
                concern_counts[c_lower] = concern_counts.get(c_lower, 0) + 1

        keyword_counts = {}
        for k in all_keywords:
            k_lower = k.lower().strip()
            if k_lower:
                keyword_counts[k_lower] = keyword_counts.get(k_lower, 0) + 1

        return {
            "job_count": job_count,
            "top_concerns": sorted(concern_counts.items(), key=lambda x: -x[1])[:20],
            "top_keywords": sorted(keyword_counts.items(), key=lambda x: -x[1])[:20],
        }

    async def insert_notification(self, job_id: int, type: str, title: str, message: str) -> int:
        now = datetime.now(timezone.utc).isoformat()
        cursor = await self.db.execute(
            "INSERT INTO notifications (job_id, type, title, message, created_at) VALUES (?, ?, ?, ?, ?)",
            (job_id, type, title, message, now),
        )
        await self.db.commit()
        return cursor.lastrowid

    async def get_notifications(self, unread_only: bool = False, limit: int = 50) -> list[dict]:
        query = "SELECT * FROM notifications"
        if unread_only:
            query += " WHERE read = 0"
        query += " ORDER BY created_at DESC LIMIT ?"
        cursor = await self.db.execute(query, (limit,))
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_unread_notification_count(self) -> int:
        cursor = await self.db.execute("SELECT COUNT(*) FROM notifications WHERE read = 0")
        row = await cursor.fetchone()
        return row[0] if row else 0

    async def mark_notification_read(self, notification_id: int):
        await self.db.execute("UPDATE notifications SET read = 1 WHERE id = ?", (notification_id,))
        await self.db.commit()

    async def mark_all_notifications_read(self):
        await self.db.execute("UPDATE notifications SET read = 1 WHERE read = 0")
        await self.db.commit()

    async def insert_application(self, job_id, status="interested"):
        cursor = await self.db.execute(
            "INSERT INTO applications (job_id, status) VALUES (?, ?)", (job_id, status)
        )
        await self.db.commit()
        return cursor.lastrowid

    async def update_application(self, app_id, **kwargs):
        _validate_columns("applications", kwargs.keys())
        sets = ", ".join(f"{k} = ?" for k in kwargs)
        vals = list(kwargs.values())
        vals.append(app_id)
        await self.db.execute(f"UPDATE applications SET {sets} WHERE id = ?", vals)
        await self.db.commit()

    async def get_application(self, job_id):
        cursor = await self.db.execute("SELECT * FROM applications WHERE job_id = ?", (job_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def upsert_application(self, job_id: int, status: str):
        now = datetime.now(timezone.utc).isoformat()
        existing = await self.get_application(job_id)
        timestamp_fields = {
            "applied": "applied_at",
            "rejected": "rejected_at",
            "offered": "offered_at",
            "withdrawn": "withdrawn_at",
        }
        if existing:
            sets = {"status": status}
            ts_col = timestamp_fields.get(status)
            if ts_col:
                sets[ts_col] = now
            set_clause = ", ".join(f"{k} = ?" for k in sets)
            vals = list(sets.values()) + [existing["id"]]
            await self.db.execute(f"UPDATE applications SET {set_clause} WHERE id = ?", vals)
        else:
            cols = ["job_id", "status"]
            vals = [job_id, status]
            ts_col = timestamp_fields.get(status)
            if ts_col:
                cols.append(ts_col)
                vals.append(now)
            placeholders = ", ".join("?" for _ in cols)
            col_str = ", ".join(cols)
            await self.db.execute(
                f"INSERT INTO applications ({col_str}) VALUES ({placeholders})", vals
            )
        await self.db.commit()

    async def get_pipeline_jobs(self, status: str) -> list[dict]:
        cursor = await self.db.execute("""
            SELECT j.id, j.title, j.company, j.location, j.url, j.created_at,
                   js.match_score, a.status as app_status, a.applied_at
            FROM jobs j
            INNER JOIN applications a ON j.id = a.job_id
            LEFT JOIN job_scores js ON j.id = js.job_id
            WHERE a.status = ? AND j.dismissed = 0
            ORDER BY COALESCE(a.applied_at, j.created_at) DESC
        """, (status,))
        return [dict(r) for r in await cursor.fetchall()]

    async def get_pipeline_stats(self) -> dict:
        cursor = await self.db.execute("""
            SELECT a.status, COUNT(*) as count
            FROM applications a
            INNER JOIN jobs j ON j.id = a.job_id
            WHERE j.dismissed = 0
            GROUP BY a.status
        """)
        rows = await cursor.fetchall()
        stats = {}
        for row in rows:
            stats[row["status"]] = row["count"]
        return stats

    async def list_jobs(self, sort_by="score", limit=50, offset=0, min_score=None,
                        search=None, source=None, dismissed=False,
                        work_type=None, employment_type=None, location=None,
                        exclude_terms=None, region=None, clearance=None,
                        posted_within=None):
        query = """
            SELECT j.*, js.match_score, js.match_reasons, js.concerns, a.status as app_status
            FROM jobs j
            LEFT JOIN job_scores js ON j.id = js.job_id
            LEFT JOIN applications a ON j.id = a.job_id
            WHERE j.dismissed = ?
        """
        params: list = [1 if dismissed else 0]
        if min_score is not None:
            query += " AND js.match_score >= ?"
            params.append(min_score)
        if search:
            query += " AND (j.title LIKE ? OR j.company LIKE ? OR j.description LIKE ?)"
            params.extend([f"%{search}%"] * 3)
        if source:
            query += " AND j.id IN (SELECT job_id FROM sources WHERE source_name = ?)"
            params.append(source)
        if work_type == "remote":
            query += " AND (LOWER(j.location) LIKE '%remote%' OR LOWER(j.title) LIKE '%remote%')"
        elif work_type == "onsite":
            query += " AND LOWER(j.location) NOT LIKE '%remote%' AND LOWER(j.title) NOT LIKE '%remote%' AND LOWER(j.location) NOT LIKE '%hybrid%'"
        elif work_type == "hybrid":
            query += " AND (LOWER(j.location) LIKE '%hybrid%' OR LOWER(j.title) LIKE '%hybrid%')"
        if employment_type == "fulltime":
            query += " AND (LOWER(j.title) LIKE '%full%time%' OR LOWER(j.description) LIKE '%full%time%' OR (LOWER(j.title) NOT LIKE '%contract%' AND LOWER(j.title) NOT LIKE '%part%time%'))"
        elif employment_type == "contract":
            query += " AND (LOWER(j.title) LIKE '%contract%' OR LOWER(j.description) LIKE '%contract%' OR LOWER(j.title) LIKE '%freelance%')"
        elif employment_type == "parttime":
            query += " AND (LOWER(j.title) LIKE '%part%time%' OR LOWER(j.description) LIKE '%part%time%')"
        if location:
            query += " AND LOWER(j.location) LIKE ?"
            params.append(f"%{location.lower()}%")
        if exclude_terms:
            for term in exclude_terms:
                query += " AND LOWER(j.title) NOT LIKE ? AND LOWER(j.description) NOT LIKE ?"
                params.extend([f"%{term.lower()}%", f"%{term.lower()}%"])
        if region:
            region_map = {
                "us": ["%united states%", "%usa%", "% us %", "% us,", "%u.s.%"],
                "europe": ["%europe%", "%germany%", "%france%", "%netherlands%", "%spain%", "%italy%", "%poland%", "%sweden%", "%ireland%", "%portugal%", "%austria%", "%switzerland%", "%belgium%", "%denmark%", "%norway%", "%finland%", "%czech%", "% eu %", "% eu,%", "%emea%"],
                "uk": ["%united kingdom%", "% uk %", "% uk,%", "%england%", "%london%", "%scotland%", "%wales%"],
                "canada": ["%canada%", "%canadian%", "%toronto%", "%vancouver%", "%montreal%", "%ottawa%"],
                "latam": ["%latin america%", "%latam%", "%brazil%", "%mexico%", "%argentina%", "%colombia%", "%chile%"],
                "apac": ["%asia%", "%pacific%", "%apac%", "%australia%", "%japan%", "%india%", "%singapore%", "%korea%", "%new zealand%"],
            }
            patterns = region_map.get(region, [])
            if patterns:
                clauses = " OR ".join("LOWER(j.location) LIKE ?" for _ in patterns)
                query += f" AND ({clauses})"
                params.extend(patterns)
        if clearance:
            clearance_terms = ["%clearance%", "%security clearance%", "%top secret%", "%ts/sci%", "%public trust%", "%green card%", "%greencard%", "%us citizen%", "%u.s. citizen%", "%citizenship required%", "%must be a us%", "%must be a u.s.%", "%permanent resident%", "%work authorization%", "%visa sponsor%", "%no visa%", "%eadauthorization%"]
            clauses = " OR ".join("LOWER(j.description) LIKE ?" for _ in clearance_terms)
            if clearance == "hide":
                query += f" AND NOT ({clauses})"
            elif clearance == "only":
                query += f" AND ({clauses})"
            params.extend(clearance_terms)
        if posted_within:
            days_map = {"24h": 1, "3d": 3, "7d": 7, "14d": 14, "30d": 30}
            days = days_map.get(posted_within)
            if days:
                query += " AND COALESCE(j.posted_date, j.created_at) >= datetime('now', ?)"
                params.append(f"-{days} days")
        if sort_by == "score":
            query += " ORDER BY js.match_score DESC NULLS LAST, COALESCE(j.posted_date, j.created_at) DESC"
        elif sort_by == "freshest":
            query += " ORDER BY COALESCE(j.posted_date, j.created_at) DESC"
        else:
            query += " ORDER BY j.created_at DESC"
        query += " LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        cursor = await self.db.execute(query, params)
        rows = await cursor.fetchall()
        results = []
        for row in rows:
            d = dict(row)
            if d.get("match_reasons"):
                d["match_reasons"] = json.loads(d["match_reasons"])
            if d.get("concerns"):
                d["concerns"] = json.loads(d["concerns"])
            results.append(d)
        return results

    async def get_unscored_jobs(self, limit=10):
        cursor = await self.db.execute(
            """SELECT j.* FROM jobs j
               LEFT JOIN job_scores js ON j.id = js.job_id
               WHERE js.id IS NULL AND j.dismissed = 0 LIMIT ?""", (limit,)
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def dismiss_job(self, job_id):
        await self.db.execute("UPDATE jobs SET dismissed = 1 WHERE id = ?", (job_id,))
        await self.db.commit()

    async def auto_dismiss_stale(self, max_age_days: int = 30, no_date_max_days: int = 30) -> int:
        """Auto-dismiss old jobs. Never dismisses jobs with non-interested applications."""
        cutoff_posted = (datetime.now(timezone.utc) - timedelta(days=max_age_days)).isoformat()
        cutoff_created = (datetime.now(timezone.utc) - timedelta(days=no_date_max_days)).isoformat()
        cursor = await self.db.execute("""
            UPDATE jobs SET dismissed = 1
            WHERE dismissed = 0
            AND id NOT IN (
                SELECT job_id FROM applications WHERE status != 'interested'
            )
            AND (
                (posted_date IS NOT NULL AND posted_date < ?)
                OR (posted_date IS NULL AND created_at < ?)
            )
        """, (cutoff_posted, cutoff_created))
        await self.db.commit()
        return cursor.rowcount

    async def get_search_config(self):
        cursor = await self.db.execute("SELECT * FROM search_config WHERE id = 1")
        row = await cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["search_terms"] = json.loads(d["search_terms"])
        d["job_titles"] = json.loads(d["job_titles"])
        d["key_skills"] = json.loads(d["key_skills"])
        d["ats_issues"] = json.loads(d["ats_issues"])
        d["ats_tips"] = json.loads(d["ats_tips"])
        d["exclude_terms"] = json.loads(d.get("exclude_terms", "[]"))
        return d

    async def save_search_config(self, resume_text: str, search_terms: list[str],
                                  job_titles: list = None, key_skills: list = None,
                                  seniority: str = "", summary: str = "",
                                  ats_score: int = 0, ats_issues: list = None,
                                  ats_tips: list = None):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            """INSERT INTO search_config (id, resume_text, search_terms, job_titles,
               key_skills, seniority, summary, ats_score, ats_issues, ats_tips, updated_at)
               VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
               resume_text = excluded.resume_text,
               search_terms = excluded.search_terms,
               job_titles = excluded.job_titles,
               key_skills = excluded.key_skills,
               seniority = excluded.seniority,
               summary = excluded.summary,
               ats_score = excluded.ats_score,
               ats_issues = excluded.ats_issues,
               ats_tips = excluded.ats_tips,
               updated_at = excluded.updated_at""",
            (resume_text, json.dumps(search_terms), json.dumps(job_titles or []),
             json.dumps(key_skills or []), seniority, summary,
             ats_score, json.dumps(ats_issues or []), json.dumps(ats_tips or []), now)
        )
        await self.db.commit()

    async def update_exclude_terms(self, exclude_terms: list[str]):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            "UPDATE search_config SET exclude_terms = ?, updated_at = ? WHERE id = 1",
            (json.dumps(exclude_terms), now)
        )
        await self.db.commit()

    async def update_search_terms(self, search_terms: list[str]):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            "UPDATE search_config SET search_terms = ?, updated_at = ? WHERE id = 1",
            (json.dumps(search_terms), now)
        )
        await self.db.commit()

    async def get_ai_settings(self):
        cursor = await self.db.execute("SELECT * FROM ai_settings WHERE id = 1")
        row = await cursor.fetchone()
        if not row:
            return None
        return dict(row)

    async def save_ai_settings(self, provider: str, api_key: str = "",
                                model: str = "", base_url: str = ""):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            """INSERT INTO ai_settings (id, provider, api_key, model, base_url, updated_at)
               VALUES (1, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
               provider = excluded.provider,
               api_key = excluded.api_key,
               model = excluded.model,
               base_url = excluded.base_url,
               updated_at = excluded.updated_at""",
            (provider, api_key, model, base_url, now)
        )
        await self.db.commit()

    async def get_scraper_keys(self) -> dict:
        cursor = await self.db.execute("SELECT name, api_key, email FROM scraper_keys")
        rows = await cursor.fetchall()
        return {row["name"]: {"api_key": row["api_key"], "email": row["email"]} for row in rows}

    async def get_scraper_key(self, name: str) -> dict | None:
        cursor = await self.db.execute("SELECT api_key, email FROM scraper_keys WHERE name = ?", (name,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def save_scraper_key(self, name: str, api_key: str = "", email: str = ""):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            """INSERT INTO scraper_keys (name, api_key, email, updated_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET
               api_key = excluded.api_key,
               email = excluded.email,
               updated_at = excluded.updated_at""",
            (name, api_key, email, now)
        )
        await self.db.commit()

    async def update_scraper_schedule(self, source_name: str, interval_hours: int):
        await self.db.execute(
            """INSERT INTO scraper_schedule (source_name, interval_hours)
               VALUES (?, ?)
               ON CONFLICT(source_name) DO UPDATE SET interval_hours = excluded.interval_hours""",
            (source_name, interval_hours),
        )
        await self.db.commit()

    async def mark_scraper_ran(self, source_name: str):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            """INSERT INTO scraper_schedule (source_name, interval_hours, last_scraped_at)
               VALUES (?, 6, ?)
               ON CONFLICT(source_name) DO UPDATE SET last_scraped_at = excluded.last_scraped_at""",
            (source_name, now),
        )
        await self.db.commit()

    async def should_scraper_run(self, source_name: str) -> bool:
        cursor = await self.db.execute(
            "SELECT interval_hours, last_scraped_at FROM scraper_schedule WHERE source_name = ?",
            (source_name,),
        )
        row = await cursor.fetchone()
        if not row or not row["last_scraped_at"]:
            return True
        last = datetime.fromisoformat(row["last_scraped_at"])
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        interval = timedelta(hours=row["interval_hours"])
        return datetime.now(timezone.utc) > last + interval

    async def get_all_scraper_schedules(self) -> list[dict]:
        cursor = await self.db.execute("SELECT * FROM scraper_schedule ORDER BY source_name")
        return [dict(r) for r in await cursor.fetchall()]

    async def update_job_contact(self, job_id: int, **fields):
        _validate_columns("jobs", fields.keys())
        sets = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [job_id]
        await self.db.execute(f"UPDATE jobs SET {sets} WHERE id = ?", vals)
        await self.db.commit()

    async def add_event(self, job_id: int, event_type: str, detail: str = ""):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            "INSERT INTO app_events (job_id, event_type, detail, created_at) VALUES (?, ?, ?, ?)",
            (job_id, event_type, detail, now)
        )
        await self.db.commit()

    async def create_reminder(self, job_id: int, remind_at: str, reminder_type: str = "follow_up") -> int:
        now = datetime.now(timezone.utc).isoformat()
        cursor = await self.db.execute(
            "INSERT INTO reminders (job_id, remind_at, reminder_type, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
            (job_id, remind_at, reminder_type, now)
        )
        await self.db.commit()
        return cursor.lastrowid

    async def get_reminders(self, status: str | None = None, include_job: bool = False) -> list[dict]:
        if include_job:
            query = """
                SELECT r.*, j.title, j.company, j.url
                FROM reminders r
                INNER JOIN jobs j ON r.job_id = j.id
            """
        else:
            query = "SELECT * FROM reminders"
        params = []
        if status:
            query += " WHERE r.status = ?" if include_job else " WHERE status = ?"
            params.append(status)
        query += " ORDER BY remind_at ASC"
        cursor = await self.db.execute(query, params)
        return [dict(r) for r in await cursor.fetchall()]

    async def get_due_reminders(self) -> list[dict]:
        now = datetime.now(timezone.utc).isoformat()
        cursor = await self.db.execute("""
            SELECT r.*, j.title, j.company, j.url, a.status as app_status
            FROM reminders r
            INNER JOIN jobs j ON r.job_id = j.id
            LEFT JOIN applications a ON r.job_id = a.job_id
            WHERE r.status = 'pending' AND r.remind_at <= ?
            ORDER BY r.remind_at ASC
        """, (now,))
        return [dict(r) for r in await cursor.fetchall()]

    async def complete_reminder(self, reminder_id: int):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            "UPDATE reminders SET status = 'completed', completed_at = ? WHERE id = ?",
            (now, reminder_id)
        )
        await self.db.commit()

    async def dismiss_reminder(self, reminder_id: int):
        await self.db.execute(
            "UPDATE reminders SET status = 'dismissed' WHERE id = ?",
            (reminder_id,)
        )
        await self.db.commit()

    async def get_reminders_for_job(self, job_id: int) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM reminders WHERE job_id = ? ORDER BY remind_at ASC",
            (job_id,)
        )
        return [dict(r) for r in await cursor.fetchall()]

    async def save_interview_prep(self, job_id: int, prep: dict):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            """INSERT INTO interview_prep (job_id, behavioral_questions, technical_questions, star_stories, talking_points, created_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(job_id) DO UPDATE SET
               behavioral_questions=excluded.behavioral_questions,
               technical_questions=excluded.technical_questions,
               star_stories=excluded.star_stories,
               talking_points=excluded.talking_points,
               created_at=excluded.created_at""",
            (job_id,
             json.dumps(prep.get("behavioral_questions", [])),
             json.dumps(prep.get("technical_questions", [])),
             json.dumps(prep.get("star_stories", [])),
             json.dumps(prep.get("talking_points", [])),
             now)
        )
        await self.db.commit()

    async def get_interview_prep(self, job_id: int) -> dict | None:
        cursor = await self.db.execute(
            "SELECT * FROM interview_prep WHERE job_id = ?", (job_id,)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["behavioral_questions"] = json.loads(d["behavioral_questions"])
        d["technical_questions"] = json.loads(d["technical_questions"])
        d["star_stories"] = json.loads(d["star_stories"])
        d["talking_points"] = json.loads(d["talking_points"])
        return d

    async def get_events(self, job_id: int) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM app_events WHERE job_id = ? ORDER BY created_at DESC", (job_id,)
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def find_similar_jobs(self, title: str, company: str, exclude_id: int = None,
                               embedding_client=None) -> list[dict]:
        """Find similar jobs using vector search (if available) with LIKE fallback."""
        # Try vector search first
        if self._vec_loaded and embedding_client and exclude_id:
            try:
                text = f"{title} at {company}"
                query_vec = await embedding_client.embed(text)
                vec_results = await self.find_similar_jobs_by_vector(query_vec, limit=11)
                if vec_results:
                    similar = []
                    for r in vec_results:
                        if r["id"] != exclude_id:
                            score_cursor = await self.db.execute(
                                "SELECT match_score FROM job_scores WHERE job_id = ?", (r["id"],)
                            )
                            score_row = await score_cursor.fetchone()
                            similar.append({
                                "id": r["id"], "title": r["title"],
                                "company": r["company"], "url": r["url"],
                                "match_score": score_row["match_score"] if score_row else None,
                                "distance": r["distance"],
                            })
                    if similar:
                        return similar[:10]
            except Exception as e:
                logger.warning("Vector similar search failed, falling back to LIKE: %s", e)

        # Fallback to LIKE-based search
        norm_company = company.lower().strip()
        query = """
            SELECT j.id, j.title, j.company, j.url, js.match_score
            FROM jobs j
            LEFT JOIN job_scores js ON j.id = js.job_id
            WHERE LOWER(j.company) LIKE ? AND j.dismissed = 0
        """
        params = [f"%{norm_company}%"]
        if exclude_id:
            query += " AND j.id != ?"
            params.append(exclude_id)
        query += " LIMIT 10"
        cursor = await self.db.execute(query, params)
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def find_cross_source_dupes(self, exclude_id: int, title: str, company: str) -> list[dict]:
        """Find likely duplicate jobs from other sources using fuzzy company + title matching."""
        norm_company = _normalize_company(company)
        cursor = await self.db.execute(
            "SELECT id, title, company, url FROM jobs WHERE id != ? AND dismissed = 0",
            (exclude_id,),
        )
        rows = await cursor.fetchall()
        dupes = []
        for row in rows:
            if _normalize_company(row["company"]) != norm_company:
                continue
            if _title_similarity(title, row["title"]) >= 0.7:
                dupes.append(dict(row))
        return dupes

    async def get_company(self, name: str) -> dict | None:
        normalized = name.lower().strip()
        cursor = await self.db.execute(
            "SELECT * FROM companies WHERE normalized_name = ?", (normalized,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def save_company(self, name: str, **fields):
        _validate_columns("companies", fields.keys())
        now = datetime.now(timezone.utc).isoformat()
        normalized = name.lower().strip()
        existing = await self.get_company(name)
        if existing:
            sets = ", ".join(f"{k} = ?" for k in fields)
            vals = list(fields.values()) + [now, normalized]
            await self.db.execute(
                f"UPDATE companies SET {sets}, updated_at = ? WHERE normalized_name = ?", vals)
        else:
            cols = ["name", "normalized_name", "updated_at"] + list(fields.keys())
            vals = [name, normalized, now] + list(fields.values())
            placeholders = ", ".join("?" for _ in cols)
            col_str = ", ".join(cols)
            await self.db.execute(
                f"INSERT INTO companies ({col_str}) VALUES ({placeholders})", vals)
        await self.db.commit()

    async def clear_jobs(self):
        for table in [
            "offers", "job_contacts", "interview_prep",
            "application_queue", "notifications", "reminders",
            "sources", "job_scores", "app_events", "applications", "jobs",
        ]:
            await self.db.execute(f"DELETE FROM {table}")
        await self.db.commit()

    async def get_user_profile(self) -> dict | None:
        cursor = await self.db.execute("SELECT * FROM user_profile WHERE id = 1")
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def save_user_profile(self, _commit=True, **fields):
        now = datetime.now(timezone.utc).isoformat()
        # Merge with existing profile to avoid blanking out columns not provided
        existing = await self.get_user_profile()
        if existing:
            existing.pop("id", None)
            existing.pop("updated_at", None)
            merged = existing
            merged.update(fields)
        else:
            merged = fields
        # Get actual columns from the table to handle both old and new schemas
        cursor = await self.db.execute("PRAGMA table_info(user_profile)")
        all_cols = {row[1] for row in await cursor.fetchall()}
        all_cols.discard("id")
        all_cols.discard("updated_at")
        int_cols = {"desired_salary_min", "desired_salary_max"}
        cols = sorted(all_cols)
        values = [merged.get(c) if c in int_cols else merged.get(c, "") for c in cols]
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        update_str = ", ".join(f"{c} = excluded.{c}" for c in cols)
        await self.db.execute(
            f"""INSERT INTO user_profile (id, {col_str}, updated_at)
                VALUES (1, {placeholders}, ?)
                ON CONFLICT(id) DO UPDATE SET {update_str}, updated_at = excluded.updated_at""",
            (*values, now)
        )
        if _commit:
            await self.db.commit()

    async def get_full_profile(self) -> dict:
        profile = await self.get_user_profile()
        if not profile:
            profile = {}
        work, edu, certs, skills, langs, refs, mil, eeo = await asyncio.gather(
            self.get_work_history(),
            self.get_education(),
            self.get_certifications(),
            self.get_skills(),
            self.get_languages(),
            self.get_references(),
            self.get_military_service(),
            self.get_eeo_responses(),
        )
        profile["work_history"] = work
        profile["education"] = edu
        profile["certifications"] = certs
        profile["skills"] = skills
        profile["languages"] = langs
        profile["references"] = refs
        profile["military"] = mil
        profile["eeo"] = eeo
        return profile

    async def save_full_profile(self, data: dict):
        nested_keys = {"work_history", "education", "certifications", "skills",
                        "languages", "references", "military", "eeo"}
        profile_fields = {k: v for k, v in data.items() if k not in nested_keys}
        try:
            if profile_fields:
                existing = await self.get_user_profile() or {}
                existing.pop("id", None)
                existing.pop("updated_at", None)
                existing.update(profile_fields)
                await self.save_user_profile(_commit=False, **existing)

            if "work_history" in data:
                await self._replace_list("work_history", data["work_history"], _commit=False)
            if "education" in data:
                await self._replace_list("education", data["education"], _commit=False)
            if "certifications" in data:
                await self._replace_list("certifications", data["certifications"], _commit=False)
            if "skills" in data:
                await self._replace_list("skills", data["skills"], _commit=False)
            if "languages" in data:
                await self._replace_list("languages", data["languages"], _commit=False)
            if "references" in data:
                await self._replace_list("user_references", data["references"], _commit=False)
            if "military" in data:
                await self.save_military_service(data["military"], _commit=False)
            if "eeo" in data:
                await self.save_eeo_responses(data["eeo"], _commit=False)
            await self.db.commit()
        except Exception:
            await self.db.rollback()
            raise

    async def _replace_list(self, table: str, items: list, _commit=True):
        if table not in _VALID_REPLACE_TABLES:
            raise ValueError(f"Invalid table for _replace_list: {table}")
        await self.db.execute(f"DELETE FROM {table} WHERE user_id = 1")
        for i, item in enumerate(items):
            item.pop("id", None)
            item["user_id"] = 1
            if "sort_order" in self._get_table_cols(table):
                item.setdefault("sort_order", i)
            cols = list(item.keys())
            _validate_columns(table, cols)
            vals = list(item.values())
            placeholders = ", ".join("?" for _ in cols)
            col_str = ", ".join(cols)
            await self.db.execute(f"INSERT INTO {table} ({col_str}) VALUES ({placeholders})", vals)
        if _commit:
            await self.db.commit()

    def _get_table_cols(self, table: str) -> set:
        # Simple mapping of tables that have sort_order
        tables_with_sort = {"work_history", "education"}
        if table in tables_with_sort:
            return {"sort_order"}
        return set()

    # Work history CRUD
    async def get_work_history(self, user_id: int = 1) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM work_history WHERE user_id = ? ORDER BY sort_order, start_year DESC", (user_id,))
        return [dict(r) for r in await cursor.fetchall()]

    async def save_work_history(self, entry: dict) -> int:
        entry.setdefault("user_id", 1)
        entry_id = entry.pop("id", None)
        _validate_columns("work_history", entry.keys())
        if entry_id:
            sets = ", ".join(f"{k} = ?" for k in entry)
            vals = list(entry.values()) + [entry_id]
            await self.db.execute(f"UPDATE work_history SET {sets} WHERE id = ?", vals)
            await self.db.commit()
            return entry_id
        cols = list(entry.keys())
        vals = list(entry.values())
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        cursor = await self.db.execute(
            f"INSERT INTO work_history ({col_str}) VALUES ({placeholders})", vals)
        await self.db.commit()
        return cursor.lastrowid

    async def delete_work_history(self, entry_id: int):
        await self.db.execute("DELETE FROM work_history WHERE id = ?", (entry_id,))
        await self.db.commit()

    # Education CRUD
    async def get_education(self, user_id: int = 1) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM education WHERE user_id = ? ORDER BY sort_order, start_year DESC", (user_id,))
        return [dict(r) for r in await cursor.fetchall()]

    async def save_education(self, entry: dict) -> int:
        entry.setdefault("user_id", 1)
        entry_id = entry.pop("id", None)
        _validate_columns("education", entry.keys())
        if entry_id:
            sets = ", ".join(f"{k} = ?" for k in entry)
            vals = list(entry.values()) + [entry_id]
            await self.db.execute(f"UPDATE education SET {sets} WHERE id = ?", vals)
            await self.db.commit()
            return entry_id
        cols = list(entry.keys())
        vals = list(entry.values())
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        cursor = await self.db.execute(
            f"INSERT INTO education ({col_str}) VALUES ({placeholders})", vals)
        await self.db.commit()
        return cursor.lastrowid

    async def delete_education(self, entry_id: int):
        await self.db.execute("DELETE FROM education WHERE id = ?", (entry_id,))
        await self.db.commit()

    # Certifications CRUD
    async def get_certifications(self, user_id: int = 1) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM certifications WHERE user_id = ? ORDER BY date_obtained DESC", (user_id,))
        return [dict(r) for r in await cursor.fetchall()]

    async def save_certification(self, entry: dict) -> int:
        entry.setdefault("user_id", 1)
        entry_id = entry.pop("id", None)
        _validate_columns("certifications", entry.keys())
        if entry_id:
            sets = ", ".join(f"{k} = ?" for k in entry)
            vals = list(entry.values()) + [entry_id]
            await self.db.execute(f"UPDATE certifications SET {sets} WHERE id = ?", vals)
            await self.db.commit()
            return entry_id
        cols = list(entry.keys())
        vals = list(entry.values())
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        cursor = await self.db.execute(
            f"INSERT INTO certifications ({col_str}) VALUES ({placeholders})", vals)
        await self.db.commit()
        return cursor.lastrowid

    async def delete_certification(self, entry_id: int):
        await self.db.execute("DELETE FROM certifications WHERE id = ?", (entry_id,))
        await self.db.commit()

    # Skills CRUD
    async def get_skills(self, user_id: int = 1) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM skills WHERE user_id = ? ORDER BY name", (user_id,))
        return [dict(r) for r in await cursor.fetchall()]

    async def save_skill(self, entry: dict) -> int:
        entry.setdefault("user_id", 1)
        entry_id = entry.pop("id", None)
        _validate_columns("skills", entry.keys())
        if entry_id:
            sets = ", ".join(f"{k} = ?" for k in entry)
            vals = list(entry.values()) + [entry_id]
            await self.db.execute(f"UPDATE skills SET {sets} WHERE id = ?", vals)
            await self.db.commit()
            return entry_id
        cols = list(entry.keys())
        vals = list(entry.values())
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        cursor = await self.db.execute(
            f"INSERT INTO skills ({col_str}) VALUES ({placeholders})", vals)
        await self.db.commit()
        return cursor.lastrowid

    async def delete_skill(self, entry_id: int):
        await self.db.execute("DELETE FROM skills WHERE id = ?", (entry_id,))
        await self.db.commit()

    # Languages CRUD
    async def get_languages(self, user_id: int = 1) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM languages WHERE user_id = ? ORDER BY language", (user_id,))
        return [dict(r) for r in await cursor.fetchall()]

    async def save_language(self, entry: dict) -> int:
        entry.setdefault("user_id", 1)
        entry_id = entry.pop("id", None)
        _validate_columns("languages", entry.keys())
        if entry_id:
            sets = ", ".join(f"{k} = ?" for k in entry)
            vals = list(entry.values()) + [entry_id]
            await self.db.execute(f"UPDATE languages SET {sets} WHERE id = ?", vals)
            await self.db.commit()
            return entry_id
        cols = list(entry.keys())
        vals = list(entry.values())
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        cursor = await self.db.execute(
            f"INSERT INTO languages ({col_str}) VALUES ({placeholders})", vals)
        await self.db.commit()
        return cursor.lastrowid

    async def delete_language(self, entry_id: int):
        await self.db.execute("DELETE FROM languages WHERE id = ?", (entry_id,))
        await self.db.commit()

    # References CRUD
    async def get_references(self, user_id: int = 1) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM user_references WHERE user_id = ? ORDER BY name", (user_id,))
        return [dict(r) for r in await cursor.fetchall()]

    async def save_reference(self, entry: dict) -> int:
        entry.setdefault("user_id", 1)
        entry_id = entry.pop("id", None)
        _validate_columns("user_references", entry.keys())
        if entry_id:
            sets = ", ".join(f"{k} = ?" for k in entry)
            vals = list(entry.values()) + [entry_id]
            await self.db.execute(f"UPDATE user_references SET {sets} WHERE id = ?", vals)
            await self.db.commit()
            return entry_id
        cols = list(entry.keys())
        vals = list(entry.values())
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        cursor = await self.db.execute(
            f"INSERT INTO user_references ({col_str}) VALUES ({placeholders})", vals)
        await self.db.commit()
        return cursor.lastrowid

    async def delete_reference(self, entry_id: int):
        await self.db.execute("DELETE FROM user_references WHERE id = ?", (entry_id,))
        await self.db.commit()

    # Military service CRUD (singleton)
    async def get_military_service(self) -> dict | None:
        cursor = await self.db.execute("SELECT * FROM military_service WHERE id = 1")
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def save_military_service(self, fields: dict, _commit=True):
        fields.pop("id", None)
        fields.pop("user_id", None)
        _validate_columns("military_service", fields.keys())
        cols = list(fields.keys())
        vals = list(fields.values())
        if not cols:
            return
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        update_str = ", ".join(f"{c} = excluded.{c}" for c in cols)
        await self.db.execute(
            f"""INSERT INTO military_service (id, user_id, {col_str})
                VALUES (1, 1, {placeholders})
                ON CONFLICT(id) DO UPDATE SET {update_str}""",
            vals)
        if _commit:
            await self.db.commit()

    # EEO responses CRUD (singleton)
    async def get_eeo_responses(self) -> dict | None:
        cursor = await self.db.execute("SELECT * FROM eeo_responses WHERE id = 1")
        row = await cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["veteran_categories"] = json.loads(d.get("veteran_categories", "[]"))
        return d

    async def save_eeo_responses(self, fields: dict, _commit=True):
        fields.pop("id", None)
        if "veteran_categories" in fields and isinstance(fields["veteran_categories"], list):
            fields["veteran_categories"] = json.dumps(fields["veteran_categories"])
        _validate_columns("eeo_responses", fields.keys())
        cols = list(fields.keys())
        vals = list(fields.values())
        if not cols:
            return
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        update_str = ", ".join(f"{c} = excluded.{c}" for c in cols)
        await self.db.execute(
            f"""INSERT INTO eeo_responses (id, {col_str})
                VALUES (1, {placeholders})
                ON CONFLICT(id) DO UPDATE SET {update_str}""",
            vals)
        if _commit:
            await self.db.commit()

    # Custom Q&A CRUD
    async def get_custom_qa(self) -> list[dict]:
        cursor = await self.db.execute("SELECT * FROM custom_qa ORDER BY times_used DESC")
        return [dict(r) for r in await cursor.fetchall()]

    async def get_custom_qa_by_id(self, qa_id: int) -> dict | None:
        cursor = await self.db.execute("SELECT * FROM custom_qa WHERE id = ?", (qa_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def save_custom_qa(self, entry: dict) -> int:
        entry_id = entry.pop("id", None)
        _validate_columns("custom_qa", entry.keys())
        if entry_id:
            sets = ", ".join(f"{k} = ?" for k in entry)
            vals = list(entry.values()) + [entry_id]
            await self.db.execute(f"UPDATE custom_qa SET {sets} WHERE id = ?", vals)
            await self.db.commit()
            return entry_id
        cols = list(entry.keys())
        vals = list(entry.values())
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        cursor = await self.db.execute(
            f"INSERT INTO custom_qa ({col_str}) VALUES ({placeholders})", vals)
        await self.db.commit()
        return cursor.lastrowid

    async def delete_custom_qa(self, qa_id: int):
        await self.db.execute("DELETE FROM custom_qa WHERE id = ?", (qa_id,))
        await self.db.commit()

    # Autofill history CRUD
    async def get_autofill_history(self, limit: int = 50) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM autofill_history ORDER BY created_at DESC LIMIT ?", (limit,))
        rows = await cursor.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["fields_filled"] = json.loads(d.get("fields_filled", "[]"))
            d["fields_skipped"] = json.loads(d.get("fields_skipped", "[]"))
            d["new_data_saved"] = json.loads(d.get("new_data_saved", "{}"))
            result.append(d)
        return result

    async def save_autofill_history(self, job_url: str, job_title: str, company: str,
                                     fields_filled: list = None, fields_skipped: list = None,
                                     new_data_saved: dict = None) -> int:
        now = datetime.now(timezone.utc).isoformat()
        cursor = await self.db.execute(
            """INSERT INTO autofill_history (job_url, job_title, company, fields_filled,
               fields_skipped, new_data_saved, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (job_url, job_title, company,
             json.dumps(fields_filled or []), json.dumps(fields_skipped or []),
             json.dumps(new_data_saved or {}), now))
        await self.db.commit()
        return cursor.lastrowid

    async def clear_all(self):
        for table in [
            "context_items", "offers", "job_contacts", "interview_prep",
            "application_queue", "notifications", "reminders",
            "contact_interactions",
            "sources", "job_scores", "app_events", "applications",
            "jobs", "contacts", "resumes",
            "search_config", "ai_settings", "user_profile", "companies",
            "work_history", "education", "certifications", "skills",
            "languages", "user_references", "military_service", "eeo_responses",
            "custom_qa", "autofill_history", "follow_up_templates",
            "career_suggestions", "saved_views", "scraper_keys",
            "scraper_schedule", "job_alerts", "email_settings",
            "embedding_settings",
        ]:
            await self.db.execute(f"DELETE FROM {table}")
        await self.db.commit()

    async def get_stats(self):
        cursor = await self.db.execute("""
            SELECT
                (SELECT COUNT(*) FROM jobs WHERE dismissed = 0) as total_jobs,
                (SELECT COUNT(*) FROM job_scores) as total_scored,
                (SELECT COUNT(*) FROM applications WHERE status = 'applied') as total_applied,
                (SELECT COUNT(*) FROM applications WHERE status = 'interested') as total_interested,
                (SELECT COUNT(*) FROM applications WHERE status = 'interviewing') as total_interviewing,
                (SELECT COUNT(*) FROM applications WHERE status = 'prepared') as total_prepared
        """)
        row = await cursor.fetchone()
        return {
            "total_jobs": row[0],
            "total_scored": row[1],
            "total_applied": row[2],
            "total_interested": row[3],
            "total_interviewing": row[4],
            "total_prepared": row[5],
        }

    async def get_email_settings(self) -> dict | None:
        cursor = await self.db.execute("SELECT * FROM email_settings WHERE id = 1")
        row = await cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["smtp_use_tls"] = bool(d.get("smtp_use_tls", 1))
        d["digest_enabled"] = bool(d.get("digest_enabled", 0))
        return d

    async def update_email_settings(self, settings: dict):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            """INSERT INTO email_settings
               (id, smtp_host, smtp_port, smtp_username, smtp_password, smtp_use_tls,
                from_address, to_address, digest_enabled, digest_schedule,
                digest_time, digest_min_score, updated_at)
               VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                smtp_host=excluded.smtp_host, smtp_port=excluded.smtp_port,
                smtp_username=excluded.smtp_username, smtp_password=excluded.smtp_password,
                smtp_use_tls=excluded.smtp_use_tls, from_address=excluded.from_address,
                to_address=excluded.to_address, digest_enabled=excluded.digest_enabled,
                digest_schedule=excluded.digest_schedule, digest_time=excluded.digest_time,
                digest_min_score=excluded.digest_min_score, updated_at=excluded.updated_at""",
            (
                settings.get("smtp_host", ""),
                settings.get("smtp_port", 587),
                settings.get("smtp_username", ""),
                settings.get("smtp_password", ""),
                int(settings.get("smtp_use_tls", True)),
                settings.get("from_address", ""),
                settings.get("to_address", ""),
                int(settings.get("digest_enabled", False)),
                settings.get("digest_schedule", "daily"),
                settings.get("digest_time", "08:00"),
                settings.get("digest_min_score", 60),
                now,
            ),
        )
        await self.db.commit()

    # --- Saved Views CRUD ---

    async def get_saved_views(self) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM saved_views ORDER BY updated_at DESC"
        )
        rows = await cursor.fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["filters"] = json.loads(d["filters"]) if d["filters"] else {}
            results.append(d)
        return results

    async def get_saved_view(self, view_id: int) -> dict | None:
        cursor = await self.db.execute(
            "SELECT * FROM saved_views WHERE id = ?", (view_id,)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["filters"] = json.loads(d["filters"]) if d["filters"] else {}
        return d

    async def create_saved_view(self, name: str, filters: dict) -> int:
        now = datetime.now(timezone.utc).isoformat()
        cursor = await self.db.execute(
            "INSERT INTO saved_views (name, filters, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (name, json.dumps(filters), now, now),
        )
        await self.db.commit()
        return cursor.lastrowid

    async def update_saved_view(self, view_id: int, name: str | None = None, filters: dict | None = None) -> bool:
        existing = await self.get_saved_view(view_id)
        if not existing:
            return False
        now = datetime.now(timezone.utc).isoformat()
        new_name = name if name is not None else existing["name"]
        new_filters = filters if filters is not None else existing["filters"]
        await self.db.execute(
            "UPDATE saved_views SET name = ?, filters = ?, updated_at = ? WHERE id = ?",
            (new_name, json.dumps(new_filters), now, view_id),
        )
        await self.db.commit()
        return True

    async def delete_saved_view(self, view_id: int) -> bool:
        cursor = await self.db.execute(
            "DELETE FROM saved_views WHERE id = ?", (view_id,)
        )
        await self.db.commit()
        return cursor.rowcount > 0

    # --- Resumes CRUD ---

    async def get_resumes(self) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM resumes ORDER BY is_default DESC, updated_at DESC"
        )
        rows = await cursor.fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["is_default"] = bool(d["is_default"])
            d["search_terms"] = json.loads(d["search_terms"]) if d["search_terms"] else []
            d["job_titles"] = json.loads(d["job_titles"]) if d["job_titles"] else []
            d["key_skills"] = json.loads(d["key_skills"]) if d["key_skills"] else []
            results.append(d)
        return results

    async def get_resume(self, resume_id: int) -> dict | None:
        cursor = await self.db.execute(
            "SELECT * FROM resumes WHERE id = ?", (resume_id,)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["is_default"] = bool(d["is_default"])
        d["search_terms"] = json.loads(d["search_terms"]) if d["search_terms"] else []
        d["job_titles"] = json.loads(d["job_titles"]) if d["job_titles"] else []
        d["key_skills"] = json.loads(d["key_skills"]) if d["key_skills"] else []
        return d

    async def get_default_resume(self) -> dict | None:
        cursor = await self.db.execute(
            "SELECT * FROM resumes WHERE is_default = 1"
        )
        row = await cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["is_default"] = True
        d["search_terms"] = json.loads(d["search_terms"]) if d["search_terms"] else []
        d["job_titles"] = json.loads(d["job_titles"]) if d["job_titles"] else []
        d["key_skills"] = json.loads(d["key_skills"]) if d["key_skills"] else []
        return d

    async def create_resume(self, name: str, resume_text: str, is_default: bool = False,
                            search_terms: list | None = None, job_titles: list | None = None,
                            key_skills: list | None = None, seniority: str = "",
                            summary: str = "") -> int:
        now = datetime.now(timezone.utc).isoformat()
        if is_default:
            await self.db.execute("UPDATE resumes SET is_default = 0")
        cursor = await self.db.execute(
            """INSERT INTO resumes (name, resume_text, is_default, search_terms, job_titles,
               key_skills, seniority, summary, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (name, resume_text, int(is_default),
             json.dumps(search_terms or []), json.dumps(job_titles or []),
             json.dumps(key_skills or []), seniority, summary, now, now),
        )
        await self.db.commit()
        return cursor.lastrowid

    async def update_resume(self, resume_id: int, **fields) -> bool:
        existing = await self.get_resume(resume_id)
        if not existing:
            return False
        now = datetime.now(timezone.utc).isoformat()
        for key in ("search_terms", "job_titles", "key_skills"):
            if key in fields and isinstance(fields[key], list):
                fields[key] = json.dumps(fields[key])
        if "is_default" in fields:
            fields["is_default"] = int(fields["is_default"])
        fields["updated_at"] = now
        _validate_columns("resumes", fields.keys())
        sets = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [resume_id]
        await self.db.execute(f"UPDATE resumes SET {sets} WHERE id = ?", vals)
        await self.db.commit()
        return True

    async def set_default_resume(self, resume_id: int) -> bool:
        existing = await self.get_resume(resume_id)
        if not existing:
            return False
        await self.db.execute("UPDATE resumes SET is_default = 0")
        await self.db.execute(
            "UPDATE resumes SET is_default = 1, updated_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), resume_id),
        )
        await self.db.commit()
        return True

    async def delete_resume(self, resume_id: int) -> bool:
        cursor = await self.db.execute(
            "DELETE FROM resumes WHERE id = ?", (resume_id,)
        )
        await self.db.commit()
        return cursor.rowcount > 0

    async def migrate_resume_from_search_config(self):
        existing = await self.get_resumes()
        if existing:
            return
        config = await self.get_search_config()
        if not config or not config.get("resume_text"):
            return
        await self.create_resume(
            name="Default Resume",
            resume_text=config["resume_text"],
            is_default=True,
            search_terms=config.get("search_terms", []),
            job_titles=config.get("job_titles", []),
            key_skills=config.get("key_skills", []),
            seniority=config.get("seniority", ""),
            summary=config.get("summary", ""),
        )

    # --- Response Tracking ---

    async def record_response(self, job_id: int, response_type: str) -> dict:
        now = datetime.now(timezone.utc).isoformat()
        application = await self.get_application(job_id)
        if not application:
            raise ValueError(f"No application found for job {job_id}")

        days_to_response = None
        applied_at = application.get("applied_at")
        if applied_at:
            try:
                applied_dt = datetime.fromisoformat(applied_at)
                if applied_dt.tzinfo is None:
                    applied_dt = applied_dt.replace(tzinfo=timezone.utc)
                days_to_response = (datetime.now(timezone.utc) - applied_dt).days
            except (ValueError, TypeError):
                pass

        await self.update_application(
            application["id"],
            response_received_at=now,
            response_type=response_type,
            days_to_response=days_to_response,
        )
        await self.add_event(job_id, "response_received", f"Response: {response_type}")
        return {
            "response_type": response_type,
            "response_received_at": now,
            "days_to_response": days_to_response,
        }

    async def get_response_analytics(self) -> dict:
        # Total applications with responses
        cursor = await self.db.execute(
            "SELECT COUNT(*) FROM applications WHERE applied_at IS NOT NULL"
        )
        total_applied = (await cursor.fetchone())[0]

        cursor = await self.db.execute(
            "SELECT COUNT(*) FROM applications WHERE response_type IS NOT NULL"
        )
        total_responses = (await cursor.fetchone())[0]

        response_rate = round(total_responses / total_applied * 100, 1) if total_applied > 0 else 0

        # Avg days to response
        cursor = await self.db.execute(
            "SELECT AVG(days_to_response) FROM applications WHERE days_to_response IS NOT NULL"
        )
        avg_days = (await cursor.fetchone())[0]
        avg_days_to_response = round(avg_days, 1) if avg_days else None

        # Response type breakdown
        cursor = await self.db.execute(
            """SELECT response_type, COUNT(*) as count
               FROM applications WHERE response_type IS NOT NULL
               GROUP BY response_type"""
        )
        type_breakdown = {r[0]: r[1] for r in await cursor.fetchall()}

        # Response rate by source
        cursor = await self.db.execute(
            """SELECT s.source_name,
                      COUNT(DISTINCT CASE WHEN a.applied_at IS NOT NULL THEN a.job_id END) as applied,
                      COUNT(DISTINCT CASE WHEN a.response_type IS NOT NULL THEN a.job_id END) as responded
               FROM sources s
               JOIN applications a ON a.job_id = s.job_id
               GROUP BY s.source_name"""
        )
        by_source = []
        for r in await cursor.fetchall():
            applied_count = r[1]
            responded_count = r[2]
            rate = round(responded_count / applied_count * 100, 1) if applied_count > 0 else 0
            by_source.append({
                "source": r[0], "applied": applied_count,
                "responded": responded_count, "rate": rate,
            })

        # Response rate by score range
        cursor = await self.db.execute(
            """SELECT
                CASE
                    WHEN js.match_score >= 80 THEN '80-100'
                    WHEN js.match_score >= 60 THEN '60-79'
                    WHEN js.match_score >= 40 THEN '40-59'
                    ELSE '0-39'
                END as score_range,
                COUNT(DISTINCT CASE WHEN a.applied_at IS NOT NULL THEN a.job_id END) as applied,
                COUNT(DISTINCT CASE WHEN a.response_type IS NOT NULL THEN a.job_id END) as responded
               FROM applications a
               JOIN job_scores js ON js.job_id = a.job_id
               GROUP BY score_range
               ORDER BY score_range DESC"""
        )
        by_score = []
        for r in await cursor.fetchall():
            applied_count = r[1]
            responded_count = r[2]
            rate = round(responded_count / applied_count * 100, 1) if applied_count > 0 else 0
            by_score.append({
                "range": r[0], "applied": applied_count,
                "responded": responded_count, "rate": rate,
            })

        return {
            "total_applied": total_applied,
            "total_responses": total_responses,
            "response_rate": response_rate,
            "avg_days_to_response": avg_days_to_response,
            "type_breakdown": type_breakdown,
            "by_source": by_source,
            "by_score_range": by_score,
        }

    # --- Job Alerts CRUD ---

    async def get_job_alerts(self) -> list[dict]:
        cursor = await self.db.execute("SELECT * FROM job_alerts ORDER BY created_at DESC")
        rows = await cursor.fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["filters"] = json.loads(d["filters"]) if d["filters"] else {}
            d["enabled"] = bool(d["enabled"])
            results.append(d)
        return results

    async def get_job_alert(self, alert_id: int) -> dict | None:
        cursor = await self.db.execute("SELECT * FROM job_alerts WHERE id = ?", (alert_id,))
        row = await cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["filters"] = json.loads(d["filters"]) if d["filters"] else {}
        d["enabled"] = bool(d["enabled"])
        return d

    async def create_job_alert(self, name: str, filters: dict, min_score: int = 0,
                                notify_method: str = "in_app") -> int:
        now = datetime.now(timezone.utc).isoformat()
        cursor = await self.db.execute(
            """INSERT INTO job_alerts (name, filters, min_score, enabled, notify_method, created_at)
               VALUES (?, ?, ?, 1, ?, ?)""",
            (name, json.dumps(filters), min_score, notify_method, now),
        )
        await self.db.commit()
        return cursor.lastrowid

    async def update_job_alert(self, alert_id: int, **fields) -> bool:
        existing = await self.get_job_alert(alert_id)
        if not existing:
            return False
        if "filters" in fields and isinstance(fields["filters"], dict):
            fields["filters"] = json.dumps(fields["filters"])
        if "enabled" in fields:
            fields["enabled"] = int(fields["enabled"])
        _validate_columns("job_alerts", fields.keys())
        sets = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [alert_id]
        await self.db.execute(f"UPDATE job_alerts SET {sets} WHERE id = ?", vals)
        await self.db.commit()
        return True

    async def delete_job_alert(self, alert_id: int) -> bool:
        cursor = await self.db.execute("DELETE FROM job_alerts WHERE id = ?", (alert_id,))
        await self.db.commit()
        return cursor.rowcount > 0

    async def get_new_jobs_for_alert(self, alert: dict) -> list[dict]:
        last_checked = alert.get("last_checked_at")
        min_score = alert.get("min_score", 0)
        filters = alert.get("filters", {})

        query = """
            SELECT j.id, j.title, j.company, j.url, j.location, j.created_at,
                   js.match_score
            FROM jobs j
            LEFT JOIN job_scores js ON j.id = js.job_id
            WHERE j.dismissed = 0 AND COALESCE(js.match_score, 0) >= ?
        """
        params: list = [min_score]

        if last_checked:
            query += " AND j.created_at > ?"
            params.append(last_checked)

        if filters.get("search"):
            query += " AND (j.title LIKE ? OR j.company LIKE ?)"
            params.extend([f"%{filters['search']}%", f"%{filters['search']}%"])
        if filters.get("source"):
            query += " AND j.id IN (SELECT job_id FROM sources WHERE source_name = ?)"
            params.append(filters["source"])
        if filters.get("location"):
            query += " AND j.location LIKE ?"
            params.append(f"%{filters['location']}%")

        query += " ORDER BY j.created_at DESC LIMIT 50"
        cursor = await self.db.execute(query, params)
        return [dict(r) for r in await cursor.fetchall()]

    async def mark_alert_checked(self, alert_id: int):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            "UPDATE job_alerts SET last_checked_at = ? WHERE id = ?", (now, alert_id)
        )
        await self.db.commit()

    # --- Application Queue ---

    async def add_to_queue(self, job_id: int, resume_id: int | None = None,
                            priority: int = 0) -> int:
        now = datetime.now(timezone.utc).isoformat()
        cursor = await self.db.execute(
            """INSERT INTO application_queue (job_id, resume_id, status, priority, queued_at)
               VALUES (?, ?, 'queued', ?, ?)
               ON CONFLICT(job_id) DO UPDATE SET
               resume_id=excluded.resume_id, priority=excluded.priority""",
            (job_id, resume_id, priority, now),
        )
        await self.db.commit()
        return cursor.lastrowid

    async def get_queue(self, status: str | None = None) -> list[dict]:
        query = """
            SELECT aq.*, j.title, j.company, j.url, js.match_score
            FROM application_queue aq
            INNER JOIN jobs j ON aq.job_id = j.id
            LEFT JOIN job_scores js ON aq.job_id = js.job_id
        """
        params = []
        if status:
            query += " WHERE aq.status = ?"
            params.append(status)
        query += " ORDER BY aq.priority DESC, aq.queued_at ASC"
        cursor = await self.db.execute(query, params)
        return [dict(r) for r in await cursor.fetchall()]

    async def get_queue_item(self, queue_id: int) -> dict | None:
        cursor = await self.db.execute(
            "SELECT * FROM application_queue WHERE id = ?", (queue_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def update_queue_status(self, queue_id: int, status: str):
        sets = {"status": status}
        if status == "ready":
            sets["prepared_at"] = datetime.now(timezone.utc).isoformat()
        set_clause = ", ".join(f"{k} = ?" for k in sets)
        vals = list(sets.values()) + [queue_id]
        await self.db.execute(
            f"UPDATE application_queue SET {set_clause} WHERE id = ?", vals
        )
        await self.db.commit()

    async def remove_from_queue(self, queue_id: int) -> bool:
        cursor = await self.db.execute(
            "DELETE FROM application_queue WHERE id = ?", (queue_id,)
        )
        await self.db.commit()
        return cursor.rowcount > 0

    async def bulk_update_queue_status(self, from_status: str, to_status: str) -> int:
        now = datetime.now(timezone.utc).isoformat()
        prepared_at_set = ", prepared_at = ?" if to_status == "ready" else ""
        params = [to_status]
        if to_status == "ready":
            params.append(now)
        params.append(from_status)
        cursor = await self.db.execute(
            f"UPDATE application_queue SET status = ?{prepared_at_set} WHERE status = ?",
            params,
        )
        await self.db.commit()
        return cursor.rowcount

    async def get_queue_items_by_status(self, status: str) -> list[dict]:
        cursor = await self.db.execute(
            """SELECT aq.*, j.title, j.company, j.url
               FROM application_queue aq
               INNER JOIN jobs j ON aq.job_id = j.id
               WHERE aq.status = ?
               ORDER BY aq.priority DESC, aq.queued_at ASC""",
            (status,),
        )
        return [dict(r) for r in await cursor.fetchall()]

    async def update_queue_fill_status(self, queue_id: int, fill_status: str,
                                        fill_progress: int | None = None):
        sets = {"status": fill_status}
        if fill_status == "submitted":
            sets["prepared_at"] = datetime.now(timezone.utc).isoformat()
        set_clause = ", ".join(f"{k} = ?" for k in sets)
        vals = list(sets.values()) + [queue_id]
        await self.db.execute(
            f"UPDATE application_queue SET {set_clause} WHERE id = ?", vals
        )
        await self.db.commit()

    # --- Follow-Up Templates CRUD ---

    async def get_follow_up_templates(self) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM follow_up_templates ORDER BY is_default DESC, days_after ASC"
        )
        rows = await cursor.fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["is_default"] = bool(d["is_default"])
            results.append(d)
        return results

    async def get_follow_up_template(self, template_id: int) -> dict | None:
        cursor = await self.db.execute(
            "SELECT * FROM follow_up_templates WHERE id = ?", (template_id,)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["is_default"] = bool(d["is_default"])
        return d

    async def create_follow_up_template(self, name: str, days_after: int,
                                          template_text: str, is_default: bool = False) -> int:
        if is_default:
            await self.db.execute("UPDATE follow_up_templates SET is_default = 0")
        cursor = await self.db.execute(
            "INSERT INTO follow_up_templates (name, days_after, template_text, is_default) VALUES (?, ?, ?, ?)",
            (name, days_after, template_text, int(is_default)),
        )
        await self.db.commit()
        return cursor.lastrowid

    async def update_follow_up_template(self, template_id: int, **fields) -> bool:
        existing = await self.get_follow_up_template(template_id)
        if not existing:
            return False
        if "is_default" in fields:
            if fields["is_default"]:
                await self.db.execute("UPDATE follow_up_templates SET is_default = 0")
            fields["is_default"] = int(fields["is_default"])
        _validate_columns("follow_up_templates", fields.keys())
        sets = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [template_id]
        await self.db.execute(f"UPDATE follow_up_templates SET {sets} WHERE id = ?", vals)
        await self.db.commit()
        return True

    async def delete_follow_up_template(self, template_id: int) -> bool:
        cursor = await self.db.execute(
            "DELETE FROM follow_up_templates WHERE id = ?", (template_id,)
        )
        await self.db.commit()
        return cursor.rowcount > 0

    async def update_reminder_draft(self, reminder_id: int, draft_text: str):
        await self.db.execute(
            "UPDATE reminders SET draft_text = ? WHERE id = ?",
            (draft_text, reminder_id),
        )
        await self.db.commit()

    async def mark_reminder_sent(self, reminder_id: int):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            "UPDATE reminders SET sent_at = ?, status = 'completed', completed_at = ? WHERE id = ?",
            (now, now, reminder_id),
        )
        await self.db.commit()

    # --- Contacts CRM ---

    async def get_contacts(self) -> list[dict]:
        cursor = await self.db.execute("SELECT * FROM contacts ORDER BY updated_at DESC")
        return [dict(r) for r in await cursor.fetchall()]

    async def get_contact(self, contact_id: int) -> dict | None:
        cursor = await self.db.execute("SELECT * FROM contacts WHERE id = ?", (contact_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def create_contact(self, name: str, **fields) -> int:
        now = datetime.now(timezone.utc).isoformat()
        cols = ["name", "created_at", "updated_at"]
        vals = [name, now, now]
        for key in ("email", "phone", "company", "role", "linkedin_url", "notes"):
            if key in fields:
                cols.append(key)
                vals.append(fields[key])
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        cursor = await self.db.execute(
            f"INSERT INTO contacts ({col_str}) VALUES ({placeholders})", vals
        )
        await self.db.commit()
        return cursor.lastrowid

    async def update_contact(self, contact_id: int, **fields) -> bool:
        existing = await self.get_contact(contact_id)
        if not existing:
            return False
        fields["updated_at"] = datetime.now(timezone.utc).isoformat()
        _validate_columns("contacts", fields.keys())
        sets = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [contact_id]
        await self.db.execute(f"UPDATE contacts SET {sets} WHERE id = ?", vals)
        await self.db.commit()
        return True

    async def delete_contact(self, contact_id: int) -> bool:
        await self.db.execute("DELETE FROM contact_interactions WHERE contact_id = ?", (contact_id,))
        await self.db.execute("DELETE FROM job_contacts WHERE contact_id = ?", (contact_id,))
        cursor = await self.db.execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
        await self.db.commit()
        return cursor.rowcount > 0

    async def get_contact_interactions(self, contact_id: int) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM contact_interactions WHERE contact_id = ? ORDER BY date DESC",
            (contact_id,),
        )
        return [dict(r) for r in await cursor.fetchall()]

    async def add_contact_interaction(self, contact_id: int, type: str,
                                       notes: str, date: str) -> int:
        now = datetime.now(timezone.utc).isoformat()
        cursor = await self.db.execute(
            "INSERT INTO contact_interactions (contact_id, type, notes, date, created_at) VALUES (?, ?, ?, ?, ?)",
            (contact_id, type, notes, date, now),
        )
        await self.db.commit()
        return cursor.lastrowid

    async def get_job_contacts(self, job_id: int) -> list[dict]:
        cursor = await self.db.execute(
            """SELECT c.*, jc.relationship FROM contacts c
               INNER JOIN job_contacts jc ON c.id = jc.contact_id
               WHERE jc.job_id = ?""",
            (job_id,),
        )
        return [dict(r) for r in await cursor.fetchall()]

    async def link_job_contact(self, job_id: int, contact_id: int, relationship: str = "") -> bool:
        await self.db.execute(
            """INSERT INTO job_contacts (job_id, contact_id, relationship) VALUES (?, ?, ?)
               ON CONFLICT(job_id, contact_id) DO UPDATE SET relationship=excluded.relationship""",
            (job_id, contact_id, relationship),
        )
        await self.db.commit()
        return True

    async def unlink_job_contact(self, job_id: int, contact_id: int) -> bool:
        cursor = await self.db.execute(
            "DELETE FROM job_contacts WHERE job_id = ? AND contact_id = ?",
            (job_id, contact_id),
        )
        await self.db.commit()
        return cursor.rowcount > 0

    # --- Career Suggestions ---

    async def get_career_suggestions(self) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM career_suggestions ORDER BY created_at DESC"
        )
        rows = await cursor.fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["transferable_skills"] = json.loads(d["transferable_skills"]) if d["transferable_skills"] else []
            d["gaps"] = json.loads(d["gaps"]) if d["gaps"] else []
            d["accepted"] = bool(d["accepted"])
            results.append(d)
        return results

    async def save_career_suggestions(self, suggestions: list[dict]):
        now = datetime.now(timezone.utc).isoformat()
        for s in suggestions:
            await self.db.execute(
                """INSERT INTO career_suggestions (title, reasoning, transferable_skills, gaps, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (s.get("title", ""), s.get("reasoning", ""),
                 json.dumps(s.get("transferable_skills", [])),
                 json.dumps(s.get("gaps", [])), now),
            )
        await self.db.commit()

    async def accept_career_suggestion(self, suggestion_id: int) -> dict | None:
        cursor = await self.db.execute(
            "SELECT * FROM career_suggestions WHERE id = ?", (suggestion_id,)
        )
        row = await cursor.fetchone()
        if not row:
            return None
        await self.db.execute(
            "UPDATE career_suggestions SET accepted = 1 WHERE id = ?", (suggestion_id,)
        )
        await self.db.commit()
        d = dict(row)
        d["transferable_skills"] = json.loads(d["transferable_skills"]) if d["transferable_skills"] else []
        d["gaps"] = json.loads(d["gaps"]) if d["gaps"] else []
        return d

    # --- Offers ---

    async def get_offers(self) -> list[dict]:
        cursor = await self.db.execute(
            """SELECT o.*, j.title, j.company
               FROM offers o
               LEFT JOIN jobs j ON o.job_id = j.id
               ORDER BY o.created_at DESC"""
        )
        return [dict(r) for r in await cursor.fetchall()]

    async def get_offer(self, offer_id: int) -> dict | None:
        cursor = await self.db.execute(
            """SELECT o.*, j.title, j.company
               FROM offers o
               LEFT JOIN jobs j ON o.job_id = j.id
               WHERE o.id = ?""",
            (offer_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def create_offer(self, **fields) -> int:
        now = datetime.now(timezone.utc).isoformat()
        cols = ["created_at"]
        vals = [now]
        for key in ("job_id", "base", "equity", "bonus", "pto_days", "remote_days",
                     "health_value", "retirement_match", "relocation", "location", "notes"):
            if key in fields:
                cols.append(key)
                vals.append(fields[key])
        placeholders = ", ".join("?" for _ in cols)
        col_str = ", ".join(cols)
        cursor = await self.db.execute(
            f"INSERT INTO offers ({col_str}) VALUES ({placeholders})", vals
        )
        await self.db.commit()
        return cursor.lastrowid

    async def update_offer(self, offer_id: int, **fields) -> bool:
        existing = await self.get_offer(offer_id)
        if not existing:
            return False
        _validate_columns("offers", fields.keys())
        sets = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [offer_id]
        await self.db.execute(f"UPDATE offers SET {sets} WHERE id = ?", vals)
        await self.db.commit()
        return True

    async def delete_offer(self, offer_id: int) -> bool:
        cursor = await self.db.execute("DELETE FROM offers WHERE id = ?", (offer_id,))
        await self.db.commit()
        return cursor.rowcount > 0

    async def get_application_history_summary(self) -> str:
        cursor = await self.db.execute("""
            SELECT a.status, COUNT(*) as count FROM applications a
            INNER JOIN jobs j ON j.id = a.job_id
            GROUP BY a.status
        """)
        status_counts = {r[0]: r[1] for r in await cursor.fetchall()}

        cursor = await self.db.execute("""
            SELECT a.status, AVG(js.match_score) as avg_score
            FROM applications a
            JOIN job_scores js ON js.job_id = a.job_id
            GROUP BY a.status
        """)
        score_avgs = {r[0]: round(r[1], 1) if r[1] else None for r in await cursor.fetchall()}

        cursor = await self.db.execute("""
            SELECT a.response_type, COUNT(*) as count
            FROM applications a
            WHERE a.response_type IS NOT NULL
            GROUP BY a.response_type
        """)
        response_counts = {r[0]: r[1] for r in await cursor.fetchall()}

        lines = ["Application History:"]
        for status, count in status_counts.items():
            avg = score_avgs.get(status)
            line = f"- {status}: {count} applications"
            if avg:
                line += f" (avg score: {avg})"
            lines.append(line)
        if response_counts:
            lines.append("Response breakdown:")
            for rtype, count in response_counts.items():
                lines.append(f"- {rtype}: {count}")
        return "\n".join(lines) if len(lines) > 1 else "No application history yet."

    # --- Embedding settings ---

    async def get_embedding_settings(self) -> dict | None:
        cursor = await self.db.execute("SELECT * FROM embedding_settings WHERE id = 1")
        row = await cursor.fetchone()
        if not row:
            return None
        return dict(row)

    async def save_embedding_settings(self, provider: str, api_key: str = "",
                                      model: str = "", base_url: str = "",
                                      dimensions: int = 256):
        now = datetime.now(timezone.utc).isoformat()
        await self.db.execute(
            """INSERT INTO embedding_settings (id, provider, api_key, model, base_url, dimensions, updated_at)
               VALUES (1, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
               provider = excluded.provider,
               api_key = excluded.api_key,
               model = excluded.model,
               base_url = excluded.base_url,
               dimensions = excluded.dimensions,
               updated_at = excluded.updated_at""",
            (provider, api_key, model, base_url, dimensions, now)
        )
        await self.db.commit()

    # --- Embedding CRUD ---

    @staticmethod
    def _serialize_f32(vec: list[float]) -> bytes:
        return struct.pack(f"{len(vec)}f", *vec)

    async def upsert_job_embedding(self, job_id: int, vector: list[float]):
        if not self._vec_loaded:
            return
        from app.embeddings import upsert_embedding
        await upsert_embedding(self.db, "vec_jobs", job_id, vector)

    async def upsert_context_embedding(self, item_id: int, vector: list[float]):
        if not self._vec_loaded:
            return
        from app.embeddings import upsert_embedding
        await upsert_embedding(self.db, "vec_context", item_id, vector)

    async def find_similar_jobs_by_vector(self, query_vector: list[float],
                                          limit: int = 10) -> list[dict]:
        if not self._vec_loaded:
            return []
        from app.embeddings import search_embeddings
        results = await search_embeddings(self.db, "vec_jobs", query_vector, limit=limit)
        if not results:
            return []
        job_ids = [job_id for job_id, _ in results]
        distance_map = {job_id: distance for job_id, distance in results}
        placeholders = ",".join("?" for _ in job_ids)
        cursor = await self.db.execute(
            f"SELECT id, title, company, location, url FROM jobs WHERE id IN ({placeholders})",
            job_ids,
        )
        rows = await cursor.fetchall()
        row_map = {row["id"]: dict(row) for row in rows}
        similar = []
        for job_id in job_ids:
            if job_id in row_map:
                similar.append({**row_map[job_id], "distance": distance_map[job_id]})
        return similar

    async def find_similar_context_by_vector(self, query_vector: list[float],
                                             limit: int = 10) -> list[tuple[int, float]]:
        if not self._vec_loaded:
            return []
        from app.embeddings import search_embeddings
        return await search_embeddings(self.db, "vec_context", query_vector, limit=limit)

    async def delete_job_embedding(self, job_id: int):
        if not self._vec_loaded:
            return
        from app.embeddings import delete_embedding
        await delete_embedding(self.db, "vec_jobs", job_id)

    async def delete_context_embedding(self, item_id: int):
        if not self._vec_loaded:
            return
        from app.embeddings import delete_embedding
        await delete_embedding(self.db, "vec_context", item_id)
