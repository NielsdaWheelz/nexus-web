"""Keyset-plan mechanics shared by every revisioned collection listing.

One ``SortKey`` plan is the single source for a listing's ``ORDER BY``, its
strict page predicate, the cursor's ``after`` values, and the cursor's query
digest, so those four can never disagree. Each collection owner keeps its own
plan construction — the sort vocabulary is domain language — and shares only
this mechanism.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from nexus.services.signed_keyset_cursor import KeysetScalar, KeysetValue, KeysetValueKind

type Direction = Literal["asc", "desc"]


@dataclass(frozen=True, slots=True)
class SortKey:
    """One key of a total keyset order: a projected column (== cursor ``after``
    key), its direction, and how the value round-trips through the cursor."""

    column: str
    direction: Direction
    value: KeysetValueKind


def order_by_sql(plan: Sequence[SortKey], *, alias: str) -> str:
    return ", ".join(f"{alias}.{key.column} {key.direction.upper()}" for key in plan)


def keyset_clause(plan: Sequence[SortKey], *, alias: str) -> str:
    """Generic strict keyset over the plan. Equality via ``IS NOT DISTINCT FROM``
    is NULL-safe; strict ``<``/``>`` on a NULL bound yields NULL (false), which is
    correct because a plan places its missing-rank key before any nullable value
    key, so the present/missing buckets are already partitioned."""
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


def keyset_params(plan: Sequence[SortKey], values: Sequence[KeysetScalar]) -> dict[str, object]:
    return {f"ks_{key.column}": value for key, value in zip(plan, values, strict=True)}


def plan_json(plan: Sequence[SortKey]) -> list[dict[str, str]]:
    """The plan's identity inside a cursor's query digest, so a cursor minted
    under one order is never accepted under another."""
    return [
        {"column": key.column, "direction": key.direction, "valueKind": key.value.value}
        for key in plan
    ]


def after_values(plan: Sequence[SortKey], row: Mapping[Any, Any]) -> tuple[KeysetValue, ...]:
    return tuple(KeysetValue(key.value, row[key.column]) for key in plan)


def expected_kinds(plan: Sequence[SortKey]) -> tuple[KeysetValueKind, ...]:
    return tuple(key.value for key in plan)
