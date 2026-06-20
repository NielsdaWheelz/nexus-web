"""Pure-function contracts for the chat-run citation persistence owner.

``chat_run_citations`` is the sole owner of chat citation persistence, extracted
verbatim from ``chat_runs.py``. The DB-mutating owners (``record_tool_citations``,
``persist_attached_citations``, ``persist_read_evidence_citation``,
``emit_citation_index``, ``prune_tool_call_retrievals``, ``clear_message_citations``)
are exercised against a real database by ``test_chat_runs.py`` and
``test_attached_citations.py``. This file pins the import-smoke (the public API
survived the move) and the one pure helper that resolves a citation target from a
telemetry row without touching the database.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from nexus.services import chat_run_citations
from nexus.services.chat_run_citations import _citation_target_ref


def test_public_api_surface() -> None:
    """The executor-called citation owners are public on the extracted module."""
    for name in (
        "record_tool_citations",
        "persist_attached_citations",
        "persist_read_evidence_citation",
        "emit_citation_index",
        "clear_message_citations",
        "prune_tool_call_retrievals",
    ):
        assert callable(getattr(chat_run_citations, name)), name


def test_citation_target_ref_resolves_citable_schemes() -> None:
    """Every citable result ref round-trips to a ResourceRef with the same URI."""
    span_id = uuid4()
    chunk_id = uuid4()
    media_id = uuid4()
    note_block_id = uuid4()
    highlight_id = uuid4()
    fragment_id = uuid4()
    message_id = uuid4()
    apparatus_item_id = uuid4()

    def target(uri: str | None):
        return _citation_target_ref(None, run=None, row={"result_ref": {"citation_target": uri}})

    for uri in (
        f"evidence_span:{span_id}",
        f"content_chunk:{chunk_id}",
        f"media:{media_id}",
        f"highlight:{highlight_id}",
        f"fragment:{fragment_id}",
        f"note_block:{note_block_id}",
        f"message:{message_id}",
        f"reader_apparatus_item:{apparatus_item_id}",
    ):
        resolved = target(uri)
        assert resolved is not None
        assert resolved.uri == uri

    assert target(None) is None
    assert _citation_target_ref(None, run=None, row={"result_ref": {}}) is None


def test_citation_target_ref_rejects_malformed_or_uncitable_targets() -> None:
    for raw_target in ("not-a-ref", "library:not-a-uuid", f"library:{uuid4()}"):
        with pytest.raises(AssertionError):
            _citation_target_ref(
                None,
                run=None,
                row={"result_ref": {"citation_target": raw_target}},
            )
