import pytest
from httpx import AsyncClient, ASGITransport
from app.main import create_app
from app.database import Database


@pytest.fixture
async def app_and_db(tmp_path):
    application = create_app(db_path=str(tmp_path / "test.db"), testing=True)
    db = Database(str(tmp_path / "test.db"))
    await db.init()
    application.state.db = db
    yield application, db
    await db.close()


@pytest.fixture
async def client(app_and_db):
    app, _ = app_and_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.mark.asyncio
async def test_apply_endpoint(client, app_and_db):
    _, db = app_and_db
    job_id = await db.insert_job(
        title="Apply Test", company="Co", location="Remote",
        salary_min=None, salary_max=None, description="d",
        url="https://example.com/job", posted_date=None,
        application_method="url", contact_email=None,
    )
    resp = await client.post(f"/api/jobs/{job_id}/apply")
    assert resp.status_code == 200
    data = resp.json()
    assert data["url"] == "https://example.com/job"
    assert data["status"] == "applied"

    app_record = await db.get_application(job_id)
    assert app_record["status"] == "applied"

    events = await db.get_events(job_id)
    assert any(e["event_type"] == "applied" for e in events)


@pytest.mark.asyncio
async def test_apply_uses_apply_url_when_available(client, app_and_db):
    _, db = app_and_db
    job_id = await db.insert_job(
        title="Apply URL Test", company="Co", location="Remote",
        salary_min=None, salary_max=None, description="d",
        url="https://example.com/listing", posted_date=None,
        application_method="url", contact_email=None,
    )
    await db.update_job_contact(job_id, apply_url="https://example.com/apply-now")
    resp = await client.post(f"/api/jobs/{job_id}/apply")
    data = resp.json()
    assert data["url"] == "https://example.com/apply-now"


@pytest.mark.asyncio
async def test_apply_nonexistent_job(client, app_and_db):
    resp = await client.post("/api/jobs/99999/apply")
    assert resp.status_code == 404
