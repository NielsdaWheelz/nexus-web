#!/usr/bin/env python
"""Seed the narrow real-stack Resource Inspector Playwright fixture."""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import text

from nexus.db.models import (
    ArtifactBuild,
    ArtifactRevision,
    Contributor,
    ContributorCredit,
    NoteBlock,
    Podcast,
    PodcastSubscription,
    SynthesisArtifact,
)
from nexus.db.session import create_session_factory
from nexus.services import media_intelligence
from nexus.services.artifacts import engine as artifact_engine
from nexus.services.resource_graph.citations import record_citation
from nexus.services.resource_graph.cleanup import delete_edges_for_deleted_resource
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot, EdgeCreate


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def seed() -> dict[str, object]:
    owner_id = UUID(require_env("NEXUS_E2E_OWNER_USER_ID"))
    media_id = UUID(require_env("NEXUS_E2E_MEDIA_ID"))
    page_id = UUID(require_env("NEXUS_E2E_PAGE_ID"))
    session_factory = create_session_factory()

    with session_factory() as db:
        note_id = uuid4()
        note_text = "Inspector fixture note with grounded source context."
        db.add(
            NoteBlock(
                id=note_id,
                user_id=owner_id,
                body_pm_json={
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": note_text}],
                        }
                    ],
                },
                body_text=note_text,
            )
        )
        db.flush()
        create_edge(
            db,
            viewer_id=owner_id,
            input=EdgeCreate(
                source=ResourceRef(scheme="page", id=page_id),
                target=ResourceRef(scheme="note_block", id=note_id),
                kind="context",
                origin="user",
                source_order_key="0000000001",
            ),
        )

        podcast_id = uuid4()
        db.add(
            Podcast(
                id=podcast_id,
                provider="e2e_fixture",
                provider_podcast_id=f"resource-inspector-{podcast_id}",
                title="E2E Resource Inspector Podcast",
                feed_url=f"https://example.invalid/resource-inspector/{podcast_id}.xml",
                description="A fixture podcast for the shared Companion shell.",
            )
        )
        db.add(
            PodcastSubscription(
                user_id=owner_id,
                podcast_id=podcast_id,
                status="active",
                sync_status="complete",
            )
        )

        contributor_id = uuid4()
        contributor_handle = f"e2e-inspector-{contributor_id.hex[:16]}"
        contributor_name = "E2E Inspector Author"
        db.add(
            Contributor(
                id=contributor_id,
                handle=contributor_handle,
                display_name=contributor_name,
            )
        )
        next_ordinal = int(
            db.execute(
                text(
                    "SELECT COALESCE(MAX(ordinal), -1) + 1 "
                    "FROM contributor_credits WHERE media_id = :media_id"
                ),
                {"media_id": media_id},
            ).scalar_one()
        )
        credit_id = uuid4()
        db.add(
            ContributorCredit(
                id=credit_id,
                contributor_id=contributor_id,
                media_id=media_id,
                credited_name=contributor_name,
                normalized_credited_name=contributor_name.lower(),
                role="author",
                ordinal=next_ordinal,
                source="manual",
            )
        )

        prior_summary = (
            db.execute(
                text(
                    "SELECT id, content_fingerprint, summary_md, model_name, status, "
                    "error_code, error_detail "
                    "FROM media_summaries WHERE media_id = :media_id"
                ),
                {"media_id": media_id},
            )
            .mappings()
            .first()
        )
        summary_backup = (
            {
                "kind": "present",
                "id": str(prior_summary["id"]),
                "content_fingerprint": str(prior_summary["content_fingerprint"]),
                "summary_md": str(prior_summary["summary_md"]),
                "model_name": str(prior_summary["model_name"]),
                "status": str(prior_summary["status"]),
                "error_code": prior_summary["error_code"],
                "error_detail": prior_summary["error_detail"],
            }
            if prior_summary is not None
            else {"kind": "absent"}
        )
        current_fingerprint = media_intelligence.current_content_fingerprint(
            db, media_id=media_id
        )
        abstract_text = (
            "A compact, reusable media-intelligence abstract exposed above the dossier."
        )
        if prior_summary is None:
            summary_id = uuid4()
            db.execute(
                text(
                    "INSERT INTO media_summaries "
                    "(id, media_id, content_fingerprint, summary_md, model_name, status) "
                    "VALUES (:id, :media_id, :fingerprint, :summary, "
                    "'e2e-resource-inspector', 'ready')"
                ),
                {
                    "id": summary_id,
                    "media_id": media_id,
                    "fingerprint": current_fingerprint,
                    "summary": abstract_text,
                },
            )
        else:
            summary_id = UUID(str(prior_summary["id"]))
            db.execute(
                text(
                    "UPDATE media_summaries SET "
                    "content_fingerprint = :fingerprint, summary_md = :summary, "
                    "model_name = 'e2e-resource-inspector', status = 'ready', "
                    "error_code = NULL, error_detail = NULL, updated_at = now() "
                    "WHERE id = :id"
                ),
                {
                    "id": summary_id,
                    "fingerprint": current_fingerprint,
                    "summary": abstract_text,
                },
            )

        artifact_id = uuid4()
        old_build_id = uuid4()
        current_build_id = uuid4()
        old_revision_id = uuid4()
        current_revision_id = uuid4()
        now = datetime.now(UTC)
        manifest = {
            "version": "v1",
            "kind": "page",
            "page_ref": f"page:{page_id}",
            "input_fingerprint": "e2e-resource-inspector-fixture",
            "block_refs": [f"note_block:{note_id}"],
            "connection_refs": [f"media:{media_id}"],
        }
        db.add(
            SynthesisArtifact(
                id=artifact_id,
                subject_scheme="page",
                subject_id=page_id,
                audience_scheme="user",
                audience_id=str(owner_id),
            )
        )
        db.flush()
        db.add_all(
            [
                ArtifactBuild(
                    id=old_build_id,
                    artifact_id=artifact_id,
                    requester_user_id=owner_id,
                    instruction="Earlier fixture emphasis",
                    idempotency_key=f"e2e-inspector-old-{old_build_id}",
                    created_at=now - timedelta(days=1),
                ),
                ArtifactBuild(
                    id=current_build_id,
                    artifact_id=artifact_id,
                    requester_user_id=owner_id,
                    instruction="Current fixture emphasis",
                    idempotency_key=f"e2e-inspector-current-{current_build_id}",
                    created_at=now,
                ),
            ]
        )
        db.flush()
        db.add_all(
            [
                ArtifactRevision(
                    id=old_revision_id,
                    build_id=old_build_id,
                    content_md=(
                        "# Earlier fixture dossier\n\n"
                        "The earlier synthesis cites its grounded source [1]."
                    ),
                    input_manifest=manifest,
                    citation_owner_user_id=owner_id,
                    creator_user_id=owner_id,
                    promoted_at=now - timedelta(days=1),
                    created_at=now - timedelta(days=1),
                ),
                ArtifactRevision(
                    id=current_revision_id,
                    build_id=current_build_id,
                    content_md=(
                        "# Current fixture dossier\n\n"
                        "The current synthesis cites its grounded source [1]."
                    ),
                    input_manifest=manifest,
                    citation_owner_user_id=owner_id,
                    creator_user_id=owner_id,
                    promoted_at=now,
                    created_at=now,
                ),
            ]
        )
        db.flush()
        for revision_id in (old_revision_id, current_revision_id):
            record_citation(
                db,
                viewer_id=owner_id,
                source=ResourceRef(scheme="artifact_revision", id=revision_id),
                target=ResourceRef(scheme="media", id=media_id),
                ordinal=1,
                kind="supports",
                snapshot=CitationSnapshot(
                    title="E2E grounded media",
                    excerpt="Grounded evidence for the Inspector acceptance journey.",
                    result_type="media",
                    deep_link=f"/media/{media_id}",
                ),
            )
        db.execute(
            text(
                "UPDATE artifacts SET current_revision_id = :revision_id, "
                "updated_at = now() WHERE id = :artifact_id"
            ),
            {"revision_id": current_revision_id, "artifact_id": artifact_id},
        )
        db.commit()

        return {
            "page_id": str(page_id),
            "note_id": str(note_id),
            "podcast_id": str(podcast_id),
            "contributor_id": str(contributor_id),
            "contributor_handle": contributor_handle,
            "credit_id": str(credit_id),
            "artifact_id": str(artifact_id),
            "old_revision_ref": f"artifact_revision:{old_revision_id}",
            "current_revision_ref": f"artifact_revision:{current_revision_id}",
            "abstract_text": abstract_text,
            "summary_id": str(summary_id),
            "summary_backup": summary_backup,
        }


def cleanup(fixture: dict[str, object]) -> None:
    owner_id = UUID(require_env("NEXUS_E2E_OWNER_USER_ID"))
    media_id = UUID(require_env("NEXUS_E2E_MEDIA_ID"))
    page_id = UUID(str(fixture["page_id"]))
    note_id = UUID(str(fixture["note_id"]))
    podcast_id = UUID(str(fixture["podcast_id"]))
    contributor_id = UUID(str(fixture["contributor_id"]))
    credit_id = UUID(str(fixture["credit_id"]))
    summary_id = UUID(str(fixture["summary_id"]))
    summary_backup = fixture["summary_backup"]
    if not isinstance(summary_backup, dict):
        raise RuntimeError("Invalid summary backup")

    session_factory = create_session_factory()
    with session_factory() as db:
        artifact_engine.on_subject_deleted(db, ResourceRef(scheme="page", id=page_id))
        delete_edges_for_deleted_resource(
            db, ref=ResourceRef(scheme="note_block", id=note_id)
        )
        delete_edges_for_deleted_resource(
            db, ref=ResourceRef(scheme="page", id=page_id)
        )
        db.execute(text("DELETE FROM note_blocks WHERE id = :id"), {"id": note_id})
        db.execute(
            text("DELETE FROM contributor_credits WHERE id = :id"),
            {"id": credit_id},
        )
        db.execute(
            text("DELETE FROM contributors WHERE id = :id"),
            {"id": contributor_id},
        )
        db.execute(
            text("DELETE FROM library_entries WHERE podcast_id = :podcast_id"),
            {"podcast_id": podcast_id},
        )
        db.execute(
            text(
                "DELETE FROM podcast_subscriptions "
                "WHERE user_id = :owner_id AND podcast_id = :podcast_id"
            ),
            {"owner_id": owner_id, "podcast_id": podcast_id},
        )
        db.execute(
            text("DELETE FROM podcasts WHERE id = :podcast_id"),
            {"podcast_id": podcast_id},
        )
        if summary_backup.get("kind") == "present":
            db.execute(
                text(
                    "UPDATE media_summaries SET "
                    "content_fingerprint = :content_fingerprint, "
                    "summary_md = :summary_md, model_name = :model_name, "
                    "status = :status, error_code = :error_code, "
                    "error_detail = :error_detail, updated_at = now() "
                    "WHERE id = :id AND media_id = :media_id"
                ),
                {
                    "id": summary_id,
                    "media_id": media_id,
                    "content_fingerprint": summary_backup["content_fingerprint"],
                    "summary_md": summary_backup["summary_md"],
                    "model_name": summary_backup["model_name"],
                    "status": summary_backup["status"],
                    "error_code": summary_backup["error_code"],
                    "error_detail": summary_backup["error_detail"],
                },
            )
        else:
            db.execute(
                text("DELETE FROM media_claims WHERE summary_id = :summary_id"),
                {"summary_id": summary_id},
            )
            db.execute(
                text(
                    "DELETE FROM media_summaries "
                    "WHERE id = :summary_id AND media_id = :media_id"
                ),
                {"summary_id": summary_id, "media_id": media_id},
            )
        db.commit()


def main() -> None:
    mode = require_env("NEXUS_E2E_RESOURCE_INSPECTOR_MODE")
    if mode == "seed":
        print(json.dumps(seed(), sort_keys=True))
        return
    if mode == "cleanup":
        raw = require_env("NEXUS_E2E_RESOURCE_INSPECTOR_FIXTURE")
        cleanup(json.loads(raw))
        print(json.dumps({"cleaned": True}))
        return
    raise RuntimeError(f"Unknown mode: {mode}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
