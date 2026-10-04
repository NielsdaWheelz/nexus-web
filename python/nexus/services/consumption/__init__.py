"""Consumption: activity capture, personal history, current state and the read model.

Every write runs in its own serializable transaction that first locks the viewer row: tabs and
the Android app write one account at once, and every fence in the package assumes serialized
writers. A command replays by ``clientMutationId``: an exact replay answers from current state
and its stored memo, then rolls back.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)


class Command(Protocol):
    client_mutation_id: UUID

    def model_dump(self, *, mode: str, by_alias: bool) -> dict[str, Any]: ...


def fresh_session() -> Session:
    """A write's own session."""
    return get_session_factory()()


def lock_viewer(db: Session, viewer_id: UUID) -> None:
    db.execute(text("SELECT 1 FROM users WHERE id = :id FOR UPDATE"), {"id": viewer_id})


def viewer_txn[T](label: str, viewer_id: UUID, op: Callable[[Session], T]) -> T:
    """``op`` in its own serializable transaction holding the viewer row lock; ``op`` commits."""
    with fresh_session() as db:

        def run() -> T:
            lock_viewer(db, viewer_id)
            return op(db)

        return retry_serializable(db, label, run)


def replayed_command[T](
    label: str,
    scope: str,
    viewer_id: UUID,
    command: Command,
    apply: Callable[[Session], dict[str, Any]],
    answer: Callable[[Session, Mapping[str, Any]], T],
) -> T:
    """Apply ``command`` once per ``clientMutationId``: ``apply`` writes and returns the stored
    memo; ``answer`` builds the response from current state and the memo, fresh or replayed."""

    def run(db: Session) -> T:
        key = {
            "viewer_id": viewer_id,
            "scope": scope,
            "client_mutation_id": str(command.client_mutation_id),
            "request_bytes": canonical_json_bytes(command.model_dump(mode="json", by_alias=True)),
        }
        stored = lookup_replay(db, **key)
        if stored is not None:
            result = answer(db, stored)
            db.rollback()
            return result
        memo = apply(db)
        result = answer(db, memo)
        record_replay(db, **key, response_json=memo)
        db.commit()
        return result

    return viewer_txn(label, viewer_id, run)
