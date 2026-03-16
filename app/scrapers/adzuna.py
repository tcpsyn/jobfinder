import logging

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

API_URL = "https://api.adzuna.com/v1/api/jobs/us/search/{page}"
MAX_PAGES = 3
PAGE_SIZE = 50
MAX_TERMS = 5
MIN_WORD_MATCHES = 2


class AdzunaScraper(BaseScraper):
    source_name = "adzuna"

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
        keys = self.scraper_keys.get("adzuna", {})
        app_id = keys.get("app_id", "")
        app_key = keys.get("app_key", "")

        if not app_id or not app_key:
            logger.warning("Adzuna API keys not configured, skipping")
            return []

        terms = list(self.search_terms[:MAX_TERMS]) if self.search_terms else ["software engineer"]
        seen_urls: set[str] = set()
        jobs: list[JobListing] = []

        try:
            async with self.get_client() as client:
                for term in terms:
                    for page in range(1, MAX_PAGES + 1):
                        url = API_URL.format(page=page)
                        params = {
                            "app_id": app_id,
                            "app_key": app_key,
                            "what": term,
                            "results_per_page": PAGE_SIZE,
                            "content-type": "application/json",
                        }
                        try:
                            resp = await self.rate_limited_get(client, url, params=params)
                            resp.raise_for_status()
                            data = resp.json()
                        except Exception as e:
                            logger.error(f"Adzuna scrape failed for '{term}' page {page}: {e}")
                            break

                        results = data.get("results", [])
                        if not results:
                            break

                        for item in results:
                            job_url = item.get("redirect_url", "")
                            if not job_url or job_url in seen_urls:
                                continue
                            seen_urls.add(job_url)

                            title = item.get("title", "")
                            description = item.get("description", "")
                            company = item.get("company", {}).get("display_name", "")
                            location = item.get("location", {}).get("display_name", "")
                            category = item.get("category", {}).get("label", "")

                            searchable = f"{title} {description} {company} {category}".lower()
                            if self.search_terms and not self._matches_search(searchable):
                                continue

                            salary_min = None
                            salary_max = None
                            if item.get("salary_min"):
                                salary_min = int(item["salary_min"])
                            if item.get("salary_max"):
                                salary_max = int(item["salary_max"])

                            tags = [category] if category else []

                            jobs.append(
                                JobListing(
                                    title=title,
                                    company=company,
                                    location=location,
                                    description=description,
                                    url=job_url,
                                    source=self.source_name,
                                    salary_min=salary_min,
                                    salary_max=salary_max,
                                    posted_date=item.get("created"),
                                    tags=tags,
                                )
                            )

                        if len(results) < PAGE_SIZE:
                            break
        except Exception as e:
            logger.error(f"Adzuna scrape failed: {e}")
            return []

        return jobs
