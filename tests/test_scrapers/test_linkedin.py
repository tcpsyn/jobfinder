import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.linkedin import LinkedInScraper

MOCK_LINKEDIN_HTML = """
<html>
<body>
<ul class="jobs-search__results-list">
  <li>
    <div class="base-card base-search-card job-search-card"
         data-entity-urn="urn:li:jobPosting:4384176322">
      <a class="base-card__full-link"
         href="https://www.linkedin.com/jobs/view/devops-engineer-at-techcorp-4384176322?position=1&pageNum=0&refId=abc&trackingId=xyz">
        <span class="sr-only">DevOps Engineer (Remote)</span>
      </a>
      <div class="base-search-card__info">
        <h3 class="base-search-card__title">DevOps Engineer (Remote)</h3>
        <h4 class="base-search-card__subtitle">
          <a href="https://www.linkedin.com/company/techcorp">TechCorp</a>
        </h4>
        <div class="base-search-card__metadata">
          <span class="job-search-card__location">Denver, CO</span>
          <time datetime="2026-03-11">1 day ago</time>
          <span class="job-search-card__salary-info">$120K/yr - $150K/yr</span>
        </div>
      </div>
    </div>
  </li>
  <li>
    <div class="base-card base-search-card job-search-card"
         data-entity-urn="urn:li:jobPosting:4384176323">
      <a class="base-card__full-link"
         href="https://www.linkedin.com/jobs/view/sre-at-cloudinc-4384176323?position=2&pageNum=0&refId=def&trackingId=uvw">
        <span class="sr-only">Site Reliability Engineer</span>
      </a>
      <div class="base-search-card__info">
        <h3 class="base-search-card__title">Site Reliability Engineer</h3>
        <h4 class="base-search-card__subtitle">
          <a href="https://www.linkedin.com/company/cloudinc">CloudInc</a>
        </h4>
        <div class="base-search-card__metadata">
          <span class="job-search-card__location">Austin, TX</span>
          <time datetime="2026-03-10">2 days ago</time>
        </div>
      </div>
    </div>
  </li>
  <li>
    <div class="base-card base-search-card job-search-card">
      <a class="base-card__full-link"
         href="https://www.linkedin.com/jobs/view/platform-eng-at-startup-4384176324?position=3">
        <span class="sr-only">Platform Engineer</span>
      </a>
      <div class="base-search-card__info">
        <h3 class="base-search-card__title">Platform Engineer</h3>
        <h4 class="base-search-card__subtitle">StartupCo</h4>
        <div class="base-search-card__metadata">
          <span class="job-search-card__location">Remote</span>
          <time datetime="2026-03-12">8 hours ago</time>
        </div>
      </div>
    </div>
  </li>
</ul>
</body>
</html>
"""


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_linkedin_parse(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://www\.linkedin\.com/jobs/search\?.*"),
        text=MOCK_LINKEDIN_HTML,
    )
    scraper = LinkedInScraper()
    jobs = await scraper.scrape()
    assert len(jobs) >= 3
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].source == "linkedin"

    devops = next(j for j in jobs if "DevOps" in j.title)
    assert devops.company == "TechCorp"
    assert devops.location == "Denver, CO"
    assert devops.posted_date == "2026-03-11"
    assert "linkedin.com/jobs/view" in devops.url
    # Tracking params should be stripped
    assert "trackingId" not in devops.url

    sre = next(j for j in jobs if "Reliability" in j.title)
    assert sre.company == "CloudInc"
    assert sre.location == "Austin, TX"

    # Company without <a> tag (just text)
    plat = next(j for j in jobs if "Platform" in j.title)
    assert plat.company == "StartupCo"


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_linkedin_deduplicates(httpx_mock):
    # Same HTML returned for multiple pages — should deduplicate
    httpx_mock.add_response(
        url=re.compile(r"https://www\.linkedin\.com/jobs/search\?.*"),
        text=MOCK_LINKEDIN_HTML,
    )
    scraper = LinkedInScraper()
    jobs = await scraper.scrape()
    urls = [j.url for j in jobs]
    assert len(urls) == len(set(urls))


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_linkedin_handles_empty(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://www\.linkedin\.com/jobs/search\?.*"),
        text="<html><body></body></html>",
    )
    scraper = LinkedInScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_linkedin_handles_error(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://www\.linkedin\.com/jobs/search\?.*"),
        status_code=429,
    )
    scraper = LinkedInScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_linkedin_url_cleaning():
    scraper = LinkedInScraper()
    dirty = "https://www.linkedin.com/jobs/view/devops-at-corp-123?position=1&pageNum=0&refId=abc&trackingId=xyz"
    clean = scraper._clean_url(dirty)
    assert clean == "https://www.linkedin.com/jobs/view/devops-at-corp-123"
    assert "trackingId" not in clean


@pytest.mark.asyncio
async def test_linkedin_salary_parsing():
    scraper = LinkedInScraper()
    assert scraper._parse_salary("$120,000 - $150,000") == (120000, 150000)
    assert scraper._parse_salary("$80,000/yr") == (80000, None)
    assert scraper._parse_salary("") == (None, None)


@pytest.mark.httpx_mock(can_send_already_matched_responses=True)
@pytest.mark.asyncio
async def test_linkedin_custom_search_terms(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://www\.linkedin\.com/jobs/search\?.*"),
        text=MOCK_LINKEDIN_HTML,
    )
    scraper = LinkedInScraper(search_terms=["kubernetes remote", "terraform remote"])
    jobs = await scraper.scrape()
    req_urls = [str(r.url) for r in httpx_mock.get_requests()]
    assert any("kubernetes" in u for u in req_urls)
