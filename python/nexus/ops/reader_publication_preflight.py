"""Publish every already-ready reader document once, before a release.

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


@dataclass(frozen=True, slots=True)
class PreflightCensus:
    eligible_ready_media: int
    unpublished_media: tuple[UUID, ...]


def read_census(db: Session) -> PreflightCensus:
    """One consistent snapshot of eligible ready documents and the unpublished subset."""
    db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
    db.execute(text("SET TRANSACTION READ ONLY"))
    rows = db.execute(
        text(
            "SELECT m.id, rp.media_id IS NULL AS unpublished FROM media m"
            " LEFT JOIN reader_publications rp ON rp.media_id = m.id"
            " WHERE m.kind = ANY(:kinds) AND m.processing_status = 'ready_for_reading'"
            " ORDER BY m.id"
        ),
        {"kinds": ["pdf", "epub", "web_article"]},
    ).all()
    return PreflightCensus(
        eligible_ready_media=len(rows),
        unpublished_media=tuple(UUID(str(row[0])) for row in rows if row[1]),
    )


def publish_unpublished_media(*, session_factory: sessionmaker[Session]) -> PreflightCensus:
    """Publish every unpublished eligible ready document, then prove convergence."""
    published = 0
    with session_factory() as db:
        census = read_census(db)
    for media_id in census.unpublished_media:
        with session_factory() as db:
            created = ensure_reader_publication(db, media_id=media_id)
            db.commit()
        if created:
            published += 1
            print(f"published media={media_id} generation=1")
    with session_factory() as db:
        census = read_census(db)
    if census.unpublished_media:
        raise RuntimeError(
            "Reader publication preflight did not converge: "
            f"{len(census.unpublished_media)} eligible ready document(s) "
            "still have no publication row"
        )
    print(f"published_total={published}")
    return census


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m nexus.ops.reader_publication_preflight")
    parser.add_argument("command", choices=("census", "rebuild"))
    command = parser.parse_args().command
    session_factory = get_session_factory()
    if command == "rebuild":
        census = publish_unpublished_media(session_factory=session_factory)
    else:
        with session_factory() as db:
            census = read_census(db)
    print(
        json.dumps(
            {
                "eligible_ready_media": census.eligible_ready_media,
                "unpublished_media": [str(media_id) for media_id in census.unpublished_media],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
