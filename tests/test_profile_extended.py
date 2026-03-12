import json

import pytest
from httpx import AsyncClient, ASGITransport

from app.database import Database


@pytest.fixture
async def db(tmp_path):
    db_path = str(tmp_path / "test.db")
    database = Database(db_path)
    await database.init()
    yield database
    await database.close()


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


# Database-level tests

@pytest.mark.asyncio
async def test_work_history_crud(db):
    entry_id = await db.save_work_history({
        "company": "Acme Corp",
        "job_title": "Engineer",
        "start_year": 2020,
        "is_current": 1,
    })
    assert entry_id is not None

    items = await db.get_work_history()
    assert len(items) == 1
    assert items[0]["company"] == "Acme Corp"
    assert items[0]["is_current"] == 1

    await db.save_work_history({"id": entry_id, "company": "Updated Corp"})
    items = await db.get_work_history()
    assert items[0]["company"] == "Updated Corp"

    await db.delete_work_history(entry_id)
    items = await db.get_work_history()
    assert len(items) == 0


@pytest.mark.asyncio
async def test_education_crud(db):
    entry_id = await db.save_education({
        "school": "MIT",
        "degree_type": "BS",
        "field_of_study": "Computer Science",
    })
    items = await db.get_education()
    assert len(items) == 1
    assert items[0]["school"] == "MIT"

    await db.delete_education(entry_id)
    assert len(await db.get_education()) == 0


@pytest.mark.asyncio
async def test_certifications_crud(db):
    entry_id = await db.save_certification({
        "name": "AWS Solutions Architect",
        "issuing_org": "Amazon",
        "cert_type": "certification",
    })
    items = await db.get_certifications()
    assert len(items) == 1
    assert items[0]["name"] == "AWS Solutions Architect"

    await db.delete_certification(entry_id)
    assert len(await db.get_certifications()) == 0


@pytest.mark.asyncio
async def test_skills_crud(db):
    entry_id = await db.save_skill({"name": "Python", "years_experience": 5})
    items = await db.get_skills()
    assert len(items) == 1
    assert items[0]["name"] == "Python"

    await db.delete_skill(entry_id)
    assert len(await db.get_skills()) == 0


@pytest.mark.asyncio
async def test_languages_crud(db):
    entry_id = await db.save_language({"language": "Spanish", "proficiency": "fluent"})
    items = await db.get_languages()
    assert len(items) == 1
    assert items[0]["language"] == "Spanish"

    await db.delete_language(entry_id)
    assert len(await db.get_languages()) == 0


@pytest.mark.asyncio
async def test_references_crud(db):
    entry_id = await db.save_reference({
        "name": "John Smith",
        "title": "CTO",
        "company": "BigCo",
        "email": "john@bigco.com",
    })
    items = await db.get_references()
    assert len(items) == 1
    assert items[0]["name"] == "John Smith"

    await db.delete_reference(entry_id)
    assert len(await db.get_references()) == 0


@pytest.mark.asyncio
async def test_military_service_crud(db):
    await db.save_military_service({"branch": "Army", "rank": "Captain"})
    mil = await db.get_military_service()
    assert mil["branch"] == "Army"

    await db.save_military_service({"branch": "Navy"})
    mil = await db.get_military_service()
    assert mil["branch"] == "Navy"


@pytest.mark.asyncio
async def test_eeo_responses_crud(db):
    await db.save_eeo_responses({
        "gender": "male",
        "veteran_status": "no",
        "veteran_categories": ["none"],
    })
    eeo = await db.get_eeo_responses()
    assert eeo["gender"] == "male"
    assert eeo["veteran_categories"] == ["none"]


@pytest.mark.asyncio
async def test_custom_qa_crud(db):
    qa_id = await db.save_custom_qa({
        "question_pattern": "Are you authorized to work?",
        "category": "work_auth",
        "answer": "Yes",
    })
    items = await db.get_custom_qa()
    assert len(items) == 1
    assert items[0]["answer"] == "Yes"

    await db.save_custom_qa({"id": qa_id, "answer": "Yes, I am a US citizen"})
    item = await db.get_custom_qa_by_id(qa_id)
    assert item["answer"] == "Yes, I am a US citizen"

    await db.delete_custom_qa(qa_id)
    assert len(await db.get_custom_qa()) == 0


@pytest.mark.asyncio
async def test_autofill_history(db):
    hist_id = await db.save_autofill_history(
        job_url="https://example.com/apply",
        job_title="Engineer",
        company="Acme",
        fields_filled=["name", "email"],
        new_data_saved={"phone": "555-1234"},
    )
    items = await db.get_autofill_history()
    assert len(items) == 1
    assert items[0]["company"] == "Acme"
    assert items[0]["fields_filled"] == ["name", "email"]
    assert items[0]["new_data_saved"] == {"phone": "555-1234"}


@pytest.mark.asyncio
async def test_full_profile_roundtrip(db):
    await db.save_full_profile({
        "full_name": "Jane Doe",
        "email": "jane@example.com",
        "middle_name": "Marie",
        "work_history": [
            {"company": "Acme", "job_title": "Dev", "start_year": 2020},
            {"company": "BigCo", "job_title": "Senior Dev", "start_year": 2022},
        ],
        "education": [
            {"school": "MIT", "degree_type": "BS", "field_of_study": "CS"},
        ],
        "skills": [
            {"name": "Python", "years_experience": 5},
        ],
        "military": {"branch": "Army", "rank": "Captain"},
        "eeo": {"gender": "female"},
    })

    profile = await db.get_full_profile()
    assert profile["full_name"] == "Jane Doe"
    assert profile["middle_name"] == "Marie"
    assert len(profile["work_history"]) == 2
    assert len(profile["education"]) == 1
    assert len(profile["skills"]) == 1
    assert profile["military"]["branch"] == "Army"
    assert profile["eeo"]["gender"] == "female"


@pytest.mark.asyncio
async def test_profile_migration_preserves_existing(db):
    """Saving with old-style fields shouldn't blank new columns."""
    await db.save_user_profile(full_name="John", middle_name="Q")
    # Save with only old fields
    await db.save_user_profile(full_name="John Updated")
    profile = await db.get_user_profile()
    assert profile["full_name"] == "John Updated"
    assert profile["middle_name"] == "Q"


# API-level tests

@pytest.mark.asyncio
async def test_get_full_profile_empty(client):
    resp = await client.get("/api/profile/full")
    assert resp.status_code == 200
    data = resp.json()
    assert data["work_history"] == []
    assert data["education"] == []


@pytest.mark.asyncio
async def test_put_full_profile(client):
    resp = await client.put("/api/profile/full", json={
        "full_name": "Test User",
        "work_history": [
            {"company": "TestCo", "job_title": "Dev"},
        ],
        "skills": [
            {"name": "Python"},
        ],
    })
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    resp = await client.get("/api/profile/full")
    data = resp.json()
    assert data["full_name"] == "Test User"
    assert len(data["work_history"]) == 1
    assert data["work_history"][0]["company"] == "TestCo"
    assert len(data["skills"]) == 1


@pytest.mark.asyncio
async def test_learn_from_autofill(client):
    resp = await client.post("/api/profile/learn", json={
        "job_url": "https://example.com/apply",
        "job_title": "Engineer",
        "company": "Acme",
        "new_data": {"phone": "555-9999"},
    })
    assert resp.status_code == 200

    resp = await client.get("/api/profile")
    assert resp.json()["phone"] == "555-9999"

    resp = await client.get("/api/autofill/history")
    items = resp.json()["items"]
    assert len(items) == 1
    assert items[0]["company"] == "Acme"


@pytest.mark.asyncio
async def test_custom_qa_api(client):
    # Create
    resp = await client.post("/api/custom-qa", json={
        "question_pattern": "Willing to relocate?",
        "answer": "Yes",
    })
    assert resp.status_code == 200
    qa_id = resp.json()["id"]

    # List
    resp = await client.get("/api/custom-qa")
    assert len(resp.json()["items"]) == 1

    # Delete
    resp = await client.delete(f"/api/custom-qa/{qa_id}")
    assert resp.status_code == 200

    resp = await client.get("/api/custom-qa")
    assert len(resp.json()["items"]) == 0


@pytest.mark.asyncio
async def test_autofill_analyze_stub(client):
    resp = await client.post("/api/autofill/analyze", json={"form_html": "<form></form>", "fields": []})
    assert resp.status_code == 200
    assert resp.json()["mappings"] == []


@pytest.mark.asyncio
async def test_autofill_history_empty(client):
    resp = await client.get("/api/autofill/history")
    assert resp.status_code == 200
    assert resp.json()["items"] == []
