import re

import pytest
from app.scrapers.indeed import IndeedScraper
from app.scrapers.linkedin import LinkedInScraper
from app.scrapers.dice import DiceScraper
from app.scrapers.remotive import RemotiveScraper
from app.scrapers.usajobs import USAJobsScraper

MOCK_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Test Job</title>
      <link>https://www.indeed.com/viewjob?jk=abc</link>
      <author>TestCo</author>
      <description>A test job</description>
    </item>
  </channel>
</rss>"""


@pytest.mark.asyncio
async def test_indeed_uses_custom_terms(httpx_mock):
    terms = ["kubernetes engineer remote", "cloud architect remote"]
    for _ in terms:
        httpx_mock.add_response(url=re.compile(r"https://www\.indeed\.com/rss\?.*"), text=MOCK_RSS)
    scraper = IndeedScraper(search_terms=terms)
    jobs = await scraper.scrape()
    assert len(jobs) == 2


@pytest.mark.asyncio
async def test_linkedin_builds_custom_query():
    scraper = LinkedInScraper(search_terms=["devops", "SRE", "cloud"])
    query = scraper._build_query()
    assert "site:linkedin.com/jobs" in query
    assert '"devops"' in query
    assert '"SRE"' in query


@pytest.mark.asyncio
async def test_dice_builds_custom_query():
    scraper = DiceScraper(search_terms=["devops", "platform"])
    query = scraper._build_query()
    assert "site:dice.com/job-detail" in query
    assert '"devops"' in query


def test_remotive_maps_categories():
    scraper = RemotiveScraper(search_terms=["devops", "data"])
    cats = scraper._get_categories()
    assert "devops" in cats
    assert "data" in cats


def test_remotive_falls_back_to_defaults():
    scraper = RemotiveScraper(search_terms=["nonexistent"])
    cats = scraper._get_categories()
    assert cats == ["devops", "software-dev"]
