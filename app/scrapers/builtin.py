import json
import logging
import re
from urllib.parse import quote_plus

from bs4 import BeautifulSoup

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

BASE_URL = "https://builtin.com"
LISTING_PATHS = {
    "dev-engineering": "/jobs/remote/dev-engineering",
    "data-analytics": "/jobs/remote/data-analytics",
    "product": "/jobs/remote/product",
    "design-ux": "/jobs/remote/design-ux",
}
DEFAULT_CATEGORIES = ["dev-engineering"]
MAX_DETAIL_FETCHES = 25


class BuiltInScraper(BaseScraper):
    source_name = "builtin"

    def _get_listing_paths(self) -> list[str]:
        if not self.search_terms:
            return [LISTING_PATHS[c] for c in DEFAULT_CATEGORIES]

        matched = []
        for term in self.search_terms:
            term_lower = term.lower()
            for key, path in LISTING_PATHS.items():
                if any(kw in term_lower for kw in key.split("-")):
                    if path not in matched:
                        matched.append(path)

        if not matched:
            # Use search URL with query
            return [f"/jobs?search={quote_plus(term)}&remote=true" for term in self.search_terms[:3]]

        return matched

    def _parse_listing_jsonld(self, html: str) -> list[dict]:
        """Extract job stubs from JSON-LD ItemList on listing pages."""
        soup = BeautifulSoup(html, "html.parser")
        items = []

        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string)
            except (json.JSONDecodeError, TypeError):
                continue

            graph = data.get("@graph", [data])
            for node in graph:
                if node.get("@type") == "ItemList":
                    for item in node.get("itemListElement", []):
                        if item.get("url") and item.get("name"):
                            items.append({
                                "title": item["name"],
                                "url": item["url"],
                                "description": item.get("description", ""),
                            })
        return items

    def _parse_detail_jsonld(self, html: str) -> dict | None:
        """Extract full job data from JobPosting JSON-LD on detail pages."""
        soup = BeautifulSoup(html, "html.parser")

        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string)
            except (json.JSONDecodeError, TypeError):
                continue

            if data.get("@type") == "JobPosting":
                return data

        return None

    def _extract_job_from_detail(self, data: dict, url: str) -> JobListing:
        """Convert a JobPosting JSON-LD object to a JobListing."""
        salary_info = data.get("baseSalary", {})
        salary_value = salary_info.get("value", {})
        salary_min = salary_value.get("minValue")
        salary_max = salary_value.get("maxValue")

        org = data.get("hiringOrganization", {})
        company = org.get("name", "") if isinstance(org, dict) else ""

        location_data = data.get("jobLocation", {})
        address = location_data.get("address", {}) if isinstance(location_data, dict) else {}
        location_parts = []
        if address.get("addressLocality"):
            location_parts.append(address["addressLocality"])
        if address.get("addressRegion"):
            location_parts.append(address["addressRegion"])
        location = ", ".join(location_parts) or "Remote"

        if data.get("jobLocationType") == "TELECOMMUTE":
            if location != "Remote":
                location = f"Remote - {location}"
            else:
                location = "Remote"

        tags = []
        industry = data.get("industry", [])
        if isinstance(industry, list):
            tags.extend(industry)
        elif isinstance(industry, str):
            tags.append(industry)

        return JobListing(
            title=data.get("title", ""),
            company=company,
            location=location,
            description=data.get("description", ""),
            url=url,
            source=self.source_name,
            salary_min=_parse_int(salary_min),
            salary_max=_parse_int(salary_max),
            posted_date=data.get("datePosted"),
            tags=tags,
        )

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

    async def scrape(self) -> list[JobListing]:
        paths = self._get_listing_paths()
        jobs = []
        stubs = []

        async with self.get_client() as client:
            # Phase 1: Fetch listing pages for job stubs
            for path in paths:
                url = f"{BASE_URL}{path}" if path.startswith("/") else path
                try:
                    resp = await client.get(url)
                    resp.raise_for_status()
                except Exception as e:
                    logger.error(f"BuiltIn listing fetch failed for {path}: {e}")
                    continue

                page_stubs = self._parse_listing_jsonld(resp.text)
                logger.info(f"BuiltIn: {path} returned {len(page_stubs)} job stubs")
                stubs.extend(page_stubs)

            if not stubs:
                return jobs

            # Phase 2: Fetch detail pages for full job data
            seen_urls = set()
            for stub in stubs[:MAX_DETAIL_FETCHES]:
                detail_url = stub["url"]
                if detail_url in seen_urls:
                    continue
                seen_urls.add(detail_url)

                try:
                    resp = await client.get(detail_url)
                    resp.raise_for_status()
                except Exception as e:
                    logger.debug(f"BuiltIn detail fetch failed for {detail_url}: {e}")
                    # Fall back to stub data
                    jobs.append(
                        JobListing(
                            title=stub["title"],
                            company="",
                            location="Remote",
                            description=stub.get("description", ""),
                            url=detail_url,
                            source=self.source_name,
                        )
                    )
                    continue

                detail_data = self._parse_detail_jsonld(resp.text)
                if detail_data:
                    job = self._extract_job_from_detail(detail_data, detail_url)
                    if self.search_terms:
                        searchable = f"{job.title} {job.description} {job.company} {' '.join(job.tags)}".lower()
                        if not self._matches_search_terms(searchable):
                            continue
                    jobs.append(job)
                else:
                    # Fall back to stub data
                    jobs.append(
                        JobListing(
                            title=stub["title"],
                            company="",
                            location="Remote",
                            description=stub.get("description", ""),
                            url=detail_url,
                            source=self.source_name,
                        )
                    )

        logger.info(f"BuiltIn scraper found {len(jobs)} jobs")
        return jobs


def _parse_int(value) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None
