"""Thin API launcher.

This is the uvicorn entrypoint. All application logic lives in the nexus package.
Run with: uvicorn main:app --reload

Note: The app instance is created here (not in nexus.app) to avoid import-time
side effects. This allows tests to import create_app without requiring all
environment variables to be configured.
"""

from nexus.app import add_request_id_middleware, create_app

# Create the application instance
app = create_app()
# Add request-id middleware LAST so it runs FIRST (outermost)
add_request_id_middleware(app)

__all__ = ["app"]
