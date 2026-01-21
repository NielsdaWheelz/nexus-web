"""FastAPI dependencies for route handlers.

Common dependencies like database sessions, authentication, etc.
"""

from nexus.db.session import get_db

__all__ = ["get_db"]
