import pytest
from app.ai_client import AIClient, parse_json_response


def test_default_model_anthropic():
    client = AIClient("anthropic", api_key="test")
    assert "claude" in client.model or client.model == "claude-sonnet-4-20250514"


def test_default_model_ollama():
    client = AIClient("ollama")
    assert client.model == "llama3"


def test_default_base_url_ollama():
    client = AIClient("ollama")
    assert client.base_url == "http://localhost:11434"


def test_parse_json_response_plain():
    result = parse_json_response('{"score": 88}')
    assert result["score"] == 88


def test_parse_json_response_markdown():
    result = parse_json_response('```json\n{"score": 88}\n```')
    assert result["score"] == 88


def test_parse_json_response_markdown_no_lang():
    result = parse_json_response('```\n{"score": 88}\n```')
    assert result["score"] == 88


def test_parse_json_response_bad_json():
    with pytest.raises(Exception):
        parse_json_response("not json")
