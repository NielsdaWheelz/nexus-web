"""Application-minted time-ordered ids (Python 3.12 has no stdlib UUIDv7, postgres no function)."""

import uuid

import uuid6


def new_uuid7() -> uuid.UUID:
    return uuid6.uuid7()
