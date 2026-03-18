import asyncio
import time

import pytest
from app.rate_limiter import AsyncRateLimiter, get_limiter, get_limiter_for_url, _limiters


@pytest.fixture(autouse=True)
def clear_registry():
    _limiters.clear()
    yield
    _limiters.clear()


@pytest.mark.asyncio
async def test_first_acquire_is_immediate():
    limiter = AsyncRateLimiter(1, 1.0)
    start = time.monotonic()
    await limiter.acquire()
    elapsed = time.monotonic() - start
    assert elapsed < 0.05


@pytest.mark.asyncio
async def test_second_acquire_waits():
    limiter = AsyncRateLimiter(1, 0.2)
    await limiter.acquire()
    start = time.monotonic()
    await limiter.acquire()
    elapsed = time.monotonic() - start
    assert elapsed >= 0.15


@pytest.mark.asyncio
async def test_context_manager():
    limiter = AsyncRateLimiter(1, 1.0)
    async with limiter:
        pass


@pytest.mark.asyncio
async def test_concurrent_access():
    limiter = AsyncRateLimiter(1, 0.1)
    results = []

    async def worker(idx):
        await limiter.acquire()
        results.append((idx, time.monotonic()))

    start = time.monotonic()
    await asyncio.gather(*[worker(i) for i in range(3)])

    times = [t - start for _, t in results]
    assert times[-1] >= 0.15


@pytest.mark.asyncio
async def test_high_rate_allows_burst():
    limiter = AsyncRateLimiter(5, 1.0)
    start = time.monotonic()
    for _ in range(5):
        await limiter.acquire()
    elapsed = time.monotonic() - start
    assert elapsed < 0.1


def test_get_limiter_returns_same_instance():
    a = get_limiter("example.com")
    b = get_limiter("example.com")
    assert a is b


def test_get_limiter_different_domains():
    a = get_limiter("example.com")
    b = get_limiter("other.com")
    assert a is not b


def test_get_limiter_linkedin_defaults():
    limiter = get_limiter("www.linkedin.com")
    assert limiter._rate == 1.0
    assert limiter._per == 3.0


def test_get_limiter_custom_rate():
    limiter = get_limiter("custom.com", rate=5.0, per=10.0)
    assert limiter._rate == 5.0
    assert limiter._per == 10.0


def test_get_limiter_for_url():
    limiter = get_limiter_for_url("https://www.linkedin.com/jobs/view/123")
    assert limiter._per == 3.0

    limiter2 = get_limiter_for_url("https://dice.com/jobs/123")
    assert limiter2._per == 2.0
