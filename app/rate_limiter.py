import asyncio
import time
from urllib.parse import urlparse


class AsyncRateLimiter:
    """Async token-bucket rate limiter."""

    def __init__(self, rate: float, per: float = 1.0):
        self._rate = rate
        self._per = per
        self._allowance = rate
        self._last_check = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self):
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_check
            self._last_check = now
            self._allowance += elapsed * (self._rate / self._per)
            if self._allowance > self._rate:
                self._allowance = self._rate
            if self._allowance < 1.0:
                wait = (1.0 - self._allowance) * (self._per / self._rate)
                self._last_check += wait
                self._allowance = 0.0
                await asyncio.sleep(wait)
            else:
                self._allowance -= 1.0

    async def __aenter__(self):
        await self.acquire()
        return self

    async def __aexit__(self, *exc):
        pass


_limiters: dict[str, AsyncRateLimiter] = {}

# Per-domain rate limits: (requests, per_seconds)
# More aggressive sites get slower limits
DOMAIN_LIMITS: dict[str, tuple[float, float]] = {
    "linkedin.com": (1.0, 3.0),
    "www.linkedin.com": (1.0, 3.0),
    "www.dice.com": (1.0, 2.0),
    "dice.com": (1.0, 2.0),
    "www.indeed.com": (1.0, 2.0),
    "indeed.com": (1.0, 2.0),
    "wellfound.com": (1.0, 3.0),
    "builtin.com": (1.0, 2.0),
    "www.builtin.com": (1.0, 2.0),
    "boards-api.greenhouse.io": (2.0, 1.0),
    "hn.algolia.com": (2.0, 1.0),
    "hacker-news.firebaseio.com": (5.0, 1.0),
    "data.usajobs.gov": (1.0, 1.0),
    "api.adzuna.com": (1.0, 1.0),
    "himalayas.app": (2.0, 1.0),
    "remotive.com": (2.0, 1.0),
    "remoteok.com": (1.0, 1.0),
    "www.arbeitnow.com": (2.0, 1.0),
    "jobicy.com": (2.0, 1.0),
    "weworkremotely.com": (2.0, 1.0),
}

DEFAULT_RATE = 1.0
DEFAULT_PER = 1.0


def get_limiter(domain: str, rate: float | None = None, per: float | None = None) -> AsyncRateLimiter:
    if domain not in _limiters:
        if rate is not None and per is not None:
            _limiters[domain] = AsyncRateLimiter(rate, per)
        else:
            default_rate, default_per = DOMAIN_LIMITS.get(domain, (DEFAULT_RATE, DEFAULT_PER))
            _limiters[domain] = AsyncRateLimiter(default_rate, default_per)
    return _limiters[domain]


def get_limiter_for_url(url: str) -> AsyncRateLimiter:
    domain = urlparse(url).hostname or "unknown"
    return get_limiter(domain)
