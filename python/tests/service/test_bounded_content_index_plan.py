"""Bounded document content-index planning and spool contracts."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media, ProcessingStatus
from nexus.errors import ApiErrorCode
from nexus.jobs.queue import JobExecutionContext
from nexus.services import content_indexing
from tests.testkit.auth import UserRecord
from tests.testkit.unreachable_state import supersede_content_index_revision


def _pdf_block(canonical_text: str) -> content_indexing.IndexableBlock:
    owner = content_indexing.IndexOwner("media", uuid4())
    quote = {"exact": canonical_text, "prefix": "", "suffix": ""}
    locator: dict[str, object] = {
        "kind": "pdf_text",
        "page_number": 1,
        "physical_page_number": 1,
        "page_label": "1",
        "plain_text_start_offset": 0,
        "plain_text_end_offset": len(canonical_text),
        "page_text_start_offset": 0,
        "page_text_end_offset": len(canonical_text),
        "text_quote": quote,
    }
    selector = {
        "kind": "pdf_text_quote",
        "page_number": 1,
        "physical_page_number": 1,
        "page_label": "1",
        "plain_text_start_offset": 0,
        "plain_text_end_offset": len(canonical_text),
        "page_text_start_offset": 0,
        "page_text_end_offset": len(canonical_text),
        "text_quote": quote,
    }
    return content_indexing.IndexableBlock(
        owner=owner,
        source_kind="pdf",
        block_idx=0,
        block_kind="pdf_text_block",
        canonical_text=canonical_text,
        extraction_confidence=None,
        source_start_offset=0,
        source_end_offset=len(canonical_text),
        locator=locator,
        selector=selector,
        heading_path=("p. 1",),
        metadata={"page_number": 1, "page_label": "1"},
    )


class _DeterministicEmbeddings:
    def __init__(self, *, dimensions: int) -> None:
        self.dimensions = dimensions
        self.batch_sizes: list[int] = []

    def __call__(self, texts: list[str]) -> tuple[str, list[list[float]]]:
        self.batch_sizes.append(len(texts))
        return (
            "openai_text_embedding_3_small_256_v1",
            [[float(index % 7) / 7 for index in range(self.dimensions)] for _ in texts],
        )


def _materialization_snapshot(db: Session, media_id: UUID) -> tuple[object, ...]:
    return tuple(
        db.execute(
            text(
                """
                SELECT
                    (SELECT status FROM content_index_states
                     WHERE owner_kind = 'media' AND owner_id = :media_id),
                    (SELECT COUNT(*) FROM content_blocks
                     WHERE owner_kind = 'media' AND owner_id = :media_id),
                    (SELECT COUNT(*) FROM content_chunks
                     WHERE owner_kind = 'media' AND owner_id = :media_id),
                    (SELECT COUNT(*) FROM content_embeddings ce
                     JOIN content_chunks cc ON cc.id = ce.chunk_id
                     WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id)
                """
            ),
            {"media_id": media_id},
        ).one()
    )


def _build_plan(
    tmp_path: Path,
    canonical_text: str,
) -> tuple[
    content_indexing.SpooledContentIndexPlan,
    _DeterministicEmbeddings,
]:
    block = _pdf_block(canonical_text)
    embeddings = _DeterministicEmbeddings(dimensions=256)
    plan = content_indexing.build_spooled_content_index_plan(
        owner=block.owner,
        source_kind="pdf",
        blocks=[block],
        spool_path=tmp_path / "content-index.jsonl",
        embed_texts=embeddings,
    )
    return plan, embeddings


def test_document_plan_batches_exactly_and_streams_a_closed_spool(tmp_path: Path) -> None:
    canonical_text = " ".join(f"word-{index}" for index in range(25_500))
    plan, embeddings = _build_plan(tmp_path, canonical_text)

    chunks = list(content_indexing.read_spooled_content_index_chunks(plan))

    assert plan.chunk_count == len(chunks) > 64, (
        "fixture must cross one provider batch and the closed trailer must name every chunk"
    )
    assert embeddings.batch_sizes, "document planning never crossed the embedding boundary"
    assert max(embeddings.batch_sizes) <= content_indexing.CONTENT_INDEX_EMBEDDING_BATCH_SIZE
    assert sum(embeddings.batch_sizes) == plan.chunk_count
    assert [chunk.parts[0][1] for chunk in chunks] == sorted(
        chunk.parts[0][1] for chunk in chunks
    ), "spooled chunks did not preserve canonical document order"
    assert all(len(chunk.embedding_f32) == plan.embedding_dimensions * 4 for chunk in chunks)


@pytest.mark.parametrize("corruption", ["truncate", "extra", "order", "parts"])
def test_document_spool_corruption_fails_closed(
    tmp_path: Path,
    corruption: str,
) -> None:
    plan, _ = _build_plan(tmp_path, " ".join(f"word-{index}" for index in range(900)))
    lines = plan.spool_path.read_bytes().splitlines(keepends=True)
    assert len(lines) >= 4, "corruption fixture did not produce multiple chunk records"

    if corruption == "truncate":
        plan.spool_path.write_bytes(b"".join(lines[:-1]))
    elif corruption == "extra":
        plan.spool_path.write_bytes(b"".join((*lines, b"{}\n")))
    elif corruption == "order":
        plan.spool_path.write_bytes(b"".join((lines[0], lines[2], lines[1], *lines[3:])))
    else:
        altered = lines[1].replace(b'"block_idx":0', b'"block_idx":7', 1)
        plan.spool_path.write_bytes(b"".join((lines[0], altered, *lines[2:])))

    with pytest.raises(content_indexing.ContentIndexSpoolCorruption):
        list(content_indexing.read_spooled_content_index_chunks(plan))


def test_document_plan_rejects_one_oversized_embedding_chunk_without_a_partial_spool(
    tmp_path: Path,
) -> None:
    canonical_text = "x" * (content_indexing.CONTENT_INDEX_CHUNK_MAX_BYTES + 1)
    block = _pdf_block(canonical_text)
    spool_path = tmp_path / "content-index.jsonl"

    with pytest.raises(content_indexing.ContentIndexResourceLimitExceeded) as raised:
        content_indexing.build_spooled_content_index_plan(
            owner=block.owner,
            source_kind="pdf",
            blocks=[block],
            spool_path=spool_path,
            embed_texts=_DeterministicEmbeddings(dimensions=256),
        )

    assert raised.value.error_code is ApiErrorCode.E_SOURCE_TOO_LARGE
    assert str(raised.value) == "Document content exceeds the bounded indexing envelope."
    assert not spool_path.exists(), "resource rejection retained a partial content-index spool"


def test_document_spool_size_is_checked_before_any_record_is_read(tmp_path: Path) -> None:
    block = _pdf_block("bounded")
    spool_path = tmp_path / "oversized-content-index.jsonl"
    with spool_path.open("wb") as spool:
        spool.truncate(content_indexing.CONTENT_INDEX_SPOOL_MAX_BYTES + 1)
    plan = content_indexing.SpooledContentIndexPlan(
        owner=block.owner,
        source_kind="pdf",
        blocks=(block,),
        spool_path=spool_path,
        chunk_count=1,
        embedding_provider="openai",
        embedding_model="openai_text_embedding_3_small_256_v1",
        embedding_dimensions=256,
    )

    with pytest.raises(content_indexing.ContentIndexSpoolCorruption):
        list(content_indexing.read_spooled_content_index_chunks(plan))


@pytest.mark.parametrize(
    ("invalid_result", "error_match"),
    [("model", "model"), ("count", "count"), ("dimensions", "dimensions")],
)
def test_embedding_result_shape_is_validated_before_spool_publication(
    tmp_path: Path,
    invalid_result: str,
    error_match: str,
) -> None:
    block = _pdf_block("bounded document")
    spool_path = tmp_path / "content-index.jsonl"

    def invalid_embeddings(texts: list[str]) -> tuple[str, Sequence[list[float]]]:
        if invalid_result == "model":
            return "foreign-model", [[0.0] * 256 for _ in texts]
        if invalid_result == "count":
            return "openai_text_embedding_3_small_256_v1", []
        return "openai_text_embedding_3_small_256_v1", [[0.0]]

    with pytest.raises(ValueError, match=error_match):
        content_indexing.build_spooled_content_index_plan(
            owner=block.owner,
            source_kind="pdf",
            blocks=[block],
            spool_path=spool_path,
            embed_texts=invalid_embeddings,
        )
    assert not spool_path.exists(), "invalid embedding output retained a partial spool"


def test_corrupt_document_spool_rolls_back_and_preserves_the_prior_materialization(
    db_session: Session,
    test_user: UserRecord,
    tmp_path: Path,
) -> None:
    block = _pdf_block("prior canonical document materialization")
    db_session.add(
        Media(
            id=block.owner.id,
            kind="pdf",
            title="Atomic document index proof",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=test_user.id,
            plain_text=block.canonical_text,
            page_count=1,
        )
    )
    db_session.flush()
    plan = content_indexing.build_spooled_content_index_plan(
        owner=block.owner,
        source_kind="pdf",
        blocks=[block],
        spool_path=tmp_path / "content-index.jsonl",
        embed_texts=_DeterministicEmbeddings(dimensions=256),
    )
    result = content_indexing.publish_content_index(
        db_session,
        plan=plan,
        reason="source_success",
    )
    db_session.commit()
    assert result.status == "ready" and result.chunk_count == 1

    prior = _materialization_snapshot(db_session, block.owner.id)
    lines = plan.spool_path.read_bytes().splitlines(keepends=True)
    plan.spool_path.write_bytes(b"".join(lines[:-1]))

    with pytest.raises(content_indexing.ContentIndexSpoolCorruption):
        content_indexing.publish_content_index(
            db_session,
            plan=plan,
            reason="operator_repair",
        )
    db_session.rollback()

    after = _materialization_snapshot(db_session, block.owner.id)
    assert after == prior == ("ready", 1, 1, 1), (
        "corrupt document spool changed the prior canonical index despite transaction rollback"
    )


def test_stale_document_plan_cannot_replace_the_prior_materialization(
    db_session: Session,
    test_user: UserRecord,
    tmp_path: Path,
) -> None:
    block = _pdf_block("stale document plan fencing proof")
    db_session.add(
        Media(
            id=block.owner.id,
            kind="pdf",
            title="Stale document index proof",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=test_user.id,
            plain_text=block.canonical_text,
            page_count=1,
        )
    )
    db_session.flush()
    plan = content_indexing.build_spooled_content_index_plan(
        owner=block.owner,
        source_kind="pdf",
        blocks=[block],
        spool_path=tmp_path / "content-index.jsonl",
        embed_texts=_DeterministicEmbeddings(dimensions=256),
    )
    content_indexing.publish_content_index(db_session, plan=plan, reason="source_success")
    db_session.commit()
    prior = _materialization_snapshot(db_session, block.owner.id)
    supersede_content_index_revision(
        db_session,
        owner_id=block.owner.id,
        expected_revision=0,
    )
    work = content_indexing.MediaContentReindexWork(
        media_id=block.owner.id,
        revision=0,
        source_kind="pdf",
        reason="source_success",
        blocks=(block,),
    )

    result = content_indexing.publish_media_content_reindex(
        db_session,
        work=work,
        plan=plan,
        context=JobExecutionContext(
            job_id=uuid4(),
            worker_id="stale-plan-proof",
            attempt_no=1,
            resource_class="Heavy",
        ),
        lease_seconds=900,
    )

    assert result is None, "obsolete document revision crossed the publication fence"
    after = _materialization_snapshot(db_session, block.owner.id)
    assert after[1:] == prior[1:] == (1, 1, 1), (
        "stale document plan changed the prior canonical materialization"
    )
