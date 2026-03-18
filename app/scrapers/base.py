import asyncio
import html as _html
import logging
import random
import re
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlparse

import httpx

from app.rate_limiter import get_limiter_for_url

logger = logging.getLogger(__name__)

# Salary sanity bounds
MIN_ANNUAL_SALARY = 10_000
MAX_ANNUAL_SALARY = 2_000_000

# Retryable HTTP status codes
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}

# User-agent pool for rotation
_USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0",
]


def _random_ua() -> str:
    return random.choice(_USER_AGENTS)


def clean_text(text: str) -> str:
    """Decode HTML entities and fix mojibake in scraped text."""
    if not text:
        return text
    # Decode HTML entities (may be double-encoded, so run twice)
    text = _html.unescape(_html.unescape(text))
    # Fix UTF-8 text decoded as Latin-1/CP1252
    try:
        text = text.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    return text


def validate_url(url: str) -> bool:
    """Check that a URL has a valid scheme and hostname."""
    if not url:
        return False
    try:
        parsed = urlparse(url)
        return parsed.scheme in ("http", "https") and bool(parsed.hostname)
    except Exception:
        return False


def validate_salary(value: int | None) -> int | None:
    """Return salary if within sane bounds, else None."""
    if value is None:
        return None
    if MIN_ANNUAL_SALARY <= value <= MAX_ANNUAL_SALARY:
        return value
    return None


@dataclass
class JobListing:
    title: str
    company: str
    location: str
    description: str
    url: str
    source: str
    salary_min: Optional[int] = None
    salary_max: Optional[int] = None
    posted_date: Optional[str] = None
    application_method: str = "url"
    contact_email: Optional[str] = None
    tags: list[str] = field(default_factory=list)

    def __post_init__(self):
        self.title = clean_text(self.title)
        self.description = clean_text(self.description)
        self.company = clean_text(self.company)
        self.location = clean_text(self.location)
        self.salary_min = validate_salary(self.salary_min)
        self.salary_max = validate_salary(self.salary_max)


class BaseScraper:
    source_name: str = "base"

    # Retry configuration — subclasses can override
    max_retries: int = 3
    initial_delay: float = 2.0
    max_delay: float = 30.0

    def __init__(self, search_terms: list[str] | None = None, scraper_keys: dict | None = None):
        self.search_terms = search_terms or []
        self.scraper_keys = scraper_keys or {}

    def get_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            headers={"User-Agent": _random_ua()},
            timeout=30.0,
            follow_redirects=True,
        )

    async def rate_limited_get(self, client: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
        """Make a GET request with per-domain rate limiting and retry/backoff."""
        await get_limiter_for_url(url).acquire()
        return await self._request_with_retry(client, url, **kwargs)

    async def _request_with_retry(self, client: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
        """Execute a GET request with exponential backoff on retryable errors."""
        last_exc = None
        delay = self.initial_delay

        for attempt in range(1, self.max_retries + 1):
            try:
                resp = await client.get(url, **kwargs)

                # Check Retry-After header on 429/503
                if resp.status_code in RETRYABLE_STATUS_CODES and attempt < self.max_retries:
                    retry_after = self._parse_retry_after(resp)
                    wait = retry_after if retry_after else delay
                    logger.info(
                        f"{self.source_name}: HTTP {resp.status_code} on attempt {attempt}/{self.max_retries}, "
                        f"retrying in {wait:.1f}s — {url}"
                    )
                    await asyncio.sleep(wait)
                    delay = min(delay * 2, self.max_delay)
                    continue

                return resp

            except (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError) as e:
                last_exc = e
                if attempt < self.max_retries:
                    logger.info(
                        f"{self.source_name}: {type(e).__name__} on attempt {attempt}/{self.max_retries}, "
                        f"retrying in {delay:.1f}s — {url}"
                    )
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, self.max_delay)

        if last_exc:
            raise last_exc
        raise httpx.TimeoutException(f"All {self.max_retries} retries exhausted for {url}")

    @staticmethod
    def _parse_retry_after(resp: httpx.Response) -> float | None:
        """Parse Retry-After or X-RateLimit-Reset headers."""
        retry_after = resp.headers.get("Retry-After") or resp.headers.get("X-RateLimit-Reset")
        if not retry_after:
            return None
        try:
            return min(float(retry_after), 60.0)  # cap at 60s
        except (ValueError, TypeError):
            return None

    async def scrape(self) -> list[JobListing]:
        raise NotImplementedError
