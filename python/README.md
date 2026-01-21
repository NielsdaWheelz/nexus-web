# Nexus Python Package

Shared Python code for the Nexus platform.

## Structure

```
nexus/
├── config.py      # Pydantic settings
├── errors.py      # Error codes and exceptions
├── responses.py   # Response envelope helpers
├── app.py         # FastAPI app creation
├── api/           # HTTP routers
│   ├── deps.py    # FastAPI dependencies
│   └── routes/    # Route handlers
└── db/            # Database layer
    ├── engine.py  # SQLAlchemy engine
    └── session.py # Session management
```

## Usage

This package is imported by:
- `apps/api/` - FastAPI server
- `apps/worker/` - Celery worker (future)

## Development

```bash
# Install dependencies
uv sync --all-extras

# Run tests
DATABASE_URL=postgresql+psycopg://localhost/test uv run pytest -v

# Lint and format
uv run ruff check .
uv run ruff format .
```

## Install as Editable

```bash
pip install -e .
```
