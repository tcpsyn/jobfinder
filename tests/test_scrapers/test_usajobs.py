import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.usajobs import USAJobsScraper

MOCK_RESPONSE = {
    "SearchResult": {
        "SearchResultCount": 2,
        "SearchResultItems": [
            {
                "MatchedObjectDescriptor": {
                    "PositionTitle": "IT Specialist (SYSADMIN)",
                    "OrganizationName": "Department of Defense",
                    "PositionURI": "https://www.usajobs.gov/job/123456",
                    "PositionLocation": [
                        {"LocationName": "Anywhere in the U.S. (remote job)"}
                    ],
                    "PositionRemuneration": [
                        {"MinimumRange": "100000", "MaximumRange": "140000", "RateIntervalCode": "PA"}
                    ],
                    "PublicationStartDate": "2026-03-01",
                    "UserArea": {
                        "Details": {
                            "MajorDuties": ["Manage IT infrastructure and cloud services."]
                        }
                    },
                }
            },
            {
                "MatchedObjectDescriptor": {
                    "PositionTitle": "Supervisory IT Specialist",
                    "OrganizationName": "Department of Veterans Affairs",
                    "PositionURI": "https://www.usajobs.gov/job/789012",
                    "PositionLocation": [
                        {"LocationName": "Washington, DC"}
                    ],
                    "PositionRemuneration": [
                        {"MinimumRange": "120000", "MaximumRange": "160000", "RateIntervalCode": "PA"}
                    ],
                    "PublicationStartDate": "2026-02-28",
                    "UserArea": {
                        "Details": {
                            "MajorDuties": ["Lead a team of IT specialists."]
                        }
                    },
                }
            },
        ],
    }
}


@pytest.mark.asyncio
async def test_usajobs_parse(httpx_mock, monkeypatch):
    monkeypatch.setenv("USAJOBS_API_KEY", "test-key")
    monkeypatch.setenv("USAJOBS_EMAIL", "test@example.com")
    httpx_mock.add_response(
        url=re.compile(r"https://data\.usajobs\.gov/api/search\?.*"),
        json=MOCK_RESPONSE,
    )
    scraper = USAJobsScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 2
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].title == "IT Specialist (SYSADMIN)"
    assert jobs[0].company == "Department of Defense"
    assert jobs[0].salary_min == 100000
    assert jobs[0].source == "usajobs"


@pytest.mark.asyncio
async def test_usajobs_multi_term_dedup(httpx_mock, monkeypatch):
    """Each search term gets its own API call; duplicate URLs are deduplicated."""
    monkeypatch.setenv("USAJOBS_API_KEY", "test-key")
    monkeypatch.setenv("USAJOBS_EMAIL", "test@example.com")

    response_a = {
        "SearchResult": {
            "SearchResultItems": [
                {
                    "MatchedObjectDescriptor": {
                        "PositionTitle": "DevOps Engineer",
                        "OrganizationName": "NASA",
                        "PositionURI": "https://www.usajobs.gov/job/aaa",
                        "PositionLocation": [],
                        "PositionRemuneration": [],
                        "PublicationStartDate": "2026-03-01",
                    }
                },
            ],
        }
    }
    response_b = {
        "SearchResult": {
            "SearchResultItems": [
                {
                    "MatchedObjectDescriptor": {
                        "PositionTitle": "DevOps Engineer",
                        "OrganizationName": "NASA",
                        "PositionURI": "https://www.usajobs.gov/job/aaa",
                        "PositionLocation": [],
                        "PositionRemuneration": [],
                        "PublicationStartDate": "2026-03-01",
                    }
                },
                {
                    "MatchedObjectDescriptor": {
                        "PositionTitle": "SRE Lead",
                        "OrganizationName": "DOE",
                        "PositionURI": "https://www.usajobs.gov/job/bbb",
                        "PositionLocation": [],
                        "PositionRemuneration": [],
                        "PublicationStartDate": "2026-03-02",
                    }
                },
            ],
        }
    }

    # Two search terms → two API calls, return different responses
    httpx_mock.add_response(
        url=re.compile(r"https://data\.usajobs\.gov/api/search\?.*"),
        json=response_a,
    )
    httpx_mock.add_response(
        url=re.compile(r"https://data\.usajobs\.gov/api/search\?.*"),
        json=response_b,
    )

    scraper = USAJobsScraper(search_terms=["devops engineer", "SRE"])
    jobs = await scraper.scrape()

    # 3 total items across both responses, but 1 duplicate URL → 2 unique jobs
    assert len(jobs) == 2
    urls = [j.url for j in jobs]
    assert "https://www.usajobs.gov/job/aaa" in urls
    assert "https://www.usajobs.gov/job/bbb" in urls


@pytest.mark.asyncio
async def test_usajobs_no_api_key(httpx_mock):
    scraper = USAJobsScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_usajobs_handles_error(httpx_mock, monkeypatch):
    monkeypatch.setenv("USAJOBS_API_KEY", "test-key")
    monkeypatch.setenv("USAJOBS_EMAIL", "test@example.com")
    # 3 responses for retry attempts (max_retries=3)
    for _ in range(3):
        httpx_mock.add_response(
            url=re.compile(r"https://data\.usajobs\.gov/api/search\?.*"),
            status_code=500,
        )
    scraper = USAJobsScraper()
    scraper.initial_delay = 0.01
    jobs = await scraper.scrape()
    assert jobs == []
