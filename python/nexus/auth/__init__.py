"""Authentication and authorization module.

This module provides:
- Token verification (Supabase JWKS verifier)
- Auth middleware for FastAPI
- Request state with viewer identity

Note: Test-only verifiers are in tests/support/test_verifier.py
"""

from nexus.auth.middleware import AuthMiddleware, get_viewer
from nexus.auth.verifier import SupabaseJwksVerifier, TokenVerifier

__all__ = [
    "AuthMiddleware",
    "get_viewer",
    "SupabaseJwksVerifier",
    "TokenVerifier",
]
