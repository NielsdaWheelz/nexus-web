"""Thin API launcher.

This is the uvicorn entrypoint. All application logic lives in the nexus package.
Run with: uvicorn main:app --reload

Note: The app instance is created here (not in nexus.app) to avoid import-time
side effects. This allows tests to import create_app without requiring all
environment variables to be configured.
"""

from nexus.app import add_request_id_middleware, create_app
from nexus.logging import configure_logging

configure_logging()

app = create_app()
add_request_id_middleware(app)
