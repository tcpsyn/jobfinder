import logging
import re
from urllib.parse import urlencode

from bs4 import BeautifulSoup

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)


class LinkedInScraper(BaseScraper):
    source_name = "linkedin"

    BASE_URL = "https://www.linkedin.com/jobs/search"

    # f_TPR values: r86400 = past 24h, r604800 = past week, r2592000 = past month
    TIME_FILTER = "r604800"  # Past week

    def _build_params(self, query: str, start: int = 0) -> dict:
        return {
            "keywords": query,
            "location": "United States",
            "f_TPR": self.TIME_FILTER,
            "position": "1",
            "pageNum": str(start // 25),
            "start": str(start),
        }

    def _clean_url(self, url: str) -> str:
        """Strip tracking params from LinkedIn job URLs."""
        if not url:
            return ""
        # Keep everything up to the job ID, strip tracking params
        match = re.match(r"(https://www\.linkedin\.com/jobs/view/[^?]+)", url)
        return match.group(1) if match else url

    def _parse_date(self, time_el) -> str | None:
        """Extract ISO date from <time> element's datetime attribute."""
        if not time_el:
            return None
        dt = time_el.get("datetime")
        if dt:
            return dt
        return None

    async def _fetch_page(self, client, query: str, start: int) -> list[JobListing]:
        """Fetch and parse one page of LinkedIn job results."""
        params = self._build_params(query, start)
        url = f"{self.BASE_URL}?{urlencode(params)}"

        try:
            resp = await client.get(url)
            resp.raise_for_status()
        except Exception as e:
            logger.error(f"LinkedIn fetch failed for '{query}' start={start}: {e}")
            return []

        soup = BeautifulSoup(resp.content, "html.parser")
        cards = soup.select(".base-search-card")
        jobs = []

        for card in cards:
            try:
                title_el = card.select_one(".base-search-card__title")
                title = title_el.get_text(strip=True) if title_el else ""
                if not title:
                    continue

                company_el = card.select_one(".base-search-card__subtitle a")
                if not company_el:
                    company_el = card.select_one(".base-search-card__subtitle")
                company = company_el.get_text(strip=True) if company_el else ""

                location_el = card.select_one(".job-search-card__location")
                location = location_el.get_text(strip=True) if location_el else ""

                link_el = card.select_one("a.base-card__full-link")
                job_url = self._clean_url(link_el.get("href", "")) if link_el else ""
                if not job_url:
                    continue

                time_el = card.select_one("time")
                posted_date = self._parse_date(time_el)

                salary_el = card.select_one(".job-search-card__salary-info")
                salary_text = salary_el.get_text(strip=True) if salary_el else ""
                salary_min, salary_max = self._parse_salary(salary_text)

                # Extract benefits/metadata if present
                benefits_el = card.select_one(".result-benefits__text")
                tags = []
                if benefits_el:
                    tags.append(benefits_el.get_text(strip=True))

                jobs.append(
                    JobListing(
                        title=title,
                        company=company,
                        location=location,
                        description="",  # LinkedIn doesn't show description in search results
                        url=job_url,
                        source=self.source_name,
                        salary_min=salary_min,
                        salary_max=salary_max,
                        posted_date=posted_date,
                        tags=tags,
                    )
                )
            except Exception as e:
                logger.debug(f"LinkedIn card parse error: {e}")
                continue

        return jobs

    def _parse_salary(self, salary_text: str) -> tuple[int | None, int | None]:
        if not salary_text:
            return None, None
        numbers = re.findall(r"[\d,]+", salary_text)
        clean = []
        for n in numbers:
            val = int(n.replace(",", ""))
            if val >= 500:
                clean.append(val)
        if len(clean) >= 2:
            return clean[0], clean[1]
        elif len(clean) == 1:
            return clean[0], None
        return None, None

    async def scrape(self) -> list[JobListing]:
        queries = self.search_terms[:10] if self.search_terms else [
            "devops remote",
            "SRE remote",
            "platform engineer remote",
        ]
        all_jobs = []
        seen_urls = set()

        async with self.get_client() as client:
            for query in queries:
                for start in [0, 25]:  # 2 pages per query (25 results each)
                    jobs = await self._fetch_page(client, query, start)
                    logger.info(f"LinkedIn: '{query}' start={start} returned {len(jobs)} jobs")

                    for job in jobs:
                        clean = self._clean_url(job.url)
                        if clean in seen_urls:
                            continue
                        seen_urls.add(clean)
                        all_jobs.append(job)

        logger.info(f"LinkedIn scraper found {len(all_jobs)} unique jobs")
        return all_jobs
