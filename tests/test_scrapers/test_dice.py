import json
import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.dice import DiceScraper

MOCK_JOB_DATA = [
    {
        "id": "abc123",
        "guid": "cd50ba4d-54f1-481e-aeb8-be5db84ca48d",
        "detailsPageUrl": "https://www.dice.com/job-detail/cd50ba4d-54f1-481e-aeb8-be5db84ca48d",
        "companyName": "TechCorp",
        "employmentType": "Full-time",
        "employerType": "Direct Hire",
        "jobLocation": {
            "city": "Denver",
            "state": "Colorado",
            "country": "USA",
            "region": "CO",
            "displayName": "Denver, Colorado, USA",
        },
        "postedDate": "2026-03-11T18:52:56Z",
        "modifiedDate": "2026-03-11T18:52:56Z",
        "salary": "$120,000 - $150,000",
        "summary": "DevOps Engineer role with CI/CD and cloud experience.",
        "title": "Senior DevOps Engineer",
        "isRemote": True,
        "workplaceTypes": ["Remote"],
    },
    {
        "id": "def456",
        "guid": "aaaa-bbbb-cccc",
        "detailsPageUrl": "https://www.dice.com/job-detail/aaaa-bbbb-cccc",
        "companyName": "CloudInc",
        "employmentType": "Contract",
        "jobLocation": {
            "city": "Austin",
            "region": "TX",
        },
        "postedDate": "2026-03-10T10:00:00Z",
        "salary": "",
        "summary": "SRE position requiring Kubernetes.",
        "title": "Site Reliability Engineer",
        "isRemote": False,
        "workplaceTypes": ["On-Site"],
    },
]


def _build_dice_html(jobs):
    """Build a mock Dice HTML page with embedded Next.js job data."""
    jobs_json = json.dumps(jobs).replace('"', '\\"')
    return f"""<html><head></head><body>
<script>self.__next_f.push([1,"7:[\\"$\\",\\"$L3b\\",null,{{\\"jobList\\":{{\\"data\\":{jobs_json},\\"meta\\":{{}}}}}},null]"])</script>
</body></html>"""


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_dice_parse(httpx_mock):
    html = _build_dice_html(MOCK_JOB_DATA)
    httpx_mock.add_response(
        url=re.compile(r"https://www\.dice\.com/jobs\?.*"),
        text=html,
    )
    scraper = DiceScraper()
    jobs = await scraper.scrape()
    assert len(jobs) >= 2
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].source == "dice"

    # Check first job
    devops = next(j for j in jobs if "DevOps" in j.title)
    assert devops.company == "TechCorp"
    assert "Remote" in devops.location
    assert devops.salary_min == 120000
    assert devops.salary_max == 150000
    assert devops.posted_date == "2026-03-11T18:52:56Z"
    assert "dice.com/job-detail" in devops.url

    # Check second job (not remote)
    sre = next(j for j in jobs if "Reliability" in j.title)
    assert sre.company == "CloudInc"
    assert "Austin" in sre.location
    assert "Remote" not in sre.location


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_dice_deduplicates(httpx_mock):
    # Same job ID appears in multiple queries
    duped = MOCK_JOB_DATA + [MOCK_JOB_DATA[0]]
    html = _build_dice_html(duped)
    httpx_mock.add_response(
        url=re.compile(r"https://www\.dice\.com/jobs\?.*"),
        text=html,
    )
    scraper = DiceScraper()
    jobs = await scraper.scrape()
    ids = [j.url for j in jobs]
    assert len(ids) == len(set(ids))


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_dice_handles_empty(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://www\.dice\.com/jobs\?.*"),
        text="<html><body></body></html>",
    )
    scraper = DiceScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_dice_handles_error(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://www\.dice\.com/jobs\?.*"),
        status_code=429,
    )
    scraper = DiceScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_dice_salary_parsing():
    scraper = DiceScraper()
    assert scraper._parse_salary("$120,000 - $150,000") == (120000, 150000)
    assert scraper._parse_salary("$$60,000 - $65,000") == (60000, 65000)
    assert scraper._parse_salary("$150,000") == (150000, None)
    assert scraper._parse_salary("") == (None, None)
    assert scraper._parse_salary("Depends on Experience") == (None, None)


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_dice_custom_search_terms(httpx_mock):
    html = _build_dice_html(MOCK_JOB_DATA[:1])
    httpx_mock.add_response(
        url=re.compile(r"https://www\.dice\.com/jobs\?.*"),
        text=html,
    )
    scraper = DiceScraper(search_terms=["kubernetes engineer", "terraform"])
    jobs = await scraper.scrape()
    # Should have made requests with custom terms
    assert len(httpx_mock.get_requests()) > 0
    req_urls = [str(r.url) for r in httpx_mock.get_requests()]
    assert any("kubernetes" in u for u in req_urls)
