import json
import logging
import re
from urllib.parse import quote_plus, urlencode

from app.scrapers.base import BaseScraper, JobListing

logger = logging.getLogger(__name__)


class DiceScraper(BaseScraper):
    source_name = "dice"

    BASE_URL = "https://www.dice.com/jobs"

    def _build_params(self, query: str, page: int = 1) -> dict:
        return {
            "q": query,
            "countryCode": "US",
            "radius": "30",
            "radiusUnit": "mi",
            "page": str(page),
            "pageSize": "20",
            "language": "en",
        }

    def _extract_jobs_from_html(self, html: str) -> list[dict]:
        """Extract job data from Next.js embedded JSON in Dice's HTML."""
        jobs = []
        try:
            # Dice uses Next.js streaming — job data is in self.__next_f.push() chunks
            chunks = []
            for m in re.finditer(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)', html, re.DOTALL):
                chunks.append(m.group(1))

            if not chunks:
                return []

            combined = "".join(chunks)
            combined = combined.encode().decode("unicode_escape")

            # Find the jobList data array
            idx = combined.find('"jobList":{"data":[')
            if idx < 0:
                return []

            arr_start = combined.find("[", idx)
            arr_end = combined.find('],"meta"', arr_start)
            if arr_end < 0:
                # Fallback: find the matching bracket
                arr_end = combined.find("]}", arr_start)
            if arr_end < 0:
                return []

            arr_str = combined[arr_start : arr_end + 1]
            jobs = json.loads(arr_str)
        except Exception as e:
            logger.warning(f"Dice JSON extraction failed: {e}")
            # Fallback: try extracting individual job objects
            try:
                for m in re.finditer(
                    r'\{"id":"[^"]+","guid":"[^"]+".*?"title":"[^"]+?".*?\}',
                    combined,
                ):
                    try:
                        jobs.append(json.loads(m.group()))
                    except json.JSONDecodeError:
                        continue
            except Exception:
                pass

        return jobs

    def _parse_salary(self, salary_str: str) -> tuple[int | None, int | None]:
        if not salary_str:
            return None, None
        # Remove extra $ signs and parse "$$60,000 - $65,000" or "$150,000"
        numbers = re.findall(r"[\d,]+", salary_str.replace(",", ""))
        if not numbers:
            numbers = re.findall(r"[\d,]+", salary_str)
        clean_numbers = []
        for n in numbers:
            n = n.replace(",", "")
            if n.isdigit():
                val = int(n)
                # Skip hourly rates that look like salary (< 500 is likely hourly)
                if val >= 500:
                    clean_numbers.append(val)
        if len(clean_numbers) >= 2:
            return clean_numbers[0], clean_numbers[1]
        elif len(clean_numbers) == 1:
            return clean_numbers[0], None
        return None, None

    async def scrape(self) -> list[JobListing]:
        queries = self.search_terms[:5] if self.search_terms else ["devops remote", "SRE remote", "platform engineer remote"]
        all_jobs = []
        seen_ids = set()

        async with self.get_client() as client:
            for query in queries:
                for page in range(1, 3):  # 2 pages per query
                    params = self._build_params(query, page)
                    url = f"{self.BASE_URL}?{urlencode(params)}"

                    try:
                        resp = await client.get(url)
                        resp.raise_for_status()
                    except Exception as e:
                        logger.error(f"Dice fetch failed for '{query}' page {page}: {e}")
                        continue

                    raw_jobs = self._extract_jobs_from_html(resp.text)
                    logger.info(f"Dice: '{query}' page {page} returned {len(raw_jobs)} jobs")

                    for job in raw_jobs:
                        job_id = job.get("id") or job.get("guid", "")
                        if job_id in seen_ids:
                            continue
                        seen_ids.add(job_id)

                        title = job.get("title", "")
                        if not title:
                            continue

                        loc = job.get("jobLocation", {})
                        location_parts = []
                        if loc.get("city"):
                            location_parts.append(loc["city"])
                        if loc.get("region"):
                            location_parts.append(loc["region"])
                        location = ", ".join(location_parts) or "Remote"

                        if job.get("isRemote"):
                            location = f"Remote - {location}" if location != "Remote" else "Remote"

                        salary_min, salary_max = self._parse_salary(job.get("salary", ""))

                        tags = []
                        if job.get("employmentType"):
                            tags.append(job["employmentType"])
                        if job.get("workplaceTypes"):
                            tags.extend(job["workplaceTypes"])

                        all_jobs.append(
                            JobListing(
                                title=title,
                                company=job.get("companyName", ""),
                                location=location,
                                description=job.get("summary", ""),
                                url=job.get("detailsPageUrl", ""),
                                source=self.source_name,
                                salary_min=salary_min,
                                salary_max=salary_max,
                                posted_date=job.get("postedDate"),
                                tags=tags,
                            )
                        )

        logger.info(f"Dice scraper found {len(all_jobs)} unique jobs")
        return all_jobs
