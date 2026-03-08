import logging

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

API_URL = "https://remotive.com/api/remote-jobs"
DEFAULT_CATEGORIES = ["devops", "software-dev"]
VALID_CATEGORIES = [
    "software-dev", "devops", "data", "product", "design",
    "customer-support", "marketing", "sales", "qa",
]


class RemotiveScraper(BaseScraper):
    source_name = "remotive"

    def _get_categories(self) -> list[str]:
        if not self.search_terms:
            return DEFAULT_CATEGORIES
        matched = [c for c in VALID_CATEGORIES if any(t.lower() in c for t in self.search_terms)]
        return matched if matched else DEFAULT_CATEGORIES

    async def scrape(self) -> list[JobListing]:
        categories = self._get_categories()
        jobs = []
        async with self.get_client() as client:
            for category in categories:
                try:
                    resp = await client.get(API_URL, params={"category": category, "limit": 50})
                    resp.raise_for_status()
                    data = resp.json()
                except Exception as e:
                    logger.error(f"Remotive scrape failed for {category}: {e}")
                    continue

                for item in data.get("jobs", []):
                    jobs.append(
                        JobListing(
                            title=item.get("title", ""),
                            company=item.get("company_name", ""),
                            location=item.get("candidate_required_location", "Remote"),
                            description=item.get("description", ""),
                            url=item.get("url", ""),
                            source=self.source_name,
                            salary_min=item.get("salary_min"),
                            salary_max=item.get("salary_max"),
                            posted_date=item.get("publication_date", None),
                            tags=item.get("tags", []),
                        )
                    )
        return jobs
