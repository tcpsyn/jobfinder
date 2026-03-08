import pytest
from app.emailer import draft_application_email, extract_emails_from_text


def test_draft_email():
    email = draft_application_email(
        to="jobs@techcorp.com",
        company="TechCorp",
        position="Senior DevOps Engineer",
        cover_letter="Dear Hiring Manager,\n\nI am writing...",
        sender_name="John Doe",
        sender_email="user@example.com",
    )
    assert email["to"] == "jobs@techcorp.com"
    assert "Senior DevOps Engineer" in email["subject"]
    assert "TechCorp" in email["subject"]
    assert "Dear Hiring Manager" in email["body"]
    assert "John Doe" in email["body"]


def test_draft_email_no_contact():
    email = draft_application_email(
        to=None,
        company="TechCorp",
        position="Senior DevOps Engineer",
        cover_letter="Dear Hiring Manager...",
        sender_name="John Doe",
        sender_email="user@example.com",
    )
    assert email is None


def test_extract_emails_from_text():
    text = "Send resume to jobs@acme.com or hr@acme.com. Not valid: foo@bar"
    emails = extract_emails_from_text(text)
    assert "jobs@acme.com" in emails
    assert "hr@acme.com" in emails


def test_extract_emails_empty():
    assert extract_emails_from_text("no emails here") == []


def test_extract_emails_deduplicates():
    text = "jobs@acme.com and again jobs@acme.com"
    emails = extract_emails_from_text(text)
    assert len(emails) == 1
