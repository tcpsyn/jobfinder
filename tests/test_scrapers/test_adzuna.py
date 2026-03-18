import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.adzuna import AdzunaScraper

KEYS = {"adzuna": {"app_id": "test-id", "app_key": "test-key"}}

MOCK_RESPONSE = {
    "results": [
        {
            "title": "Senior Backend Engineer",
            "description": "Build scalable APIs and services using Python and FastAPI.",
            "redirect_url": "https://adzuna.com/job/111",
            "company": {"display_name": "TechCorp"},
            "location": {"display_name": "New York, NY"},
            "category": {"label": "IT Jobs"},
            "salary_min": 120000,
            "salary_max": 180000,
            "created": "2026-03-10",
        },
        {
            "title": "Data Analyst",
            "description": "Analyze business data and create dashboards.",
            "redirect_url": "https://adzuna.com/job/222",
            "company": {"display_name": "DataInc"},
            "location": {"display_name": "Remote"},
            "category": {"label": "Data Science"},
            "salary_min": 90000,
            "salary_max": 130000,
            "created": "2026-03-09",
        },
    ]
}

URL_PATTERN = re.compile(r"https://api\.adzuna\.com/v1/api/jobs/us/search/\d+\?.*")


def _add_response(httpx_mock, response=None):
    """Add a single mock response. Results < PAGE_SIZE stops pagination automatically."""
    httpx_mock.add_response(url=URL_PATTERN, json=response or MOCK_RESPONSE)


@pytest.mark.asyncio
async def test_adzuna_parse(httpx_mock):
    _add_response(httpx_mock)
    scraper = AdzunaScraper(scraper_keys=KEYS)
    jobs = await scraper.scrape()
    assert len(jobs) == 2
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].title == "Senior Backend Engineer"
    assert jobs[0].company == "TechCorp"
    assert jobs[0].location == "New York, NY"
    assert jobs[0].source == "adzuna"
    assert jobs[0].salary_min == 120000
    assert jobs[0].salary_max == 180000
    assert jobs[0].posted_date == "2026-03-10"
    assert jobs[0].tags == ["IT Jobs"]


@pytest.mark.asyncio
async def test_adzuna_no_api_keys():
    scraper = AdzunaScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_adzuna_missing_app_id():
    scraper = AdzunaScraper(scraper_keys={"adzuna": {"app_key": "key-only"}})
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_adzuna_dedup(httpx_mock):
    """Duplicate URLs across search terms are deduplicated."""
    response_a = {
        "results": [
            {
                "title": "DevOps Engineer",
                "description": "Manage cloud infrastructure.",
                "redirect_url": "https://adzuna.com/job/aaa",
                "company": {"display_name": "CloudCo"},
                "location": {"display_name": "Remote"},
                "category": {"label": "DevOps"},
            },
        ]
    }
    response_b = {
        "results": [
            {
                "title": "DevOps Engineer",
                "description": "Manage cloud infrastructure.",
                "redirect_url": "https://adzuna.com/job/aaa",
                "company": {"display_name": "CloudCo"},
                "location": {"display_name": "Remote"},
                "category": {"label": "DevOps"},
            },
            {
                "title": "SRE Lead",
                "description": "Site reliability engineering leadership.",
                "redirect_url": "https://adzuna.com/job/bbb",
                "company": {"display_name": "ReliaCo"},
                "location": {"display_name": "San Francisco, CA"},
                "category": {"label": "IT Jobs"},
            },
        ]
    }

    # Term 1: returns response_a (< PAGE_SIZE, stops pagination)
    httpx_mock.add_response(url=URL_PATTERN, json=response_a)
    # Term 2: returns response_b (< PAGE_SIZE, stops pagination)
    httpx_mock.add_response(url=URL_PATTERN, json=response_b)

    scraper = AdzunaScraper(
        search_terms=["devops engineer", "SRE"],
        scraper_keys=KEYS,
    )
    jobs = await scraper.scrape()

    assert len(jobs) == 2
    urls = [j.url for j in jobs]
    assert "https://adzuna.com/job/aaa" in urls
    assert "https://adzuna.com/job/bbb" in urls


@pytest.mark.asyncio
async def test_adzuna_word_filter_match(httpx_mock):
    """Multi-word search terms match when at least 2 words appear."""
    _add_response(httpx_mock)
    scraper = AdzunaScraper(
        search_terms=["senior backend engineer"],
        scraper_keys=KEYS,
    )
    jobs = await scraper.scrape()
    assert len(jobs) == 1
    assert jobs[0].title == "Senior Backend Engineer"


@pytest.mark.asyncio
async def test_adzuna_word_filter_no_match(httpx_mock):
    """Multi-word search terms fail when fewer than 2 words appear."""
    _add_response(httpx_mock)
    scraper = AdzunaScraper(
        search_terms=["quantum physicist researcher"],
        scraper_keys=KEYS,
    )
    jobs = await scraper.scrape()
    assert len(jobs) == 0


@pytest.mark.asyncio
async def test_adzuna_single_word_filter(httpx_mock):
    """Single-word search term matches when the word appears."""
    _add_response(httpx_mock)
    scraper = AdzunaScraper(
        search_terms=["backend"],
        scraper_keys=KEYS,
    )
    jobs = await scraper.scrape()
    assert len(jobs) == 1
    assert jobs[0].title == "Senior Backend Engineer"


@pytest.mark.asyncio
async def test_adzuna_handles_error(httpx_mock):
    # 3 responses for retry attempts (max_retries=3)
    for _ in range(3):
        httpx_mock.add_response(url=URL_PATTERN, status_code=500)
    scraper = AdzunaScraper(scraper_keys=KEYS)
    scraper.initial_delay = 0.01
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_adzuna_no_salary(httpx_mock):
    """Jobs without salary fields parse correctly with None salary."""
    response = {
        "results": [
            {
                "title": "Frontend Developer",
                "description": "Build UIs with React.",
                "redirect_url": "https://adzuna.com/job/333",
                "company": {"display_name": "WebCo"},
                "location": {"display_name": "Austin, TX"},
                "category": {"label": "IT Jobs"},
            },
        ]
    }
    httpx_mock.add_response(url=URL_PATTERN, json=response)
    scraper = AdzunaScraper(scraper_keys=KEYS)
    jobs = await scraper.scrape()
    assert len(jobs) == 1
    assert jobs[0].salary_min is None
    assert jobs[0].salary_max is None
