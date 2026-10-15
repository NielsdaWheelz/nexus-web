"""The uvicorn entrypoint (`main:app`); the application lives in the nexus package."""

from nexus.app import create_app
from nexus.logging import configure_logging

configure_logging()
app = create_app()
