"""Priority proof: Conversation Dossier search results remain durable retrieval facts."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from pydantic import TypeAdapter
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import ArtifactBuild, ArtifactRevision, Conversation, SynthesisArtifact
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.retrieval import RetrievalResultRef, retrieval_result_ref_json
from nexus.schemas.search import (
    ConversationArtifactSearchOut,
    SearchResultActivationOut,
    SearchResultContextRefOut,
    SearchResultOut,
)
from nexus.services import bootstrap
from nexus.services.retrieval_citation import citation_from_search_result
from nexus.services.search.resolver import get_search_result


def test_retrieval_result_refs_cover_every_canonical_search_discriminant() -> None:
    public_discriminator = TypeAdapter(SearchResultOut).json_schema()["discriminator"]
    retrieval_discriminator = TypeAdapter(RetrievalResultRef).json_schema()["discriminator"]

    assert set(retrieval_discriminator["mapping"]) == set(public_discriminator["mapping"])


def test_artifact_search_result_projects_to_the_canonical_retrieval_ref() -> None:
    subject_id = UUID("00000000-0000-0000-0000-000000000101")
    artifact_id = UUID("00000000-0000-0000-0000-000000000102")
    revision_id = UUID("00000000-0000-0000-0000-000000000103")
    revision_ref = f"artifact_revision:{revision_id}"
    result = ConversationArtifactSearchOut(
        type="artifact",
        id=subject_id,
        revision_id=revision_id,
        subject_ref=f"conversation:{subject_id}",
        score=1.0,
        snippet="A current Dossier claim.",
        title="Dossier",
        source_label="dossier",
        media_id=None,
        media_kind=None,
        resource_ref=revision_ref,
        owner_resource_ref=f"conversation:{subject_id}",
        actionSubjectRef=revision_ref,
        activation=SearchResultActivationOut(
            resource_ref=revision_ref,
            kind="route",
            href=f"/artifacts/artifact:{artifact_id}?revision={revision_ref}",
        ),
        citation_target=None,
        context_ref=SearchResultContextRefOut(type="artifact", id=subject_id),
    )

    citation = citation_from_search_result(result, filters={"kinds": ["conversations"]})
    projected = retrieval_result_ref_json(citation.result_ref_json())

    assert projected["type"] == "artifact"
    assert projected["id"] == str(subject_id)
    assert projected["source_id"] == str(subject_id)
    assert projected["revision_id"] == str(revision_id)
    assert projected["subject_ref"] == f"conversation:{subject_id}"
    assert projected["context_ref"] == {"type": "artifact", "id": str(subject_id)}


def test_artifact_search_result_reresolves_the_current_visible_revision(engine: Engine) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"artifact-search-owner-{owner_id}@example.invalid",
        )
        bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"artifact-search-foreign-{foreign_id}@example.invalid",
        )
        conversation = Conversation(owner_user_id=owner_id, title="Searchable conversation")
        db.add(conversation)
        db.flush()
        artifact = SynthesisArtifact(
            subject_scheme="conversation",
            subject_id=conversation.id,
            audience_scheme="user",
            audience_id=str(owner_id),
        )
        db.add(artifact)
        db.flush()
        build = ArtifactBuild(
            artifact_id=artifact.id,
            requester_user_id=owner_id,
            instruction=None,
            idempotency_key=f"artifact-search-{uuid4()}",
        )
        db.add(build)
        db.flush()
        revision = ArtifactRevision(
            build_id=build.id,
            content_html="<p>A current Dossier claim.</p>",
            content_text="A current Dossier claim.",
            input_manifest={},
            citation_owner_user_id=owner_id,
            creator_user_id=owner_id,
        )
        db.add(revision)
        db.flush()
        artifact.current_revision_id = revision.id
        db.commit()

        result = get_search_result(db, owner_id, "artifact", str(conversation.id))

        assert isinstance(result, ConversationArtifactSearchOut)
        assert result.id == conversation.id
        assert result.revision_id == revision.id
        assert result.subject_ref == f"conversation:{conversation.id}"
        assert result.resource_ref == f"artifact_revision:{revision.id}"
        assert result.owner_resource_ref == f"conversation:{conversation.id}"
        assert result.snippet == revision.content_text

        with pytest.raises(NotFoundError) as denied:
            get_search_result(db, foreign_id, "artifact", str(conversation.id))
        assert denied.value.code is ApiErrorCode.E_NOT_FOUND
