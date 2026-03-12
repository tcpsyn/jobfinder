import json
import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.builtin import BuiltInScraper

MOCK_LISTING_HTML = """
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "CollectionPage",
      "name": "Best Remote Software Engineer Jobs 2026 | Built In",
      "url": "https://builtin.com/jobs/remote/dev-engineering"
    },
    {
      "@type": "ItemList",
      "name": "Top Remote Software Engineer Jobs",
      "numberOfItems": 2,
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Senior DevOps Engineer",
          "url": "https://builtin.com/job/senior-devops-engineer/1001",
          "description": "Manage cloud infrastructure and CI/CD pipelines for a fast-growing fintech company."
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Backend Software Engineer",
          "url": "https://builtin.com/job/backend-software-engineer/1002",
          "description": "Design and build scalable microservices using Python and Go."
        }
      ]
    }
  ]
}
</script>
</head>
<body></body>
</html>
"""

MOCK_DETAIL_HTML_1 = """
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "Senior DevOps Engineer",
  "description": "Manage cloud infrastructure and CI/CD pipelines for a fast-growing fintech company. Requirements: 5+ years experience with AWS, Kubernetes, Terraform.",
  "datePosted": "2026-03-10",
  "validThrough": "2026-04-10T00:00:00+00:00",
  "employmentType": "FULL_TIME",
  "jobLocationType": "TELECOMMUTE",
  "baseSalary": {
    "@type": "MonetaryAmount",
    "currency": "USD",
    "value": {
      "@type": "QuantitativeValue",
      "minValue": 150000,
      "maxValue": 200000,
      "unitText": "YEAR"
    }
  },
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "San Francisco",
      "addressRegion": "California",
      "addressCountry": "USA"
    }
  },
  "hiringOrganization": {
    "@type": "Organization",
    "name": "CloudTech Inc",
    "sameAs": "https://builtin.com/company/cloudtech-inc"
  },
  "industry": ["Fintech", "Cloud Computing"]
}
</script>
</head>
<body></body>
</html>
"""

MOCK_DETAIL_HTML_2 = """
<html>
<head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "Backend Software Engineer",
  "description": "Design and build scalable microservices using Python and Go.",
  "datePosted": "2026-03-09",
  "employmentType": "FULL_TIME",
  "jobLocationType": "TELECOMMUTE",
  "baseSalary": {
    "@type": "MonetaryAmount",
    "currency": "USD",
    "value": {
      "@type": "QuantitativeValue",
      "minValue": 120000,
      "maxValue": 160000,
      "unitText": "YEAR"
    }
  },
  "jobLocation": {
    "@type": "Place",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "Austin",
      "addressRegion": "Texas",
      "addressCountry": "USA"
    }
  },
  "hiringOrganization": {
    "@type": "Organization",
    "name": "DataFlow Corp"
  },
  "industry": ["Software"]
}
</script>
</head>
<body></body>
</html>
"""


@pytest.mark.asyncio
async def test_builtin_parse(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/jobs/remote/dev-engineering"),
        text=MOCK_LISTING_HTML,
    )
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/job/senior-devops-engineer/1001"),
        text=MOCK_DETAIL_HTML_1,
    )
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/job/backend-software-engineer/1002"),
        text=MOCK_DETAIL_HTML_2,
    )

    scraper = BuiltInScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 2
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].source == "builtin"

    devops = next(j for j in jobs if "DevOps" in j.title)
    assert devops.company == "CloudTech Inc"
    assert devops.salary_min == 150000
    assert devops.salary_max == 200000
    assert devops.posted_date == "2026-03-10"
    assert "Remote" in devops.location
    assert "San Francisco" in devops.location
    assert "Fintech" in devops.tags
    assert "builtin.com/job/" in devops.url

    backend = next(j for j in jobs if "Backend" in j.title)
    assert backend.company == "DataFlow Corp"
    assert backend.salary_min == 120000
    assert backend.salary_max == 160000


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_builtin_detail_fetch_failure_falls_back(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/jobs/remote/dev-engineering"),
        text=MOCK_LISTING_HTML,
    )
    # Detail pages return errors
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/job/.*"),
        status_code=500,
    )

    scraper = BuiltInScraper()
    jobs = await scraper.scrape()
    # Should still get jobs via stub fallback
    assert len(jobs) == 2
    assert jobs[0].title == "Senior DevOps Engineer"
    assert jobs[0].company == ""  # No company from stub
    assert jobs[0].url == "https://builtin.com/job/senior-devops-engineer/1001"


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_builtin_detail_missing_jsonld_falls_back(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/jobs/remote/dev-engineering"),
        text=MOCK_LISTING_HTML,
    )
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/job/.*"),
        text="<html><body>No structured data here</body></html>",
    )

    scraper = BuiltInScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 2
    assert jobs[0].company == ""


@pytest.mark.asyncio
async def test_builtin_handles_empty_listing(httpx_mock):
    empty_html = """
    <html><head>
    <script type="application/ld+json">
    {"@context": "https://schema.org", "@graph": [{"@type": "CollectionPage"}]}
    </script>
    </head><body></body></html>
    """
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/jobs/.*"),
        text=empty_html,
    )
    scraper = BuiltInScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_builtin_handles_listing_error(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/jobs/.*"),
        status_code=403,
    )
    scraper = BuiltInScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_builtin_search_terms_filter(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/jobs/remote/dev-engineering"),
        text=MOCK_LISTING_HTML,
    )
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/job/senior-devops-engineer/1001"),
        text=MOCK_DETAIL_HTML_1,
    )
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/job/backend-software-engineer/1002"),
        text=MOCK_DETAIL_HTML_2,
    )

    scraper = BuiltInScraper(search_terms=["devops"])
    jobs = await scraper.scrape()
    # Only the DevOps job should match the search term
    assert len(jobs) == 1
    assert "DevOps" in jobs[0].title


@pytest.mark.asyncio
async def test_builtin_custom_search_uses_search_url(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/jobs\?search=.*"),
        text="<html><body></body></html>",
    )
    scraper = BuiltInScraper(search_terms=["kubernetes"])
    jobs = await scraper.scrape()
    assert jobs == []
    req_urls = [str(r.url) for r in httpx_mock.get_requests()]
    assert any("search=kubernetes" in u for u in req_urls)


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_builtin_deduplicates(httpx_mock):
    # Listing with duplicate URLs
    dup_html = """
    <html><head>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "ItemList",
          "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Job A", "url": "https://builtin.com/job/a/1", "description": "desc a"},
            {"@type": "ListItem", "position": 2, "name": "Job A Dupe", "url": "https://builtin.com/job/a/1", "description": "desc a"}
          ]
        }
      ]
    }
    </script>
    </head><body></body></html>
    """
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/jobs/remote/dev-engineering"),
        text=dup_html,
    )
    httpx_mock.add_response(
        url=re.compile(r"https://builtin\.com/job/.*"),
        text="<html><body></body></html>",
    )

    scraper = BuiltInScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 1


@pytest.mark.asyncio
async def test_builtin_salary_parsing():
    from app.scrapers.builtin import _parse_int

    assert _parse_int(150000) == 150000
    assert _parse_int("120000") == 120000
    assert _parse_int(None) is None
    assert _parse_int("not a number") is None
