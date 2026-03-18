import logging

import feedparser
import httpx

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

FEED_URLS = [
    "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
    "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
]


class WeWorkRemotelyScraper(BaseScraper):
    source_name = "weworkremotely"

    async def scrape(self) -> list[JobListing]:
        jobs = []
        async with self.get_client() as client:
            for feed_url in FEED_URLS:
                try:
                    resp = await self.rate_limited_get(client, feed_url)
                    resp.raise_for_status()
                except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as e:
                    logger.error(f"WWR scrape failed for {feed_url}: {e}")
                    continue

                feed = feedparser.parse(resp.content)
                for entry in feed.entries:
                    title = entry.get("title", "")
                    # WWR titles often have "Company: Title" format
                    company = ""
                    if ": " in title:
                        company, title = title.split(": ", 1)

                    jobs.append(
                        JobListing(
                            title=title,
                            company=company,
                            location="Remote",
                            description=entry.get("summary", ""),
                            url=entry.get("link", ""),
                            source=self.source_name,
                            posted_date=entry.get("published", None),
                        )
                    )
        return jobs
