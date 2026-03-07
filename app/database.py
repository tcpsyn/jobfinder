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
            CREATE INDEX IF NOT EXISTS idx_jobs_dedup ON jobs(dedup_hash);
            CREATE INDEX IF NOT EXISTS idx_scores_job ON job_scores(job_id);
            CREATE INDEX IF NOT EXISTS idx_sources_job ON sources(job_id);
        """)
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
                        search=None, source=None, dismissed=False):
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

    async def get_stats(self):
        stats = {}
        for key, query in [
            ("total_jobs", "SELECT COUNT(*) FROM jobs WHERE dismissed = 0"),
            ("total_scored", "SELECT COUNT(*) FROM job_scores"),
            ("total_applied", "SELECT COUNT(*) FROM applications WHERE status = 'applied'"),
            ("total_interested", "SELECT COUNT(*) FROM applications WHERE status = 'interested'"),
            ("total_interviewing", "SELECT COUNT(*) FROM applications WHERE status = 'interviewing'"),
        ]:
            cursor = await self.db.execute(query)
            row = await cursor.fetchone()
            stats[key] = row[0]
        return stats
