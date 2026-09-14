"""Queue missing immutable publications and verify the release's complete sources.

`census` reports readiness metadata only. `rebuild` durably enqueues missing
publications in bounded pages; it does not wait or declare convergence. After the
existing background worker finishes, `verify` checks every required object and
query projection without producing an offline archive. All old and candidate publication writers must remain stopped by the release
owner through verification and the activation decision.
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import require_reader_publication_limits
from nexus.db.session import get_session_factory
from nexus.schemas.reader_publication import ReaderPublicationPreparationRequest
from nexus.services.reader_publication import (
    ReaderPublicationBusy,
    ensure_reader_publication,
    read_publication_generation,
)
from nexus.services.reader_publication_preparation import enqueue_reader_publication

_ELIGIBLE_KINDS = ("pdf", "epub", "web_article")
# Same finite batch cardinality as existing owned resource projections; not a
# maximum supported library size. Keyset traversal covers the complete corpus.
_PAGE_SIZE = 200
# NULL means the operator's whole quiesced corpus; an array restricts the run to
# exactly those documents, so a scoped caller cannot enqueue foreign work.
_SCOPE_PREDICATE = "(CAST(:scope AS uuid[]) IS NULL OR m.id = ANY(CAST(:scope AS uuid[])))"


@dataclass(frozen=True, slots=True)
class PreflightCensus:
    eligible_ready_media: int
    unpublished_media_count: int
    missing_descriptor_count: int


def read_census(db: Session, *, media_ids: Sequence[UUID] | None = None) -> PreflightCensus:
    """Three scalar counts; object/projection conformance belongs to verify.

    `media_ids` restricts the corpus to exactly those documents. The release
    owner omits it: the operator's scope is the quiesced database itself.
    """
    row = db.execute(
        text(f"""
        SELECT count(*) AS eligible,
               count(*) FILTER (WHERE rp.media_id IS NULL) AS unpublished,
               count(*) FILTER (WHERE rp.media_id IS NOT NULL AND member.path IS NULL) AS unprepared
        FROM media m
        LEFT JOIN reader_publications rp ON rp.media_id = m.id
        LEFT JOIN reader_publication_artifacts member
          ON member.media_id = rp.media_id AND member.generation = rp.generation
         AND member.path = 'descriptor.json' AND member.role = 'descriptor'
        WHERE m.kind = ANY(:kinds) AND m.processing_status = 'ready_for_reading'
          AND {_SCOPE_PREDICATE}
    """),
        {"kinds": list(_ELIGIBLE_KINDS), "scope": None if media_ids is None else list(media_ids)},
    ).one()
    return PreflightCensus(row.eligible, row.unpublished, row.unprepared)


def require_converged(census: PreflightCensus) -> None:
    if census.unpublished_media_count or census.missing_descriptor_count:
        raise RuntimeError(
            "Reader publication preflight did not converge: "
            f"{census.unpublished_media_count} missing generations; "
            f"{census.missing_descriptor_count} missing immutable publications"
        )


def _ready_page(
    db: Session, after: UUID | None, media_ids: Sequence[UUID] | None
) -> list[tuple[UUID, int | None]]:
    rows = db.execute(
        text(f"""
        SELECT m.id, rp.generation
        FROM media m LEFT JOIN reader_publications rp ON rp.media_id = m.id
        WHERE m.kind = ANY(:kinds) AND m.processing_status = 'ready_for_reading'
          AND (CAST(:after AS uuid) IS NULL OR m.id > CAST(:after AS uuid))
          AND {_SCOPE_PREDICATE}
        ORDER BY m.id LIMIT :limit
    """),
        {
            "kinds": list(_ELIGIBLE_KINDS),
            "after": after,
            "limit": _PAGE_SIZE,
            "scope": None if media_ids is None else list(media_ids),
        },
    ).all()
    return [(row.id, row.generation) for row in rows]


def publish_unpublished_media(
    *, session_factory: sessionmaker[Session], media_ids: Sequence[UUID] | None = None
) -> PreflightCensus:
    """Accept missing generation metadata and its exact durable member job together.

    `media_ids` restricts which documents may be fenced and enqueued, so a caller
    that owns only part of the corpus cannot durably enqueue work for the rest.
    """
    after = None
    while True:
        with session_factory() as db:
            page = _ready_page(db, after, media_ids)
        if not page:
            break
        for media_id, selected_generation in page:
            with session_factory() as db:
                if selected_generation is None:
                    ensure_reader_publication(db, media_id=media_id)
                    selected_generation = read_publication_generation(db, media_id=media_id)
                if selected_generation is None:
                    raise ReaderPublicationBusy()
                ready = db.scalar(
                    text("""
                    SELECT 1 FROM reader_publication_artifacts
                    WHERE media_id = :media AND generation = :generation
                      AND path = 'descriptor.json' AND role = 'descriptor'
                """),
                    {"media": media_id, "generation": selected_generation},
                )
                if ready is None:
                    job = enqueue_reader_publication(
                        db,
                        request=ReaderPublicationPreparationRequest(
                            media_id=media_id,
                            expected_generation=selected_generation,
                        ),
                    )
                    print(
                        f"publication media={media_id} generation={selected_generation} job={job.id} status={job.status}"
                    )
                db.commit()
        after = page[-1][0]
    with session_factory() as db:
        return read_census(db, media_ids=media_ids)


def verify_ready_publications(*, session_factory: sessionmaker[Session]) -> PreflightCensus:
    from nexus.services.reader_publication_apparatus import (
        verify_current_reader_publication_apparatus,
    )
    from nexus.services.reader_publication_verification import verify_retained_reader_publication

    limits = require_reader_publication_limits()
    with session_factory() as db:
        require_converged(read_census(db))
    after = None
    while True:
        with session_factory() as db:
            page = _ready_page(db, after, None)
        if not page:
            break
        for media_id, generation in page:
            if generation is None:
                raise ReaderPublicationBusy()
            verify_retained_reader_publication(
                session_factory,
                media_id=media_id,
                generation=generation,
                limits=limits,
            )
            with session_factory() as db:
                verify_current_reader_publication_apparatus(
                    db, media_id=media_id, generation=generation
                )
        after = page[-1][0]
    with session_factory() as db:
        census = read_census(db)
    require_converged(census)
    return census


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m nexus.ops.reader_publication_preflight")
    parser.add_argument("command", choices=("census", "rebuild", "verify"))
    args = parser.parse_args()
    session_factory = get_session_factory()
    if args.command == "rebuild":
        require_reader_publication_limits()
        census = publish_unpublished_media(session_factory=session_factory)
    elif args.command == "verify":
        census = verify_ready_publications(session_factory=session_factory)
    else:
        with session_factory() as db:
            census = read_census(db)
    print(json.dumps(asdict(census), sort_keys=True))


if __name__ == "__main__":
    main()
