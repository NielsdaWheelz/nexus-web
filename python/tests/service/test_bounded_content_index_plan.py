"""Bounded document content-index planning and spool contracts."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media, ProcessingStatus
from nexus.jobs.queue import JobExecutionContext
from nexus.services import content_indexing
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.fragment_blocks import parse_fragment_blocks
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


@pytest.mark.parametrize("shape", ["ascii", "astral", "combining"])
def test_document_plan_splits_accepted_unbroken_text_with_exact_source_ranges(
    tmp_path: Path,
    shape: str,
) -> None:
    canonical_text = (
        "x" * (8 * 1024 * 1024)
        if shape == "ascii"
        else "🧠" * 70_000
        if shape == "astral"
        else "q" + "́" * 150_000
    )
    block = _pdf_block(canonical_text)
    embeddings = _DeterministicEmbeddings(dimensions=256)

    def bounded_embeddings(texts: list[str]) -> tuple[str, list[list[float]]]:
        assert all(0 < len(value.encode("utf-8")) <= 8191 for value in texts), (
            "accepted source exceeded the per-input embedding byte envelope"
        )
        return embeddings(texts)

    plan = content_indexing.build_spooled_content_index_plan(
        owner=block.owner,
        source_kind="pdf",
        blocks=[block],
        spool_path=tmp_path / "content-index.jsonl",
        embed_texts=bounded_embeddings,
    )
    end = 0
    count = 0
    for chunk in content_indexing.read_spooled_content_index_chunks(plan):
        assert len(chunk.parts) == 1
        _, start, following, words = chunk.parts[0]
        assert start == end and following > start and words == 1
        assert chunk.text == canonical_text[start:following]
        assert chunk.locator["plain_text_start_offset"] == start
        assert chunk.locator["plain_text_end_offset"] == following
        assert chunk.locator["page_text_start_offset"] == start
        assert chunk.locator["page_text_end_offset"] == following
        assert chunk.locator["text_quote"]["exact"] == chunk.text
        end = following
        count += 1
    assert end == len(canonical_text) and count == plan.chunk_count > 1
    assert sum(embeddings.batch_sizes) == count
    assert max(embeddings.batch_sizes) <= 64


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
    ("first_text", "second_text", "second_start"),
    [("a" * 5000, "b" * 5000, 5000), ("left", "right", 6)],
)
def test_document_plan_keeps_separate_chunks_when_bytes_or_source_gaps_require_it(
    tmp_path: Path, first_text: str, second_text: str, second_start: int
) -> None:
    first = _pdf_block(first_text)
    second = _pdf_block(second_text)
    second_end = second_start + len(second_text)
    second = replace(
        second,
        owner=first.owner,
        block_idx=1,
        source_start_offset=second_start,
        source_end_offset=second_end,
        locator={
            **second.locator,
            "plain_text_start_offset": second_start,
            "plain_text_end_offset": second_end,
            "page_text_start_offset": second_start,
            "page_text_end_offset": second_end,
        },
        selector={
            **second.selector,
            "plain_text_start_offset": second_start,
            "plain_text_end_offset": second_end,
            "page_text_start_offset": second_start,
            "page_text_end_offset": second_end,
        },
    )
    plan = content_indexing.build_spooled_content_index_plan(
        owner=first.owner,
        source_kind="pdf",
        blocks=[first, second],
        spool_path=tmp_path / "adjacent.jsonl",
        embed_texts=_DeterministicEmbeddings(dimensions=256),
    )
    chunks = list(content_indexing.read_spooled_content_index_chunks(plan))
    assert [(chunk.text, chunk.locator["plain_text_start_offset"]) for chunk in chunks] == [
        (first_text, 0),
        (second_text, second_start),
    ], "coalesced source blocks exceeded the byte envelope or invented an unknown source gap"


@pytest.mark.parametrize("shape", ["paragraphs", "byte-fit", "byte-overflow"])
def test_document_plan_coalesces_exact_source_paragraphs_with_original_delimiters(
    tmp_path: Path, shape: str
) -> None:
    words = (
        ["x"] * 1000
        if shape == "paragraphs"
        else ["é" * 4094, "z" if shape == "byte-fit" else "zzz"]
    )
    html = "".join(f"<p>{word}<br/><br/></p>" for word in words)
    source = "\n\n".join(words)
    assert generate_canonical_text(html) == source
    fragment_id, media_id = uuid4(), uuid4()
    specs = parse_fragment_blocks(source)
    assert len(specs) == len(words)
    blocks = content_indexing.build_fragment_indexable_blocks(
        media_id=media_id,
        source_kind="epub",
        fragments=[{"id": fragment_id, "idx": 0, "canonical_text": source, "html_sanitized": html}],
        media_title=None,
        nav_by_fragment_idx={},
        fragment_blocks_by_id={
            fragment_id: [
                (fragment_id, spec.block_idx, spec.start_offset, spec.end_offset) for spec in specs
            ]
        },
    )
    embeddings = _DeterministicEmbeddings(dimensions=256)
    plan = content_indexing.build_spooled_content_index_plan(
        owner=blocks[0].owner,
        source_kind="epub",
        blocks=blocks,
        spool_path=tmp_path / "paragraphs.jsonl",
        embed_texts=embeddings,
    )
    chunks = list(content_indexing.read_spooled_content_index_chunks(plan))
    expected_count = 3 if shape == "paragraphs" else 1 if shape == "byte-fit" else 2
    assert len(chunks) == expected_count, (
        "exact adjacent source paragraphs were not coalesced within the embedding envelope"
    )
    for chunk in chunks:
        start, end = chunk.locator["start_offset"], chunk.locator["end_offset"]
        assert chunk.text == source[start:end]
        assert chunk.locator["text_quote"]["exact"] == source[start:end]
        assert chunk.locator["fragment_id"] == str(fragment_id)
        assert len(chunk.text.encode("utf-8")) <= 8191
        assert sum(part[3] for part in chunk.parts) <= 420
    if shape == "paragraphs":
        assert [chunk.text for chunk in chunks] == [
            "\n\n".join(["x"] * count) for count in (420, 420, 160)
        ]
        assert [chunk.locator["start_offset"] for chunk in chunks] == [0, 1260, 2520]
        assert chunks[-1].locator["end_offset"] == len(source)
    elif shape == "byte-fit":
        assert chunks[0].text == source and len(source.encode("utf-8")) == 8191
    else:
        assert [chunk.text for chunk in chunks] == words
        assert chunks[1].locator["start_offset"] == 4096


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
            execution_id=uuid4(),
        ),
        lease_seconds=900,
    )

    assert result is None, "obsolete document revision crossed the publication fence"
    after = _materialization_snapshot(db_session, block.owner.id)
    assert after[1:] == prior[1:] == (1, 1, 1), (
        "stale document plan changed the prior canonical materialization"
    )


@pytest.mark.parametrize("shape", ["paragraphs", "large-block"])
def test_publication_batches_preserve_source_and_roll_back_after_late_spool_failure(
    db_session: Session, test_user: UserRecord, tmp_path: Path, shape: str
) -> None:
    import hashlib
    import json
    import os
    import re

    from sqlalchemy import Text, cast, event, select

    from nexus.db.models import (
        ContentBlock,
        ContentChunk,
        ContentChunkPart,
        ContentEmbedding,
        EvidenceSpan,
        Fragment,
    )

    words = (
        [f"word{index}" for index in range(1000)]
        if shape == "paragraphs"
        else ["abcdefghijklmn"] * 100000
    )
    paragraphs = (
        words if shape == "paragraphs" else [" ".join(words[:420])] * 70 + [" ".join(words)]
    )
    source = "\n\n".join(paragraphs)
    html = "".join(f"<p>{paragraph}<br/><br/></p>" for paragraph in paragraphs)
    if shape == "large-block":
        # The first 64 ordinary blocks exceed the byte envelope even before
        # metadata: each stores canonical text and two exact quote copies.
        assert sum(len(value.encode()) * 3 for value in paragraphs[:64]) > 1048576
    assert generate_canonical_text(html) == source
    media_id, fragment_id = uuid4(), uuid4()
    db_session.add(
        Media(
            id=media_id,
            kind="epub",
            title="Index publication batch proof",
            processing_status=ProcessingStatus.ready_for_reading,
            created_by_user_id=test_user.id,
        )
    )
    db_session.flush()
    db_session.add(
        Fragment(
            id=fragment_id, media_id=media_id, idx=0, canonical_text=source, html_sanitized=html
        )
    )
    db_session.flush()
    specs = parse_fragment_blocks(source)
    blocks = content_indexing.build_fragment_indexable_blocks(
        media_id=media_id,
        source_kind="epub",
        fragments=[{"id": fragment_id, "idx": 0, "canonical_text": source, "html_sanitized": html}],
        media_title=None,
        nav_by_fragment_idx={},
        fragment_blocks_by_id={
            fragment_id: [
                (fragment_id, spec.block_idx, spec.start_offset, spec.end_offset) for spec in specs
            ]
        },
    )
    plan = content_indexing.build_spooled_content_index_plan(
        owner=blocks[0].owner,
        source_kind="epub",
        blocks=blocks,
        spool_path=tmp_path / "batch-publication.jsonl",
        embed_texts=_DeterministicEmbeddings(dimensions=256),
    )
    observed: list[dict[str, object]] = []
    tables = {
        "content_blocks",
        "evidence_spans",
        "content_chunks",
        "content_chunk_parts",
        "content_embeddings",
    }

    def observe_insert(_connection, _cursor, statement, parameters, _context, many):
        matched = re.match(r"\s*INSERT INTO (\w+)\s*\(", statement)
        if matched is None or matched[1] not in tables:
            return
        rows = parameters if many else (parameters,)
        # Independent observation of the actual driver parameters. This proof
        # records scalar sizes/counts, never retains another parameter corpus.
        size = sum(
            len(str(key).encode()) + len(str(value).encode())
            for row in rows
            for key, value in row.items()
        )
        observed.append({"table": matched[1], "rows": len(rows), "bytes": size})

    connection = db_session.connection()
    event.listen(connection, "before_cursor_execute", observe_insert)
    try:
        result = content_indexing.publish_content_index(
            db_session, plan=plan, reason="source_success"
        )
    finally:
        event.remove(connection, "before_cursor_execute", observe_insert)
    db_session.commit()
    rows = db_session.execute(
        select(
            ContentChunk.id,
            ContentChunk.chunk_idx,
            ContentChunk.chunk_text,
            ContentChunk.summary_locator,
            EvidenceSpan.span_text,
            EvidenceSpan.selector,
            ContentEmbedding.embedding_provider,
            ContentEmbedding.embedding_model,
            ContentEmbedding.embedding_dimensions,
            cast(ContentEmbedding.embedding_vector, Text).label("embedding_vector"),
        )
        .join(EvidenceSpan, ContentChunk.primary_evidence_span_id == EvidenceSpan.id)
        .join(ContentEmbedding, ContentEmbedding.chunk_id == ContentChunk.id)
        .where(ContentChunk.owner_kind == "media", ContentChunk.owner_id == media_id)
        .order_by(ContentChunk.chunk_idx)
    ).all()
    expected_texts = (
        ["\n\n".join(words[start : start + 420]) for start in range(0, 1000, 420)]
        if shape == "paragraphs"
        else paragraphs[:70]
        + [" ".join(words[start : start + 420]) for start in range(0, 100000, 360)]
    )
    assert result.status == "ready" and result.chunk_count == len(expected_texts)
    assert [row.chunk_text for row in rows] == expected_texts
    for index, row in enumerate(rows):
        assert row.chunk_idx == index
        assert row.embedding_provider == "openai"
        assert row.embedding_model == "openai_text_embedding_3_small_256_v1"
        assert row.embedding_dimensions == 256
        assert json.loads(row.embedding_vector) == pytest.approx(
            [float(i % 7) / 7 for i in range(256)]
        )
        locator = row.summary_locator
        start, end = locator["start_offset"], locator["end_offset"]
        assert row.chunk_text == row.span_text == source[start:end]
        assert row.selector == locator and locator["fragment_id"] == str(fragment_id)
        assert locator["text_quote"]["exact"] == row.chunk_text
        parts = db_session.execute(
            select(
                ContentChunkPart.part_idx,
                ContentChunkPart.block_start_offset,
                ContentChunkPart.block_end_offset,
                ContentChunkPart.chunk_start_offset,
                ContentChunkPart.chunk_end_offset,
                ContentChunkPart.separator_before,
                ContentBlock.canonical_text,
            )
            .join(ContentBlock, ContentChunkPart.block_id == ContentBlock.id)
            .where(ContentChunkPart.chunk_id == row.id)
            .order_by(ContentChunkPart.part_idx)
        ).all()
        position = 0
        for part_index, part in enumerate(parts):
            assert part.part_idx == part_index
            text = part.canonical_text[part.block_start_offset : part.block_end_offset]
            assert row.chunk_text[position : part.chunk_start_offset] == part.separator_before
            assert part.chunk_start_offset == position + len(part.separator_before)
            assert row.chunk_text[part.chunk_start_offset : part.chunk_end_offset] == text
            position = part.chunk_end_offset
        assert position == len(row.chunk_text)
    receipt_path = (
        Path(__file__).parents[3]
        / "test-results/runs"
        / os.environ["NEXUS_TEST_RUN_ID"]
        / f"content-index-batches-{shape}.json"
    )
    receipt = {
        "shape": shape,
        "source_utf8_bytes": len(source.encode()),
        "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
        "chunks": len(rows),
        "inserts": observed,
        "scope": "real PostgreSQL publication; prepared parameter bytes/counts, not physical heap or heartbeat qualification",
    }
    receipt_path.write_text(json.dumps(receipt) + "\n")
    for table in ("content_blocks", "evidence_spans", "content_chunks", "content_embeddings"):
        writes = [entry for entry in observed if entry["table"] == table]
        row_count = sum(entry["rows"] for entry in writes)
        if row_count > 64:
            assert len(writes) < row_count, "content-index publication still writes individual rows"
    for entry in observed:
        if entry["table"] == "content_blocks":
            assert entry["rows"] <= 64
            assert entry["bytes"] <= 1048576 or entry["rows"] == 1
    groups: list[list[dict[str, object]]] = []
    for entry in observed:
        if entry["table"] == "content_blocks":
            continue
        if entry["table"] == "evidence_spans":
            groups.append([])
        groups[-1].append(entry)
    for group in groups:
        if (
            sum(item["rows"] for item in group) > 64
            or sum(item["bytes"] for item in group) > 1048576
        ):
            assert all(
                item["rows"] == 1 for item in group if item["table"] != "content_chunk_parts"
            ), "oversized publication group shared a batch"
    if shape == "large-block":
        assert any(
            entry["table"] == "content_blocks" and entry["bytes"] > 1048576 and entry["rows"] == 1
            for entry in observed
        )
    else:
        assert any(
            entry["table"] == "content_chunk_parts" and entry["rows"] > 64 for entry in observed
        )

    prior_ids = [row.id for row in rows]
    prior = _materialization_snapshot(db_session, media_id)
    lines = plan.spool_path.read_bytes().splitlines(keepends=True)
    plan.spool_path.write_bytes(b"".join(lines[:-1]))
    observed.clear()
    connection = db_session.connection()
    event.listen(connection, "before_cursor_execute", observe_insert)
    try:
        with pytest.raises(content_indexing.ContentIndexSpoolCorruption):
            content_indexing.publish_content_index(db_session, plan=plan, reason="operator_repair")
    finally:
        event.remove(connection, "before_cursor_execute", observe_insert)
    assert sum(item["rows"] for item in observed if item["table"] == "content_chunks") > 0, (
        "late spool failure did not follow actual publication writes"
    )
    db_session.rollback()
    assert _materialization_snapshot(db_session, media_id) == prior
    assert (
        list(
            db_session.scalars(
                select(ContentChunk.id)
                .where(ContentChunk.owner_id == media_id)
                .order_by(ContentChunk.chunk_idx)
            )
        )
        == prior_ids
    )
