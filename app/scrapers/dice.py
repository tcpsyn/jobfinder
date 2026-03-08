import logging
import os
import random
import asyncio
from urllib.parse import quote_plus

from bs4 import BeautifulSoup

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

DEFAULT_QUERY = 'site:dice.com/job-detail "devops" OR "SRE" OR "infrastructure" OR "platform engineer" remote'


class DiceScraper(BaseScraper):
    source_name = "dice"

    def _build_query(self) -> str:
        if not self.search_terms:
            return DEFAULT_QUERY
        quoted = [f'"{t}"' for t in self.search_terms[:5]]
        return f'site:dice.com/job-detail {" OR ".join(quoted)} remote'

    async def scrape(self) -> list[JobListing]:
        is_test = os.environ.get("TESTING", "")
        encoded = quote_plus(self._build_query())
        url = f"https://www.google.com/search?q={encoded}&num=20"

        try:
            async with self.get_client() as client:
                resp = await client.get(url)
                resp.raise_for_status()
                html = resp.text
        except Exception as e:
            logger.error(f"Dice/Google scrape failed: {e}")
            return []

        soup = BeautifulSoup(html, "html.parser")
        jobs = []

        for result in soup.select("div.g"):
            link_el = result.select_one("a[href]")
            if not link_el:
                continue

            href = link_el.get("href", "")
            if "dice.com/job-detail" not in href:
                continue

            title_el = result.select_one("h3")
            title = title_el.get_text(strip=True) if title_el else ""

            snippet_el = result.select_one("div.VwiC3b")
            snippet = snippet_el.get_text(strip=True) if snippet_el else ""

            jobs.append(
                JobListing(
                    title=title,
                    company="",
                    location="Remote",
                    description=snippet,
                    url=href,
                    source=self.source_name,
                )
            )

        if not is_test and jobs:
            delay = random.uniform(30, 90)
            logger.info(f"Dice scraper sleeping {delay:.0f}s to avoid rate limiting")
            await asyncio.sleep(delay)

        return jobs
