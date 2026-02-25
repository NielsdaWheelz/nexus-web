"""Shared PDF advisory-lock helpers for cross-PR coordination.

Owns media-scoped coordination lock key derivation and ordered lock helpers
for the S6-PR04-D09/D10 lock-ordering contract:
  media-scoped coordination lock -> duplicate-identity advisory lock

Import boundary: stdlib + SQLAlchemy only. No imports from pdf_highlights,
pdf_lifecycle, pdf_ingest, or route/service modules.
"""

import hashlib
import struct
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

_COORDINATION_NAMESPACE = b"pdf_media_coord_v1:"


def derive_media_coordination_lock_key(media_id: UUID) -> int:
    """Derive a stable namespaced int64 advisory-lock key for media-scoped coordination.

    Used to serialize PDF highlight writes and text-rebuild/invalidation
    operations on the same media.
    """
    identity = _COORDINATION_NAMESPACE + media_id.bytes
    digest = hashlib.sha256(identity).digest()
    return struct.unpack(">q", digest[:8])[0]


def acquire_advisory_xact_lock(db: Session, lock_key: int) -> None:
    """Acquire a transaction-scoped Postgres advisory lock.

    Released automatically at transaction end (commit/rollback).
    """
    db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_key})


def acquire_ordered_locks(
    db: Session,
    media_coordination_key: int,
    duplicate_lock_key: int,
) -> None:
    """Acquire media coordination + duplicate advisory locks in D09 order.

    Always: coordination lock first, then duplicate lock.
    """
    acquire_advisory_xact_lock(db, media_coordination_key)
    acquire_advisory_xact_lock(db, duplicate_lock_key)
