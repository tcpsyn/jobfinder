import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import AsyncClient, ASGITransport

from app.database import Database


@pytest.fixture
async def app(tmp_path):
    from app.main import create_app
    application = create_app(db_path=str(tmp_path / "test.db"), testing=True)
    db = Database(str(tmp_path / "test.db"))
    await db.init()
    application.state.db = db
    yield application
    await db.close()


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.mark.asyncio
async def test_health(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_list_jobs_empty(client):
    resp = await client.get("/api/jobs")
    assert resp.status_code == 200
    assert resp.json()["jobs"] == []


@pytest.mark.asyncio
async def test_get_stats(client):
    resp = await client.get("/api/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert "total_jobs" in data
    assert "total_scored" in data
    assert "total_applied" in data


@pytest.mark.asyncio
async def test_get_job_not_found(client):
    resp = await client.get("/api/jobs/999")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_trigger_scrape(client):
    resp = await client.post("/api/scrape")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_dismiss_job_not_found(client):
    resp = await client.post("/api/jobs/999/dismiss")
    assert resp.status_code in [200, 404]


@pytest.mark.asyncio
async def test_prepare_not_found(client):
    resp = await client.post("/api/jobs/999/prepare")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_prepare_no_tailor(client, app):
    db = app.state.db
    job_id = await db.insert_job(
        title="Engineer", company="Acme", location="Remote",
        salary_min=150000, salary_max=200000,
        description="Build things", url="https://example.com/job1",
        posted_date="2026-01-01", application_method="url",
        contact_email=None,
    )
    app.state.tailor = None
    resp = await client.post(f"/api/jobs/{job_id}/prepare")
    assert resp.status_code == 503


@pytest.mark.asyncio
async def test_prepare_with_mock_tailor(client, app):
    db = app.state.db
    job_id = await db.insert_job(
        title="Engineer", company="Acme", location="Remote",
        salary_min=150000, salary_max=200000,
        description="Build things", url="https://example.com/job2",
        posted_date="2026-01-01", application_method="url",
        contact_email=None,
    )
    await db.insert_score(
        job_id, 85, ["Good skills match"], ["No concerns"], ["Python", "AWS"],
    )

    mock_tailor = MagicMock()
    mock_tailor.prepare = AsyncMock(return_value={
        "tailored_resume": "Tailored resume text",
        "cover_letter": "Dear hiring manager...",
    })
    app.state.tailor = mock_tailor

    resp = await client.post(f"/api/jobs/{job_id}/prepare")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "prepared"
    assert data["tailored_resume"] == "Tailored resume text"
    assert data["cover_letter"] == "Dear hiring manager..."

    mock_tailor.prepare.assert_called_once_with(
        job_description="Build things",
        match_reasons=["Good skills match"],
        suggested_keywords=["Python", "AWS"],
    )

    application = await db.get_application(job_id)
    assert application is not None
    assert application["status"] == "prepared"
    assert application["tailored_resume"] == "Tailored resume text"


@pytest.mark.asyncio
async def test_email_no_job(client):
    resp = await client.post("/api/jobs/999/email")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_email_no_cover_letter(client, app):
    db = app.state.db
    job_id = await db.insert_job(
        title="Engineer", company="Acme", location="Remote",
        salary_min=150000, salary_max=200000,
        description="Build things", url="https://example.com/job3",
        posted_date="2026-01-01", application_method="url",
        contact_email="hr@acme.com",
    )
    resp = await client.post(f"/api/jobs/{job_id}/email")
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_email_success(client, app):
    db = app.state.db
    job_id = await db.insert_job(
        title="Engineer", company="Acme", location="Remote",
        salary_min=150000, salary_max=200000,
        description="Build things", url="https://example.com/job4",
        posted_date="2026-01-01", application_method="email",
        contact_email="hr@acme.com",
    )
    app_id = await db.insert_application(job_id, "prepared")
    await db.update_application(app_id, cover_letter="Dear hiring manager...")

    resp = await client.post(f"/api/jobs/{job_id}/email")
    assert resp.status_code == 200
    data = resp.json()
    assert data["email"]["to"] == "hr@acme.com"
    assert "Engineer" in data["email"]["subject"]


@pytest.mark.asyncio
async def test_email_no_contact(client, app):
    db = app.state.db
    job_id = await db.insert_job(
        title="Engineer", company="Acme", location="Remote",
        salary_min=150000, salary_max=200000,
        description="Build things", url="https://example.com/job5",
        posted_date="2026-01-01", application_method="url",
        contact_email=None,
    )
    app_id = await db.insert_application(job_id, "prepared")
    await db.update_application(app_id, cover_letter="Dear hiring manager...")

    resp = await client.post(f"/api/jobs/{job_id}/email")
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_get_search_config_empty(client):
    resp = await client.get("/api/search-config")
    assert resp.status_code == 200
    data = resp.json()
    assert data["search_terms"] == []
    assert data["resume_text"] == ""


@pytest.mark.asyncio
async def test_update_search_terms(client, app):
    db = app.state.db
    await db.save_search_config("resume", ["old"])
    resp = await client.post("/api/search-config/terms", json={"search_terms": ["devops remote", "SRE"]})
    assert resp.status_code == 200
    assert resp.json()["search_terms"] == ["devops remote", "SRE"]

    config = await db.get_search_config()
    assert config["search_terms"] == ["devops remote", "SRE"]


@pytest.mark.asyncio
async def test_upload_resume_no_client(client, app):
    app.state._anthropic_client = None
    app.state.testing = True
    import io
    files = {"file": ("resume.txt", io.BytesIO(b"My resume content"), "text/plain")}
    resp = await client.post("/api/resume/upload", files=files)
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["resume_length"] == len("My resume content")
    assert data["search_terms"] == []


@pytest.mark.asyncio
async def test_upload_resume_pdf(client, app):
    app.state._anthropic_client = None
    app.state.testing = True
    import fitz
    import io
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Senior DevOps Engineer Resume")
    pdf_bytes = doc.tobytes()
    doc.close()
    files = {"file": ("resume.pdf", io.BytesIO(pdf_bytes), "application/pdf")}
    resp = await client.post("/api/resume/upload", files=files)
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["resume_length"] > 0
