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
                        exclude_terms=None):
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
        if sort_by == "score":
            query += " ORDER BY js.match_score DESC NULLS LAST"
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
        cols = ["full_name", "email", "phone", "location", "linkedin_url", "github_url", "portfolio_url"]
        values = [fields.get(c, "") for c in cols]
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
