"""Make ordinal citations source-owned and bind imported quote/embed occurrences.

After head 0332, stopped writers and a verified backup are required. Preserve old
citation ids, numbering, evidence and retrieval pointers; discard their unused
role by setting kind=context. Add literal-attribution and completion-proof nulls
to stored evidence. Backfilled completion keeps its original observations intact.
Backfill current proved source observations, never reconstruct an overwritten
article excerpt or retrieve provider data. Newly observed citations use the
database creation time. Rename the remote evidence lane without resetting it.
Unsupported ownership, numbering, references or snapshots abort the transaction.
"""

import json
import re
import unicodedata
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op

revision = "0333"
down_revision = "0332"
branch_labels = None
depends_on = None

_SCHEMES = {
    "media",
    "library",
    "evidence_span",
    "content_chunk",
    "highlight",
    "page",
    "note_block",
    "fragment",
    "conversation",
    "message",
    "oracle_reading",
    "oracle_passage_anchor",
    "external_snapshot",
    "contributor",
    "podcast",
    "reader_apparatus_item",
    "passage_anchor",
}


def _require(condition: bool, identity: str, problem: str) -> None:
    if not condition:
        raise RuntimeError(f"0333 refuses {identity}: {problem}")


def _ref(value: object, identity: str) -> None:
    if value is None:
        return
    _require(isinstance(value, str), identity, "invalid resource reference")
    scheme, separator, resource_id = value.partition(":")
    try:
        valid = (
            separator and scheme in _SCHEMES and str(UUID(resource_id)) == resource_id
        )
    except ValueError:
        valid = False
    _require(bool(valid), identity, "invalid resource reference")


def _evidence(value: object, identity: str) -> dict:
    _require(
        isinstance(value, dict) and set(value) == {"quote", "source", "target"},
        identity,
        "unsupported captured evidence",
    )
    source, target, quote = value["source"], value["target"], value["quote"]
    _require(
        isinstance(source, dict)
        and set(source)
        == {
            "ref",
            "title",
            "media_kind",
            "contributors",
            "location_label",
        },
        identity,
        "unsupported captured source",
    )
    _ref(source["ref"], identity)
    _require(
        isinstance(target, dict)
        and target.get("kind")
        in {
            "resource",
            "passage",
            "unavailable",
        },
        identity,
        "unsupported captured target",
    )
    _ref(target.get("owner_ref"), identity)
    expected_target = {"kind", "owner_ref", "field"}
    if target["kind"] == "passage":
        expected_target |= {"locator", "precision", "source_identity"}
        _require(
            isinstance(target.get("locator"), dict),
            identity,
            "missing captured locator",
        )
    _require(
        set(target) == expected_target, identity, "unsupported captured target fields"
    )
    _require(
        target["kind"] == "unavailable" or isinstance(target["owner_ref"], str),
        identity,
        "captured target lacks its owner",
    )
    _require(
        target["field"] is None
        or (
            target["field"] == "annotation"
            and isinstance(target["owner_ref"], str)
            and target["owner_ref"].startswith("highlight:")
        ),
        identity,
        "invalid captured field",
    )
    if quote is not None:
        _require(
            isinstance(quote, dict)
            and set(quote)
            == {
                "exact",
                "prefix",
                "suffix",
                "color",
                "excerpt",
            }
            and isinstance(quote["exact"], str)
            and isinstance(quote["excerpt"], dict),
            identity,
            "unsupported captured quote",
        )
    source["attribution_text"] = None
    value["completion_ref"] = None
    return value


def _captured_evidence(db, capture_id, revision_id: str) -> tuple[str, UUID, dict]:
    row = (
        db.execute(
            sa.text("""
        SELECT c.id,c.source_revision_id,c.payload,f.id AS fragment_id,f.canonical_text
        FROM x_post_captures c JOIN fragments f ON f.x_post_capture_id=c.id
        WHERE c.id=:id
    """),
            {"id": capture_id},
        )
        .mappings()
        .one_or_none()
    )
    identity = f"capture {capture_id}"
    _require(
        row is not None and row["source_revision_id"] == revision_id,
        identity,
        "capture does not prove the declared exact revision",
    )
    words, payload = row["canonical_text"], row["payload"]
    _require(
        isinstance(words, str) and isinstance(payload, dict),
        identity,
        "invalid capture",
    )
    credits, attribution = None, None
    if payload.get("kind") == "complete_post":
        content = payload.get("content", {})
        author = content.get("author")
        _require(
            isinstance(author, dict) and isinstance(author.get("name"), str),
            identity,
            "complete capture lacks its observed author",
        )
        literal = content.get("text")
        _require(
            isinstance(literal, str),
            identity,
            "complete capture lacks its literal body",
        )
        # Freeze the native renderer's text-only paragraph policy. Older fragments
        # may append generated URL/attachment labels; none are the post's words.
        body = "\n".join(
            re.sub(r"[\s\u00a0]+", " ", line).strip() for line in literal.splitlines()
        )
        body = re.sub(r"\n{3,}", "\n\n", unicodedata.normalize("NFC", body)).strip()
        _require(
            words.startswith(body),
            identity,
            "literal body differs from its fragment prefix",
        )
        words = body
        credits = [
            {
                "contributor_handle": None,
                "contributor_display_name": None,
                "href": None,
                "credited_name": author["name"],
                "role": "author",
                "raw_role": None,
                "ordinal": 0,
            }
        ]
    else:
        _require(
            payload.get("kind") == "article_excerpt",
            identity,
            "unsupported capture payload",
        )
        attribution = payload.get("attribution_text")
        _require(
            isinstance(attribution, str | None), identity, "invalid literal attribution"
        )
    owner = f"fragment:{row['fragment_id']}"
    quote = None
    target = {"kind": "resource", "owner_ref": owner, "field": None}
    if words:
        quote = {
            "exact": words,
            "prefix": None,
            "suffix": None,
            "color": None,
            "excerpt": {
                "structure": "unknown",
                "lang": None,
                "dir": None,
                "content": [{"kind": "text", "text": words}],
                "selection": {
                    "start": {"path": [0], "offset": 0},
                    "end": {"path": [0], "offset": len(words)},
                },
                "source_extent": None,
                "truncated_before": None,
                "truncated_after": None,
            },
        }
        target = {
            "kind": "passage",
            "owner_ref": owner,
            "field": None,
            "precision": "exact",
            "source_identity": str(capture_id),
            "locator": {
                "type": "x_capture_offsets",
                "capture_id": str(capture_id),
                "fragment_id": str(row["fragment_id"]),
                "start_offset": 0,
                "end_offset": len(words),
                "text_quote_selector": {"exact": words, "prefix": None, "suffix": None},
            },
        }
    return (
        "fragment",
        row["fragment_id"],
        {
            "quote": quote,
            "completion_ref": None,
            "source": {
                "ref": owner,
                "title": None,
                "media_kind": None,
                "contributors": credits,
                "attribution_text": attribution,
                "location_label": None,
            },
            "target": target,
        },
    )


def _insert_citation(
    db, *, source_scheme, source_id, ordinal, revision_id, capture_id, title=None
) -> UUID:
    _require(
        isinstance(revision_id, str)
        and re.fullmatch(r"[0-9]+", revision_id) is not None,
        f"source {source_scheme}:{source_id}",
        "invalid declared X revision",
    )
    if capture_id is not None:
        target_scheme, target_id, evidence = _captured_evidence(
            db, capture_id, revision_id
        )
        if title is not None:
            evidence["source"]["title"] = title
    else:
        target_scheme, target_id = "external_snapshot", uuid4()
        url = f"https://x.com/i/status/{revision_id}"
        db.execute(
            sa.text("""INSERT INTO resource_external_snapshots
            (id,user_id,provider,url,title,snippet) VALUES (:id,NULL,'x',:url,:title,'')"""),
            {"id": target_id, "url": url, "title": title or url},
        )
        target_ref = f"external_snapshot:{target_id}"
        evidence = {
            "quote": None,
            "completion_ref": None,
            "source": {
                "ref": target_ref,
                "title": title,
                "media_kind": None,
                "contributors": None,
                "attribution_text": None,
                "location_label": None,
            },
            "target": {"kind": "resource", "owner_ref": target_ref, "field": None},
        }
    edge_id = uuid4()
    db.execute(
        sa.text("""INSERT INTO resource_edges
        (id,user_id,kind,origin,source_scheme,source_id,target_scheme,target_id,ordinal,snapshot)
        VALUES (:id,NULL,'context','citation',:source_scheme,:source_id,:target_scheme,
                :target_id,:ordinal,CAST(:snapshot AS jsonb))"""),
        {
            "id": edge_id,
            "source_scheme": source_scheme,
            "source_id": source_id,
            "target_scheme": target_scheme,
            "target_id": target_id,
            "ordinal": ordinal,
            "snapshot": json.dumps(
                {"evidence": evidence, "rationale": None}, ensure_ascii=False
            ),
        },
    )
    return edge_id


def _live_edge(alias: str) -> str:
    endpoints = []
    for side in ("source", "target"):
        endpoints.append(f"""CASE {alias}.{side}_scheme
            WHEN 'note_block' THEN EXISTS (SELECT 1 FROM note_blocks n
                WHERE n.id={alias}.{side}_id AND n.authored_visible)
            WHEN 'page' THEN EXISTS (SELECT 1 FROM pages p
                WHERE p.id={alias}.{side}_id AND p.authored_visible)
            WHEN 'highlight' THEN EXISTS (SELECT 1 FROM highlights h
                WHERE h.id={alias}.{side}_id AND h.authored_visible)
            WHEN 'passage_anchor' THEN EXISTS (SELECT 1 FROM passage_anchors pa
                WHERE pa.id={alias}.{side}_id)
            ELSE TRUE END""")
    return f"({alias}.authored_visible AND ({endpoints[0]}) AND ({endpoints[1]}))"


_VISIBLE_MEDIA = """
    WITH RECURSIVE eligible AS (
        SELECT m.id FROM media m
        WHERE NOT EXISTS (SELECT 1 FROM user_media_deletions d
            WHERE d.media_id=m.id AND d.user_id=:viewer_id)
          AND NOT EXISTS (SELECT 1 FROM media_teardown_intents t WHERE t.media_id=m.id)
    ), reached(media_id) AS (
        SELECT roots.media_id FROM (
            SELECT le.media_id FROM library_entries le
            JOIN memberships ms ON ms.library_id=le.library_id
            WHERE ms.user_id=:viewer_id AND le.media_id IS NOT NULL
            UNION
            SELECT m.id FROM media m WHERE EXISTS (
                SELECT 1 FROM resource_grants g LEFT JOIN highlights h
                  ON g.subject_scheme='highlight' AND h.id=g.subject_id AND h.authored_visible
                WHERE ((g.subject_scheme='media' AND g.subject_id=m.id) OR h.anchor_media_id=m.id)
                  AND (g.grantee_user_id=:viewer_id OR g.created_by_user_id=:viewer_id))
        ) roots JOIN eligible ON eligible.id=roots.media_id
        UNION
        SELECT parts.media_id FROM reached
        JOIN media_parts parts ON parts.source_media_id=reached.media_id
        JOIN eligible ON eligible.id=parts.media_id
    ) SELECT media_id FROM reached
"""


def _authority_before_backfill(db) -> dict:
    """Freeze the 0332 authority graph before any imported citation gains evidence.

    Existing primary/article selections and admitted authored/generated evidence
    are roots. Their original admitted direct contexts add exactly one hop.
    Source-owned citations created below cannot manufacture their own witness.
    """
    capture_sql = f"""
        WITH visible_media AS ({_VISIBLE_MEDIA}), roots AS (
            SELECT xm.capture_id FROM x_post_media xm JOIN visible_media vm ON vm.media_id=xm.media_id
            UNION
            SELECT tp.capture_id FROM x_thread_posts tp JOIN visible_media vm ON vm.media_id=tp.thread_media_id
            UNION
            SELECT de.target_x_post_capture_id FROM document_embeds de
            JOIN visible_media vm ON vm.media_id=de.media_id
            WHERE de.provider='x' AND de.embed_kind='post' AND de.canonical_end_offset IS NOT NULL
              AND de.target_x_post_capture_id IS NOT NULL
            UNION
            SELECT f.x_post_capture_id FROM highlights h
            JOIN highlight_fragment_anchors a ON a.highlight_id=h.id
            JOIN fragments f ON f.id=a.fragment_id
            JOIN x_post_capture_admissions admission
              ON admission.capture_id=f.x_post_capture_id AND admission.user_id=:viewer_id
            WHERE h.authored_visible AND (h.user_id=:viewer_id OR EXISTS (
                SELECT 1 FROM resource_grants g WHERE g.subject_scheme='highlight' AND g.subject_id=h.id
                  AND (g.grantee_user_id=:viewer_id OR g.created_by_user_id=:viewer_id)))
            UNION
            SELECT f.x_post_capture_id FROM passage_anchors pa
            JOIN fragments f ON pa.owner_scheme='fragment' AND pa.owner_id=f.id
            JOIN x_post_capture_admissions admission
              ON admission.capture_id=f.x_post_capture_id AND admission.user_id=:viewer_id
            WHERE pa.user_id=:viewer_id AND EXISTS (
                SELECT 1 FROM resource_edges e WHERE e.user_id=pa.user_id AND {_live_edge("e")}
                  AND ((e.source_scheme='passage_anchor' AND e.source_id=pa.id)
                    OR (e.target_scheme='passage_anchor' AND e.target_id=pa.id)))
            UNION
            SELECT f.x_post_capture_id FROM message_retrievals r
            JOIN messages m ON m.id=r.assistant_message_id
            JOIN conversations c ON c.id=m.conversation_id
            JOIN fragments f ON f.id::text=r.locator->>'fragment_id'
            JOIN x_post_capture_admissions admission
              ON admission.capture_id=f.x_post_capture_id AND admission.user_id=:viewer_id
            WHERE c.owner_user_id=:viewer_id AND r.locator->>'type'='x_capture_offsets'
              AND r.locator->>'capture_id'=f.x_post_capture_id::text
            UNION
            SELECT f.x_post_capture_id FROM messages m
            JOIN conversations c ON c.id=m.conversation_id
            JOIN fragments f ON f.id::text=m.reader_selection_snapshot #>> '{{evidence,target,locator,fragment_id}}'
            JOIN x_post_capture_admissions admission
              ON admission.capture_id=f.x_post_capture_id AND admission.user_id=:viewer_id
            WHERE c.owner_user_id=:viewer_id
              AND m.reader_selection_snapshot #>> '{{evidence,target,locator,type}}'='x_capture_offsets'
              AND m.reader_selection_snapshot #>> '{{evidence,target,locator,capture_id}}'=f.x_post_capture_id::text
            UNION
            SELECT f.x_post_capture_id FROM resource_edges e
            JOIN fragments f ON f.id::text=e.snapshot #>> '{{evidence,target,locator,fragment_id}}'
            JOIN x_post_capture_admissions admission
              ON admission.capture_id=f.x_post_capture_id AND admission.user_id=:viewer_id
            WHERE e.user_id=:viewer_id AND e.origin='citation' AND {_live_edge("e")}
              AND e.snapshot #>> '{{evidence,target,locator,type}}'='x_capture_offsets'
              AND e.snapshot #>> '{{evidence,target,locator,capture_id}}'=f.x_post_capture_id::text
        ) SELECT capture_id FROM roots
        UNION
        SELECT context.target_capture_id FROM roots
        JOIN x_post_capture_contexts context ON context.capture_id=roots.capture_id
        JOIN x_post_capture_admissions admission
          ON admission.capture_id=context.target_capture_id AND admission.user_id=:viewer_id
        WHERE context.target_capture_id IS NOT NULL
    """
    return {
        user_id: (
            set(db.scalars(sa.text(_VISIBLE_MEDIA), {"viewer_id": user_id})),
            set(db.scalars(sa.text(capture_sql), {"viewer_id": user_id})),
        )
        for user_id in db.scalars(sa.text("SELECT id FROM users ORDER BY id"))
    }


def _complete_backfilled(db, authority: dict) -> None:
    """Complete only exact captures already independently readable before cutover."""
    candidates: dict[str, list[UUID]] = {}
    for row in db.execute(
        sa.text("""SELECT id,source_revision_id FROM x_post_captures
        WHERE payload->>'kind'='complete_post' ORDER BY created_at,id""")
    ).mappings():
        candidates.setdefault(row["source_revision_id"], []).append(row["id"])
    for row in db.execute(
        sa.text("""SELECT e.id,e.source_scheme,e.source_id,e.snapshot,
            f.x_post_capture_id AS source_capture_id,
            COALESCE(de.provider_target_ref,context.referenced_revision_id) AS revision_id
        FROM resource_edges e LEFT JOIN document_embeds de ON de.citation_id=e.id
        LEFT JOIN x_post_capture_contexts context ON context.citation_id=e.id
        LEFT JOIN fragments f ON e.source_scheme='fragment' AND f.id=e.source_id
        WHERE de.id IS NOT NULL OR context.id IS NOT NULL ORDER BY e.id""")
    ).mappings():
        readable = set()
        for media_ids, capture_ids in authority.values():
            source_visible = (
                row["source_scheme"] == "media" and row["source_id"] in media_ids
            ) or (
                row["source_scheme"] == "fragment"
                and row["source_capture_id"] in capture_ids
            )
            if source_visible:
                readable.update(capture_ids)
        capture_id = next(
            (
                candidate
                for candidate in candidates.get(row["revision_id"], ())
                if candidate in readable
            ),
            None,
        )
        if capture_id is None:
            continue
        _, _, observation = _captured_evidence(db, capture_id, row["revision_id"])
        snapshot = row["snapshot"]
        evidence = snapshot["evidence"]
        unknown_metadata = any(
            field != "ref" and evidence["source"][field] is None and value is not None
            for field, value in observation["source"].items()
        )
        unknown_body = evidence["target"]["owner_ref"].startswith("external_snapshot:")
        if unknown_body:
            _require(
                evidence["quote"] is None,
                f"citation {row['id']}",
                "uncaptured quote has words",
            )
        if unknown_body or unknown_metadata:
            evidence["completion_ref"] = observation["target"]["owner_ref"]
            db.execute(
                sa.text(
                    "UPDATE resource_edges SET snapshot=CAST(:snapshot AS jsonb) WHERE id=:id"
                ),
                {"id": row["id"], "snapshot": json.dumps(snapshot, ensure_ascii=False)},
            )


def upgrade() -> None:
    db = op.get_bind()
    authority = _authority_before_backfill(db)
    invalid = db.scalar(
        sa.text("""SELECT count(*) FROM resource_edges e
        LEFT JOIN messages m ON e.source_scheme='message' AND m.id=e.source_id
        LEFT JOIN conversations c ON c.id=m.conversation_id
        LEFT JOIN oracle_readings o ON e.source_scheme='oracle_reading' AND o.id=e.source_id
        WHERE e.ordinal IS NOT NULL AND (
            e.origin<>'citation' OR e.ordinal<1 OR e.source_order_key IS NOT NULL
            OR e.kind NOT IN ('context','supports','contradicts')
            OR (e.source_scheme='message' AND (m.id IS NULL OR c.owner_user_id<>e.user_id))
            OR (e.source_scheme='oracle_reading' AND (o.id IS NULL OR o.user_id<>e.user_id))
            OR e.source_scheme NOT IN ('message','oracle_reading'))""")
    )
    _require(
        invalid == 0, "existing citations", "invalid source ownership or ordinal shape"
    )
    invalid = db.scalar(
        sa.text("""SELECT count(*) FROM (
        SELECT source_scheme,source_id FROM resource_edges WHERE ordinal IS NOT NULL
        GROUP BY source_scheme,source_id
        HAVING min(ordinal)<>1 OR max(ordinal)<>count(*) OR count(DISTINCT ordinal)<>count(*)
    ) invalid""")
    )
    _require(
        invalid == 0,
        "existing citations",
        "source-local numbering is not dense and unique",
    )
    for table, column, nested, predicate in (
        (
            "messages",
            "reader_selection_snapshot",
            True,
            "reader_selection_snapshot IS NOT NULL",
        ),
        (
            "message_retrievals",
            "captured_evidence",
            False,
            "captured_evidence IS NOT NULL",
        ),
        ("resource_edges", "snapshot", True, "ordinal IS NOT NULL"),
    ):
        for row in db.execute(
            sa.text(
                f"SELECT id,{column} AS value FROM {table} WHERE {predicate} ORDER BY id"
            )
        ).mappings():
            identity, value = f"{table}:{row['id']}", row["value"]
            if nested:
                _require(
                    isinstance(value, dict) and isinstance(value.get("evidence"), dict),
                    identity,
                    "missing captured evidence",
                )
                if table == "resource_edges":
                    _require(
                        set(value) == {"evidence", "rationale"}
                        and value["rationale"] is None,
                        identity,
                        "citation carries a relationship rationale",
                    )
                else:
                    _require(
                        set(value) == {"evidence", "highlight_ref"},
                        identity,
                        "unsupported reader snapshot",
                    )
                    highlight_ref = value["highlight_ref"]
                    _ref(highlight_ref, identity)
                    _require(
                        highlight_ref is None or highlight_ref.startswith("highlight:"),
                        identity,
                        "reader snapshot has a non-highlight reference",
                    )
                value["evidence"] = _evidence(value["evidence"], identity)
            else:
                value = _evidence(value, identity)
            db.execute(
                sa.text(
                    f"UPDATE {table} SET {column}=CAST(:value AS jsonb) WHERE id=:id"
                ),
                {"id": row["id"], "value": json.dumps(value, ensure_ascii=False)},
            )
    op.drop_constraint(
        "ck_resource_edges_citation_shape", "resource_edges", type_="check"
    )
    op.alter_column("resource_edges", "user_id", nullable=True)
    op.alter_column("resource_external_snapshots", "user_id", nullable=True)
    op.drop_index("uq_resource_edges_citation_ordinal", table_name="resource_edges")
    db.execute(
        sa.text(
            "UPDATE resource_edges SET user_id=NULL,kind='context' WHERE ordinal IS NOT NULL"
        )
    )
    op.create_index(
        "uq_resource_edges_citation_ordinal",
        "resource_edges",
        ["source_scheme", "source_id", "ordinal"],
        unique=True,
        postgresql_where=sa.text("ordinal IS NOT NULL"),
    )
    for table in ("document_embeds", "x_post_capture_contexts"):
        op.add_column(table, sa.Column("citation_id", sa.Uuid(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_citation", table, "resource_edges", ["citation_id"], ["id"]
        )
        op.create_unique_constraint(f"uq_{table}_citation", table, ["citation_id"])

    for row in db.execute(
        sa.text("""SELECT context.id,context.referenced_revision_id,
            context.target_capture_id,f.id AS source_id,
            row_number() OVER (PARTITION BY context.capture_id ORDER BY context.ordinal,context.id) AS ordinal
        FROM x_post_capture_contexts context
        JOIN fragments f ON f.x_post_capture_id=context.capture_id
        WHERE context.relation='quoted' ORDER BY context.capture_id,context.ordinal,context.id
    """)
    ).mappings():
        edge_id = _insert_citation(
            db,
            source_scheme="fragment",
            source_id=row["source_id"],
            ordinal=row["ordinal"],
            revision_id=row["referenced_revision_id"],
            capture_id=row["target_capture_id"],
        )
        db.execute(
            sa.text(
                "UPDATE x_post_capture_contexts SET citation_id=:edge WHERE id=:id"
            ),
            {"edge": edge_id, "id": row["id"]},
        )
    for row in db.execute(
        sa.text("""SELECT de.*,
            row_number() OVER (PARTITION BY media_id ORDER BY ordinal,id) AS citation_ordinal
        FROM document_embeds de WHERE provider='x' AND embed_kind='post'
          AND provider_target_ref ~ '^[0-9]+$'
        ORDER BY media_id,ordinal,id""")
    ).mappings():
        edge_id = _insert_citation(
            db,
            source_scheme="media",
            source_id=row["media_id"],
            ordinal=row["citation_ordinal"],
            revision_id=row["provider_target_ref"],
            capture_id=row["target_x_post_capture_id"],
            title=row["title"],
        )
        db.execute(
            sa.text("UPDATE document_embeds SET citation_id=:edge WHERE id=:id"),
            {"edge": edge_id, "id": row["id"]},
        )

    _complete_backfilled(db, authority)

    # Remove only the converted embed facts. Other media embeds keep their graph rows.
    db.execute(
        sa.text("""DELETE FROM resource_view_states WHERE edge_id IN (
        SELECT e.id FROM resource_edges e JOIN document_embeds de
          ON e.source_scheme='media' AND e.source_id=de.media_id
         AND e.target_scheme='media' AND e.target_id=de.target_media_id
        WHERE e.origin='document_embed' AND de.citation_id IS NOT NULL)""")
    )
    db.execute(
        sa.text("""DELETE FROM resource_edges e USING document_embeds de
        WHERE e.origin='document_embed' AND e.source_scheme='media' AND e.source_id=de.media_id
          AND e.target_scheme='media' AND e.target_id=de.target_media_id
          AND de.citation_id IS NOT NULL""")
    )
    conflicts = db.scalar(
        sa.text("""SELECT count(*) FROM resource_versions old
        JOIN resource_versions present USING(user_id,resource_scheme,resource_id)
        WHERE old.lane='annotations' AND present.lane='evidence'""")
    )
    _require(
        conflicts == 0,
        "remote evidence lanes",
        "annotations/evidence ownership conflicts",
    )
    db.execute(
        sa.text("UPDATE resource_versions SET lane='evidence' WHERE lane='annotations'")
    )


def downgrade() -> None:
    raise RuntimeError(
        "Restore the verified pre-release backup and matching binaries to downgrade"
    )
