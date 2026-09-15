"""Release preflight: publish every already-ready reader document once.

Revision 0219 backfills one generation-`1` publication row per eligible ready
document at the instant the migration runs. A document that becomes ready
afterwards is published by the deployed application artifact. An older artifact
running against the migrated database cannot create that row. Such a document
has no publication generation at all, so both offline routes fail closed forever
and nothing self-heals.

This operator entrypoint closes that window before the first reading-capable APK
is exposed: it publishes the then-current canonical projection of every eligible
`ready_for_reading` document that still has no publication row, at generation
`1`, through the publication owner. It is idempotent — an existing publication
row is never read as stale and never bumped — so it is safe to run before every
release.

    python -m nexus.ops.reader_publication_preflight census
    python -m nexus.ops.reader_publication_preflight rebuild
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.session import get_session_factory
from nexus.services.reader_publication import ensure_reader_publication

_ELIGIBLE_KINDS = ("pdf", "epub", "web_article")
_CONVERGENCE_PASSES = 3


@dataclass(frozen=True, slots=True)
class PreflightCensus:
    """What the preflight sees: ready documents and the ones still unpublished."""

    eligible_ready_media: int
    unpublished_media: tuple[UUID, ...]


def read_census(db: Session) -> PreflightCensus:
    """Read one consistent snapshot of unpublished eligible ready documents."""
    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    db.execute(text("SET TRANSACTION READ ONLY"))
    rows = (
        db.execute(
            text(
                """
                SELECT m.id, rp.media_id IS NULL AS unpublished
                FROM media m
                LEFT JOIN reader_publications rp ON rp.media_id = m.id
                WHERE m.kind = ANY(:kinds)
                  AND m.processing_status = 'ready_for_reading'
                ORDER BY m.id
                """
            ),
            {"kinds": list(_ELIGIBLE_KINDS)},
        )
        .mappings()
        .all()
    )
    return PreflightCensus(
        eligible_ready_media=len(rows),
        unpublished_media=tuple(UUID(str(row["id"])) for row in rows if row["unpublished"]),
    )


def require_converged(census: PreflightCensus) -> None:
    """Fail unless every eligible ready document carries a publication row."""
    if census.unpublished_media:
        raise RuntimeError(
            "Reader publication preflight did not converge: "
            f"{len(census.unpublished_media)} eligible ready document(s) "
            "still have no publication row"
        )


def publish_unpublished_media(*, session_factory: sessionmaker[Session]) -> PreflightCensus:
    """Publish every unpublished eligible ready document and prove convergence.

    A document can become ready while this runs, so the census is re-read and
    re-published within a bounded number of passes before convergence is required.
    """
    published = 0
    census = PreflightCensus(eligible_ready_media=0, unpublished_media=())
    for _pass_index in range(_CONVERGENCE_PASSES):
        with session_factory() as db:
            census = read_census(db)
        if not census.unpublished_media:
            break
        for media_id in census.unpublished_media:
            with session_factory() as db:
                created = ensure_reader_publication(db, media_id=media_id)
                db.commit()
            if created:
                published += 1
                print(f"published media={media_id} generation=1")
    else:
        with session_factory() as db:
            census = read_census(db)
    require_converged(census)
    print(f"published_total={published}")
    return census


def _report(census: PreflightCensus) -> None:
    print(
        json.dumps(
            {
                "eligible_ready_media": census.eligible_ready_media,
                "unpublished_media": [str(media_id) for media_id in census.unpublished_media],
            },
            sort_keys=True,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m nexus.ops.reader_publication_preflight")
    parser.add_argument("command", choices=("census", "rebuild"))
    args = parser.parse_args()
    session_factory = get_session_factory()
    if args.command == "rebuild":
        census = publish_unpublished_media(session_factory=session_factory)
    else:
        with session_factory() as db:
            census = read_census(db)
    _report(census)


if __name__ == "__main__":
    main()
