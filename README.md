# CareerPulse

Self-hosted job discovery and application tool. Scrapes jobs from multiple boards, scores them against your resume using AI, and helps prepare tailored applications.

## Features

- **Multi-source scraping** — LinkedIn, Dice, Remotive, Hacker News, USA Jobs, Arbeitnow, Jobicy
- **AI-powered matching** — Scores jobs 0-100 against your resume with reasons and concerns
- **Chrome extension autofill** — Auto-fills job applications on any ATS (Workday, Greenhouse, Lever, iCIMS, Taleo, custom forms) using AI
- **Comprehensive profile** — Personal info, work history, education, skills, certifications, languages, references, EEO responses
- **Resume analysis** — Extracts skills, suggests job titles, rates ATS compatibility
- **Application prep** — Generates tailored resumes and cover letters per job
- **ATS-optimized PDFs** — Drag-and-drop resume and cover letter downloads
- **Hiring manager lookup** — Searches the web for hiring contact info when not in the listing
- **Direct apply links** — Scrapes actual "Apply" button URLs from job pages
- **Salary estimation** — AI-powered salary range estimates when not listed
- **Company research** — Auto-fetches company descriptions, Glassdoor ratings, and website links
- **Smart deduplication** — Flags similar listings from the same company with one-click dismiss
- **Application timeline** — Auto-tracked events for every action (status changes, prep, downloads)
- **Learning loop** — After form submission, extension prompts to save new data back to CareerPulse
- **Custom Q&A bank** — Store answers to common application questions for reuse
- **Region & clearance filters** — Filter by US, Europe, UK, Canada, LATAM, APAC; hide clearance/visa-required jobs
- **One-click apply tracking** — "Mark as Applied" button with automatic timestamp
- **Job freshness alerts** — Color-coded age badges and stale listing warnings
- **Daily digest** — Summary of new high-scoring matches with copy-to-clipboard
- **CSV export** — Export your entire job pipeline to a spreadsheet
- **Keyboard shortcuts** — Power-user navigation (j/k, ?, /, d, p, o, s)
- **Configurable AI backend** — Anthropic, OpenAI, Google Gemini, OpenRouter, or Ollama (local)
- **Job filters** — Score threshold, work type, employment type, location, keyword search, exclude terms
- **Automated scheduling** — Periodic scraping with APScheduler
- **Persistent data** — SQLite database survives restarts via Docker volume mount
- **Tabbed settings** — Profile, Work History, Job Search, AI & Integrations, Data Management

## Quick Start

### Docker (recommended)

```bash
cp .env.example .env
# Edit .env if you want to set an API key via env var (optional — can configure from UI)
docker compose up -d --build
```

Open http://localhost:8085

### Local

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
uvicorn app.main:create_app --factory --port 8085
```

## Configuration

All env vars use the `JOBFINDER_` prefix. Everything can also be configured from the Settings UI.

| Variable | Default | Description |
|----------|---------|-------------|
| `JOBFINDER_ANTHROPIC_API_KEY` | (empty) | Anthropic API key (or set via UI) |
| `JOBFINDER_USAJOBS_API_KEY` | (empty) | USA Jobs API key (optional) |
| `JOBFINDER_DB_PATH` | `data/jobfinder.db` | SQLite database path |
| `JOBFINDER_RESUME_PATH` | `data/resume.txt` | Default resume file path |
| `JOBFINDER_SCRAPE_INTERVAL_HOURS` | `6` | Auto-scrape interval |
| `JOBFINDER_HOST` | `0.0.0.0` | Server bind host |
| `JOBFINDER_PORT` | `8085` | Server port |

### AI Backend

Configure from **Settings > AI Provider**:

- **Anthropic** — API key required, defaults to `claude-sonnet-4-20250514`
- **OpenAI** — API key required, defaults to `gpt-4o`
- **Google (Gemini)** — API key required, defaults to `gemini-2.0-flash`
- **OpenRouter** — API key required, defaults to `anthropic/claude-sonnet-4` (access many models through one API)
- **Ollama** — Select from a dropdown of locally available models. Set the Ollama URL (defaults to `http://localhost:11434`). When running in Docker, localhost URLs are automatically rewritten to reach the host.

OpenAI, Google, and OpenRouter use the OpenAI-compatible API format. Recommended Ollama models: `qwen2.5:32b`, `Qwen2.5-Coder:32b`, or `qwen2.5:14b-instruct-q4_K_M`.

## Usage

1. **Upload resume** — Settings > Upload & Analyze (PDF, TXT, or MD)
2. **Review analysis** — ATS score, suggested job titles, extracted skills, auto-generated search terms
3. **Scrape jobs** — Dashboard > Scrape Now (or wait for auto-scrape)
4. **Browse matches** — Jobs feed sorted by match score, filtered by type/location
5. **Prepare applications** — Click a job > Prepare Application for tailored resume + cover letter

## Chrome Extension (AutoFill)

The CareerPulse AutoFill extension auto-fills job application forms on any ATS using AI to map your profile data to form fields.

### Install

1. Make sure CareerPulse is running (default: `http://localhost:8001`)
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked** and select the `extension/` folder from this repo
5. The CareerPulse icon appears in your toolbar

### Usage

1. Navigate to any job application form (Workday, Greenhouse, Lever, etc.)
2. Click the CareerPulse extension icon
3. Click **Fill Application** — the extension reads the form, sends it to CareerPulse's AI, and fills fields
4. Review filled fields: green = confident, yellow = needs review
5. After submitting, the extension prompts you to save any new data back to your profile

### How it works

- Content script extracts all form fields (labels, placeholders, options, aria attributes)
- Sends sanitized form HTML to `POST /api/autofill/analyze`
- AI maps your full profile (personal info, work history, education, skills, EEO, custom Q&A) to form fields
- Fields are filled iteratively — handles dynamic/conditional forms (up to 5 passes)
- React-compatible filling using native property descriptor setters
- Works across iframes (common in Workday, iCIMS)

### Configuration

Click the extension popup gear icon or visit **Settings > AI & Integrations** in CareerPulse to configure the server URL (defaults to `http://localhost:8001`).

The extension requires profile data in CareerPulse. Fill out your profile in **Settings > Profile** and **Settings > Work History** before using autofill.

## Architecture

```
FastAPI (async)
├── Scrapers (7 sources) → SQLite (aiosqlite)
├── AIClient (Anthropic | OpenAI | Google | OpenRouter | Ollama)
│   ├── JobMatcher (scoring)
│   ├── ResumeAnalyzer (analysis + ATS)
│   ├── Tailor (resume + cover letter)
│   └── AutoFill analyzer (form field mapping)
├── APScheduler (periodic scraping)
├── Vanilla JS SPA (frontend)
└── Chrome Extension (autofill client)
```

### Scrapers

| Source | Method | Notes |
|--------|--------|-------|
| LinkedIn | Google search | Rate-limited (30-90s delay) |
| Dice | Google search | Rate-limited (30-90s delay) |
| Remotive | REST API | Category-based filtering |
| Hacker News | Algolia + HTML | "Who is Hiring" threads |
| USA Jobs | REST API | Requires API key |
| Arbeitnow | REST API | Client-side keyword filtering |
| Jobicy | REST API | Tag-based filtering |

Jobs are deduplicated by SHA-256 hash of normalized title + company + URL.

### Database

SQLite with tables: `jobs`, `sources`, `job_scores`, `applications`, `app_events`, `search_config`, `ai_settings`, `user_profile`, `companies`, `scraper_keys`, `work_history`, `education`, `certifications`, `skills`, `languages`, `user_references`, `military_service`, `eeo_responses`, `custom_qa`, `autofill_history`. Schema auto-migrates on startup.

## API

### Jobs
- `GET /api/jobs` — List with filters (`sort`, `limit`, `offset`, `min_score`, `search`, `source`, `work_type`, `employment_type`, `location`)
- `GET /api/jobs/:id` — Detail with score, sources, application
- `POST /api/jobs/:id/dismiss` — Dismiss job
- `POST /api/jobs/:id/prepare` — Generate tailored resume + cover letter
- `GET /api/jobs/:id/resume.pdf` — Download tailored resume as PDF
- `GET /api/jobs/:id/cover-letter.pdf` — Download cover letter as PDF
- `POST /api/jobs/:id/email` — Draft application email
- `POST /api/jobs/:id/application` — Update status/notes
- `POST /api/jobs/:id/events` — Add timeline note
- `POST /api/jobs/:id/find-contact` — Search for hiring manager contact
- `POST /api/jobs/:id/find-apply-link` — Scrape direct apply URL
- `POST /api/jobs/:id/estimate-salary` — AI salary estimation

### Configuration
- `GET /api/search-config` — Resume analysis and search terms
- `POST /api/search-config/terms` — Update search terms
- `POST /api/search-config/exclude-terms` — Update exclude terms
- `POST /api/resume/upload` — Upload + analyze resume (multipart)

### AI Settings
- `GET /api/ai-settings` — Current provider/model (keys masked)
- `POST /api/ai-settings` — Save provider config
- `GET /api/ai-settings/models` — List available Ollama models
- `POST /api/ai-settings/test` — Test AI connection

### Profile
- `GET /api/profile` — Get basic user profile
- `POST /api/profile` — Save user profile fields
- `GET /api/profile/full` — Complete structured profile (personal, work history, education, skills, etc.)
- `PUT /api/profile/full` — Update full profile
- `POST /api/profile/learn` — Save new data learned from autofill

### Profile CRUD
- `POST /api/work-history` — Add/update work experience
- `DELETE /api/work-history/:id` — Delete work experience
- `POST /api/education` — Add/update education
- `DELETE /api/education/:id` — Delete education
- `POST /api/certifications` — Add/update certification
- `DELETE /api/certifications/:id` — Delete certification
- `POST /api/skills` — Add/update skill
- `DELETE /api/skills/:id` — Delete skill
- `POST /api/languages` — Add/update language
- `DELETE /api/languages/:id` — Delete language
- `POST /api/references` — Add/update reference
- `DELETE /api/references/:id` — Delete reference

### AutoFill (Extension)
- `POST /api/autofill/analyze` — AI analyzes form HTML, returns field mappings with selectors, values, and confidence
- `GET /api/autofill/history` — List past autofill sessions
- `GET /api/custom-qa` — List custom Q&A bank
- `POST /api/custom-qa` — Add/update Q&A entry
- `DELETE /api/custom-qa/:id` — Delete Q&A entry

### Companies
- `GET /api/companies/:name` — Get/fetch company info (cached)

### Scraper Keys
- `GET /api/scraper-keys` — Get configured scraper keys (masked)
- `POST /api/scraper-keys` — Save scraper API keys

### Operations
- `GET /api/stats` — Job counts by status
- `GET /api/digest` — Daily digest of new high-scoring jobs
- `GET /api/export/csv` — Export jobs to CSV
- `POST /api/scrape` — Trigger scrape cycle (background)
- `GET /api/scrape/progress` — Scrape progress
- `POST /api/score` — Trigger scoring (background)
- `GET /api/score/progress` — Scoring progress
- `POST /api/clear-jobs` — Delete all jobs, scores, and applications (keeps config)
- `POST /api/clear-all` — Factory reset (deletes everything)
- `GET /api/health` — Health check

## Testing

```bash
pip install -e ".[dev]"
pytest
```

133 tests covering scrapers, database, API endpoints, matcher, tailor, resume analyzer, AI client, contact finder, apply link finder, salary estimator, company research, digest, profile CRUD, autofill, and custom Q&A.

## Tech Stack

- **Backend**: Python 3.12+, FastAPI, aiosqlite, httpx
- **Frontend**: Vanilla JS SPA, no build step
- **Extension**: Chrome Manifest V3 (content script + service worker)
- **AI**: Anthropic SDK / OpenAI SDK / Ollama REST API
- **Scraping**: feedparser, BeautifulSoup4, httpx
- **Scheduling**: APScheduler
- **PDF**: PyMuPDF
