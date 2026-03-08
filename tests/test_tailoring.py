import pytest
import json
from unittest.mock import AsyncMock, MagicMock
from app.tailoring import Tailor

SAMPLE_RESUME = "Senior Linux and Infrastructure Engineer with 20+ years..."

MOCK_TAILORED = {
    "tailored_resume": "Senior Infrastructure & AI Engineer with 20+ years...",
    "cover_letter": "Dear Hiring Manager,\n\nI am writing to express my interest in the Senior DevOps Engineer position...",
}


@pytest.mark.asyncio
async def test_tailor_generates_materials():
    mock_client = MagicMock()
    mock_client.chat = AsyncMock(return_value=json.dumps(MOCK_TAILORED))

    tailor = Tailor(client=mock_client, resume_text=SAMPLE_RESUME)
    result = await tailor.prepare(
        job_description="Senior DevOps role requiring AWS, K8s...",
        match_reasons=["Strong AWS match"],
        suggested_keywords=["kubernetes"],
    )
    assert "tailored_resume" in result
    assert "cover_letter" in result
    assert len(result["cover_letter"]) > 0
    assert len(result["tailored_resume"]) > 0


@pytest.mark.asyncio
async def test_tailor_handles_error():
    mock_client = MagicMock()
    mock_client.chat = AsyncMock(side_effect=Exception("API error"))

    tailor = Tailor(client=mock_client, resume_text=SAMPLE_RESUME)
    result = await tailor.prepare("job desc", [], [])
    assert result["tailored_resume"] == SAMPLE_RESUME
    assert result["cover_letter"] == ""


@pytest.mark.asyncio
async def test_tailor_handles_bad_json():
    mock_client = MagicMock()
    mock_client.chat = AsyncMock(return_value="not valid json")

    tailor = Tailor(client=mock_client, resume_text=SAMPLE_RESUME)
    result = await tailor.prepare("job desc", [], [])
    assert result["tailored_resume"] == SAMPLE_RESUME
    assert result["cover_letter"] == ""
