"""Bounded database transaction retry: the one owner of the retry loop."""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from nexus.db.errors import (
    DatabaseRetryExhaustedError,
    TransactionRestart,
    integrity_constraint_name,
    is_retryable_transaction_conflict,
)
from nexus.db.session import use_read_committed_if_available, use_serializable_if_available

# Named uniqueness constraints whose violation is a legitimate concurrent-insert
# race rather than a defect, owner-neutral across callers: the author
# resolver's exact-batch operation (spec
# lightweight-author-deduplication-hard-cutover.md §2.7), the repository-wide
# replay-memo constraint, the reader profile's first-PATCH insert (spec
# reader-profile-persistence-hard-cutover.md §6), the consumption
# ensure-membership insert (spec lectern-player-lifecycle-hard-cutover.md §5.3),
# and the Link mutation's first inserts — passage-anchor identity, canonical
# neutral-Link pair, directed stance pair, and client-minted Highlight id (spec
# universal-link-authoring-hard-cutover.md, Graph Shapes) — all retry the whole
# operation on a first-sight race.
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
        "reader_profiles_pkey",
        "uq_consumption_queue_items_user_media",
        "uq_passage_anchors_identity",
        "uq_resource_edges_user_context_link_pair",
        "uq_resource_edges_user_stance_directed_pair",
        "highlights_pkey",
    }
)


def _retry_transaction[T](
    db: Session,
    label: str,
    op: Callable[[], T],
    prepare_attempt: Callable[[Session], None],
    *,
    retries: int,
) -> T:
    for attempt in range(retries):
        prepare_attempt(db)
        try:
            return op()
        except TransactionRestart as exc:
            db.rollback()
            if attempt == retries - 1:
                # justify-defect: the operation could not establish its database invariant
                # within the repository's bounded transaction retry budget.
                raise DatabaseRetryExhaustedError(label, retries) from exc
        except OperationalError as exc:
            db.rollback()
            if not is_retryable_transaction_conflict(exc):
                raise
            if attempt == retries - 1:
                # justify-defect: retryable database conflicts must not cross the retry
                # boundary as a product-facing dependency error.
                raise DatabaseRetryExhaustedError(label, retries) from exc
        except IntegrityError as exc:
            db.rollback()
            constraint_name = integrity_constraint_name(exc)
            if constraint_name not in RETRYABLE_UNIQUE_CONSTRAINTS:
                raise
            if attempt == retries - 1:
                # justify-defect: a persistent first-sight race after the bounded retry
                # budget violates the owning operation's expected invariant.
                raise DatabaseRetryExhaustedError(label, retries) from exc
    # justify-defect: the loop returns or raises on the final attempt.
    raise AssertionError(f"{label} retry loop exhausted")


def retry_serializable[T](db: Session, label: str, op: Callable[[], T], *, retries: int = 3) -> T:
    """Run ``op`` in bounded SERIALIZABLE transaction attempts.

    Each attempt sets SERIALIZABLE before ``op`` opens its transaction. A retryable
    transaction conflict rolls back and retries. An ``IntegrityError`` against one of the named
    ``RETRYABLE_UNIQUE_CONSTRAINTS`` is treated the same way — it is a
    concurrent first-sight insert race, not a defect. ``op`` must open and commit
    its transaction and reload all working state on every call.
    """
    return _retry_transaction(
        db,
        label,
        op,
        use_serializable_if_available,
        retries=retries,
    )


def retry_read_committed[T](db: Session, label: str, op: Callable[[], T], *, retries: int = 3) -> T:
    """Run ``op`` in bounded READ COMMITTED transaction attempts.

    Use this when one attempt deliberately takes locks and then must observe a
    newer statement snapshot before deciding whether its locked set is complete.
    ``TransactionRestart`` requests a fresh attempt without exposing that control
    signal outside this boundary.
    """
    return _retry_transaction(
        db,
        label,
        op,
        use_read_committed_if_available,
        retries=retries,
    )
