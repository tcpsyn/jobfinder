import logging
import os

import httpx

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

API_URL = "https://data.usajobs.gov/api/search"


class USAJobsScraper(BaseScraper):
    source_name = "usajobs"

    async def scrape(self) -> list[JobListing]:
        keys = self.scraper_keys.get("usajobs", {})
        api_key = keys.get("api_key", "") or os.environ.get("USAJOBS_API_KEY", "")
        email = keys.get("email", "") or os.environ.get("USAJOBS_EMAIL", "")

        if not api_key:
            logger.warning("USAJOBS API key not configured, skipping")
            return []

        headers = {
            "Authorization-Key": api_key,
            "User-Agent": email,
            "Host": "data.usajobs.gov",
        }

        keywords = list(self.search_terms[:10]) if self.search_terms else ["information technology"]

        seen_urls: set[str] = set()
        jobs: list[JobListing] = []

        try:
            async with self.get_client() as client:
                for keyword in keywords:
                    params = {
                        "Keyword": keyword,
                        "JobCategoryCode": "2210",
                        "RemoteIndicator": "True",
                        "ResultsPerPage": 50,
                    }
                    resp = await self.rate_limited_get(client, API_URL, headers=headers, params=params)
                    resp.raise_for_status()
                    data = resp.json()

                    results = data.get("SearchResult", {}).get("SearchResultItems", [])
                    for item in results:
                        match = item.get("MatchedObjectDescriptor", {})
                        url = match.get("PositionURI", "")
                        if url in seen_urls:
                            continue
                        seen_urls.add(url)

                        position = match.get("PositionTitle", "")
                        org = match.get("OrganizationName", "")
                        desc = match.get("UserArea", {}).get("Details", {}).get("MajorDuties", [""])[0] if match.get("UserArea") else ""
                        location_list = match.get("PositionLocation", [])
                        location = location_list[0].get("LocationName", "Remote") if location_list else "Remote"

                        salary_min = None
                        salary_max = None
                        remuneration = match.get("PositionRemuneration", [])
                        if remuneration:
                            try:
                                salary_min = int(float(remuneration[0].get("MinimumRange", 0)))
                                salary_max = int(float(remuneration[0].get("MaximumRange", 0)))
                            except (ValueError, TypeError, IndexError):
                                pass

                        posted_date = match.get("PublicationStartDate", None)

                        jobs.append(
                            JobListing(
                                title=position,
                                company=org,
                                location=location,
                                description=desc,
                                url=url,
                                source=self.source_name,
                                salary_min=salary_min if salary_min else None,
                                salary_max=salary_max if salary_max else None,
                                posted_date=posted_date,
                            )
                        )
        except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as e:
            logger.error(f"USAJobs scrape failed: {e}")
            return []

        return jobs
