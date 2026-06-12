from __future__ import annotations

from collections import Counter
from typing import Any

from tests.reader_apparatus_corpus import expected_counts


def assert_item_counts_match_case(
    items: list[dict[str, Any]],
    case: dict[str, Any],
    *,
    fields: tuple[str, ...] = ("kind", "confidence", "extraction_method"),
) -> None:
    expected_keys = {
        "kind": "item_kinds",
        "confidence": "item_confidences",
        "extraction_method": "item_methods",
    }
    for field in fields:
        assert Counter(item[field] for item in items) == expected_counts(
            case,
            expected_keys[field],
        )


def assert_edge_counts_match_case(
    edges: list[dict[str, Any]],
    case: dict[str, Any],
    *,
    fields: tuple[str, ...] = ("relation", "confidence", "extraction_method"),
) -> None:
    expected_keys = {
        "relation": "edge_relations",
        "confidence": "edge_confidences",
        "extraction_method": "edge_methods",
    }
    for field in fields:
        assert Counter(edge[field] for edge in edges) == expected_counts(
            case,
            expected_keys[field],
        )


def assert_item_and_edge_counts_match_case(
    items: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    case: dict[str, Any],
    *,
    item_fields: tuple[str, ...] = ("kind", "confidence", "extraction_method"),
    edge_fields: tuple[str, ...] = ("relation", "confidence", "extraction_method"),
) -> None:
    assert_item_counts_match_case(items, case, fields=item_fields)
    assert_edge_counts_match_case(edges, case, fields=edge_fields)


def assert_body_needles_present(items: list[dict[str, Any]], needles: object) -> None:
    assert isinstance(needles, list | tuple)
    body_text = "\n".join(str(item.get("body_text") or "") for item in items)
    for needle in needles:
        assert str(needle) in body_text


def assert_edges_point_to_non_reference_targets(
    items: list[dict[str, Any]],
    edges: list[dict[str, Any]],
) -> None:
    by_key = {item["stable_key"]: item for item in items}
    for edge in edges:
        source = by_key[edge["from_stable_key"]]
        target = by_key[edge["to_stable_key"]]
        assert str(source["kind"]).endswith("_ref"), edge
        assert not str(target["kind"]).endswith("_ref"), edge


def assert_edges_point_to_expected_item_kinds(
    items: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    expected: dict[str, tuple[str, str]],
) -> None:
    by_key = {item["stable_key"]: item for item in items}
    for edge in edges:
        source_kind, target_kind = expected[edge["relation"]]
        assert by_key[edge["from_stable_key"]]["kind"] == source_kind, edge
        assert by_key[edge["to_stable_key"]]["kind"] == target_kind, edge


def edge_target_source_ref_values(
    items: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    *,
    source_ref_key: str = "target_id",
) -> tuple[str, ...]:
    by_key = {item["stable_key"]: item for item in items}
    return tuple(str(by_key[edge["to_stable_key"]]["source_ref"][source_ref_key]) for edge in edges)


def edge_source_ref_values(
    edges: list[dict[str, Any]],
    *,
    source_ref_key: str,
) -> tuple[str, ...]:
    return tuple(str(edge["source_ref"][source_ref_key]) for edge in edges)


def edge_source_to_target_source_ref_pairs(
    items: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    *,
    edge_source_ref_key: str,
    target_source_ref_key: str | None = None,
) -> tuple[tuple[str, str], ...]:
    target_key = target_source_ref_key or edge_source_ref_key
    by_key = {item["stable_key"]: item for item in items}
    return tuple(
        (
            str(edge["source_ref"][edge_source_ref_key]),
            str(by_key[edge["to_stable_key"]]["source_ref"][target_key]),
        )
        for edge in edges
    )


def assert_edge_target_source_ref_sequence(
    items: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    expected: tuple[str, ...],
    *,
    source_ref_key: str = "target_id",
) -> None:
    assert (
        edge_target_source_ref_values(
            items,
            edges,
            source_ref_key=source_ref_key,
        )
        == expected
    )


def assert_edge_source_ref_sequence(
    edges: list[dict[str, Any]],
    expected: tuple[str, ...],
    *,
    source_ref_key: str,
) -> None:
    assert edge_source_ref_values(edges, source_ref_key=source_ref_key) == expected


def assert_edge_source_to_target_source_ref_pairs(
    items: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    expected: tuple[tuple[str, str], ...],
    *,
    edge_source_ref_key: str,
    target_source_ref_key: str | None = None,
) -> None:
    assert (
        edge_source_to_target_source_ref_pairs(
            items,
            edges,
            edge_source_ref_key=edge_source_ref_key,
            target_source_ref_key=target_source_ref_key,
        )
        == expected
    )
