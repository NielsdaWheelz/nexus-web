"""Authentication and authorization module.

This module provides:
- Token verification (Supabase JWKS and test verifiers)
- Auth middleware for FastAPI
- Request state with viewer identity
"""

from nexus.auth.middleware import AuthMiddleware, get_viewer
from nexus.auth.verifier import MockTokenVerifier, SupabaseJwksVerifier, TokenVerifier

__all__ = [
    "AuthMiddleware",
    "get_viewer",
    "SupabaseJwksVerifier",
    "MockTokenVerifier",
    "TokenVerifier",
]
