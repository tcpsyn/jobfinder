import hashlib
import json
from datetime import datetime, timezone

import aiosqlite


def make_dedup_hash(title: str, company: str, url: str) -> str:
    normalized = f"{title.lower().strip()}|{company.lower().strip()}|{url.lower().strip().rstrip('/')}"
    return hashlib.sha256(normalized.encode()).hexdigest()


class Database:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.db = None

    async def init(self):
        self.db = await aiosqlite.connect(self.db_path)
        self.db.row_factory = aiosqlite.Row
        await self._create_tables()

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
                FOREIGN KEY (job_id) REFERENCES jobs(id)
            );
            CREATE TABLE IF NOT EXISTS job_scores (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER UNIQUE NOT NULL,
                match_score INTEGER NOT NULL,
                match_reasons TEXT NOT NULL,
                concerns TEXT NOT NULL,
                suggested_keywords TEXT NOT NULL,
                scored_at TEXT NOT NULL,
                FOREIGN KEY (job_id) REFERENCES jobs(id)
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
                FOREIGN KEY (job_id) REFERENCES jobs(id)
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
                FOREIGN KEY (job_id) REFERENCES jobs(id)
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
                user_id INTEGER NOT NULL DEFAULT 1 CHECK (id = 1),
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
        """)
        await self._migrate()
        await self.db.commit()

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
        return cursor.lastrowid

    async def get_job(self, job_id):
        cursor = await self.db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def find_job_by_hash(self, dedup_hash):
        cursor = await self.db.execute("SELECT * FROM jobs WHERE dedup_hash = ?", (dedup_hash,))
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

    async def insert_application(self, job_id, status="interested"):
        cursor = await self.db.execute(
            "INSERT INTO applications (job_id, status) VALUES (?, ?)", (job_id, status)
        )
        await self.db.commit()
        return cursor.lastrowid

    async def update_application(self, app_id, **kwargs):
        sets = ", ".join(f"{k} = ?" for k in kwargs)
        vals = list(kwargs.values())
        vals.append(app_id)
        await self.db.execute(f"UPDATE applications SET {sets} WHERE id = ?", vals)
        await self.db.commit()

    async def get_application(self, job_id):
        cursor = await self.db.execute("SELECT * FROM applications WHERE job_id = ?", (job_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def list_jobs(self, sort_by="score", limit=50, offset=0, min_score=None,
                        search=None, source=None, dismissed=False,
                        work_type=None, employment_type=None, location=None,
                        exclude_terms=None, region=None, clearance=None):
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
        if sort_by == "score":
            query += " ORDER BY js.match_score DESC NULLS LAST"
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

    async def update_job_contact(self, job_id: int, **fields):
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

    async def get_events(self, job_id: int) -> list[dict]:
        cursor = await self.db.execute(
            "SELECT * FROM app_events WHERE job_id = ? ORDER BY created_at DESC", (job_id,)
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def find_similar_jobs(self, title: str, company: str, exclude_id: int = None) -> list[dict]:
        """Find jobs with similar company name (fuzzy match on company, same or similar title)."""
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

    async def get_company(self, name: str) -> dict | None:
        normalized = name.lower().strip()
        cursor = await self.db.execute(
            "SELECT * FROM companies WHERE normalized_name = ?", (normalized,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def save_company(self, name: str, **fields):
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
        await self.db.executescript("""
            DELETE FROM sources;
            DELETE FROM job_scores;
            DELETE FROM applications;
            DELETE FROM app_events;
            DELETE FROM jobs;
        """)
        await self.db.commit()

    async def get_user_profile(self) -> dict | None:
        cursor = await self.db.execute("SELECT * FROM user_profile WHERE id = 1")
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def save_user_profile(self, **fields):
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
        await self.db.commit()

    async def get_full_profile(self) -> dict:
        profile = await self.get_user_profile()
        if not profile:
            profile = {}
        profile["work_history"] = await self.get_work_history()
        profile["education"] = await self.get_education()
        profile["certifications"] = await self.get_certifications()
        profile["skills"] = await self.get_skills()
        profile["languages"] = await self.get_languages()
        profile["references"] = await self.get_references()
        profile["military"] = await self.get_military_service()
        profile["eeo"] = await self.get_eeo_responses()
        return profile

    async def save_full_profile(self, data: dict):
        nested_keys = {"work_history", "education", "certifications", "skills",
                        "languages", "references", "military", "eeo"}
        profile_fields = {k: v for k, v in data.items() if k not in nested_keys}
        if profile_fields:
            # Merge with existing profile so we don't blank out fields not sent
            existing = await self.get_user_profile() or {}
            existing.pop("id", None)
            existing.pop("updated_at", None)
            existing.update(profile_fields)
            await self.save_user_profile(**existing)

        if "work_history" in data:
            await self._replace_list("work_history", data["work_history"])
        if "education" in data:
            await self._replace_list("education", data["education"])
        if "certifications" in data:
            await self._replace_list("certifications", data["certifications"])
        if "skills" in data:
            await self._replace_list("skills", data["skills"])
        if "languages" in data:
            await self._replace_list("languages", data["languages"])
        if "references" in data:
            await self._replace_list("user_references", data["references"])
        if "military" in data:
            await self.save_military_service(data["military"])
        if "eeo" in data:
            await self.save_eeo_responses(data["eeo"])

    async def _replace_list(self, table: str, items: list):
        await self.db.execute(f"DELETE FROM {table} WHERE user_id = 1")
        for i, item in enumerate(items):
            item.pop("id", None)
            item["user_id"] = 1
            if "sort_order" in self._get_table_cols(table):
                item.setdefault("sort_order", i)
            cols = list(item.keys())
            vals = list(item.values())
            placeholders = ", ".join("?" for _ in cols)
            col_str = ", ".join(cols)
            await self.db.execute(f"INSERT INTO {table} ({col_str}) VALUES ({placeholders})", vals)
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

    async def save_military_service(self, fields: dict):
        fields.pop("id", None)
        fields.pop("user_id", None)
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

    async def save_eeo_responses(self, fields: dict):
        fields.pop("id", None)
        if "veteran_categories" in fields and isinstance(fields["veteran_categories"], list):
            fields["veteran_categories"] = json.dumps(fields["veteran_categories"])
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
        await self.db.executescript("""
            DELETE FROM sources;
            DELETE FROM job_scores;
            DELETE FROM applications;
            DELETE FROM app_events;
            DELETE FROM jobs;
            DELETE FROM search_config;
            DELETE FROM ai_settings;
            DELETE FROM user_profile;
            DELETE FROM companies;
            DELETE FROM work_history;
            DELETE FROM education;
            DELETE FROM certifications;
            DELETE FROM skills;
            DELETE FROM languages;
            DELETE FROM user_references;
            DELETE FROM military_service;
            DELETE FROM eeo_responses;
            DELETE FROM custom_qa;
            DELETE FROM autofill_history;
        """)
        await self.db.commit()

    async def get_stats(self):
        stats = {}
        for key, query in [
            ("total_jobs", "SELECT COUNT(*) FROM jobs WHERE dismissed = 0"),
            ("total_scored", "SELECT COUNT(*) FROM job_scores"),
            ("total_applied", "SELECT COUNT(*) FROM applications WHERE status = 'applied'"),
            ("total_interested", "SELECT COUNT(*) FROM applications WHERE status = 'interested'"),
            ("total_interviewing", "SELECT COUNT(*) FROM applications WHERE status = 'interviewing'"),
            ("total_prepared", "SELECT COUNT(*) FROM applications WHERE status = 'prepared'"),
        ]:
            cursor = await self.db.execute(query)
            row = await cursor.fetchone()
            stats[key] = row[0]
        return stats
