"""Bounded transaction attempts: the one owner of database retry.

An operation passed here is a pure database participant: it reloads canonical state,
flushes before projecting its result, and leaves the same transaction active. This
module owns isolation, commit and bounded retry. Entry with an ambient transaction is
a defect; it is never discarded or joined. Provider and other external effects stay
outside the operation. Every Exception rolls the owned attempt back; a BaseException
(a cancellation) is left to the session's close. Serialization failures, deadlocks,
TransactionRestart and named first-sight races retry. Lock timeout raises
DatabaseBusyError without another attempt. The api maps busy attempts and exhausted
transaction retries to 409; workers keep their existing transient queue retry.
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
        "note_blocks_pkey",
        "reader_profiles_pkey",
        "uq_reader_media_state_user_media",
        "uq_consumption_queue_items_user_media",
        "uq_consumption_completion_facts_user_media",
        "uq_passage_anchors_identity",
        "uq_resource_edges_user_link_pair",
        "highlights_pkey",
        "pages_pkey",
        "libraries_pkey",
        "users_pkey",
        "uix_libraries_one_default_per_user",
        "memberships_pkey",
        "uq_artifacts_subject_audience",
        "uq_artifact_idea_subjects_owner_key",
        "uq_artifact_idea_seeds_pair",
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


class DatabaseBusyError(RuntimeError):
    """An owned attempt could not complete because of a resource lock or transaction conflict.

    This is not an ApiError: worker source owners must retain transient retry.
    """


class DatabaseRetryExhaustedError(DatabaseBusyError):
    """Every attempt ended in a retryable conflict."""

    def __init__(self, label: str, attempts: int) -> None:
        super().__init__(f"{label} exhausted after {attempts} transaction attempts")


def integrity_constraint_name(exc: IntegrityError) -> str | None:
    """The constraint a failed write violated, from psycopg's diagnostics."""
    name = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
    return str(name) if name else None


def retry_serializable[T](db: Session, label: str, op: Callable[[], T], *, retries: int = 3) -> T:
    """Commit `op` in at most `retries` fresh SERIALIZABLE attempts."""
    return _attempts(db, label, op, "SERIALIZABLE", retries)


def retry_read_committed[T](db: Session, label: str, op: Callable[[], T], *, retries: int = 3) -> T:
    """Commit `op` in fresh READ COMMITTED attempts with new snapshots after lock waits."""
    return _attempts(db, label, op, "READ COMMITTED", retries)


def _attempts[T](
    db: Session,
    label: str,
    op: Callable[[], T],
    isolation: Literal["SERIALIZABLE", "READ COMMITTED"],
    retries: int,
) -> T:
    assert not db.in_transaction(), f"{label} requires a fresh transaction"
    attempt = 1
    while True:
        db.connection(execution_options={"isolation_level": isolation})
        transaction = db.get_transaction()
        assert transaction is not None
        try:
            result = op()
            assert db.get_transaction() is transaction and transaction.is_active, (
                f"{label} ended its owned transaction"
            )
            db.commit()
            return result
        except Exception as exc:
            db.rollback()
            if isinstance(exc, OperationalError) and getattr(exc.orig, "sqlstate", None) == "55P03":
                raise DatabaseBusyError(f"{label}: resource lock remained busy") from exc
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
