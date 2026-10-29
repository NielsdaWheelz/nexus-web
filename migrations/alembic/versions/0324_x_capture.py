"""Move retained x bodies to immutable captures.

Writers must stop. Existing fragment, highlight and causal identities are retained;
historically unknown body observation times remain null.
unknown source bindings abort rather than inventing a body. The authored feed is
not rewritten. Downgrade requires a matched backup and client restore.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from urllib.parse import parse_qs, parse_qsl, quote, urlencode, urlsplit, urlunsplit
from uuid import NAMESPACE_URL, UUID, uuid5

import sqlalchemy as sa
from lxml import html
from alembic import op

revision = "0324"
down_revision = "0323"
branch_labels = None
depends_on = None


def _id() -> UUID:
    return UUID(
        int=(int(time.time() * 1000) << 80)
        | (7 << 76)
        | (secrets.randbits(12) << 64)
        | (2 << 62)
        | secrets.randbits(62)
    )


def upgrade() -> None:
    db = op.get_bind()
    op.execute(
        "ALTER TABLE authored_heads ADD COLUMN snapshot_floor_seq bigint NOT NULL DEFAULT 0"
    )
    op.execute("UPDATE authored_heads SET snapshot_floor_seq=head_seq")
    op.execute(
        "ALTER TABLE authored_replicas ADD COLUMN format_revision integer NOT NULL DEFAULT 1"
    )
    op.execute(
        "ALTER TABLE authored_replicas ALTER COLUMN format_revision SET DEFAULT 2"
    )
    op.execute("""CREATE TABLE x_post_captures (
        id uuid PRIMARY KEY, post_id uuid NOT NULL REFERENCES x_post_sources(id),
        source_revision_id text NOT NULL, payload jsonb NOT NULL,
        captured_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        asset_job_id uuid REFERENCES background_jobs(id))""")
    op.execute("""CREATE TABLE x_post_capture_contexts (
        id uuid PRIMARY KEY, capture_id uuid NOT NULL REFERENCES x_post_captures(id),
        relation text NOT NULL, ordinal integer NOT NULL, referenced_revision_id text NOT NULL,
        target_capture_id uuid REFERENCES x_post_captures(id), outcome text NOT NULL,
        error_code text, UNIQUE(capture_id,ordinal),
        UNIQUE(capture_id,relation,referenced_revision_id))""")
    op.execute("""CREATE TABLE x_post_media (
        id uuid PRIMARY KEY, media_id uuid NOT NULL UNIQUE REFERENCES media(id),
        post_id uuid NOT NULL UNIQUE REFERENCES x_post_sources(id),
        capture_id uuid NOT NULL REFERENCES x_post_captures(id))""")
    op.execute("""CREATE TABLE x_post_capture_assets (
        id uuid PRIMARY KEY, capture_id uuid NOT NULL REFERENCES x_post_captures(id),
        asset_key text NOT NULL, storage_path text NOT NULL, mime text NOT NULL,
        sha256 text NOT NULL, size_bytes bigint NOT NULL, captured_at timestamptz NOT NULL,
        UNIQUE(capture_id,asset_key))""")
    op.execute("""CREATE TABLE x_post_capture_admissions (
        id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
        capture_id uuid NOT NULL REFERENCES x_post_captures(id), UNIQUE(user_id,capture_id))""")
    op.execute("""CREATE TABLE resource_grant_captures (
        id uuid PRIMARY KEY, grant_id uuid NOT NULL REFERENCES resource_grants(id),
        capture_id uuid NOT NULL REFERENCES x_post_captures(id), UNIQUE(grant_id,capture_id))""")
    op.execute(
        "ALTER TABLE fragments ADD COLUMN x_post_capture_id uuid REFERENCES x_post_captures(id)"
    )
    op.drop_constraint("fragments_media_id_fkey", "fragments", type_="foreignkey")
    op.create_foreign_key(
        "fragments_media_id_fkey", "fragments", "media", ["media_id"], ["id"]
    )
    op.alter_column("fragments", "media_id", nullable=True)
    op.create_unique_constraint(
        "uq_fragments_x_post_capture_id", "fragments", ["x_post_capture_id"]
    )
    op.execute(
        "ALTER TABLE document_embeds ADD COLUMN target_x_post_capture_id uuid REFERENCES x_post_captures(id)"
    )
    op.execute(
        "ALTER TABLE document_embeds ADD COLUMN capture_job_id uuid REFERENCES background_jobs(id)"
    )
    op.execute(
        "ALTER TABLE x_thread_posts ADD COLUMN capture_id uuid REFERENCES x_post_captures(id)"
    )
    op.execute(
        "ALTER TABLE x_thread_sources ADD COLUMN root_capture_id uuid REFERENCES x_post_captures(id)"
    )
    op.execute(
        "ALTER TABLE x_post_aliases ADD COLUMN post_id uuid REFERENCES x_post_sources(id)"
    )
    op.execute("ALTER TABLE x_post_aliases ADD COLUMN availability text")
    op.execute("ALTER TABLE x_post_aliases ADD COLUMN checked_at timestamptz")
    op.execute(
        "CREATE TEMP TABLE x_capture_map(media_id uuid PRIMARY KEY, post_id uuid NOT NULL, capture_id uuid NOT NULL, fragment_id uuid NOT NULL) ON COMMIT DROP"
    )
    # Legacy aliases can name a failed acquisition without any captured body.
    # Make its logical identity without inventing a capture.
    for column in (
        "source_attempt_id",
        "source_revision_id",
        "payload",
        "availability",
    ):
        op.alter_column("x_post_sources", column, nullable=True)
    orphans = list(
        db.scalars(
            sa.text("""SELECT DISTINCT a.post_media_id FROM x_post_aliases a
        LEFT JOIN x_post_sources xp ON xp.media_id=a.post_media_id WHERE xp.id IS NULL""")
        )
    )
    for media_id in orphans:
        db.execute(
            sa.text("INSERT INTO x_post_sources(id,media_id) VALUES (:id,:media)"),
            {"id": _id(), "media": media_id},
        )
    op.execute(
        "CREATE TEMP TABLE x_uncaptured_media(media_id uuid PRIMARY KEY) ON COMMIT DROP"
    )
    op.execute(
        "INSERT INTO x_uncaptured_media SELECT media_id FROM x_post_sources WHERE payload IS NULL"
    )
    rows = db.execute(
        sa.text("""SELECT xp.*, f.id AS fragment_id, f.idx,
        (SELECT count(*) FROM fragments f2 WHERE f2.media_id=xp.media_id) AS fragment_count
        FROM x_post_sources xp LEFT JOIN fragments f ON f.media_id=xp.media_id AND f.idx=0
        ORDER BY xp.id""")
    ).mappings()
    for row in rows:
        if row["payload"] is None:
            if row["fragment_count"] != 0:
                raise RuntimeError(
                    f"0324 x source {row['id']} has a body with no provider evidence"
                )
            continue
        if row["fragment_count"] != 1 or row["fragment_id"] is None:
            raise RuntimeError(
                f"0324 x source {row['id']} lacks one original fragment"
            )
        payload = row["payload"]
        if not isinstance(payload, dict) or not isinstance(
            payload.get("references"), list
        ):
            raise RuntimeError(
                f"0324 x source {row['id']} has invalid provider evidence"
            )
        capture_id = _id()
        fragment_html = db.scalar(
            sa.text("SELECT html_sanitized FROM fragments WHERE id=:id"),
            {"id": row["fragment_id"]},
        )
        document = html.fragment_fromstring(fragment_html, create_parent=True)
        images = {}
        for attachment in payload.get("attachments", []):
            if not isinstance(attachment, dict) or not isinstance(
                attachment.get("media_key"), str
            ):
                raise RuntimeError(
                    f"0324 x source {row['id']} has invalid image evidence"
                )
            source_url = attachment.get("url") or attachment.get("preview_image_url")
            if source_url:
                if (
                    source_url in images
                    and images[source_url] != attachment["media_key"]
                ):
                    raise RuntimeError(
                        f"0324 x source {row['id']} has ambiguous image identity"
                    )
                images[source_url] = attachment["media_key"]
        for image in document.iter("img"):
            src = image.get("src") or ""
            parsed = urlsplit(src)
            if parsed.path == "/api/media/image":
                values = parse_qs(parsed.query).get("url", [])
                src = values[0] if len(values) == 1 else ""
            if src not in images:
                raise RuntimeError(
                    f"0324 x source {row['id']} image lacks exact attachment evidence"
                )
            image.set(
                "src",
                f"/api/x/captures/{capture_id}/assets/{quote(images[src], safe='')}",
            )
        fragment_html = (document.text or "") + "".join(
            html.tostring(child, encoding="unicode") for child in document
        )
        db.execute(
            sa.text("UPDATE fragments SET html_sanitized=:html WHERE id=:id"),
            {"html": fragment_html, "id": row["fragment_id"]},
        )
        db.execute(
            sa.text("""INSERT INTO x_post_captures
            (id,post_id,source_revision_id,payload,captured_at)
            VALUES (:id,:post,:revision,CAST(:payload AS jsonb),:captured)"""),
            {
                "id": capture_id,
                "post": row["id"],
                "revision": row["source_revision_id"],
                "payload": json.dumps(
                    {"kind": "complete_post", "content": payload}, default=str
                ),
                "captured": row["body_captured_at"],
            },
        )
        db.execute(
            sa.text(
                "INSERT INTO x_capture_map VALUES (:media,:post,:capture,:fragment)"
            ),
            {
                "media": row["media_id"],
                "post": row["id"],
                "capture": capture_id,
                "fragment": row["fragment_id"],
            },
        )
    _seed_admissions(db)
    op.drop_constraint(
        "ck_highlights_anchor_fields_paired_null", "highlights", type_="check"
    )
    _convert_authored(db)
    if db.scalar(
        sa.text("""SELECT EXISTS(SELECT 1 FROM highlights h JOIN x_post_sources xp
        ON xp.media_id=h.anchor_media_id UNION ALL SELECT 1 FROM passage_anchors p
        JOIN x_post_sources xp ON p.owner_scheme='media' AND p.owner_id=xp.media_id)""")
    ):
        raise RuntimeError(
            "0324 an authored x anchor lacks its exact retained fragment"
        )
    if db.scalar(
        sa.text("""SELECT EXISTS(SELECT 1 FROM authored_resources r JOIN x_post_sources xp
        ON r.state->>'source_ref'='media:'||xp.media_id::text WHERE r.state->>'kind'='highlight'
        UNION ALL SELECT 1 FROM authored_passages p JOIN x_post_sources xp
        ON p.state->>'source_ref'='media:'||xp.media_id::text)""")
    ):
        raise RuntimeError(
            "0324 an authored x source lacks its exact retained fragment"
        )
    op.execute(
        "CREATE TEMP TABLE x_old_embeds ON COMMIT DROP AS SELECT * FROM document_embeds"
    )
    _convert_cursors(db)
    _convert_publications(db)
    _convert_workspace(db)
    _convert_index(db)
    _convert_evidence(db)
    _convert_schema(db)
    _seed_public_grants(db)
    # Occurrence and source identities changed even when the literal body did not.
    op.execute("""UPDATE reader_publications SET generation=generation+1,changed_at=now()
        WHERE media_id IN (SELECT media_id FROM x_post_media UNION SELECT thread_media_id FROM x_thread_posts
          UNION SELECT media_id FROM document_embeds WHERE target_x_post_capture_id IS NOT NULL)""")
    _convert_search_projection(db)
    _queue_capture_work(db)
    _retire_context_media(db)


def _convert_workspace(db: sa.Connection) -> None:
    mappings = {
        str(r["media_id"]): r
        for r in db.execute(
            sa.text("""SELECT map.*,f.canonical_text,
        f.html_sanitized,c.source_revision_id FROM x_capture_map map JOIN fragments f ON f.id=map.fragment_id
        JOIN x_post_captures c ON c.id=map.capture_id""")
        ).mappings()
    }
    retained = {
        str(value) for value in db.scalars(sa.text("SELECT media_id FROM x_post_media"))
    }
    affected = {
        str(value)
        for value in db.scalars(
            sa.text("""SELECT media_id FROM x_post_media UNION
        SELECT thread_media_id FROM x_thread_posts UNION SELECT media_id FROM document_embeds
        WHERE target_x_post_capture_id IS NOT NULL""")
        )
    }
    retiring_uncaptured = {
        str(value)
        for value in db.scalars(
            sa.text("""SELECT u.media_id FROM x_uncaptured_media u
        WHERE NOT EXISTS (SELECT 1 FROM library_entries WHERE media_id=u.media_id)
          AND NOT EXISTS (SELECT 1 FROM resource_grants WHERE subject_scheme='media' AND subject_id=u.media_id)
          AND NOT EXISTS (SELECT 1 FROM authored_links WHERE state->>'endpoint_a'='media:'||u.media_id::text
            OR state->>'endpoint_b'='media:'||u.media_id::text)
          AND NOT EXISTS (SELECT 1 FROM document_embeds WHERE target_media_id=u.media_id)
          AND NOT EXISTS (SELECT 1 FROM note_blocks n CROSS JOIN LATERAL
            jsonb_array_elements(COALESCE(n.body_pm_json->'content','[]'::jsonb)) item
            WHERE item->>'type'='resource_embed' AND item->'attrs'->>'resource_ref'='media:'||u.media_id::text)""")
        )
    }
    surviving = {str(value) for value in db.scalars(sa.text("SELECT id FROM media"))}
    surviving -= (mappings.keys() - retained) | retiring_uncaptured

    def old_occurrence(
        reading: object,
        post: object,
        parent: str = "",
        relation: str = "primary",
        slot: str = "",
    ) -> str:
        return str(
            uuid5(NAMESPACE_URL, f"nexus:x:{reading}:{parent}:{post}:{relation}:{slot}")
        )

    def map_unit(
        reading: str, unit: object, source_only: bool, identity: str
    ) -> tuple[str, str, str]:
        if not isinstance(unit, str):
            raise RuntimeError(f"0324 workspace {identity} has invalid reader unit")
        candidates = []
        own = mappings.get(reading)
        if own is not None and unit == old_occurrence(reading, reading):
            candidates.append(
                (
                    str(own["capture_id"]) if source_only else reading,
                    own["canonical_text"],
                    own["html_sanitized"],
                )
            )
        members = list(
            db.execute(
                sa.text("""SELECT id,post_media_id,capture_id FROM x_thread_posts
            WHERE thread_media_id=CAST(:reading AS uuid)"""),
                {"reading": reading},
            ).mappings()
        )
        for member in members:
            parent = mappings.get(str(member["post_media_id"]))
            if parent is None:
                continue
            old_parent = old_occurrence(reading, member["post_media_id"])
            if unit == old_parent:
                candidates.append(
                    (
                        str(member["id"]),
                        parent["canonical_text"],
                        parent["html_sanitized"],
                    )
                )
        primaries = [(str(r["post_media_id"]), str(r["id"])) for r in members]
        if own is not None:
            primaries.append(
                (reading, str(own["capture_id"]) if source_only else reading)
            )
        for parent_media, new_parent in primaries:
            parent = mappings.get(parent_media)
            if parent is None:
                continue
            old_parent = old_occurrence(reading, parent_media)
            contexts = db.execute(
                sa.text("""SELECT e.target_media_id,e.provider_target_ref,x.payload FROM x_old_embeds e
                JOIN x_post_sources x ON x.media_id=e.media_id WHERE e.media_id=CAST(:media AS uuid)
                  AND e.provider='x' AND e.embed_kind='post' AND e.resolution_status='resolved'
                  AND e.canonical_end_offset IS NOT NULL AND e.target_media_id IS NOT NULL"""),
                {"media": parent_media},
            ).mappings()
            for context in contexts:
                target = mappings.get(str(context["target_media_id"]))
                if (
                    target is None
                    or context["provider_target_ref"] != target["source_revision_id"]
                ):
                    continue
                for reference in context["payload"]["references"]:
                    relation = reference["kind"]
                    if reference["target_revision_id"] == target[
                        "source_revision_id"
                    ] and unit == old_occurrence(
                        reading, context["target_media_id"], old_parent, relation
                    ):
                        new_unit = old_occurrence(
                            parent["capture_id"],
                            target["capture_id"],
                            new_parent,
                            relation,
                        )
                        candidates.append(
                            (
                                new_unit,
                                target["canonical_text"],
                                target["html_sanitized"],
                            )
                        )
        embeds = db.execute(
            sa.text("""SELECT * FROM x_old_embeds WHERE media_id=CAST(:reading AS uuid)
            AND provider='x' AND embed_kind='post' AND resolution_status='resolved'
            AND canonical_end_offset IS NOT NULL AND target_media_id IS NOT NULL"""),
            {"reading": reading},
        ).mappings()
        for embed in embeds:
            target = mappings.get(str(embed["target_media_id"]))
            if (
                target is not None
                and embed["provider_target_ref"] == target["source_revision_id"]
                and unit
                == old_occurrence(
                    reading,
                    embed["target_media_id"],
                    str(embed["fragment_id"]),
                    "embedded",
                    embed["occurrence_key"],
                )
            ):
                candidates.append(
                    (
                        str(embed["id"]),
                        target["canonical_text"],
                        target["html_sanitized"],
                    )
                )
        for fragment in db.execute(
            sa.text("""SELECT id,canonical_text,html_sanitized FROM fragments
            WHERE media_id=CAST(:reading AS uuid) AND id::text=:unit"""),
            {"reading": reading, "unit": unit},
        ).mappings():
            candidates.append(
                (
                    str(fragment["id"]),
                    fragment["canonical_text"],
                    fragment["html_sanitized"],
                )
            )
        if len(candidates) != 1:
            raise RuntimeError(
                f"0324 workspace {identity} has an ambiguous reader unit"
            )
        return candidates[0]

    def new_identity(
        reading: str, account: object, source_only: bool, generation: int
    ) -> str:
        source = mappings.get(reading)
        if source_only:
            assert source is not None
            primary = [(str(source["capture_id"]), source["capture_id"])]
        else:
            primary = [
                (str(r.id), r.capture_id)
                for r in db.execute(
                    sa.text("""SELECT id,capture_id
                FROM x_thread_posts WHERE thread_media_id=CAST(:id AS uuid) ORDER BY ordinal"""),
                    {"id": reading},
                )
            ]
            if not primary:
                binding = db.scalar(
                    sa.text(
                        "SELECT capture_id FROM x_post_media WHERE media_id=CAST(:id AS uuid)"
                    ),
                    {"id": reading},
                )
                if binding is not None:
                    primary = [(reading, binding)]
            if not primary:
                primary = [
                    (str(r.id), r.target_x_post_capture_id)
                    for r in db.execute(
                        sa.text("""SELECT e.id,e.target_x_post_capture_id
                    FROM document_embeds e JOIN fragments f ON f.id=e.fragment_id
                    WHERE e.media_id=CAST(:id AS uuid) AND e.provider='x' AND e.embed_kind='post'
                      AND e.target_x_post_capture_id IS NOT NULL AND e.canonical_end_offset IS NOT NULL
                    ORDER BY f.idx,e.canonical_end_offset,e.document_order_key"""),
                        {"id": reading},
                    )
                ]
        revisions = set(
            db.scalars(
                sa.text(
                    "SELECT source_revision_id FROM x_post_captures WHERE id=ANY(:ids)"
                ),
                {"ids": [capture for _, capture in primary]},
            )
        )
        is_native = (
            source_only
            or source is not None
            or bool(
                db.scalar(
                    sa.text(
                        "SELECT EXISTS(SELECT 1 FROM x_thread_sources WHERE media_id=CAST(:id AS uuid))"
                    ),
                    {"id": reading},
                )
            )
        )
        units = []
        for unit_id, capture_id in primary:
            units.append(f"{unit_id}:{capture_id}")
            contexts = db.execute(
                sa.text("""SELECT c.relation,c.referenced_revision_id,c.target_capture_id
                FROM x_post_capture_contexts c JOIN x_post_capture_admissions a
                  ON a.capture_id=c.target_capture_id AND a.user_id=:account
                WHERE c.capture_id=:capture AND c.target_capture_id IS NOT NULL ORDER BY c.ordinal"""),
                {"account": account, "capture": capture_id},
            ).mappings()
            for context in contexts:
                if (
                    is_native
                    and not source_only
                    and context["relation"] == "replied_to"
                    and context["referenced_revision_id"] in revisions
                ):
                    continue
                child_id = old_occurrence(
                    capture_id,
                    context["target_capture_id"],
                    unit_id,
                    context["relation"],
                )
                units.append(f"{child_id}:{context['target_capture_id']}")
        digest = hashlib.sha256("\n".join(units).encode()).hexdigest()[:24]
        return (
            f"capture:{source['capture_id']}:{digest}"
            if source_only
            else f"g{generation + 1}:x{digest}"
            if units
            else f"g{generation + 1}"
        )

    rows = list(
        db.execute(
            sa.text("SELECT id,user_id,state FROM workspace_sessions ORDER BY id")
        ).mappings()
    )
    for row in rows:
        state = row["state"]
        panes = state.get("panes") if isinstance(state, dict) else None
        if not isinstance(panes, list):
            raise RuntimeError(f"0324 workspace {row['id']} has malformed panes")
        changed = False
        for pane in panes:
            if not isinstance(pane, dict) or not isinstance(pane.get("history"), dict):
                raise RuntimeError(f"0324 workspace {row['id']} has malformed history")
            visits = [
                pane.get("current_visit"),
                *pane["history"].get("back", []),
                *pane["history"].get("forward", []),
            ]
            for visit in visits:
                if not isinstance(visit, dict) or not isinstance(
                    visit.get("href"), str
                ):
                    raise RuntimeError(
                        f"0324 workspace {row['id']} has malformed visit"
                    )
                url = urlsplit(visit["href"])
                pieces = url.path.split("/")
                if len(pieces) != 3 or pieces[1] != "media":
                    continue
                media = pieces[2]
                mapping = mappings.get(media)
                retired = mapping is not None and media not in retained
                if media in retiring_uncaptured:
                    raise RuntimeError(
                        f"0324 workspace {row['id']} names an uncaptured retiring source"
                    )
                if not retired and media not in affected:
                    continue
                query = parse_qsl(url.query, keep_blank_values=True)
                if len(query) == 1 and query[0][0] == "source_attempt_id":
                    try:
                        attempt_id = UUID(query[0][1])
                    except ValueError as exc:
                        raise RuntimeError(
                            f"0324 workspace {row['id']} has invalid source handoff"
                        ) from exc
                    destination = db.scalar(
                        sa.text("""SELECT COALESCE(
                        (SELECT media_id FROM media_source_supersessions WHERE source_attempt_id=:id),
                        (SELECT media_id FROM media_source_attempts WHERE id=:id))::text"""),
                        {"id": attempt_id},
                    )
                    if (
                        str(attempt_id) != query[0][1]
                        or url.fragment
                        or media not in surviving
                        or destination not in surviving
                    ):
                        raise RuntimeError(
                            f"0324 workspace {row['id']} has unproved source handoff"
                        )
                    # Acceptance resolves its own destination; preserve the receipt
                    # and href exactly, without inventing a reader position.
                    continue
                if any(key != "loc" for key, _ in query) or len(query) > 1:
                    raise RuntimeError(
                        f"0324 workspace {row['id']} has unknown reader query"
                    )
                if query:
                    try:
                        destination = json.loads(query[0][1])
                    except (ValueError, TypeError) as exc:
                        raise RuntimeError(
                            f"0324 workspace {row['id']} has invalid reader destination"
                        ) from exc
                    generation = db.scalar(
                        sa.text(
                            "SELECT generation FROM reader_publications WHERE media_id=CAST(:id AS uuid)"
                        ),
                        {"id": media},
                    )
                    if (
                        generation is None
                        or not isinstance(destination, dict)
                        or set(destination) != {"source_identity", "target"}
                        or destination["source_identity"] != f"g{generation}"
                        or not isinstance(destination["target"], dict)
                    ):
                        raise RuntimeError(
                            f"0324 workspace {row['id']} has stale reader evidence"
                        )
                    target = destination["target"]
                    kind = target.get("kind")
                    if kind in {"point", "range", "anchor"}:
                        point = target.get("point") if kind == "point" else target
                        expected = (
                            {"kind", "unit", "offset"}
                            if kind == "point"
                            else {"kind", "unit", "start", "end"}
                            if kind == "range"
                            else {"kind", "unit", "id"}
                        )
                        if (
                            not isinstance(point, dict)
                            or set(point) != expected
                            or (
                                kind == "point"
                                and (
                                    set(target) != {"kind", "point"}
                                    or point.get("kind") != "text"
                                )
                            )
                        ):
                            raise RuntimeError(
                                f"0324 workspace {row['id']} has invalid reader target"
                            )
                        new_unit, text, rendered = map_unit(
                            media, point.get("unit"), retired, str(row["id"])
                        )
                        for key in (
                            ("offset",)
                            if kind == "point"
                            else ("start", "end")
                            if kind == "range"
                            else ()
                        ):
                            if type(point.get(key)) is not int or not 0 <= point[
                                key
                            ] <= len(text):
                                raise RuntimeError(
                                    f"0324 workspace {row['id']} has invalid reader offset"
                                )
                        if kind == "range" and point["start"] >= point["end"]:
                            raise RuntimeError(
                                f"0324 workspace {row['id']} has empty reader range"
                            )
                        if kind == "anchor":
                            anchor = point.get("id")
                            document = html.fragment_fromstring(
                                rendered, create_parent=True
                            )
                            if not isinstance(anchor, str) or not document.xpath(
                                ".//*[@id=$value]", value=anchor
                            ):
                                raise RuntimeError(
                                    f"0324 workspace {row['id']} has unproved reader anchor"
                                )
                        point["unit"] = new_unit
                    elif kind == "edge":
                        if set(target) != {"kind", "edge"} or target.get(
                            "edge"
                        ) not in {"start", "end"}:
                            raise RuntimeError(
                                f"0324 workspace {row['id']} has invalid reader edge"
                            )
                    elif kind == "evidence_item" and not retired:
                        item_id = target.get("item_id")
                        if (
                            set(target) != {"kind", "item_id"}
                            or not isinstance(item_id, str)
                            or not item_id.startswith("reader_apparatus_item:")
                            or not db.scalar(
                                sa.text("""SELECT EXISTS(SELECT 1 FROM reader_apparatus_items
                            WHERE id::text=:item AND media_id=CAST(:media AS uuid))"""),
                                {
                                    "item": item_id.removeprefix(
                                        "reader_apparatus_item:"
                                    ),
                                    "media": media,
                                },
                            )
                        ):
                            raise RuntimeError(
                                f"0324 workspace {row['id']} has unproved evidence item"
                            )
                    else:
                        raise RuntimeError(
                            f"0324 workspace {row['id']} has unsupported reader destination"
                        )
                    destination["source_identity"] = new_identity(
                        media, row["user_id"], retired, generation
                    )
                    query = [
                        (
                            "loc",
                            json.dumps(
                                destination, separators=(",", ":"), ensure_ascii=False
                            ),
                        )
                    ]
                if retired:
                    fragment = url.fragment
                    if fragment:
                        kind, separator, value = fragment.partition("-")
                        if not separator or kind not in {
                            "highlight",
                            "fragment",
                            "passage",
                        }:
                            raise RuntimeError(
                                f"0324 workspace {row['id']} has unsupported source hash"
                            )
                        if kind == "fragment":
                            valid = value == str(mapping["fragment_id"])
                        elif kind == "highlight":
                            valid = bool(
                                db.scalar(
                                    sa.text(
                                        "SELECT EXISTS(SELECT 1 FROM highlight_fragment_anchors WHERE highlight_id::text=:value AND fragment_id=:fragment)"
                                    ),
                                    {
                                        "value": value,
                                        "fragment": mapping["fragment_id"],
                                    },
                                )
                            )
                        else:
                            valid = bool(
                                db.scalar(
                                    sa.text(
                                        "SELECT EXISTS(SELECT 1 FROM passage_anchors WHERE id::text=:value AND owner_scheme='fragment' AND owner_id=:fragment)"
                                    ),
                                    {
                                        "value": value,
                                        "fragment": mapping["fragment_id"],
                                    },
                                )
                            )
                        if not valid:
                            raise RuntimeError(
                                f"0324 workspace {row['id']} has unproved source hash"
                            )
                    url = url._replace(path=f"/x/captures/{mapping['capture_id']}")
                visit["href"] = urlunsplit(
                    ("", "", url.path, urlencode(query), url.fragment)
                )
                changed = True
        if changed:
            db.execute(
                sa.text(
                    "UPDATE workspace_sessions SET state=CAST(:state AS jsonb) WHERE id=:id"
                ),
                {"state": json.dumps(state), "id": row["id"]},
            )


def _seed_public_grants(db: sa.Connection) -> None:
    roots = db.execute(
        sa.text("""WITH roots AS (
        SELECT g.id AS grant_id,g.created_by_user_id AS creator,m.capture_id
          FROM resource_grants g JOIN x_post_media m ON g.subject_scheme='media' AND g.subject_id=m.media_id
          WHERE g.grantee_user_id IS NULL
        UNION SELECT g.id,g.created_by_user_id,t.capture_id FROM resource_grants g JOIN x_thread_posts t
          ON g.subject_scheme='media' AND g.subject_id=t.thread_media_id WHERE g.grantee_user_id IS NULL
        UNION SELECT g.id,g.created_by_user_id,e.target_x_post_capture_id FROM resource_grants g JOIN document_embeds e
          ON g.subject_scheme='media' AND g.subject_id=e.media_id WHERE g.grantee_user_id IS NULL
            AND e.provider='x' AND e.embed_kind='post' AND e.canonical_end_offset IS NOT NULL
            AND e.target_x_post_capture_id IS NOT NULL
        UNION SELECT g.id,g.created_by_user_id,m.capture_id FROM resource_grants g
          JOIN highlights h ON g.subject_scheme='highlight' AND g.subject_id=h.id AND h.authored_visible
          JOIN x_post_media m ON m.media_id=h.anchor_media_id WHERE g.grantee_user_id IS NULL
        UNION SELECT g.id,g.created_by_user_id,t.capture_id FROM resource_grants g
          JOIN highlights h ON g.subject_scheme='highlight' AND g.subject_id=h.id AND h.authored_visible
          JOIN x_thread_posts t ON t.thread_media_id=h.anchor_media_id WHERE g.grantee_user_id IS NULL
        UNION SELECT g.id,g.created_by_user_id,e.target_x_post_capture_id FROM resource_grants g
          JOIN highlights h ON g.subject_scheme='highlight' AND g.subject_id=h.id AND h.authored_visible
          JOIN document_embeds e ON e.media_id=h.anchor_media_id
          WHERE g.grantee_user_id IS NULL AND e.provider='x' AND e.embed_kind='post'
            AND e.canonical_end_offset IS NOT NULL AND e.target_x_post_capture_id IS NOT NULL
        UNION SELECT g.id,g.created_by_user_id,f.x_post_capture_id FROM resource_grants g
          JOIN highlights h ON g.subject_scheme='highlight' AND g.subject_id=h.id AND h.authored_visible
          JOIN highlight_fragment_anchors a ON a.highlight_id=h.id
          JOIN fragments f ON f.id=a.fragment_id AND f.x_post_capture_id IS NOT NULL
          WHERE g.grantee_user_id IS NULL),
        authorized AS (SELECT roots.* FROM roots JOIN x_post_capture_admissions a
          ON a.user_id=roots.creator AND a.capture_id=roots.capture_id)
        SELECT grant_id,capture_id FROM authorized
        UNION SELECT authorized.grant_id,c.target_capture_id FROM authorized
          JOIN x_post_capture_contexts c ON c.capture_id=authorized.capture_id AND c.target_capture_id IS NOT NULL
          JOIN x_post_capture_admissions a ON a.user_id=authorized.creator AND a.capture_id=c.target_capture_id""")
    ).tuples()
    for grant_id, capture_id in roots:
        db.execute(
            sa.text("""INSERT INTO resource_grant_captures(id,grant_id,capture_id)
            VALUES (:id,:grant,:capture) ON CONFLICT(grant_id,capture_id) DO NOTHING"""),
            {"id": _id(), "grant": grant_id, "capture": capture_id},
        )


def _retire_context_media(db: sa.Connection) -> None:
    retired = list(
        db.execute(
            sa.text("""SELECT map.* FROM x_capture_map map
        LEFT JOIN x_post_media binding ON binding.media_id=map.media_id
        WHERE binding.id IS NULL ORDER BY map.media_id""")
        ).mappings()
    )
    uncaptured = db.execute(
        sa.text("""SELECT u.media_id, NULL::uuid AS fragment_id, NULL::uuid AS capture_id
        FROM x_uncaptured_media u WHERE NOT EXISTS (SELECT 1 FROM library_entries le WHERE le.media_id=u.media_id)
          AND NOT EXISTS (SELECT 1 FROM resource_grants g WHERE g.subject_scheme='media' AND g.subject_id=u.media_id)
          AND NOT EXISTS (SELECT 1 FROM authored_links l WHERE l.state->>'endpoint_a'='media:'||u.media_id::text
            OR l.state->>'endpoint_b'='media:'||u.media_id::text)
          AND NOT EXISTS (SELECT 1 FROM note_blocks n CROSS JOIN LATERAL
            jsonb_array_elements(COALESCE(n.body_pm_json->'content','[]'::jsonb)) item
            WHERE item->>'type'='resource_embed' AND item->'attrs'->>'resource_ref'='media:'||u.media_id::text)
          AND NOT EXISTS (SELECT 1 FROM document_embeds e WHERE e.target_media_id=u.media_id)""")
    ).mappings()
    retired.extend(uncaptured)
    for row in retired:
        media_id, fragment_id, capture_id = (
            row["media_id"],
            row["fragment_id"],
            row["capture_id"],
        )
        params = {
            "media": media_id,
            "fragment": fragment_id,
            "capture": str(capture_id),
        }
        if capture_id is None and db.scalar(
            sa.text("""SELECT EXISTS(
            SELECT 1 FROM resource_view_states WHERE (surface_scheme='media' AND surface_id=:media)
              OR (target_scheme='media' AND target_id=:media)
            UNION ALL SELECT 1 FROM resource_versions WHERE resource_scheme='media' AND resource_id=:media
            UNION ALL SELECT 1 FROM resource_edges WHERE (source_scheme='media' AND source_id=:media)
              OR (target_scheme='media' AND target_id=:media))"""),
            params,
        ):
            raise RuntimeError(
                f"0324 uncaptured media {media_id} has a retained destination requiring repair"
            )
        # Frozen attribution is not a destination when a target owner exists.
        # Without one, the evidence reader falls back to source.ref.
        if db.scalar(
            sa.text("""SELECT EXISTS(
            SELECT 1 FROM messages m WHERE m.reader_selection_snapshot #>> '{evidence,target,owner_ref}'='media:'||CAST(:media AS text)
              OR (NULLIF(m.reader_selection_snapshot #>> '{evidence,target,owner_ref}', '') IS NULL
                AND m.reader_selection_snapshot #>> '{evidence,source,ref}'='media:'||CAST(:media AS text))
            UNION ALL SELECT 1 FROM resource_edges e WHERE e.origin='citation' AND
              (e.snapshot #>> '{evidence,target,owner_ref}'='media:'||CAST(:media AS text)
               OR (NULLIF(e.snapshot #>> '{evidence,target,owner_ref}', '') IS NULL
                 AND e.snapshot #>> '{evidence,source,ref}'='media:'||CAST(:media AS text)))
            UNION ALL SELECT 1 FROM message_retrievals r WHERE
              r.captured_evidence #>> '{target,owner_ref}'='media:'||CAST(:media AS text)
              OR (NULLIF(r.captured_evidence #>> '{target,owner_ref}', '') IS NULL
                AND r.captured_evidence #>> '{source,ref}'='media:'||CAST(:media AS text))
              OR r.locator->>'media_id'=CAST(:media AS text)
              OR r.context_ref #>> '{passage_target,owner_ref}'='media:'||CAST(:media AS text)
              OR r.result_ref->>'deep_link'='/media/'||CAST(:media AS text))"""),
            params,
        ):
            raise RuntimeError(
                f"0324 source-only media {media_id} has unconverted chat evidence"
            )
        # A standalone cursor is user state, not disposable extraction metadata.
        if db.scalar(
            sa.text(
                "SELECT EXISTS(SELECT 1 FROM reader_media_state WHERE media_id=:media AND cursor IS NOT NULL)"
            ),
            params,
        ):
            raise RuntimeError(
                f"0324 source-only media {media_id} has a standalone reader cursor requiring repair"
            )
        if db.scalar(
            sa.text("""SELECT EXISTS(SELECT 1 FROM resource_edges e WHERE e.origin='citation'
            AND ((e.source_scheme='media' AND e.source_id=:media) OR (e.target_scheme='media' AND e.target_id=:media))
            AND e.snapshot #>> '{evidence,target,locator,capture_id}' IS DISTINCT FROM :capture)"""),
            params,
        ):
            raise RuntimeError(
                f"0324 source-only media {media_id} has an unconverted citation"
            )
        db.execute(
            sa.text("""UPDATE resource_edges e SET target_scheme='fragment',target_id=:fragment
            WHERE e.origin='citation' AND e.target_scheme='media' AND e.target_id=:media
              AND e.snapshot #>> '{evidence,target,locator,capture_id}'=:capture"""),
            params,
        )
        db.execute(
            sa.text("""UPDATE resource_edges e SET source_scheme='fragment',source_id=:fragment
            WHERE e.origin='citation' AND e.source_scheme='media' AND e.source_id=:media
              AND e.snapshot #>> '{evidence,target,locator,capture_id}'=:capture"""),
            params,
        )
        for column in ("surface", "target"):
            db.execute(
                sa.text(f"""UPDATE resource_view_states SET {column}_scheme='fragment',{column}_id=:fragment
                WHERE {column}_scheme='media' AND {column}_id=:media"""),
                params,
            )
        db.execute(
            sa.text("""UPDATE resource_versions SET resource_scheme='fragment',resource_id=:fragment
            WHERE resource_scheme='media' AND resource_id=:media"""),
            params,
        )
        db.execute(
            sa.text(
                """DELETE FROM keyword_occurrences WHERE ref='media:'||CAST(:media AS text)"""
            ),
            params,
        )
        # Context-only publication artifacts are withdrawn; capture-owned fragments,
        # indexes, highlights and typed evidence have already been moved.
        if db.scalar(
            sa.text(
                "SELECT EXISTS(SELECT 1 FROM reader_apparatus_items WHERE media_id=:media)"
            ),
            params,
        ):
            raise RuntimeError(
                f"0324 source-only media {media_id} has apparatus requiring repair"
            )
        if db.scalar(
            sa.text(
                "SELECT EXISTS(SELECT 1 FROM media_parts WHERE media_id=:media OR source_media_id=:media)"
            ),
            params,
        ):
            raise RuntimeError(
                f"0324 source-only media {media_id} has a retained media part"
            )
        if db.scalar(
            sa.text("SELECT EXISTS(SELECT 1 FROM media_file WHERE media_id=:media)"),
            params,
        ):
            raise RuntimeError(
                f"0324 source-only media {media_id} has a stored file requiring repair"
            )
        db.execute(
            sa.text("""DELETE FROM resource_edges WHERE origin='document_embed'
            AND ((source_scheme='media' AND source_id=:media) OR (target_scheme='media' AND target_id=:media))"""),
            params,
        )
        legacy_job_ids = list(
            db.scalars(
                sa.text("""SELECT id FROM background_jobs WHERE kind IN
            ('ingest_media_source','media_content_reindex_job','enrich_metadata','media_unit_build',
             'discover_document_parts','media_teardown') AND payload->>'media_id'=CAST(:media AS text)"""),
                params,
            )
        )
        if legacy_job_ids:
            db.execute(
                sa.text("DELETE FROM metadata_result_reviews WHERE job_id=ANY(:ids)"),
                {"ids": legacy_job_ids},
            )
            db.execute(
                sa.text(
                    "DELETE FROM background_job_capacity_leases WHERE job_id=ANY(:ids)"
                ),
                {"ids": legacy_job_ids},
            )
            db.execute(
                sa.text("DELETE FROM background_jobs WHERE id=ANY(:ids)"),
                {"ids": legacy_job_ids},
            )
        for table in (
            "media_claims",
            "media_summaries",
            "contributor_credits",
            "media_processing_events",
            "reader_apparatus_edges",
            "reader_apparatus_states",
            "reader_publications",
            "user_media_deletions",
            "reader_media_state",
            "reader_engagement_states",
            "consumption_overrides",
            "consumption_activity_exclusions",
            "consumption_activity_spans",
            "consumption_completion_facts",
            "media_source_supersessions",
            "media_teardown_intents",
        ):
            db.execute(sa.text(f"DELETE FROM {table} WHERE media_id=:media"), params)
        db.execute(
            sa.text("DELETE FROM media_source_attempts WHERE media_id=:media"), params
        )
        try:
            db.execute(sa.text("DELETE FROM media WHERE id=:media"), params)
        except sa.exc.IntegrityError as exc:
            raise RuntimeError(
                f"0324 source-only media {media_id} has an unknown retained reference"
            ) from exc


def _convert_search_projection(db: sa.Connection) -> None:
    op.execute("""UPDATE keyword_occurrences k SET owner_ref='fragment:'||c.owner_id::text,
        admission_key='content_chunk:'||c.owner_id::text||':'||s.lexical_revision::text,
        source_revision=s.lexical_revision FROM content_chunks c JOIN content_index_states s
        ON s.owner_kind=c.owner_kind AND s.owner_id=c.owner_id
        WHERE c.owner_kind='fragment' AND k.doc_key='content_chunk:'||c.id::text
          AND s.lexical_revision IS NOT NULL""")
    op.execute("""UPDATE keyword_occurrences k SET owner_ref='fragment:'||map.fragment_id::text,
        admission_key='fragment:'||map.fragment_id::text FROM x_capture_map map
        WHERE k.doc_key='fragment:'||map.fragment_id::text""")
    op.execute("""DELETE FROM keyword_occurrences k WHERE k.family='highlight' AND EXISTS (
        SELECT 1 FROM highlight_fragment_anchors a JOIN x_capture_map map ON map.fragment_id=a.fragment_id
        WHERE k.ref='highlight:'||a.highlight_id::text)""")
    op.execute("""WITH roots AS (
        SELECT media_id,capture_id FROM x_post_media
        UNION SELECT thread_media_id,capture_id FROM x_thread_posts
        UNION SELECT media_id,target_x_post_capture_id FROM document_embeds
          WHERE target_x_post_capture_id IS NOT NULL),
        occurrences AS (SELECT media_id,capture_id FROM roots UNION
          SELECT roots.media_id,c.target_capture_id FROM roots JOIN x_post_capture_contexts c
            ON c.capture_id=roots.capture_id WHERE c.target_capture_id IS NOT NULL)
        INSERT INTO keyword_occurrences(doc_key,ref,owner_ref,family,admission_key,body,prefix,suffix)
        SELECT DISTINCT 'highlight:'||o.media_id::text||':'||h.id::text,
          'highlight:'||h.id::text,'highlight:'||h.id::text,'highlight',
          'highlight:'||o.media_id::text||':'||h.id::text,h.exact,COALESCE(h.prefix,''),COALESCE(h.suffix,'')
        FROM occurrences o JOIN fragments f ON f.x_post_capture_id=o.capture_id
        JOIN highlight_fragment_anchors a ON a.fragment_id=f.id
        JOIN highlights h ON h.id=a.highlight_id AND h.authored_visible
        ON CONFLICT(doc_key) DO NOTHING""")
    op.execute("""INSERT INTO keyword_occurrences(doc_key,ref,owner_ref,family,admission_key,body,prefix,suffix)
        SELECT 'highlight:source:'||h.id::text,'highlight:'||h.id::text,'highlight:'||h.id::text,
          'highlight','highlight:source:'||h.id::text,h.exact,COALESCE(h.prefix,''),COALESCE(h.suffix,'')
        FROM highlights h JOIN highlight_fragment_anchors a ON a.highlight_id=h.id
        JOIN fragments f ON f.id=a.fragment_id AND f.x_post_capture_id IS NOT NULL
        WHERE h.authored_visible ON CONFLICT(doc_key) DO NOTHING""")


def _convert_cursors(db: sa.Connection) -> None:
    maps = {
        str(row["media_id"]): row
        for row in db.execute(
            sa.text("""SELECT map.*,c.source_revision_id,f.canonical_text
        FROM x_capture_map map JOIN x_post_captures c ON c.id=map.capture_id
        JOIN fragments f ON f.id=map.fragment_id""")
        ).mappings()
    }

    def occurrence(
        reading: object,
        post: object,
        parent: str = "",
        relation: str = "primary",
        slot: str = "",
    ) -> str:
        return str(
            uuid5(NAMESPACE_URL, f"nexus:x:{reading}:{parent}:{post}:{relation}:{slot}")
        )

    rows = list(
        db.execute(
            sa.text(
                "SELECT user_id,media_id,cursor FROM reader_media_state WHERE cursor IS NOT NULL"
            )
        ).mappings()
    )
    for row in rows:
        cursor = row["cursor"]
        if not isinstance(cursor, dict):
            raise RuntimeError(f"0324 reader cursor {row['media_id']} is malformed")
        tag = cursor.get("tag")
        locator = (
            cursor.get("locator")
            if tag == "Positioned"
            else cursor.get("previous_locator")
            if tag == "Unresolved"
            else None
        )
        if not isinstance(locator, dict) or locator.get("kind") != "x":
            continue
        mapping = maps.get(locator.get("post_media_id"))
        if (
            mapping is None
            or locator.get("source_revision_id") != mapping["source_revision_id"]
        ):
            raise RuntimeError(
                f"0324 reader cursor {row['media_id']} lacks its original x capture"
            )
        locations = locator.get("locations")
        if not isinstance(locations, dict):
            raise RuntimeError(
                f"0324 reader cursor {row['media_id']} has invalid locations"
            )
        offset = locations.get("text_offset")
        if offset is not None and (
            type(offset) is not int or not 0 <= offset <= len(mapping["canonical_text"])
        ):
            raise RuntimeError(
                f"0324 reader cursor {row['media_id']} has invalid x offset"
            )
        if tag in {"Positioned", "Unresolved"}:
            old_id = locator.get("occurrence_id")
            reading = row["media_id"]
            candidates = []
            primaries = list(
                db.execute(
                    sa.text("""SELECT tp.id,tp.post_media_id FROM x_thread_posts tp
                WHERE tp.thread_media_id=:media ORDER BY tp.ordinal"""),
                    {"media": reading},
                ).mappings()
            )
            if not primaries and str(reading) in maps:
                primaries = [{"id": reading, "post_media_id": reading}]
            for primary in primaries:
                parent_map = maps.get(str(primary["post_media_id"]))
                if parent_map is None:
                    continue
                old_parent = occurrence(reading, primary["post_media_id"])
                new_parent = str(primary["id"])
                if (
                    old_parent == old_id
                    and str(primary["post_media_id"]) == locator["post_media_id"]
                ):
                    candidates.append(new_parent)
                for context in db.execute(
                    sa.text("""SELECT de.target_media_id,de.provider_target_ref,xp.payload
                    FROM document_embeds de JOIN x_post_sources xp ON xp.media_id=de.media_id
                    WHERE de.media_id=:id AND de.provider='x' AND de.embed_kind='post'
                      AND de.target_media_id IS NOT NULL"""),
                    {"id": primary["post_media_id"]},
                ).mappings():
                    if str(context["target_media_id"]) != locator["post_media_id"]:
                        continue
                    for reference in context["payload"]["references"]:
                        relation = reference["kind"]
                        if (
                            reference["target_revision_id"]
                            == context["provider_target_ref"]
                            and occurrence(
                                reading,
                                context["target_media_id"],
                                old_parent,
                                relation,
                            )
                            == old_id
                        ):
                            candidates.append(
                                occurrence(
                                    parent_map["capture_id"],
                                    mapping["capture_id"],
                                    new_parent,
                                    relation,
                                )
                            )
            for embed in db.execute(
                sa.text("""SELECT id,fragment_id,occurrence_key,target_media_id
                FROM document_embeds WHERE media_id=:id AND provider='x' AND embed_kind='post'
                  AND target_media_id IS NOT NULL"""),
                {"id": reading},
            ).mappings():
                if (
                    str(embed["target_media_id"]) == locator["post_media_id"]
                    and occurrence(
                        reading,
                        embed["target_media_id"],
                        str(embed["fragment_id"]),
                        "embedded",
                        embed["occurrence_key"],
                    )
                    == old_id
                ):
                    candidates.append(str(embed["id"]))
            if len(candidates) != 1:
                raise RuntimeError(
                    f"0324 reader cursor {reading} has an ambiguous x occurrence"
                )
            locator["occurrence_id"] = candidates[0]
        locator.pop("post_media_id")
        locator["capture_id"] = str(mapping["capture_id"])
        locator["fragment_id"] = str(mapping["fragment_id"])
        if tag == "Unresolved":
            prior = cursor.pop("post_media_id", None)
            if prior is None:
                cursor["capture_id"] = None
            elif prior == str(mapping["media_id"]):
                cursor["capture_id"] = str(mapping["capture_id"])
            else:
                raise RuntimeError(
                    f"0324 unresolved cursor {row['media_id']} has conflicting x identity"
                )
        db.execute(
            sa.text(
                "UPDATE reader_media_state SET cursor=CAST(:cursor AS jsonb) WHERE user_id=:user AND media_id=:media"
            ),
            {
                "cursor": json.dumps(cursor),
                "user": row["user_id"],
                "media": row["media_id"],
            },
        )


def _queue_capture_work(db: sa.Connection) -> None:
    captures = list(
        db.execute(
            sa.text("""SELECT c.id,c.payload,map.fragment_id
        FROM x_post_captures c JOIN x_capture_map map ON map.capture_id=c.id""")
        ).mappings()
    )
    for capture in captures:
        attachments = capture["payload"]["content"]["attachments"]
        has_images = any(
            (a.get("url") if a.get("type") == "photo" else a.get("preview_image_url"))
            for a in attachments
        )
        if has_images:
            job_id = _id()
            db.execute(
                sa.text("""INSERT INTO background_jobs(id,kind,payload)
                VALUES (:id,'archive_x_capture_assets',CAST(:payload AS jsonb))"""),
                {
                    "id": job_id,
                    "payload": json.dumps({"capture_id": str(capture["id"])}),
                },
            )
            db.execute(
                sa.text(
                    "UPDATE x_post_captures SET asset_job_id=:job WHERE id=:capture"
                ),
                {"job": job_id, "capture": capture["id"]},
            )
        if not db.scalar(
            sa.text("""SELECT EXISTS(SELECT 1 FROM content_index_states
            WHERE owner_kind='fragment' AND owner_id=:id AND status IN ('ready','no_text'))"""),
            {"id": capture["fragment_id"]},
        ):
            db.execute(
                sa.text("""INSERT INTO background_jobs(id,kind,payload)
                VALUES (:id,'x_capture_content_reindex',CAST(:payload AS jsonb))"""),
                {
                    "id": _id(),
                    "payload": json.dumps({"capture_id": str(capture["id"])}),
                },
            )


def _seed_admissions(db: sa.Connection) -> None:
    # Freeze the old viewer-visible relation before changing its source identities.
    visible = """WITH RECURSIVE eligible AS (
        SELECT m.id FROM media m WHERE NOT EXISTS (SELECT 1 FROM user_media_deletions d
          WHERE d.media_id=m.id AND d.user_id=:viewer)
          AND NOT EXISTS (SELECT 1 FROM media_teardown_intents ti WHERE ti.media_id=m.id)),
    edges AS (SELECT source_media_id parent,media_id child FROM media_parts),
    roots AS (
        SELECT le.media_id FROM library_entries le JOIN memberships m ON m.library_id=le.library_id
          WHERE m.user_id=:viewer
        UNION SELECT g.subject_id FROM resource_grants g WHERE g.subject_scheme='media'
          AND (g.grantee_user_id=:viewer OR g.created_by_user_id=:viewer)
        UNION SELECT h.anchor_media_id FROM resource_grants g JOIN highlights h
          ON g.subject_scheme='highlight' AND g.subject_id=h.id AND h.authored_visible
          WHERE g.grantee_user_id=:viewer OR g.created_by_user_id=:viewer
        UNION SELECT h.anchor_media_id FROM highlights h WHERE h.user_id=:viewer AND h.authored_visible
        UNION SELECT p.owner_id FROM passage_anchors p WHERE p.user_id=:viewer AND p.owner_scheme='media'
        UNION SELECT r.media_id FROM message_retrievals r JOIN messages m ON m.id=r.assistant_message_id
          JOIN conversations c ON c.id=m.conversation_id WHERE c.owner_user_id=:viewer
        UNION SELECT xp.media_id FROM messages m JOIN conversations c ON c.id=m.conversation_id
          JOIN x_post_sources xp ON m.reader_selection_snapshot #>> '{evidence,target,owner_ref}'='media:'||xp.media_id::text
          WHERE c.owner_user_id=:viewer
        UNION SELECT xp.media_id FROM resource_edges e JOIN x_post_sources xp
          ON e.snapshot #>> '{evidence,target,owner_ref}'='media:'||xp.media_id::text
          WHERE e.user_id=:viewer AND e.origin='citation' AND e.ordinal IS NOT NULL),
    reached(media_id) AS (
        SELECT roots.media_id FROM roots JOIN eligible ON eligible.id=roots.media_id
        UNION SELECT edges.child FROM reached JOIN edges ON edges.parent=reached.media_id
          JOIN eligible ON eligible.id=edges.child)
    SELECT map.capture_id FROM x_capture_map map JOIN reached ON reached.media_id=map.media_id
    UNION SELECT target.capture_id FROM reached JOIN x_post_sources xp ON xp.media_id=reached.media_id
      JOIN document_embeds de ON de.media_id=xp.media_id AND de.provider='x' AND de.embed_kind='post'
        AND de.resolution_status='resolved' AND de.canonical_end_offset IS NOT NULL
      JOIN x_capture_map target ON target.media_id=de.target_media_id
      JOIN x_post_captures c ON c.id=target.capture_id AND c.source_revision_id=de.provider_target_ref
    UNION SELECT map.capture_id FROM x_thread_posts tp JOIN reached ON reached.media_id=tp.thread_media_id
      JOIN x_capture_map map ON map.media_id=tp.post_media_id
    UNION SELECT map.capture_id FROM document_embeds de JOIN reached ON reached.media_id=de.media_id
      JOIN x_capture_map map ON map.media_id=de.target_media_id
      JOIN x_post_captures c ON c.id=map.capture_id AND c.source_revision_id=de.provider_target_ref
      WHERE de.provider='x' AND de.embed_kind='post' AND de.resolution_status='resolved' AND de.canonical_end_offset IS NOT NULL
    UNION SELECT target.capture_id FROM x_thread_posts tp JOIN reached ON reached.media_id=tp.thread_media_id
      JOIN document_embeds de ON de.media_id=tp.post_media_id AND de.provider='x' AND de.embed_kind='post' AND de.resolution_status='resolved' AND de.canonical_end_offset IS NOT NULL
      JOIN x_capture_map target ON target.media_id=de.target_media_id
      JOIN x_post_captures c ON c.id=target.capture_id AND c.source_revision_id=de.provider_target_ref
    UNION SELECT target.capture_id FROM document_embeds root JOIN reached ON reached.media_id=root.media_id
      JOIN x_capture_map primary_post ON primary_post.media_id=root.target_media_id
      JOIN x_post_captures primary_capture ON primary_capture.id=primary_post.capture_id
        AND primary_capture.source_revision_id=root.provider_target_ref
      JOIN document_embeds de ON de.media_id=primary_post.media_id AND de.provider='x' AND de.embed_kind='post' AND de.resolution_status='resolved' AND de.canonical_end_offset IS NOT NULL
      JOIN x_capture_map target ON target.media_id=de.target_media_id
      JOIN x_post_captures c ON c.id=target.capture_id AND c.source_revision_id=de.provider_target_ref
      WHERE root.provider='x' AND root.embed_kind='post' AND root.resolution_status='resolved' AND root.canonical_end_offset IS NOT NULL"""
    for account_id in db.scalars(sa.text("SELECT id FROM users ORDER BY id")):
        for capture_id in db.scalars(sa.text(visible), {"viewer": account_id}):
            db.execute(
                sa.text("""INSERT INTO x_post_capture_admissions(id,user_id,capture_id)
                VALUES (:id,:user,:capture) ON CONFLICT(user_id,capture_id) DO NOTHING"""),
                {"id": _id(), "user": account_id, "capture": capture_id},
            )


def _convert_index(db: sa.Connection) -> None:
    for table, constraint in (
        ("content_chunks", "ck_content_chunks_owner_kind"),
        ("content_index_states", "ck_content_index_states_owner_kind"),
        ("evidence_spans", "ck_evidence_spans_owner_kind"),
    ):
        op.drop_constraint(constraint, table, type_="check")
    for table, selector_column, text_column in (
        ("content_chunks", "summary_locator", "chunk_text"),
        ("evidence_spans", "selector", "span_text"),
    ):
        rows = list(
            db.execute(
                sa.text(f"""SELECT x.id,x.{selector_column} AS selector,
            x.{text_column} AS literal,map.fragment_id,map.capture_id,f.canonical_text
            FROM {table} x JOIN x_capture_map map ON x.owner_kind='media' AND x.owner_id=map.media_id
            JOIN fragments f ON f.id=map.fragment_id""")
            ).mappings()
        )
        for row in rows:
            locator, literal = row["selector"], row["literal"]
            if (
                not isinstance(locator, dict)
                or locator.get("type") != "web_text_offsets"
                or locator.get("fragment_id") != str(row["fragment_id"])
            ):
                raise RuntimeError(
                    f"0324 {table} {row['id']} lacks an exact source fragment"
                )
            start, end = locator.get("start_offset"), locator.get("end_offset")
            if (
                type(start) is not int
                or type(end) is not int
                or not 0 <= start < end <= len(row["canonical_text"])
                or row["canonical_text"][start:end] != literal
            ):
                raise RuntimeError(
                    f"0324 {table} {row['id']} does not match its retained source"
                )
            selector = {
                "type": "x_capture_offsets",
                "kind": "x_capture_text",
                "capture_id": str(row["capture_id"]),
                "fragment_id": str(row["fragment_id"]),
                "start_offset": start,
                "end_offset": end,
                "text_quote": {"exact": literal, "prefix": "", "suffix": ""},
            }
            db.execute(
                sa.text(f"""UPDATE {table} SET owner_kind='fragment',owner_id=:fragment,
                {selector_column}=CAST(:selector AS jsonb) WHERE id=:id"""),
                {
                    "fragment": row["fragment_id"],
                    "selector": json.dumps(selector),
                    "id": row["id"],
                },
            )
    op.execute("""UPDATE content_index_states s SET owner_kind='fragment',owner_id=map.fragment_id
        FROM x_capture_map map WHERE s.owner_kind='media' AND s.owner_id=map.media_id""")


def _convert_evidence(db: sa.Connection) -> None:
    mappings = {
        f"media:{row['media_id']}": row
        for row in db.execute(
            sa.text(
                """SELECT map.*,f.canonical_text,rp.generation FROM x_capture_map map JOIN fragments f ON f.id=map.fragment_id LEFT JOIN reader_publications rp ON rp.media_id=map.media_id"""
            )
        ).mappings()
    }

    def passage_mapping(target: object) -> sa.RowMapping | None:
        if not isinstance(target, dict) or target.get("kind") != "passage":
            return None
        locator = target.get("locator")
        if not isinstance(locator, dict):
            return mappings.get(target.get("owner_ref"))
        return mappings.get(f"media:{locator.get('media_id')}") or mappings.get(
            target.get("owner_ref")
        )

    def passage(target: object, identity: str, quote_exact: object) -> object:
        if not isinstance(target, dict) or target.get("kind") != "passage":
            return target
        mapping = passage_mapping(target)
        if mapping is None:
            return target
        owner = target.get("owner_ref")
        if not isinstance(owner, str) or not owner.startswith("media:"):
            raise RuntimeError(f"0324 {identity} has an unknown reading owner")
        if "source_identity" not in target:
            raise RuntimeError(f"0324 {identity} lacks source publication evidence")
        source_identity = target["source_identity"]
        if source_identity is None:
            if owner != f"media:{mapping['media_id']}":
                raise RuntimeError(f"0324 {identity} has conflicting retained owner")
        else:
            generation = db.scalar(
                sa.text(
                    "SELECT generation FROM reader_publications WHERE media_id::text=:id"
                ),
                {"id": owner.removeprefix("media:")},
            )
            if generation is None or source_identity != f"g{generation}":
                raise RuntimeError(
                    f"0324 {identity} refers to a different or unknown publication"
                )
        converted = _convert_locator(target.get("locator"), mapping, identity)
        if (
            not isinstance(quote_exact, str)
            or quote_exact
            != mapping["canonical_text"][
                converted["start_offset"] : converted["end_offset"]
            ]
        ):
            raise RuntimeError(
                f"0324 {identity} quote differs from retained text"
            )
        target["locator"] = converted
        target["owner_ref"] = f"fragment:{mapping['fragment_id']}"
        if source_identity is not None:
            target["source_identity"] = str(mapping["capture_id"])
        return target

    def evidence(value: object, identity: str) -> object:
        if not isinstance(value, dict):
            return value
        target = value.get("target")
        quote = value.get("quote")
        value["target"] = passage(
            target, identity, quote.get("exact") if isinstance(quote, dict) else None
        )
        return value

    rows = list(
        db.execute(
            sa.text(
                "SELECT id,reader_selection_snapshot FROM messages WHERE reader_selection_snapshot IS NOT NULL"
            )
        ).mappings()
    )
    for row in rows:
        snapshot = row["reader_selection_snapshot"]
        key = snapshot.get("key")
        if (
            not isinstance(key, dict)
            or "media_id" not in key
            or "highlight_id" not in key
        ):
            raise RuntimeError(
                f"0324 message {row['id']} has an unknown reader snapshot"
            )
        target = snapshot.get("evidence", {}).get("target")
        mapping = passage_mapping(target)
        if mapping is not None:
            if f"media:{key['media_id']}" != target.get("owner_ref"):
                raise RuntimeError(
                    f"0324 message {row['id']} has conflicting frozen reader key"
                )
            key["media_id"] = None
            key["capture_id"] = str(mapping["capture_id"])
        elif mappings.get(f"media:{key['media_id']}") is not None:
            raise RuntimeError(
                f"0324 message {row['id']} lacks exact x passage evidence"
            )
        else:
            key["capture_id"] = None
        snapshot["evidence"] = evidence(
            snapshot.get("evidence"), f"message {row['id']}"
        )
        db.execute(
            sa.text(
                "UPDATE messages SET reader_selection_snapshot=CAST(:value AS jsonb) WHERE id=:id"
            ),
            {"id": row["id"], "value": json.dumps(snapshot)},
        )
    rows = list(
        db.execute(
            sa.text(
                "SELECT id,snapshot FROM resource_edges WHERE origin='citation' AND snapshot IS NOT NULL"
            )
        ).mappings()
    )
    for row in rows:
        snapshot = row["snapshot"]
        snapshot["evidence"] = evidence(
            snapshot.get("evidence"), f"citation {row['id']}"
        )
        db.execute(
            sa.text(
                "UPDATE resource_edges SET snapshot=CAST(:value AS jsonb) WHERE id=:id"
            ),
            {"id": row["id"], "value": json.dumps(snapshot)},
        )
    rows = list(
        db.execute(
            sa.text("""SELECT id,result_type,media_id,locator,context_ref,result_ref,captured_evidence
        FROM message_retrievals WHERE media_id IN (SELECT media_id FROM x_capture_map)
          OR locator->>'media_id' IN (SELECT media_id::text FROM x_capture_map)""")
        ).mappings()
    )
    for row in rows:
        locator = row["locator"]
        mapping = (
            mappings.get(f"media:{locator.get('media_id')}")
            if isinstance(locator, dict)
            else None
        )
        if mapping is None:
            mapping = mappings[f"media:{row['media_id']}"]
        if locator is None:
            # A deliberately saved media result remains a media result.
            if db.scalar(
                sa.text("SELECT EXISTS(SELECT 1 FROM x_post_media WHERE media_id=:id)"),
                {"id": row["media_id"]},
            ):
                continue
            raise RuntimeError(
                f"0324 retrieval {row['id']} lacks original x passage evidence"
            )
        converted = _convert_locator(locator, mapping, f"retrieval {row['id']}")
        if row["result_type"] not in {
            "highlight",
            "fragment",
            "content_chunk",
            "evidence_span",
        }:
            raise RuntimeError(
                f"0324 retrieval {row['id']} needs source-result identity repair"
            )
        context = row["context_ref"]
        if not isinstance(context, dict) or not isinstance(row["result_ref"], dict):
            raise RuntimeError(
                f"0324 retrieval {row['id']} has invalid stored references"
            )
        result_locator = row["result_ref"].get("locator")
        if result_locator is not None and result_locator != locator:
            raise RuntimeError(
                f"0324 retrieval {row['id']} has conflicting result locator"
            )
        captured_quote = (
            row["captured_evidence"].get("quote")
            if isinstance(row["captured_evidence"], dict)
            else None
        )
        if isinstance(context, dict):
            context["passage_target"] = passage(
                context.get("passage_target"),
                f"retrieval {row['id']}",
                captured_quote.get("exact")
                if isinstance(captured_quote, dict)
                else None,
            )
        result = row["result_ref"]
        if isinstance(result, dict):
            result["locator"] = converted
            result["media_id"] = None
            result["deep_link"] = f"/x/captures/{mapping['capture_id']}"
            result["context_ref"] = context
        captured = evidence(row["captured_evidence"], f"retrieval {row['id']}")
        target = captured.get("target") if isinstance(captured, dict) else None
        if not isinstance(target, dict) or target.get("locator") != converted:
            raise RuntimeError(
                f"0324 retrieval {row['id']} has conflicting captured evidence"
            )
        passage_target = context.get("passage_target")
        if passage_target is not None and (
            not isinstance(passage_target, dict)
            or passage_target.get("locator") != converted
        ):
            raise RuntimeError(
                f"0324 retrieval {row['id']} has conflicting context evidence"
            )
        if result.get("citation_target") == f"media:{mapping['media_id']}":
            result["citation_target"] = f"fragment:{mapping['fragment_id']}"
        db.execute(
            sa.text("""UPDATE message_retrievals SET media_id=NULL,locator=CAST(:locator AS jsonb),
            context_ref=CAST(:context AS jsonb),result_ref=CAST(:result AS jsonb),
            captured_evidence=CAST(:captured AS jsonb) WHERE id=:id"""),
            {
                "id": row["id"],
                "locator": json.dumps(converted),
                "context": json.dumps(context),
                "result": json.dumps(result),
                "captured": json.dumps(captured),
            },
        )


def _convert_schema(db: sa.Connection) -> None:
    if db.scalar(
        sa.text("""SELECT EXISTS(SELECT 1 FROM x_thread_sources ts
        CROSS JOIN LATERAL jsonb_array_elements_text(ts.coverage->'unchecked_primary_post_media_ids') old(media_id)
        LEFT JOIN x_post_sources xp ON xp.media_id::text=old.media_id WHERE xp.id IS NULL)""")
    ):
        raise RuntimeError("0324 thread coverage references an unknown logical source")
    op.execute("""UPDATE x_thread_sources ts SET coverage=(coverage - 'unchecked_primary_post_media_ids') ||
        jsonb_build_object('unchecked_primary_post_ids', COALESCE((
          SELECT jsonb_agg(xp.id ORDER BY ord.ordinality)
          FROM jsonb_array_elements_text(ts.coverage->'unchecked_primary_post_media_ids')
               WITH ORDINALITY AS ord(media_id, ordinality)
          JOIN x_post_sources xp ON xp.media_id::text=ord.media_id), '[]'::jsonb))""")
    op.execute("""UPDATE fragments f SET media_id=NULL,x_post_capture_id=map.capture_id
        FROM x_capture_map map WHERE f.id=map.fragment_id""")
    if db.scalar(
        sa.text("""SELECT count(*) FROM fragments
        WHERE (media_id IS NULL) = (x_post_capture_id IS NULL)
           OR (x_post_capture_id IS NOT NULL AND idx<>0)""")
    ):
        raise RuntimeError("0324 fragment ownership or capture index is invalid")
    op.drop_constraint(
        "x_post_aliases_post_media_id_fkey", "x_post_aliases", type_="foreignkey"
    )
    op.drop_column("x_post_aliases", "post_media_id")
    op.alter_column("x_post_aliases", "post_id", nullable=False)
    op.drop_constraint(
        "x_thread_posts_post_media_id_fkey", "x_thread_posts", type_="foreignkey"
    )
    op.drop_constraint(
        "x_thread_posts_thread_media_id_post_media_id_key",
        "x_thread_posts",
        type_="unique",
    )
    op.drop_column("x_thread_posts", "post_media_id")
    op.alter_column("x_thread_posts", "capture_id", nullable=False)
    op.drop_constraint(
        "x_thread_sources_root_post_media_id_fkey",
        "x_thread_sources",
        type_="foreignkey",
    )
    op.drop_column("x_thread_sources", "root_post_media_id")
    op.drop_constraint(
        "x_post_sources_media_id_fkey", "x_post_sources", type_="foreignkey"
    )
    op.drop_constraint(
        "x_post_sources_source_attempt_id_fkey", "x_post_sources", type_="foreignkey"
    )
    op.drop_constraint("x_post_sources_media_id_key", "x_post_sources", type_="unique")
    # Settled x-capture receipts retain the originally accepted media identity
    # even after its presentation is removed. Other attempts require live media.
    op.drop_constraint(
        "media_source_attempts_media_id_fkey",
        "media_source_attempts",
        type_="foreignkey",
    )
    for column in (
        "media_id",
        "source_attempt_id",
        "source_revision_id",
        "payload",
        "availability",
        "body_captured_at",
        "checked_at",
    ):
        op.drop_column("x_post_sources", column)
    op.execute(
        "ALTER TABLE x_post_sources ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()"
    )
    op.create_unique_constraint(
        "uq_x_post_sources_logical_post_id", "x_post_sources", ["logical_post_id"]
    )
    op.drop_table("document_embed_artifact_states")


def _convert_publications(db: sa.Connection) -> None:
    op.execute("""UPDATE x_post_aliases a SET post_id=xp.id,
        availability=CASE WHEN a.revision_id=xp.source_revision_id THEN xp.availability END,
        checked_at=CASE WHEN a.revision_id=xp.source_revision_id THEN xp.checked_at END
        FROM x_post_sources xp WHERE a.post_media_id=xp.media_id""")
    missing = db.scalar(
        sa.text("SELECT count(*) FROM x_post_aliases WHERE post_id IS NULL")
    )
    if missing:
        raise RuntimeError("0324 aliases without retained post identity require repair")
    if db.scalar(
        sa.text("""SELECT EXISTS(SELECT 1 FROM x_post_captures c
        LEFT JOIN x_post_aliases a ON a.post_id=c.post_id AND a.revision_id=c.source_revision_id
        WHERE a.id IS NULL)""")
    ):
        raise RuntimeError(
            "0324 captured revision lacks its exact logical-source alias"
        )
    op.execute("""UPDATE x_thread_posts tp SET capture_id=map.capture_id FROM x_capture_map map
        WHERE tp.post_media_id=map.media_id""")
    if db.scalar(
        sa.text("SELECT count(*) FROM x_thread_posts WHERE capture_id IS NULL")
    ):
        raise RuntimeError("0324 thread membership lacks a retained capture")
    op.execute("""UPDATE x_thread_sources ts SET root_capture_id=map.capture_id FROM x_capture_map map
        WHERE ts.root_post_media_id=map.media_id""")
    if db.scalar(
        sa.text(
            "SELECT count(*) FROM x_thread_sources WHERE root_post_media_id IS NOT NULL AND root_capture_id IS NULL"
        )
    ):
        raise RuntimeError("0324 thread root lacks a retained capture")
    rows = list(
        db.execute(
            sa.text("""SELECT map.*,xp.payload,xp.source_revision_id
        FROM x_capture_map map JOIN x_post_sources xp ON xp.id=map.post_id ORDER BY map.post_id""")
        ).mappings()
    )
    for row in rows:
        references = row["payload"]["references"]
        seen = set()
        for ordinal, reference in enumerate(references):
            if not isinstance(reference, dict) or set(reference) != {
                "kind",
                "target_revision_id",
            }:
                raise RuntimeError(f"0324 source {row['post_id']} has invalid context")
            relation, revision_id = reference["kind"], reference["target_revision_id"]
            if (
                relation not in {"quoted", "replied_to", "retweeted"}
                or not isinstance(revision_id, str)
                or (relation, revision_id) in seen
            ):
                raise RuntimeError(
                    f"0324 source {row['post_id']} has ambiguous context"
                )
            seen.add((relation, revision_id))
            candidates = list(
                db.execute(
                    sa.text("""SELECT de.target_media_id,de.error_code,de.resolution_status,de.canonical_end_offset,
                target.capture_id, capture.source_revision_id
                FROM document_embeds de
                LEFT JOIN x_capture_map target ON target.media_id=de.target_media_id
                LEFT JOIN x_post_captures capture ON capture.id=target.capture_id
                WHERE de.media_id=:media AND de.provider='x' AND de.embed_kind='post'
                  AND de.provider_target_ref=:revision"""),
                    {"media": row["media_id"], "revision": revision_id},
                ).mappings()
            )
            if len(candidates) > 1:
                raise RuntimeError(
                    f"0324 source {row['post_id']} has ambiguous context occurrence"
                )
            candidate = candidates[0] if candidates else None
            target_id = (
                candidate["capture_id"]
                if candidate
                and candidate["source_revision_id"] == revision_id
                and candidate["resolution_status"] == "resolved"
                and candidate["canonical_end_offset"] is not None
                else None
            )
            outcome = (
                "captured"
                if target_id
                else "unavailable"
                if candidate and candidate["error_code"] == "E_X_POST_UNAVAILABLE"
                else "not_captured"
            )
            db.execute(
                sa.text("""INSERT INTO x_post_capture_contexts
                (id,capture_id,relation,ordinal,referenced_revision_id,target_capture_id,outcome,error_code)
                VALUES (:id,:capture,:relation,:ordinal,:revision,:target,:outcome,:error)"""),
                {
                    "id": _id(),
                    "capture": row["capture_id"],
                    "relation": relation,
                    "ordinal": ordinal,
                    "revision": revision_id,
                    "target": target_id,
                    "outcome": outcome,
                    "error": candidate["error_code"]
                    if candidate and target_id is None
                    else None,
                },
            )
    op.execute("""UPDATE document_embeds de SET target_x_post_capture_id=map.capture_id,target_media_id=NULL
        FROM x_capture_map map JOIN x_post_captures c ON c.id=map.capture_id
        WHERE de.target_media_id=map.media_id AND de.provider='x' AND de.embed_kind='post'
          AND de.provider_target_ref=c.source_revision_id
          AND de.resolution_status='resolved' AND de.canonical_end_offset IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM x_capture_map parent WHERE parent.media_id=de.media_id)""")
    # An old mutable winning body is not evidence for another requested revision.
    if db.scalar(
        sa.text("""SELECT count(*) FROM document_embeds de JOIN x_capture_map map
        ON map.media_id=de.target_media_id WHERE de.provider='x' AND de.embed_kind='post'
        AND de.resolution_status='resolved' AND de.canonical_end_offset IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM x_capture_map parent WHERE parent.media_id=de.media_id)""")
    ):
        raise RuntimeError(
            "0324 article quote target does not match its retained exact revision"
        )
    unresolved = list(
        db.execute(
            sa.text("""SELECT de.id,de.media_id,de.source_attempt_id,de.provider_target_ref,
        EXISTS(SELECT 1 FROM media_source_attempts child WHERE child.media_id=de.target_media_id
          AND child.source_type='x_post' AND child.status IN ('accepted','queued','running')) AS pending
        FROM document_embeds de JOIN x_post_sources xp ON xp.media_id=de.target_media_id
        WHERE de.provider='x' AND de.embed_kind='post'
          AND NOT EXISTS (SELECT 1 FROM x_capture_map parent WHERE parent.media_id=de.media_id)""")
        ).mappings()
    )
    for occurrence in unresolved:
        job_id = None
        if occurrence["pending"]:
            revision_id = occurrence["provider_target_ref"]
            if (
                occurrence["source_attempt_id"] is None
                or not isinstance(revision_id, str)
                or not revision_id.isascii()
                or not revision_id.isdecimal()
            ):
                raise RuntimeError(
                    f"0324 pending quote {occurrence['id']} lacks exact provenance"
                )
            job_id = _id()
            payload = {
                "media_id": str(occurrence["media_id"]),
                "occurrence_id": str(occurrence["id"]),
                "parent_source_attempt_id": str(occurrence["source_attempt_id"]),
                "requested_revision_id": revision_id,
            }
            db.execute(
                sa.text("""INSERT INTO background_jobs(id,kind,payload)
                VALUES (:id,'capture_x_quote',CAST(:payload AS jsonb))"""),
                {"id": job_id, "payload": json.dumps(payload)},
            )
        db.execute(
            sa.text("""UPDATE document_embeds SET target_media_id=NULL,capture_job_id=:job,
            resolution_status=:status WHERE id=:id"""),
            {
                "job": job_id,
                "status": "resolving" if job_id else "failed",
                "id": occurrence["id"],
            },
        )
    op.execute(
        "DELETE FROM document_embeds de USING x_capture_map map WHERE de.media_id=map.media_id AND de.provider='x' AND de.embed_kind='post'"
    )
    # A physical holding or explicit media grant is never inferred to be a phantom.
    retained = list(
        db.execute(
            sa.text("""SELECT DISTINCT map.* FROM x_capture_map map WHERE
        EXISTS (SELECT 1 FROM library_entries le WHERE le.media_id=map.media_id)
        OR EXISTS (SELECT 1 FROM resource_grants g WHERE g.subject_scheme='media' AND g.subject_id=map.media_id)
        OR EXISTS (SELECT 1 FROM resource_edges e WHERE e.authored_visible AND e.origin IN ('user','highlight_note','link_note')
            AND ((e.source_scheme='media' AND e.source_id=map.media_id) OR (e.target_scheme='media' AND e.target_id=map.media_id)))
        OR EXISTS (SELECT 1 FROM document_embeds e WHERE e.target_media_id=map.media_id)
        OR EXISTS (SELECT 1 FROM authored_links l WHERE l.state->>'endpoint_a'='media:'||map.media_id::text
            OR l.state->>'endpoint_b'='media:'||map.media_id::text)
        OR EXISTS (SELECT 1 FROM note_blocks n CROSS JOIN LATERAL
            jsonb_array_elements(COALESCE(n.body_pm_json->'content','[]'::jsonb)) item
            WHERE item->>'type'='resource_embed' AND item->'attrs'->>'resource_ref'='media:'||map.media_id::text)""")
        ).mappings()
    )
    for row in retained:
        db.execute(
            sa.text(
                "INSERT INTO x_post_media(id,media_id,post_id,capture_id) VALUES (:id,:media,:post,:capture)"
            ),
            {
                "id": _id(),
                "media": row["media_id"],
                "post": row["post_id"],
                "capture": row["capture_id"],
            },
        )


def _convert_locator(locator: object, row: sa.RowMapping, identity: str) -> dict:
    if not isinstance(locator, dict) or locator.get("type") != "web_text_offsets":
        raise RuntimeError(f"0324 {identity} has an unsupported x locator")
    if locator.get("media_id") != str(row["media_id"]) or locator.get(
        "fragment_id"
    ) != str(row["fragment_id"]):
        raise RuntimeError(f"0324 {identity} does not identify the retained x fragment")
    start, end = locator.get("start_offset"), locator.get("end_offset")
    text = row["canonical_text"]
    if (
        type(start) is not int
        or type(end) is not int
        or not 0 <= start < end <= len(text)
    ):
        raise RuntimeError(f"0324 {identity} has invalid x offsets")
    quote = locator.get("text_quote_selector")
    if quote is not None and (
        not isinstance(quote, dict) or quote.get("exact") != text[start:end]
    ):
        raise RuntimeError(
            f"0324 {identity} quote does not match its retained x fragment"
        )
    return {
        "type": "x_capture_offsets",
        "capture_id": str(row["capture_id"]),
        "fragment_id": str(row["fragment_id"]),
        "start_offset": start,
        "end_offset": end,
        "text_quote_selector": quote,
    }


def _convert_authored(db: sa.Connection) -> None:
    mappings = {
        f"media:{row['media_id']}": row
        for row in db.execute(
            sa.text("""SELECT map.*, f.canonical_text,rp.generation FROM x_capture_map map
            JOIN fragments f ON f.id=map.fragment_id LEFT JOIN reader_publications rp ON rp.media_id=map.media_id""")
        ).mappings()
    }

    for table, key, register in (
        ("authored_resources", "ref", "selection"),
        ("authored_passages", "anchor_id", "capture"),
    ):
        rows = list(
            db.execute(
                sa.text(
                    f"SELECT account_id,{key},state FROM {table} ORDER BY account_id,{key}"
                )
            ).mappings()
        )
        for record in rows:
            state = record["state"]
            mapping = mappings.get(state.get("source_ref"))
            if mapping is None:
                continue
            identity = f"{table} {record[key]}"
            if table == "authored_resources" and state.get("kind") != "highlight":
                raise RuntimeError(f"0324 {identity} has an unknown x source binding")
            capture = state.get(register, {}).get("value")
            if not isinstance(capture, dict):
                raise RuntimeError(f"0324 {identity} lacks a capture register")
            publication = capture.get("publication")
            if publication is None:
                # Highlight anchors prove a retained location, not the original
                # publication. Keep that provenance unknown after conversion.
                if table == "authored_passages" and mapping["generation"] != 1:
                    raise RuntimeError(
                        f"0324 {identity} has no proof of its original publication"
                    )
            elif (
                not isinstance(publication, dict)
                or publication.get("kind") != "reader"
                or publication.get("generation") != mapping["generation"]
            ):
                raise RuntimeError(f"0324 {identity} refers to a different publication")
            locator = capture.get("locator")
            if locator is None and table == "authored_passages":
                quote = capture.get("quote_exact")
                if (
                    not isinstance(quote, str)
                    or not quote
                    or mapping["canonical_text"].count(quote) != 1
                ):
                    raise RuntimeError(
                        f"0324 {identity} lacks a unique original passage"
                    )
            else:
                converted = _convert_locator(locator, mapping, identity)
                if (
                    capture.get("quote_exact")
                    != mapping["canonical_text"][
                        converted["start_offset"] : converted["end_offset"]
                    ]
                ):
                    raise RuntimeError(
                        f"0324 {identity} selection differs from retained text"
                    )
                if table == "authored_resources":
                    anchor = (
                        db.execute(
                            sa.text("""SELECT h.anchor_media_id,a.fragment_id,a.start_offset,a.end_offset
                        FROM highlights h LEFT JOIN highlight_fragment_anchors a ON a.highlight_id=h.id
                        WHERE h.id=CAST(:id AS uuid)"""),
                            {"id": str(record[key]).removeprefix("highlight:")},
                        )
                        .mappings()
                        .one_or_none()
                    )
                    if (
                        anchor is None
                        or anchor["anchor_media_id"] != mapping["media_id"]
                        or anchor["fragment_id"] != mapping["fragment_id"]
                        or anchor["start_offset"] != converted["start_offset"]
                        or anchor["end_offset"] != converted["end_offset"]
                    ):
                        raise RuntimeError(
                            f"0324 {identity} conflicts with its anchor projection"
                        )
                capture["locator"] = converted
            if publication is not None or table == "authored_passages":
                capture["publication"] = {
                    "kind": "x_capture",
                    "capture_id": str(mapping["capture_id"]),
                }
            state["source_ref"] = f"fragment:{mapping['fragment_id']}"
            db.execute(
                sa.text(
                    f"UPDATE {table} SET state=CAST(:state AS jsonb) WHERE account_id=:account AND {key}=:key"
                ),
                {
                    "state": json.dumps(state),
                    "account": record["account_id"],
                    "key": record[key],
                },
            )
    rows = list(
        db.execute(
            sa.text(
                "SELECT account_id,source_ref,state FROM authored_source_stubs ORDER BY account_id,source_ref"
            )
        ).mappings()
    )
    for record in rows:
        mapping = mappings.get(record["source_ref"])
        if mapping is None:
            continue
        state = record["state"]
        capture = state.get("capture", {}).get("value")
        if not isinstance(capture, dict):
            raise RuntimeError(
                f"0324 source stub {record['source_ref']} lacks a capture register"
            )
        new_ref = f"fragment:{mapping['fragment_id']}"
        capture["publication"] = {
            "kind": "x_capture",
            "capture_id": str(mapping["capture_id"]),
        }
        state["source_ref"] = new_ref
        params = {
            "new_ref": new_ref,
            "state": json.dumps(state),
            "account": record["account_id"],
            "old_ref": record["source_ref"],
        }
        deliberate = db.scalar(
            sa.text("""SELECT EXISTS (
            SELECT 1 FROM authored_links WHERE account_id=:account
              AND (state->>'endpoint_a'=:old_ref OR state->>'endpoint_b'=:old_ref)
            UNION ALL
            SELECT 1 FROM note_blocks n CROSS JOIN LATERAL
              jsonb_array_elements(COALESCE(n.body_pm_json->'content','[]'::jsonb)) item
              WHERE n.user_id=:account AND item->>'type'='resource_embed'
                AND item->'attrs'->>'resource_ref'=:old_ref)"""),
            params,
        )
        if deliberate:
            db.execute(
                sa.text("""INSERT INTO authored_source_stubs(account_id,source_ref,state)
                VALUES (:account,:new_ref,CAST(:state AS jsonb))"""),
                params,
            )
        else:
            db.execute(
                sa.text("""UPDATE authored_source_stubs SET source_ref=:new_ref,state=CAST(:state AS jsonb)
                WHERE account_id=:account AND source_ref=:old_ref"""),
                params,
            )
    op.execute("""UPDATE highlights h SET anchor_media_id=NULL FROM x_capture_map map
        JOIN highlight_fragment_anchors a ON a.fragment_id=map.fragment_id
        WHERE h.id=a.highlight_id AND h.anchor_media_id=map.media_id""")
    op.execute("""UPDATE passage_anchors p SET owner_scheme='fragment',owner_id=map.fragment_id
        FROM x_capture_map map WHERE p.owner_scheme='media' AND p.owner_id=map.media_id""")


def downgrade() -> None:
    raise RuntimeError("0324 is a hard cutover")
