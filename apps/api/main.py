"""Thin API launcher.

This is the uvicorn entrypoint. All application logic lives in the nexus package.
Run with: uvicorn main:app --reload
"""

from nexus.app import app

__all__ = ["app"]
