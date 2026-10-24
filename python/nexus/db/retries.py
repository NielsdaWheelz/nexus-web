"""Bounded transaction attempts: the one owner of database retry.

An operation passed here opens and commits its own transaction and reloads its state on every
call. An attempt selects its isolation before its transaction opens; a session that arrives
with a transaction open keeps that transaction's isolation (an open issue:
docs/issues/retry-serializable-keeps-open-transaction-isolation.md). Every Exception rolls the
attempt back; a BaseException (a cancellation) is left to the session's close. A serialization
failure or deadlock, a TransactionRestart, or a violation of a name in
RETRYABLE_UNIQUE_CONSTRAINTS runs the operation again; when the last attempt fails that way it
raises DatabaseRetryExhaustedError (the edge answers 500). Anything else propagates.
"""

from collections.abc import Callable
from typing import Literal

from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

# Unique constraints whose violation is a first-sight race, not a defect: two writers insert
# the same identity (a client-minted id, a get-or-create key) and the rerun reads the winner.
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
        "contributors_pkey",
        "resource_edges_pkey",
        "uix_resource_versions_lane",
        "uix_resource_view_states_endpoint_order",
        "uix_resource_view_states_edge_occurrence",
        "reader_profiles_pkey",
        "uq_reader_media_state_user_media",
        "uq_consumption_queue_items_user_media",
        "uq_consumption_completion_facts_user_media",
        "uq_passage_anchors_identity",
        "uq_resource_edges_user_link_pair",
        "libraries_pkey",
        "users_pkey",
        "uix_libraries_one_default_per_user",
        "memberships_pkey",
        "uq_media_summaries_media",
        "uix_media_canonical_url",
        "x_post_aliases_revision_id_key",
        "uq_daily_page_bindings_user_date",
        "uq_daily_page_bindings_user_page",
        "uq_resource_grants_person",
        "uq_resource_grants_link",
        "uq_suggestion_feeds_lectern",
        "uq_suggestion_feeds_library",
        "pk_resource_grants",
        "library_invitations_pkey",
        "uix_library_invitations_pending_once",
    }
)


class TransactionRestart(Exception):
    """Raised by an operation: roll back and run it again against fresh state."""


class DatabaseRetryExhaustedError(RuntimeError):
    """Every attempt ended in a retryable conflict."""

    def __init__(self, label: str, attempts: int) -> None:
        super().__init__(f"{label} exhausted after {attempts} transaction attempts")


def integrity_constraint_name(exc: IntegrityError) -> str | None:
    """The constraint a failed write violated, from psycopg's diagnostics."""
    name = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
    return str(name) if name else None


def retry_serializable[T](db: Session, label: str, op: Callable[[], T], *, retries: int = 3) -> T:
    """Run `op` in at most `retries` SERIALIZABLE attempts."""
    return _attempts(db, label, op, "SERIALIZABLE", retries)


def retry_read_committed[T](db: Session, label: str, op: Callable[[], T], *, retries: int = 3) -> T:
    """Run `op` in at most `retries` READ COMMITTED attempts: for an op that takes locks and
    then must see a newer snapshot to decide whether its locked set is complete."""
    return _attempts(db, label, op, "READ COMMITTED", retries)


def _attempts[T](
    db: Session,
    label: str,
    op: Callable[[], T],
    isolation: Literal["SERIALIZABLE", "READ COMMITTED"],
    retries: int,
) -> T:
    attempt = 1
    while True:
        if not db.in_transaction():
            db.connection(execution_options={"isolation_level": isolation})
        try:
            return op()
        except Exception as exc:
            db.rollback()
            if not _retryable(exc):
                raise
            if attempt >= retries:
                raise DatabaseRetryExhaustedError(label, attempt) from exc
        attempt += 1


def _retryable(exc: Exception) -> bool:
    if isinstance(exc, OperationalError):
        return getattr(exc.orig, "sqlstate", None) in ("40001", "40P01")
    if isinstance(exc, IntegrityError):
        return integrity_constraint_name(exc) in RETRYABLE_UNIQUE_CONSTRAINTS
    return isinstance(exc, TransactionRestart)
