import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.remotive import RemotiveScraper

MOCK_RESPONSE = {
    "jobs": [
        {
            "id": 1,
            "title": "DevOps Engineer",
            "company_name": "CloudCo",
            "candidate_required_location": "Worldwide",
            "description": "Manage cloud infrastructure.",
            "url": "https://remotive.com/remote-jobs/devops/devops-engineer-1",
            "salary_min": 120000,
            "salary_max": 160000,
            "publication_date": "2026-03-01",
            "tags": ["devops", "aws"],
        },
        {
            "id": 2,
            "title": "Platform Engineer",
            "company_name": "InfraCo",
            "candidate_required_location": "US Only",
            "description": "Build internal platform.",
            "url": "https://remotive.com/remote-jobs/devops/platform-engineer-2",
            "publication_date": "2026-02-28",
            "tags": ["kubernetes"],
        },
    ]
}


@pytest.mark.asyncio
async def test_remotive_parse(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://remotive\.com/api/remote-jobs\?.*"), json=MOCK_RESPONSE
    )
    httpx_mock.add_response(
        url=re.compile(r"https://remotive\.com/api/remote-jobs\?.*"), json=MOCK_RESPONSE
    )
    scraper = RemotiveScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 4  # 2 per category x 2 categories
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].title == "DevOps Engineer"
    assert jobs[0].company == "CloudCo"
    assert jobs[0].source == "remotive"
    assert jobs[0].salary_min == 120000


@pytest.mark.asyncio
async def test_remotive_handles_empty(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://remotive\.com/api/remote-jobs\?.*"), json={"jobs": []}
    )
    httpx_mock.add_response(
        url=re.compile(r"https://remotive\.com/api/remote-jobs\?.*"), json={"jobs": []}
    )
    scraper = RemotiveScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_remotive_handles_error(httpx_mock):
    # 2 categories × 3 retry attempts = 6 responses needed
    for _ in range(6):
        httpx_mock.add_response(
            url=re.compile(r"https://remotive\.com/api/remote-jobs\?.*"), status_code=500
        )
    scraper = RemotiveScraper()
    scraper.initial_delay = 0.01
    jobs = await scraper.scrape()
    assert jobs == []
