import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.indeed import IndeedScraper, DEFAULT_KEYWORDS

MOCK_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Indeed Jobs</title>
    <item>
      <title>Senior DevOps Engineer</title>
      <link>https://www.indeed.com/viewjob?jk=abc123</link>
      <author>TechCorp</author>
      <description>Looking for a senior DevOps engineer with AWS experience.</description>
      <pubDate>Sat, 01 Mar 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Platform Engineer</title>
      <link>https://www.indeed.com/viewjob?jk=def456</link>
      <author>CloudInc</author>
      <description>Platform engineering role with Kubernetes.</description>
      <pubDate>Fri, 28 Feb 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>"""


@pytest.mark.asyncio
async def test_indeed_parse(httpx_mock):
    for kw in DEFAULT_KEYWORDS:
        httpx_mock.add_response(url=re.compile(r"https://www\.indeed\.com/rss\?.*"), text=MOCK_RSS)
    scraper = IndeedScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 10  # 2 per keyword x 5 keywords
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].title == "Senior DevOps Engineer"
    assert jobs[0].company == "TechCorp"
    assert jobs[0].source == "indeed"


@pytest.mark.asyncio
async def test_indeed_handles_empty(httpx_mock):
    empty_rss = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'
    for kw in DEFAULT_KEYWORDS:
        httpx_mock.add_response(url=re.compile(r"https://www\.indeed\.com/rss\?.*"), text=empty_rss)
    scraper = IndeedScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_indeed_handles_error(httpx_mock):
    for kw in DEFAULT_KEYWORDS:
        httpx_mock.add_response(url=re.compile(r"https://www\.indeed\.com/rss\?.*"), status_code=500)
    scraper = IndeedScraper()
    jobs = await scraper.scrape()
    assert jobs == []
