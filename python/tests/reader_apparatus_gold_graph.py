from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

from tests.reader_apparatus_corpus import FIXTURES_ROOT

GOLD_GRAPHS_ROOT = FIXTURES_ROOT / "reader_apparatus" / "gold_graphs"
GOLD_GRAPH_COVERAGE = {
    "adapter_scope_exhaustive",
    "fixture_exhaustive",
    "negative_exhaustive",
    "sample_scope",
}


def load_reader_apparatus_gold_graph(fixture_id: str) -> dict[str, Any]:
    path = GOLD_GRAPHS_ROOT / f"{fixture_id}.json"
    graph = json.loads(path.read_text(encoding="utf-8"))
    validate_reader_apparatus_gold_graph(graph, path=path)
    if graph["fixture_id"] != fixture_id:
        raise AssertionError(f"{path} fixture_id does not match {fixture_id}")
    return graph


def validate_reader_apparatus_gold_graph(
    graph: dict[str, Any],
    *,
    path: Path | None = None,
) -> None:
    label = str(path) if path is not None else graph.get("fixture_id", "<unknown>")
    required = {
        "schema_version",
        "fixture_id",
        "fixture_sha256",
        "coverage",
        "audit_basis",
        "items",
        "edges",
        "expected_absences",
        "diagnostics",
    }
    missing = required - set(graph)
    if missing:
        raise AssertionError(f"{label} missing gold graph keys: {sorted(missing)}")
    if graph["schema_version"] != 1:
        raise AssertionError(f"{label} has unsupported gold graph schema")
    if graph["coverage"] not in GOLD_GRAPH_COVERAGE:
        raise AssertionError(f"{label} has unknown coverage: {graph['coverage']}")
    if not re.fullmatch(r"[a-f0-9]{64}", graph["fixture_sha256"]):
        raise AssertionError(f"{label} fixture_sha256 must be a SHA-256 hex digest")
    if len({item["gold_key"] for item in graph["items"]}) != len(graph["items"]):
        raise AssertionError(f"{label} item gold_key values must be unique")

    gold_keys = {item["gold_key"] for item in graph["items"]}
    for edge in graph["edges"]:
        if edge["from_gold_key"] not in gold_keys:
            raise AssertionError(f"{label} edge references unknown source: {edge}")
        if edge["to_gold_key"] not in gold_keys:
            raise AssertionError(f"{label} edge references unknown target: {edge}")

    if graph["coverage"] == "negative_exhaustive":
        if graph["items"] or graph["edges"]:
            raise AssertionError(f"{label} negative gold graphs must not contain items or edges")
    _validate_tei_hand_gold_ref_matrix(graph, label=label)


def _validate_tei_hand_gold_ref_matrix(graph: dict[str, Any], *, label: str) -> None:
    diagnostics = graph.get("diagnostics")
    if not isinstance(diagnostics, dict):
        return
    matrix = diagnostics.get("hand_gold_ref_matrix")
    if matrix is None:
        return
    if graph["coverage"] != "sample_scope":
        raise AssertionError(f"{label} TEI hand-gold matrices must be sample-scope")
    if not isinstance(matrix, list) or not matrix:
        raise AssertionError(f"{label} hand_gold_ref_matrix must be a non-empty list")

    required = {
        "declared_target_id",
        "expected_edge_count",
        "expected_target_ids",
        "ordinal",
        "ref_text",
        "source_target_id",
        "stratum",
    }
    seen_ordinals: set[int] = set()
    for row in matrix:
        if not isinstance(row, dict):
            raise AssertionError(f"{label} matrix rows must be objects: {row}")
        missing = required - set(row)
        if missing:
            raise AssertionError(f"{label} matrix row missing keys: {sorted(missing)}")
        ordinal = row["ordinal"]
        if not isinstance(ordinal, int):
            raise AssertionError(f"{label} matrix ordinal must be int: {row}")
        if ordinal in seen_ordinals:
            raise AssertionError(f"{label} duplicate matrix ordinal: {ordinal}")
        seen_ordinals.add(ordinal)

        expected_targets = row["expected_target_ids"]
        if not isinstance(expected_targets, list) or any(
            not isinstance(target_id, str) or not target_id for target_id in expected_targets
        ):
            raise AssertionError(f"{label} expected_target_ids must be strings: {row}")
        expected_edge_count = row["expected_edge_count"]
        if not isinstance(expected_edge_count, int) or expected_edge_count < 0:
            raise AssertionError(f"{label} expected_edge_count must be non-negative: {row}")
        if expected_edge_count != len(expected_targets):
            raise AssertionError(f"{label} matrix edge count must match targets: {row}")
        if not isinstance(row["ref_text"], str) or not row["ref_text"]:
            raise AssertionError(f"{label} matrix ref_text must be a non-empty string: {row}")
        if row["source_target_id"] is not None and not isinstance(row["source_target_id"], str):
            raise AssertionError(f"{label} source_target_id must be string/null: {row}")
        if row["declared_target_id"] is not None and not isinstance(row["declared_target_id"], str):
            raise AssertionError(f"{label} declared_target_id must be string/null: {row}")
        suppressed_candidates = row.get("suppressed_candidate_target_ids", [])
        if not isinstance(suppressed_candidates, list) or any(
            not isinstance(target_id, str) or not target_id for target_id in suppressed_candidates
        ):
            raise AssertionError(f"{label} suppressed candidates must be strings: {row}")

        if expected_edge_count:
            if row.get("resolution_method") not in {
                "grobid_tei_bibliography_ref",
                "grobid_tei_author_year_match",
            }:
                raise AssertionError(f"{label} matrix positive row needs method: {row}")
        elif "resolution_method" in row:
            raise AssertionError(f"{label} matrix zero-edge row must not set method: {row}")

    selected_ref_ordinals = diagnostics.get("selected_ref_ordinals")
    if isinstance(selected_ref_ordinals, list) and set(selected_ref_ordinals) != seen_ordinals:
        raise AssertionError(f"{label} selected_ref_ordinals must match matrix ordinals")


def assert_reader_apparatus_matches_gold_graph(
    apparatus: dict[str, Any],
    gold_graph: dict[str, Any],
) -> None:
    validate_reader_apparatus_gold_graph(gold_graph)
    if gold_graph["coverage"] == "negative_exhaustive":
        assert apparatus["items"] == []
        assert apparatus["edges"] == []
        assert apparatus["status"] == "empty"
        return

    gold_item_signatures_by_key = {
        item["gold_key"]: _gold_item_signature(item) for item in gold_graph["items"]
    }
    actual_items_by_key = {item["stable_key"]: item for item in apparatus["items"]}
    actual_item_signatures_by_key = {
        stable_key: _actual_item_signature(item) for stable_key, item in actual_items_by_key.items()
    }

    actual_item_signatures = Counter(actual_item_signatures_by_key.values())
    gold_item_signatures = Counter(gold_item_signatures_by_key.values())
    if gold_graph["coverage"] == "sample_scope":
        assert gold_item_signatures - actual_item_signatures == Counter()
    else:
        assert actual_item_signatures == gold_item_signatures

    include_edge_source_ref = any("source_ref" in edge for edge in gold_graph["edges"])
    gold_edge_signatures = Counter(
        _edge_signature(
            from_item_signature=gold_item_signatures_by_key[edge["from_gold_key"]],
            to_item_signature=gold_item_signatures_by_key[edge["to_gold_key"]],
            edge=edge,
            include_source_ref=include_edge_source_ref,
        )
        for edge in gold_graph["edges"]
    )
    actual_edge_signatures = Counter(
        _edge_signature(
            from_item_signature=actual_item_signatures_by_key[edge["from_stable_key"]],
            to_item_signature=actual_item_signatures_by_key[edge["to_stable_key"]],
            edge=edge,
            include_source_ref=include_edge_source_ref,
        )
        for edge in apparatus["edges"]
    )
    if gold_graph["coverage"] == "sample_scope":
        assert gold_edge_signatures - actual_edge_signatures == Counter()
    else:
        assert actual_edge_signatures == gold_edge_signatures

    _assert_expected_absences(
        apparatus=apparatus,
        expected_absences=gold_graph["expected_absences"],
    )


def normalized_body_sha256(text: str | None) -> str:
    normalized = re.sub(r"\s+", " ", text or "").strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _edge_signature(
    *,
    from_item_signature: tuple[object, ...],
    to_item_signature: tuple[object, ...],
    edge: dict[str, Any],
    include_source_ref: bool,
) -> tuple[object, ...]:
    signature = (
        from_item_signature,
        to_item_signature,
        edge["relation"],
        edge["confidence"],
        edge["extraction_method"],
    )
    if not include_source_ref:
        return signature
    return (*signature, _edge_source_ref_signature(edge.get("source_ref") or {}))


def _edge_source_ref_signature(source_ref: dict[str, Any]) -> tuple[object, ...]:
    return (
        source_ref.get("format"),
        source_ref.get("tei_sha256"),
        source_ref.get("tei_element"),
        source_ref.get("fragment_idx"),
        source_ref.get("element"),
        source_ref.get("toggle_id"),
        source_ref.get("citation_ordinal"),
        source_ref.get("citation_key"),
        source_ref.get("note_id"),
        source_ref.get("target_id"),
        source_ref.get("marker_href"),
        source_ref.get("marker_id"),
        source_ref.get("note_number"),
        source_ref.get("ordinal"),
        source_ref.get("ref_text"),
        tuple(source_ref.get("resolved_target_ids") or ()),
        source_ref.get("coords"),
        source_ref.get("resolution_method"),
        source_ref.get("named_destination"),
        source_ref.get("page_number"),
        source_ref.get("link_index"),
        source_ref.get("link_xref"),
        source_ref.get("destination_page_number"),
        _pdf_point_signature(source_ref.get("destination_point")),
        _pdf_rect_signature(source_ref.get("source_rect")),
    )


def _assert_expected_absences(
    *,
    apparatus: dict[str, Any],
    expected_absences: list[dict[str, Any]],
) -> None:
    items_by_key = {item["stable_key"]: item for item in apparatus["items"]}
    edge_count_by_from_key = Counter(edge["from_stable_key"] for edge in apparatus["edges"])
    for absence in expected_absences:
        kind = absence.get("kind")
        if kind == "distill_uncited_bibliography_keys":
            keys = set(absence["keys"])
            assert len(keys) == int(absence["expected_count"]), absence
            emitted_keys = sorted(
                key
                for item in items_by_key.values()
                if (key := item["source_ref"].get("citation_key")) in keys
            )
            assert emitted_keys == [], absence
            continue
        if kind != "tei_ref_edges":
            continue
        expected_count = int(absence["expected_count"])
        source_ref = absence["source_ref"]
        matching_items = [
            item
            for item in items_by_key.values()
            if item["kind"] == "bibliography_ref"
            and item["source_ref"].get("format") == "grobid_tei"
            and item["source_ref"].get("ordinal") == source_ref["ordinal"]
        ]
        assert len(matching_items) == 1, absence
        actual_source_ref = matching_items[0]["source_ref"]
        for key, expected_value in source_ref.items():
            assert actual_source_ref.get(key) == expected_value, absence
        assert edge_count_by_from_key[matching_items[0]["stable_key"]] == expected_count


def _actual_item_signature(item: dict[str, Any]) -> tuple[object, ...]:
    kind = item["kind"]
    source_ref = item["source_ref"]
    if kind == "bibliography_ref":
        if source_ref.get("format") == "pdf":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("page_number"),
                source_ref.get("link_index"),
                source_ref.get("link_xref"),
                source_ref.get("named_destination"),
                source_ref.get("destination_page_number"),
                _pdf_point_signature(source_ref.get("destination_point")),
                _pdf_rect_signature(source_ref.get("source_rect")),
                item["confidence"],
                item["extraction_method"],
            )
        if source_ref.get("format") == "grobid_tei":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("tei_sha256"),
                source_ref.get("adapter_version"),
                source_ref.get("tei_element"),
                source_ref.get("ordinal"),
                source_ref.get("ref_type"),
                source_ref.get("ref_text"),
                source_ref.get("target_id"),
                tuple(source_ref.get("resolved_target_ids") or ()),
                source_ref.get("coords"),
                item["confidence"],
                item["extraction_method"],
            )
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("element"),
            source_ref.get("note_id"),
            source_ref.get("target_id"),
            source_ref.get("marker_href"),
            source_ref.get("marker_id"),
            source_ref.get("citation_ordinal"),
            tuple(source_ref.get("citation_keys") or ()),
            item["confidence"],
            item["extraction_method"],
        )
    if kind == "bibliography_entry":
        if source_ref.get("format") == "pdf":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("named_destination"),
                source_ref.get("target_label"),
                source_ref.get("target_page_number"),
                _pdf_point_signature(source_ref.get("destination_point")),
                _pdf_rect_signature(source_ref.get("reference_block")),
                normalized_body_sha256(item.get("body_text")),
                item["confidence"],
                item["extraction_method"],
            )
        if source_ref.get("format") == "grobid_tei":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("tei_sha256"),
                source_ref.get("adapter_version"),
                source_ref.get("tei_element"),
                source_ref.get("target_id"),
                source_ref.get("coords"),
                normalized_body_sha256(item.get("body_text")),
                item["confidence"],
                item["extraction_method"],
            )
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("element"),
            source_ref.get("citation_ordinal"),
            source_ref.get("citation_key"),
            source_ref.get("target_id"),
            normalized_body_sha256(item.get("body_text")),
            item["confidence"],
            item["extraction_method"],
        )
    if kind == "endnote_ref":
        if source_ref.get("format") == "html":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("fragment_idx"),
                source_ref.get("element"),
                source_ref.get("marker_id"),
                source_ref.get("target_id"),
                source_ref.get("note_number"),
                source_ref.get("marker_href"),
                item["confidence"],
                item["extraction_method"],
            )
        return (
            kind,
            item["label"],
            source_ref.get("package_href"),
            source_ref.get("marker_id"),
            source_ref.get("target_id"),
            source_ref.get("target_ref"),
            item["confidence"],
            item["extraction_method"],
        )
    if kind == "endnote":
        if source_ref.get("format") == "html":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("fragment_idx"),
                source_ref.get("element"),
                source_ref.get("target_anchor_element"),
                source_ref.get("target_id"),
                source_ref.get("note_number"),
                source_ref.get("backlink_href"),
                normalized_body_sha256(item.get("body_text")),
                item["confidence"],
                item["extraction_method"],
            )
        return (
            kind,
            item["label"],
            source_ref.get("package_href"),
            source_ref.get("target_id"),
            _target_ref(source_ref),
            normalized_body_sha256(item.get("body_text")),
            item["confidence"],
            item["extraction_method"],
        )
    if kind == "footnote_ref":
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("target_id"),
            source_ref.get("marker_id"),
            source_ref.get("element"),
            source_ref.get("ordinal"),
            item["confidence"],
            item["extraction_method"],
        )
    if kind == "footnote":
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("target_id"),
            source_ref.get("element"),
            source_ref.get("ordinal"),
            normalized_body_sha256(item.get("body_text")),
            item["confidence"],
            item["extraction_method"],
        )
    if kind in {"margin_note", "sidenote"}:
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("element"),
            source_ref.get("toggle_id"),
            source_ref.get("ordinal"),
            normalized_body_sha256(item.get("body_text")),
            item["confidence"],
            item["extraction_method"],
        )
    if kind in {"margin_note_ref", "sidenote_ref"}:
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("element"),
            source_ref.get("toggle_id"),
            source_ref.get("ordinal"),
            item["confidence"],
            item["extraction_method"],
        )
    raise AssertionError(f"Gold graph comparator does not support item kind yet: {kind}")


def _gold_item_signature(item: dict[str, Any]) -> tuple[object, ...]:
    kind = item["kind"]
    source_ref = item["source_ref"]
    if kind == "bibliography_ref":
        if source_ref.get("format") == "pdf":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("page_number"),
                source_ref.get("link_index"),
                source_ref.get("link_xref"),
                source_ref.get("named_destination"),
                source_ref.get("destination_page_number"),
                _pdf_point_signature(source_ref.get("destination_point")),
                _pdf_rect_signature(source_ref.get("source_rect")),
                item["confidence"],
                item["extraction_method"],
            )
        if source_ref.get("format") == "grobid_tei":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("tei_sha256"),
                source_ref.get("adapter_version"),
                source_ref.get("tei_element"),
                source_ref.get("ordinal"),
                source_ref.get("ref_type"),
                source_ref.get("ref_text"),
                source_ref.get("target_id"),
                tuple(source_ref.get("resolved_target_ids") or ()),
                source_ref.get("coords"),
                item["confidence"],
                item["extraction_method"],
            )
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("element"),
            source_ref.get("note_id"),
            source_ref.get("target_id"),
            source_ref.get("marker_href"),
            source_ref.get("marker_id"),
            source_ref.get("citation_ordinal"),
            tuple(source_ref.get("citation_keys") or ()),
            item["confidence"],
            item["extraction_method"],
        )
    if kind == "bibliography_entry":
        if source_ref.get("format") == "pdf":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("named_destination"),
                source_ref.get("target_label"),
                source_ref.get("target_page_number"),
                _pdf_point_signature(source_ref.get("destination_point")),
                _pdf_rect_signature(source_ref.get("reference_block")),
                item["body_sha256"],
                item["confidence"],
                item["extraction_method"],
            )
        if source_ref.get("format") == "grobid_tei":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("tei_sha256"),
                source_ref.get("adapter_version"),
                source_ref.get("tei_element"),
                source_ref.get("target_id"),
                source_ref.get("coords"),
                item["body_sha256"],
                item["confidence"],
                item["extraction_method"],
            )
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("element"),
            source_ref.get("citation_ordinal"),
            source_ref.get("citation_key"),
            source_ref.get("target_id"),
            item["body_sha256"],
            item["confidence"],
            item["extraction_method"],
        )
    if kind == "endnote_ref":
        if source_ref.get("format") == "html":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("fragment_idx"),
                source_ref.get("element"),
                source_ref.get("marker_id"),
                source_ref.get("target_id"),
                source_ref.get("note_number"),
                source_ref.get("marker_href"),
                item["confidence"],
                item["extraction_method"],
            )
        return (
            kind,
            item["label"],
            source_ref.get("package_href"),
            source_ref.get("marker_id"),
            source_ref.get("target_id"),
            source_ref.get("target_ref"),
            item["confidence"],
            item["extraction_method"],
        )
    if kind == "endnote":
        if source_ref.get("format") == "html":
            return (
                kind,
                item["label"],
                source_ref.get("format"),
                source_ref.get("fragment_idx"),
                source_ref.get("element"),
                source_ref.get("target_anchor_element"),
                source_ref.get("target_id"),
                source_ref.get("note_number"),
                source_ref.get("backlink_href"),
                item["body_sha256"],
                item["confidence"],
                item["extraction_method"],
            )
        return (
            kind,
            item["label"],
            source_ref.get("package_href"),
            source_ref.get("target_id"),
            _target_ref(source_ref),
            item["body_sha256"],
            item["confidence"],
            item["extraction_method"],
        )
    if kind == "footnote_ref":
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("target_id"),
            source_ref.get("marker_id"),
            source_ref.get("element"),
            source_ref.get("ordinal"),
            item["confidence"],
            item["extraction_method"],
        )
    if kind == "footnote":
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("target_id"),
            source_ref.get("element"),
            source_ref.get("ordinal"),
            item["body_sha256"],
            item["confidence"],
            item["extraction_method"],
        )
    if kind in {"margin_note", "sidenote"}:
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("element"),
            source_ref.get("toggle_id"),
            source_ref.get("ordinal"),
            item["body_sha256"],
            item["confidence"],
            item["extraction_method"],
        )
    if kind in {"margin_note_ref", "sidenote_ref"}:
        return (
            kind,
            item["label"],
            source_ref.get("format"),
            source_ref.get("fragment_idx"),
            source_ref.get("element"),
            source_ref.get("toggle_id"),
            source_ref.get("ordinal"),
            item["confidence"],
            item["extraction_method"],
        )
    raise AssertionError(f"Gold graph comparator does not support item kind yet: {kind}")


def _target_ref(source_ref: dict[str, Any]) -> str:
    target_ref = source_ref.get("target_ref")
    if isinstance(target_ref, str) and target_ref:
        return target_ref
    return f"{source_ref.get('package_href')}#{source_ref.get('target_id')}"


def _pdf_point_signature(point: object) -> tuple[float, float] | None:
    if not isinstance(point, dict):
        return None
    return (_pdf_number(point["x"]), _pdf_number(point["y"]))


def _pdf_rect_signature(rect: object) -> tuple[float, float, float, float] | None:
    if not isinstance(rect, dict):
        return None
    return (
        _pdf_number(rect["left"]),
        _pdf_number(rect["top"]),
        _pdf_number(rect["right"]),
        _pdf_number(rect["bottom"]),
    )


def _pdf_number(value: object) -> float:
    return round(float(value), 3)
