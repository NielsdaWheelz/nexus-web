"""retry_serializable: bounded SERIALIZABLE retry semantics."""

from __future__ import annotations

import pytest
from sqlalchemy.exc import OperationalError

from nexus.db.retries import retry_serializable

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


def test_retry_serializable_reraises_after_exhausting_retries() -> None:
    db = _FakeSession()
    attempts = {"n": 0}

    def op():
        attempts["n"] += 1
        raise _serialization_error()

    with pytest.raises(OperationalError):
        retry_serializable(db, "test_op", op, retries=3)  # type: ignore[arg-type]
    assert attempts["n"] == 3, f"expected exactly 3 attempts, got {attempts['n']}"
    assert db.rollbacks == 3
