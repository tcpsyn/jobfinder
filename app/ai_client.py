import json
import logging
import os

import httpx

logger = logging.getLogger(__name__)


def _resolve_ollama_url(url: str) -> str:
    """Rewrite localhost URLs to host.docker.internal when running in Docker."""
    if os.path.exists("/.dockerenv"):
        return url.replace("localhost", "host.docker.internal").replace("127.0.0.1", "host.docker.internal")
    return url


class AIClient:
    """Unified async AI client supporting Anthropic and Ollama backends."""

    def __init__(self, provider: str, api_key: str = "", model: str = "",
                 base_url: str = ""):
        self.provider = provider
        self.api_key = api_key
        self.model = model or self._default_model()
        self.base_url = base_url or self._default_base_url()

    def _default_model(self):
        if self.provider == "anthropic":
            return "claude-sonnet-4-20250514"
        if self.provider == "ollama":
            return "llama3"
        return ""

    def _default_base_url(self):
        if self.provider == "ollama":
            return "http://localhost:11434"
        return ""

    async def chat(self, prompt: str, max_tokens: int = 1024) -> str:
        if self.provider == "anthropic":
            return await self._anthropic_chat(prompt, max_tokens)
        elif self.provider == "ollama":
            return await self._ollama_chat(prompt, max_tokens)
        else:
            raise ValueError(f"Unknown provider: {self.provider}")

    async def _anthropic_chat(self, prompt: str, max_tokens: int) -> str:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=self.api_key)
        message = await client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text

    async def _ollama_chat(self, prompt: str, max_tokens: int) -> str:
        url = f"{_resolve_ollama_url(self.base_url).rstrip('/')}/api/chat"
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "options": {"num_predict": max_tokens},
        }
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            return data["message"]["content"]


def parse_json_response(raw: str) -> dict:
    """Strip markdown code fences and parse JSON from AI response."""
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        raw = raw.rsplit("```", 1)[0]
    return json.loads(raw)
