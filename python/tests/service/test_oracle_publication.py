"""Oracle is visible only after exact PostgreSQL and object support is published."""

from __future__ import annotations

from collections.abc import Generator
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import (
    ContentChunk,
    ContentIndexState,
    Media,
    OracleCorpusPublication,
    OracleCorpusSource,
    OraclePassageAnchor,
    OraclePlate,
    ProcessingStatus,
)
from nexus.ops.oracle_reconcile import _reconcile_corpus_database
from nexus.oracle.manifest import OracleCorpusManifestWork, OracleManifest
from nexus.services import library_entries, oracle_corpus
from nexus.services.semantic_chunks import (
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
)
from nexus.storage.client import StorageClientBase, get_storage_client
from tests.testkit.auth import UserRecord


@pytest.fixture
def oracle_manifest() -> OracleManifest:
    return OracleManifest.model_validate(
        {
            "schema_version": 1,
            "works": [
                {
                    "work_key": "work",
                    "title": "Title",
                    "author_text": "Author",
                    "source_repository": "repo",
                    "source_url": "https://example.invalid/work",
                    "source_download_url": "https://example.invalid/work.txt",
                    "source_media_kind": "web_article",
                    "display_order": 1,
                    "passage_anchors": [
                        {
                            "passage_key": "passage",
                            "display_label": "Passage",
                            "selector": {"kind": "text_quote", "exact": "Words"},
                            "tags": ["x"],
                            "phase_hints": [],
                        }
                    ],
                }
            ],
            "plates": [
                {
                    "source_repository": "repo",
                    "source_url": "https://example.invalid/plate.jpg",
                    "artist": "Artist",
                    "work_title": "Plate",
                    "year": None,
                    "attribution_text": "Attribution",
                    "resolved_source_url": "https://example.invalid/plate-bytes.jpg",
                    "tags": ["x"],
                }
            ],
        }
    )


@pytest.fixture
def oracle_support(
    db_session: Session,
    test_user: UserRecord,
    oracle_manifest: OracleManifest,
) -> Generator[tuple[StorageClientBase, str], None, None]:
    storage = get_storage_client()
    storage_key = "oracle/plates/plate.jpg"
    payload = b"oracle-publication-proof"
    db_session.query(OraclePlate).delete(synchronize_session=False)
    library_id = oracle_corpus.ensure_oracle_corpus_library(db_session, owner_user_id=test_user.id)
    media = Media(
        id=uuid4(),
        kind="web_article",
        title="Title",
        requested_url="https://example.invalid/work.txt",
        canonical_url="https://example.invalid/work.txt",
        canonical_source_url="https://example.invalid/work.txt",
        processing_status=ProcessingStatus.ready_for_reading,
        created_by_user_id=test_user.id,
    )
    db_session.add(media)
    db_session.flush()
    library_entries.seed_media_into_system_library(db_session, library_id, media.id)
    source = OracleCorpusSource(
        corpus_key="oracle",
        work_key="work",
        library_id=library_id,
        media_id=media.id,
        title="Title",
        author_text="Author",
        source_repository="repo",
        source_url="https://example.invalid/work",
        source_download_url="https://example.invalid/work.txt",
        source_media_kind="web_article",
        display_order=1,
    )
    db_session.add(source)
    db_session.flush()
    db_session.add(
        ContentIndexState(
            owner_kind="media",
            owner_id=media.id,
            revision=1,
            status="ready",
            active_embedding_provider=current_transcript_embedding_provider(),
            active_embedding_model=current_transcript_embedding_model(),
        )
    )
    chunk = ContentChunk(
        owner_kind="media",
        owner_id=media.id,
        chunk_idx=0,
        source_kind="web_article",
        chunk_text="Words",
        token_count=1,
        heading_path=[],
        summary_locator={},
    )
    db_session.add(chunk)
    db_session.flush()
    db_session.add(
        OraclePassageAnchor(
            corpus_source_id=source.id,
            passage_key="passage",
            display_label="Passage",
            selector={"kind": "text_quote", "exact": "Words"},
            tags=["x"],
            phase_hints=[],
            current_content_chunk_id=chunk.id,
            resolution_status="resolved",
            resolved_at=db_session.scalar(select(func.now())),
        )
    )
    db_session.add(
        OraclePlate(
            source_repository="repo",
            source_page_url="https://example.invalid/plate.jpg",
            source_url="https://example.invalid/plate-bytes.jpg",
            license_text="public domain",
            artist="Artist",
            work_title="Plate",
            year=None,
            attribution_text="Attribution",
            width=1,
            height=1,
            storage_key=storage_key,
            content_type="image/jpeg",
            byte_size=len(payload),
            tags=["x"],
        )
    )
    db_session.flush()
    db_session.commit()
    storage.put_object(storage_key, payload, "image/jpeg")
    try:
        yield storage, storage_key
    finally:
        storage.delete_object(storage_key)


def test_publication_is_last_and_removal_rejects_before_unpublish(
    db_session: Session,
    test_user: UserRecord,
    oracle_manifest: OracleManifest,
    oracle_support: tuple[StorageClientBase, str],
) -> None:
    storage, storage_key = oracle_support
    provider = current_transcript_embedding_provider()
    model = current_transcript_embedding_model()

    database = oracle_corpus.inspect_oracle_corpus_database(
        db_session,
        manifest=oracle_manifest,
        owner_user_id=test_user.id,
    )
    db_session.commit()
    unpublished = oracle_corpus.complete_oracle_corpus_inspection(
        database,
        storage_client=storage,
    )
    assert unpublished.support_ready
    assert not unpublished.published
    assert (
        oracle_corpus.get_oracle_corpus_readiness(
            db_session,
            expected_manifest_digest=oracle_manifest.manifest_digest,
        ).status
        == "not_ready"
    )
    storage.delete_object(storage_key)
    missing_object = oracle_corpus.complete_oracle_corpus_inspection(
        database,
        storage_client=storage,
    )
    assert not missing_object.support_ready
    with pytest.raises(ValueError, match="not ready"):
        oracle_corpus.publish_oracle_corpus(db_session, inspection=missing_object)
    storage.put_object(storage_key, b"oracle-publication-proof", "image/jpeg")

    exact = oracle_corpus.complete_oracle_corpus_inspection(
        database,
        storage_client=storage,
    )
    oracle_corpus.publish_oracle_corpus(db_session, inspection=exact)
    db_session.commit()
    assert oracle_corpus.oracle_publication_matches(
        db_session,
        expected_manifest_digest=oracle_manifest.manifest_digest,
        embedding_provider=provider,
        embedding_model=model,
    )
    assert (
        oracle_corpus.get_oracle_corpus_readiness(
            db_session,
            expected_manifest_digest=oracle_manifest.manifest_digest,
        ).status
        == "ready"
    )
    assert (
        oracle_corpus.get_oracle_corpus_readiness(
            db_session,
            expected_manifest_digest="sha256:" + "0" * 64,
        ).status
        == "not_ready"
    )
    with pytest.raises(ValueError, match="unpublished before support"):
        oracle_corpus.require_oracle_corpus_unpublished(db_session)

    source_id = db_session.query(OracleCorpusSource.id).filter_by(work_key="work").scalar()
    assert source_id is not None
    db_session.add(
        OraclePassageAnchor(
            corpus_source_id=source_id,
            passage_key="published-extra",
            display_label="Published extra",
            selector={"kind": "text_quote", "exact": "Words"},
            tags=[],
            phase_hints=[],
        )
    )
    db_session.flush()
    with pytest.raises(ValueError, match="remove"):
        oracle_corpus.reject_oracle_manifest_removals(db_session, manifest=oracle_manifest)
    assert oracle_corpus.oracle_publication_matches(
        db_session,
        expected_manifest_digest=oracle_manifest.manifest_digest,
        embedding_provider=provider,
        embedding_model=model,
    )

    oracle_corpus.unpublish_oracle_corpus(db_session)
    db_session.commit()
    oracle_corpus.require_oracle_corpus_unpublished(db_session)
    assert not oracle_corpus.oracle_publication_matches(
        db_session,
        expected_manifest_digest=oracle_manifest.manifest_digest,
        embedding_provider=provider,
        embedding_model=model,
    )
    assert (
        oracle_corpus.get_oracle_corpus_readiness(
            db_session,
            expected_manifest_digest=oracle_manifest.manifest_digest,
        ).status
        == "not_ready"
    )


def test_reconcile_updates_selectors_without_pruning_existing_anchors(
    db_session: Session,
    test_user: UserRecord,
    oracle_manifest: OracleManifest,
    oracle_support: tuple[StorageClientBase, str],
) -> None:
    del oracle_support
    source = db_session.query(OracleCorpusSource).filter_by(work_key="work").one()
    db_session.add(
        OraclePassageAnchor(
            corpus_source_id=source.id,
            passage_key="unsupported-removal",
            display_label="Preserved",
            selector={"kind": "text_quote", "exact": "Words"},
            tags=[],
            phase_hints=[],
        )
    )
    changed_work_payload = oracle_manifest.works[0].model_dump(mode="json")
    changed_work_payload["passage_anchors"][0]["selector"]["exact"] = "Changed words"
    changed_work = OracleCorpusManifestWork.model_validate(changed_work_payload)

    oracle_corpus.ensure_oracle_corpus_media(
        db_session,
        owner_user_id=test_user.id,
        library_id=source.library_id,
        work=changed_work,
    )
    db_session.commit()

    anchors = {
        anchor.passage_key: anchor
        for anchor in db_session.query(OraclePassageAnchor)
        .filter_by(corpus_source_id=source.id)
        .all()
    }
    assert set(anchors) == {"passage", "unsupported-removal"}
    assert anchors["passage"].selector == {
        "kind": "text_quote",
        "exact": "Changed words",
    }
    assert anchors["passage"].resolution_status == "pending"
    assert anchors["passage"].current_content_chunk_id is None


def test_corpus_reconcile_commits_the_library_before_attaching_media(
    db_session: Session,
    test_user: UserRecord,
    oracle_manifest: OracleManifest,
) -> None:
    sessions = sessionmaker(
        bind=db_session.get_bind(),
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )

    media_ids = _reconcile_corpus_database(
        session_factory=sessions,
        manifest=oracle_manifest,
        owner_user_id=test_user.id,
    )

    assert len(media_ids) == 1
    with sessions() as db:
        source = db.query(OracleCorpusSource).filter_by(work_key="work").one()
        assert source.media_id == media_ids[0]


def test_invalid_publication_domain_fails_closed(
    db_session: Session,
    oracle_manifest: OracleManifest,
) -> None:
    provider = current_transcript_embedding_provider()
    model = current_transcript_embedding_model()
    db_session.add(
        OracleCorpusPublication(
            corpus_key="legacy",
            manifest_digest=oracle_manifest.manifest_digest,
            embedding_provider=provider,
            embedding_model=model,
        )
    )
    db_session.commit()

    assert not oracle_corpus.oracle_publication_matches(
        db_session,
        expected_manifest_digest=oracle_manifest.manifest_digest,
        embedding_provider=provider,
        embedding_model=model,
    )
    with pytest.raises(ValueError, match="unsupported marker keys"):
        oracle_corpus.unpublish_oracle_corpus(db_session)
