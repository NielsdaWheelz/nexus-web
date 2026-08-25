"""Durable persisted-Web search-result resolution behavior."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import (
    Conversation,
    Message,
    MessageRetrieval,
    MessageToolCall,
    ResourceExternalSnapshot,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.retrieval import ExternalSnapshotId, ProviderResultRef
from nexus.schemas.search import SearchResultWebOut
from nexus.services import bootstrap
from nexus.services.agent_tools.web_search import PersistedWebSearchCitation
from nexus.services.search.resolver import get_search_result


@dataclass(frozen=True, slots=True)
class _PersistedWebResult:
    retrieval_id: UUID
    snapshot_id: UUID
    provider_result_ref: str
    title: str
    url: str
    snippet: str


def _seed_web_result(
    db: Session,
    *,
    viewer_id: UUID,
    label: str,
    malformed_result_ref: bool = False,
) -> _PersistedWebResult:
    conversation = Conversation(
        owner_user_id=viewer_id,
        title=f"{label.title()} web result conversation",
    )
    db.add(conversation)
    db.flush()
    user_message = Message(
        conversation_id=conversation.id,
        seq=1,
        role="user",
        content=f"Find {label}",
    )
    db.add(user_message)
    db.flush()
    assistant_message = Message(
        conversation_id=conversation.id,
        seq=2,
        role="assistant",
        content=f"Found {label}",
        parent_message_id=user_message.id,
    )
    db.add(assistant_message)
    db.flush()
    tool_call = MessageToolCall(
        conversation_id=conversation.id,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
        canonical_tool_id="web.search",
        record_kind="current_execution",
        tool_call_index=0,
        scope="all",
        requested_types=["web_result"],
        result_refs=[],
        selected_context_refs=[],
        provider_request_ids=[f"request-{label}"],
        status="complete",
    )
    snapshot = ResourceExternalSnapshot(
        user_id=viewer_id,
        provider="brave",
        url=f"https://example.invalid/{label}",
        title=f"{label.title()} result",
        snippet=f"Durable {label} web evidence survives.",
        source_snapshot={"kind": "test"},
    )
    db.add_all([tool_call, snapshot])
    db.flush()
    citation = PersistedWebSearchCitation(
        external_snapshot_id=ExternalSnapshotId(snapshot.id),
        provider_result_ref=ProviderResultRef(f"provider-{label}"),
        title=snapshot.title,
        url=snapshot.url,
        display_url="example.invalid",
        snippet=snapshot.snippet,
        extra_snippets=(f"More {label} context.",),
        published_at="2026-08-25T00:00:00Z",
        source_name="Example",
        rank=2,
        provider="brave",
        provider_request_id=f"request-{label}",
        selected=True,
    )
    result_ref = citation.retrieval_result_ref_json()
    retrieval = MessageRetrieval(
        tool_call_id=tool_call.id,
        ordinal=0,
        result_type="web_result",
        source_id=str(snapshot.id),
        scope="all",
        context_ref=result_ref["context_ref"],
        result_ref={"type": "web_result"} if malformed_result_ref else result_ref,
        deep_link=snapshot.url,
        score=0.5,
        selected=True,
        source_title=snapshot.title,
        exact_snippet=snapshot.snippet,
        locator=citation.locator_json(),
        retrieval_status="web_result",
        included_in_prompt=True,
    )
    db.add(retrieval)
    db.flush()
    return _PersistedWebResult(
        retrieval_id=retrieval.id,
        snapshot_id=snapshot.id,
        provider_result_ref=str(citation.provider_result_ref),
        title=snapshot.title,
        url=snapshot.url,
        snippet=snapshot.snippet,
    )


def test_web_results_reresolve_canonical_snapshot_identity_and_fail_closed(
    engine: Engine,
) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"web-search-owner-{owner_id}@example.invalid",
        )
        bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"web-search-foreign-{foreign_id}@example.invalid",
        )
        owned = _seed_web_result(db, viewer_id=owner_id, label="owned")
        foreign = _seed_web_result(db, viewer_id=foreign_id, label="foreign")
        malformed = _seed_web_result(
            db,
            viewer_id=owner_id,
            label="malformed",
            malformed_result_ref=True,
        )
        db.commit()

        result = get_search_result(
            db,
            owner_id,
            "web_result",
            str(owned.retrieval_id),
        )

        assert isinstance(result, SearchResultWebOut)
        assert result.id == str(owned.retrieval_id)
        assert result.source_id == str(owned.snapshot_id)
        assert result.result_ref == owned.provider_result_ref
        assert result.resource_ref == f"external_snapshot:{owned.snapshot_id}"
        assert result.owner_resource_ref == f"external_snapshot:{owned.snapshot_id}"
        assert result.title == owned.title
        assert result.url == owned.url
        assert result.snippet == owned.snippet
        assert result.display_url == "example.invalid"
        assert result.extra_snippets == ["More owned context."]
        assert result.published_at == "2026-08-25T00:00:00Z"
        assert result.source_name == "Example"
        assert result.rank == 2
        assert result.provider == "brave"
        assert result.provider_request_id == "request-owned"
        assert result.selected is True
        assert result.locator.model_dump(mode="json", exclude_none=True) == {
            "type": "external_url",
            "url": owned.url,
            "title": owned.title,
            "display_url": "example.invalid",
        }

        for hidden_retrieval_id in (foreign.retrieval_id, malformed.retrieval_id):
            with pytest.raises(NotFoundError) as denied:
                get_search_result(
                    db,
                    owner_id,
                    "web_result",
                    str(hidden_retrieval_id),
                )
            assert denied.value.code is ApiErrorCode.E_NOT_FOUND
