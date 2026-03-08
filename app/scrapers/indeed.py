import logging
from urllib.parse import quote_plus

import feedparser

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

DEFAULT_KEYWORDS = [
    "devops engineer remote",
    "SRE remote",
    "infrastructure engineer remote",
    "AI engineer remote",
    "platform engineer remote",
]


class IndeedScraper(BaseScraper):
    source_name = "indeed"

    async def scrape(self) -> list[JobListing]:
        keywords = self.search_terms if self.search_terms else DEFAULT_KEYWORDS
        jobs = []
        async with self.get_client() as client:
            for keyword in keywords:
                url = f"https://www.indeed.com/rss?q={quote_plus(keyword)}&l=remote&sort=date"
                try:
                    resp = await client.get(url)
                    resp.raise_for_status()
                except Exception as e:
                    logger.error(f"Indeed scrape failed for '{keyword}': {e}")
                    continue

                feed = feedparser.parse(resp.text)
                for entry in feed.entries:
                    jobs.append(
                        JobListing(
                            title=entry.get("title", ""),
                            company=entry.get("author", entry.get("source", {}).get("title", "")),
                            location="Remote",
                            description=entry.get("summary", ""),
                            url=entry.get("link", ""),
                            source=self.source_name,
                            posted_date=entry.get("published", None),
                        )
                    )
        return jobs
