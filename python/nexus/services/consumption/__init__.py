"""Consumption: where each viewer is in each work, what they finished, the Lectern, and what
they actually read, heard and watched.

Every write runs in its own serializable transaction that first locks the viewer's ``users``
row with no-key-update (I10): tabs and the Android app write one account at once, and every fence here assumes
serialized writers. Writes inside a caller's transaction (the assistant, podcast sync) take the
same lock first; re-taking a held lock is a no-op.
"""

from __future__ import annotations

from collections.abc import Callable
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.services import users


def viewer_txn[T](label: str, viewer_id: UUID, op: Callable[[Session], T]) -> T:
    """``op`` in a fresh serializable transaction holding the viewer lock; ``op`` commits."""
    with get_session_factory()() as db:

        def run() -> T:
            users.lock_viewer(db, viewer_id)
            return op(db)

        return retry_serializable(db, label, run)
