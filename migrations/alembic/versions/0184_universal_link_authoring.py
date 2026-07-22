"""Universal link authoring hard cutover.

Revision ID: 0184
Revises: 0183
Create Date: 2026-07-20

Makes the neutral user Link the one durable relationship-authoring primitive
(spec docs/cutovers/universal-link-authoring-hard-cutover.md, Hard-cutover
Migration steps 1-8). All phases run inside the one alembic transaction — any
raise rolls back everything including ``alembic_version``, so a failed run
leaves no partial state.

1. Inventory neutral Links, stances, ``note_body`` edges, ProseMirror
   ``object_ref``/``object_embed`` nodes, and matching ``resource_view_states``.
   Ordered edges (``source_order_key`` set) are excluded from the inventory and
   from Link canonicalization entirely.
2. Classify each derived or missing direct endpoint:
   - live and convertible (a derived row whose normalized quote identity
     exists): recorded in the canonical anchor map. A quote that RESOLVES
     uniquely in current owner text materializes with recomputed context and a
     current locator hint; one that cannot resolve (ambiguous/no-match) is
     still convertible — its anchor is durable but unresolved (empty context,
     no locator), matching the runtime "remains durable but unresolved" rule.
   - missing underlying row (derived or direct): already lost — the dead edge
     and its edge view states are deleted, a stale note chip unwraps to its
     label text, and an exact report line is emitted per deletion.
   - readable but unconvertible (a live derived row with no durable quote
     identity, or with a missing owner): abort with the referencing edge,
     note (+ JSON path), and view-state IDs plus the raw ref. A media
     fallback is never guessed.
3. Create ``passage_anchors``; add the ``passage_anchor`` scheme to the five
   closed scheme CHECKs and to the two ``chat_run_turn_contexts``
   subject-scheme CHECKs (passage_anchor IS a chat subject); add the
   ``link_note`` origin. The anchor's shape is service validation plus defect
   tests — no CHECK or trigger.
4. Materialize/reuse anchors for live ``evidence_span``/``content_chunk``/
   ``fragment``/``reader_apparatus_item``/``oracle_passage_anchor`` endpoints
   and rewrite edges, edge-bound view-state resource refs, and note JSON plus
   its ``note_body`` projection together.
5. Canonicalize orderless user/context Links only, by total (scheme, id) order
   (ids compare as canonical lowercase uuid strings — the service-side
   canonicalizer must match). Losers map to winners; view-state ``edge_id``
   is rebound BEFORE loser deletion; a rebind occurrence collision keeps the
   latest (updated_at, id), matching migration 0179's phase 5.
6. Drop ``uq_resource_edges_context_pair``; create the three shape-owned
   replacement indexes; retain ``uq_resource_edges_source_order``.
7. Drop ``trg_highlight_fragment_anchor_delete_core`` and
   ``delete_fragment_highlight_after_anchor_delete()`` (both created by
   migration 0056), drop the ``highlight_fragment_anchors.fragment_id`` FK
   (the column stays as a disposable locator cache), and recreate the six
   Highlight-family FKs with default non-cascading behavior.
8. Assert no Link/stance/note-body endpoint or persisted note node remains on
   a derived passage scheme and no dangling link-note/view-state motif
   survives.

This file is self-contained: the quote normalization, anchor-key encoding,
normalized matching, context-window, and note-text projection helpers are
FROZEN LOCAL COPIES, behaviorally identical to
``nexus/services/passage_anchors.py`` / ``nexus/services/text_quote.py`` /
``nexus/services/note_bodies.py`` at this revision (pinned by the gold-vector
parity test in ``python/tests/test_migrations.py``). Never import runtime
services here; future drift in the runtime must not change history.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Iterable, Sequence
from typing import NoReturn
from uuid import uuid4

import sqlalchemy as sa
from alembic import op

revision: str = "0184"
down_revision: str | Sequence[str] | None = "0183"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Derived passage schemes: replaceable index rows that may no longer be
# Link/stance/note-body endpoints after this revision.
_DERIVED_SCHEMES: tuple[str, ...] = (
    "evidence_span",
    "content_chunk",
    "fragment",
    "reader_apparatus_item",
    "oracle_passage_anchor",
)

# Every pre-0184 ResourceScheme and its backing table, for endpoint existence
# checks (``passage_anchor`` is created by this revision and cannot be
# referenced yet).
_SCHEME_TABLES: dict[str, str] = {
    "media": "media",
    "library": "libraries",
    "evidence_span": "evidence_spans",
    "content_chunk": "content_chunks",
    "highlight": "highlights",
    "page": "pages",
    "note_block": "note_blocks",
    "fragment": "fragments",
    "conversation": "conversations",
    "message": "messages",
    "oracle_reading": "oracle_readings",
    "oracle_passage_anchor": "oracle_passage_anchors",
    "artifact": "artifacts",
    "artifact_revision": "artifact_revisions",
    "external_snapshot": "resource_external_snapshots",
    "contributor": "contributors",
    "podcast": "podcasts",
    "reader_apparatus_item": "reader_apparatus_items",
}

_SELECTOR_VERSION = 1
_PREFIX_SUFFIX_WINDOW = 64

# The identical 19-scheme list used verbatim in all seven closed-contract
# CHECK constraints (s1-contracts.md §3): the five resource-graph CHECKs plus
# the two chat_run_turn_contexts subject-scheme CHECKs.
_SCHEME_LIST_SQL = """(
    'media', 'library', 'evidence_span', 'content_chunk',
    'highlight', 'page', 'note_block', 'fragment',
    'conversation', 'message', 'oracle_reading',
    'oracle_passage_anchor', 'artifact',
    'artifact_revision',
    'external_snapshot', 'contributor', 'podcast',
    'reader_apparatus_item', 'passage_anchor'
)"""


# ---------------------------------------------------------------------------
# Small helpers (file-local by design; copied idiom from 0179/0183)
# ---------------------------------------------------------------------------

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _fail(phase: str, message: str) -> NoReturn:
    raise RuntimeError(f"0184 {phase}: {message}")


def _report(message: str) -> None:
    print(f"0184: {message}")


def _uuid_list_sql(ids: Iterable[str]) -> str:
    """Literal SQL uuid list; every element is validated against the uuid grammar."""

    values = sorted(set(ids))
    for value in values:
        if _UUID_RE.fullmatch(value) is None:
            _fail("internal", f"non-uuid value in id list: {value!r}")
    return "(" + ", ".join(f"'{value}'" for value in values) + ")"


def _chunks(items: Sequence, size: int) -> Iterable[Sequence]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _index_exists(bind, name: str) -> bool:
    return bool(
        bind.execute(
            sa.text("SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = :n"),
            {"n": name},
        ).scalar()
    )


def _single_column_fk_name(bind, table: str, column: str) -> str | None:
    return bind.execute(
        sa.text(
            "SELECT con.conname"
            " FROM pg_constraint con"
            " JOIN pg_class rel ON rel.oid = con.conrelid"
            " JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace"
            " WHERE nsp.nspname = 'public' AND rel.relname = :t AND con.contype = 'f'"
            "   AND array_length(con.conkey, 1) = 1"
            "   AND (SELECT att.attname FROM pg_attribute att"
            "        WHERE att.attrelid = rel.oid AND att.attnum = con.conkey[1]) = :c"
        ),
        {"t": table, "c": column},
    ).scalar()


def _fk_delete_rule(bind, table: str, name: str) -> str | None:
    return bind.execute(
        sa.text(
            "SELECT con.confdeltype"
            " FROM pg_constraint con"
            " JOIN pg_class rel ON rel.oid = con.conrelid"
            " JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace"
            " WHERE nsp.nspname = 'public' AND rel.relname = :t AND con.conname = :n"
        ),
        {"t": table, "n": name},
    ).scalar()


# ---------------------------------------------------------------------------
# Frozen identity helpers (parity-pinned against services/passage_anchors.py
# and services/text_quote.py by the gold-vector test in test_migrations.py)
# ---------------------------------------------------------------------------


def _normalize_quote(value: str) -> str:
    """Canonical quote normalization: NFC, whitespace runs -> U+0020, trimmed."""

    return _normalize_with_spans(value)[0].strip()


def _normalize_with_spans(value: str) -> tuple[str, tuple[tuple[int, int], ...]]:
    """Whitespace-collapsed NFC text with per-char raw codepoint spans."""

    nfc = unicodedata.normalize("NFC", value)
    chars: list[str] = []
    spans: list[tuple[int, int]] = []
    i = 0
    length = len(nfc)
    while i < length:
        if nfc[i].isspace():
            j = i
            while j < length and nfc[j].isspace():
                j += 1
            chars.append(" ")
            spans.append((i, j))
            i = j
        else:
            chars.append(nfc[i])
            spans.append((i, i + 1))
            i += 1
    return "".join(chars), tuple(spans)


def _anchor_key(*, exact: str, prefix: str, suffix: str) -> str:
    """sha256 hex over canonical JSON of the already-normalized quote identity."""

    canonical = json.dumps(
        {"exact": exact, "prefix": prefix, "suffix": suffix},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _find_occurrences(text: str, needle: str) -> list[int]:
    positions: list[int] = []
    start = 0
    while True:
        idx = text.find(needle, start)
        if idx == -1:
            break
        positions.append(idx)
        start = idx + 1
    return positions


def _context_window(normalized_text: str, *, start: int, end: int) -> tuple[str, str]:
    """Nearest 64 normalized scalars each side, trimmed (shorter at boundaries)."""

    prefix = normalized_text[max(0, start - _PREFIX_SUFFIX_WINDOW) : start].strip()
    suffix = normalized_text[end : end + _PREFIX_SUFFIX_WINDOW].strip()
    return prefix, suffix


def _note_text_projection(value: object) -> str:
    """Frozen copy of note_bodies.text_from_pm_json at this revision."""

    parts: list[str] = []

    def visit(node: object) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        if not isinstance(node, dict):
            return
        node_type = node.get("type")
        if node_type == "text" and isinstance(node.get("text"), str):
            parts.append(str(node["text"]))
        elif node_type in {"object_ref", "object_embed"} and isinstance(node.get("attrs"), dict):
            attrs = node["attrs"]
            label = attrs.get("label") or f"{attrs.get('objectType')}:{attrs.get('objectId')}"
            if isinstance(label, str):
                parts.append(label)
        elif node_type == "image" and isinstance(node.get("attrs"), dict):
            alt = node["attrs"].get("alt")
            if isinstance(alt, str):
                parts.append(alt)
        elif node_type == "hard_break":
            parts.append("\n")
        visit(node.get("content"))
        if node_type in {"paragraph", "code_block"}:
            parts.append("\n")

    visit(value)
    return "\n".join(line.rstrip() for line in "".join(parts).splitlines()).strip()


# ---------------------------------------------------------------------------
# Owner-text quote resolution (frozen, hint-less copy of
# locator_resolver.resolve_passage_selector's matching behavior)
# ---------------------------------------------------------------------------


def _resolve_quote_in_owner(
    bind, *, owner_scheme: str, owner_id: str, exact: str
) -> tuple[str, str, str, dict | None]:
    """Resolve a normalized quote against the owner's CURRENT text.

    Returns ``(status, prefix, suffix, locator)`` where status is
    ``unique``/``ambiguous``/``no_match``. Context and locator are set only on
    a unique hit; ambiguity is never first-occurrence-resolved.
    """

    if owner_scheme == "note_block":
        body = bind.execute(
            sa.text("SELECT body_text FROM note_blocks WHERE id = :id"),
            {"id": owner_id},
        ).scalar()
        if body is None:
            return ("no_match", "", "", None)
        normalized, spans = _normalize_with_spans(body)
        hits = _find_occurrences(normalized, exact)
        if len(hits) != 1:
            return ("ambiguous" if hits else "no_match", "", "", None)
        start = hits[0]
        end = start + len(exact)
        prefix, suffix = _context_window(normalized, start=start, end=end)
        locator = {
            "kind": "text",
            "start_offset": spans[start][0],
            "end_offset": spans[end - 1][1],
        }
        return ("unique", prefix, suffix, locator)

    row = bind.execute(
        sa.text("SELECT kind, plain_text FROM media WHERE id = :id"), {"id": owner_id}
    ).fetchone()
    if row is None:
        return ("no_match", "", "", None)
    kind, plain_text = row

    if kind == "pdf":
        normalized, spans = _normalize_with_spans(plain_text or "")
        hits = _find_occurrences(normalized, exact)
        if len(hits) != 1:
            return ("ambiguous" if len(hits) > 1 else "no_match", "", "", None)
        start = hits[0]
        end = start + len(exact)
        prefix, suffix = _context_window(normalized, start=start, end=end)
        page_number = bind.execute(
            sa.text(
                "SELECT page_number FROM pdf_page_text_spans"
                " WHERE media_id = :media_id"
                "   AND start_offset <= :offset AND :offset < end_offset"
                " ORDER BY page_number LIMIT 1"
            ),
            {"media_id": owner_id, "offset": spans[start][0]},
        ).scalar()
        locator = {"kind": "pdf", "page_number": int(page_number)} if page_number else None
        return ("unique", prefix, suffix, locator)

    fragment_rows = bind.execute(
        sa.text(
            "SELECT id::text, canonical_text FROM fragments WHERE media_id = :media_id ORDER BY idx"
        ),
        {"media_id": owner_id},
    ).fetchall()
    all_hits: list[tuple[str, str, tuple[tuple[int, int], ...], int]] = []
    for fragment_id, canonical_text in fragment_rows:
        normalized, spans = _normalize_with_spans(canonical_text)
        for start in _find_occurrences(normalized, exact):
            all_hits.append((fragment_id, normalized, spans, start))
    if len(all_hits) != 1:
        return ("ambiguous" if len(all_hits) > 1 else "no_match", "", "", None)
    fragment_id, normalized, spans, start = all_hits[0]
    end = start + len(exact)
    prefix, suffix = _context_window(normalized, start=start, end=end)
    locator = {
        "kind": "text",
        "fragment_id": fragment_id,
        "start_offset": spans[start][0],
        "end_offset": spans[end - 1][1],
    }
    return ("unique", prefix, suffix, locator)


# ---------------------------------------------------------------------------
# Phase 1: inventory + classification (SELECT-only)
# ---------------------------------------------------------------------------


# Plain classes, not dataclasses: alembic's migration loader does not register
# the module in sys.modules, which breaks dataclass string-annotation probing.
class _Convertible:
    def __init__(self, *, owner_scheme: str, owner_id: str, exact: str) -> None:
        self.owner_scheme = owner_scheme
        self.owner_id = owner_id
        self.exact = exact  # normalized quote identity (nonempty)
        self.users: set[str] = set()


class _Inventory:
    def __init__(
        self,
        *,
        edges: list[dict],
        notes: list[dict],
        chip_refs: dict[tuple[str, str], list[tuple[str, str]]],
        convertible: dict[tuple[str, str], _Convertible],
        lost: set[tuple[str, str]],
    ) -> None:
        # Bare orderless user/note_body edges as dicts with lowercase-uuid ids;
        # notes carrying object_ref/object_embed chips ({"id", "user_id",
        # "doc"}); (scheme, id) -> [(note_id, json_path)] chip occurrences.
        self.edges = edges
        self.notes = notes
        self.chip_refs = chip_refs
        self.convertible = convertible
        self.lost = lost


def _walk_chips(node: object, path: str, out: list[tuple[str, dict]]) -> None:
    if isinstance(node, list):
        for idx, child in enumerate(node):
            _walk_chips(child, f"{path}[{idx}]", out)
        return
    if not isinstance(node, dict):
        return
    if node.get("type") in {"object_ref", "object_embed"} and isinstance(node.get("attrs"), dict):
        out.append((path, node))
    content = node.get("content")
    if content is not None:
        _walk_chips(content, f"{path}.content" if path else "content", out)


def _chip_ref(node: dict) -> tuple[str, str] | None:
    """(scheme, lowercase-uuid) for a chip whose ref is well-formed and in the
    pre-0184 closed scheme set; anything else is left untouched."""

    attrs = node["attrs"]
    object_type = attrs.get("objectType")
    object_id = attrs.get("objectId")
    if not isinstance(object_type, str) or object_type not in _SCHEME_TABLES:
        return None
    if not isinstance(object_id, str) or _UUID_RE.fullmatch(object_id.lower()) is None:
        return None
    return (object_type, object_id.lower())


def _derived_quote_and_owner(bind, scheme: str, ref_id: str):
    """(owner_scheme, owner_id, raw_quote) for a live derived row, or None if
    the row is missing."""

    if scheme == "fragment":
        row = bind.execute(
            sa.text("SELECT canonical_text, media_id::text FROM fragments WHERE id = :id"),
            {"id": ref_id},
        ).fetchone()
        return None if row is None else ("media", row[1], row[0])
    if scheme == "evidence_span":
        row = bind.execute(
            sa.text(
                "SELECT span_text, owner_kind, owner_id::text FROM evidence_spans WHERE id = :id"
            ),
            {"id": ref_id},
        ).fetchone()
        return None if row is None else (row[1], row[2], row[0])
    if scheme == "content_chunk":
        row = bind.execute(
            sa.text(
                "SELECT chunk_text, owner_kind, owner_id::text FROM content_chunks WHERE id = :id"
            ),
            {"id": ref_id},
        ).fetchone()
        return None if row is None else (row[1], row[2], row[0])
    if scheme == "reader_apparatus_item":
        row = bind.execute(
            sa.text("SELECT body_text, media_id::text FROM reader_apparatus_items WHERE id = :id"),
            {"id": ref_id},
        ).fetchone()
        return None if row is None else ("media", row[1], row[0] or "")
    if scheme == "oracle_passage_anchor":
        row = bind.execute(
            sa.text(
                "SELECT a.selector->>'exact', s.media_id::text"
                " FROM oracle_passage_anchors a"
                " JOIN oracle_corpus_sources s ON s.id = a.corpus_source_id"
                " WHERE a.id = :id"
            ),
            {"id": ref_id},
        ).fetchone()
        return None if row is None else ("media", row[1], row[0] or "")
    _fail("classify", f"unexpected derived scheme {scheme!r}")  # justify-defect: closed set


def _abort_unconvertible(bind, inv_edges: list[dict], chip_refs, scheme, ref_id, reason) -> None:
    edge_ids = sorted(
        edge["id"]
        for edge in inv_edges
        if (edge["source_scheme"], edge["source_id"]) == (scheme, ref_id)
        or (edge["target_scheme"], edge["target_id"]) == (scheme, ref_id)
    )
    note_locations = sorted(chip_refs.get((scheme, ref_id), ()))
    view_state_ids: list[str] = []
    if edge_ids:
        view_state_ids.extend(
            str(row[0])
            for row in bind.execute(
                sa.text(
                    "SELECT id FROM resource_view_states"
                    f" WHERE edge_id IN {_uuid_list_sql(edge_ids)}"  # noqa: S608
                )
            ).fetchall()
        )
    view_state_ids.extend(
        str(row[0])
        for row in bind.execute(
            sa.text(
                "SELECT id FROM resource_view_states"
                " WHERE (target_scheme = :s AND target_id = :i)"
                "    OR (surface_scheme = :s AND surface_id = :i)"
            ),
            {"s": scheme, "i": ref_id},
        ).fetchall()
    )
    _fail(
        "classify",
        f"raw_ref={scheme}:{ref_id} is readable but unconvertible ({reason});"
        f" edges={edge_ids} notes={note_locations}"
        f" view_states={sorted(set(view_state_ids))}."
        " Remediate the underlying row (or remove the reference through the"
        " product), then rerun. A media fallback is never guessed.",
    )


def _phase1_classify(bind) -> _Inventory:
    # Ordered edges (source_order_key set) are ordered adjacency, a separate
    # shape this migration never touches (AC21): they are excluded from the
    # inventory, conversion, and canonicalization entirely, even when an
    # endpoint is a derived passage scheme.
    edges = [
        {
            "id": str(row[0]),
            "user_id": str(row[1]),
            "origin": row[2],
            "kind": row[3],
            "source_scheme": row[4],
            "source_id": str(row[5]),
            "target_scheme": row[6],
            "target_id": str(row[7]),
            "created_at": row[8],
        }
        for row in bind.execute(
            sa.text(
                "SELECT id, user_id, origin, kind, source_scheme, source_id,"
                "       target_scheme, target_id, created_at"
                " FROM resource_edges"
                " WHERE origin IN ('user', 'note_body') AND source_order_key IS NULL"
                " ORDER BY created_at, id"
            )
        ).fetchall()
    ]

    notes: list[dict] = []
    chip_refs: dict[tuple[str, str], list[tuple[str, str]]] = {}
    note_users: dict[tuple[str, str], set[str]] = {}
    note_rows = bind.execute(
        sa.text(
            "SELECT id, user_id, body_pm_json FROM note_blocks"
            " WHERE body_pm_json::text LIKE :needle ORDER BY id"
        ),
        {"needle": '%"objectType":%'},
    ).fetchall()
    for note_id, user_id, doc in note_rows:
        chips: list[tuple[str, dict]] = []
        _walk_chips(doc, "", chips)
        if not chips:
            continue
        notes.append({"id": str(note_id), "user_id": str(user_id), "doc": doc})
        for path, node in chips:
            ref = _chip_ref(node)
            if ref is None:
                continue
            chip_refs.setdefault(ref, []).append((str(note_id), path))
            note_users.setdefault(ref, set()).add(str(user_id))

    # Endpoint existence for every referenced ref (derived AND direct).
    referenced: dict[str, set[str]] = {}
    for edge in edges:
        referenced.setdefault(edge["source_scheme"], set()).add(edge["source_id"])
        referenced.setdefault(edge["target_scheme"], set()).add(edge["target_id"])
    for scheme, ref_id in chip_refs:
        referenced.setdefault(scheme, set()).add(ref_id)

    lost: set[tuple[str, str]] = set()
    for scheme, ids in sorted(referenced.items()):
        table = _SCHEME_TABLES.get(scheme)
        if table is None:
            _fail("classify", f"edge/note reference uses unknown scheme {scheme!r}")
        live: set[str] = set()
        for chunk in _chunks(sorted(ids), 500):
            live.update(
                str(row[0])
                for row in bind.execute(
                    sa.text(f"SELECT id FROM {table} WHERE id IN {_uuid_list_sql(chunk)}")  # noqa: S608
                ).fetchall()
            )
        lost.update((scheme, ref_id) for ref_id in ids - live)

    convertible: dict[tuple[str, str], _Convertible] = {}
    for scheme in _DERIVED_SCHEMES:
        for ref_id in sorted(referenced.get(scheme, ())):
            if (scheme, ref_id) in lost:
                continue
            owner = _derived_quote_and_owner(bind, scheme, ref_id)
            if owner is None:  # raced away since the existence check
                lost.add((scheme, ref_id))
                continue
            owner_scheme, owner_id, raw_quote = owner
            exact = _normalize_quote(raw_quote or "")
            if not exact:
                _abort_unconvertible(
                    bind, edges, chip_refs, scheme, ref_id, "no durable quote identity"
                )
            if owner_scheme not in ("media", "note_block"):
                _abort_unconvertible(
                    bind,
                    edges,
                    chip_refs,
                    scheme,
                    ref_id,
                    f"owner kind {owner_scheme!r}",
                )
            owner_table = "media" if owner_scheme == "media" else "note_blocks"
            owner_live = bind.execute(
                sa.text(f"SELECT 1 FROM {owner_table} WHERE id = :id"),  # noqa: S608
                {"id": owner_id},
            ).scalar()
            if not owner_live:
                _abort_unconvertible(
                    bind,
                    edges,
                    chip_refs,
                    scheme,
                    ref_id,
                    f"owner {owner_scheme}:{owner_id} is missing",
                )
            entry = _Convertible(owner_scheme=owner_scheme, owner_id=owner_id, exact=exact)
            for edge in edges:
                if (edge["source_scheme"], edge["source_id"]) == (scheme, ref_id) or (
                    edge["target_scheme"],
                    edge["target_id"],
                ) == (scheme, ref_id):
                    entry.users.add(edge["user_id"])
            entry.users.update(note_users.get((scheme, ref_id), ()))
            convertible[(scheme, ref_id)] = entry

    classification = {
        "in_scope_edges": len(edges),
        "notes_with_chips": len(notes),
        "convertible_derived_refs": len(convertible),
        "already_lost_refs": len(lost),
    }
    _report(f"classification: {classification}")
    for scheme, ref_id in sorted(lost):
        _report(f"already lost: {scheme}:{ref_id}")
    return _Inventory(
        edges=edges,
        notes=notes,
        chip_refs=chip_refs,
        convertible=convertible,
        lost=lost,
    )


# ---------------------------------------------------------------------------
# Phase 2: passage_anchors + closed-contract CHECKs + broad-index drop
# ---------------------------------------------------------------------------


def _phase2_ddl_prepare(bind) -> None:
    op.execute("""
        CREATE TABLE passage_anchors (
            id uuid NOT NULL,
            user_id uuid NOT NULL,
            owner_scheme text NOT NULL,
            owner_id uuid NOT NULL,
            selector_version smallint NOT NULL,
            anchor_key text NOT NULL,
            selector jsonb NOT NULL,
            created_at timestamptz DEFAULT now() NOT NULL,
            PRIMARY KEY (id),
            CONSTRAINT uq_passage_anchors_identity UNIQUE (
                user_id, owner_scheme, owner_id, selector_version, anchor_key
            ),
            CONSTRAINT fk_passage_anchors_user FOREIGN KEY (user_id) REFERENCES users (id)
        )
    """)

    op.execute("ALTER TABLE resource_edges DROP CONSTRAINT ck_resource_edges_origin")
    op.execute("""
        ALTER TABLE resource_edges ADD CONSTRAINT ck_resource_edges_origin CHECK (
            origin IN (
                'user', 'citation', 'system', 'note_body', 'highlight_note',
                'synapse', 'document_embed', 'assistant', 'link_note'
            )
        )
    """)
    for table, constraint, column, nullable in (
        ("resource_edges", "ck_resource_edges_source_scheme", "source_scheme", False),
        ("resource_edges", "ck_resource_edges_target_scheme", "target_scheme", False),
        (
            "resource_versions",
            "ck_resource_versions_resource_scheme",
            "resource_scheme",
            False,
        ),
        (
            "resource_view_states",
            "ck_resource_view_states_surface_scheme",
            "surface_scheme",
            False,
        ),
        (
            "resource_view_states",
            "ck_resource_view_states_target_scheme",
            "target_scheme",
            True,
        ),
        (
            "chat_run_turn_contexts",
            "ck_chat_run_turn_contexts_requested_subject_scheme",
            "requested_subject_scheme",
            True,
        ),
        (
            "chat_run_turn_contexts",
            "ck_chat_run_turn_contexts_subject_scheme",
            "subject_scheme",
            True,
        ),
    ):
        predicate = f"{column} IN {_SCHEME_LIST_SQL}"
        if nullable:
            predicate = f"{column} IS NULL OR {predicate}"
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT {constraint}")
        op.execute(f"ALTER TABLE {table} ADD CONSTRAINT {constraint} CHECK ({predicate})")

    # Dropped before any endpoint rewrite: the broad directed index would
    # collide when two derived endpoints converge onto one anchor. Its three
    # exact-predicate replacements are created after canonicalization.
    op.execute("DROP INDEX uq_resource_edges_context_pair")


# ---------------------------------------------------------------------------
# Phase 3: materialize/reuse passage anchors
# ---------------------------------------------------------------------------


def _phase3_materialize(bind, inv: _Inventory) -> dict[tuple[str, str, str], str]:
    """(user_id, scheme, ref_id) -> passage_anchor id for every convertible
    derived ref and referencing user."""

    anchor_of: dict[tuple[str, str, str], str] = {}
    identity_of: dict[tuple[str, str, str, str], str] = {}
    materialized = reused = unresolved = 0
    for (scheme, ref_id), entry in sorted(inv.convertible.items()):
        status, prefix, suffix, locator = _resolve_quote_in_owner(
            bind,
            owner_scheme=entry.owner_scheme,
            owner_id=entry.owner_id,
            exact=entry.exact,
        )
        if status != "unique":
            # Convertible but currently unresolved: the anchor is durable with
            # bare quote identity; runtime resolution stays live and explicit.
            prefix, suffix, locator = "", "", None
            unresolved += 1
        key = _anchor_key(exact=entry.exact, prefix=prefix, suffix=suffix)
        for user_id in sorted(entry.users):
            identity = (user_id, entry.owner_scheme, entry.owner_id, key)
            anchor_id = identity_of.get(identity)
            if anchor_id is None:
                anchor_id = str(uuid4())
                bind.execute(
                    sa.text(
                        "INSERT INTO passage_anchors"
                        " (id, user_id, owner_scheme, owner_id, selector_version,"
                        "  anchor_key, selector)"
                        " VALUES (:id, :user_id, :owner_scheme, :owner_id, :version,"
                        "         :anchor_key, CAST(:selector AS jsonb))"
                    ),
                    {
                        "id": anchor_id,
                        "user_id": user_id,
                        "owner_scheme": entry.owner_scheme,
                        "owner_id": entry.owner_id,
                        "version": _SELECTOR_VERSION,
                        "anchor_key": key,
                        "selector": json.dumps(
                            {
                                "quote": {
                                    "exact": entry.exact,
                                    "prefix": prefix,
                                    "suffix": suffix,
                                },
                                "locator_hint": locator,
                            }
                        ),
                    },
                )
                identity_of[identity] = anchor_id
                materialized += 1
            else:
                reused += 1
            anchor_of[(user_id, scheme, ref_id)] = anchor_id
    _report(
        f"materialized {materialized} passage anchor(s)"
        f" ({reused} identity reuse(s), {unresolved} currently-unresolved quote(s))"
    )
    return anchor_of


# ---------------------------------------------------------------------------
# Phase 4: rewrite edges + dedupe stance/note_body convergence collisions
# ---------------------------------------------------------------------------


def _phase4_rewrite_edges(
    bind, inv: _Inventory, anchor_of: dict[tuple[str, str, str], str]
) -> tuple[dict[str, str], dict[str, str]]:
    """Apply endpoint rewrites. Returns (dead, losers): dead maps a deleted
    edge id to its report reason; losers maps a redundant edge id to its
    surviving winner (deletion itself happens after view-state rebind)."""

    dead: dict[str, str] = {}
    rewritten = 0
    for edge in inv.edges:
        src = (edge["source_scheme"], edge["source_id"])
        tgt = (edge["target_scheme"], edge["target_id"])
        lost_endpoints = [f"{s}:{i}" for (s, i) in (src, tgt) if (s, i) in inv.lost]
        if lost_endpoints:
            dead[edge["id"]] = f"endpoint(s) already lost: {', '.join(lost_endpoints)}"
            continue
        new_src = src
        new_tgt = tgt
        if src[0] in _DERIVED_SCHEMES:
            new_src = ("passage_anchor", anchor_of[(edge["user_id"], *src)])
        if tgt[0] in _DERIVED_SCHEMES:
            new_tgt = ("passage_anchor", anchor_of[(edge["user_id"], *tgt)])
        if (new_src, new_tgt) == (src, tgt):
            continue
        if new_src == new_tgt:
            dead[edge["id"]] = (
                f"self edge after materialization: {src[0]}:{src[1]} and"
                f" {tgt[0]}:{tgt[1]} converge onto passage_anchor:{new_src[1]}"
            )
            continue
        bind.execute(
            sa.text(
                "UPDATE resource_edges SET source_scheme = :ss, source_id = :si,"
                " target_scheme = :ts, target_id = :ti WHERE id = :id"
            ),
            {
                "id": edge["id"],
                "ss": new_src[0],
                "si": new_src[1],
                "ts": new_tgt[0],
                "ti": new_tgt[1],
            },
        )
        edge["source_scheme"], edge["source_id"] = new_src
        edge["target_scheme"], edge["target_id"] = new_tgt
        rewritten += 1
    _report(f"rewrote {rewritten} edge endpoint pair(s) onto passage anchors")

    # Convergence can mint exact directed duplicates in the two directed
    # orderless classes the new unique indexes will protect: user stances
    # (kind-excluded slot) and note_body projections. Keep the earliest
    # (created_at, id) per identity, matching 0179's edge-winner rule.
    losers: dict[str, str] = {}
    for label, where in (
        (
            "stance",
            "origin = 'user' AND kind IN ('supports', 'contradicts')"
            " AND ordinal IS NULL AND snapshot IS NULL"
            " AND source_order_key IS NULL AND target_order_key IS NULL",
        ),
        ("note_body", "origin = 'note_body'"),
    ):
        rows = bind.execute(
            sa.text(
                "SELECT id, user_id, source_scheme, source_id, target_scheme, target_id,"
                " created_at FROM resource_edges"
                f" WHERE {where} ORDER BY created_at, id"  # noqa: S608
            )
        ).fetchall()
        groups: dict[tuple, list[tuple]] = {}
        for row in rows:
            edge_id = str(row[0])
            if edge_id in dead:
                continue
            key = (str(row[1]), row[2], str(row[3]), row[4], str(row[5]))
            groups.setdefault(key, []).append((row[6], edge_id))
        for members in groups.values():
            members.sort()
            winner = members[0][1]
            for _, loser in members[1:]:
                losers[loser] = winner
                _report(f"collapsed duplicate {label} edge {loser} into {winner}")
    return dead, losers


# ---------------------------------------------------------------------------
# Phase 5: canonicalize orderless user/context Links
# ---------------------------------------------------------------------------


def _phase5_canonicalize(
    bind, excluded: set[str]
) -> tuple[dict[str, str], list[tuple[str, tuple[str, str], tuple[str, str]]]]:
    """Group neutral Links by (user, unordered pair); keep the earliest
    (created_at, id) per group; return (losers, orientation flips)."""

    rows = bind.execute(
        sa.text(
            "SELECT id, user_id, source_scheme, source_id, target_scheme, target_id,"
            " created_at FROM resource_edges"
            " WHERE origin = 'user' AND kind = 'context' AND ordinal IS NULL"
            "   AND snapshot IS NULL AND source_order_key IS NULL"
            "   AND target_order_key IS NULL"
            " ORDER BY created_at, id"
        )
    ).fetchall()
    groups: dict[tuple, list[tuple]] = {}
    for row in rows:
        edge_id = str(row[0])
        if edge_id in excluded:
            continue
        src = (row[2], str(row[3]))
        tgt = (row[4], str(row[5]))
        pair = tuple(sorted((src, tgt)))
        groups.setdefault((str(row[1]), pair), []).append((row[6], edge_id, src, tgt))
    losers: dict[str, str] = {}
    flips: list[tuple[str, tuple[str, str], tuple[str, str]]] = []
    for (_, pair), members in sorted(groups.items()):
        members.sort()
        _, winner_id, winner_src, _ = members[0]
        for _, loser_id, _, _ in members[1:]:
            losers[loser_id] = winner_id
            _report(f"collapsed duplicate neutral Link {loser_id} into {winner_id}")
        if winner_src != pair[0]:
            flips.append((winner_id, pair[0], pair[1]))
    _report(
        f"canonicalized neutral Links: {len(losers)} duplicate(s) collapsed,"
        f" {len(flips)} orientation flip(s)"
    )
    return losers, flips


# ---------------------------------------------------------------------------
# Phase 6: view-state rebind/remap + edge deletions + orientation flips
# ---------------------------------------------------------------------------


def _phase6_view_states_and_deletes(
    bind,
    *,
    dead: dict[str, str],
    losers: dict[str, str],
    flips: list[tuple[str, tuple[str, str], tuple[str, str]]],
    anchor_of: dict[tuple[str, str, str], str],
) -> None:
    # 6a. Delete view states on winner-less dead edges; rebind loser-bound view
    # states to the winner BEFORE edge deletion (the FK is RESTRICT). A rebind
    # occurrence collision keeps the latest (updated_at, id) — 0179 phase 5.
    for chunk in _chunks(sorted(dead), 500):
        deleted = bind.execute(
            sa.text(
                f"DELETE FROM resource_view_states WHERE edge_id IN {_uuid_list_sql(chunk)}"  # noqa: S608
            )
        ).rowcount
        if deleted:
            _report(f"deleted {deleted} view state(s) bound to dead edges")
    if losers:
        edge_ids = sorted(set(losers) | set(losers.values()))
        rows: list = []
        for chunk in _chunks(edge_ids, 500):
            rows.extend(
                bind.execute(
                    sa.text(
                        "SELECT id, user_id, surface_scheme, surface_id, edge_id, updated_at"
                        f" FROM resource_view_states WHERE edge_id IN {_uuid_list_sql(chunk)}"  # noqa: S608
                    )
                ).fetchall()
            )
        groups: dict[tuple, list[dict]] = {}
        for row in rows:
            current = str(row[4])
            new_edge = losers.get(current, current)
            groups.setdefault((str(row[1]), row[2], str(row[3]), new_edge), []).append(
                {
                    "id": str(row[0]),
                    "current": current,
                    "new_edge": new_edge,
                    "updated_at": row[5],
                }
            )
        for members in groups.values():
            members.sort(key=lambda m: (m["updated_at"], m["id"]), reverse=True)
            winner = members[0]
            for member in members[1:]:
                bind.execute(
                    sa.text("DELETE FROM resource_view_states WHERE id = :id"),
                    {"id": member["id"]},
                )
            if winner["new_edge"] != winner["current"]:
                bind.execute(
                    sa.text("UPDATE resource_view_states SET edge_id = :edge WHERE id = :id"),
                    {"edge": winner["new_edge"], "id": winner["id"]},
                )

    # 6b. Delete dead and loser edges, with an exact per-edge report.
    for edge_id, reason in sorted(dead.items()):
        _report(f"deleted dead edge {edge_id}: {reason}")
    doomed = sorted(set(dead) | set(losers))
    for chunk in _chunks(doomed, 500):
        bind.execute(
            sa.text(f"DELETE FROM resource_edges WHERE id IN {_uuid_list_sql(chunk)}")  # noqa: S608
        )

    # 6c. Flip surviving winners into canonical (scheme, id) order.
    for edge_id, src, tgt in flips:
        bind.execute(
            sa.text(
                "UPDATE resource_edges SET source_scheme = :ss, source_id = :si,"
                " target_scheme = :ts, target_id = :ti WHERE id = :id"
            ),
            {"id": edge_id, "ss": src[0], "si": src[1], "ts": tgt[0], "ti": tgt[1]},
        )

    # 6d. Remap derived resource refs on view states bound to surviving
    # orderless user/note_body edges (citation and other origin motifs
    # legitimately keep derived refs; ordered adjacency is untouched).
    derived_list = "(" + ", ".join(f"'{s}'" for s in _DERIVED_SCHEMES) + ")"
    rows = bind.execute(
        sa.text(
            "SELECT vs.id, vs.user_id, vs.surface_scheme, vs.surface_id,"
            "       vs.target_scheme, vs.target_id"
            " FROM resource_view_states vs"
            " JOIN resource_edges e ON e.id = vs.edge_id"
            " WHERE e.origin IN ('user', 'note_body')"
            "   AND e.source_order_key IS NULL"
            f"   AND (vs.surface_scheme IN {derived_list}"  # noqa: S608
            f"        OR vs.target_scheme IN {derived_list})"
        )
    ).fetchall()
    for row in rows:
        state_id, user_id = str(row[0]), str(row[1])
        params: dict[str, str] = {"id": state_id}
        sets: list[str] = []
        for prefix, scheme, ref_id in (
            ("surface", row[2], str(row[3])),
            ("target", row[4], str(row[5]) if row[5] is not None else None),
        ):
            if scheme in _DERIVED_SCHEMES and ref_id is not None:
                anchor_id = anchor_of.get((user_id, scheme, ref_id))
                if anchor_id is None:
                    _fail(  # justify-defect: every surviving edge endpoint was converted above
                        "view-states",
                        f"view state {state_id} references unconverted {scheme}:{ref_id}",
                    )
                sets.append(f"{prefix}_scheme = :{prefix}_scheme, {prefix}_id = :{prefix}_id")
                params[f"{prefix}_scheme"] = "passage_anchor"
                params[f"{prefix}_id"] = anchor_id
        if sets:
            bind.execute(
                sa.text(f"UPDATE resource_view_states SET {', '.join(sets)} WHERE id = :id"),  # noqa: S608
                params,
            )
    if rows:
        _report(f"remapped {len(rows)} view state resource ref(s) onto passage anchors")


# ---------------------------------------------------------------------------
# Phase 7: note JSON rewrite + note_body text projection
# ---------------------------------------------------------------------------


def _transform_note_doc(
    node: object,
    path: str,
    *,
    anchors: dict[tuple[str, str], str],
    lost: set[tuple[str, str]],
    events: list[tuple[str, str, str]],
) -> object:
    if isinstance(node, list):
        return [
            _transform_note_doc(child, f"{path}[{idx}]", anchors=anchors, lost=lost, events=events)
            for idx, child in enumerate(node)
        ]
    if not isinstance(node, dict):
        return node
    node_type = node.get("type")
    if node_type in {"object_ref", "object_embed"} and isinstance(node.get("attrs"), dict):
        attrs = node["attrs"]
        ref = _chip_ref(node)
        if ref is not None:
            raw_ref = f"{ref[0]}:{ref[1]}"
            if ref in lost:
                label = attrs.get("label") or raw_ref
                events.append(("unwrapped", path, raw_ref))
                text_node = {"type": "text", "text": str(label)}
                if node_type == "object_ref":
                    return text_node
                return {"type": "paragraph", "content": [text_node]}
            anchor_id = anchors.get(ref)
            if anchor_id is not None:
                events.append(("rewrote", path, raw_ref))
                return {
                    **node,
                    "attrs": {
                        **attrs,
                        "objectType": "passage_anchor",
                        "objectId": anchor_id,
                    },
                }
        return node
    content = node.get("content")
    if content is None:
        return node
    return {
        **node,
        "content": _transform_note_doc(
            content,
            f"{path}.content" if path else "content",
            anchors=anchors,
            lost=lost,
            events=events,
        ),
    }


def _phase7_rewrite_notes(
    bind, inv: _Inventory, anchor_of: dict[tuple[str, str, str], str]
) -> None:
    changed_notes = 0
    for note in inv.notes:
        anchors = {
            (scheme, ref_id): anchor_id
            for (user_id, scheme, ref_id), anchor_id in anchor_of.items()
            if user_id == note["user_id"]
        }
        events: list[tuple[str, str, str]] = []
        new_doc = _transform_note_doc(
            note["doc"], "", anchors=anchors, lost=inv.lost, events=events
        )
        if new_doc == note["doc"]:
            continue
        bind.execute(
            sa.text(
                "UPDATE note_blocks SET body_pm_json = CAST(:doc AS jsonb),"
                " body_text = :body_text WHERE id = :id"
            ),
            {
                "id": note["id"],
                "doc": json.dumps(new_doc),
                "body_text": _note_text_projection(new_doc),
            },
        )
        changed_notes += 1
        for action, path, raw_ref in events:
            _report(f"note {note['id']}: {action} chip at {path} ({raw_ref})")
    _report(f"rewrote {changed_notes} note body document(s)")


# ---------------------------------------------------------------------------
# Phase 8: replacement indexes + Highlight-durability DDL
# ---------------------------------------------------------------------------

_HIGHLIGHT_FKS: tuple[tuple[str, str, str], ...] = (
    ("highlights", "user_id", "users"),
    ("highlights", "anchor_media_id", "media"),
    ("highlight_fragment_anchors", "highlight_id", "highlights"),
    ("highlight_pdf_anchors", "highlight_id", "highlights"),
    ("highlight_pdf_anchors", "media_id", "media"),
    ("highlight_pdf_quads", "highlight_id", "highlights"),
)


def _phase8_ddl_finalize(bind) -> None:
    op.execute("""
        CREATE UNIQUE INDEX uq_resource_edges_user_context_link_pair
        ON resource_edges (user_id, source_scheme, source_id, target_scheme, target_id)
        WHERE origin = 'user' AND kind = 'context' AND ordinal IS NULL
          AND snapshot IS NULL AND source_order_key IS NULL
          AND target_order_key IS NULL
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_resource_edges_user_stance_directed_pair
        ON resource_edges (user_id, source_scheme, source_id, target_scheme, target_id)
        WHERE origin = 'user' AND kind IN ('supports', 'contradicts')
          AND ordinal IS NULL AND snapshot IS NULL
          AND source_order_key IS NULL AND target_order_key IS NULL
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_resource_edges_nonuser_orderless_pair
        ON resource_edges (user_id, origin, source_scheme, source_id, target_scheme, target_id)
        WHERE origin <> 'user' AND ordinal IS NULL
          AND source_order_key IS NULL AND target_order_key IS NULL
    """)

    # The destructive fragment-anchor trigger/function pair (migration 0056)
    # and the fragment cache FK: fragments become replaceable index rows that
    # never delete authored Highlights.
    op.execute(
        "DROP TRIGGER trg_highlight_fragment_anchor_delete_core ON highlight_fragment_anchors"
    )
    op.execute("DROP FUNCTION delete_fragment_highlight_after_anchor_delete()")
    fragment_fk = _single_column_fk_name(bind, "highlight_fragment_anchors", "fragment_id")
    if fragment_fk is None:
        _fail("ddl", "highlight_fragment_anchors.fragment_id has no FK constraint to drop")
    op.execute(f"ALTER TABLE highlight_fragment_anchors DROP CONSTRAINT {fragment_fk}")

    # Recreate the six Highlight-family FKs with default non-cascading
    # (NO ACTION) behavior; deletes route through explicit child-first cleanup.
    for table, column, referenced in _HIGHLIGHT_FKS:
        name = _single_column_fk_name(bind, table, column)
        if name is None:
            _fail("ddl", f"{table}.{column} has no FK constraint to recreate")
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT {name}")
        op.execute(
            f"ALTER TABLE {table} ADD CONSTRAINT {name}"
            f" FOREIGN KEY ({column}) REFERENCES {referenced} (id)"
        )


# ---------------------------------------------------------------------------
# Phase 9: postconditions
# ---------------------------------------------------------------------------


def _phase9_postconditions(bind) -> None:
    derived_list = "(" + ", ".join(f"'{s}'" for s in _DERIVED_SCHEMES) + ")"

    # Scoped to orderless rows: ordered adjacency is a separate shape that may
    # legitimately keep derived endpoints (Invariant 4, AC21/AC22).
    residue = bind.execute(
        sa.text(
            "SELECT id FROM resource_edges"
            " WHERE origin IN ('user', 'note_body') AND source_order_key IS NULL"
            f"   AND (source_scheme IN {derived_list} OR target_scheme IN {derived_list})"  # noqa: S608
            " ORDER BY id"
        )
    ).fetchall()
    if residue:
        _fail(
            "postconditions",
            f"Link/stance/note-body edges still carry derived endpoints:"
            f" {[str(row[0]) for row in residue]}",
        )

    chip_needles = [f'"objectType": "{scheme}"' for scheme in _DERIVED_SCHEMES]
    conds = " OR ".join(f"body_pm_json::text LIKE '%' || :n{i} || '%'" for i in range(5))
    chip_residue = bind.execute(
        sa.text(f"SELECT id FROM note_blocks WHERE {conds} ORDER BY id"),  # noqa: S608
        {f"n{i}": needle for i, needle in enumerate(chip_needles)},
    ).fetchall()
    if chip_residue:
        _fail(
            "postconditions",
            f"note nodes still persist derived passage refs:"
            f" {[str(row[0]) for row in chip_residue]}",
        )

    half_motifs = bind.execute(
        sa.text(
            "SELECT source_id, count(*) FROM resource_edges WHERE origin = 'link_note'"
            " GROUP BY source_id HAVING count(*) <> 2"
        )
    ).fetchall()
    if half_motifs:
        _fail(
            "postconditions",
            f"dangling link-note motif(s): {[(str(r[0]), r[1]) for r in half_motifs]}",
        )

    dangling_states = bind.execute(
        sa.text(
            "SELECT vs.id FROM resource_view_states vs"
            " JOIN resource_edges e ON e.id = vs.edge_id"
            " WHERE e.origin IN ('user', 'note_body') AND e.source_order_key IS NULL"
            f"   AND (vs.surface_scheme IN {derived_list}"  # noqa: S608
            f"        OR vs.target_scheme IN {derived_list})"
        )
    ).fetchall()
    if dangling_states:
        _fail(
            "postconditions",
            f"view states on Link/note-body edges still carry derived refs:"
            f" {[str(row[0]) for row in dangling_states]}",
        )

    if _index_exists(bind, "uq_resource_edges_context_pair"):
        _fail("postconditions", "uq_resource_edges_context_pair survived the swap")
    for name in (
        "uq_resource_edges_user_context_link_pair",
        "uq_resource_edges_user_stance_directed_pair",
        "uq_resource_edges_nonuser_orderless_pair",
        "uq_resource_edges_source_order",
    ):
        if not _index_exists(bind, name):
            _fail("postconditions", f"index {name} is missing")

    for table, column, _ in _HIGHLIGHT_FKS:
        name = _single_column_fk_name(bind, table, column)
        if name is None:
            _fail("postconditions", f"{table}.{column} lost its FK entirely")
        if _fk_delete_rule(bind, table, name) != "a":
            _fail("postconditions", f"{table}.{column} FK is still cascading")
    if _single_column_fk_name(bind, "highlight_fragment_anchors", "fragment_id") is not None:
        _fail("postconditions", "highlight_fragment_anchors.fragment_id FK survived")


def upgrade() -> None:
    bind = op.get_bind()

    inventory = _phase1_classify(bind)
    _phase2_ddl_prepare(bind)
    anchor_of = _phase3_materialize(bind, inventory)
    dead, dedupe_losers = _phase4_rewrite_edges(bind, inventory, anchor_of)
    link_losers, flips = _phase5_canonicalize(bind, set(dead) | set(dedupe_losers))
    _phase6_view_states_and_deletes(
        bind,
        dead=dead,
        losers={**dedupe_losers, **link_losers},
        flips=flips,
        anchor_of=anchor_of,
    )
    _phase7_rewrite_notes(bind, inventory, anchor_of)
    _phase8_ddl_finalize(bind)
    _phase9_postconditions(bind)


def downgrade() -> None:
    raise NotImplementedError(
        "0184 is a hard cutover migration and has no downgrade path: derived"
        " passage endpoints were materialized into passage anchors, dead and"
        " duplicate edges/view states were deleted, and the broad context-pair"
        " index plus the destructive Highlight trigger/FKs were dropped, none"
        " of which is reconstructable."
    )
