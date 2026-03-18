import pytest
from app.scrapers.base import JobListing
from app.scrapers.weworkremotely import WeWorkRemotelyScraper, FEED_URLS

MOCK_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>We Work Remotely</title>
    <item>
      <title>TechCorp: Senior DevOps Engineer</title>
      <link>https://weworkremotely.com/remote-jobs/techcorp-devops</link>
      <description>AWS and Terraform experience required.</description>
      <pubDate>Sat, 01 Mar 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>CloudInc: SRE Engineer</title>
      <link>https://weworkremotely.com/remote-jobs/cloudinc-sre</link>
      <description>Site reliability role.</description>
      <pubDate>Fri, 28 Feb 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>"""


@pytest.mark.asyncio
async def test_wwr_parse(httpx_mock):
    for url in FEED_URLS:
        httpx_mock.add_response(url=url, text=MOCK_RSS)
    scraper = WeWorkRemotelyScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 4  # 2 per feed x 2 feeds
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].title == "Senior DevOps Engineer"
    assert jobs[0].company == "TechCorp"
    assert jobs[0].source == "weworkremotely"


@pytest.mark.asyncio
async def test_wwr_handles_empty(httpx_mock):
    empty_rss = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'
    for url in FEED_URLS:
        httpx_mock.add_response(url=url, text=empty_rss)
    scraper = WeWorkRemotelyScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_wwr_handles_error(httpx_mock):
    # 3 retry attempts per feed URL
    for url in FEED_URLS:
        for _ in range(3):
            httpx_mock.add_response(url=url, status_code=500)
    scraper = WeWorkRemotelyScraper()
    scraper.initial_delay = 0.01
    jobs = await scraper.scrape()
    assert jobs == []
