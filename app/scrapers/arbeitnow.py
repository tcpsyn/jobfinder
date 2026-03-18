import logging

import httpx

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

API_URL = "https://www.arbeitnow.com/api/job-board-api"


class ArbeitnowScraper(BaseScraper):
    source_name = "arbeitnow"

    async def scrape(self) -> list[JobListing]:
        jobs = []
        async with self.get_client() as client:
            for page in range(1, 4):
                try:
                    resp = await self.rate_limited_get(client, API_URL, params={"page": page})
                    resp.raise_for_status()
                    data = resp.json()
                except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as e:
                    logger.error(f"Arbeitnow scrape failed page {page}: {e}")
                    break

                listings = data.get("data", [])
                if not listings:
                    break

                for item in listings:
                    title = item.get("title", "")
                    description = item.get("description", "")
                    tags = item.get("tags", [])
                    searchable = f"{title} {description} {' '.join(tags)}".lower()

                    if self.search_terms and not any(
                        term.lower() in searchable for term in self.search_terms
                    ):
                        continue

                    jobs.append(
                        JobListing(
                            title=title,
                            company=item.get("company_name", ""),
                            location=item.get("location", "Remote") if item.get("location") else "Remote",
                            description=description,
                            url=item.get("url", ""),
                            source=self.source_name,
                            posted_date=None,
                            tags=tags,
                        )
                    )
        return jobs
