"""0230 attributes PDF anchors only where the database can prove the binary."""

from __future__ import annotations

from pathlib import Path
from uuid import UUID, uuid4

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

_NEVER_REPUBLISHED = "a" * 64
_REPUBLISHED = "b" * 64
_PRE_STAMPED = "c" * 64
_UNPUBLISHED = "d" * 64
_AUTHORED = "e" * 64


def test_0230_stamps_only_anchors_the_binary_history_establishes(
    empty_migration_database_url: str,
) -> None:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    command.upgrade(config, "0229")
    engine = create_engine(empty_migration_database_url)
    user_id = uuid4()
    never, republished, restamped, unpublished = (uuid4() for _ in range(4))
    anchors: dict[str, UUID] = {
        name: uuid4()
        for name in ("legacy", "before_republication", "after_republication", "authored", "orphan")
    }
    try:
        with engine.begin() as db:
            db.execute(
                text("INSERT INTO users (id,email) VALUES (:id,:email)"),
                {"id": user_id, "email": f"anchor-backfill-{user_id}@example.invalid"},
            )
            for media_id, digest in (
                (never, _NEVER_REPUBLISHED),
                (republished, _REPUBLISHED),
                (restamped, _PRE_STAMPED),
                (unpublished, _UNPUBLISHED),
            ):
                db.execute(
                    text(
                        "INSERT INTO media (id,kind,title,processing_status) "
                        "VALUES (:id,'pdf','Retained anchor','ready_for_reading')"
                    ),
                    {"id": media_id},
                )
                db.execute(
                    text(
                        "INSERT INTO media_file "
                        "(media_id,storage_path,content_type,size_bytes,source_sha256) "
                        "VALUES (:media,:path,'application/pdf',1024,:digest)"
                    ),
                    {"media": media_id, "path": f"sources/{media_id}.pdf", "digest": digest},
                )
            for media_id, generation, changed_at in (
                (never, 1, "2026-01-10T00:00:00+00:00"),
                (republished, 3, "2026-02-01T00:00:00+00:00"),
                (restamped, 2, "2026-03-01T00:00:00+00:00"),
            ):
                db.execute(
                    text(
                        "INSERT INTO reader_publications (id,media_id,generation,changed_at) "
                        "VALUES (:id,:media,:generation,CAST(:changed_at AS timestamptz))"
                    ),
                    {
                        "id": uuid4(),
                        "media": media_id,
                        "generation": generation,
                        "changed_at": changed_at,
                    },
                )
            for name, media_id, created_at, source_sha256 in (
                ("legacy", never, "2026-01-05T00:00:00+00:00", None),
                ("before_republication", republished, "2026-01-20T00:00:00+00:00", None),
                ("after_republication", republished, "2026-02-05T00:00:00+00:00", None),
                ("authored", restamped, "2026-01-01T00:00:00+00:00", _AUTHORED),
                ("orphan", unpublished, "2026-01-01T00:00:00+00:00", None),
            ):
                db.execute(
                    text(
                        "INSERT INTO highlights "
                        "(id,user_id,anchor_kind,anchor_media_id,color,exact,prefix,suffix) "
                        "VALUES (:id,:user,'pdf_page_geometry',:media,'yellow','quote','','')"
                    ),
                    {"id": anchors[name], "user": user_id, "media": media_id},
                )
                db.execute(
                    text(
                        "INSERT INTO highlight_pdf_anchors "
                        "(highlight_id,media_id,page_number,source_sha256,sort_top,sort_left,"
                        "rect_count,created_at) "
                        "VALUES (:id,:media,1,:digest,10,10,1,CAST(:created_at AS timestamptz))"
                    ),
                    {
                        "id": anchors[name],
                        "media": media_id,
                        "digest": source_sha256,
                        "created_at": created_at,
                    },
                )
        command.upgrade(config, "0230")
        with engine.connect() as db:
            stamped = {
                row.highlight_id: row.source_sha256
                for row in db.execute(
                    text("SELECT highlight_id,source_sha256 FROM highlight_pdf_anchors")
                )
            }
    finally:
        engine.dispose()
    assert stamped[anchors["legacy"]] == _NEVER_REPUBLISHED, (
        "an anchor on a never-republished binary keeps painting after the cutover"
    )
    assert stamped[anchors["after_republication"]] == _REPUBLISHED
    assert stamped[anchors["before_republication"]] is None, (
        "geometry older than the last republication must not claim the current binary"
    )
    assert stamped[anchors["authored"]] == _AUTHORED, "an authored digest is never overwritten"
    assert stamped[anchors["orphan"]] is None, (
        "an unpublished media establishes no binary to attribute"
    )
