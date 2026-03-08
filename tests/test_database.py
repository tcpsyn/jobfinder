import pytest
from app.database import Database, make_dedup_hash


@pytest.fixture
async def db(tmp_path):
    db_path = str(tmp_path / "test.db")
    database = Database(db_path)
    await database.init()
    yield database
    await database.close()


@pytest.mark.asyncio
async def test_insert_and_get_job(db):
    job_id = await db.insert_job(
        title="Senior DevOps Engineer", company="Acme Corp", location="Remote",
        salary_min=160000, salary_max=200000,
        description="We need a senior devops engineer...",
        url="https://example.com/job/1", posted_date="2026-03-01",
        application_method="url", contact_email=None,
    )
    assert job_id is not None
    job = await db.get_job(job_id)
    assert job["title"] == "Senior DevOps Engineer"
    assert job["company"] == "Acme Corp"
    assert job["salary_min"] == 160000


@pytest.mark.asyncio
async def test_insert_source(db):
    job_id = await db.insert_job(
        title="SRE", company="BigCo", location="Remote",
        salary_min=None, salary_max=None, description="SRE role",
        url="https://example.com/job/2", posted_date=None,
        application_method="url", contact_email=None,
    )
    await db.insert_source(job_id, "remoteok", "https://remoteok.com/jobs/123")
    sources = await db.get_sources(job_id)
    assert len(sources) == 1
    assert sources[0]["source_name"] == "remoteok"


@pytest.mark.asyncio
async def test_dedup_hash():
    h = make_dedup_hash("Senior DevOps Engineer", "Acme Corp", "https://example.com/job/1")
    assert isinstance(h, str)
    assert len(h) == 64  # sha256


@pytest.mark.asyncio
async def test_find_by_dedup_hash(db):
    job_id = await db.insert_job(
        title="SRE", company="BigCo", location="Remote",
        salary_min=None, salary_max=None, description="SRE role",
        url="https://example.com/sre", posted_date=None,
        application_method="url", contact_email=None,
    )
    h = make_dedup_hash("SRE", "BigCo", "https://example.com/sre")
    found = await db.find_job_by_hash(h)
    assert found is not None
    assert found["id"] == job_id


@pytest.mark.asyncio
async def test_insert_score(db):
    job_id = await db.insert_job(
        title="SRE", company="BigCo", location="Remote",
        salary_min=None, salary_max=None, description="SRE role",
        url="https://example.com/sre2", posted_date=None,
        application_method="url", contact_email=None,
    )
    await db.insert_score(job_id, 85, ["strong AWS match"], ["no K8s mentioned"], ["kubernetes"])
    score = await db.get_score(job_id)
    assert score["match_score"] == 85
    assert "strong AWS match" in score["match_reasons"]


@pytest.mark.asyncio
async def test_insert_and_update_application(db):
    job_id = await db.insert_job(
        title="SRE", company="BigCo", location="Remote",
        salary_min=None, salary_max=None, description="SRE role",
        url="https://example.com/sre3", posted_date=None,
        application_method="url", contact_email=None,
    )
    app_id = await db.insert_application(job_id, "interested")
    await db.update_application(app_id, status="applied", cover_letter="Dear hiring manager...")
    app = await db.get_application(job_id)
    assert app["status"] == "applied"
    assert app["cover_letter"] == "Dear hiring manager..."


@pytest.mark.asyncio
async def test_list_jobs_with_scores(db):
    for i in range(3):
        jid = await db.insert_job(
            title=f"Job {i}", company=f"Co {i}", location="Remote",
            salary_min=150000 + i * 10000, salary_max=None, description=f"desc {i}",
            url=f"https://example.com/job/{i+10}", posted_date=None,
            application_method="url", contact_email=None,
        )
        await db.insert_score(jid, 90 - i * 10, [], [], [])
    jobs = await db.list_jobs(sort_by="score", limit=10, offset=0)
    assert len(jobs) == 3
    assert jobs[0]["match_score"] >= jobs[1]["match_score"]


@pytest.mark.asyncio
async def test_get_stats(db):
    stats = await db.get_stats()
    assert "total_jobs" in stats
    assert "total_scored" in stats
    assert "total_applied" in stats


@pytest.mark.asyncio
async def test_get_unscored_jobs(db):
    job_id = await db.insert_job(
        title="Unscored", company="Co", location="Remote",
        salary_min=None, salary_max=None, description="desc",
        url="https://example.com/unscored", posted_date=None,
        application_method="url", contact_email=None,
    )
    unscored = await db.get_unscored_jobs(limit=10)
    assert len(unscored) == 1
    assert unscored[0]["id"] == job_id


@pytest.mark.asyncio
async def test_add_and_get_events(db):
    job_id = await db.insert_job(
        title="Dev", company="Co", location="Remote",
        salary_min=None, salary_max=None, description="desc",
        url="http://x", posted_date=None,
        application_method="url", contact_email=None,
    )
    await db.add_event(job_id, "note", "Looks interesting")
    await db.add_event(job_id, "status_change", "interested -> prepared")
    events = await db.get_events(job_id)
    assert len(events) == 2
    assert events[0]["event_type"] == "status_change"  # DESC order
    assert events[1]["event_type"] == "note"


@pytest.mark.asyncio
async def test_save_and_get_profile(db):
    await db.save_user_profile(full_name="John", email="john@example.com", phone="555-1234")
    profile = await db.get_user_profile()
    assert profile["full_name"] == "John"
    assert profile["email"] == "john@example.com"
    assert profile["phone"] == "555-1234"
    assert profile["linkedin_url"] == ""  # default empty


@pytest.mark.asyncio
async def test_update_profile(db):
    await db.save_user_profile(full_name="John")
    await db.save_user_profile(full_name="Jane", email="jane@x.com")
    profile = await db.get_user_profile()
    assert profile["full_name"] == "Jane"
    assert profile["email"] == "jane@x.com"


@pytest.mark.asyncio
async def test_find_similar_jobs(db):
    id1 = await db.insert_job("Senior Dev", "Acme Corp", "Remote", None, None, "desc", "http://a", None, "url", None)
    id2 = await db.insert_job("Junior Dev", "Acme Corp", "NYC", None, None, "desc", "http://b", None, "url", None)
    id3 = await db.insert_job("Designer", "Other Inc", "Remote", None, None, "desc", "http://c", None, "url", None)

    similar = await db.find_similar_jobs("Senior Dev", "Acme Corp", exclude_id=id1)
    assert len(similar) == 1
    assert similar[0]["id"] == id2

    # Other company should not match
    similar2 = await db.find_similar_jobs("Designer", "Other Inc", exclude_id=id3)
    assert len(similar2) == 0  # no other jobs from "Other Inc"


@pytest.mark.asyncio
async def test_dismiss_job(db):
    job_id = await db.insert_job(
        title="Dismiss me", company="Co", location="Remote",
        salary_min=None, salary_max=None, description="desc",
        url="https://example.com/dismiss", posted_date=None,
        application_method="url", contact_email=None,
    )
    await db.dismiss_job(job_id)
    jobs = await db.list_jobs()
    assert len(jobs) == 0
