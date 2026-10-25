"""Batched resource previews, complete primary annotations and the one viewer gate.

``_rows`` selects only what the viewer may see: it is the visibility verdict for items,
actions, writes (``visible_refs``) and prompt bodies (graph.resolve reads only refs it
admits; I2). SQL bounds previews except prefix context, whose tail needs full grapheme context. Annotations deliberately
carry full canonical bodies and their body-lane version from one statement. Live media
uses one canonical summary batch; narrow source attribution keeps its own projection.
One query per scheme, plus summary, source-credit and annotation batches, avoids
recursive reads. A media that disappears during summary hydration becomes unavailable
before routing, so neither its old title nor a live activation escapes.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Sequence
from typing import Any, assert_never, cast
from uuid import UUID

import regex
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import highlight_readability_sql, visible_media_ids_cte_sql
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.highlight_color import HighlightColor
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.resource_items import (
    ExcerptOut,
    ImagesResourceBodyOut,
    MediaResourceBodyOut,
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
from nexus.services.media import media_summaries
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items.locations import media_passages
from nexus.services.resource_items.routing import resource_activations_for_refs

_VISIBLE = f"({visible_media_ids_cte_sql()})"


def excerpt(value: str, limit: int = 600, *, tail: bool = False) -> ExcerptOut:
    """Codepoint budget, never bisect a grapheme. Flags describe removed text.

    Prefix iteration stops at the budget. Tails retain bounded spans but segment
    forward through the source: Unicode boundaries can depend on earlier text.
    """
    if len(value) <= limit:
        return ExcerptOut(text=value, truncated_before=False, truncated_after=False)
    if tail:
        # Skip whole grapheme blocks in the regex engine; only retain the final
        # two block starts. Their suffix covers the budget, even across a block boundary.
        previous = last = 0
        for block in regex.finditer(rf"(?:\X){{1,{max(1024, limit)}}}", value):
            previous, last = last, block.start()
        spans: deque[tuple[int, int]] = deque()
        size = 0
        for match in regex.finditer(r"\X", value, pos=previous):
            start, end = match.span()
            spans.append((start, end))
            size += end - start
            while size > limit and spans:
                first, last = spans.popleft()
                size -= last - first
        clipped = value[spans[0][0] :] if spans else ""
    else:
        return excerpt_window(value, start=0, limit=limit)[1]
    return ExcerptOut(
        text=_trim_excerpt(clipped, tail=tail),
        truncated_before=tail,
        truncated_after=not tail,
    )


def excerpt_window(value: str, *, start: int, limit: int = 600) -> tuple[int, ExcerptOut]:
    """A literal prefix window, aligned backward to the containing source grapheme.

    Return its actual source start for native match offsets. Forward block scanning
    preserves contextual boundaries without copying or retaining the source suffix.
    """
    assert 0 <= start <= len(value)
    if 0 < start < len(value):
        block_start = 0
        seek_end = start + 1
        for block in regex.finditer(r"(?:\X){1,1024}", value, endpos=seek_end):
            block_start = block.start()
            if block.end() >= start:
                break
        for match in regex.finditer(r"\X", value, pos=block_start, endpos=seek_end):
            if match.end() > start:
                start = match.start()
                break
    end = start
    # The extra codepoint makes any artificially ended cluster exceed the budget.
    for match in regex.finditer(r"\X", value, pos=start, endpos=min(len(value), start + limit + 1)):
        if match.end() - start > limit:
            break
        end = match.end()
    clipped = value[start:end]
    truncated = end < len(value)
    return start, ExcerptOut(
        text=_trim_excerpt(clipped, tail=False) if truncated else clipped,
        truncated_before=start > 0,
        truncated_after=truncated,
    )


def _trim_excerpt(clipped: str, *, tail: bool) -> str:
    # Skip word trimming when whitespace shares a grapheme with adjacent text.
    boundary = regex.search(r"\s+\S*$", clipped) if not tail else regex.search(r"^\S*\s+", clipped)
    if boundary is not None and len(clipped) > 32:
        cut = boundary.start() if not tail else boundary.end()
        candidate = clipped[:cut] if not tail else clipped[cut:]
        if len(candidate) >= len(clipped) // 2 and (
            cut == 0 or any(match.end() == cut for match in regex.finditer(r"\X", clipped))
        ):
            return candidate
    return clipped


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
    db: Session,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
    reading_media_id: UUID | None = None,
) -> list[ResourceItemOut]:
    rows = _rows(db, viewer_id, refs, reading_media_id=reading_media_id)
    summaries = media_summaries(
        db,
        viewer_id=viewer_id,
        media_ids=[ref.id for ref in refs if ref.scheme == "media" and ref.uri in rows],
    )
    for ref in refs:
        if ref.scheme == "media" and ref.id not in summaries:
            rows.pop(ref.uri, None)
    missing = {ref.uri for ref in refs if ref.uri not in rows}
    activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=refs,
        missing_ref_uris=missing,
        reading_media_id=reading_media_id,
    )
    owner_refs = [
        assert_resource_ref(uri)
        for uri in dict.fromkeys(row["owner_ref"] for row in rows.values() if row.get("owner_ref"))
    ]
    source_rows = {ref.uri: rows[ref.uri] for ref in owner_refs if ref.uri in rows}
    source_rows.update(_rows(db, viewer_id, [ref for ref in owner_refs if ref.uri not in rows]))
    named_refs = [ref for ref in refs if ref.scheme == "podcast" and ref.uri not in missing]
    credits = _credits(db, [*named_refs, *(ref for ref in owner_refs if ref.uri in source_rows)])
    source_activations = resource_activations_for_refs(
        db,
        viewer_id=viewer_id,
        refs=owner_refs,
        missing_ref_uris={ref.uri for ref in owner_refs if ref.uri not in source_rows},
    )
    sources = _source_attributions(owner_refs, source_rows, credits, source_activations)
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
                media_summary=summaries.get(ref.id) if ref.scheme == "media" else None,
                source=sources.get(row["owner_ref"]) if row and row.get("owner_ref") else None,
                annotation=annotations.get(ref.id),
                activation=activations[ref.uri],
                reading_media_id=reading_media_id,
            )
        )
    return out


def _resource_item_out(
    *,
    ref: ResourceRef,
    row: dict[str, Any] | None,
    credits: list[ContributorCreditOut] | None,
    media_summary: MediaSummaryOut | None,
    source: SourceAttributionOut | None,
    annotation: ResourceAnnotationOut | None,
    activation: ResourceActivationOut,
    reading_media_id: UUID | None,
) -> ResourceItemOut:
    body: ResourceBodyOut
    if row is None:
        body = NamedResourceBodyOut(
            title="Resource unavailable", image_url=None, media_kind=None, contributors=None
        )
        source = None
        label = "Resource unavailable"
        action_ref = ref.uri
    else:
        if ref.scheme == "media":
            assert media_summary is not None
            body = MediaResourceBodyOut(media_summary=media_summary)
        else:
            body = _body(row, credits)
        if source is not None and row.get("location_label"):
            source = source.model_copy(update={"location_label": row["location_label"]})
        label = _body_label(body)
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
            else row.get("owner_ref", ref.uri)
            if ref.scheme == "highlight" and reading_media_id is not None
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


def resource_item_out(
    db: Session, *, viewer_id: UUID, ref: ResourceRef, reading_media_id: UUID | None = None
) -> ResourceItemOut:
    return resource_items_out(
        db, viewer_id=viewer_id, refs=[ref], reading_media_id=reading_media_id
    )[0]


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
    return _source_attributions(refs, rows, credits, activations)


def _source_attributions(
    refs: Sequence[ResourceRef],
    rows: dict[str, dict[str, Any]],
    credits: dict[str, list[ContributorCreditOut]],
    activations: dict[str, ResourceActivationOut],
) -> dict[str, SourceAttributionOut]:
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
        title=row.get("title") or "Untitled",
        image_url=row.get("image_url"),
        media_kind=row.get("media_kind"),
        contributors=credits,
    )


def _body_label(body: ResourceBodyOut) -> str:
    match body.kind:
        case "media":
            return body.media_summary.title
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
        case _ as unreachable:
            assert_never(unreachable)


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


def _rows(
    db: Session,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
    *,
    reading_media_id: UUID | None = None,
) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for scheme in dict.fromkeys(ref.scheme for ref in refs):
        ids = list({ref.id for ref in refs if ref.scheme == scheme})
        for row in db.execute(
            text(_QUERIES[scheme]), {"ids": ids, "viewer_id": viewer_id}
        ).mappings():
            out[f"{scheme}:{row['id']}"] = dict(row)
    passages = media_passages(db, viewer_id=viewer_id, refs=refs, reading_media_id=reading_media_id)
    canonical_schemes = {
        "highlight",
        "fragment",
        "reader_apparatus_item",
        "content_chunk",
        "evidence_span",
        "oracle_passage_anchor",
        "passage_anchor",
    }
    for ref in refs:
        row = out.get(ref.uri)
        if ref.scheme in canonical_schemes and (
            ref.scheme
            in {"highlight", "fragment", "reader_apparatus_item", "oracle_passage_anchor"}
            or row is not None
            and str(row.get("owner_ref", "")).startswith("media:")
        ):
            out.pop(ref.uri, None)
        passage = passages.get(ref.uri)
        if passage is not None:
            out[ref.uri] = {
                "id": ref.id,
                "body_kind": "passage",
                "exact": passage.quote.exact,
                "prefix": passage.quote.prefix,
                "suffix": passage.quote.suffix,
                "color": passage.quote.color,
                "owner_ref": passage.owner.uri,
                "location_label": row.get("location_label") if row is not None else None,
            }
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
    "podcast": "SELECT id, title, image_url FROM podcasts WHERE id = ANY(:ids)",
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
    match body.kind:
        case "media":
            return body.media_summary.title
        case "passage":
            return body.exact.text
        case "prose":
            return body.excerpt.text
        case "named":
            return body.title
        case "reference":
            return body.label.text if body.label else ""
        case "images":
            return " ".join(alt.text for alt in body.alts if alt is not None)
        case _ as unreachable:
            assert_never(unreachable)
