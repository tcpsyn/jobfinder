import logging
import time

import httpx
from bs4 import BeautifulSoup

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

ALGOLIA_SEARCH_URL = "https://hn.algolia.com/api/v1/search"
HN_ITEM_URL = "https://hacker-news.firebaseio.com/v0/item/{id}.json"


class HackerNewsScraper(BaseScraper):
    source_name = "hackernews"

    async def scrape(self) -> list[JobListing]:
        one_month_ago = int(time.time()) - 60 * 60 * 24 * 35

        async with self.get_client() as client:
            try:
                resp = await self.rate_limited_get(
                    client, ALGOLIA_SEARCH_URL,
                    params={
                        "query": "who is hiring",
                        "tags": "story,ask_hn",
                        "numericFilters": f"created_at_i>{one_month_ago}",
                    },
                )
                resp.raise_for_status()
                search_data = resp.json()
            except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as e:
                logger.error(f"HN search failed: {e}")
                return []

            hits = search_data.get("hits", [])
            if not hits:
                return []

            thread_id = hits[0]["objectID"]

            try:
                resp = await self.rate_limited_get(client, HN_ITEM_URL.format(id=thread_id))
                resp.raise_for_status()
                thread_data = resp.json()
            except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as e:
                logger.error(f"HN thread fetch failed: {e}")
                return []

            kids = thread_data.get("kids", [])
            jobs = []

            for kid_id in kids[:100]:  # limit to first 100 comments
                try:
                    resp = await self.rate_limited_get(client, HN_ITEM_URL.format(id=kid_id))
                    resp.raise_for_status()
                    comment = resp.json()
                except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as e:
                    logger.warning(f"HN comment {kid_id} fetch failed: {e}")
                    continue

                if not comment or comment.get("deleted") or not comment.get("text"):
                    continue

                text = comment["text"]
                soup = BeautifulSoup(text, "html.parser")
                plain_text = soup.get_text(separator="\n")
                lines = [l.strip() for l in plain_text.split("\n") if l.strip()]

                if not lines:
                    continue

                first_line = lines[0]
                # HN hiring posts typically start with "Company | Role | Location | ..."
                parts = [p.strip() for p in first_line.split("|")]
                company = parts[0] if len(parts) > 0 else ""
                title = parts[1] if len(parts) > 1 else first_line
                location = parts[2] if len(parts) > 2 else ""

                jobs.append(
                    JobListing(
                        title=title,
                        company=company,
                        location=location,
                        description=plain_text[:2000],
                        url=f"https://news.ycombinator.com/item?id={kid_id}",
                        source=self.source_name,
                        posted_date=None,
                    )
                )

        return jobs
