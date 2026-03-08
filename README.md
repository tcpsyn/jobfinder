# JobFinder

Self-hosted job discovery and application tool. Scrapes jobs from multiple boards, scores them against your resume using AI, and helps prepare tailored applications.

## Features

- **Multi-source scraping** — Indeed, LinkedIn, Dice, Remote OK, We Work Remotely, Remotive, Hacker News, USA Jobs
- **AI-powered matching** — Scores jobs 0-100 against your resume with reasons and concerns
- **Resume analysis** — Extracts skills, suggests job titles, rates ATS compatibility
- **Application prep** — Generates tailored resumes and cover letters per job
- **Configurable AI backend** — Anthropic (Claude) or Ollama (local models)
- **Job filters** — Score threshold, work type (remote/onsite/hybrid), employment type, location, keyword search
- **Automated scheduling** — Periodic scraping with APScheduler
- **Persistent data** — SQLite database survives restarts via Docker volume mount
- **Data management** — Clear jobs or reset all data from Settings

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

- **Anthropic** — Enter API key, model defaults to `claude-sonnet-4-20250514`
- **Ollama** — Select from a dropdown of locally available models. Set the Ollama URL (defaults to `http://localhost:11434`). When running in Docker, localhost URLs are automatically rewritten to reach the host.

Recommended Ollama models for this app: `qwen2.5:32b`, `Qwen2.5-Coder:32b`, or `qwen2.5:14b-instruct-q4_K_M`.

## Usage

1. **Upload resume** — Settings > Upload & Analyze (PDF, TXT, or MD)
2. **Review analysis** — ATS score, suggested job titles, extracted skills, auto-generated search terms
3. **Scrape jobs** — Dashboard > Scrape Now (or wait for auto-scrape)
4. **Browse matches** — Jobs feed sorted by match score, filtered by type/location
5. **Prepare applications** — Click a job > Prepare Application for tailored resume + cover letter

## Architecture

```
FastAPI (async)
├── Scrapers (8 sources) → SQLite (aiosqlite)
├── AIClient (Anthropic | Ollama)
│   ├── JobMatcher (scoring)
│   ├── ResumeAnalyzer (analysis + ATS)
│   └── Tailor (resume + cover letter)
├── APScheduler (periodic scraping)
└── Vanilla JS SPA (frontend)
```

### Scrapers

| Source | Method | Notes |
|--------|--------|-------|
| Indeed | RSS feed | Keyword-based search |
| LinkedIn | Google search | Rate-limited (30-90s delay) |
| Dice | Google search | Rate-limited (30-90s delay) |
| Remote OK | JSON API | Direct API |
| We Work Remotely | RSS feed | Fixed categories (devops, backend) |
| Remotive | REST API | Category-based filtering |
| Hacker News | Algolia + HTML | "Who is Hiring" threads |
| USA Jobs | REST API | Requires API key |

Jobs are deduplicated by SHA-256 hash of normalized title + company + URL.

### Database

SQLite with tables: `jobs`, `sources`, `job_scores`, `applications`, `search_config`, `ai_settings`. Schema auto-migrates on startup.

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

### Configuration
- `GET /api/search-config` — Resume analysis and search terms
- `POST /api/search-config/terms` — Update search terms
- `POST /api/resume/upload` — Upload + analyze resume (multipart)

### AI Settings
- `GET /api/ai-settings` — Current provider/model (keys masked)
- `POST /api/ai-settings` — Save provider config
- `GET /api/ai-settings/models` — List available Ollama models
- `POST /api/ai-settings/test` — Test AI connection

### Operations
- `GET /api/stats` — Job counts by status
- `POST /api/scrape` — Trigger scrape cycle (background)
- `POST /api/score` — Trigger scoring (background)
- `POST /api/clear-jobs` — Delete all jobs, scores, and applications (keeps config)
- `POST /api/clear-all` — Factory reset (deletes everything)
- `GET /api/health` — Health check

## Testing

```bash
pip install -e ".[dev]"
pytest
```

93 tests covering scrapers, database, API endpoints, matcher, tailor, resume analyzer, and AI client.

## Tech Stack

- **Backend**: Python 3.12+, FastAPI, aiosqlite, httpx
- **Frontend**: Vanilla JS SPA, no build step
- **AI**: Anthropic SDK / Ollama REST API
- **Scraping**: feedparser, BeautifulSoup4, httpx
- **Scheduling**: APScheduler
- **PDF**: PyMuPDF
