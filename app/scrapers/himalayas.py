import logging

import httpx

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

API_URL = "https://himalayas.app/jobs/api"
MAX_PAGES = 10
PAGE_SIZE = 50
MIN_WORD_MATCHES = 2


class HimalayasScraper(BaseScraper):
    source_name = "himalayas"

    def _matches_search(self, searchable: str) -> bool:
        """Check if searchable text matches any search term.

        For each search term, split into individual words and require at least
        MIN_WORD_MATCHES words (or all words if the term has fewer) to appear.
        """
        for term in self.search_terms:
            words = term.lower().split()
            threshold = min(len(words), MIN_WORD_MATCHES)
            matched = sum(1 for w in words if w in searchable)
            if matched >= threshold:
                return True
        return False

    async def scrape(self) -> list[JobListing]:
        jobs = []
        async with self.get_client() as client:
            for page in range(MAX_PAGES):
                try:
                    resp = await self.rate_limited_get(
                        client, API_URL, params={"limit": PAGE_SIZE, "offset": page * PAGE_SIZE}
                    )
                    resp.raise_for_status()
                    data = resp.json()
                except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as e:
                    logger.error(f"Himalayas scrape failed page {page}: {e}")
                    break

                listings = data.get("jobs", [])
                if not listings:
                    break

                for item in listings:
                    title = item.get("title", "")
                    description = item.get("description", "")
                    categories = item.get("categories", [])
                    searchable = f"{title} {description} {' '.join(categories)}".lower()

                    if self.search_terms and not self._matches_search(searchable):
                        continue

                    location_restrictions = item.get("locationRestrictions", [])
                    location = ", ".join(location_restrictions) if location_restrictions else "Remote"

                    jobs.append(
                        JobListing(
                            title=title,
                            company=item.get("companyName", ""),
                            location=location,
                            description=description,
                            url=item.get("applicationLink", ""),
                            source=self.source_name,
                            salary_min=item.get("minSalary"),
                            salary_max=item.get("maxSalary"),
                            posted_date=item.get("pubDate", None),
                            tags=categories,
                        )
                    )
        return jobs
