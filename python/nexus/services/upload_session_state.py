"""Derived upload session state shared by the upload and projection owners."""

UPLOAD_SESSION_DERIVED_STATE_SQL = """
        CASE
            WHEN published_at IS NOT NULL THEN 'Published'
            WHEN verification_error_code IS NOT NULL THEN 'VerificationFailed'
            WHEN upload_url_expires_at <= now() THEN 'CapabilityExpired'
            ELSE 'AwaitingBytes'
        END"""
"""The one statement of a session's state, for Imports' set-wise reads."""

UPLOAD_SESSION_ATTENTION_STATES = ("VerificationFailed", "CapabilityExpired")
