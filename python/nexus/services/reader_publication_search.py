"""Prepared normalized text and sparse original-coordinate maps for evidence.

Reflowable source text is already globally NFC. PDF raw text is not: normalize
complete graphemes before staging normalized chunks, and attest only the original
page. Raw PDF bytes remain a separate literal geometry-matching projection.
Preparation writes bounded chunks to its caller-owned tempfile. Installation
streams those chunks through COPY inside the existing publication transaction.
"""

from __future__ import annotations

import hashlib
import json
import math
import unicodedata
from dataclasses import dataclass, replace
from itertools import zip_longest
from typing import BinaryIO
from uuid import UUID

import regex
from sqlalchemy import insert, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ReaderPublicationSearchMap, ReaderPublicationSearchSource


@dataclass(frozen=True)
class PreparedReaderSearchChunk:
    offset: int
    size: int
    sha256: str
    normalized_start: int
    normalized_end: int
    page_number: int | None


@dataclass(frozen=True)
class PreparedReaderSearchSource:
    source_ordinal: int
    fragment_id: UUID | None
    raw_codepoints: int
    normalized_codepoints: int
    chunks: tuple[PreparedReaderSearchChunk, ...]
    pdf_page_spans: tuple[tuple[int, int, int] | None, ...] | None
    pdf_page_heights: tuple[float | None, ...] | None


@dataclass(frozen=True)
class PreparedReaderSearch:
    file: BinaryIO
    sources: tuple[PreparedReaderSearchSource, ...]


def normalize_reader_search_chunk(
    text: str, *, raw_start: int, normalized_start: int, previous_space: bool
) -> tuple[str, list[int], list[int], bool]:
    """Collapse whitespace with piecewise-constant original offset deltas."""
    normalized: list[str] = []
    run_starts: list[int] = []
    raw_deltas: list[int] = []
    for offset, point in enumerate(text, raw_start):
        space = point.isspace()
        if space and previous_space:
            continue
        position = normalized_start + len(normalized)
        delta = offset - position
        if not raw_deltas or raw_deltas[-1] != delta:
            run_starts.append(position)
            raw_deltas.append(delta)
        normalized.append(" " if space else point)
        previous_space = space
    return "".join(normalized), run_starts, raw_deltas, previous_space


class ReaderSearchPreparation:
    """One streaming preparation pass, sharing the publication's temp ownership."""

    def __init__(self, file: BinaryIO, *, chunk_codepoints: int) -> None:
        self.file = file
        self.chunk_codepoints = chunk_codepoints
        self.sources: list[PreparedReaderSearchSource] = []
        self.chunks: list[PreparedReaderSearchChunk] = []
        self.previous_space = False

    def append(
        self,
        *,
        source_ordinal: int,
        fragment_id: UUID,
        raw_start: int,
        text: str,
        page_number: int | None = None,
    ) -> None:
        if len(text) > self.chunk_codepoints:
            raise ValueError("Search preparation chunk exceeds its admitted source extent")
        if not self.sources or self.sources[-1].source_ordinal != source_ordinal:
            if self.sources:
                if source_ordinal <= self.sources[-1].source_ordinal:
                    raise ValueError("Search sources must retain original source order")
                self.sources[-1] = replace(self.sources[-1], chunks=tuple(self.chunks))
            self.sources.append(
                PreparedReaderSearchSource(source_ordinal, fragment_id, 0, 0, (), None, None)
            )
            self.chunks.clear()
            self.previous_space = False
        source = self.sources[-1]
        if source.fragment_id != fragment_id or source.raw_codepoints != raw_start:
            raise ValueError("Search chunks must cover their original source contiguously")
        normalized, starts, deltas, self.previous_space = normalize_reader_search_chunk(
            text,
            raw_start=raw_start,
            normalized_start=source.normalized_codepoints,
            previous_space=self.previous_space,
        )
        end = source.normalized_codepoints + len(normalized)
        if normalized:
            value = {"text": normalized, "run_starts": starts, "raw_deltas": deltas}
            payload = json.dumps(
                value,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            chunk = PreparedReaderSearchChunk(
                self.file.tell(),
                len(payload),
                hashlib.sha256(payload).hexdigest(),
                source.normalized_codepoints,
                end,
                page_number,
            )
            self.file.write(payload)
            self.chunks.append(chunk)
        self.sources[-1] = replace(
            source, raw_codepoints=raw_start + len(text), normalized_codepoints=end
        )

    def finish(self) -> PreparedReaderSearch:
        if self.sources:
            self.sources[-1] = replace(self.sources[-1], chunks=tuple(self.chunks))
        return PreparedReaderSearch(self.file, tuple(self.sources))


def prepare_pdf_reader_search(
    file: BinaryIO,
    *,
    plain_text: str,
    page_spans: tuple[tuple[int, int, int], ...],
    page_heights: tuple[tuple[int, float | None], ...],
    page_count: int,
    chunk_codepoints: int,
) -> PreparedReaderSearch:
    """Keep raw literal text; normalize passages without inventing raw intervals.

    NFC contributors may reorder or compose discontiguously. PDF passage
    navigation needs the beginning page, not an invented exact raw range.
    Normalize whole graphemes across staging cuts; each must belong entirely to
    one source page to attest that page. The largest source grapheme remains
    part of the existing worker source-memory qualification, never API parsing.
    """
    previous_end = previous_page = 0
    indexed_heights: list[float | None] = [None] * page_count
    previous_height_page = 0
    for number, height in page_heights:
        if not previous_height_page < number <= page_count or (
            height is not None and (not math.isfinite(height) or height <= 0)
        ):
            raise ValueError("PDF overview height differs from its selected source")
        indexed_heights[number - 1] = height
        previous_height_page = number
    indexed_pages: list[tuple[int, int, int] | None] = [None] * page_count
    for page_number, start, end in page_spans:
        if not previous_page < page_number <= page_count or not previous_end <= start <= end <= len(
            plain_text
        ):
            raise ValueError("PDF search page spans differ from their canonical source")
        indexed_pages[page_number - 1] = (page_number, start, end)
        previous_end, previous_page = end, page_number
    chunks: list[PreparedReaderSearchChunk] = []
    normalized_offset = 0

    def stage(raw_text: str, normalized_text: str, page: int | None) -> None:
        nonlocal normalized_offset
        payload = json.dumps(
            {"raw_text": raw_text, "text": normalized_text, "run_starts": None, "raw_deltas": None},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        end = normalized_offset + len(normalized_text)
        chunks.append(
            PreparedReaderSearchChunk(
                file.tell(),
                len(payload),
                hashlib.sha256(payload).hexdigest(),
                normalized_offset,
                end,
                page,
            )
        )
        file.write(payload)
        normalized_offset = end

    for start in range(0, len(plain_text), chunk_codepoints):
        stage(plain_text[start : start + chunk_codepoints], "", None)
    buffer: list[str] = []
    buffer_page = None
    previous_space = False
    page_index = 0
    for cluster in regex.finditer(r"\X", plain_text):
        while page_index < len(page_spans) and page_spans[page_index][2] <= cluster.start():
            page_index += 1
        page = None
        if page_index < len(page_spans):
            number, start, end = page_spans[page_index]
            if start <= cluster.start() and cluster.end() <= end:
                page = number
        for point in unicodedata.normalize("NFC", cluster.group()):
            space = point.isspace()
            if not (space and previous_space):
                if buffer and (page != buffer_page or len(buffer) == chunk_codepoints):
                    stage("", "".join(buffer), buffer_page)
                    buffer.clear()
                buffer_page = page
                buffer.append(" " if space else point)
            previous_space = space
    if buffer:
        stage("", "".join(buffer), buffer_page)
    return PreparedReaderSearch(
        file,
        (
            PreparedReaderSearchSource(
                0,
                None,
                len(plain_text),
                normalized_offset,
                tuple(chunks),
                tuple(indexed_pages),
                tuple(indexed_heights),
            ),
        ),
    )


def _read_chunk(prepared: PreparedReaderSearch, chunk: PreparedReaderSearchChunk) -> dict:
    prepared.file.seek(chunk.offset)
    payload = prepared.file.read(chunk.size)
    if len(payload) != chunk.size or hashlib.sha256(payload).hexdigest() != chunk.sha256:
        raise AssertionError("Staged search projection differs from its prepared bytes")
    return json.loads(payload)


def install_reader_search(
    db: Session, *, media_id: UUID, generation: int, prepared: PreparedReaderSearch
) -> None:
    """COPY source text without constructing a whole-fragment Python binding.

    A search source belongs to exactly one branch: a PDF source addresses its text
    by page and carries the page spans and heights, a fragment source addresses its
    text by fragment and carries neither. Conditional nullability like that is this
    owner's to enforce, not the schema's, so the branch is checked here before any
    row is written.
    """
    for source in prepared.sources:
        pdf_source = source.fragment_id is None
        if pdf_source != (source.pdf_page_spans is not None) or pdf_source != (
            source.pdf_page_heights is not None
        ):
            # justify-defect: the preparers own both halves of a source's branch, so
            # page geometry without a PDF source -- or a PDF source without it -- is
            # a broken preparation, never a state a publication can install.
            raise AssertionError("Prepared search source mixes the PDF and fragment branches")
    driver = db.connection().connection.driver_connection
    if driver is None:
        raise AssertionError("Publication transaction has no PostgreSQL connection")
    with (
        driver.cursor() as cursor,
        cursor.copy(
            "COPY reader_publication_search_sources "
            "(media_id, generation, source_ordinal, fragment_id, raw_codepoints, "
            "normalized_codepoints, pdf_page_spans, pdf_page_heights, canonical_text, normalized_text) FROM STDIN"
        ) as copy,
    ):
        for source in prepared.sources:
            header = "\t".join(
                (
                    str(media_id),
                    str(generation),
                    str(source.source_ordinal),
                    str(source.fragment_id) if source.fragment_id is not None else "\\N",
                    str(source.raw_codepoints),
                    str(source.normalized_codepoints),
                    json.dumps(source.pdf_page_spans, separators=(",", ":"))
                    if source.pdf_page_spans is not None
                    else "\\N",
                    json.dumps(source.pdf_page_heights, separators=(",", ":"))
                    if source.pdf_page_heights is not None
                    else "\\N",
                    "",
                )
            )
            copy.write(header.encode("ascii"))
            if source.fragment_id is None:
                for chunk in source.chunks:
                    raw = _read_chunk(prepared, chunk)["raw_text"].encode("utf-8")
                    copy.write(
                        raw.replace(b"\\", b"\\\\")
                        .replace(b"\n", b"\\n")
                        .replace(b"\r", b"\\r")
                        .replace(b"\t", b"\\t")
                    )
            else:
                copy.write(b"\\N")
            copy.write(b"\t")
            for chunk in source.chunks:
                value = _read_chunk(prepared, chunk)
                copy.write(value["text"].encode("utf-8").replace(b"\\", b"\\\\"))
            copy.write(b"\n")
    # Same PostgreSQL word predicate as media.plain_text_word_count; the staged
    # span array has exactly page_count slots and distinguishes absent spans.
    db.execute(
        text("""
            UPDATE reader_publication_search_sources
            SET pdf_quote_text_ready = CASE WHEN fragment_id IS NULL THEN
                regexp_count(canonical_text, '[^[:space:]]+') > 0
                AND jsonb_array_length(pdf_page_spans) > 0
                AND NOT jsonb_path_exists(pdf_page_spans, '$[*] ? (@ == null)')
                ELSE NULL END
            WHERE media_id = :media AND generation = :generation
        """),
        {"media": media_id, "generation": generation},
    )
    for source in prepared.sources:
        for chunk in source.chunks:
            if chunk.normalized_start == chunk.normalized_end:
                continue
            value = _read_chunk(prepared, chunk)
            if source.fragment_id is not None and chunk.page_number is not None:
                # justify-defect: only a PDF source has pages; a fragment source's
                # extent is addressed by its fragment, never by a page number.
                raise AssertionError("Prepared search map claims a page outside a PDF source")
            if (source.fragment_id is not None) != (value["run_starts"] is not None):
                # justify-defect: normalized-to-original run offsets exist exactly for
                # the fragment branch, which normalizes in place; the PDF branch
                # retains raw text instead and maps no runs.
                raise AssertionError("Prepared search map offset runs contradict its source")
            db.execute(
                insert(ReaderPublicationSearchMap).values(
                    media_id=media_id,
                    generation=generation,
                    source_ordinal=source.source_ordinal,
                    normalized_start=chunk.normalized_start,
                    normalized_end=chunk.normalized_end,
                    page_number=chunk.page_number,
                    run_starts=value["run_starts"],
                    raw_deltas=value["raw_deltas"],
                )
            )


def verify_reader_search(
    db: Session, *, media_id: UUID, generation: int, prepared: PreparedReaderSearch
) -> None:
    """Compare exact normalized bytes and map semantics, irrespective of chunk cuts.

    The database hashes its one retained source value once. Query/cgroup
    qualification must include that detoast/digest allocation; Python receives
    only the digest, scalar source facts, and one bounded map row at a time.
    """
    rows = db.execute(
        select(
            ReaderPublicationSearchSource.source_ordinal,
            ReaderPublicationSearchSource.fragment_id,
            ReaderPublicationSearchSource.raw_codepoints,
            ReaderPublicationSearchSource.normalized_codepoints,
            ReaderPublicationSearchSource.pdf_page_spans,
            ReaderPublicationSearchSource.pdf_page_heights,
        )
        .where(
            ReaderPublicationSearchSource.media_id == media_id,
            ReaderPublicationSearchSource.generation == generation,
        )
        .order_by(ReaderPublicationSearchSource.source_ordinal)
    ).yield_per(1)
    for stored, source in zip_longest(rows, prepared.sources):
        if (
            stored is None
            or source is None
            or tuple(stored[:4])
            != (
                source.source_ordinal,
                source.fragment_id,
                source.raw_codepoints,
                source.normalized_codepoints,
            )
            or (
                None
                if stored.pdf_page_spans is None
                else tuple(None if span is None else tuple(span) for span in stored.pdf_page_spans)
            )
            != source.pdf_page_spans
            or (None if stored.pdf_page_heights is None else tuple(stored.pdf_page_heights))
            != source.pdf_page_heights
        ):
            raise ValueError("Retained search source facts differ from canonical content")
        digest = hashlib.sha256()
        raw_digest = hashlib.sha256()
        for chunk in source.chunks:
            value = _read_chunk(prepared, chunk)
            digest.update(value["text"].encode("utf-8"))
            if source.fragment_id is None:
                raw_digest.update(value["raw_text"].encode("utf-8"))
        stored_digest = db.scalar(
            text(
                "SELECT encode(sha256(convert_to(normalized_text, 'UTF8')), 'hex') "
                "FROM reader_publication_search_sources "
                "WHERE media_id = :media AND generation = :generation AND source_ordinal = :ordinal"
            ),
            {"media": media_id, "generation": generation, "ordinal": source.source_ordinal},
        )
        if stored_digest != digest.hexdigest():
            raise ValueError("Retained normalized search text differs from canonical content")
        if source.fragment_id is None:
            ready_valid = db.scalar(
                text("""
                SELECT pdf_quote_text_ready IS NOT DISTINCT FROM (
                    regexp_count(canonical_text, '[^[:space:]]+') > 0
                    AND jsonb_array_length(pdf_page_spans) > 0
                    AND NOT jsonb_path_exists(pdf_page_spans, '$[*] ? (@ == null)')
                ) FROM reader_publication_search_sources
                WHERE media_id = :media AND generation = :generation AND source_ordinal = :ordinal
            """),
                {"media": media_id, "generation": generation, "ordinal": source.source_ordinal},
            )
            if not ready_valid:
                raise ValueError("Retained PDF quote readiness differs from its source")
            stored_raw_digest = db.scalar(
                text(
                    "SELECT encode(sha256(convert_to(canonical_text, 'UTF8')), 'hex') "
                    "FROM reader_publication_search_sources "
                    "WHERE media_id = :media AND generation = :generation AND source_ordinal = :ordinal"
                ),
                {"media": media_id, "generation": generation, "ordinal": source.source_ordinal},
            )
            if stored_raw_digest != raw_digest.hexdigest():
                raise ValueError("Retained PDF canonical text differs from its source")

        def expected_runs(source: PreparedReaderSearchSource = source):
            previous = None
            for chunk in source.chunks:
                value = _read_chunk(prepared, chunk)
                if chunk.normalized_start == chunk.normalized_end:
                    continue
                runs = (
                    ((chunk.normalized_start, None),)
                    if source.fragment_id is None
                    else zip(value["run_starts"], value["raw_deltas"], strict=True)
                )
                for start, delta in runs:
                    identity = (delta, chunk.page_number)
                    if identity != previous:
                        yield (start, *identity)
                        previous = identity

        def stored_runs(source: PreparedReaderSearchSource = source):
            previous = None
            end = 0
            result = db.execute(
                select(
                    ReaderPublicationSearchMap.normalized_start,
                    ReaderPublicationSearchMap.normalized_end,
                    ReaderPublicationSearchMap.page_number,
                    ReaderPublicationSearchMap.run_starts,
                    ReaderPublicationSearchMap.raw_deltas,
                )
                .where(
                    ReaderPublicationSearchMap.media_id == media_id,
                    ReaderPublicationSearchMap.generation == generation,
                    ReaderPublicationSearchMap.source_ordinal == source.source_ordinal,
                )
                .order_by(ReaderPublicationSearchMap.normalized_start)
                .execution_options(yield_per=1)
            )
            for row in result:
                if row.normalized_start != end:
                    raise ValueError("Retained search maps do not cover normalized content")
                if source.fragment_id is None:
                    if row.run_starts is not None or row.raw_deltas is not None:
                        raise ValueError("PDF page map cannot claim exact raw offsets")
                    runs = ((row.normalized_start, None),)
                else:
                    if row.run_starts is None or row.raw_deltas is None:
                        raise ValueError("Text search map has no exact raw offsets")
                    runs = zip(row.run_starts, row.raw_deltas, strict=True)
                last_start = row.normalized_start - 1
                for start, delta in runs:
                    if not last_start < start < row.normalized_end:
                        raise ValueError("Retained search map offsets are not ordered")
                    identity = (delta, row.page_number)
                    if identity != previous:
                        yield (start, *identity)
                        previous = identity
                    last_start = start
                end = row.normalized_end
            if end != source.normalized_codepoints:
                raise ValueError("Retained search maps do not cover normalized content")

        if any(left != right for left, right in zip_longest(expected_runs(), stored_runs())):
            raise ValueError("Retained search offsets differ from canonical content")


def reader_passage_search_rows_sql(anchor_relation: str) -> str:
    """Resolve supplied anchor_id rows in selected :media_id/:generation.

    Stored passage quotes are already normalized. Their canonical context is
    trimmed, and source whitespace is one space at most, so four complete
    literal needles preserve the existing optional seam-space rule. Searching
    complete needles avoids rescanning a long source for every rejected prefix.
    PostgreSQL returns at most two distinct scalar hits per anchor; this owner
    never hydrates a complete quote or source into foreground Python.
    """
    matches = reader_publication_quote_matches_sql(
        "SELECT anchor.selector #>> '{quote,exact}' AS exact, "
        "coalesce(anchor.selector #>> '{quote,prefix}', '') AS prefix, "
        "coalesce(anchor.selector #>> '{quote,suffix}', '') AS suffix"
    )
    return f"""
        SELECT anchor.id AS anchor_id, matches.hit_count,
               matches.fragment_id, matches.raw_start, matches.raw_end,
               matches.page_number
        FROM ({anchor_relation}) requested
        JOIN passage_anchors anchor ON anchor.id = requested.anchor_id
        LEFT JOIN LATERAL (
            {matches}
        ) matches ON TRUE
        WHERE anchor.user_id = :viewer_id AND anchor.owner_scheme = 'media'
          AND anchor.owner_id = :media_id
    """


def reader_publication_quote_matches_sql(quote_select: str) -> str:
    """Two scalar normalized matches for one supplied exact/prefix/suffix row.

    quote_select is owned SQL, never request text. Inputs use the existing
    normalize_for_match contract; source/start maps remain publication-owned.
    """
    return f"""
    WITH quote AS MATERIALIZED (
        {quote_select}
    ), variants AS MATERIALIZED (
        SELECT DISTINCT prefix || before_gap || exact || after_gap || suffix AS needle,
               char_length(prefix) + char_length(before_gap) AS quote_offset,
               char_length(exact) AS quote_length
        FROM quote
        CROSS JOIN (VALUES (''), (' ')) before_space(before_gap)
        CROSS JOIN (VALUES (''), (' ')) after_space(after_gap)
        WHERE exact <> ''
          AND (prefix <> '' OR before_gap = '')
          AND (suffix <> '' OR after_gap = '')
    ), hits AS MATERIALIZED (
        SELECT DISTINCT source.source_ordinal, source.fragment_id,
               hit.position - 1 + variants.quote_offset AS start_position,
               hit.position - 1 + variants.quote_offset + variants.quote_length AS end_position
        FROM reader_publication_search_sources source
        CROSS JOIN variants
        CROSS JOIN LATERAL (
            SELECT strpos(source.normalized_text, variants.needle) AS position
        ) first_hit
        CROSS JOIN LATERAL (VALUES
            (first_hit.position),
            (CASE WHEN first_hit.position > 0 THEN first_hit.position + nullif(
                strpos(substring(source.normalized_text FROM first_hit.position + 1), variants.needle), 0
            ) END)
        ) hit(position)
        WHERE source.media_id = :media_id AND source.generation = :generation
          AND hit.position > 0
        LIMIT 2
    ), resolved AS (
        SELECT hit.*, CASE WHEN hit.fragment_id IS NOT NULL
                   THEN hit.start_position + first_delta.delta END AS raw_start,
               CASE WHEN hit.fragment_id IS NOT NULL
                   THEN hit.end_position - 1 + last_delta.delta + 1 END AS raw_end,
               first_map.page_number
        FROM hits hit
        JOIN LATERAL (
            SELECT map.* FROM reader_publication_search_maps map
            WHERE map.media_id = :media_id AND map.generation = :generation
              AND map.source_ordinal = hit.source_ordinal
              AND map.normalized_start <= hit.start_position
              AND map.normalized_end > hit.start_position
            ORDER BY map.normalized_start DESC LIMIT 1
        ) first_map ON TRUE
        LEFT JOIN LATERAL (
            SELECT run.delta FROM unnest(first_map.run_starts, first_map.raw_deltas)
                AS run(start_position, delta)
            WHERE run.start_position <= hit.start_position
            ORDER BY run.start_position DESC LIMIT 1
        ) first_delta ON TRUE
        JOIN LATERAL (
            SELECT map.* FROM reader_publication_search_maps map
            WHERE map.media_id = :media_id AND map.generation = :generation
              AND map.source_ordinal = hit.source_ordinal
              AND map.normalized_start < hit.end_position
              AND map.normalized_end >= hit.end_position
            ORDER BY map.normalized_start DESC LIMIT 1
        ) last_map ON TRUE
        LEFT JOIN LATERAL (
            SELECT run.delta FROM unnest(last_map.run_starts, last_map.raw_deltas)
                AS run(start_position, delta)
            WHERE run.start_position < hit.end_position
            ORDER BY run.start_position DESC LIMIT 1
        ) last_delta ON TRUE
    )
    SELECT (SELECT count(*) FROM hits) AS hit_count,
           (SELECT fragment_id FROM resolved LIMIT 1) AS fragment_id,
           (SELECT raw_start FROM resolved LIMIT 1) AS raw_start,
           (SELECT raw_end FROM resolved LIMIT 1) AS raw_end,
           (SELECT page_number FROM resolved LIMIT 1) AS page_number
    """
