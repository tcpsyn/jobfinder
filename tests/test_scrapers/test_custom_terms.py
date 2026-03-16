import json
import re

import pytest
from app.scrapers.indeed import IndeedScraper
from app.scrapers.linkedin import LinkedInScraper
from app.scrapers.dice import DiceScraper
from app.scrapers.remotive import RemotiveScraper
from app.scrapers.usajobs import USAJobsScraper


def _make_indeed_html(jobs_data: list[dict]) -> str:
    results = []
    for job in jobs_data:
        results.append({
            "title": job.get("title", ""),
            "company": job.get("company", ""),
            "formattedLocation": "Remote",
            "snippet": job.get("description", ""),
            "jobkey": job.get("jobkey", ""),
            "formattedRelativeTime": "",
            "salarySnippet": {"text": ""},
        })
    mosaic_data = {"metaData": {"mosaicProviderJobCardsModel": {"results": results}}}
    padding = " " * 1000
    return f'<html><body>{padding}<script>window.mosaic.providerData = {json.dumps(mosaic_data)};</script></body></html>'


INDEED_URL_PATTERN = re.compile(r"https://www\.indeed\.com/jobs\?.*")


@pytest.mark.asyncio
async def test_indeed_uses_custom_terms(httpx_mock):
    terms = ["kubernetes engineer remote", "cloud architect remote"]
    # First term returns a kubernetes job, second returns a cloud job
    html1 = _make_indeed_html([{"title": "Kubernetes Engineer", "company": "TestCo", "description": "kubernetes engineer role", "jobkey": "k1"}])
    html2 = _make_indeed_html([{"title": "Cloud Architect", "company": "TestCo", "description": "cloud architect role", "jobkey": "c1"}])
    httpx_mock.add_response(url=INDEED_URL_PATTERN, text=html1)
    httpx_mock.add_response(url=INDEED_URL_PATTERN, text=html2)
    scraper = IndeedScraper(search_terms=terms)
    jobs = await scraper.scrape()
    assert len(jobs) == 2


@pytest.mark.asyncio
async def test_linkedin_builds_params():
    scraper = LinkedInScraper(search_terms=["devops", "SRE", "cloud"])
    params = scraper._build_params("devops")
    assert params["keywords"] == "devops"
    assert "location" in params
    assert "f_TPR" in params


@pytest.mark.asyncio
async def test_dice_builds_params():
    scraper = DiceScraper(search_terms=["devops", "platform"])
    params = scraper._build_params("devops")
    assert params["q"] == "devops"
    assert params["countryCode"] == "US"


def test_remotive_maps_categories():
    scraper = RemotiveScraper(search_terms=["devops", "data"])
    cats = scraper._get_categories()
    assert "devops" in cats
    assert "data" in cats


def test_remotive_falls_back_to_defaults():
    scraper = RemotiveScraper(search_terms=["nonexistent"])
    cats = scraper._get_categories()
    assert cats == ["devops", "software-dev"]
