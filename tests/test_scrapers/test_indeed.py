import re
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.scrapers.base import JobListing
from app.scrapers.indeed import IndeedScraper, DEFAULT_KEYWORDS, MAX_SEARCH_TERMS

URL_PATTERN = re.compile(r"https://www\.indeed\.com/jobs\?.*")


def _make_mosaic_html(jobs_data: list[dict]) -> str:
    """Build a fake Indeed search results page with embedded mosaic JSON."""
    import json

    results = []
    for job in jobs_data:
        results.append({
            "title": job.get("title", ""),
            "company": job.get("company", ""),
            "formattedLocation": job.get("location", "Remote"),
            "snippet": job.get("description", ""),
            "jobkey": job.get("jobkey", ""),
            "formattedRelativeTime": job.get("posted", ""),
            "salarySnippet": {"text": job.get("salary_text", "")},
        })

    mosaic_data = {
        "metaData": {
            "mosaicProviderJobCardsModel": {
                "results": results,
            }
        }
    }
    padding = " " * 1000
    return f"""<html><head></head><body>{padding}
<script>window.mosaic.providerData = {json.dumps(mosaic_data)};</script>
</body></html>"""


def _make_card_html(jobs_data: list[dict]) -> str:
    """Build a fake Indeed search results page with HTML job cards."""
    cards = []
    for job in jobs_data:
        jk = job.get("jobkey", "")
        cards.append(f"""
        <div data-jk="{jk}" class="job_seen_beacon">
          <h2><a href="/viewjob?jk={jk}">{job.get("title", "")}</a></h2>
          <span data-testid="company-name">{job.get("company", "")}</span>
          <div data-testid="text-location">{job.get("location", "Remote")}</div>
          <div class="job-snippet">{job.get("description", "")}</div>
        </div>
        """)
    padding = " " * 1000
    return f"<html><body>{padding}{''.join(cards)}</body></html>"


SAMPLE_JOBS = [
    {
        "title": "Senior DevOps Engineer",
        "company": "TechCorp",
        "location": "Remote",
        "description": "Looking for a senior DevOps engineer with AWS experience.",
        "jobkey": "abc123",
        "posted": "1 day ago",
        "salary_text": "$120,000 - $160,000 a year",
    },
    {
        "title": "Platform Engineer",
        "company": "CloudInc",
        "location": "Remote",
        "description": "Platform engineering role with Kubernetes.",
        "jobkey": "def456",
        "posted": "2 days ago",
        "salary_text": "",
    },
]

MOCK_HTML = _make_mosaic_html(SAMPLE_JOBS)


def _mock_all_default_keywords(httpx_mock, html=MOCK_HTML):
    """Register a mock response for each default keyword."""
    for _ in DEFAULT_KEYWORDS:
        httpx_mock.add_response(url=URL_PATTERN, text=html)


# ---------------------------------------------------------------------------
# httpx-path tests (Playwright not available)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", False)
async def test_indeed_parse_mosaic_json(httpx_mock):
    """Test parsing job data from embedded mosaic JSON via httpx fallback."""
    _mock_all_default_keywords(httpx_mock)
    scraper = IndeedScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 2
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].title == "Senior DevOps Engineer"
    assert jobs[0].company == "TechCorp"
    assert jobs[0].source == "indeed"
    assert jobs[0].url == "https://www.indeed.com/viewjob?jk=abc123"
    assert jobs[0].salary_min == 120000
    assert jobs[0].salary_max == 160000
    assert jobs[1].salary_min is None


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", False)
async def test_indeed_parse_html_cards(httpx_mock):
    """Test fallback to HTML card parsing when no mosaic JSON present."""
    html = _make_card_html(SAMPLE_JOBS)
    _mock_all_default_keywords(httpx_mock, html)
    scraper = IndeedScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 2
    assert jobs[0].title == "Senior DevOps Engineer"
    assert jobs[0].company == "TechCorp"


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", False)
async def test_indeed_deduplicates(httpx_mock):
    """Test that duplicate job URLs across keywords are deduplicated."""
    _mock_all_default_keywords(httpx_mock)
    scraper = IndeedScraper()
    jobs = await scraper.scrape()
    urls = [j.url for j in jobs]
    assert len(urls) == len(set(urls))


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", False)
async def test_indeed_handles_empty(httpx_mock):
    """Test that empty search results return empty list."""
    empty_html = "<html><body>" + " " * 1000 + "</body></html>"
    _mock_all_default_keywords(httpx_mock, empty_html)
    scraper = IndeedScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", False)
async def test_indeed_handles_error(httpx_mock):
    """Test that HTTP errors are handled gracefully."""
    for _ in DEFAULT_KEYWORDS:
        httpx_mock.add_response(url=URL_PATTERN, status_code=500)
    scraper = IndeedScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", False)
async def test_indeed_handles_captcha_httpx(httpx_mock):
    """Test that captcha pages are detected and skipped in httpx path."""
    captcha_html = "<html><body>Please verify you are human. Captcha challenge.</body></html>"
    _mock_all_default_keywords(httpx_mock, captcha_html)
    scraper = IndeedScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", False)
async def test_indeed_limits_search_terms(httpx_mock):
    """Test that search terms are limited to MAX_SEARCH_TERMS."""
    terms = [f"term{i}" for i in range(10)]
    for _ in range(MAX_SEARCH_TERMS):
        httpx_mock.add_response(url=URL_PATTERN, text=MOCK_HTML)
    scraper = IndeedScraper(search_terms=terms)
    await scraper.scrape()
    assert len(httpx_mock.get_requests()) == MAX_SEARCH_TERMS


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", False)
async def test_indeed_word_matching_filter(httpx_mock):
    """Test that word-based matching filters results when search terms are provided."""
    jobs_data = [
        {
            "title": "DevOps Engineer",
            "company": "AcmeCorp",
            "description": "DevOps and cloud infrastructure role",
            "jobkey": "match1",
        },
        {
            "title": "Marketing Manager",
            "company": "BrandCo",
            "description": "Lead marketing campaigns",
            "jobkey": "nomatch1",
        },
    ]
    html = _make_mosaic_html(jobs_data)
    httpx_mock.add_response(url=URL_PATTERN, text=html)
    scraper = IndeedScraper(search_terms=["devops engineer remote"])
    jobs = await scraper.scrape()
    assert len(jobs) == 1
    assert jobs[0].title == "DevOps Engineer"


@pytest.mark.asyncio
async def test_indeed_salary_parsing():
    """Test salary text parsing."""
    scraper = IndeedScraper()
    assert scraper._parse_salary("$80,000 - $120,000 a year") == (80000, 120000)
    assert scraper._parse_salary("$50,000 a year") == (50000, 50000)
    assert scraper._parse_salary("") == (None, None)
    assert scraper._parse_salary("Competitive") == (None, None)


@pytest.mark.asyncio
async def test_indeed_max_search_terms_constant():
    """Verify MAX_SEARCH_TERMS is 5."""
    assert MAX_SEARCH_TERMS == 5


# ---------------------------------------------------------------------------
# _is_blocked detection
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_is_blocked_detects_captcha():
    """Test captcha/challenge page detection."""
    scraper = IndeedScraper()
    assert scraper._is_blocked("<html><body>captcha</body></html>") is True
    assert scraper._is_blocked("<html><body>cf-challenge</body></html>") is True
    assert scraper._is_blocked("<html><body>Just a moment</body></html>") is True
    assert scraper._is_blocked("short") is True
    assert scraper._is_blocked(MOCK_HTML) is False


# ---------------------------------------------------------------------------
# Playwright path tests (mocked)
# ---------------------------------------------------------------------------

def _make_mock_page(html_responses: list[str]):
    """Create a mock Playwright page that returns given HTML content in order."""
    page = AsyncMock()
    page.content = AsyncMock(side_effect=html_responses)
    page.goto = AsyncMock()
    return page


def _make_mock_context(page):
    """Create a mock browser context that returns the given page."""
    context = AsyncMock()
    context.new_page = AsyncMock(return_value=page)
    context.cookies = AsyncMock(return_value=[])
    context.close = AsyncMock()
    return context


def _make_mock_pool(context):
    """Create a mock BrowserPool that returns the given context."""
    pool = MagicMock()
    pool.get_context = AsyncMock(return_value=context)
    pool.save_cookies = MagicMock()
    return pool


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", True)
@patch("app.scrapers.indeed.STEALTH_AVAILABLE", False)
@patch("app.scrapers.indeed.get_browser_pool")
async def test_indeed_playwright_scrape(mock_get_pool):
    """Test Playwright scraping path with mocked browser."""
    # homepage warmup + 5 keyword pages = 6 page.content() calls
    html_responses = [MOCK_HTML] * (1 + len(DEFAULT_KEYWORDS))
    page = _make_mock_page(html_responses)
    context = _make_mock_context(page)
    pool = _make_mock_pool(context)
    mock_get_pool.return_value = pool

    scraper = IndeedScraper()
    jobs = await scraper.scrape()

    assert len(jobs) == 2
    assert jobs[0].title == "Senior DevOps Engineer"
    assert jobs[0].source == "indeed"
    pool.get_context.assert_called_once_with("indeed")
    pool.save_cookies.assert_called_once()


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", True)
@patch("app.scrapers.indeed.STEALTH_AVAILABLE", True)
@patch("app.scrapers.indeed.get_browser_pool")
async def test_indeed_playwright_applies_stealth(mock_get_pool):
    """Test that stealth_async is called when available."""
    mock_stealth = AsyncMock()
    html_responses = [MOCK_HTML] * (1 + len(DEFAULT_KEYWORDS))
    page = _make_mock_page(html_responses)
    context = _make_mock_context(page)
    pool = _make_mock_pool(context)
    mock_get_pool.return_value = pool

    with patch("app.scrapers.indeed.stealth_async", mock_stealth):
        scraper = IndeedScraper()
        await scraper.scrape()

    mock_stealth.assert_called_once_with(page)


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", True)
@patch("app.scrapers.indeed.STEALTH_AVAILABLE", False)
@patch("app.scrapers.indeed.get_browser_pool")
async def test_indeed_playwright_captcha_retry(mock_get_pool):
    """Test that Playwright retries once on captcha detection."""
    blocked_html = "<html><body>captcha challenge</body></html>"
    # warmup, then first keyword returns blocked, retry returns good html
    # remaining keywords return good html
    html_responses = [MOCK_HTML, blocked_html, MOCK_HTML] + [MOCK_HTML] * (len(DEFAULT_KEYWORDS) - 1)
    page = _make_mock_page(html_responses)
    context = _make_mock_context(page)
    pool = _make_mock_pool(context)
    mock_get_pool.return_value = pool

    scraper = IndeedScraper()
    jobs = await scraper.scrape()

    # Should still get results after retry
    assert len(jobs) == 2


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", True)
@patch("app.scrapers.indeed.STEALTH_AVAILABLE", False)
@patch("app.scrapers.indeed.get_browser_pool")
async def test_indeed_playwright_fails_falls_back_to_httpx(mock_get_pool, httpx_mock):
    """Test fallback to httpx when Playwright raises an exception."""
    pool = _make_mock_pool(AsyncMock())
    pool.get_context = AsyncMock(side_effect=Exception("Browser crashed"))
    mock_get_pool.return_value = pool

    _mock_all_default_keywords(httpx_mock)

    scraper = IndeedScraper()
    jobs = await scraper.scrape()

    assert len(jobs) == 2
    assert jobs[0].title == "Senior DevOps Engineer"


@pytest.mark.asyncio
@patch("app.scrapers.indeed.PLAYWRIGHT_AVAILABLE", True)
@patch("app.scrapers.indeed.STEALTH_AVAILABLE", False)
@patch("app.scrapers.indeed.get_browser_pool")
async def test_indeed_playwright_empty_falls_back_to_httpx(mock_get_pool, httpx_mock):
    """Test fallback to httpx when Playwright returns no results."""
    empty_html = "<html><body>" + " " * 1000 + "</body></html>"
    html_responses = [empty_html] * (1 + len(DEFAULT_KEYWORDS))
    page = _make_mock_page(html_responses)
    context = _make_mock_context(page)
    pool = _make_mock_pool(context)
    mock_get_pool.return_value = pool

    _mock_all_default_keywords(httpx_mock)

    scraper = IndeedScraper()
    jobs = await scraper.scrape()

    assert len(jobs) == 2
    assert jobs[0].title == "Senior DevOps Engineer"
