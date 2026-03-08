import pytest
from app.database import Database


@pytest.fixture
async def db(tmp_path):
    d = Database(str(tmp_path / "test.db"))
    await d.init()
    yield d
    await d.close()


@pytest.mark.asyncio
async def test_search_config_initially_none(db):
    config = await db.get_search_config()
    assert config is None


@pytest.mark.asyncio
async def test_save_and_get_search_config(db):
    await db.save_search_config(
        "my resume text", ["devops remote", "SRE remote"],
        job_titles=[{"title": "DevOps Engineer", "why": "strong fit"}],
        key_skills=["AWS", "Kubernetes"],
        seniority="senior",
        summary="Experienced engineer",
    )
    config = await db.get_search_config()
    assert config["resume_text"] == "my resume text"
    assert config["search_terms"] == ["devops remote", "SRE remote"]
    assert config["job_titles"] == [{"title": "DevOps Engineer", "why": "strong fit"}]
    assert config["key_skills"] == ["AWS", "Kubernetes"]
    assert config["seniority"] == "senior"
    assert config["summary"] == "Experienced engineer"
    assert config["updated_at"] is not None


@pytest.mark.asyncio
async def test_update_search_terms(db):
    await db.save_search_config("resume", ["old term"])
    await db.update_search_terms(["new term 1", "new term 2"])
    config = await db.get_search_config()
    assert config["search_terms"] == ["new term 1", "new term 2"]
    assert config["resume_text"] == "resume"


@pytest.mark.asyncio
async def test_save_search_config_upserts(db):
    await db.save_search_config("v1", ["term1"])
    await db.save_search_config("v2", ["term2", "term3"],
                                 job_titles=[{"title": "SRE"}],
                                 seniority="staff")
    config = await db.get_search_config()
    assert config["resume_text"] == "v2"
    assert config["search_terms"] == ["term2", "term3"]
    assert config["job_titles"] == [{"title": "SRE"}]
    assert config["seniority"] == "staff"
