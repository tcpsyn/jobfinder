import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.remoteok import RemoteOKScraper

MOCK_RESPONSE = [
    {"legal": "disclaimer"},
    {
        "position": "DevOps Engineer",
        "company": "CloudCo",
        "location": "Worldwide",
        "description": "Manage cloud infrastructure and CI/CD pipelines.",
        "apply_url": "https://cloudco.com/apply",
        "url": "https://remoteok.com/jobs/1",
        "salary_min": 120000,
        "salary_max": 160000,
        "date": "2026-03-01T00:00:00+00:00",
        "tags": ["devops", "aws", "kubernetes"],
    },
    {
        "position": "Frontend Developer",
        "company": "WebCo",
        "location": "",
        "description": "Build React applications.",
        "url": "https://remoteok.com/jobs/2",
        "date": "2026-02-28T00:00:00+00:00",
        "tags": ["react", "javascript"],
    },
]


@pytest.mark.asyncio
async def test_remoteok_parse(httpx_mock):
    httpx_mock.add_response(url=re.compile(r"https://remoteok\.com/api"), json=MOCK_RESPONSE)
    scraper = RemoteOKScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 2
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].title == "DevOps Engineer"
    assert jobs[0].company == "CloudCo"
    assert jobs[0].source == "remoteok"
    assert jobs[0].salary_min == 120000
    assert jobs[0].url == "https://cloudco.com/apply"
    # Empty location defaults to Remote
    assert jobs[1].location == "Remote"


@pytest.mark.asyncio
async def test_remoteok_search_terms_filter(httpx_mock):
    httpx_mock.add_response(url=re.compile(r"https://remoteok\.com/api"), json=MOCK_RESPONSE)
    scraper = RemoteOKScraper(search_terms=["devops"])
    jobs = await scraper.scrape()
    assert len(jobs) == 1
    assert jobs[0].title == "DevOps Engineer"


@pytest.mark.asyncio
async def test_remoteok_handles_empty(httpx_mock):
    httpx_mock.add_response(url=re.compile(r"https://remoteok\.com/api"), json=[{"legal": "notice"}])
    scraper = RemoteOKScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_remoteok_handles_error(httpx_mock):
    # 3 responses for retry attempts (max_retries=3)
    for _ in range(3):
        httpx_mock.add_response(url=re.compile(r"https://remoteok\.com/api"), status_code=500)
    scraper = RemoteOKScraper()
    scraper.initial_delay = 0.01
    jobs = await scraper.scrape()
    assert jobs == []
