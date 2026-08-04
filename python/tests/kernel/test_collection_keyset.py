"""Keyset-plan mechanics: one plan must drive ORDER BY, the page predicate, and
the cursor identically, or a paged collection silently skips or repeats rows.

The oracle is the collection-refinement cutover's ordering/cursor rules: every
advertised order is total and stable, missing values partition before any
nullable key is compared, and a cursor is bound to the exact plan that produced
it. Expected SQL below is written from those rules, not read back from the
generator.
"""

from __future__ import annotations

import re

from nexus.services.collection_keyset import (
    SortKey,
    after_values,
    expected_kinds,
    keyset_clause,
    keyset_params,
    order_by_sql,
    plan_json,
)
from nexus.services.signed_keyset_cursor import KeysetValue, KeysetValueKind

# A publication order: the missing-rank key sorts undated works last in both
# directions, the nullable date is the semantic key, and href makes it total.
_PUBLICATION_PLAN = [
    SortKey("date_missing", "asc", KeysetValueKind.Int),
    SortKey("date_key", "desc", KeysetValueKind.TextOrNull),
    SortKey("href", "asc", KeysetValueKind.Text),
]


def test_multi_key_plan_with_a_nullable_key_emits_matching_order_by_and_null_safe_keyset() -> None:
    order_by = order_by_sql(_PUBLICATION_PLAN, alias="facts")
    assert order_by == "facts.date_missing ASC, facts.date_key DESC, facts.href ASC", (
        f"publication plan produced ORDER BY {order_by!r}, which does not follow the plan's"
        " key order and per-key direction"
    )

    clause = keyset_clause(_PUBLICATION_PLAN, alias="facts")
    assert clause == (
        "AND ("
        "(facts.date_missing > :ks_date_missing)"
        " OR (facts.date_missing IS NOT DISTINCT FROM :ks_date_missing"
        " AND facts.date_key < :ks_date_key)"
        " OR (facts.date_missing IS NOT DISTINCT FROM :ks_date_missing"
        " AND facts.date_key IS NOT DISTINCT FROM :ks_date_key"
        " AND facts.href > :ks_href)"
        ")"
    ), (
        f"publication plan produced keyset predicate {clause!r}; each disjunct must compare"
        " the preceding keys with NULL-safe equality and the current key strictly in its own"
        " direction"
    )


def test_keyset_params_bind_exactly_the_placeholders_the_generated_predicate_reads() -> None:
    clause = keyset_clause(_PUBLICATION_PLAN, alias="facts")
    params = keyset_params(_PUBLICATION_PLAN, (0, "2019-04-01", "/media/first"))
    placeholders = set(re.findall(r":(\w+)", clause))
    assert placeholders == set(params), (
        f"publication plan predicate reads {sorted(placeholders)} but the plan supplies"
        f" {sorted(params)}; an unbound or unused placeholder makes the page query unexecutable"
    )
    assert params["ks_date_key"] == "2019-04-01", (
        f"plan bound ks_date_key to {params['ks_date_key']!r} instead of the second cursor value;"
        " values must be assigned in plan order"
    )


def test_cursor_binding_follows_plan_order_for_a_row_whose_nullable_key_is_missing() -> None:
    undated_row = {
        "date_missing": 1,
        "date_key": None,
        "href": "/media/undated",
        "title": "not a key of this plan",
    }
    assert after_values(_PUBLICATION_PLAN, undated_row) == (
        KeysetValue(KeysetValueKind.Int, 1),
        KeysetValue(KeysetValueKind.TextOrNull, None),
        KeysetValue(KeysetValueKind.Text, "/media/undated"),
    ), (
        "undated row produced cursor values that do not follow the publication plan's columns,"
        f" order, and declared kinds: {after_values(_PUBLICATION_PLAN, undated_row)}"
    )
    assert expected_kinds(_PUBLICATION_PLAN) == (
        KeysetValueKind.Int,
        KeysetValueKind.TextOrNull,
        KeysetValueKind.Text,
    ), "decode kinds must match the kinds the same plan encodes"

    assert plan_json(_PUBLICATION_PLAN) == [
        {"column": "date_missing", "direction": "asc", "valueKind": "int"},
        {"column": "date_key", "direction": "desc", "valueKind": "text_or_null"},
        {"column": "href", "direction": "asc", "valueKind": "text"},
    ], (
        "the cursor query digest must describe every key's column, direction, and kind so a"
        " cursor cannot replay under a different order"
    )
