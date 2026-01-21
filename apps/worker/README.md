# Nexus Worker

Celery worker entrypoint (placeholder for future PR).

## Overview

The worker will process background tasks like:
- Media extraction and processing
- Embedding generation
- Email notifications

## Usage (future)

```bash
cd apps/worker
celery -A main worker --loglevel=info
```

## Architecture

All task logic lives in `python/nexus/jobs/`. This directory contains only the thin Celery launcher.
