"""Sole owner of application-generated UUIDv7 identity.

Python 3.12 has no standard-library UUIDv7 generator and the database exposes
no UUIDv7 function to lean on. This module wraps the `uuid6` package's
`uuid7()` so every call site that needs an application-generated, time-ordered
identifier goes through one owner.
"""

import uuid

import uuid6


def new_uuid7() -> uuid.UUID:
    """Generate a new UUIDv7 identifier."""
    return uuid6.uuid7()
