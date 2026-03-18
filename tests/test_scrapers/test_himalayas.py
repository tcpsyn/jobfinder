import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.himalayas import HimalayasScraper

MOCK_RESPONSE = {
    "jobs": [
        {
            "title": "Platform Engineer",
            "companyName": "InfraCo",
            "description": "Build and maintain cloud platform.",
            "applicationLink": "https://infraco.com/apply",
            "minSalary": 130000,
            "maxSalary": 170000,
            "categories": ["devops", "infrastructure"],
            "pubDate": "2026-03-01",
            "locationRestrictions": ["US", "Canada"],
        },
        {
            "title": "Data Scientist",
            "companyName": "DataCo",
            "description": "Analyze large datasets.",
            "applicationLink": "https://dataco.com/apply",
            "categories": ["data", "machine-learning"],
            "pubDate": "2026-02-28",
            "locationRestrictions": [],
        },
    ]
}


@pytest.mark.asyncio
async def test_himalayas_parse(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://himalayas\.app/jobs/api\?.*"), json=MOCK_RESPONSE
    )
    httpx_mock.add_response(
        url=re.compile(r"https://himalayas\.app/jobs/api\?.*"), json={"jobs": []}
    )
    scraper = HimalayasScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 2
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].title == "Platform Engineer"
    assert jobs[0].company == "InfraCo"
    assert jobs[0].source == "himalayas"
    assert jobs[0].salary_min == 130000
    assert jobs[0].location == "US, Canada"
    # Empty locationRestrictions defaults to Remote
    assert jobs[1].location == "Remote"


@pytest.mark.asyncio
async def test_himalayas_search_terms_filter(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://himalayas\.app/jobs/api\?.*"), json=MOCK_RESPONSE
    )
    httpx_mock.add_response(
        url=re.compile(r"https://himalayas\.app/jobs/api\?.*"), json={"jobs": []}
    )
    scraper = HimalayasScraper(search_terms=["devops"])
    jobs = await scraper.scrape()
    assert len(jobs) == 1
    assert jobs[0].title == "Platform Engineer"


@pytest.mark.asyncio
async def test_himalayas_multi_word_search_matches(httpx_mock):
    """Multi-word terms match when at least 2 words appear in the job text."""
    httpx_mock.add_response(
        url=re.compile(r"https://himalayas\.app/jobs/api\?.*"), json=MOCK_RESPONSE
    )
    httpx_mock.add_response(
        url=re.compile(r"https://himalayas\.app/jobs/api\?.*"), json={"jobs": []}
    )
    # "devops engineer" — "devops" in categories, "engineer" in title → 2 matches → hit
    scraper = HimalayasScraper(search_terms=["senior devops engineer remote"])
    jobs = await scraper.scrape()
    assert len(jobs) == 1
    assert jobs[0].title == "Platform Engineer"


@pytest.mark.asyncio
async def test_himalayas_multi_word_search_no_match(httpx_mock):
    """Multi-word terms fail when fewer than 2 words appear."""
    httpx_mock.add_response(
        url=re.compile(r"https://himalayas\.app/jobs/api\?.*"), json=MOCK_RESPONSE
    )
    httpx_mock.add_response(
        url=re.compile(r"https://himalayas\.app/jobs/api\?.*"), json={"jobs": []}
    )
    # Only "scientist" matches Data Scientist, but "quantum" and "biology" don't → 1 match < 2
    scraper = HimalayasScraper(search_terms=["quantum biology scientist"])
    jobs = await scraper.scrape()
    assert len(jobs) == 0


@pytest.mark.asyncio
async def test_himalayas_handles_empty(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://himalayas\.app/jobs/api\?.*"), json={"jobs": []}
    )
    scraper = HimalayasScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_himalayas_handles_error(httpx_mock):
    # 3 responses for retry attempts (max_retries=3)
    for _ in range(3):
        httpx_mock.add_response(
            url=re.compile(r"https://himalayas\.app/jobs/api\?.*"), status_code=500
        )
    scraper = HimalayasScraper()
    scraper.initial_delay = 0.01
    jobs = await scraper.scrape()
    assert jobs == []
