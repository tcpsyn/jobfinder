import logging
import os

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

API_URL = "https://data.usajobs.gov/api/search"


class USAJobsScraper(BaseScraper):
    source_name = "usajobs"

    async def scrape(self) -> list[JobListing]:
        api_key = os.environ.get("USAJOBS_API_KEY", "")
        email = os.environ.get("USAJOBS_EMAIL", "")

        if not api_key:
            logger.warning("USAJOBS_API_KEY not set, skipping USAJobs scraper")
            return []

        headers = {
            "Authorization-Key": api_key,
            "User-Agent": email,
            "Host": "data.usajobs.gov",
        }

        keyword = "information technology"
        if self.search_terms:
            keyword = " ".join(self.search_terms[:3])

        params = {
            "Keyword": keyword,
            "JobCategoryCode": "2210",
            "RemoteIndicator": "True",
            "ResultsPerPage": 50,
        }

        try:
            async with self.get_client() as client:
                resp = await client.get(API_URL, headers=headers, params=params)
                resp.raise_for_status()
                data = resp.json()
        except Exception as e:
            logger.error(f"USAJobs scrape failed: {e}")
            return []

        jobs = []
        results = data.get("SearchResult", {}).get("SearchResultItems", [])
        for item in results:
            match = item.get("MatchedObjectDescriptor", {})
            position = match.get("PositionTitle", "")
            org = match.get("OrganizationName", "")
            desc = match.get("UserArea", {}).get("Details", {}).get("MajorDuties", [""])[0] if match.get("UserArea") else ""
            url = match.get("PositionURI", "")
            location_list = match.get("PositionLocation", [])
            location = location_list[0].get("LocationName", "Remote") if location_list else "Remote"

            salary_min = None
            salary_max = None
            remuneration = match.get("PositionRemuneration", [])
            if remuneration:
                salary_min = int(float(remuneration[0].get("MinimumRange", 0)))
                salary_max = int(float(remuneration[0].get("MaximumRange", 0)))

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

        return jobs
