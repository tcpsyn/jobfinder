import logging

import httpx

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

API_URL = "https://jobicy.com/api/v2/remote-jobs"

TAG_MAP = {
    "devops": "devops",
    "python": "python",
    "linux": "linux",
    "kubernetes": "kubernetes",
    "docker": "docker",
    "aws": "aws",
    "cloud": "cloud",
    "terraform": "terraform",
    "ansible": "ansible",
    "sre": "sre",
    "infrastructure": "infrastructure",
    "backend": "backend",
    "golang": "golang",
    "rust": "rust",
    "java": "java",
    "react": "react",
    "node": "nodejs",
    "typescript": "typescript",
    "engineer": "engineer",
    "security": "security",
    "data": "data",
    "ai": "ai",
    "machine learning": "machine-learning",
}

DEFAULT_TAGS = ["devops", "python", "linux", "cloud", "engineer"]


class JobicyScraper(BaseScraper):
    source_name = "jobicy"

    def _get_tags(self) -> list[str]:
        if not self.search_terms:
            return DEFAULT_TAGS
        tags = []
        for term in self.search_terms:
            for keyword, tag in TAG_MAP.items():
                if keyword in term.lower():
                    tags.append(tag)
        return list(set(tags)) if tags else DEFAULT_TAGS

    async def scrape(self) -> list[JobListing]:
        tags = self._get_tags()
        jobs = []
        seen_ids = set()
        async with self.get_client() as client:
            for tag in tags:
                try:
                    resp = await self.rate_limited_get(client, API_URL, params={"count": 50, "tag": tag})
                    resp.raise_for_status()
                    data = resp.json()
                except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as e:
                    logger.error(f"Jobicy scrape failed for tag '{tag}': {e}")
                    continue

                for item in data.get("jobs", []):
                    job_id = item.get("id")
                    if job_id in seen_ids:
                        continue
                    seen_ids.add(job_id)

                    jobs.append(
                        JobListing(
                            title=item.get("jobTitle", ""),
                            company=item.get("companyName", ""),
                            location=item.get("jobGeo", "Remote"),
                            description=item.get("jobDescription", ""),
                            url=item.get("url", ""),
                            source=self.source_name,
                            salary_min=item.get("salaryMin") or item.get("annualSalaryMin"),
                            salary_max=item.get("salaryMax") or item.get("annualSalaryMax"),
                            posted_date=item.get("pubDate"),
                        )
                    )
        return jobs
