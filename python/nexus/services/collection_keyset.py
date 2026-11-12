"""Keyset pages: one total order per list drives its ORDER BY, its strict page predicate
and its cursor, so the three cannot disagree.

A cursor is unpadded base64url JSON ``{"after": [...], "binding": "<sha256>"}``: the last
row's sort values and a digest of the list's binding (its name, viewer, scope and view),
the plan and those values. Anyone can mint one, so decoding checks the digest, the arity
and every value's kind; any failure is E_INVALID_CURSOR and nothing is reinterpreted.

Following cursors until none is returned yields every row whose sort values do not change
during the walk exactly once, in plan order. A row that moves across the cursor meanwhile
can be missed (until the next read from the first page) or seen twice (the client keeps
the first); see docs/architecture.md §8.12.
"""

import base64
import binascii
import hashlib
import json
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import RowMapping, text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError

type Direction = Literal["asc", "desc"]
_MAX_CURSOR_CHARS = 16_384
_INT64 = 2**63


class KeysetValueKind(StrEnum):
    """How one sort value round-trips through the cursor's JSON."""

    Int = "int"
    FloatOrNull = "float_or_null"
    DateTime = "datetime"
    DateTimeOrNull = "datetime_or_null"
    Uuid = "uuid"
    Text = "text"
    TextOrNull = "text_or_null"


_NULLABLE = {
    KeysetValueKind.FloatOrNull,
    KeysetValueKind.DateTimeOrNull,
    KeysetValueKind.TextOrNull,
}


@dataclass(frozen=True, slots=True)
class SortKey:
    """One key of a total order: a projected column (the row key the cursor reads), its
    direction and its value kind. A plan ends in a unique key, and a nullable key follows
    the key that partitions its NULLs, so the strict predicate below is total."""

    column: str
    direction: Direction
    value: KeysetValueKind


def order_by_sql(plan: Sequence[SortKey], *, alias: str) -> str:
    return ", ".join(f"{alias}.{key.column} {key.direction.upper()}" for key in plan)


def keyset_clause(plan: Sequence[SortKey], *, alias: str) -> str:
    """The rows strictly after ``:ks_<column>`` in plan order. Equality is NULL-safe; a
    strict comparison against a NULL bound is false, which the partitioning key makes
    correct."""
    ors = []
    for index, key in enumerate(plan):
        conj = [
            f"{alias}.{earlier.column} IS NOT DISTINCT FROM :ks_{earlier.column}"
            for earlier in plan[:index]
        ]
        op = ">" if key.direction == "asc" else "<"
        conj.append(f"{alias}.{key.column} {op} :ks_{key.column}")
        ors.append("(" + " AND ".join(conj) + ")")
    return "AND (" + " OR ".join(ors) + ")"


def _digest(binding: Mapping[str, object], plan: Sequence[SortKey], after: list[object]) -> str:
    identity = {
        "after": after,
        "binding": binding,
        "plan": [[key.column, key.direction, key.value] for key in plan],
    }
    canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


def encode_keyset_cursor(
    binding: Mapping[str, object], plan: Sequence[SortKey], row: Mapping[Any, Any]
) -> str:
    """The cursor after ``row`` (any mapping holding the plan's columns)."""
    after: list[object] = []
    for key in plan:
        value = row[key.column]
        if isinstance(value, datetime):
            value = value.isoformat()
        elif isinstance(value, UUID):
            value = str(value)
        after.append(value)
    body = {"after": after, "binding": _digest(binding, plan, after)}
    raw = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _decoded(kind: KeysetValueKind, value: object) -> object:
    if value is None and kind in _NULLABLE:
        return None
    match kind:
        case KeysetValueKind.Int if type(value) is int and -_INT64 <= value < _INT64:
            return value
        case KeysetValueKind.FloatOrNull if type(value) is float and math.isfinite(value):
            return value
        case KeysetValueKind.DateTime | KeysetValueKind.DateTimeOrNull if isinstance(value, str):
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is not None:
                return parsed
        case KeysetValueKind.Uuid if isinstance(value, str):
            return UUID(value)
        case KeysetValueKind.Text | KeysetValueKind.TextOrNull if isinstance(value, str):
            # Postgres text binds neither NUL nor a lone surrogate (UnicodeEncodeError).
            value.encode()
            if "\x00" not in value:
                return value
        case _:
            pass
    raise ValueError("cursor value does not match its sort key")


def decode_keyset_cursor(
    cursor: str, binding: Mapping[str, object], plan: Sequence[SortKey]
) -> tuple[object, ...]:
    """The after-values of a cursor issued under this exact binding and plan."""
    try:
        if len(cursor) > _MAX_CURSOR_CHARS:
            raise ValueError("cursor too long")
        padded = cursor + "=" * (-len(cursor) % 4)
        body = json.loads(base64.b64decode(padded, altchars=b"-_", validate=True))
        if not isinstance(body, dict) or body.keys() != {"after", "binding"}:
            raise ValueError("not a cursor")
        after = body["after"]
        if (
            not isinstance(after, list)
            or len(after) != len(plan)
            or body["binding"] != _digest(binding, plan, after)
        ):
            raise ValueError("cursor is not bound to this list")
        return tuple(_decoded(key.value, value) for key, value in zip(plan, after, strict=True))
    except (ValueError, TypeError, RecursionError, binascii.Error) as exc:
        # justify-ignore-error: a malformed or foreign cursor is one expected API error.
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor") from exc


def keyset_page(
    db: Session,
    *,
    binding: Mapping[str, object],
    plan: Sequence[SortKey],
    cursor: str | None,
    limit: int,
    params: Mapping[str, object],
    sql: Callable[[str, str], str],
    alias: str = "facts",
) -> tuple[list[RowMapping], str | None]:
    """One page of at most ``limit`` rows and the cursor after it (None at the end).

    ``sql(predicate, order_by)`` selects ``LIMIT :limit`` rows of ``alias`` with the
    predicate appended to its WHERE clause; this binds ``limit + 1`` to see the end.
    """
    bound = {**params, "limit": limit + 1}
    predicate = ""
    if cursor is not None:
        predicate = keyset_clause(plan, alias=alias)
        after = decode_keyset_cursor(cursor, binding, plan)
        bound |= {f"ks_{key.column}": value for key, value in zip(plan, after, strict=True)}
    statement = text(sql(predicate, order_by_sql(plan, alias=alias)))
    rows = db.execute(statement, bound).mappings().all()
    page = list(rows[:limit])
    return page, encode_keyset_cursor(binding, plan, page[-1]) if len(rows) > limit else None
