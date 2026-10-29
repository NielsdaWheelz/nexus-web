"""Frozen excerpt adapters. The shared kernel owns text, clipping and revisions."""

from collections.abc import Sequence
from typing import Any

from nexus.schemas.reader_excerpts import (
    ExcerptBody,
    ExcerptProjection,
    ExcerptTextParts,
    FrozenExcerpt,
)
from nexus.services.authored import helper


def plain_excerpt(
    exact: str, prefix: str | None = None, suffix: str | None = None
) -> FrozenExcerpt:
    before, after = prefix or "", suffix or ""
    return FrozenExcerpt.model_validate(
        {
            "structure": "plain",
            "lang": None,
            "dir": None,
            "content": [{"kind": "text", "text": before + exact + after}],
            "selection": {
                "start": {"path": [0], "offset": len(before)},
                "end": {"path": [0], "offset": len(before) + len(exact)},
            },
            "source_extent": None,
            "truncated_before": None,
            "truncated_after": None,
        }
    )


def project_excerpts(items: Sequence[dict[str, Any]]) -> list[ExcerptProjection]:
    """Bound helper envelopes, retaining input order without a process per row."""
    return [
        ExcerptProjection.model_validate(value)
        for value in helper.call_items("project_excerpts", list(items))
    ]


def read_captures(db: Any, refs: Sequence[str]) -> dict[str, dict[str, Any]]:
    """Canonical capture identity belongs to its author, including readable peer highlights."""
    from sqlalchemy import text

    return {
        row.ref: {"source_ref": row.source_ref, "capture": {"kind": row.kind, "value": row.capture}}
        for row in db.execute(
            text("""
        SELECT r.ref,r.state->>'source_ref' AS source_ref,'selection' AS kind,
               r.state #> '{selection,value}' AS capture
        FROM authored_resources r JOIN highlights h ON h.user_id=r.account_id
          AND r.ref='highlight:' || h.id::text
        WHERE r.ref=ANY(:refs) AND r.state->>'kind'='highlight'
        UNION ALL
        SELECT 'passage_anchor:' || p.anchor_id,p.state->>'source_ref','passage',
               p.state #> '{capture,value}'
        FROM authored_passages p JOIN passage_anchors a ON a.user_id=p.account_id
          AND a.id::text=p.anchor_id WHERE 'passage_anchor:' || p.anchor_id=ANY(:refs)
    """),
            {"refs": list(refs)},
        )
    }


def text_parts(bodies: Sequence[ExcerptBody]) -> list[ExcerptTextParts]:
    return [
        ExcerptTextParts.model_validate(value)
        for value in helper.call_items(
            "excerpt_text_parts", [body.model_dump(mode="json") for body in bodies]
        )
    ]


def quote_parts(quote: Any) -> ExcerptTextParts:
    """Literal full text for already admitted immutable quote snapshots."""
    body = ExcerptBody.model_validate(
        quote.excerpt.model_dump(exclude={"source_extent", "truncated_before", "truncated_after"})
    )
    return text_parts([body])[0]


def contains_table(excerpt: FrozenExcerpt) -> bool:
    def walk(nodes: Sequence[Any]) -> bool:
        return any(
            node.kind == "table" or hasattr(node, "children") and walk(node.children)
            for node in nodes
        )

    return walk(excerpt.content)


def scope_excerpts(
    items: Sequence[dict[str, Any]],
    *,
    incomplete_tables: Sequence[Sequence[tuple[int, int]]] | None = None,
) -> list[FrozenExcerpt | None]:
    if not items:
        return []
    output = [
        None if value is None else FrozenExcerpt.model_validate(value)
        for value in helper.call_items("scope_excerpts", list(items))
    ]
    if incomplete_tables is not None:
        for index, (excerpt, intervals) in enumerate(zip(output, incomplete_tables, strict=True)):
            if excerpt is None or not contains_table(excerpt) or excerpt.source_extent is None:
                continue
            extent = excerpt.source_extent
            if any(
                left < extent.end_offset
                and right > extent.start_offset
                or left == right
                and extent.start_offset <= left <= extent.end_offset
                for left, right in intervals
            ):
                output[index] = None
    return output
