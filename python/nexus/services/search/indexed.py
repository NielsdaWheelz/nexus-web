"""Indexed browser relevance and selected literal evidence.

One native lexical traversal supplies comparable owner winners. Semantic facts use
the separately approved bounded windows; lexical occurrences take precedence.
The returned facts belong to one read snapshot and are passed through composition.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import RowMapping, text
from sqlalchemy.orm import Session

from nexus.schemas.resource_items import ResourceItemOut
from nexus.schemas.search import SearchMatchOut, SearchMatchRangeOut
from nexus.services.resource_graph.refs import ResourceRef, assert_resource_ref
from nexus.services.resource_items.items import excerpt_window, resource_items_out
from nexus.services.search.projection import ANALYZER, TABLE, TEXT_FIELDS
from nexus.services.search.sources import (
    GENERATED_FAMILIES,
    DiscoveryHit,
    Retrieval,
    discovery_browse,
    discovery_eligible,
    discovery_semantic_hits,
)


def query_segments(query: str) -> list[dict[str, Any]]:
    """Recognize structure only; native analysis owns words, stems and stopwords.

    Standalone OR separates conjunctions; unary minus negates one segment. Quoted
    phrases retain their original characters. All other punctuation is ordinary
    input, not engine field/boost/wildcard syntax. Native simple tokenization splits
    unquoted segments, so Python never approximates its Unicode word boundaries.
    """
    segments: list[dict[str, Any]] = []
    branch = 0
    position = 0
    while position < len(query):
        if query[position].isspace():
            position += 1
            continue
        negative = query[position] == "-"
        position += int(negative)
        if position == len(query):
            break
        quoted = query[position] == '"'
        if quoted:
            end = query.find('"', position + 1)
            if end < 0:
                end = len(query)
            raw = query[position + 1 : end]
            position = min(end + 1, len(query))
        else:
            end = position
            while end < len(query) and not query[end].isspace() and query[end] != '"':
                end += 1
            raw = query[position:end]
            position = end
            if not negative and raw.lower() == "or":
                branch += 1
                continue
        if raw:
            segments.append({"branch": branch, "negative": negative, "quoted": quoted, "raw": raw})
    return segments


def _compiler(terms: str) -> tuple[str, dict[str, Any]]:
    """one grammar/analyzer compiler shared by scoring and selected-only annotation."""
    params: dict[str, Any] = {
        "query_segments": json.dumps(query_segments(terms)),
        "query_fields": list(TEXT_FIELDS),
        "word_tokenizer": json.dumps({"type": "default", "lowercase": False}),
        "indexed_tokenizer": json.dumps(ANALYZER),
    }
    # Analyze only to discard empty leaves; never feed normalized stems back
    # through parse. Quoted parse receives original text and retains positions.
    return (
        """
        query_segments AS MATERIALIZED (
            SELECT (atom->>'branch')::int AS branch,(atom->>'negative')::boolean AS negative,
                (atom->>'quoted')::boolean AS quoted,atom->>'raw' AS raw,segment_order
            FROM jsonb_array_elements(CAST(:query_segments AS jsonb)) WITH ORDINALITY j(atom,segment_order)),
        query_words AS MATERIALIZED (
            SELECT branch,negative,raw AS literal,segment_order,0 AS word_order FROM query_segments WHERE quoted
            UNION ALL
            SELECT s.branch,s.negative,t.token AS literal,s.segment_order,t.position AS word_order FROM query_segments s
                CROSS JOIN LATERAL paradedb.tokenize(CAST(:word_tokenizer AS jsonb),s.raw) t
                WHERE NOT s.quoted),
        analyzed_terms AS MATERIALIZED (
            SELECT branch,negative,literal,segment_order,word_order FROM query_words
            WHERE EXISTS (SELECT 1 FROM paradedb.tokenize(CAST(:indexed_tokenizer AS jsonb),literal))),
        parsed_terms AS MATERIALIZED (
            SELECT a.branch,a.negative,a.segment_order,a.word_order,paradedb.parse('(' || (
                SELECT string_agg(field || ':(' || chr(34) ||
                    replace(replace(a.literal,chr(92),chr(92)||chr(92)),chr(34),chr(92)||chr(34))
                    || chr(34) || ')',' OR ' ORDER BY ordinal)
                FROM unnest(CAST(:query_fields AS text[])) WITH ORDINALITY f(field,ordinal)
                ) || ')',conjunction_mode=>true) AS query
            FROM analyzed_terms a),
        query_branches AS MATERIALIZED (
            SELECT branch,paradedb.boolean(
                must=>CASE WHEN count(*) FILTER (WHERE NOT negative)=0 THEN ARRAY[paradedb.all()]
                    ELSE array_agg(query ORDER BY segment_order,word_order) FILTER (WHERE NOT negative) END,
                must_not=>COALESCE(array_agg(query ORDER BY segment_order,word_order) FILTER (WHERE negative),ARRAY[paradedb.empty()])) AS query
            FROM parsed_terms GROUP BY branch),
        compiled_query AS MATERIALIZED (
            SELECT paradedb.boolean(should=>COALESCE(array_agg(query ORDER BY branch),ARRAY[paradedb.empty()]),
                minimum_should_match=>1) AS query FROM query_branches)""",
        params,
    )


def statement(
    db: Session,
    r: Retrieval,
    families: Sequence[str],
    *,
    group_owners: bool,
) -> tuple[str, dict[str, Any]]:
    """One lexical scoring stream, with grouping before any truncation."""
    assert r.terms
    eligible, params = discovery_eligible(db, r, families)
    compiler, query_params = _compiler(r.terms)
    params = dict(params) | query_params | {"k": r.k}
    generated = ",".join("'" + family + "'" for family in sorted(GENERATED_FAMILIES))
    # primary candidates use family literals; canonical admission still joins every
    # hit before ranking or limits. generated occurrences retain owner-key filtering.
    native_filter = """paradedb.boolean(should=>ARRAY[
        paradedb.term_set(ARRAY(SELECT paradedb.term('admission_key',admission_key)
            FROM eligible WHERE native_search_id IS NULL)),
        paradedb.term_set(ARRAY(SELECT paradedb.term('doc_key',doc_key)
            FROM eligible WHERE native_search_id IS NOT NULL))],minimum_should_match=>1)"""
    if families and not (GENERATED_FAMILIES | {"highlight"}).intersection(families):
        native_filter = (
            "paradedb.term_set(ARRAY["
            + ",".join(f"paradedb.term('family','{family}')" for family in sorted(set(families)))
            + "])"
        )
    # the first producer retains exactly two named fast fields under pinned0.26.2.
    sql = (
        eligible
        + ","
        + compiler
        + f""",
        name_matches AS MATERIALIZED (
            SELECT doc_key FROM eligible WHERE doc_key IS NOT NULL
                AND (name ILIKE :contains OR discovery_name ILIKE :contains)),
        hits AS MATERIALIZED (
            SELECT search_id,admission_key,pdb.score(search_id) AS score
            FROM {TABLE}
            WHERE search_id @@@ paradedb.boolean(
                must=>ARRAY[paradedb.const_score(0,{native_filter})],
                should=>ARRAY[(SELECT query FROM compiled_query),
                    paradedb.const_score(0,paradedb.term_set(ARRAY(
                        SELECT paradedb.term('doc_key',doc_key) FROM name_matches)))],
                minimum_should_match=>1)),
        facts AS MATERIALIZED (
            SELECT h.search_id,e.doc_key,e.ref,e.owner_ref,e.family,
                COALESCE(e.name_tier,0) AS name_tier,
                h.score,''::text AS sort_label,e.reading_media_id
            FROM hits h JOIN eligible e ON h.admission_key=e.admission_key
                AND (e.native_search_id IS NULL OR e.native_search_id=h.search_id))"""
    )
    if group_owners:
        sql += f""",
            best AS (SELECT family,owner_ref,max(score) AS score FROM facts
                WHERE family IN ({generated}) GROUP BY family,owner_ref),
            tie_refs AS MATERIALIZED (
                SELECT h.*,COALESCE(h.ref,(SELECT p.doc_key FROM {TABLE} p
                    WHERE p.search_id=h.search_id)) AS canonical_ref
                FROM facts h JOIN best USING(family,owner_ref,score)),
            representatives AS (SELECT family,owner_ref,score,min(canonical_ref COLLATE "C") AS ref
                FROM tie_refs GROUP BY family,owner_ref,score),
            selected AS (
                SELECT doc_key,ref,owner_ref,family,name_tier,score,sort_label,reading_media_id
                    FROM facts WHERE family NOT IN ({generated})
                UNION ALL SELECT COALESCE(h.doc_key,h.canonical_ref),h.canonical_ref,
                    h.owner_ref,h.family,h.name_tier,h.score,h.sort_label,h.reading_media_id
                FROM tie_refs h JOIN representatives w ON h.family=w.family
                    AND h.owner_ref=w.owner_ref AND h.score=w.score AND h.canonical_ref=w.ref)"""
    else:
        # Every eligible passage family has tier zero, but retaining the complete
        # canonical order makes that premise explicit rather than accidental.
        sql += f""", prefix AS MATERIALIZED (SELECT * FROM facts
            ORDER BY name_tier DESC,score DESC,sort_label COLLATE "C"
            FETCH FIRST (:k) ROWS WITH TIES),
        prefix_refs AS MATERIALIZED (
            SELECT h.*,COALESCE(h.ref,(SELECT p.doc_key FROM {TABLE} p
                WHERE p.search_id=h.search_id)) AS canonical_ref FROM prefix h),
        selected AS (SELECT COALESCE(doc_key,canonical_ref) AS doc_key,canonical_ref AS ref,
            owner_ref,family,name_tier,score,sort_label,reading_media_id FROM prefix_refs
            ORDER BY name_tier DESC,score DESC,sort_label COLLATE "C",canonical_ref COLLATE "C"
            LIMIT :k)"""
    output = """SELECT 'selected'::text AS row_kind,doc_key,ref,owner_ref,family,name_tier,score,sort_label,reading_media_id
        FROM selected"""
    return (
        sql
        + " SELECT * FROM ("
        + output
        + """
        ) result ORDER BY row_kind,name_tier DESC,score DESC,sort_label COLLATE "C",ref COLLATE "C"
        """,
        params,
    )


def select(
    db: Session, r: Retrieval, families: Sequence[str], *, group_owners: bool
) -> tuple[list[DiscoveryHit], dict[str, str]]:
    """Consume complete owner facts or the individual occurrence prefix once."""
    sql, params = statement(db, r, families, group_owners=group_owners)
    rows = db.execute(text(sql), params).mappings().all()
    hits = [
        DiscoveryHit(
            family=row["family"],
            ref=assert_resource_ref(row["ref"]),
            owner=assert_resource_ref(row["owner_ref"])
            if row["family"] in GENERATED_FAMILIES
            else None,
            name_tier=row["name_tier"],
            lexical=True,
            relevance=float(row["score"]),
            sort_label=row["sort_label"],
            reading_media_id=row["reading_media_id"],
        )
        for row in rows
    ]
    return sorted(hits, key=lambda hit: hit.order), {row["ref"]: row["doc_key"] for row in rows}


@dataclass(frozen=True, slots=True)
class IndexedRead:
    hits: list[DiscoveryHit]
    doc_keys: dict[str, str]

    def with_semantic(
        self, db: Session, r: Retrieval, neighbours: dict[str, list[tuple[UUID, float]]]
    ) -> IndexedRead:
        """Merge approved windows into these same lexical facts; existing refs win."""
        if not neighbours:
            return self
        existing = {hit.ref for hit in self.hits}
        hits = list(self.hits)
        for family, window in neighbours.items():
            hits.extend(
                hit
                for hit in discovery_semantic_hits(db, r, family, window)
                if hit.ref not in existing
            )
        return IndexedRead(sorted(hits, key=lambda hit: hit.order), self.doc_keys)

    def rank(
        self,
        families: Sequence[str],
        *,
        k: int,
        owners: Sequence[UUID] | None = None,
        excluded_owners: Sequence[UUID] = (),
        identities: Sequence[UUID] | None = None,
        group_owners: bool = False,
    ) -> list[DiscoveryHit]:
        hits = [
            hit
            for hit in self.hits
            if hit.family in families
            and (owners is None or (hit.owner is not None and hit.owner.id in owners))
            and (not excluded_owners or hit.owner is None or hit.owner.id not in excluded_owners)
            and (identities is None or hit.ref.id in identities)
        ]
        if group_owners:
            strongest: dict[tuple[str, ResourceRef | None], DiscoveryHit] = {}
            for hit in sorted(hits, key=lambda hit: hit.order):
                strongest.setdefault((hit.family, hit.owner), hit)
            hits = sorted(
                strongest.values(),
                key=lambda hit: (*hit.order[:-1], hit.owner.uri if hit.owner else hit.ref.uri),
            )
        return hits[:k]


def read(
    db: Session,
    r: Retrieval,
    families: Sequence[str],
    neighbours: dict[str, list[tuple[UUID, float]]],
    *,
    group_owners: bool,
) -> IndexedRead:
    if not families:
        return IndexedRead([], {})
    if not r.terms:
        return IndexedRead(discovery_browse(db, r, families), {})
    hits, doc_keys = select(db, r, families, group_owners=group_owners)
    return IndexedRead(hits, doc_keys).with_semantic(db, r, neighbours)


def _literal_match(
    value: str, *, anchor: int, span: tuple[int, int] | None = None
) -> SearchMatchOut | None:
    """one literal field window; only native spans supply emphasis."""
    if not value:
        return None
    start = max(0, anchor - 160)
    if span and span[1] - start > 600:
        start = span[0]
    if start:
        space = value.find(" ", start, anchor)
        if space >= 0:
            start = space + 1
    start, shown = excerpt_window(value, start=start, limit=600)
    if (span[1] if span else anchor + 1) > start + len(shown.text):
        # A preceding oversized grapheme can consume the context window's budget.
        start, shown = excerpt_window(value, start=span[0] if span else anchor, limit=600)
    ranges = (
        [SearchMatchRangeOut(start=span[0] - start, end=span[1] - start)]
        if (span and start <= span[0] < span[1] <= start + len(shown.text))
        else []
    )
    return SearchMatchOut(excerpt=shown, ranges=ranges)


def _witness(row: RowMapping, hit: DiscoveryHit, terms: str) -> SearchMatchOut | None:
    """a positive query-term witness need not certify a whole boolean branch."""
    for name in TEXT_FIELDS:
        value, positions = row[name], row[name + "_positions"]
        if value and positions:
            begin, end = positions[0]
            encoded = value.encode("utf-8")
            assert 0 <= begin < end <= len(encoded), "native field span is outside its literal text"
            # strict decoding rejects offsets inside a utf-8 code point.
            start = len(encoded[:begin].decode("utf-8"))
            stop = len(encoded[:end].decode("utf-8"))
            return _literal_match(value, anchor=start, span=(start, stop))
    if hit.name_tier:
        # this anchors the existing raw-name admission only; it neither parses the
        # query nor manufactures positive emphasis for stopword/name-only hits.
        for name in ("name", "discovery_name"):
            value = row[name]
            found = re.search(re.escape(terms), value, re.IGNORECASE) if value else None
            if found:
                return _literal_match(value, anchor=found.start())
    # negative-only hits need no invented positive span. missing native evidence
    # stays absent, with the canonical selected resource and body still intact.
    return None


def present(
    db: Session,
    facts: IndexedRead,
    *,
    viewer_id: UUID,
    refs: Sequence[ResourceRef],
    hits: Sequence[DiscoveryHit],
    terms: str,
) -> dict[str, tuple[ResourceItemOut, SearchMatchOut | None]]:
    """annotate only selected keys in the caller's admitted snapshot."""
    owners = {hit.ref: hit.reading_media_id for hit in hits}
    items = []
    for owner in dict.fromkeys(owners.get(ref) for ref in refs):
        items.extend(
            resource_items_out(
                db,
                viewer_id=viewer_id,
                refs=list(dict.fromkeys(ref for ref in refs if owners.get(ref) == owner)),
                reading_media_id=owner,
            )
        )
    keys = list(
        dict.fromkeys(facts.doc_keys[hit.ref.uri] for hit in hits if hit.ref.uri in facts.doc_keys)
    )
    annotations: dict[str, RowMapping] = {}
    if keys:
        compiler, params = _compiler(terms)
        columns = ",".join(
            f"p.{name},pdb.snippet_positions(p.{name},1,0) AS {name}_positions"
            for name in TEXT_FIELDS
        )
        # native highlighting visits must_not terms too. only positive leaves
        # from the same parser/analyzer belong in the annotation query.
        sql = (
            "WITH"
            + compiler
            + f""", evidence_query AS MATERIALIZED (
            SELECT paradedb.boolean(should=>COALESCE(array_agg(query
                ORDER BY branch,segment_order,word_order) FILTER (WHERE NOT negative),
                ARRAY[paradedb.empty()]),minimum_should_match=>1) AS query FROM parsed_terms)
            SELECT p.doc_key,p.name,p.discovery_name,{columns} FROM {TABLE} p
            WHERE p.search_id @@@ paradedb.boolean(
                must=>ARRAY[paradedb.term_set(ARRAY(
                    SELECT paradedb.term('doc_key',k) FROM unnest(CAST(:selected_keys AS text[])) selected(k)))],
                should=>ARRAY[(SELECT query FROM evidence_query)],minimum_should_match=>0)"""
        )
        rows = db.execute(text(sql), params | {"selected_keys": keys}).mappings().all()
        annotations = {row["doc_key"]: row for row in rows}
        assert len(annotations) == len(rows) and annotations.keys() <= set(keys)
    by_ref = {hit.ref.uri: hit for hit in hits}
    presented: dict[str, tuple[ResourceItemOut, SearchMatchOut | None]] = {}
    for item in items:
        if item.missing:
            raise RuntimeError("visible discovery resource missing from canonical item projection")
        key = facts.doc_keys.get(item.ref)
        row = annotations.get(key) if key is not None else None
        match = (
            _witness(row, by_ref[item.ref], terms)
            if row is not None and item.ref in by_ref
            else None
        )
        presented[item.ref] = item, match
    return presented
