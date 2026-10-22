"""Preserve personal holdings and fence acquisitions against accepted removals.

revision: 0309; parent: 0308.
data effects: snapshot every viewer's physical non-system all membership before
show folding; append missing default entries using the original all added time.
existing entry identities, dates and positions, removal markers, subscriptions,
source identities and annotations remain unchanged. changed defaults advance.
initialize account removal revisions; preserve historical entry provenance while
setting its unproved undo revision to null. wrap historical successful media inspect
results in the new tagged resource result without changing evidence/content.
missing personal default ownership or
malformed entries/receipts aborts. the zero-uuid system account is not a viewer and
is the sole account permitted to have no default. irreversible: restore backup.
"""

import json
from datetime import datetime
from typing import Annotated, Literal
from collections.abc import Sequence
from uuid import UUID

import sqlalchemy as sa
from alembic import op
from pydantic import BaseModel, ConfigDict, Field, ValidationError

revision: str = "0309"
down_revision: str | Sequence[str] | None = "0308"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# frozen pre-cutover success schema; migrations never import application contracts.
class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _Authorship(_Closed):
    target_kind: Literal[
        "library_entry", "note_block", "highlight", "resource_edge", "queue_item"
    ]
    target_id: UUID
    generation_id: UUID
    generation_seq: Annotated[int, Field(ge=1, le=2147483647)]
    tool_position: Annotated[int, Field(ge=1, le=2147483647)]
    position_path: Annotated[
        str, Field(pattern=r"^generation/[1-9][0-9]*/tool/[1-9][0-9]*$", max_length=37)
    ]
    effect_id: UUID


class _Evidence(_Closed):
    admission_scope: Annotated[str, Field(max_length=128)]
    citation_target: Annotated[str, Field(max_length=128)] | None
    content_sha256: Annotated[str, Field(max_length=64)] | None
    context_ref: Annotated[str, Field(max_length=128)] | None
    excerpt_id: UUID | None
    locator: Annotated[str, Field(max_length=512)] | None
    machine_authorship: _Authorship | None = None
    observed_at: datetime | None
    resource_uri: Annotated[str, Field(max_length=128)]
    snapshot_revision: Annotated[str, Field(max_length=128)] | None


class _Section(_Closed):
    fragment_id: UUID | None
    label: Annotated[str, Field(max_length=310)]
    ordinal: Annotated[int, Field(ge=1, le=1000000)]
    page_end: Annotated[int | None, Field(ge=0, le=1000000)]
    page_start: Annotated[int | None, Field(ge=0, le=1000000)]
    parent_label: Annotated[str, Field(max_length=310)] | None
    preview: Annotated[str, Field(max_length=470)]
    read_uri: Annotated[str, Field(max_length=128)]
    section_kind: Literal["heading", "page_range", "transcript_segment"]
    t_end_ms: Annotated[int | None, Field(ge=0, le=86400000)]
    t_start_ms: Annotated[int | None, Field(ge=0, le=86400000)]


class _Inspect(_Closed):
    evidence: _Evidence
    media_kind: Literal["web_article", "epub", "pdf", "video", "podcast_episode"]
    sections: Annotated[list[_Section], Field(max_length=200)]
    title: Annotated[str, Field(max_length=1000)]
    total_sections: Annotated[int, Field(ge=0, le=1000000)]
    uri: Annotated[str, Field(max_length=128)]


def upgrade() -> None:
    db = op.get_bind()
    invalid = db.execute(
        sa.text("""
        SELECT u.id FROM users u
        LEFT JOIN libraries l ON l.owner_user_id = u.id AND l.is_default
        GROUP BY u.id HAVING
            (u.id <> '00000000-0000-0000-0000-000000000000'::uuid AND count(l.id) <> 1)
            OR count(l.id) > 1
        UNION
        SELECT l.owner_user_id FROM libraries l
        WHERE l.is_default AND (l.system_key IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM memberships membership
            WHERE membership.library_id = l.id AND membership.user_id = l.owner_user_id
              AND membership.role = 'admin'))
    """)
    ).first()
    if invalid is not None:
        raise RuntimeError(
            f"0309 cannot convert account {invalid[0]}: default ownership"
        )
    malformed = db.execute(
        sa.text("""
        SELECT le.id FROM library_entries le JOIN libraries l ON l.id = le.library_id
        WHERE (le.media_id IS NULL) = (le.podcast_id IS NULL)
           OR le.position < 0 OR (l.is_default AND le.podcast_id IS NOT NULL)
           OR (le.media_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM podcast_episodes pe JOIN library_entries show
                 ON show.podcast_id = pe.podcast_id AND show.library_id = le.library_id
               WHERE pe.media_id = le.media_id))
        LIMIT 1
    """)
    ).first()
    if malformed is not None:
        raise RuntimeError(
            f"0309 cannot convert entry {malformed[0]}: target/placement"
        )
    converted = []
    for row in db.execute(
        sa.text("SELECT id, created_refs FROM tool_calls")
    ).mappings():
        refs = row["created_refs"]
        if not isinstance(refs, list):
            raise RuntimeError(f"0309 cannot convert tool receipt {row['id']}: array")
        changed = False
        for ref in refs:
            if not isinstance(ref, dict) or ref.get("kind") not in {
                "entry",
                "note_block",
                "highlight",
                "edge",
                "queue",
            }:
                raise RuntimeError(
                    f"0309 cannot convert tool receipt {row['id']}: kind"
                )
            if ref["kind"] != "entry":
                continue
            if ref.get("target_scheme") not in {"media", "podcast"} or not isinstance(
                ref.get("label"), str
            ):
                raise RuntimeError(
                    f"0309 cannot convert tool receipt {row['id']}: entry shape"
                )
            for key in ("id", "library_id", "target_id"):
                value = ref.get(key)
                if not isinstance(value, str):
                    raise RuntimeError(
                        f"0309 cannot convert tool receipt {row['id']}: {key}"
                    )
                try:
                    UUID(value)
                except ValueError as exc:
                    raise RuntimeError(
                        f"0309 cannot convert tool receipt {row['id']}: {key}"
                    ) from exc
            ref["order_revision"] = None
            changed = True
        if changed:
            converted.append({"id": row["id"], "refs": json.dumps(refs)})
    inspected = []
    for row in db.execute(
        sa.text(
            "SELECT id, result FROM tool_calls "
            "WHERE tool_id = 'nexus.resource.inspect' AND result->>'type' = 'Success'"
        )
    ).mappings():
        result = row["result"]
        value = result.get("value")
        try:
            _Inspect.model_validate_json(json.dumps(value))
        except ValidationError as exc:
            raise RuntimeError(
                f"0309 cannot convert inspect result {row['id']}: shape"
            ) from exc
        inspected.append(
            {
                "id": row["id"],
                "result": json.dumps(
                    {**result, "value": {"resource": {"kind": "Media", **value}}}
                ),
            }
        )
    db.execute(
        sa.text("""
        CREATE TEMP TABLE library_retention_missing ON COMMIT DROP AS
        WITH snapshot AS (
            SELECT DISTINCT ON (viewer.id, le.media_id)
                   viewer.id AS user_id, destination.id AS library_id,
                   le.media_id, le.created_at AS added_at
            FROM users viewer
            JOIN libraries destination ON destination.owner_user_id = viewer.id
              AND destination.is_default AND destination.system_key IS NULL
            JOIN memberships membership ON membership.user_id = viewer.id
            JOIN libraries source ON source.id = membership.library_id
              AND source.system_key IS NULL
            JOIN library_entries le ON le.library_id = source.id AND le.media_id IS NOT NULL
            WHERE NOT EXISTS (SELECT 1 FROM user_media_deletions removed
                              WHERE removed.user_id = viewer.id AND removed.media_id = le.media_id)
              AND NOT EXISTS (SELECT 1 FROM media_teardown_intents teardown
                              WHERE teardown.media_id = le.media_id)
            ORDER BY viewer.id, le.media_id, (le.library_id = destination.id) DESC,
                     le.created_at, le.id
        )
        SELECT snapshot.* FROM snapshot
        WHERE NOT EXISTS (SELECT 1 FROM library_entries held
                          WHERE held.library_id = snapshot.library_id AND held.media_id = snapshot.media_id)
    """)
    )
    overflow = db.execute(
        sa.text("""
        SELECT missing.library_id FROM library_retention_missing missing
        GROUP BY missing.library_id
        HAVING count(*) + (SELECT COALESCE(max(position), -1) FROM library_entries existing
                           WHERE existing.library_id = missing.library_id) > 2147483647
    """)
    ).first()
    if overflow is not None:
        raise RuntimeError(
            f"0309 cannot append default {overflow[0]}: position overflow"
        )
    db.execute(
        sa.text("""
        INSERT INTO library_entries (id, library_id, media_id, created_at, position)
        SELECT gen_random_uuid(), missing.library_id, missing.media_id, missing.added_at,
               (COALESCE((SELECT max(existing.position) FROM library_entries existing
                          WHERE existing.library_id = missing.library_id), -1)
                + row_number() OVER (PARTITION BY missing.library_id
                                     ORDER BY missing.added_at, missing.media_id))::integer
        FROM library_retention_missing missing
        ORDER BY missing.library_id, missing.added_at, missing.media_id
    """)
    )
    db.execute(
        sa.text("""
        UPDATE libraries SET order_revision = nextval('collection_order_revision_seq')
        WHERE id IN (SELECT library_id FROM library_retention_missing)
    """)
    )
    op.add_column(
        "users",
        sa.Column(
            "removal_revision",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("nextval('collection_order_revision_seq')"),
        ),
    )
    for receipt in converted:
        db.execute(
            sa.text(
                "UPDATE tool_calls SET created_refs = CAST(:refs AS jsonb) WHERE id = :id"
            ),
            receipt,
        )
    for inspection in inspected:
        db.execute(
            sa.text(
                "UPDATE tool_calls SET result = CAST(:result AS jsonb) WHERE id = :id"
            ),
            inspection,
        )


def downgrade() -> None:
    raise NotImplementedError("0309 is irreversible; restore the pre-release backup")
