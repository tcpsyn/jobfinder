from dataclasses import dataclass, field
from typing import Optional

import httpx


@dataclass
class JobListing:
    title: str
    company: str
    location: str
    description: str
    url: str
    source: str
    salary_min: Optional[int] = None
    salary_max: Optional[int] = None
    posted_date: Optional[str] = None
    application_method: str = "url"
    contact_email: Optional[str] = None
    tags: list[str] = field(default_factory=list)


class BaseScraper:
    source_name: str = "base"

    def __init__(self, search_terms: list[str] | None = None):
        self.search_terms = search_terms or []

    def get_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            },
            timeout=30.0,
            follow_redirects=True,
        )

    async def scrape(self) -> list[JobListing]:
        raise NotImplementedError
