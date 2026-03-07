import pytest
from unittest.mock import AsyncMock, MagicMock

from app.database import Database
from app.scrapers.base import JobListing
from app.scheduler import run_scrape_cycle


@pytest.fixture
async def db(tmp_path):
    database = Database(str(tmp_path / "test.db"))
    await database.init()
    yield database
    await database.close()


def make_mock_scraper(source_name, jobs):
    scraper = MagicMock()
    scraper.source_name = source_name
    scraper.scrape = AsyncMock(return_value=jobs)
    return scraper


@pytest.mark.asyncio
async def test_scrape_cycle_stores_jobs(db):
    scraper = make_mock_scraper("test", [
        JobListing(
            title="Test Job", company="TestCo", location="Remote",
            description="A test job", url="https://example.com/test",
            source="test", salary_min=160000, salary_max=200000,
        )
    ])
    new_count = await run_scrape_cycle(db, scrapers=[scraper])
    assert new_count == 1
    jobs = await db.list_jobs()
    assert len(jobs) == 1
    assert jobs[0]["title"] == "Test Job"
    sources = await db.get_sources(jobs[0]["id"])
    assert sources[0]["source_name"] == "test"


@pytest.mark.asyncio
async def test_scrape_cycle_deduplicates(db):
    job = JobListing(
        title="Test Job", company="TestCo", location="Remote",
        description="A test job", url="https://example.com/test",
        source="test",
    )
    scraper = make_mock_scraper("test", [job])
    await run_scrape_cycle(db, scrapers=[scraper])
    await run_scrape_cycle(db, scrapers=[scraper])
    jobs = await db.list_jobs()
    assert len(jobs) == 1


@pytest.mark.asyncio
async def test_scrape_cycle_multiple_sources(db):
    job1 = JobListing(
        title="Same Job", company="SameCo", location="Remote",
        description="desc", url="https://example.com/same",
        source="source1",
    )
    job2 = JobListing(
        title="Same Job", company="SameCo", location="Remote",
        description="desc", url="https://example.com/same",
        source="source2",
    )
    s1 = make_mock_scraper("source1", [job1])
    s2 = make_mock_scraper("source2", [job2])
    await run_scrape_cycle(db, scrapers=[s1, s2])
    jobs = await db.list_jobs()
    assert len(jobs) == 1
    sources = await db.get_sources(jobs[0]["id"])
    assert len(sources) == 2


@pytest.mark.asyncio
async def test_scrape_cycle_handles_scraper_error(db):
    bad_scraper = MagicMock()
    bad_scraper.source_name = "bad"
    bad_scraper.scrape = AsyncMock(side_effect=Exception("boom"))

    good_scraper = make_mock_scraper("good", [
        JobListing(
            title="Good Job", company="GoodCo", location="Remote",
            description="good", url="https://example.com/good",
            source="good",
        )
    ])
    new_count = await run_scrape_cycle(db, scrapers=[bad_scraper, good_scraper])
    assert new_count == 1
    jobs = await db.list_jobs()
    assert len(jobs) == 1
