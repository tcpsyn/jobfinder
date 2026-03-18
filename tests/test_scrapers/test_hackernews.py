import re

import pytest
from app.scrapers.base import JobListing
from app.scrapers.hackernews import HackerNewsScraper

MOCK_SEARCH_RESPONSE = {
    "hits": [
        {"objectID": "99999", "title": "Ask HN: Who is hiring? (March 2026)"}
    ]
}

MOCK_THREAD = {
    "id": 99999,
    "kids": [1001, 1002],
    "title": "Ask HN: Who is hiring? (March 2026)",
}

MOCK_COMMENT_1 = {
    "id": 1001,
    "text": "Acme Corp | Senior DevOps Engineer | Remote | $180k-$220k<p>We are hiring a senior DevOps engineer to work on cloud infrastructure.</p>",
}

MOCK_COMMENT_2 = {
    "id": 1002,
    "text": "BigTech Inc | SRE | NYC or Remote<p>Looking for an SRE with Kubernetes experience.</p>",
}


@pytest.mark.asyncio
async def test_hackernews_parse(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://hn\.algolia\.com/api/v1/search\?.*"),
        json=MOCK_SEARCH_RESPONSE,
    )
    httpx_mock.add_response(
        url="https://hacker-news.firebaseio.com/v0/item/99999.json",
        json=MOCK_THREAD,
    )
    httpx_mock.add_response(
        url="https://hacker-news.firebaseio.com/v0/item/1001.json",
        json=MOCK_COMMENT_1,
    )
    httpx_mock.add_response(
        url="https://hacker-news.firebaseio.com/v0/item/1002.json",
        json=MOCK_COMMENT_2,
    )

    scraper = HackerNewsScraper()
    jobs = await scraper.scrape()
    assert len(jobs) == 2
    assert isinstance(jobs[0], JobListing)
    assert jobs[0].company == "Acme Corp"
    assert jobs[0].title == "Senior DevOps Engineer"
    assert jobs[0].source == "hackernews"
    assert jobs[1].company == "BigTech Inc"


@pytest.mark.asyncio
async def test_hackernews_no_threads(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"https://hn\.algolia\.com/api/v1/search\?.*"),
        json={"hits": []},
    )
    scraper = HackerNewsScraper()
    jobs = await scraper.scrape()
    assert jobs == []


@pytest.mark.asyncio
async def test_hackernews_handles_error(httpx_mock):
    # 3 responses for retry attempts (max_retries=3)
    for _ in range(3):
        httpx_mock.add_response(
            url=re.compile(r"https://hn\.algolia\.com/api/v1/search\?.*"),
            status_code=500,
        )
    scraper = HackerNewsScraper()
    scraper.initial_delay = 0.01
    jobs = await scraper.scrape()
    assert jobs == []
