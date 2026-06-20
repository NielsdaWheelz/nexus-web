"""Static negative gates for the chat subsystem consolidation hard cutover.

Pure repo greps (no DB, no app import) that pin the single-owner end state from
`docs/cutovers/chat-subsystem-consolidation-hard-cutover.md` §16: one
reducer-backed message owner, one per-run stream context, one run-visibility
factory, the extracted backend services, the single event emitter, and the
generalized `run_kit` run-tail query. A reintroduced scattered `setMessages`, a
revived per-run ref, a citation/tool body sliding back into the executor, or a
hand-rolled event append all fail here with a file:line pointer.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_ROOT = _REPO_ROOT / "python" / "nexus"
_WEB_ROOT = _REPO_ROOT / "apps" / "web" / "src"

# The reducer-backed engine + fold layer + run-tail orchestrator live here.
_CHAT_FE_ROOTS = (
    _WEB_ROOT / "components" / "chat",
    _WEB_ROOT / "lib" / "conversations",
)
_CHAT_RUNS_PY = _PY_ROOT / "services" / "chat_runs.py"
_CHAT_CITATIONS_PY = _PY_ROOT / "services" / "chat_run_citations.py"
_CHAT_TOOLS_PY = _PY_ROOT / "services" / "chat_run_tools.py"
_CHAT_EVENT_STORE_PY = _PY_ROOT / "services" / "chat_run_event_store.py"
_RUN_KIT_PY = _PY_ROOT / "services" / "run_kit.py"
_ORACLE_PY = _PY_ROOT / "services" / "oracle.py"
_LI_REVISIONS_PY = _PY_ROOT / "services" / "library_intelligence_revisions.py"

_FE_TEST = re.compile(r"\.test\.")


def _scan_files(*roots: Path) -> list[Path]:
    files: list[Path] = []
    for root in roots:
        if root.is_file():
            files.append(root)
        elif root.is_dir():
            files.extend(p for p in sorted(root.rglob("*")) if p.is_file())
    return files


def _hits(pattern: str, *roots: Path, exclude: re.Pattern[str] | None = None) -> list[str]:
    rx = re.compile(pattern)
    out: list[str] = []
    for path in _scan_files(*roots):
        if exclude is not None and exclude.search(path.as_posix()):
            continue
        for line_no, line in enumerate(
            path.read_text(encoding="utf-8", errors="ignore").splitlines(), start=1
        ):
            if rx.search(line):
                out.append(f"{path.as_posix()}:{line_no}: {line.strip()}")
    return out


# =============================================================================
# Frontend: one reducer-backed owner, one per-run context, dead code gone (§16)
# =============================================================================


def test_chat_message_list_has_at_most_one_set_messages_consumer():
    # The reducer-backed engine (useReducer) is the sole writer of messages[].
    # The spec bar is <= 1; the achieved state is 0 (no raw setter at all).
    hits = _hits(r"\bsetMessages\(", *_CHAT_FE_ROOTS, exclude=_FE_TEST)
    assert len(hits) <= 1, "more than one setMessages() consumer:\n" + "\n".join(hits)


def test_chat_per_run_stream_refs_are_consolidated():
    # activeStreamsRef + runTokensRef + firstDeltaRunIdsRef folded into one
    # PerRunStreamContext.
    hits = _hits(
        r"\b(activeStreamsRef|runTokensRef|firstDeltaRunIdsRef)\b",
        *_CHAT_FE_ROOTS,
        exclude=_FE_TEST,
    )
    assert not hits, "former per-run stream refs still present:\n" + "\n".join(hits)


def test_chat_dead_optimistic_handler_is_absent():
    hits = _hits(r"\bhandleOptimisticMessages\b", *_CHAT_FE_ROOTS, exclude=_FE_TEST)
    assert not hits, "dead handleOptimisticMessages still present:\n" + "\n".join(hits)


# =============================================================================
# Backend: chat_runs.py is an executor; services + emitter own their concerns
# =============================================================================

_EXTRACTED_SERVICE_DEFS = (
    r"^\s*def\s+("
    r"record_tool_citations|_record_retrieval_citation|_citation_target_ref|"
    r"persist_attached_citations|prune_tool_call_retrievals|_delete_citation_edge|"
    r"clear_message_citations|persist_read_evidence_citation|emit_citation_index|"
    r"app_search_tool_output|web_search_tool_output|persist_tool_call_start|"
    r"persist_tool_call_error|bind_provider_tool_call_events|tool_start_event|"
    r"persist_tool_call_trace|tool_trace_event"
    r")\b"
)


def test_chat_runs_no_longer_defines_the_extracted_services():
    # The citation family -> chat_run_citations, the tool family -> chat_run_tools.
    hits = _hits(_EXTRACTED_SERVICE_DEFS, _CHAT_RUNS_PY)
    assert not hits, "extracted service fn still defined in chat_runs.py:\n" + "\n".join(hits)


def test_chat_event_appends_go_only_through_the_emitter():
    # ChatRunEventEmitter is the single durable-append owner; production code
    # never hand-rolls append_and_commit / append_run_event. (Tests may still
    # seed via the public primitives — they live outside the executor + services.)
    hits = _hits(
        r"\b(append_and_commit|append_run_event)\(",
        _CHAT_RUNS_PY,
        _CHAT_CITATIONS_PY,
        _CHAT_TOOLS_PY,
    )
    assert not hits, "direct event append outside the emitter:\n" + "\n".join(hits)


def test_oracle_and_li_drop_their_private_run_tail_queries():
    # get_*_events / is_*_terminal are generalized into run_kit; oracle/LI keep
    # only their own assert_viewer owner.
    hits = _hits(
        r"\bdef\s+(get_reading_events|is_reading_terminal|get_revision_events|is_revision_terminal)\b",
        _ORACLE_PY,
        _LI_REVISIONS_PY,
    )
    assert not hits, "private run-tail query still defined in oracle/LI:\n" + "\n".join(hits)


# =============================================================================
# Anti-over-deletion: the new single owners must remain present
# =============================================================================


def test_consolidated_single_owners_remain():
    assert _CHAT_CITATIONS_PY.exists(), "chat_run_citations.py must exist"
    assert _CHAT_TOOLS_PY.exists(), "chat_run_tools.py must exist"
    assert "class ChatRunEventEmitter" in _CHAT_EVENT_STORE_PY.read_text(encoding="utf-8")
    run_kit = _RUN_KIT_PY.read_text(encoding="utf-8")
    assert "def get_run_events(" in run_kit
    assert "def is_run_terminal(" in run_kit
    fe_conversations = _WEB_ROOT / "lib" / "conversations"
    assert (fe_conversations / "messageUpdateReducer.ts").exists()
    assert (fe_conversations / "runVisibility.ts").exists()
    assert (_WEB_ROOT / "components" / "chat" / "perRunStreamContext.ts").exists()
