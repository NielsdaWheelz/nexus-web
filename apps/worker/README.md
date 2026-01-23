# Nexus Worker

Celery worker for asynchronous task processing.

## Overview

The worker processes background tasks including:
- **Web article ingestion**: Fetch URLs via Playwright, extract with Mozilla Readability, sanitize HTML, generate canonical text
- Future: Media extraction, embedding generation, transcription

## Prerequisites

For web article ingestion, the worker requires:
- Node.js 20+ (for the ingest script)
- Playwright with Chromium (installed by `npx playwright install chromium`)

## Usage

### Local Development

```bash
# From repo root
make worker

# Or manually:
cd python
PYTHONPATH=$PWD:$PWD/.. \
  DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:54322/postgres \
  REDIS_URL=redis://localhost:6379/0 \
  uv run celery -A apps.worker.main:celery_app worker -Q ingest --concurrency=1 --loglevel=info
```

### Docker

```bash
# Build worker image (from repo root)
docker build -f docker/Dockerfile.worker -t nexus-worker .

# Run with docker-compose
docker compose -f docker/docker-compose.yml -f docker/docker-compose.worker.yml up -d

# Or run standalone
docker run \
  -e DATABASE_URL=... \
  -e REDIS_URL=... \
  -e SUPABASE_JWKS_URL=... \
  -e SUPABASE_ISSUER=... \
  -e SUPABASE_AUDIENCES=... \
  nexus-worker
```

## Architecture

### Task Registration

Tasks are explicitly imported in `main.py` - no autodiscovery:

```python
from nexus.tasks import ingest_web_article  # noqa: F401
```

All task logic lives in `python/nexus/tasks/`. This directory contains only the thin Celery launcher.

### Queue Configuration

| Queue | Purpose | Concurrency |
|-------|---------|-------------|
| `ingest` | Web article ingestion (Playwright) | 1 (due to Chromium memory) |
| `default` | General tasks (future) | N |

### Web Article Ingestion Flow

1. API creates provisional media row (`POST /media/from_url`)
2. API enqueues `ingest_web_article` task to `ingest` queue
3. Worker task:
   - Runs Node.js subprocess (Playwright + jsdom + Readability)
   - Resolves redirects, computes canonical URL
   - Handles deduplication atomically
   - Sanitizes HTML (XSS protection, image proxy rewriting)
   - Generates canonical text for highlighting
   - Persists fragment and updates media to `ready_for_reading`

### Node.js Subprocess

The worker spawns `node/ingest/ingest.mjs` as a subprocess:

```
Python worker → subprocess → node/ingest/ingest.mjs
                                  ├── Playwright (fetch + JS render)
                                  ├── jsdom (DOM parsing)
                                  └── @mozilla/readability (extraction)
```

Subprocess protocol:
- **Input**: JSON via stdin `{"url": "...", "timeout_ms": 30000}`
- **Output**: JSON via stdout `{"final_url": "...", "title": "...", "content_html": "..."}`
- **Exit codes**: 0=success, 10=timeout, 11=fetch failed, 12=readability failed
- **Timeout**: 40s hard wall-clock limit

### Memory Considerations

Chromium browser processes are memory-intensive. Recommendations:
- Start with `--concurrency=1` for the `ingest` queue
- Scale by running multiple worker containers rather than increasing concurrency
- Set container memory limits (e.g., 2GB per worker)

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis URL for Celery broker |
| `CELERY_BROKER_URL` | No | Override broker URL (defaults to REDIS_URL) |
| `CELERY_RESULT_BACKEND` | No | Override result backend (defaults to REDIS_URL) |
| `SUPABASE_JWKS_URL` | Yes | Supabase JWKS endpoint |
| `SUPABASE_ISSUER` | Yes | JWT issuer |
| `SUPABASE_AUDIENCES` | Yes | JWT audiences |

## Troubleshooting

### Node.js Not Found

Ensure Node.js 20+ is installed and in PATH:
```bash
node --version  # Should be v20.x.x or later
```

### Playwright Chromium Missing

Install Playwright browsers:
```bash
cd node/ingest
npm ci
npx playwright install chromium
```

### Task Not Processing

Check that:
1. Redis is running and accessible
2. Worker is connected to the correct queue (`-Q ingest`)
3. Task was enqueued successfully (check Celery logs)

### Memory Issues

If worker is killed (OOM):
- Reduce concurrency to 1
- Increase container memory limit
- Check for memory leaks in long-running workers
