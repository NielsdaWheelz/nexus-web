"""Exact keyword occurrence publication in the canonical writer's transaction.

Canonical owners retain permissions, revisions, worker fences and whole-attempt
serializable retries. Refresh derives complete scalar text from canonical rows;
missing identities withdraw old occurrences. Explicit withdrawal removes known
deleted identities without reading canonical sources. Both replace absolute values
in the caller's transaction and never commit. search_id is a private numeric index
key, while doc_key preserves canonical occurrence identity.
"""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.contributor_credits import (
    contributor_credits_rollup_cte_sql,
    contributor_fts_text_sql,
)
from nexus.services.resource_graph.refs import ResourceRef

TABLE = "keyword_occurrences"
_BATCH = 256
ANALYZER = {
    "type": "default",
    "stemmer": "English",
    "stopwords_language": ["English"],
}
TEXT_FIELDS = (
    "title",
    "body",
    "description",
    "publisher",
    "contributors",
    "prefix",
    "suffix",
    "url",
    "kind",
    "motto",
    "interpretation",
    "subject_title",
)
_COLUMNS = (
    "doc_key",
    "ref",
    "owner_ref",
    "family",
    "admission_key",
    "source_revision",
    "name",
    "discovery_name",
    *TEXT_FIELDS,
)
_FAMILIES = (
    "media",
    "podcast",
    "contributor",
    "page",
    "note_block",
    "highlight",
    "conversation",
    "message",
    "reader_apparatus_item",
    "fragment",
    "content_chunk",
    "web_result",
    "library",
    "oracle_reading",
    "dossier",
    "passage_anchor",
)
_SOURCE_IDS: dict[str, str] = {}


def _source(
    family: str,
    relation: str,
    *,
    identity: str,
    fields: dict[str, str],
    owner: str | None = None,
    name: str = "NULL::text",
    discovery_name: str = "NULL::text",
    revision: str = "NULL::bigint",
    admission: str | None = None,
    where: str = "TRUE",
) -> str:
    """The shared twelve-column shape hides only repetitive nullable SQL slots."""
    assert fields.keys() <= set(TEXT_FIELDS)
    _SOURCE_IDS[family] = identity
    scheme = {"dossier": "artifact", "web_result": "external_snapshot"}.get(family, family)
    ref = f"'{scheme}:' || ({identity})::text"
    key = (
        f"'contributor:' || CAST(:projection_viewer_id AS text) || ':' || ({identity})::text"
        if family == "contributor"
        else ref
    )
    columns = [
        f"{key} AS doc_key",
        f"{ref} AS ref",
        f"{owner or ref} AS owner_ref",
        f"'{family}'::text AS family",
        f"{admission or key} AS admission_key",
        f"{revision} AS source_revision",
        f"{name} AS name",
        f"{discovery_name} AS discovery_name",
        *(f"{fields.get(field, 'NULL::text')} AS {field}" for field in TEXT_FIELDS),
    ]
    return "SELECT " + ", ".join(columns) + f" FROM {relation} WHERE {where} /*identity_filter*/"


_SOURCES = {
    "media": _source(
        "media",
        "media m LEFT JOIN ("
        + contributor_credits_rollup_cte_sql("media_id")
        + ") credits ON credits.media_id=m.id",
        identity="m.id",
        name="m.title",
        fields={
            "title": "m.title",
            "description": "m.description",
            "publisher": "m.publisher",
            "contributors": "credits.contributor_search_text",
        },
    ),
    "podcast": _source(
        "podcast",
        "podcasts p LEFT JOIN ("
        + contributor_credits_rollup_cte_sql("podcast_id")
        + ") credits ON credits.podcast_id=p.id",
        identity="p.id",
        name="p.title",
        fields={
            "title": "p.title",
            "description": "p.description",
            "contributors": "credits.contributor_search_text",
        },
    ),
    "contributor": _source(
        "contributor",
        "contributors c JOIN (" + contributor_fts_text_sql() + ") fts ON fts.contributor_id=c.id",
        identity="c.id",
        name="c.display_name",
        fields={"contributors": "fts.search_text"},
    ),
    "page": _source(
        "page", "pages p", identity="p.id", name="p.title", fields={"title": "p.title"}
    ),
    "note_block": _source(
        "note_block",
        "note_blocks n LEFT JOIN resource_versions v ON v.user_id=n.user_id AND v.resource_scheme='note_block' AND v.resource_id=n.id AND v.lane='body'",
        identity="n.id",
        revision="COALESCE(v.version,1)",
        admission="'note_block:' || n.id::text || ':' || COALESCE(v.version,1)::text",
        fields={"body": "n.body_text"},
        where="n.body_text<>''",
    ),
    "highlight": _source(
        "highlight",
        "highlights h",
        identity="h.id",
        fields={"body": "h.exact", "prefix": "h.prefix", "suffix": "h.suffix"},
    ),
    "conversation": _source(
        "conversation",
        "conversations c",
        identity="c.id",
        name="c.title",
        fields={"title": "c.title"},
    ),
    "message": _source(
        "message",
        "messages m",
        identity="m.id",
        owner="'conversation:' || m.conversation_id::text",
        fields={"body": "m.content"},
        where="m.status='complete' AND m.content<>''",
    ),
    "reader_apparatus_item": _source(
        "reader_apparatus_item",
        "reader_apparatus_items i JOIN reader_apparatus_states s ON s.id=i.state_id",
        identity="i.id",
        owner="'media:' || i.media_id::text",
        admission="'reader_apparatus_item:' || i.media_id::text",
        fields={"title": "i.label", "kind": "i.kind", "body": "i.body_text"},
        where="s.status IN ('ready','partial')",
    ),
    "fragment": _source(
        "fragment",
        "fragments f JOIN media m ON m.id=f.media_id",
        identity="f.id",
        owner="'media:' || f.media_id::text",
        admission="'fragment:' || f.media_id::text",
        fields={"body": "f.canonical_text"},
        where="f.canonical_text<>'' AND CASE WHEN f.t_start_ms IS NOT NULL AND f.t_end_ms IS NOT NULL THEN 0<=f.t_start_ms AND f.t_start_ms<f.t_end_ms ELSE m.kind<>'pdf' END",
    ),
    "content_chunk": _source(
        "content_chunk",
        "content_chunks c JOIN content_index_states s ON s.owner_kind=c.owner_kind AND s.owner_id=c.owner_id",
        identity="c.id",
        owner="'media:' || c.owner_id::text",
        revision="s.lexical_revision",
        admission="'content_chunk:' || c.owner_id::text || ':' || s.lexical_revision::text",
        fields={"body": "c.chunk_text"},
        where="c.owner_kind='media' AND c.primary_evidence_span_id IS NOT NULL AND c.chunk_text<>'' AND s.lexical_revision IS NOT NULL",
    ),
    "web_result": _source(
        "web_result",
        "resource_external_snapshots s",
        identity="s.id",
        name="s.title",
        fields={"title": "s.title", "url": "s.url", "body": "s.snippet"},
    ),
    "library": _source(
        "library",
        "libraries l",
        identity="l.id",
        name="CASE WHEN l.is_default THEN 'All' ELSE l.name END",
        fields={"title": "CASE WHEN l.is_default THEN 'All' ELSE l.name END"},
    ),
    "oracle_reading": _source(
        "oracle_reading",
        "oracle_readings r",
        identity="r.id",
        name="r.question_text",
        fields={
            "title": "r.question_text",
            "motto": "r.folio_motto",
            "interpretation": "r.interpretation_text",
        },
    ),
    "dossier": _source(
        "dossier",
        """artifacts a
            LEFT JOIN media sm ON a.subject_scheme='media' AND sm.id=a.subject_id
            LEFT JOIN conversations sc ON a.subject_scheme='conversation' AND sc.id=a.subject_id
            LEFT JOIN libraries sl ON a.subject_scheme='library' AND sl.id=a.subject_id
            LEFT JOIN podcasts sp ON a.subject_scheme='podcast' AND sp.id=a.subject_id
            LEFT JOIN contributors so ON a.subject_scheme='contributor' AND so.id=a.subject_id
            LEFT JOIN pages sg ON a.subject_scheme='page' AND sg.id=a.subject_id
            LEFT JOIN note_blocks sn ON a.subject_scheme='note_block' AND sn.id=a.subject_id
            LEFT JOIN artifact_idea_subjects si ON a.subject_scheme='idea' AND si.id=a.subject_id
            CROSS JOIN LATERAL (SELECT COALESCE(sm.title,sc.title,CASE WHEN sl.is_default THEN 'All' ELSE sl.name END,sp.title,so.display_name,sg.title,sn.body_text,si.display_title,'Dossier') AS title) subject""",
        identity="a.id",
        name="subject.title",
        discovery_name="'Dossier — ' || COALESCE(sm.title,sc.title,CASE WHEN sl.is_default THEN 'All' ELSE sl.name END,sp.title,so.display_name,sg.title,si.display_title)",
        fields={"subject_title": "subject.title", "body": "a.content_text"},
    ),
    "passage_anchor": _source(
        "passage_anchor",
        "passage_anchors p",
        identity="p.id",
        fields={"body": "p.selector#>>'{quote,exact}'"},
        where="COALESCE(p.selector#>>'{quote,exact}','')<>''",
    ),
}


def _withdraw_batch(
    db: Session, family: str, identities: Sequence[UUID], *, viewer_id: UUID | None
) -> None:
    scheme = {"dossier": "artifact", "web_result": "external_snapshot"}.get(family, family)
    refs = [f"{scheme}:{identity}" for identity in identities]
    keys = (
        [f"contributor:{viewer_id}:{identity}" for identity in identities]
        if family == "contributor"
        else refs
    )
    db.execute(text(f"DELETE FROM {TABLE} WHERE doc_key=ANY(:keys)"), {"keys": keys})


def withdraw(
    db: Session, family: str, identities: Sequence[UUID], *, viewer_id: UUID | None = None
) -> None:
    """Retract identities already deleted by the canonical owner in this transaction.

    No source extraction is needed. Contributor keys still require their viewer.
    """
    assert family in _FAMILIES
    assert (viewer_id is not None) == (family == "contributor")
    if not identities:
        return
    db.execute(text("SET LOCAL paradedb.global_mutable_segment_rows=0"))
    for start in range(0, len(identities), _BATCH):
        _withdraw_batch(db, family, identities[start : start + _BATCH], viewer_id=viewer_id)


def refresh(
    db: Session, family: str, identities: Sequence[UUID], *, viewer_id: UUID | None = None
) -> None:
    """Replace exact canonical rows in the caller's transaction; replay is absolute.

    Deleted source identities simply retract their projection. Contributor refresh
    needs the explicit viewer whose visible credited names own this document.
    """
    assert family in _FAMILIES
    assert (viewer_id is not None) == (family == "contributor")
    if not identities:
        return
    db.execute(text("SET LOCAL paradedb.global_mutable_segment_rows=0"))
    for start in range(0, len(identities), _BATCH):
        ids = list(identities[start : start + _BATCH])
        _withdraw_batch(db, family, ids, viewer_id=viewer_id)
        params = {"ids": ids, "viewer_id": viewer_id, "projection_viewer_id": viewer_id}
        source = _SOURCES[family].replace(
            "/*identity_filter*/", f"AND {_SOURCE_IDS[family]}=ANY(CAST(:ids AS uuid[]))"
        )
        db.execute(text(f"INSERT INTO {TABLE} ({','.join(_COLUMNS)}) {source}"), params)


def refresh_contributor_dependents(db: Session, contributor_ids: Sequence[UUID]) -> None:
    """Refresh direct credited works after canonical names or aliases change.

    The caller owns the serializable attempt from source reads through commit.
    Concurrent dependency changes restart that whole attempt, including discovery.
    """
    if not contributor_ids:
        return
    for family, column in (("media", "media_id"), ("podcast", "podcast_id")):
        identities = db.scalars(
            text(
                f"SELECT DISTINCT {column} FROM contributor_credits "
                f"WHERE contributor_id = ANY(CAST(:ids AS uuid[])) AND {column} IS NOT NULL "
                f"ORDER BY {column}"
            ),
            {"ids": list(contributor_ids)},
        ).all()
        refresh(db, family, identities)


def refresh_contributors(db: Session, contributor_ids: Sequence[UUID]) -> None:
    """Refresh viewer-dependent names for every existing viewer after a credit edit."""
    if not contributor_ids:
        return
    for viewer_id in db.scalars(text("SELECT id FROM users ORDER BY id")):
        refresh(db, "contributor", contributor_ids, viewer_id=viewer_id)


def refresh_subject_dossiers(db: Session, refs: Sequence[ResourceRef]) -> None:
    """Refresh dossiers after their subjects' canonical names or bodies change.

    The caller owns the serializable attempt and has flushed its mutation. Dossier
    deletion owns removed artifact identities; this discovers surviving heads.
    """
    if not refs:
        return
    identities = db.scalars(
        text(
            "SELECT id FROM artifacts WHERE (subject_scheme, subject_id) IN "
            "(SELECT * FROM unnest(CAST(:schemes AS text[]), CAST(:ids AS uuid[]))) ORDER BY id"
        ),
        {"schemes": [ref.scheme for ref in refs], "ids": [ref.id for ref in refs]},
    ).all()
    refresh(db, "dossier", identities)


def refresh_viewer_contributors(db: Session, viewer_ids: Sequence[UUID]) -> None:
    """Replace each viewer's complete contributor text after a visibility mutation.

    The caller owns the serializable attempt and has flushed its mutation. Conservative
    full coverage includes newly visible credits and replaces withdrawn credited text.
    Contributors and viewers have no hard-delete owner. Each current identity uses
    refresh's exact document-key replacement; no transaction or retry is owned here.
    """
    for viewer_id in sorted(set(viewer_ids)):
        previous = None
        while True:
            identities = db.scalars(
                text(
                    "SELECT id FROM contributors "
                    "WHERE CAST(:previous AS uuid) IS NULL OR id>:previous ORDER BY id LIMIT 256"
                ),
                {"previous": previous},
            ).all()
            if not identities:
                break
            refresh(db, "contributor", identities, viewer_id=viewer_id)
            previous = identities[-1]
