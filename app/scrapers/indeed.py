import asyncio
import json
import logging
import random
from urllib.parse import quote_plus

from bs4 import BeautifulSoup

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

try:
    from app.browser_pool import (
        get_browser_pool,
        PLAYWRIGHT_AVAILABLE,
        STEALTH_AVAILABLE,
        stealth_async,
    )
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    STEALTH_AVAILABLE = False
    stealth_async = None

DEFAULT_KEYWORDS = [
    "devops engineer remote",
    "SRE remote",
    "infrastructure engineer remote",
    "AI engineer remote",
    "platform engineer remote",
]

MAX_SEARCH_TERMS = 10
SEARCH_URL = "https://www.indeed.com/jobs"
DOMAIN = "indeed"


class IndeedScraper(BaseScraper):
    source_name = "indeed"

    def _matches_search_terms(self, searchable: str) -> bool:
        """Check if searchable text matches any search term.

        Splits each search term into words and requires at least 2 words
        (or all words if the term has fewer than 2) to appear in the text.
        """
        for term in self.search_terms:
            words = term.lower().split()
            if not words:
                continue
            threshold = min(2, len(words))
            matched = sum(1 for w in words if w in searchable)
            if matched >= threshold:
                return True
        return False

    def _parse_search_results(self, html: str) -> list[dict]:
        """Extract job data from Indeed search results HTML.

        Indeed embeds job data in a window.mosaic.providerData JSON blob
        inside a script tag. Falls back to HTML card parsing if not found.
        """
        soup = BeautifulSoup(html, "html.parser")
        jobs = []

        # Strategy 1: Extract from embedded JSON data
        for script in soup.find_all("script"):
            text = script.string or ""
            if "window.mosaic.providerData" in text:
                try:
                    start = text.index("{", text.index("window.mosaic.providerData"))
                    # Find matching closing brace
                    depth = 0
                    end = start
                    for i, ch in enumerate(text[start:], start):
                        if ch == "{":
                            depth += 1
                        elif ch == "}":
                            depth -= 1
                            if depth == 0:
                                end = i + 1
                                break
                    data = json.loads(text[start:end])
                    results = (
                        data.get("metaData", {})
                        .get("mosaicProviderJobCardsModel", {})
                        .get("results", [])
                    )
                    for result in results:
                        title = result.get("title", "")
                        company = result.get("company", "")
                        location = result.get("formattedLocation", "Remote")
                        description = result.get("snippet", "")
                        job_key = result.get("jobkey", "")
                        url = f"https://www.indeed.com/viewjob?jk={job_key}" if job_key else ""
                        posted = result.get("formattedRelativeTime", "")
                        salary_snippet = result.get("salarySnippet", {}) or {}
                        salary_text = salary_snippet.get("text", "")

                        salary_min, salary_max = self._parse_salary(salary_text)

                        if title and url:
                            jobs.append({
                                "title": title,
                                "company": company,
                                "location": location,
                                "description": description,
                                "url": url,
                                "posted_date": posted,
                                "salary_min": salary_min,
                                "salary_max": salary_max,
                            })
                    if jobs:
                        return jobs
                except (ValueError, json.JSONDecodeError, KeyError) as e:
                    logger.debug(f"Indeed JSON extraction failed: {e}")

        # Strategy 2: Parse HTML job cards
        for card in soup.select('[data-jk], .job_seen_beacon, .resultContent'):
            title_el = card.select_one("h2 a, .jobTitle a, [data-jk] a")
            company_el = card.select_one('[data-testid="company-name"], .companyName, .company')
            location_el = card.select_one('[data-testid="text-location"], .companyLocation')
            snippet_el = card.select_one(".job-snippet, .jobCardShelfContainer")

            title = title_el.get_text(strip=True) if title_el else ""
            href = title_el.get("href", "") if title_el else ""
            if href and not href.startswith("http"):
                href = f"https://www.indeed.com{href}"

            if title and href:
                jobs.append({
                    "title": title,
                    "company": company_el.get_text(strip=True) if company_el else "",
                    "location": location_el.get_text(strip=True) if location_el else "Remote",
                    "description": snippet_el.get_text(strip=True) if snippet_el else "",
                    "url": href,
                    "posted_date": None,
                    "salary_min": None,
                    "salary_max": None,
                })

        return jobs

    @staticmethod
    def _parse_salary(text: str) -> tuple[int | None, int | None]:
        """Extract min/max salary from Indeed salary text like '$80,000 - $120,000 a year'."""
        if not text:
            return None, None
        import re
        amounts = re.findall(r"\$[\d,]+", text)
        if not amounts:
            return None, None
        try:
            values = [int(a.replace("$", "").replace(",", "")) for a in amounts]
            if len(values) >= 2:
                return values[0], values[1]
            return values[0], values[0]
        except ValueError:
            return None, None

    @staticmethod
    def _is_blocked(html: str) -> bool:
        """Detect if the response is a captcha/challenge page."""
        if len(html) < 1000:
            return True
        lower = html.lower()
        return "captcha" in lower or "cf-challenge" in lower or "just a moment" in lower

    async def _scrape_with_playwright(self, keywords: list[str]) -> list[dict]:
        """Scrape Indeed using Playwright with stealth and cookie persistence."""
        if not PLAYWRIGHT_AVAILABLE:
            return []

        pool = get_browser_pool()
        context = await pool.get_context(DOMAIN)
        all_results = []

        try:
            page = await context.new_page()

            if STEALTH_AVAILABLE and stealth_async:
                await stealth_async(page)

            # Warm up: visit homepage to get Cloudflare cookies
            try:
                await page.goto("https://www.indeed.com", wait_until="networkidle", timeout=30000)
                await asyncio.sleep(random.uniform(1.5, 3.0))
            except Exception as e:
                logger.warning(f"Indeed homepage warmup failed: {e}")

            from app.rate_limiter import get_limiter
            limiter = get_limiter("www.indeed.com")

            for keyword in keywords:
                await limiter.acquire()
                url = f"{SEARCH_URL}?q={quote_plus(keyword)}&l=remote&sort=date"

                try:
                    await page.goto(url, wait_until="networkidle", timeout=30000)
                    await asyncio.sleep(random.uniform(1.5, 3.0))
                except Exception as e:
                    logger.warning(f"Indeed Playwright navigation failed for '{keyword}': {e}")
                    continue

                html = await page.content()

                # Check for captcha/challenge - wait and retry once
                if self._is_blocked(html):
                    logger.info(f"Indeed challenge detected for '{keyword}', waiting to retry...")
                    await asyncio.sleep(random.uniform(5.0, 8.0))
                    html = await page.content()
                    if self._is_blocked(html):
                        logger.warning(f"Indeed still blocked for '{keyword}' after retry")
                        continue

                results = self._parse_search_results(html)
                logger.info(f"Indeed (Playwright): '{keyword}' returned {len(results)} results")
                all_results.extend(results)

                # Random delay between searches
                await asyncio.sleep(random.uniform(2.0, 5.0))

            # Save cookies for next session
            cookies = await context.cookies()
            pool.save_cookies(DOMAIN, cookies)

        except Exception as e:
            logger.warning(f"Indeed Playwright scrape error: {e}")
        finally:
            await context.close()

        return all_results

    async def _scrape_with_httpx(self, keywords: list[str]) -> list[dict]:
        """Scrape Indeed using httpx (fallback method)."""
        all_results = []

        async with self.get_client() as client:
            for keyword in keywords:
                url = f"{SEARCH_URL}?q={quote_plus(keyword)}&l=remote&sort=date"
                try:
                    resp = await self.rate_limited_get(client, url)
                    resp.raise_for_status()
                except Exception as e:
                    logger.warning(f"Indeed httpx scrape failed for '{keyword}': {e}")
                    continue

                if self._is_blocked(resp.text):
                    logger.warning(
                        f"Indeed appears to be blocking requests for '{keyword}' "
                        "(captcha or minimal response). Skipping."
                    )
                    continue

                results = self._parse_search_results(resp.text)
                logger.info(f"Indeed (httpx): '{keyword}' returned {len(results)} results")
                all_results.extend(results)

        return all_results

    def _build_listings(self, raw_results: list[dict]) -> list[JobListing]:
        """Deduplicate and filter raw results into JobListings."""
        jobs = []
        seen_urls = set()

        for result in raw_results:
            if result["url"] in seen_urls:
                continue
            seen_urls.add(result["url"])

            job = JobListing(
                title=result["title"],
                company=result["company"],
                location=result["location"],
                description=result["description"],
                url=result["url"],
                source=self.source_name,
                salary_min=result.get("salary_min"),
                salary_max=result.get("salary_max"),
                posted_date=result.get("posted_date"),
            )

            if self.search_terms:
                searchable = f"{job.title} {job.description} {job.company}".lower()
                if not self._matches_search_terms(searchable):
                    continue

            jobs.append(job)

        return jobs

    async def scrape(self) -> list[JobListing]:
        keywords = self.search_terms if self.search_terms else DEFAULT_KEYWORDS
        keywords = keywords[:MAX_SEARCH_TERMS]

        # Try Playwright first
        raw_results = []
        if PLAYWRIGHT_AVAILABLE:
            try:
                raw_results = await self._scrape_with_playwright(keywords)
            except Exception as e:
                logger.warning(f"Indeed Playwright scrape failed entirely: {e}")

        # Fall back to httpx if Playwright produced nothing
        if not raw_results:
            if PLAYWRIGHT_AVAILABLE:
                logger.info("Indeed: Playwright returned no results, falling back to httpx")
            raw_results = await self._scrape_with_httpx(keywords)

        jobs = self._build_listings(raw_results)

        if not jobs:
            logger.warning(
                "Indeed scraper returned 0 results. Indeed aggressively blocks automated "
                "requests. Install playwright (`uv pip install 'careerpulse[playwright]'` "
                "&& `playwright install chromium`) for better results, or consider a paid "
                "job data API."
            )

        return jobs
