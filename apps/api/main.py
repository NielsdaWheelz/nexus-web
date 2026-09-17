"""Thin API launcher.

This is the uvicorn entrypoint. All application logic lives in the nexus package.
Run with: uvicorn main:app --reload
"""

from nexus.app import create_app
from nexus.logging import configure_logging

configure_logging()

app = create_app()
