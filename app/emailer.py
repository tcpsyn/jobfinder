import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)

EMAIL_PATTERN = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")


def extract_emails_from_text(text: str) -> list[str]:
    return list(set(EMAIL_PATTERN.findall(text)))


def draft_application_email(
    to: Optional[str],
    company: str,
    position: str,
    cover_letter: str,
    sender_name: str,
    sender_email: str,
) -> Optional[dict]:
    if not to:
        return None
    return {
        "to": to,
        "subject": f"Application: {position} at {company} - {sender_name}",
        "body": f"{cover_letter}\n\nBest regards,\n{sender_name}\n{sender_email}",
    }


async def find_contact_emails(domain: str) -> list[str]:
    import httpx

    common_paths = ["/careers", "/jobs", "/contact", "/about"]
    found = []
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            for path in common_paths:
                try:
                    resp = await client.get(f"https://{domain}{path}")
                    if resp.status_code == 200:
                        found.extend(extract_emails_from_text(resp.text))
                except Exception:
                    continue
    except Exception as e:
        logger.error(f"Contact email search failed for {domain}: {e}")
    return list(set(found))
