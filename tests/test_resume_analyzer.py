import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from app.resume_analyzer import analyze_resume


@pytest.mark.asyncio
async def test_analyze_resume_extracts_terms():
    mock_client = MagicMock()
    mock_client.chat = AsyncMock(return_value=json.dumps({
        "search_terms": ["senior devops engineer remote", "SRE remote"],
        "job_titles": [{"title": "DevOps Engineer", "why": "strong fit"}],
        "key_skills": ["AWS", "Kubernetes"],
        "seniority": "senior",
        "summary": "Experienced infrastructure engineer",
    }))
    result = await analyze_resume(mock_client, "Experienced DevOps engineer...")
    assert "senior devops engineer remote" in result["search_terms"]
    assert result["job_titles"][0]["title"] == "DevOps Engineer"
    assert "AWS" in result["key_skills"]
    assert result["seniority"] == "senior"
    assert result["summary"] == "Experienced infrastructure engineer"


@pytest.mark.asyncio
async def test_analyze_resume_handles_error():
    mock_client = MagicMock()
    mock_client.chat = AsyncMock(side_effect=Exception("API error"))
    result = await analyze_resume(mock_client, "some resume")
    assert result["search_terms"] == []
    assert result["job_titles"] == []


@pytest.mark.asyncio
async def test_analyze_resume_handles_bad_json():
    mock_client = MagicMock()
    mock_client.chat = AsyncMock(return_value="not json")
    result = await analyze_resume(mock_client, "some resume")
    assert result["search_terms"] == []
