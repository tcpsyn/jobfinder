import logging

import httpx

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

API_URL = "https://remoteok.com/api"


class RemoteOKScraper(BaseScraper):
    source_name = "remoteok"

    async def scrape(self) -> list[JobListing]:
        jobs = []
        async with self.get_client() as client:
            try:
                resp = await self.rate_limited_get(client, API_URL)
                resp.raise_for_status()
                data = resp.json()
            except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as e:
                logger.error(f"RemoteOK scrape failed: {e}")
                return jobs

            # First element is a metadata/legal notice object, skip it
            listings = data[1:] if isinstance(data, list) and len(data) > 1 else []

            for item in listings:
                title = item.get("position", "")
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
                        company=item.get("company", ""),
                        location=item.get("location", "Remote") or "Remote",
                        description=description,
                        url=item.get("apply_url") or item.get("url", ""),
                        source=self.source_name,
                        salary_min=_parse_salary(item.get("salary_min")),
                        salary_max=_parse_salary(item.get("salary_max")),
                        posted_date=item.get("date", None),
                        tags=tags,
                    )
                )
        return jobs


def _parse_salary(value) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None
