import json
import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.wellfound import WellfoundScraper

# Wellfound uses Next.js with __NEXT_DATA__ for SSR pages
MOCK_NEXTDATA_HTML = """
<html>
<head>
<script id="__NEXT_DATA__" type="application/json">
{
  "props": {
    "pageProps": {
      "jobs": [
        {
          "id": "job-1001",
          "title": "Senior DevOps Engineer",
          "slug": "senior-devops-engineer-at-startupx",
          "description": "Manage cloud infrastructure with Kubernetes and Terraform.",
          "startup": {"name": "StartupX"},
          "location": "San Francisco, CA",
          "salaryMin": 140000,
          "salaryMax": 190000,
          "postedAt": "2026-03-10",
          "tags": [{"name": "devops"}, {"name": "kubernetes"}, {"name": "terraform"}]
        },
        {
          "id": "job-1002",
          "title": "Full Stack Engineer",
          "slug": "full-stack-engineer-at-growthy",
          "description": "Build React and Node.js applications for our SaaS platform.",
          "startup": {"name": "Growthy"},
          "location": "Remote",
          "salaryMin": 120000,
          "salaryMax": 160000,
          "postedAt": "2026-03-09",
          "tags": [{"name": "react"}, {"name": "node.js"}]
        }
      ]
    }
  }
}
</script>
</head>
<body></body>
</html>
"""

# Alternative: Apollo GraphQL state embedded in the page
MOCK_APOLLO_HTML = """
<html>
<head></head>
<body>
<script>
window.__APOLLO_STATE__ = {
  "JobListing:3001": {
    "__typename": "JobListing",
    "id": "3001",
    "title": "Platform Engineer",
    "slug": "platform-engineer-at-infraco",
    "description": "Build internal developer platform tools.",
    "startup": {"name": "InfraCo"},
    "location": "New York, NY",
    "salaryMin": 130000,
    "salaryMax": 170000,
    "postedAt": "2026-03-08",
    "tags": [{"name": "platform"}, {"name": "devops"}]
  },
  "JobListing:3002": {
    "__typename": "JobListing",
    "id": "3002",
    "title": "Backend Engineer",
    "slug": "backend-engineer-at-dataflow",
    "description": "Design microservices in Go and Python.",
    "startup": {"name": "DataFlow"},
    "location": "Remote",
    "salaryMin": 110000,
    "salaryMax": 150000,
    "postedAt": "2026-03-07",
    "tags": [{"name": "go"}, {"name": "python"}]
  },
  "ROOT_QUERY": {
    "__typename": "Query"
  }
};
</script>
</body>
</html>
"""

# JSON-LD structured data format
MOCK_JSONLD_HTML = """
<html>
<head>
<script type="application/ld+json">
{
  "@type": "JobPosting",
  "title": "SRE Engineer",
  "description": "Site reliability engineering for distributed systems.",
  "datePosted": "2026-03-06",
  "url": "https://wellfound.com/jobs/sre-engineer-at-reliaco",
  "hiringOrganization": {
    "@type": "Organization",
    "name": "ReliaCo"
  },
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "Austin"
    }
  },
  "baseSalary": {
    "@type": "MonetaryAmount",
    "value": {
      "minValue": 145000,
      "maxValue": 185000
    }
  }
}
</script>
</head>
<body></body>
</html>
"""


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_wellfound_parse_next_data(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://wellfound\.com/role/.*"),
        text=MOCK_NEXTDATA_HTML,
    )
    scraper = WellfoundScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 2
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].source == "wellfound"

    devops = next(j for j in jobs if "DevOps" in j.title)
    assert devops.company == "StartupX"
    assert devops.location == "San Francisco, CA"
    assert devops.salary_min == 140000
    assert devops.salary_max == 190000
    assert devops.posted_date == "2026-03-10"
    assert "devops" in devops.tags
    assert "wellfound.com/jobs/" in devops.url

    fullstack = next(j for j in jobs if "Full Stack" in j.title)
    assert fullstack.company == "Growthy"
    assert fullstack.location == "Remote"


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_wellfound_parse_apollo_state(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://wellfound\.com/role/.*"),
        text=MOCK_APOLLO_HTML,
    )
    scraper = WellfoundScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 2

    platform = next(j for j in jobs if "Platform" in j.title)
    assert platform.company == "InfraCo"
    assert platform.salary_min == 130000

    backend = next(j for j in jobs if "Backend" in j.title)
    assert backend.company == "DataFlow"
    assert backend.location == "Remote"


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_wellfound_parse_jsonld(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://wellfound\.com/role/.*"),
        text=MOCK_JSONLD_HTML,
    )
    scraper = WellfoundScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 1
    assert jobs[0].title == "SRE Engineer"
    assert jobs[0].company == "ReliaCo"
    assert jobs[0].location == "Austin"
    assert jobs[0].salary_min == 145000
    assert jobs[0].salary_max == 185000


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_wellfound_search_terms_filter(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://wellfound\.com/role/.*"),
        text=MOCK_NEXTDATA_HTML,
    )
    scraper = WellfoundScraper(search_terms=["devops"])
    jobs = await scraper.scrape()
    # Should filter to only jobs matching "devops"
    assert len(jobs) == 1
    assert "DevOps" in jobs[0].title


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_wellfound_custom_role_paths(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://wellfound\.com/role/.*"),
        text=MOCK_NEXTDATA_HTML,
    )
    scraper = WellfoundScraper(search_terms=["data engineer"])
    jobs = await scraper.scrape()
    req_urls = [str(r.url) for r in httpx_mock.get_requests()]
    assert any("data-engineer" in u for u in req_urls)


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_wellfound_handles_403(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://wellfound\.com/role/.*"),
        status_code=403,
    )
    scraper = WellfoundScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_wellfound_handles_empty_page(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://wellfound\.com/role/.*"),
        text="<html><body></body></html>",
    )
    scraper = WellfoundScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_wellfound_deduplicates(httpx_mock):
    # Two role paths returning same jobs (same URLs)
    httpx_mock.add_response(
        url=re.compile(r"https://wellfound\.com/role/.*"),
        text=MOCK_NEXTDATA_HTML,
    )
    scraper = WellfoundScraper(search_terms=["software engineer", "full stack"])
    jobs = await scraper.scrape()
    urls = [j.url for j in jobs]
    assert len(urls) == len(set(urls))


@pytest.mark.asyncio
async def test_wellfound_int_parsing():
    from app.scrapers.wellfound import _parse_int

    assert _parse_int(140000) == 140000
    assert _parse_int("120000") == 120000
    assert _parse_int(None) is None
    assert _parse_int("invalid") is None
