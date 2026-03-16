import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.greenhouse import GreenhouseScraper, DEFAULT_COMPANIES

API_PATTERN = re.compile(r"https://boards-api\.greenhouse\.io/v1/boards/.+/jobs.*")

MOCK_JOBS_RESPONSE = {
    "jobs": [
        {
            "id": 101,
            "title": "Senior Site Reliability Engineer",
            "content": "<p>Build and scale infrastructure for cloud services.</p>",
            "absolute_url": "https://boards.greenhouse.io/testco/jobs/101",
            "updated_at": "2026-03-10T12:00:00Z",
            "location": {"name": "San Francisco, CA"},
            "departments": [{"id": 1, "name": "Engineering"}],
            "metadata": [],
        },
        {
            "id": 102,
            "title": "Product Designer",
            "content": "<p>Design beautiful user interfaces.</p>",
            "absolute_url": "https://boards.greenhouse.io/testco/jobs/102",
            "updated_at": "2026-03-09T10:00:00Z",
            "location": {"name": "Remote"},
            "departments": [{"id": 2, "name": "Design"}],
            "metadata": [],
        },
    ]
}

EMPTY_RESPONSE = {"jobs": []}


def _mock_single_company(httpx_mock, company="testco", response=None, status_code=200):
    """Mock a single company's API response."""
    url_pattern = re.compile(
        rf"https://boards-api\.greenhouse\.io/v1/boards/{re.escape(company)}/jobs.*"
    )
    httpx_mock.add_response(url=url_pattern, json=response or EMPTY_RESPONSE, status_code=status_code)


def _mock_all_defaults_empty(httpx_mock):
    """Mock all default companies returning empty results."""
    httpx_mock.add_response(url=API_PATTERN, json=EMPTY_RESPONSE)


@pytest.mark.asyncio
async def test_greenhouse_parse(httpx_mock):
    _mock_single_company(httpx_mock, "testco", MOCK_JOBS_RESPONSE)
    scraper = GreenhouseScraper(scraper_keys={"greenhouse_companies": "testco"})
    jobs = await scraper.scrape()

    assert len(jobs) == 2
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].title == "Senior Site Reliability Engineer"
    assert jobs[0].location == "San Francisco, CA"
    assert jobs[0].source == "greenhouse"
    assert jobs[0].url == "https://boards.greenhouse.io/testco/jobs/101"
    assert jobs[0].posted_date == "2026-03-10"
    assert "Engineering" in jobs[0].tags

    assert jobs[1].title == "Product Designer"
    assert jobs[1].location == "Remote"


@pytest.mark.asyncio
async def test_greenhouse_search_filter(httpx_mock):
    _mock_single_company(httpx_mock, "testco", MOCK_JOBS_RESPONSE)
    scraper = GreenhouseScraper(
        search_terms=["reliability engineer"],
        scraper_keys={"greenhouse_companies": "testco"},
    )
    jobs = await scraper.scrape()

    assert len(jobs) == 1
    assert jobs[0].title == "Senior Site Reliability Engineer"


@pytest.mark.asyncio
async def test_greenhouse_multi_word_search_matches(httpx_mock):
    _mock_single_company(httpx_mock, "testco", MOCK_JOBS_RESPONSE)
    scraper = GreenhouseScraper(
        search_terms=["senior infrastructure engineer cloud"],
        scraper_keys={"greenhouse_companies": "testco"},
    )
    jobs = await scraper.scrape()

    # "infrastructure" in content, "cloud" in content → 2 matches
    assert len(jobs) == 1
    assert jobs[0].title == "Senior Site Reliability Engineer"


@pytest.mark.asyncio
async def test_greenhouse_multi_word_search_no_match(httpx_mock):
    _mock_single_company(httpx_mock, "testco", MOCK_JOBS_RESPONSE)
    scraper = GreenhouseScraper(
        search_terms=["quantum biology researcher"],
        scraper_keys={"greenhouse_companies": "testco"},
    )
    jobs = await scraper.scrape()
    assert len(jobs) == 0


@pytest.mark.asyncio
async def test_greenhouse_404_handled(httpx_mock):
    _mock_single_company(httpx_mock, "nonexistent", status_code=404)
    scraper = GreenhouseScraper(scraper_keys={"greenhouse_companies": "nonexistent"})
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_greenhouse_multiple_companies(httpx_mock):
    company_a_response = {
        "jobs": [
            {
                "id": 201,
                "title": "DevOps Engineer",
                "content": "Manage CI/CD pipelines.",
                "absolute_url": "https://boards.greenhouse.io/companya/jobs/201",
                "updated_at": "2026-03-08T09:00:00Z",
                "location": {"name": "New York, NY"},
                "departments": [],
                "metadata": [],
            }
        ]
    }
    _mock_single_company(httpx_mock, "companya", company_a_response)
    _mock_single_company(httpx_mock, "companyb", MOCK_JOBS_RESPONSE)

    scraper = GreenhouseScraper(scraper_keys={"greenhouse_companies": "companya,companyb"})
    jobs = await scraper.scrape()

    assert len(jobs) == 3
    companies = {j.company for j in jobs}
    assert "companya" in companies or "companyb" in companies


@pytest.mark.asyncio
async def test_greenhouse_deduplicates_by_url(httpx_mock):
    dup_response = {
        "jobs": [
            {
                "id": 101,
                "title": "Senior Site Reliability Engineer",
                "content": "Build infra.",
                "absolute_url": "https://boards.greenhouse.io/testco/jobs/101",
                "updated_at": "2026-03-10T12:00:00Z",
                "location": {"name": "Remote"},
                "departments": [],
                "metadata": [],
            },
            {
                "id": 101,
                "title": "Senior Site Reliability Engineer",
                "content": "Build infra.",
                "absolute_url": "https://boards.greenhouse.io/testco/jobs/101",
                "updated_at": "2026-03-10T12:00:00Z",
                "location": {"name": "Remote"},
                "departments": [],
                "metadata": [],
            },
        ]
    }
    _mock_single_company(httpx_mock, "testco", dup_response)
    scraper = GreenhouseScraper(scraper_keys={"greenhouse_companies": "testco"})
    jobs = await scraper.scrape()
    assert len(jobs) == 1


@pytest.mark.asyncio
async def test_greenhouse_empty_response(httpx_mock):
    _mock_single_company(httpx_mock, "testco")
    scraper = GreenhouseScraper(scraper_keys={"greenhouse_companies": "testco"})
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_greenhouse_server_error(httpx_mock):
    _mock_single_company(httpx_mock, "testco", status_code=500)
    scraper = GreenhouseScraper(scraper_keys={"greenhouse_companies": "testco"})
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_greenhouse_fallback_url_from_id(httpx_mock):
    """Jobs without absolute_url should get a constructed URL from id."""
    response = {
        "jobs": [
            {
                "id": 999,
                "title": "Backend Engineer",
                "content": "Write APIs.",
                "updated_at": "2026-03-10T12:00:00Z",
                "location": {"name": "Remote"},
                "departments": [],
                "metadata": [],
            }
        ]
    }
    _mock_single_company(httpx_mock, "testco", response)
    scraper = GreenhouseScraper(scraper_keys={"greenhouse_companies": "testco"})
    jobs = await scraper.scrape()
    assert len(jobs) == 1
    assert jobs[0].url == "https://boards.greenhouse.io/testco/jobs/999"


@pytest.mark.asyncio
async def test_greenhouse_default_companies_list():
    assert len(DEFAULT_COMPANIES) >= 30
    assert "cloudflare" in DEFAULT_COMPANIES
    assert "datadog" in DEFAULT_COMPANIES
    assert "gitlab" in DEFAULT_COMPANIES


@pytest.mark.asyncio
async def test_greenhouse_custom_companies_from_keys(httpx_mock):
    _mock_single_company(httpx_mock, "mycompany", MOCK_JOBS_RESPONSE)
    scraper = GreenhouseScraper(scraper_keys={"greenhouse_companies": "mycompany"})
    jobs = await scraper.scrape()
    assert len(jobs) == 2


@pytest.mark.asyncio
async def test_greenhouse_missing_location(httpx_mock):
    response = {
        "jobs": [
            {
                "id": 300,
                "title": "SRE",
                "content": "Reliability work.",
                "absolute_url": "https://boards.greenhouse.io/testco/jobs/300",
                "updated_at": "2026-03-10T12:00:00Z",
                "departments": [],
                "metadata": [],
            }
        ]
    }
    _mock_single_company(httpx_mock, "testco", response)
    scraper = GreenhouseScraper(scraper_keys={"greenhouse_companies": "testco"})
    jobs = await scraper.scrape()
    assert len(jobs) == 1
    assert jobs[0].location == "Remote"
