import logging

from app.ai_client import AIClient, parse_json_response

logger = logging.getLogger(__name__)

TAILORING_PROMPT = """You are a resume tailoring assistant for a senior engineer.

BASE RESUME:
{resume}

JOB DESCRIPTION:
{job_description}

MATCH REASONS (from prior analysis):
{match_reasons}

KEYWORDS TO EMPHASIZE:
{keywords}

Return ONLY valid JSON:
{{
    "tailored_resume": "<full resume text, lightly reorganized to emphasize relevant experience. DO NOT fabricate experience. Only reorder bullets, adjust summary wording, and highlight matching skills.>",
    "cover_letter": "<~250 word professional cover letter. Confident senior engineer tone. Connect specific accomplishments to job requirements. No generic filler.>"
}}"""


class Tailor:
    def __init__(self, client: AIClient, resume_text: str):
        self.client = client
        self.resume_text = resume_text

    async def prepare(
        self,
        job_description: str,
        match_reasons: list,
        suggested_keywords: list,
    ) -> dict:
        try:
            prompt = TAILORING_PROMPT.format(
                resume=self.resume_text,
                job_description=job_description,
                match_reasons="\n".join(match_reasons),
                keywords=", ".join(suggested_keywords),
            )
            raw = await self.client.chat(prompt, max_tokens=4096)
            return parse_json_response(raw)
        except Exception as e:
            logger.error(f"Tailoring failed: {e}")
            return {
                "tailored_resume": self.resume_text,
                "cover_letter": "",
            }
