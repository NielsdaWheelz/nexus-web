"""The oracle corpus: ``corpus.json`` and its database projection (docs/modules/oracle.md).

One system media per work, one anchor per passage with a cache pointer into its work's
current index. ``seed`` converges the projection; readings heal and rank the anchors.
"""

import argparse
import hashlib
import json
import math
import re
import sys
import unicodedata
from collections import Counter
from collections.abc import Iterable
from functools import cache
from pathlib import Path
from typing import Literal, NamedTuple
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import Media, OracleCorpusSource, OraclePassageAnchor, ProcessingStatus
from nexus.db.session import get_session_factory
from nexus.services import library_entries, library_governance
from nexus.services.content_indexing import request_media_content_reindex
from nexus.services.media_source_ingest import (
    accept_system_url_source,
    repair_source_for_system_media,
)
from nexus.services.oracle.synthesis import Candidate
from nexus.services.search.chunks import score_content_chunks
from nexus.services.semantic_chunks import (
    current_transcript_embedding_model,
    current_transcript_embedding_provider,
)

SYSTEM_KEY = "oracle_corpus"
TOKEN = re.compile(r"[a-z]{3,}")


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Passage(_Frozen):
    key: str
    label: str
    tags: tuple[str, ...]
    quote: str


class Work(_Frozen):
    key: str
    title: str
    author: str
    kind: Literal["epub", "web_article", "pdf"]
    download_url: str
    passages: tuple[Passage, ...]


class Plate(_Frozen):
    key: str  # apps/web/public/oracle-plates/<key>.jpg; new bytes take a new key
    artist: str
    work_title: str
    year: str | None
    attribution: str
    tags: tuple[str, ...]
    width: int
    height: int
    page_url: str
    image_url: str
    licence: str


class _Corpus(_Frozen):
    works: tuple[Work, ...]
    plates: tuple[Plate, ...]


@cache
def _corpus() -> _Corpus:
    return _Corpus.model_validate_json(Path(__file__).with_name("corpus.json").read_bytes())


def works() -> tuple[Work, ...]:
    return _corpus().works


def plate(key: str) -> Plate:
    """Plate keys are permanent: a reading from before 0262 without a captured plate
    (its log had no plate event) shows its key's current record."""
    return {p.key: p for p in _corpus().plates}[key]


def pick_plate(question: str, tags: Iterable[str]) -> Plate:
    """The plate sharing most tags with the question's words and the offered passages."""
    signal = set(TOKEN.findall(question.lower())) | {tag.lower() for tag in tags}
    return min(_corpus().plates, key=lambda p: (-len(signal.intersection(p.tags)), p.key))


# ---------- reading-time: refresh and rank -----------------------------------


def refresh_anchors(db: Session) -> None:
    """Re-resolve pending anchors and resolved ones whose chunk left their work's ready
    active-model index. Unindexed works wait pending; an unmatched quote is failed until
    the next seed. Flush only; id order so concurrent jobs lock alike."""
    rows = db.execute(
        text(
            """
            SELECT a.id, a.quote, a.resolution_status, s.media_id,
                   cis.owner_id IS NOT NULL AS indexed
            FROM oracle_passage_anchors a
            JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
            LEFT JOIN content_index_states cis ON cis.owner_kind = 'media'
                AND cis.owner_id = s.media_id AND cis.status = 'ready'
                AND cis.active_embedding_provider = :provider
                AND cis.active_embedding_model = :model
            WHERE a.resolution_status = 'pending'
               OR (a.resolution_status = 'resolved' AND (cis.owner_id IS NULL OR NOT EXISTS (
                   SELECT 1 FROM content_chunks cc WHERE cc.id = a.current_content_chunk_id
                     AND cc.owner_kind = 'media' AND cc.owner_id = s.media_id)))
            ORDER BY a.id
            """
        ),
        _active_model(),
    ).all()
    chunks: dict[UUID, list[_Chunk]] = {}
    for anchor_id, quote, status, media_id, indexed in rows:
        if not indexed and status == "pending":
            continue
        match = None
        if indexed:
            if media_id not in chunks:
                chunks[media_id] = _ready_chunks(db, media_id)
            match = _match(quote, chunks[media_id])
        chunk_id, span_id = (None, None) if match is None else match
        db.execute(
            text(
                "UPDATE oracle_passage_anchors SET resolution_status = :status,"
                " current_content_chunk_id = :chunk, current_evidence_span_id = :span"
                " WHERE id = :id"
            ),
            {
                "id": anchor_id,
                "status": "resolved" if match else "failed" if indexed else "pending",
                "chunk": chunk_id,
                "span": span_id,
            },
        )


def rank_passages(
    db: Session, *, question: str, query_embedding: tuple[str, list[float]]
) -> list[Candidate]:
    """Up to six resolved passages, one per work, by similarity plus two per shared tag."""
    rows = db.execute(
        text(
            """
            SELECT a.id, a.passage_key, a.display_label, a.quote, a.tags,
                   a.current_content_chunk_id, s.work_key, s.title, s.author_text
            FROM oracle_passage_anchors a
            JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id
            WHERE a.resolution_status = 'resolved'
            """
        )
    ).all()
    similarity = score_content_chunks(
        db, query_embedding=query_embedding, chunk_ids=[row[5] for row in rows]
    )
    words = set(TOKEN.findall(question.lower()))
    scored = sorted(
        (
            (-(similarity[row[5]] + 2 * len(words.intersection(row[4]))), row[1], row)
            for row in rows
            if row[5] in similarity
        ),
        key=lambda item: item[:2],
    )
    chosen: dict[str, Candidate] = {}
    for _score, _key, row in scored:
        if row[6] not in chosen and len(chosen) < 6:
            chosen[row[6]] = Candidate(
                source_kind="public_domain",
                ref=f"oracle_passage_anchor:{row[0]}",
                attribution=f"{row[8]}, {row[7]}",
                locator=row[2],
                quote=row[3],
                tags=tuple(row[4]),
            )
    return list(chosen.values())


# ---------- the matcher: which ready chunk of a work quotes a passage ---------


class _Chunk(NamedTuple):
    id: UUID
    span_id: UUID | None
    alnum: str  # the folded text's alphanumerics
    tokens: list[str]
    counts: Counter[str]


# Editions differ in quotes, dashes, contractions and line breaks; both sides fold alike.
_EDITION = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-"})
_CONTRACTIONS = (
    (r"\bthro'\b", "through"),
    (r"\btho'\b", "though"),
    (r"\bne'er\b", "never"),
    (r"\bo'er\b", "over"),
    (r"\be'er\b", "ever"),
    (r"\b([a-zA-Z]+)'d\b", r"\1ed"),
)
_ALIASES = {"thro": "through", "tho": "though", "neer": "never", "oer": "over", "eer": "ever"}
_RATIO = 0.78


def _fold(value: str) -> str:
    value = value.translate(_EDITION)
    for pattern, replacement in _CONTRACTIONS:
        value = re.sub(pattern, replacement, value, flags=re.IGNORECASE)
    return unicodedata.normalize("NFKD", value).lower()


def _alnum(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", _fold(value))


def _tokens(value: str) -> list[str]:
    words: list[str] = re.findall(r"[a-z0-9]+", _fold(value))
    return [_ALIASES.get(word, word) for word in words if not word.isdigit()]


def _ready_chunks(db: Session, media_id: UUID) -> list[_Chunk]:
    rows = db.execute(
        text(
            "SELECT id, primary_evidence_span_id, chunk_text FROM content_chunks"
            " WHERE owner_kind = 'media' AND owner_id = :media_id ORDER BY chunk_idx"
        ),
        {"media_id": media_id},
    ).all()
    out: list[_Chunk] = []
    for chunk_id, span_id, chunk_text in rows:
        tokens = _tokens(chunk_text)
        out.append(_Chunk(chunk_id, span_id, _alnum(chunk_text), tokens, Counter(tokens)))
    return out


def _match(quote: str, chunks: list[_Chunk]) -> tuple[UUID, UUID | None] | None:
    """The first chunk holding the quote's first 80 alphanumerics, else one with a window of
    n-2..n+4 tokens sharing a common subsequence of max(6, 78% of n) tokens (and 78% of
    the longer side) with the quote's first n <= 18 tokens."""
    prefix = _alnum(quote)[:80]
    for chunk in chunks:
        if prefix and prefix in chunk.alnum:
            return chunk.id, chunk.span_id
    needle = _tokens(quote)[:18]
    n = len(needle)
    if n < 6:
        return None
    least = max(6, math.ceil(n * _RATIO))
    for chunk in chunks:
        tokens = chunk.tokens
        if sum((Counter(needle) & chunk.counts).values()) < least:
            continue
        for start in range(len(tokens) - max(6, n - 2) + 1):
            for size in range(max(6, n - 2), min(len(tokens), n + 4) + 1):
                if start + size > len(tokens):
                    break
                common = _lcs(needle, tokens[start : start + size])
                if common >= least and common / max(n, size) >= _RATIO:
                    return chunk.id, chunk.span_id
    return None


def _lcs(a: list[str], b: list[str]) -> int:
    previous = [0] * (len(b) + 1)
    for x in a:
        current = [0]
        for j, y in enumerate(b, start=1):
            current.append(previous[j - 1] + 1 if x == y else max(previous[j], current[j - 1]))
        previous = current
    return previous[-1]


# ---------- operator: seed ------------------------------------------------------


def seed(session_factory: sessionmaker[Session], *, owner_user_id: UUID) -> dict[str, int]:
    """Converge the database on corpus.json, one transaction per work; idempotent and safe
    while the app is live. Workers ingest and index; the next reading resolves anchors."""
    with session_factory() as db:
        library_id = library_governance.ensure_system_library(
            db, system_key=SYSTEM_KEY, name="Oracle Corpus", owner_user_id=owner_user_id
        )
    counts: Counter[str] = Counter()
    for work in works():
        with session_factory() as db:
            counts.update(_seed_work(db, work=work, library_id=library_id, owner=owner_user_id))
            db.commit()
    with session_factory() as db:
        kept = [f"{work.key}/{p.key}" for work in works() for p in work.passages]
        removed = db.execute(
            text(
                "DELETE FROM oracle_passage_anchors a USING oracle_corpus_sources s"
                " WHERE s.id = a.corpus_source_id"
                " AND s.work_key || '/' || a.passage_key <> ALL(:kept) RETURNING a.id"
            ),
            {"kept": kept},
        ).all()
        counts["anchors_removed"] = len(removed)
        db.commit()
    return {"works": len(works()), **counts}


def _seed_work(db: Session, *, work: Work, library_id: UUID, owner: UUID) -> Counter[str]:
    counts: Counter[str] = Counter()
    source = db.scalar(select(OracleCorpusSource).where(OracleCorpusSource.work_key == work.key))
    accepted = None
    if source is None or (source.source_download_url, source.source_media_kind) != (
        work.download_url,
        work.kind,
    ):
        digest = hashlib.sha256(work.download_url.encode()).hexdigest()[:16]
        accepted = accept_system_url_source(
            db=db,
            actor_user_id=owner,
            url=work.download_url,
            expected_kind=work.kind,
            system_source=SYSTEM_KEY,
            idempotency_key=f"oracle-corpus-oracle-{work.key}-{digest}",
        )
        counts["accepted"] += 1
        if source is None:
            source = OracleCorpusSource(work_key=work.key, media_id=accepted.media_id)
            db.add(source)
        elif source.media_id != accepted.media_id:
            superseded = source.media_id
            library_entries.lock_media_rows_in_order(db, [superseded, accepted.media_id])
            library_governance.lock_library_rows_in_order(db, [library_id])
            if library_entries.delete_entry(
                db, library_id, library_entries.media_target(superseded)
            ):
                library_entries.normalize_positions(db, library_id)
            source.media_id = accepted.media_id
    source.title = work.title
    source.author_text = work.author
    source.source_download_url = work.download_url
    source.source_media_kind = work.kind
    db.flush()
    library_entries.seed_media_into_system_library(db, library_id, source.media_id)
    if accepted is None or accepted.idempotency_outcome != "created":
        counts.update(_repair(db, work=work, media_id=source.media_id, owner=owner))

    anchors = {
        anchor.passage_key: anchor
        for anchor in db.scalars(
            select(OraclePassageAnchor).where(OraclePassageAnchor.corpus_source_id == source.id)
        )
    }
    for passage in work.passages:
        anchor = anchors.get(passage.key)
        if anchor is None:
            anchor = OraclePassageAnchor(corpus_source_id=source.id, passage_key=passage.key)
            db.add(anchor)
        if anchor.quote != passage.quote or anchor.resolution_status == "failed":
            anchor.quote = passage.quote
            anchor.resolution_status = "pending"
            anchor.current_content_chunk_id = None
            anchor.current_evidence_span_id = None
            counts["anchors_pending"] += 1
        anchor.display_label = passage.label
        anchor.tags = list(passage.tags)
    db.flush()
    return counts


def _repair(db: Session, *, work: Work, media_id: UUID, owner: UUID) -> Counter[str]:
    media = db.get(Media, media_id)
    if media is None or media.processing_status != ProcessingStatus.ready_for_reading:
        repair_source_for_system_media(
            db=db,
            actor_user_id=owner,
            media_id=media_id,
            request_id=f"oracle-corpus-seed:{work.key}",
            reason="oracle_corpus_seed",
        )
        return Counter(repaired=1)
    index = db.execute(
        text(
            "SELECT status, active_embedding_provider, active_embedding_model"
            " FROM content_index_states WHERE owner_kind = 'media' AND owner_id = :media_id"
        ),
        {"media_id": media_id},
    ).first()
    active = _active_model()
    if index is None or (
        index[0] not in ("pending", "indexing")
        and tuple(index) != ("ready", active["provider"], active["model"])
    ):
        request_media_content_reindex(db, media_id=media_id, reason="oracle_corpus_seed")
        return Counter(reindexed=1)
    return Counter()


def _active_model() -> dict[str, str]:
    return {
        "provider": current_transcript_embedding_provider(),
        "model": current_transcript_embedding_model(),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m nexus.services.oracle.corpus",
        description="Converge the oracle corpus on corpus.json.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("seed").add_argument("--owner-user", type=UUID, required=True)
    args = parser.parse_args(argv)
    counts = seed(get_session_factory(), owner_user_id=args.owner_user)
    print(json.dumps(counts, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
