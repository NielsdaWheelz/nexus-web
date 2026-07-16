"""Bounded SERIALIZABLE retry: the one owner of the serialization-failure loop."""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name, is_serialization_failure
from nexus.db.session import use_serializable_if_available

# Named uniqueness constraints whose violation is a legitimate concurrent-insert
# race rather than a defect, so the whole operation retries on a first-sight
# race instead of surfacing a raw IntegrityError: the author resolver's
# exact-batch operation (spec lightweight-author-deduplication-hard-cutover.md
# §2.7), the repository-wide replay-memo constraint, and the consumption
# ensure-membership insert (spec lectern-player-lifecycle-hard-cutover.md §5.3).
RETRYABLE_UNIQUE_CONSTRAINTS = frozenset(
    {
        "uq_contributors_handle",
        "uq_contributor_aliases_owner_normalized",
        "uq_contributor_external_ids_authority_key",
        "uq_contributor_credits_media_ordinal",
        "uq_contributor_credits_media_contributor_role",
        "uq_contributor_credits_podcast_ordinal",
        "uq_contributor_credits_podcast_contributor_role",
        "uq_contributor_credits_gutenberg_ordinal",
        "uq_contributor_credits_gutenberg_contributor_role",
        "uix_resource_mutations_client_id",
        "uq_consumption_queue_items_user_media",
    }
)


def retry_serializable[T](db: Session, label: str, op: Callable[[], T], *, retries: int = 3) -> T:
    """Run ``op`` under SERIALIZABLE isolation, retrying on serialization failure.

    Each attempt sets SERIALIZABLE (when no transaction is open) and runs ``op``;
    a serialization failure rolls back and retries, up to ``retries`` total
    attempts, then re-raises. An ``IntegrityError`` against one of the named
    ``RETRYABLE_UNIQUE_CONSTRAINTS`` is treated the same way — it is a
    concurrent first-sight insert race, not a defect. Any other
    ``OperationalError`` or ``IntegrityError`` rolls back and re-raises
    immediately. ``op`` must reload its working rows and commit on each call so
    a retry sees fresh state. Per concurrency.md there is no explicit row
    locking on top of SERIALIZABLE.
    """
    for attempt in range(retries):
        use_serializable_if_available(db)
        try:
            return op()
        except OperationalError as exc:
            db.rollback()
            if not is_serialization_failure(exc) or attempt == retries - 1:
                raise
        except IntegrityError as exc:
            db.rollback()
            constraint_name = integrity_constraint_name(exc)
            if constraint_name not in RETRYABLE_UNIQUE_CONSTRAINTS or attempt == retries - 1:
                raise
    # justify-defect: the loop returns or raises on the final attempt.
    raise AssertionError(f"{label} retry loop exhausted")
