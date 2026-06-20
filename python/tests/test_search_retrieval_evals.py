"""Offline retrieval evals for search-backed ``app_search``."""

from __future__ import annotations

import json
import math
import time
from collections import Counter
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.errors import ApiError
from nexus.services.agent_tools.app_search import (
    APP_SEARCH_CONTEXT_CHARS,
    APP_SEARCH_SELECTED_LIMIT,
    _resolve_scope_uris,
    execute_app_search,
    render_retrieved_context_blocks,
)
from nexus.services.retrieval_citation import RetrievalCitation, citation_from_search_result
from nexus.services.search import get_search_result, search
from nexus.services.search.batch import search_scopes
from nexus.services.search.kinds import SEARCH_KINDS
from nexus.services.search.policy import (
    APP_SEARCH_DEEP_CANDIDATE_LIMIT,
    APP_SEARCH_SCOPED_CANDIDATE_LIMIT,
    plan_app_search,
)
from nexus.services.search.query import build_search_query
from nexus.services.search.scope import scope_from_uri
from nexus.services.search.selection import (
    APP_SEARCH_SELECTION_STRATEGY,
    APP_SEARCH_SELECTION_VERSION,
    rerank_app_search_candidates,
)
from tests.factories import (
    add_context_edge,
    create_searchable_media_in_library,
    create_test_conversation,
    create_test_library,
    create_test_message,
    create_test_user,
    share_conversation_to_library,
)

QUERY_CLASSES = (
    "exact_lookup",
    "scoped_passage_lookup",
    "single_source_summary",
    "cross_document_synthesis",
    "global_library_question",
    "multi_hop_search_read_inspect_question",
    "negative_absence_question",
    "recency_or_conversation_question",
)
FIXTURE_PATH = Path(__file__).parent / "fixtures" / "search_retrieval_evals.json"


def _content_chunk_ref(db: Session, media_id: UUID) -> str:
    chunk_id = db.execute(
        text(
            """
            SELECT id
            FROM content_chunks
            WHERE owner_kind = 'media' AND owner_id = :media_id
            ORDER BY chunk_idx ASC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).scalar_one()
    return f"content_chunk:{chunk_id}"


def _next_seq(db: Session, conversation_id: UUID) -> int:
    return int(
        db.execute(
            text("SELECT next_seq FROM conversations WHERE id = :conversation_id"),
            {"conversation_id": conversation_id},
        ).scalar_one()
    )


def _append_app_search_messages(
    db: Session,
    conversation_id: UUID,
) -> tuple[UUID, UUID]:
    seq = _next_seq(db, conversation_id)
    user_message_id = create_test_message(
        db,
        conversation_id,
        seq=seq,
        role="user",
        content="search retrieval eval tool request",
    )
    assistant_message_id = create_test_message(
        db,
        conversation_id,
        seq=seq + 1,
        role="assistant",
        content="",
        status="pending",
    )
    return user_message_id, assistant_message_id


def _citation_item(citation: RetrievalCitation, scope: str) -> dict:
    return {
        "ref": _citation_ref(citation),
        "type": citation.result_type,
        "score": citation.score,
        "media_id": citation.media_id,
        "source_label": citation.source_label,
        "locator": citation.locator,
        "citation_target": citation.citation_target,
        "source_map": citation.source_map,
        "scope": scope,
    }


def _indexed_refs(db: Session, viewer_id: UUID, refs: list[str]) -> list[str]:
    indexed = []
    for ref in refs:
        scheme, raw_id = ref.split(":", 1)
        try:
            result = get_search_result(db, viewer_id, scheme, raw_id)
        except ApiError:
            continue
        citation = citation_from_search_result(result, filters={})
        _, _, selected, _ = render_retrieved_context_blocks(
            db,
            viewer_id=viewer_id,
            citations=[citation],
        )
        if selected:
            indexed.append(ref)
    return indexed


def _citation_ref(citation: RetrievalCitation) -> str:
    return citation.citation_target or f"{citation.result_type}:{citation.source_id}"


def _relevant_refs(fixture: dict) -> list[str]:
    return [item["ref"] for item in fixture["relevance"]]


def _relevance_grades(fixture: dict) -> dict[str, int]:
    return {item["ref"]: int(item["grade"]) for item in fixture["relevance"]}


def _recall(refs: list[str], relevant_refs: list[str]) -> float | None:
    if not relevant_refs:
        return None
    return len(set(refs) & set(relevant_refs)) / len(set(relevant_refs))


def _precision(refs: list[str], relevant_refs: list[str]) -> float | None:
    if not refs:
        return None
    return len(set(refs) & set(relevant_refs)) / len(refs)


def _first_relevant_rank(refs: list[str], relevant_refs: list[str]) -> int | None:
    relevant = set(relevant_refs)
    for index, ref in enumerate(refs, start=1):
        if ref in relevant:
            return index
    return None


def _average_precision(refs: list[str], relevant_refs: list[str]) -> float | None:
    if not relevant_refs:
        return None
    relevant = set(relevant_refs)
    hits = 0
    total = 0.0
    for index, ref in enumerate(refs, start=1):
        if ref in relevant:
            hits += 1
            total += hits / index
    return total / len(relevant)


def _dcg(grades: list[int]) -> float:
    return sum((2**grade - 1) / math.log2(index + 2) for index, grade in enumerate(grades))


def _ndcg(refs: list[str], relevance_grades: dict[str, int]) -> float | None:
    if not relevance_grades:
        return None
    ideal = _dcg(sorted(relevance_grades.values(), reverse=True))
    if ideal == 0:
        return None
    return _dcg([relevance_grades.get(ref, 0) for ref in refs]) / ideal


def _stage(
    relevant_refs: list[str],
    indexed_refs: list[str],
    candidate_refs: list[str],
    selected_refs: list[str],
) -> str:
    relevant = set(relevant_refs)
    if not relevant:
        return "unexpected_retrieval" if candidate_refs or selected_refs else "expected_absence"
    if relevant - set(indexed_refs):
        return "indexing_failure"
    if relevant - set(candidate_refs):
        return "candidate_generation_failure"
    if relevant - set(selected_refs):
        return "evidence_packing_failure"
    return "selected"


def _source_key(item: dict) -> str:
    return str(item.get("media_id") or item["ref"])


def _section_key(item: dict) -> str:
    return str(item.get("locator") or item.get("source_label") or item["ref"])


def _run_candidates(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
    fixture: dict,
    depth: int,
) -> dict:
    filters = {"kinds": fixture["kinds"]}
    query = build_search_query(
        text=fixture["query"],
        raw_kinds=fixture["kinds"],
        raw_formats=None,
        raw_authors=None,
        raw_roles=None,
        scope=scope_from_uri("all"),
        cursor=None,
        limit=depth,
    )
    start = time.perf_counter()
    resolved_scopes = _resolve_scope_uris(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
        scopes=fixture["scope_refs"],
    )
    response = (
        search_scopes(db, viewer_id, query, [scope_from_uri(scope) for scope in resolved_scopes])
        if resolved_scopes
        else search(db, viewer_id, query)
    )
    citations = [
        citation_from_search_result(result, filters=filters) for result in response.results
    ]
    prompt_citations, _ = rerank_app_search_candidates(fixture["query"], citations)
    _, context_chars, selected, selection_reasons = render_retrieved_context_blocks(
        db,
        viewer_id=viewer_id,
        citations=prompt_citations,
    )
    scope = ",".join(resolved_scopes) if resolved_scopes else "all"
    return {
        "latency_ms": int((time.perf_counter() - start) * 1000),
        "context_chars": context_chars,
        "resolved_scope_refs": resolved_scopes,
        "candidates": [_citation_item(citation, scope) for citation in citations],
        "selected": [_citation_item(citation, scope) for citation in selected],
        "selection_reasons": selection_reasons,
    }


def _seed_eval_fixtures(
    db: Session,
    user_id: UUID,
    library_id: UUID,
    conversation_id: UUID,
) -> list[dict]:
    suffix = uuid4().hex
    missing_suffix = uuid4().hex
    raw = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    media_by_key: dict[str, UUID] = {}
    for key, title in raw["media_titles"].items():
        media_by_key[key] = create_searchable_media_in_library(
            db,
            user_id,
            library_id,
            title=title.format(suffix=suffix),
        )
        add_context_edge(db, conversation_id, f"media:{media_by_key[key]}")

    message_by_key: dict[str, UUID] = {}
    for key, content in raw["messages"].items():
        text_content = content.format(suffix=suffix)
        message_by_key[key] = create_test_message(
            db,
            conversation_id,
            seq=_next_seq(db, conversation_id),
            role="user",
            content=text_content,
        )
    share_conversation_to_library(db, conversation_id, library_id)
    add_context_edge(db, conversation_id, f"library:{library_id}")

    fixtures = []
    for case in raw["cases"]:
        scope_refs = []
        for ref in case["scope_refs"]:
            if ref == "library":
                scope_refs.append(f"library:{library_id}")
            elif ref.startswith("media:"):
                scope_refs.append(f"media:{media_by_key[ref.removeprefix('media:')]}")
            else:
                raise AssertionError(f"unexpected retrieval eval scope fixture: {ref}")
        fixtures.append(
            {
                "id": case["id"],
                "query": case["query"].format(suffix=suffix, missing_suffix=missing_suffix),
                "class": case["class"],
                "kinds": case["kinds"],
                "scope_refs": scope_refs,
                "relevance": [
                    {
                        "ref": _content_chunk_ref(db, media_by_key[item["media_key"]])
                        if "media_key" in item
                        else f"message:{message_by_key[item['message_key']]}",
                        "grade": item["grade"],
                    }
                    for item in case["relevance"]
                ],
            }
        )
    return fixtures


def _candidate_metrics(candidates: list[dict], relevant_refs: list[str], grades: dict[str, int]):
    refs = [item["ref"] for item in candidates]
    first_rank = _first_relevant_rank(refs, relevant_refs)
    relevant = set(relevant_refs)
    return {
        "candidate_count": len(refs),
        "relevant_count": len(relevant),
        "hit_count": len(set(refs) & relevant),
        "false_positive_count": len([ref for ref in refs if ref not in relevant]),
        "recall_at_k": _recall(refs, relevant_refs),
        "precision_at_k": _precision(refs, relevant_refs),
        "mrr": 0.0 if first_rank is None else round(1 / first_rank, 4),
        "average_precision": _average_precision(refs, relevant_refs),
        "ndcg": _ndcg(refs, grades),
        "exact_match_ref_hit_rate": None
        if not relevant_refs
        else 1.0
        if set(refs) & set(relevant_refs)
        else 0.0,
        "first_relevant_rank": first_rank,
        "candidates_by_type": dict(Counter(item["type"] for item in candidates)),
        "candidates_by_source": dict(Counter(_source_key(item) for item in candidates)),
        "candidates_by_scope": dict(Counter(item["scope"] for item in candidates)),
    }


def _pack_metrics(
    candidates: list[dict],
    selected: list[dict],
    selection_reasons: list[str],
    selected_char_count: int,
    relevant_refs: list[str],
) -> dict:
    candidate_refs = [item["ref"] for item in candidates]
    selected_refs = [item["ref"] for item in selected]
    first_selected_rank = _first_relevant_rank(selected_refs, relevant_refs)
    return {
        "candidate_count": len(candidate_refs),
        "selected_count": len(selected_refs),
        "selected_char_count": selected_char_count,
        "selected_evidence_recall": _recall(selected_refs, relevant_refs),
        "selected_evidence_precision": _precision(selected_refs, relevant_refs),
        "first_relevant_selected_rank": first_selected_rank,
        "relevant_retrieved_not_selected_count": len(
            (set(candidate_refs) & set(relevant_refs)) - set(selected_refs)
        ),
        "selected_false_positive_count": len(
            [ref for ref in selected_refs if ref not in set(relevant_refs)]
        ),
        "skipped_count": sum(
            1 for reason in selection_reasons if not reason.startswith("selected_")
        ),
        "trimmed_count": selection_reasons.count("selected_trimmed_to_budget"),
        "selection_reasons": dict(Counter(selection_reasons)),
        "selected_source_map_count": sum(1 for item in selected if item["source_map"]),
        "duplicate_count": len(candidate_refs) - len(set(candidate_refs)),
        "uncitable_count": sum(1 for item in candidates if item["citation_target"] is None),
        "source_diversity": len({_source_key(item) for item in selected}),
        "section_diversity": len({_section_key(item) for item in selected}),
        "candidate_refs": candidate_refs,
        "selected_refs": selected_refs,
        "candidates_by_type": dict(Counter(item["type"] for item in candidates)),
        "candidates_by_scope": dict(Counter(item["scope"] for item in candidates)),
        "selected": selected,
    }


def _ledger_metrics(db: Session, tool_call_id: UUID) -> dict:
    candidate_count, selected_count, reasons = db.execute(
        text(
            """
            SELECT coalesce(sum(reason_count), 0),
                   coalesce(sum(selected_count), 0),
                   jsonb_object_agg(selection_reason, reason_count ORDER BY selection_reason)
            FROM (
                SELECT selection_reason,
                       count(*) AS reason_count,
                       count(*) FILTER (WHERE selected) AS selected_count
                FROM message_retrieval_candidate_ledgers
                WHERE tool_call_id = :tool_call_id
                GROUP BY selection_reason
            ) reason_counts
            """
        ),
        {"tool_call_id": tool_call_id},
    ).one()
    inclusion = db.execute(
        text(
            """
            SELECT count(*) FILTER (WHERE selected AND included_in_prompt),
                   count(*) FILTER (WHERE selected AND NOT included_in_prompt)
            FROM message_retrieval_candidate_ledgers
            WHERE tool_call_id = :tool_call_id
            """
        ),
        {"tool_call_id": tool_call_id},
    ).one()
    rerank = db.execute(
        text(
            """
            SELECT strategy, input_count, selected_count, budget_chars, selected_chars, status, metadata
            FROM message_rerank_ledgers
            WHERE tool_call_id = :tool_call_id
            ORDER BY created_at DESC
            LIMIT 1
            """
        ),
        {"tool_call_id": tool_call_id},
    ).one()
    return {
        "candidate_count": int(candidate_count),
        "selected_count": int(selected_count),
        "selection_reasons": dict(reasons or {}),
        "selected_included_count": int(inclusion[0]),
        "selected_not_included_count": int(inclusion[1]),
        "rerank_strategy": str(rerank[0]),
        "rerank_input_count": int(rerank[1]),
        "rerank_selected_count": int(rerank[2]),
        "rerank_budget_chars": int(rerank[3]),
        "rerank_selected_chars": int(rerank[4]),
        "rerank_status": str(rerank[5]),
        "rerank_metadata": dict(rerank[6]),
    }


@pytest.mark.integration
def test_search_retrieval_eval_baseline_report(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("NEXUS_ENV", "test")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    clear_settings_cache()

    openai_embedding_calls = []

    def fail_openai_embeddings(*args, **kwargs):
        openai_embedding_calls.append((args, kwargs))
        raise AssertionError("search retrieval evals must not call provider-backed embeddings")

    monkeypatch.setattr("nexus.services.semantic_chunks._embed_with_openai", fail_openai_embeddings)

    user_id = create_test_user(db_session)
    library_id = create_test_library(db_session, user_id, "Search Retrieval Eval Library")
    conversation_id = create_test_conversation(db_session, user_id)
    fixtures = _seed_eval_fixtures(db_session, user_id, library_id, conversation_id)

    assert {fixture["class"] for fixture in fixtures} == set(QUERY_CLASSES)

    report = {
        "runtime_policy": {
            "scoped_candidate_limit": APP_SEARCH_SCOPED_CANDIDATE_LIMIT,
            "deep_candidate_limit": APP_SEARCH_DEEP_CANDIDATE_LIMIT,
            "selected_limit": APP_SEARCH_SELECTED_LIMIT,
            "context_chars": APP_SEARCH_CONTEXT_CHARS,
        },
        "candidate_depths": [
            8,
            APP_SEARCH_SCOPED_CANDIDATE_LIMIT,
            APP_SEARCH_DEEP_CANDIDATE_LIMIT,
        ],
        "answer_layer": {"provider_backed": False},
        "fixtures": [],
    }

    for fixture in fixtures:
        relevant_refs = _relevant_refs(fixture)
        grades = _relevance_grades(fixture)
        indexed_refs = _indexed_refs(db_session, user_id, relevant_refs)
        depth_reports = {}
        for depth in report["candidate_depths"]:
            candidate_run = _run_candidates(db_session, user_id, conversation_id, fixture, depth)
            candidates = candidate_run["candidates"]
            pack_at_depth = _pack_metrics(
                candidates,
                candidate_run["selected"],
                candidate_run["selection_reasons"],
                candidate_run["context_chars"],
                relevant_refs,
            )
            depth_reports[str(depth)] = {
                **_candidate_metrics(candidates, relevant_refs, grades),
                "selected_pack_recall": pack_at_depth["selected_evidence_recall"],
                "stage": _stage(
                    relevant_refs,
                    indexed_refs,
                    pack_at_depth["candidate_refs"],
                    pack_at_depth["selected_refs"],
                ),
                "latency_ms": candidate_run["latency_ms"],
                "scope_refs": fixture["scope_refs"],
                "resolved_scope_refs": candidate_run["resolved_scope_refs"],
                "pack": pack_at_depth,
            }
        recall_at_8 = depth_reports["8"]["recall_at_k"]
        for depth in report["candidate_depths"]:
            recall = depth_reports[str(depth)]["recall_at_k"]
            depth_reports[str(depth)]["recall_delta_vs_8"] = (
                None if recall is None or recall_at_8 is None else round(recall - recall_at_8, 4)
            )

        user_message_id, assistant_message_id = _append_app_search_messages(
            db_session,
            conversation_id,
        )
        run = execute_app_search(
            db_session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=fixture["scope_refs"],
            query=fixture["query"],
            kinds=fixture["kinds"],
        )
        candidates = [_citation_item(citation, run.scope) for citation in run.citations]
        selected = [_citation_item(citation, run.scope) for citation in run.selected_citations]
        plan = plan_app_search(fixture["query"], fixture["scope_refs"], fixture["kinds"])
        assert run.query_class == plan.query_class
        assert run.candidate_limit == plan.candidate_limit
        assert run.retrieval_mode == plan.retrieval_mode
        assert run.policy_reason == plan.policy_reason
        assert run.context_route == plan.context_route
        pack = _pack_metrics(
            candidates,
            selected,
            run.selection_reasons,
            run.context_chars,
            relevant_refs,
        )
        assert run.tool_call_id is not None
        ledger = _ledger_metrics(db_session, run.tool_call_id)
        assert ledger["candidate_count"] == pack["candidate_count"], ledger
        assert ledger["selected_count"] == pack["selected_count"], ledger
        assert ledger["rerank_input_count"] == pack["candidate_count"], ledger
        assert ledger["rerank_selected_count"] == pack["selected_count"], ledger
        assert ledger["selection_reasons"] == pack["selection_reasons"], ledger
        assert ledger["selected_not_included_count"] == 0, ledger
        assert ledger["rerank_strategy"] == APP_SEARCH_SELECTION_STRATEGY, ledger
        metadata = dict(ledger["rerank_metadata"])
        assert len(metadata["candidate_rerank_trace"]) == len(run.citations)
        assert [item["selection_reason"] for item in metadata["candidate_rerank_trace"]] == (
            run.selection_reasons
        )
        assert [item["selected"] for item in metadata["candidate_rerank_trace"]] == [
            citation in run.selected_citations for citation in run.citations
        ]
        assert {
            key: value for key, value in metadata.items() if key != "candidate_rerank_trace"
        } == {
            "selection_strategy": APP_SEARCH_SELECTION_STRATEGY,
            "selection_policy_version": APP_SEARCH_SELECTION_VERSION,
            "ordering_policy": "hybrid_score_exactness_citation_quality_diversity",
            "diversity_policy": "source_section_penalty",
            "budget_policy": "greedy_context_budget",
            "candidate_limit": run.candidate_limit,
            "selected_limit": APP_SEARCH_SELECTED_LIMIT,
            "context_budget_chars": APP_SEARCH_CONTEXT_CHARS,
            "scope_count": run.scope_count,
            "result_type_mix": dict(Counter(citation.result_type for citation in run.citations)),
            "query_class": run.query_class,
            "retrieval_mode": run.retrieval_mode,
            "policy_reason": run.policy_reason,
            "graph_expanded_scopes": run.graph_expanded_scopes,
            "graph_expanded_scope_count": len(run.graph_expanded_scopes),
            "context_route": run.context_route,
            "context_route_reason": run.context_route_reason,
            "selected_source_map_count": pack["selected_source_map_count"],
            "scope": run.scope,
            "resolved_scopes": run.resolved_scopes,
            "inclusion_surface": "tool_output",
            "selection_reason_counts": dict(Counter(run.selection_reasons)),
        }
        baseline = {
            "candidate_limit": run.candidate_limit,
            "query_class": run.query_class,
            "retrieval_mode": run.retrieval_mode,
            "policy_reason": run.policy_reason,
            "context_route": run.context_route,
            "context_route_reason": run.context_route_reason,
            "selected_source_map_count": pack["selected_source_map_count"],
            "candidate_count": pack["candidate_count"],
            "selected_count": pack["selected_count"],
            "context_chars": run.context_chars,
            "candidate_recall": _recall(pack["candidate_refs"], relevant_refs),
            "selected_pack_recall": pack["selected_evidence_recall"],
            "stage": _stage(
                relevant_refs,
                indexed_refs,
                pack["candidate_refs"],
                pack["selected_refs"],
            ),
            "pack": pack,
            "ledger": ledger,
        }
        report["fixtures"].append(
            {
                "id": fixture["id"],
                "class": fixture["class"],
                "query": fixture["query"],
                "scope_refs": fixture["scope_refs"],
                "relevance": fixture["relevance"],
                "relevant_refs": relevant_refs,
                "candidate_depths": depth_reports,
                "baseline": baseline,
            }
        )

    report["summary"] = {
        "fixture_count": len(report["fixtures"]),
        "stage_counts": dict(Counter(item["baseline"]["stage"] for item in report["fixtures"])),
    }
    for depth in report["candidate_depths"]:
        recalls = [
            item["candidate_depths"][str(depth)]["recall_at_k"]
            for item in report["fixtures"]
            if item["candidate_depths"][str(depth)]["recall_at_k"] is not None
        ]
        report["summary"][f"mean_candidate_recall_at_{depth}"] = (
            round(sum(recalls) / len(recalls), 4) if recalls else None
        )
        deltas = [
            item["candidate_depths"][str(depth)]["recall_delta_vs_8"]
            for item in report["fixtures"]
            if item["candidate_depths"][str(depth)]["recall_delta_vs_8"] is not None
        ]
        report["summary"][f"mean_candidate_recall_delta_{depth}_vs_8"] = (
            round(sum(deltas) / len(deltas), 4) if deltas else None
        )

    (tmp_path / "search-retrieval-evals-baseline.json").write_text(
        json.dumps(report, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    positive = [item for item in report["fixtures"] if item["relevant_refs"]]
    assert positive
    assert all(item["candidate_depths"]["50"]["recall_at_k"] == 1.0 for item in positive), report
    assert any(
        item["candidate_depths"]["50"]["recall_at_k"] > item["candidate_depths"]["8"]["recall_at_k"]
        for item in positive
    ), report
    assert all(
        item["baseline"]["candidate_recall"]
        == item["candidate_depths"][str(item["baseline"]["candidate_limit"])]["recall_at_k"]
        for item in positive
    ), report
    assert all(
        item["baseline"]["stage"] in {"selected", "evidence_packing_failure"} for item in positive
    ), report
    assert all(
        {
            "recall_at_k",
            "recall_delta_vs_8",
            "precision_at_k",
            "mrr",
            "average_precision",
            "ndcg",
            "latency_ms",
        }
        <= set(item["candidate_depths"]["8"])
        for item in report["fixtures"]
    ), report
    assert all(
        {
            "selected_evidence_recall",
            "selected_char_count",
            "skipped_count",
            "trimmed_count",
            "selected_source_map_count",
            "duplicate_count",
            "uncitable_count",
            "source_diversity",
            "section_diversity",
            "first_relevant_selected_rank",
            "relevant_retrieved_not_selected_count",
            "selected_false_positive_count",
        }
        <= set(item["baseline"]["pack"])
        for item in report["fixtures"]
    ), report
    assert all("context_route" in item["baseline"] for item in report["fixtures"]), report
    for item in report["fixtures"]:
        for selected in item["baseline"]["pack"]["selected"]:
            source_map = selected["source_map"]
            if source_map is None:
                continue
            assert "citation_target" not in source_map
            assert "generated_text" not in source_map
            assert "summary" not in source_map

    source_summary = next(
        item for item in report["fixtures"] if item["class"] == "single_source_summary"
    )
    assert source_summary["baseline"]["candidate_limit"] == APP_SEARCH_SCOPED_CANDIDATE_LIMIT
    assert source_summary["baseline"]["context_route"] == "long_context_candidate"
    assert source_summary["baseline"]["context_route_reason"] == "single_media_whole_source_query"

    negative = next(
        item for item in report["fixtures"] if item["class"] == "negative_absence_question"
    )
    assert negative["baseline"]["candidate_limit"] == APP_SEARCH_DEEP_CANDIDATE_LIMIT, negative
    assert negative["baseline"]["policy_reason"] == "library_scope", negative
    assert set(negative["candidate_depths"]) == {"8", "20", "50"}
    assert (
        negative["baseline"]["pack"]["selected_false_positive_count"]
        == negative["baseline"]["selected_count"]
    ), negative
    assert all(
        depth["false_positive_count"] == depth["candidate_count"]
        for depth in negative["candidate_depths"].values()
    ), negative
    assert negative["baseline"]["pack"]["selected_evidence_recall"] is None, negative
    assert openai_embedding_calls == []


@pytest.mark.integration
def test_search_retrieval_eval_fixture_shape_is_exhaustive() -> None:
    raw = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    assert set(raw) == {"media_titles", "messages", "cases"}
    assert Counter(case["class"] for case in raw["cases"]) == Counter(QUERY_CLASSES)
    assert len({case["id"] for case in raw["cases"]}) == len(raw["cases"])
    for case in raw["cases"]:
        assert set(case) == {"id", "query", "class", "kinds", "scope_refs", "relevance"}
        assert case["class"] in QUERY_CLASSES
        assert set(case["kinds"]) <= set(SEARCH_KINDS)
        assert case["scope_refs"]
        for scope_ref in case["scope_refs"]:
            assert scope_ref == "library" or scope_ref.startswith("media:")
            if scope_ref.startswith("media:"):
                assert scope_ref.removeprefix("media:") in raw["media_titles"]
        for item in case["relevance"]:
            assert ("media_key" in item) != ("message_key" in item), item
            assert item["grade"] > 0
            if "media_key" in item:
                assert item["media_key"] in raw["media_titles"]
            if "message_key" in item:
                assert item["message_key"] in raw["messages"]

    by_class = {case["class"]: case for case in raw["cases"]}
    assert len(by_class["cross_document_synthesis"]["relevance"]) >= 2
    assert by_class["scoped_passage_lookup"]["scope_refs"][0].startswith("media:")
    assert by_class["single_source_summary"]["scope_refs"][0].startswith("media:")
    assert "summary" in by_class["single_source_summary"]["query"]
    assert by_class["negative_absence_question"]["relevance"] == []
    assert "{missing_suffix}" in by_class["negative_absence_question"]["query"]
    assert any(
        "message_key" in item for item in by_class["recency_or_conversation_question"]["relevance"]
    )
    assert {"documents", "conversations"} <= set(
        by_class["multi_hop_search_read_inspect_question"]["kinds"]
    )
    assert any(
        "media_key" in item
        for item in by_class["multi_hop_search_read_inspect_question"]["relevance"]
    )
    assert any(
        "message_key" in item
        for item in by_class["multi_hop_search_read_inspect_question"]["relevance"]
    )


@pytest.mark.unit
def test_search_retrieval_eval_stage_classifier_distinguishes_failures() -> None:
    target = "content_chunk:00000000-0000-0000-0000-000000000001"

    assert _stage([target], [], [], []) == "indexing_failure"
    assert _stage([target], [target], [], []) == "candidate_generation_failure"
    assert _stage([target], [target], [target], []) == "evidence_packing_failure"
    assert _stage([], [], [], []) == "expected_absence"
    assert _stage([], [], [target], []) == "unexpected_retrieval"


@pytest.mark.integration
def test_search_retrieval_eval_classifies_candidate_lost_before_selection(
    db_session: Session,
) -> None:
    user_id = create_test_user(db_session)
    library_id = create_test_library(db_session, user_id, "Search Retrieval Packer Eval")

    citations = []
    for index in range(APP_SEARCH_SELECTED_LIMIT + 1):
        media_id = create_searchable_media_in_library(
            db_session,
            user_id,
            library_id,
            title=f"Search retrieval packer eval {index}",
        )
        result = get_search_result(
            db_session,
            user_id,
            "content_chunk",
            _content_chunk_ref(db_session, media_id).removeprefix("content_chunk:"),
        )
        citations.append(citation_from_search_result(result, filters={}))

    _, _, selected, _ = render_retrieved_context_blocks(
        db_session,
        viewer_id=user_id,
        citations=citations,
    )
    target = _citation_ref(citations[-1])
    selected_refs = [_citation_ref(citation) for citation in selected]

    assert _stage(
        [target], [target], [_citation_ref(citation) for citation in citations], selected_refs
    ) == ("evidence_packing_failure"), {"target": target, "selected_refs": selected_refs}
