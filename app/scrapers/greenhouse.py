import logging

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)

API_BASE = "https://boards-api.greenhouse.io/v1/boards"
MIN_WORD_MATCHES = 3
MAX_DETAIL_FETCHES = 30

DEFAULT_COMPANIES = [
    "cloudflare",
    "datadog",
    "gitlab",
    "twilio",
    "airbnb",
    "hashicorp",
    "confluent",
    "elastic",
    "grafanalabs",
    "snyk",
    "cockroachlabs",
    "temporaltechnologies",
    "pulumi",
    "tailscale",
    "flyio",
    "render",
    "planetscale",
    "neon",
    "supabase",
    "vercel",
    "netlify",
    "dopplerhq",
    "teleaborttechnologies",
    "strongdm",
    "lacework",
    "orcasecurity",
    "wizinc",
    "aiven",
    "circleci",
    "launchdarkly",
    "prismaticio",
    "relativityspace",
    "chainguard",
    "reddoorsinteractive",
    "coreweave",
    "benchling",
    "gusto",
    "plaid",
    "figma",
    "notion",
    "airtable",
    "databricks",
    "dbt",
    "fivetran",
    "materialize",
    "stytch",
]


class GreenhouseScraper(BaseScraper):
    source_name = "greenhouse"

    def _get_companies(self) -> list[str]:
        custom = self.scraper_keys.get("greenhouse_companies")
        if custom:
            if isinstance(custom, str):
                return [c.strip() for c in custom.split(",") if c.strip()]
            return list(custom)
        return DEFAULT_COMPANIES

    def _matches_search(self, title: str, searchable: str) -> bool:
        for term in self.search_terms:
            words = term.lower().split()
            if len(words) <= 1:
                # Single-word terms must match in the title, not just the description
                if words and words[0] in title.lower():
                    return True
            else:
                threshold = min(len(words), MIN_WORD_MATCHES)
                matched = sum(1 for w in words if w in searchable)
                if matched >= threshold:
                    return True
        return False

    async def scrape(self) -> list[JobListing]:
        jobs: list[JobListing] = []
        seen_urls: set[str] = set()
        companies = self._get_companies()

        async with self.get_client() as client:
            for company in companies:
                url = f"{API_BASE}/{company}/jobs"
                try:
                    resp = await self.rate_limited_get(client, url, params={"content": "true"})
                    if resp.status_code == 404:
                        logger.debug(f"Greenhouse: company '{company}' not found (404)")
                        continue
                    resp.raise_for_status()
                    data = resp.json()
                except Exception as e:
                    logger.error(f"Greenhouse scrape failed for {company}: {e}")
                    continue

                for item in data.get("jobs", []):
                    title = item.get("title", "")
                    content = item.get("content", "")
                    location_name = item.get("location", {}).get("name", "") if isinstance(item.get("location"), dict) else ""

                    job_url = item.get("absolute_url", "")
                    if not job_url:
                        job_id = item.get("id")
                        if job_id:
                            job_url = f"https://boards.greenhouse.io/{company}/jobs/{job_id}"
                        else:
                            continue

                    if job_url in seen_urls:
                        continue
                    seen_urls.add(job_url)

                    searchable = f"{title} {content} {location_name}".lower()
                    if self.search_terms and not self._matches_search(title, searchable):
                        continue

                    metadata = item.get("metadata", [])
                    salary_min = None
                    salary_max = None
                    tags = []
                    for meta in metadata if isinstance(metadata, list) else []:
                        name = (meta.get("name") or "").lower()
                        value = meta.get("value")
                        if "salary" in name and "min" in name:
                            salary_min = _parse_int(value)
                        elif "salary" in name and "max" in name:
                            salary_max = _parse_int(value)
                        elif "department" in name or "team" in name:
                            if value:
                                tags.append(str(value))

                    departments = item.get("departments", [])
                    for dept in departments if isinstance(departments, list) else []:
                        dept_name = dept.get("name", "") if isinstance(dept, dict) else ""
                        if dept_name and dept_name not in tags:
                            tags.append(dept_name)

                    posted_date = None
                    updated_at = item.get("updated_at", "")
                    if updated_at:
                        posted_date = updated_at[:10]

                    company_name = item.get("company", {}).get("name", company) if isinstance(item.get("company"), dict) else company

                    jobs.append(
                        JobListing(
                            title=title,
                            company=company_name,
                            location=location_name or "Remote",
                            description=content,
                            url=job_url,
                            source=self.source_name,
                            salary_min=salary_min,
                            salary_max=salary_max,
                            posted_date=posted_date,
                            tags=tags,
                        )
                    )

        logger.info(f"Greenhouse scraper found {len(jobs)} jobs")
        return jobs


def _parse_int(value) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None
