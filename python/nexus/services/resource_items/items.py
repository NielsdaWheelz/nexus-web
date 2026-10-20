"""Batched resource previews, complete primary annotations and the one viewer gate.

``_rows`` selects only what the viewer may see: it is the visibility verdict for items,
actions, writes (``visible_refs``) and prompt bodies (graph.resolve reads only refs it
admits; I2). SQL bounds previews before they leave the database. Annotations deliberately
carry full canonical bodies and their body-lane version from one statement. One query
per scheme, plus source-credit and annotation batches, avoids recursive reads.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, cast
from uuid import UUID

import regex
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import highlight_readability_sql, visible_media_ids_cte_sql
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.highlight_color import HighlightColor
from nexus.schemas.resource_items import (
    ExcerptOut,
    ImagesResourceBodyOut,
    NamedResourceBodyOut,
    PassageResourceBodyOut,
    ProseResourceBodyOut,
    ReferenceResourceBodyOut,
    ResourceActivationOut,
    ResourceAnnotationOut,
    ResourceBodyOut,
    ResourceItemOut,
    ResourcePreviewOut,
    SourceAttributionOut,
)
from nexus.services.contributor_credits import (
    load_contributor_credits_for_media,
    load_contributor_credits_for_podcasts,
)
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items.routing import resource_activations_for_refs

_VISIBLE = f"({visible_media_ids_cte_sql()})"


def excerpt(value: str, limit: int = 600, *, tail: bool = False) -> ExcerptOut:
    """Codepoint budget, never bisect a grapheme. Flags describe removed text."""
    if len(value) <= limit:
        return ExcerptOut(text=value, truncated_before=False, truncated_after=False)
    clusters = regex.findall(r"\X", value)
    kept: list[str] = []
    size = 0
    for cluster in reversed(clusters) if tail else clusters:
        if size + len(cluster) > limit:
            break
        kept.append(cluster)
        size += len(cluster)
    clipped = "".join(reversed(kept) if tail else kept)
    boundary = regex.search(r"\s+\S*$", clipped) if not tail else regex.search(r"^\S*\s+", clipped)
    if boundary is not None and len(clipped) > 32:
        candidate = clipped[: boundary.start()] if not tail else clipped[boundary.end() :]
        if len(candidate) >= len(clipped) // 2:
            clipped = candidate
    return ExcerptOut(
        text=clipped,
        truncated_before=tail,
        truncated_after=not tail,
    )


def passage_body(
    exact: str,
    prefix: str | None = None,
    suffix: str | None = None,
    color: HighlightColor | None = None,
    *,
    limit: int = 600,
) -> PassageResourceBodyOut:
    selection = excerpt(exact, limit)
    return PassageResourceBodyOut(
        exact=selection,
        prefix=excerpt(prefix, 48, tail=True) if prefix else None,
        suffix=excerpt(suffix, 48) if suffix and not selection.truncated_after else None,
        color=color,
    )


def passage_label(selection: ExcerptOut) -> str:
    """The resource label for an already-bounded passage excerpt."""
    return selection.text[:120] or "Passage"


def resource_items_out(
    db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]
) -> list[ResourceItemOut]:
    rows = _rows(db, viewer_id, refs)
    missing = {ref.uri for ref in refs if ref.uri not in rows}
    activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=refs,
        missing_ref_uris=missing,
    )
    owner_refs = list({row["owner_ref"] for row in rows.values() if row.get("owner_ref")})
    sources = source_attributions(
        db, viewer_id=viewer_id, refs=[assert_resource_ref(r) for r in owner_refs]
    )
    named_refs = [
        ref for ref in refs if ref.scheme in ("media", "podcast") and ref.uri not in missing
    ]
    credits = _credits(db, named_refs)
    annotations = _annotations(
        db,
        viewer_id,
        [ref.id for ref in refs if ref.scheme == "highlight" and ref.uri not in missing],
    )
    out: list[ResourceItemOut] = []
    for ref in refs:
        row = rows.get(ref.uri)
        out.append(
            _resource_item_out(
                ref=ref,
                row=row,
                credits=credits.get(ref.uri),
                source=sources.get(row["owner_ref"]) if row and row.get("owner_ref") else None,
                annotation=annotations.get(ref.id),
                activation=activations[ref.uri],
            )
        )
    return out


def _resource_item_out(
    *,
    ref: ResourceRef,
    row: dict[str, Any] | None,
    credits: list[ContributorCreditOut] | None,
    source: SourceAttributionOut | None,
    annotation: ResourceAnnotationOut | None,
    activation: ResourceActivationOut,
) -> ResourceItemOut:
    body: ResourceBodyOut
    if row is None:
        body = NamedResourceBodyOut(
            title="Resource unavailable", media_kind=None, contributors=None
        )
        source = None
        label = "Resource unavailable"
        action_ref = ref.uri
    else:
        body = _body(row, credits)
        if source is not None and row.get("location_label"):
            source = source.model_copy(update={"location_label": row["location_label"]})
        label = row.get("title") or _body_label(body)
        action_ref = (
            (row.get("owner_ref") or ref.uri)
            if ref.scheme
            in (
                "fragment",
                "content_chunk",
                "evidence_span",
                "reader_apparatus_item",
                "oracle_passage_anchor",
            )
            else ref.uri
        )
    return ResourceItemOut(
        ref=ref.uri,
        action_ref=action_ref,
        label=label,
        preview=ResourcePreviewOut(body=body, source=source, annotation=annotation),
        activation=activation,
        missing=row is None,
    )


def resource_item_out(db: Session, *, viewer_id: UUID, ref: ResourceRef) -> ResourceItemOut:
    return resource_items_out(db, viewer_id=viewer_id, refs=[ref])[0]


def visible_refs(db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]) -> set[str]:
    """The uris of ``refs`` the viewer may see now."""
    return set(_rows(db, viewer_id, refs))


def source_attributions(
    db: Session, *, viewer_id: UUID, refs: Sequence[ResourceRef]
) -> dict[str, SourceAttributionOut]:
    """Known current source metadata, only after the same viewer gate as resource rows."""
    rows = _rows(db, viewer_id, refs)
    credits = _credits(db, [r for r in refs if r.uri in rows])
    activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=refs,
        missing_ref_uris={r.uri for r in refs if r.uri not in rows},
    )
    return {
        ref.uri: SourceAttributionOut(
            ref=ref.uri,
            title=row.get("title") or _body_label(_body(row, None)),
            media_kind=row.get("media_kind"),
            contributors=credits.get(ref.uri),
            location_label=None,
            activation=activations[ref.uri],
        )
        for ref in refs
        if (row := rows.get(ref.uri)) is not None
    }


def _credits(db: Session, refs: Sequence[ResourceRef]) -> dict[str, list[ContributorCreditOut]]:
    return {
        f"{scheme}:{id_}": values
        for scheme, loader in (
            ("media", load_contributor_credits_for_media),
            ("podcast", load_contributor_credits_for_podcasts),
        )
        for id_, values in loader(
            db, list({ref.id for ref in refs if ref.scheme == scheme})
        ).items()
    }


def _body(
    row: dict[str, Any], credits: list[ContributorCreditOut] | None, limit: int = 600
) -> ResourceBodyOut:
    kind = row.get("body_kind", "named")
    if kind == "passage":
        return passage_body(
            row.get("exact") or "",
            row.get("prefix"),
            row.get("suffix"),
            cast(HighlightColor | None, row.get("color")),
            limit=limit,
        )
    if kind == "note":
        if row["note_kind"] == "object_embed":
            return ReferenceResourceBodyOut(
                target_ref=row["embed_ref"],
                label=excerpt(row["embed_label"], limit) if row.get("embed_label") else None,
            )
        prose = row.get("prose") or ""
        images = row.get("image_count", 0)
        if not prose and images:
            budget = limit
            alts: list[ExcerptOut | None] = []
            for alt in row.get("image_alts") or []:
                value = excerpt(alt, budget) if alt else None
                alts.append(value)
                budget -= len(value.text) if value else 0
            return ImagesResourceBodyOut(count=images, alts=alts)
        return ProseResourceBodyOut(
            excerpt=excerpt(prose, limit),
            role=None,
            format="code" if row["note_kind"] == "code_block" else "plain",
            image_count=images,
        )
    if kind == "prose":
        return ProseResourceBodyOut(
            excerpt=excerpt(row.get("prose") or "", limit),
            role=row.get("role"),
            format="plain",
            image_count=0,
        )
    return NamedResourceBodyOut(
        title=row.get("title") or "Untitled", media_kind=row.get("media_kind"), contributors=credits
    )


def _body_label(body: ResourceBodyOut) -> str:
    match body.kind:
        case "named":
            return body.title
        case "passage":
            return passage_label(body.exact)
        case "prose":
            return body.excerpt.text[:120] or "Note"
        case "images":
            return "Image" if body.count == 1 else f"{body.count} images"
        case "reference":
            return body.label.text if body.label else "Embedded resource"


def _annotations(
    db: Session, viewer_id: UUID, ids: list[UUID]
) -> dict[UUID, ResourceAnnotationOut]:
    if not ids:
        return {}
    rows = (
        db.execute(
            text("""
        SELECT DISTINCT ON (e.source_id) e.source_id, e.id AS attachment_edge_id,
               n.id AS note_id, n.body_pm_json, n.body_text, COALESCE(v.version, 1) AS body_version
        FROM resource_edges e JOIN note_blocks n ON n.id = e.target_id AND n.user_id = :viewer_id
        LEFT JOIN resource_versions v ON v.user_id = :viewer_id
          AND v.resource_scheme = 'note_block' AND v.resource_id = n.id AND v.lane = 'body'
        WHERE e.user_id = :viewer_id AND e.source_scheme = 'highlight'
          AND e.source_id = ANY(:ids) AND e.target_scheme = 'note_block' AND e.origin = 'highlight_note'
        ORDER BY e.source_id, e.created_at, e.id, n.id
    """),
            {"viewer_id": viewer_id, "ids": ids},
        )
        .mappings()
        .all()
    )
    activations = resource_activations_for_refs(
        db, viewer_id=viewer_id, refs=[ResourceRef("note_block", row["note_id"]) for row in rows]
    )
    return {
        row["source_id"]: ResourceAnnotationOut(
            attachment_edge_id=row["attachment_edge_id"],
            note_ref=f"note_block:{row['note_id']}",
            body_pm_json=row["body_pm_json"],
            body_text=row["body_text"],
            body_version=row["body_version"],
            activation=activations[f"note_block:{row['note_id']}"],
        )
        for row in rows
    }


def _rows(db: Session, viewer_id: UUID, refs: Sequence[ResourceRef]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for scheme in dict.fromkeys(ref.scheme for ref in refs):
        ids = list({ref.id for ref in refs if ref.scheme == scheme})
        if scheme in ("artifact", "artifact_revision"):
            from nexus.services.dossier.subjects import head_visible_sql

            key = "id" if scheme == "artifact" else "revision_id"
            sql = f"""SELECT a.{key} AS id, 'Dossier — ' || COALESCE(m.title,c.title,CASE WHEN l.is_default THEN 'All' ELSE l.name END,p.title,co.display_name,pg.title,idea.display_title,'Note') AS title
                FROM artifacts a LEFT JOIN media m ON a.subject_scheme='media' AND m.id=a.subject_id
                LEFT JOIN conversations c ON a.subject_scheme='conversation' AND c.id=a.subject_id
                LEFT JOIN libraries l ON a.subject_scheme='library' AND l.id=a.subject_id
                LEFT JOIN podcasts p ON a.subject_scheme='podcast' AND p.id=a.subject_id
                LEFT JOIN contributors co ON a.subject_scheme='contributor' AND co.id=a.subject_id
                LEFT JOIN pages pg ON a.subject_scheme='page' AND pg.id=a.subject_id
                LEFT JOIN artifact_idea_subjects idea ON a.subject_scheme='idea' AND idea.id=a.subject_id
                WHERE a.{key} = ANY(:ids) AND {head_visible_sql("a")}"""
        else:
            sql = _QUERIES[scheme]
        for row in db.execute(text(sql), {"ids": ids, "viewer_id": viewer_id}).mappings():
            out[f"{scheme}:{row['id']}"] = dict(row)
    return out


_NOTE_PARTS_SQL = """
    SELECT string_agg(CASE child->>'type' WHEN 'text' THEN child->>'text' WHEN 'hard_break' THEN E'\\n' ELSE '' END, '' ORDER BY ordinal) AS prose,
           count(*) FILTER (WHERE child->>'type' = 'image') AS image_count,
           (array_agg(left(child #>> '{attrs,alt}', 601) ORDER BY ordinal) FILTER (WHERE child->>'type' = 'image'))[1:3] AS image_alts
    FROM jsonb_array_elements(COALESCE(n.body_pm_json->'content', '[]'::jsonb)) WITH ORDINALITY t(child, ordinal)
"""


def note_display_texts(
    db: Session, *, viewer_id: UUID, note_ids: Sequence[UUID]
) -> dict[UUID, str]:
    """Literal note text for a search-centered excerpt; canonical offsets remain body_text."""
    if not note_ids:
        return {}
    return {
        id_: words
        for id_, words in db.execute(
            text(
                f"SELECT n.id, COALESCE(parts.prose, '') FROM note_blocks n LEFT JOIN LATERAL ({_NOTE_PARTS_SQL}) parts ON TRUE WHERE n.id=ANY(:ids) AND n.user_id=:viewer_id"
            ),
            {"ids": list(note_ids), "viewer_id": viewer_id},
        )
    }


_NOTE_SQL = f"""
SELECT n.id, 'note' AS body_kind, n.body_pm_json->>'type' AS note_kind,
       left(COALESCE(parts.prose, ''), 601) AS prose, COALESCE(parts.image_count, 0) AS image_count,
       parts.image_alts,
       concat(n.body_pm_json #>> '{{attrs,objectType}}', ':', n.body_pm_json #>> '{{attrs,objectId}}') AS embed_ref,
       left(n.body_pm_json #>> '{{attrs,label}}', 601) AS embed_label
FROM note_blocks n LEFT JOIN LATERAL ({_NOTE_PARTS_SQL}) parts ON TRUE WHERE n.id = ANY(:ids) AND n.user_id = :viewer_id
"""

_QUERIES = {
    "media": f"SELECT id, title, kind AS media_kind FROM media WHERE id = ANY(:ids) AND id IN {_VISIBLE}",
    "library": "SELECT l.id, CASE WHEN l.is_default THEN 'All' ELSE l.name END AS title FROM libraries l WHERE l.id = ANY(:ids) AND EXISTS (SELECT 1 FROM memberships ms WHERE ms.library_id = l.id AND ms.user_id = :viewer_id)",
    "page": "SELECT id, title FROM pages WHERE id = ANY(:ids) AND user_id = :viewer_id",
    "note_block": _NOTE_SQL,
    "conversation": "SELECT id, COALESCE(NULLIF(title, ''), 'Untitled conversation') AS title FROM conversations WHERE id = ANY(:ids) AND owner_user_id = :viewer_id",
    "message": "SELECT m.id, 'prose' AS body_kind, left(m.content, 601) AS prose, m.role, 'conversation:' || c.id AS owner_ref FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.owner_user_id = :viewer_id WHERE m.id = ANY(:ids) AND m.status != 'pending'",
    "podcast": "SELECT id, title FROM podcasts WHERE id = ANY(:ids)",
    "contributor": "SELECT id, display_name AS title FROM contributors WHERE id = ANY(:ids)",
    "external_snapshot": "SELECT id, title FROM resource_external_snapshots WHERE id = ANY(:ids) AND user_id = :viewer_id",
    "oracle_reading": "SELECT id, left(question_text, 601) AS title FROM oracle_readings WHERE id = ANY(:ids) AND user_id = :viewer_id",
    "highlight": f"SELECT h.id, 'passage' AS body_kind, left(h.exact,601) AS exact, right(h.prefix,49) AS prefix, left(h.suffix,49) AS suffix, h.color, 'media:' || h.anchor_media_id AS owner_ref FROM highlights h WHERE h.id = ANY(:ids) AND {highlight_readability_sql('h')}",
    "fragment": f"SELECT id, 'passage' AS body_kind, left(canonical_text,601) AS exact, 'media:' || media_id AS owner_ref FROM fragments WHERE id = ANY(:ids) AND media_id IN {_VISIBLE}",
    "passage_anchor": "SELECT id, 'passage' AS body_kind, left(selector #>> '{quote,exact}',601) AS exact, right(selector #>> '{quote,prefix}',49) AS prefix, left(selector #>> '{quote,suffix}',49) AS suffix, owner_scheme || ':' || owner_id AS owner_ref FROM passage_anchors WHERE id = ANY(:ids) AND user_id = :viewer_id",
    "reader_apparatus_item": f"SELECT t.id, 'passage' AS body_kind, left(COALESCE(t.body_text,t.label,''),601) AS exact, t.label AS location_label, 'media:' || t.media_id AS owner_ref FROM reader_apparatus_items t JOIN reader_apparatus_states s ON s.id = t.state_id WHERE t.id = ANY(:ids) AND s.status IN ('ready','partial') AND t.media_id IN {_VISIBLE}",
    "oracle_passage_anchor": "SELECT a.id, 'passage' AS body_kind, left(a.quote,601) AS exact, a.display_label AS location_label, 'media:' || s.media_id AS owner_ref FROM oracle_passage_anchors a JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id WHERE a.id = ANY(:ids)",
}
for _scheme, _table, _body_column in (
    ("evidence_span", "evidence_spans", "span_text"),
    ("content_chunk", "content_chunks", "chunk_text"),
):
    _QUERIES[
        _scheme
    ] = f"""SELECT t.id, 'passage' AS body_kind, left(t.{_body_column},601) AS exact,
        t.owner_kind || ':' || t.owner_id AS owner_ref
        FROM {_table} t LEFT JOIN note_blocks nb ON nb.id = t.owner_id AND t.owner_kind = 'note_block'
        WHERE t.id = ANY(:ids) AND ((t.owner_kind = 'media' AND t.owner_id IN {_VISIBLE})
          OR (t.owner_kind = 'note_block' AND nb.user_id = :viewer_id))"""


def preview_text(item: ResourceItemOut) -> str:
    """Plain text for narrow consumers such as marker tooltips and tool summaries."""
    body = item.preview.body
    if body.kind == "passage":
        return body.exact.text
    if body.kind == "prose":
        return body.excerpt.text
    if body.kind == "named":
        return body.title
    if body.kind == "reference":
        return body.label.text if body.label else ""
    return " ".join(alt.text for alt in body.alts if alt is not None)
