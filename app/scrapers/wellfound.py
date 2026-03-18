import json
import logging
import re

import httpx
from bs4 import BeautifulSoup

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

# Wellfound (formerly AngelList Talent) aggressively blocks automated access.
# This scraper attempts to parse their pages but may get 403 responses.
# If Wellfound returns data, it typically uses Next.js with __NEXT_DATA__ or
# Apollo GraphQL state embedded in the page.

BASE_URL = "https://wellfound.com"

# Standard Wellfound role slugs — these are real paths on wellfound.com.
ROLE_SLUG_MAP = {
    "software": "/role/r/software-engineer",
    "backend": "/role/r/backend-engineer",
    "frontend": "/role/r/frontend-engineer",
    "full stack": "/role/r/full-stack-engineer",
    "fullstack": "/role/r/full-stack-engineer",
    "devops": "/role/r/devops-engineer",
    "sre": "/role/r/site-reliability-engineer",
    "site reliability": "/role/r/site-reliability-engineer",
    "infrastructure": "/role/r/infrastructure-engineer",
    "data engineer": "/role/r/data-engineer",
    "data scientist": "/role/r/data-scientist",
    "data": "/role/r/data-engineer",
    "machine learning": "/role/r/machine-learning-engineer",
    "ml": "/role/r/machine-learning-engineer",
    "ai": "/role/r/machine-learning-engineer",
    "mobile": "/role/r/mobile-engineer",
    "ios": "/role/r/ios-engineer",
    "android": "/role/r/android-engineer",
    "security": "/role/r/security-engineer",
    "cloud": "/role/r/cloud-engineer",
    "platform": "/role/r/platform-engineer",
    "qa": "/role/r/qa-engineer",
    "test": "/role/r/qa-engineer",
    "product manager": "/role/r/product-manager",
    "designer": "/role/r/product-designer",
    "ux": "/role/r/product-designer",
}

DEFAULT_ROLES = [
    "/role/r/software-engineer",
    "/role/r/backend-engineer",
    "/role/r/full-stack-engineer",
    "/role/r/devops-engineer",
    "/role/r/data-engineer",
]

BROWSER_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://wellfound.com/",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
}


class WellfoundScraper(BaseScraper):
    source_name = "wellfound"

    def _get_role_paths(self) -> list[str]:
        if not self.search_terms:
            return DEFAULT_ROLES

        paths = []
        seen = set()
        for term in self.search_terms:
            term_lower = term.lower().strip()
            matched = False
            # Try exact match first, then substring match
            for keyword, path in ROLE_SLUG_MAP.items():
                if keyword in term_lower or term_lower in keyword:
                    if path not in seen:
                        paths.append(path)
                        seen.add(path)
                    matched = True
                    break
            if not matched:
                # Fall back to slugifying single/double word terms that look
                # like they could be a Wellfound role slug
                slug = re.sub(r"[^a-z0-9]+", "-", term_lower).strip("-")
                path = f"/role/r/{slug}"
                if path not in seen:
                    paths.append(path)
                    seen.add(path)

        # Also include default roles to broaden coverage
        for path in DEFAULT_ROLES:
            if path not in seen:
                paths.append(path)
                seen.add(path)

        return paths[:10]

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

    def _parse_next_data(self, html: str) -> list[dict]:
        """Extract job data from __NEXT_DATA__ script tag (Next.js SSR)."""
        soup = BeautifulSoup(html, "html.parser")
        script = soup.find("script", id="__NEXT_DATA__")
        if not script or not script.string:
            return []

        try:
            data = json.loads(script.string)
        except json.JSONDecodeError:
            return []

        return self._extract_jobs_from_next_data(data)

    def _extract_jobs_from_next_data(self, data: dict) -> list[dict]:
        """Walk the __NEXT_DATA__ structure to find job listings."""
        jobs = []
        props = data.get("props", {}).get("pageProps", {})

        # Try common patterns for job data in Next.js apps
        for key in ["jobs", "jobListings", "listings", "results", "data"]:
            items = props.get(key)
            if isinstance(items, list):
                jobs.extend(items)
                break

        # Try nested Apollo state (__APOLLO_STATE__ embedded in pageProps)
        apollo_state = props.get("apolloState") or props.get("__APOLLO_STATE__")
        if apollo_state and isinstance(apollo_state, dict):
            for key, value in apollo_state.items():
                if isinstance(value, dict) and value.get("__typename") in (
                    "JobListing", "StartupJobListing", "Job",
                ):
                    jobs.append(value)

        return jobs

    def _parse_apollo_state(self, html: str) -> list[dict]:
        """Extract job data from Apollo GraphQL state embedded in HTML."""
        jobs = []
        match = re.search(
            r'window\.__APOLLO_STATE__\s*=\s*({.*?});?\s*</script>',
            html,
            re.DOTALL,
        )
        if not match:
            return []

        try:
            state = json.loads(match.group(1))
        except json.JSONDecodeError:
            return []

        for key, value in state.items():
            if isinstance(value, dict) and value.get("__typename") in (
                "JobListing", "StartupJobListing", "Job",
            ):
                jobs.append(value)

        return jobs

    def _parse_jsonld(self, html: str) -> list[dict]:
        """Extract job data from JSON-LD structured data."""
        soup = BeautifulSoup(html, "html.parser")
        jobs = []

        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string)
            except (json.JSONDecodeError, TypeError):
                continue

            if isinstance(data, list):
                for item in data:
                    if item.get("@type") == "JobPosting":
                        jobs.append(item)
            elif data.get("@type") == "JobPosting":
                jobs.append(data)

        return jobs

    def _job_from_raw(self, item: dict) -> JobListing | None:
        """Convert a raw job dict (from any source) to a JobListing."""
        # Handle JSON-LD JobPosting format
        if item.get("@type") == "JobPosting":
            org = item.get("hiringOrganization", {})
            company = org.get("name", "") if isinstance(org, dict) else ""
            location_data = item.get("jobLocation", {})
            address = location_data.get("address", {}) if isinstance(location_data, dict) else {}
            location = address.get("addressLocality", "Remote") or "Remote"

            salary = item.get("baseSalary", {})
            salary_val = salary.get("value", {}) if isinstance(salary, dict) else {}
            salary_min = salary_val.get("minValue") if isinstance(salary_val, dict) else None
            salary_max = salary_val.get("maxValue") if isinstance(salary_val, dict) else None

            return JobListing(
                title=item.get("title", ""),
                company=company,
                location=location,
                description=item.get("description", ""),
                url=item.get("url", ""),
                source=self.source_name,
                salary_min=_parse_int(salary_min),
                salary_max=_parse_int(salary_max),
                posted_date=item.get("datePosted"),
            )

        # Handle Wellfound's internal data format (Apollo/Next.js)
        title = item.get("title") or item.get("name", "")
        if not title:
            return None

        company = ""
        startup = item.get("startup") or item.get("company")
        if isinstance(startup, dict):
            company = startup.get("name", "")
        elif isinstance(startup, str):
            company = startup

        location = item.get("location") or item.get("remote", "Remote") or "Remote"
        if isinstance(location, dict):
            location = location.get("name", "Remote")

        slug = item.get("slug", "")
        job_id = item.get("id", "")
        url = item.get("url", "")
        if not url and slug:
            url = f"{BASE_URL}/jobs/{slug}"
        elif not url and job_id:
            url = f"{BASE_URL}/jobs/{job_id}"

        salary_min = item.get("salaryMin") or item.get("salary_min")
        salary_max = item.get("salaryMax") or item.get("salary_max")

        tags = item.get("tags", [])
        if isinstance(tags, list) and tags and isinstance(tags[0], dict):
            tags = [t.get("name", "") for t in tags if t.get("name")]

        return JobListing(
            title=title,
            company=company,
            location=location,
            description=item.get("description", ""),
            url=url,
            source=self.source_name,
            salary_min=_parse_int(salary_min),
            salary_max=_parse_int(salary_max),
            posted_date=item.get("postedAt") or item.get("posted_at"),
            tags=tags if isinstance(tags, list) else [],
        )

    async def scrape(self) -> list[JobListing]:
        paths = self._get_role_paths()
        jobs = []
        seen_urls = set()

        async with self.get_client() as client:
            for path in paths:
                url = f"{BASE_URL}{path}"
                try:
                    resp = await self.rate_limited_get(
                        client, url, headers=BROWSER_HEADERS,
                    )
                    resp.raise_for_status()
                except httpx.HTTPStatusError as e:
                    status = e.response.status_code
                    if status in (403, 429):
                        logger.warning(f"Wellfound blocked ({status}) for {path}")
                    else:
                        logger.error(f"Wellfound HTTP {status} for {path}")
                    continue
                except (httpx.TimeoutException, httpx.ConnectError) as e:
                    logger.error(f"Wellfound fetch failed for {path}: {e}")
                    continue

                html = resp.text

                # Try multiple extraction strategies
                raw_jobs = self._parse_next_data(html)
                if not raw_jobs:
                    raw_jobs = self._parse_apollo_state(html)
                if not raw_jobs:
                    raw_jobs = self._parse_jsonld(html)

                logger.info(f"Wellfound: {path} returned {len(raw_jobs)} jobs")

                for item in raw_jobs:
                    job = self._job_from_raw(item)
                    if not job or not job.title:
                        continue

                    if job.url in seen_urls:
                        continue
                    seen_urls.add(job.url)

                    if self.search_terms:
                        searchable = f"{job.title} {job.description} {' '.join(job.tags)}".lower()
                        if not self._matches_search_terms(searchable):
                            continue

                    jobs.append(job)

        logger.info(f"Wellfound scraper found {len(jobs)} jobs")
        return jobs


def _parse_int(value) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None
