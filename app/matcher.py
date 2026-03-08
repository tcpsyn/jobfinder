import asyncio
import logging

from app.ai_client import AIClient, parse_json_response

logger = logging.getLogger(__name__)

SCORING_PROMPT = """You are a job matching assistant. Compare this resume against the job description.

RESUME:
{resume}

JOB DESCRIPTION:
{job_description}

Return ONLY valid JSON with this exact structure:
{{
    "score": <0-100 integer>,
    "reasons": ["reason 1", "reason 2"],
    "concerns": ["concern 1"],
    "keywords": ["keyword to emphasize"]
}}

Scoring criteria:
- Skills overlap between resume and job requirements
- Seniority alignment (years of experience vs role level)
- Role relevance (how well the candidate's background fits)
- Remote compatibility if applicable
- Score 80+ = strong match, 60-79 = decent, below 60 = weak"""


class JobMatcher:
    def __init__(self, client: AIClient, resume_text: str):
        self.client = client
        self.resume_text = resume_text

    async def score_job(self, job_description: str) -> dict:
        try:
            prompt = SCORING_PROMPT.format(
                resume=self.resume_text,
                job_description=job_description,
            )
            raw = await self.client.chat(prompt, max_tokens=1024)
            return parse_json_response(raw)
        except Exception as e:
            logger.error(f"Scoring failed: {e}")
            return {
                "score": 0,
                "reasons": [],
                "concerns": [f"Scoring error: {e}"],
                "keywords": [],
            }

    async def batch_score(self, jobs: list[dict], delay: float = 2.0) -> list[dict]:
        results = []
        for job in jobs:
            result = await self.score_job(job["description"])
            result["job_id"] = job["id"]
            results.append(result)
            if job != jobs[-1] and delay > 0:
                await asyncio.sleep(delay)
        return results
