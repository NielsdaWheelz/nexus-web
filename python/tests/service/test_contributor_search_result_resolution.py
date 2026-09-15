"""Durable Contributor search-result resolution behavior."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import (
    Contributor,
    ContributorCredit,
    Media,
    MediaKind,
    Page,
    ProcessingStatus,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.search import SearchResultContributorOut
from nexus.services import bootstrap, library_entries
from nexus.services.resource_graph.edges import create_link
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search.resolver import get_search_result


def _seed_credited_contributor(
    db: Session,
    *,
    viewer_id: UUID,
    label: str,
) -> Contributor:
    contributor = Contributor(
        handle=f"{label}-{uuid4().hex}",
        display_name=f"{label.title()} Contributor",
    )
    media = Media(
        kind=MediaKind.web_article,
        title=f"{label.title()} credited work",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=viewer_id,
    )
    db.add_all([contributor, media])
    db.flush()
    assert library_entries.ensure_media_in_default_library(db, viewer_id, media.id)
    db.add(
        ContributorCredit(
            contributor_id=contributor.id,
            media_id=media.id,
            credited_name=contributor.display_name,
            normalized_credited_name=contributor.display_name.casefold(),
            role="author",
            ordinal=0,
            source="test",
        )
    )
    db.flush()
    return contributor


def test_contributor_results_reresolve_credited_and_linked_visibility(
    engine: Engine,
) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"contributor-search-owner-{owner_id}@example.invalid",
        )
        bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"contributor-search-foreign-{foreign_id}@example.invalid",
        )
        credited = _seed_credited_contributor(db, viewer_id=owner_id, label="credited")
        foreign = _seed_credited_contributor(db, viewer_id=foreign_id, label="foreign")
        linked = Contributor(
            handle=f"linked-{uuid4().hex}",
            display_name="Linked Contributor",
        )
        unlinked = Contributor(
            handle=f"unlinked-{uuid4().hex}",
            display_name="Unlinked Contributor",
        )
        page = Page(
            user_id=owner_id,
            title="Contributor link source",
        )
        db.add_all([linked, unlinked, page])
        db.flush()
        refs = sorted(
            (
                ResourceRef(scheme="contributor", id=linked.id),
                ResourceRef(scheme="page", id=page.id),
            ),
            key=lambda ref: (ref.scheme, str(ref.id)),
        )
        create_link(
            db,
            viewer_id=owner_id,
            source=refs[0],
            target=refs[1],
        )
        db.commit()

        credited_result = get_search_result(
            db,
            owner_id,
            "contributor",
            str(credited.id),
        )
        linked_result = get_search_result(
            db,
            owner_id,
            "contributor",
            str(linked.id),
        )

        assert isinstance(credited_result, SearchResultContributorOut)
        assert credited_result.id == credited.handle
        assert credited_result.contributor_handle == credited.handle
        assert credited_result.contributor.handle == credited.handle
        assert credited_result.contributor.display_name == credited.display_name
        assert credited_result.resource_ref == f"contributor:{credited.id}"
        assert credited_result.owner_resource_ref == f"contributor:{credited.id}"
        assert isinstance(linked_result, SearchResultContributorOut)
        assert linked_result.id == linked.handle
        assert linked_result.contributor.display_name == linked.display_name

        for hidden_contributor_id in (foreign.id, unlinked.id):
            with pytest.raises(NotFoundError) as denied:
                get_search_result(
                    db,
                    owner_id,
                    "contributor",
                    str(hidden_contributor_id),
                )
            assert denied.value.code is ApiErrorCode.E_NOT_FOUND
