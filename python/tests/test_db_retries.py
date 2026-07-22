"""retry_serializable: bounded SERIALIZABLE retry semantics."""

from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError, OperationalError

from nexus.db.errors import DatabaseRetryExhaustedError, TransactionRestart
from nexus.db.retries import retry_read_committed, retry_serializable

pytestmark = pytest.mark.unit


class _FakeBind:
    def in_transaction(self) -> bool:
        return True


class _FakeSession:
    """Stand-in: retry_serializable only calls get_bind/in_transaction/rollback."""

    def __init__(self) -> None:
        self.rollbacks = 0

    def get_bind(self) -> _FakeBind:
        return _FakeBind()

    def in_transaction(self) -> bool:
        return True

    def rollback(self) -> None:
        self.rollbacks += 1


class _FakeOrig:
    def __init__(self, *, sqlstate: str, message: str) -> None:
        self.sqlstate = sqlstate
        self._message = message

    def __str__(self) -> str:
        return self._message


def _serialization_error() -> OperationalError:
    return OperationalError(
        "UPDATE ...", {}, _FakeOrig(sqlstate="40001", message="could not serialize access")
    )


def _deadlock_error() -> OperationalError:
    return OperationalError(
        "UPDATE ...", {}, _FakeOrig(sqlstate="40P01", message="deadlock detected")
    )


class _FakeDiag:
    def __init__(self, constraint_name: str | None) -> None:
        self.constraint_name = constraint_name


class _FakeIntegrityOrig:
    """Stand-in for psycopg's ``orig``: exposes ``.diag.constraint_name`` (or none)."""

    def __init__(self, *, constraint_name: str | None) -> None:
        self.diag = _FakeDiag(constraint_name) if constraint_name is not None else None

    def __str__(self) -> str:
        return "duplicate key value violates unique constraint"


def _integrity_error(constraint_name: str | None) -> IntegrityError:
    return IntegrityError("INSERT ...", {}, _FakeIntegrityOrig(constraint_name=constraint_name))


class _FakeIntegrityOrigNoDiag:
    """Stand-in for a driver ``orig`` that never populates ``.diag`` at all."""

    def __str__(self) -> str:
        return "duplicate key value violates unique constraint"


def _integrity_error_missing_diag() -> IntegrityError:
    return IntegrityError("INSERT ...", {}, _FakeIntegrityOrigNoDiag())


def test_retry_serializable_retries_serialization_failure_then_succeeds() -> None:
    db = _FakeSession()
    attempts = {"n": 0}

    def op():
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise _serialization_error()
        return "ok"

    assert retry_serializable(db, "test_op", op) == "ok"  # type: ignore[arg-type]
    assert attempts["n"] == 2
    assert db.rollbacks == 1


def test_retry_serializable_propagates_non_serialization_error() -> None:
    db = _FakeSession()
    attempts = {"n": 0}

    def op():
        attempts["n"] += 1
        raise OperationalError("UPDATE ...", {}, _FakeOrig(sqlstate="42P01", message="undefined"))

    with pytest.raises(OperationalError):
        retry_serializable(db, "test_op", op)  # type: ignore[arg-type]
    assert attempts["n"] == 1, "non-serialization failures must not be retried"
    assert db.rollbacks == 1


def test_retry_serializable_defect_wraps_exhaustion() -> None:
    db = _FakeSession()
    attempts = {"n": 0}

    def op():
        attempts["n"] += 1
        raise _serialization_error()

    with pytest.raises(DatabaseRetryExhaustedError) as excinfo:
        retry_serializable(db, "test_op", op, retries=3)  # type: ignore[arg-type]
    assert attempts["n"] == 3, f"expected exactly 3 attempts, got {attempts['n']}"
    assert db.rollbacks == 3
    assert isinstance(excinfo.value.__cause__, OperationalError)


def test_retry_read_committed_retries_deadlock_then_succeeds() -> None:
    db = _FakeSession()
    attempts = {"n": 0}

    def op():
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise _deadlock_error()
        return "ok"

    assert retry_read_committed(db, "test_op", op) == "ok"  # type: ignore[arg-type]
    assert attempts["n"] == 2
    assert db.rollbacks == 1


def test_retry_read_committed_retries_explicit_transaction_restart() -> None:
    db = _FakeSession()
    attempts = {"n": 0}

    def op():
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise TransactionRestart("locked library membership set changed")
        return "ok"

    assert retry_read_committed(db, "test_op", op) == "ok"  # type: ignore[arg-type]
    assert attempts["n"] == 2
    assert db.rollbacks == 1


def test_retry_read_committed_defect_wraps_restart_exhaustion() -> None:
    db = _FakeSession()

    def op():
        raise TransactionRestart("locked library membership set changed")

    with pytest.raises(DatabaseRetryExhaustedError) as excinfo:
        retry_read_committed(db, "library_delete", op, retries=3)  # type: ignore[arg-type]
    assert isinstance(excinfo.value.__cause__, TransactionRestart)
    assert db.rollbacks == 3


def test_retry_serializable_retries_allowlisted_integrity_error_then_succeeds() -> None:
    db = _FakeSession()
    attempts = {"n": 0}

    def op():
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise _integrity_error("uq_contributors_handle")
        return "ok"

    assert retry_serializable(db, "test_op", op) == "ok"  # type: ignore[arg-type]
    assert attempts["n"] == 2
    assert db.rollbacks == 1


def test_retry_serializable_propagates_non_allowlisted_integrity_error() -> None:
    db = _FakeSession()
    attempts = {"n": 0}

    def op():
        attempts["n"] += 1
        raise _integrity_error("ck_some_unrelated_check")

    with pytest.raises(IntegrityError):
        retry_serializable(db, "test_op", op)  # type: ignore[arg-type]
    assert attempts["n"] == 1, "non-allowlisted constraint violations must not be retried"
    assert db.rollbacks == 1


def test_retry_serializable_propagates_integrity_error_missing_diag() -> None:
    db = _FakeSession()
    attempts = {"n": 0}

    def op():
        attempts["n"] += 1
        raise _integrity_error_missing_diag()

    with pytest.raises(IntegrityError):
        retry_serializable(db, "test_op", op)  # type: ignore[arg-type]
    assert attempts["n"] == 1, "a missing orig.diag must not be treated as retryable"
    assert db.rollbacks == 1


def test_retry_serializable_defect_wraps_integrity_exhaustion() -> None:
    db = _FakeSession()
    attempts = {"n": 0}

    def op():
        attempts["n"] += 1
        raise _integrity_error("uix_resource_mutations_client_id")

    with pytest.raises(DatabaseRetryExhaustedError) as excinfo:
        retry_serializable(db, "test_op", op, retries=3)  # type: ignore[arg-type]
    assert attempts["n"] == 3, f"expected exactly 3 attempts, got {attempts['n']}"
    assert db.rollbacks == 3
    assert isinstance(excinfo.value.__cause__, IntegrityError)


def test_retry_serializable_retries_reader_profile_pkey_race_then_succeeds() -> None:
    """A concurrent first PATCH-insert race on reader_profiles is retryable,
    not a defect: the whole attempt reruns so the SELECT observes the winner."""
    db = _FakeSession()
    attempts = {"n": 0}

    def op():
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise _integrity_error("reader_profiles_pkey")
        return "ok"

    assert retry_serializable(db, "test_op", op) == "ok"  # type: ignore[arg-type]
    assert attempts["n"] == 2
    assert db.rollbacks == 1
