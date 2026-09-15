"""Replace EPUB file sections with source structure and fragment-addressed cursors."""

import json
from dataclasses import replace
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit
from uuid import UUID

import sqlalchemy as sa
from alembic import op
from nexus.ids import new_uuid7
from nexus.schemas.presence import Present
from nexus.services.canonicalize import (
    canonicalize_structure,
    repair_epub_body_anchor,
    repair_historical_html_structure,
)
from nexus.services.epub_structure import (
    EpubStructureFragment,
    EpubStructureTocNode,
    build_epub_structure,
)
from nexus.services.web_article_structure import (
    add_heading_anchors,
    build_web_article_index_blocks,
)
from sqlalchemy.engine import Connection, RowMapping

revision = "0228"
down_revision = "0227"
branch_labels = None
depends_on = None

# Frozen reader1 persistence contract; Python and JavaScript both index Unicode code points.
_READER_QUOTE_EXACT_CODE_POINTS = 48
_READER_QUOTE_CONTEXT_CODE_POINTS = 24


def _repair_historical_fragment(connection: Connection, fragment: RowMapping) -> str:
    try:
        repaired = repair_historical_html_structure(
            fragment["html_sanitized"], fragment["canonical_text"]
        )
    except ValueError as exc:
        raise RuntimeError(
            f"Reader structure repair changed canonical text: {fragment['id']}"
        ) from exc
    connection.execute(
        sa.text("UPDATE fragments SET html_sanitized = :html WHERE id = :id"),
        {"id": fragment["id"], "html": repaired},
    )
    return repaired


def _repair_web_cursors(
    connection: Connection, media_id: UUID, fragments: list[RowMapping]
) -> None:
    def fail(cursor_id: UUID) -> None:
        raise RuntimeError(
            f"Reader structure repair cannot resolve stored web cursor: {cursor_id}"
        )

    def matches_quote_window(
        canonical_text: str,
        offset: int,
        quote: str,
        prefix: str | None,
        suffix: str | None,
    ) -> bool:
        if not 0 <= offset <= len(canonical_text) or not canonical_text:
            return False
        quote_start = min(
            min(offset, len(canonical_text) - 1),
            max(0, len(canonical_text) - _READER_QUOTE_EXACT_CODE_POINTS),
        )
        quote_end = min(
            len(canonical_text), quote_start + _READER_QUOTE_EXACT_CODE_POINTS
        )
        prefix_start = max(0, quote_start - _READER_QUOTE_CONTEXT_CODE_POINTS)
        suffix_end = min(
            len(canonical_text), quote_end + _READER_QUOTE_CONTEXT_CODE_POINTS
        )
        return (
            canonical_text[quote_start:quote_end] == quote
            and (canonical_text[prefix_start:quote_start] or None) == prefix
            and (canonical_text[quote_end:suffix_end] or None) == suffix
        )

    text_by_fragment = {
        str(fragment["id"]): fragment["canonical_text"] for fragment in fragments
    }
    cursors = connection.execute(
        sa.text(
            "SELECT id, locator FROM reader_media_state "
            "WHERE media_id = :media AND locator IS NOT NULL ORDER BY id"
        ),
        {"media": media_id},
    ).mappings()
    for cursor in cursors:
        cursor_id = cursor["id"]
        locator = cursor["locator"]
        if not isinstance(locator, dict) or locator.get("kind") != "web":
            fail(cursor_id)
        target = locator.get("target")
        locations = locator.get("locations")
        if not isinstance(target, dict) or not isinstance(locations, dict):
            fail(cursor_id)
        fragment_id = target.get("fragment_id")
        offset = locations.get("text_offset")
        if not isinstance(fragment_id, str) or (
            offset is not None and type(offset) is not int
        ):
            fail(cursor_id)
        canonical_text = text_by_fragment.get(fragment_id)
        if canonical_text is not None:
            if offset is not None and not 0 <= offset <= len(canonical_text):
                fail(cursor_id)
            continue
        text_context = locator.get("text")
        if type(offset) is not int or not isinstance(text_context, dict):
            fail(cursor_id)
        quote = text_context.get("quote")
        prefix = text_context.get("quote_prefix")
        suffix = text_context.get("quote_suffix")
        if (
            not isinstance(quote, str)
            or not quote
            or (prefix is not None and not isinstance(prefix, str))
            or (suffix is not None and not isinstance(suffix, str))
        ):
            fail(cursor_id)
        candidates = [
            candidate_id
            for candidate_id, candidate_text in text_by_fragment.items()
            if matches_quote_window(candidate_text, offset, quote, prefix, suffix)
        ]
        if len(candidates) != 1:
            fail(cursor_id)
        repaired = {**locator, "target": {**target, "fragment_id": candidates[0]}}
        connection.execute(
            sa.text(
                "UPDATE reader_media_state SET locator = CAST(:locator AS jsonb), "
                "revision = revision + 1, updated_at = now() WHERE id = :id"
            ),
            {"id": cursor_id, "locator": json.dumps(repaired)},
        )


def _repair_references(
    connection: Connection, media_id: UUID, retired: set[str], fragments: dict[str, int]
) -> None:
    def resource_address(scheme: str, identity: UUID) -> dict | None:
        if scheme == "evidence_span":
            query = "SELECT selector FROM evidence_spans WHERE id = :id AND owner_kind = 'media' AND owner_id = :media"
        elif scheme == "content_chunk":
            query = "SELECT summary_locator FROM content_chunks WHERE id = :id AND owner_kind = 'media' AND owner_id = :media"
        elif scheme == "passage_anchor":
            query = "SELECT selector->'locator_hint' FROM passage_anchors WHERE id = :id AND owner_scheme = 'media' AND owner_id = :media"
        else:
            return None
        return connection.scalar(sa.text(query), {"id": identity, "media": media_id})

    def citation_address(identity: UUID) -> dict | None:
        # A fragment citation can name a finer passage than its target grain.
        # Chat's retained retrieval owns that original range, not the whole file.
        row = (
            connection.execute(
                sa.text(
                    "SELECT edge.target_scheme, edge.target_id, retrieval.locator "
                    "FROM resource_edges edge LEFT JOIN message_retrievals retrieval "
                    "ON retrieval.cited_edge_id = edge.id AND retrieval.media_id = :media "
                    "WHERE edge.id = :id AND edge.origin = 'citation'"
                ),
                {"id": identity, "media": media_id},
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            return None
        if row["locator"] is not None:
            return row["locator"]
        return resource_address(row["target_scheme"], row["target_id"])

    def repair_link(link: str, locator: dict) -> str:
        parts = urlsplit(link)
        query = parse_qsl(parts.query, keep_blank_values=True)
        if not any(key == "loc" and value in retired for key, value in query) and not (
            parts.fragment.startswith("loc-") and unquote(parts.fragment[4:]) in retired
        ):
            return link
        fragment_id = locator.get("fragment_id")
        start = locator.get("start_offset")
        end = locator.get("end_offset")
        if (
            fragment_id not in fragments
            or type(start) is not int
            or type(end) is not int
            or not 0 <= start <= end <= fragments[fragment_id]
        ):
            raise RuntimeError(
                f"Reader structure repair cannot resolve stored link: {media_id}"
            )
        query = [(key, value) for key, value in query if key not in {"loc", "fragment"}]
        query.append(("fragment", fragment_id))
        target = parts.fragment
        if not target.startswith(("evidence-", "highlight-")):
            if target and not target.startswith(("fragment-", "loc-")):
                raise RuntimeError(
                    f"Reader structure repair cannot replace unrelated link fragment: {media_id}"
                )
            target = f"text-{fragment_id}:{start}:{end}"
        return urlunsplit(parts._replace(query=urlencode(query), fragment=target))

    def repair(value: dict, address: dict) -> dict:
        result = dict(value)
        if result.get("section_id") in retired:
            fragment_id = address.get("fragment_id")
            start = address.get("start_offset")
            end = address.get("end_offset")
            if (
                fragment_id not in fragments
                or type(start) is not int
                or type(end) is not int
                or not 0 <= start <= end <= fragments[fragment_id]
            ):
                raise RuntimeError(
                    f"Reader structure repair lacks an exact passage address: {media_id}"
                )
            del result["section_id"]
        for field in ("locator_hint", "locator", "context_ref"):
            nested = result.get(field)
            if isinstance(nested, dict):
                result[field] = repair(nested, nested)
        if isinstance(result.get("deep_link"), str):
            result["deep_link"] = repair_link(
                result["deep_link"],
                result["locator"]
                if isinstance(result.get("locator"), dict)
                else address,
            )
        activation = result.get("activation")
        if isinstance(activation, dict) and isinstance(activation.get("href"), str):
            result["activation"] = {
                **activation,
                "href": repair_link(
                    activation["href"],
                    result["locator"]
                    if isinstance(result.get("locator"), dict)
                    else address,
                ),
            }
        return result

    # These are owned locator columns, not arbitrary user JSON or quoted evidence.
    for table, columns, predicate in (
        (
            "content_blocks",
            ("locator", "selector", "metadata"),
            "owner_kind = 'media' AND owner_id = :media",
        ),
        (
            "content_chunks",
            ("summary_locator",),
            "owner_kind = 'media' AND owner_id = :media",
        ),
        ("evidence_spans", ("selector",), "owner_kind = 'media' AND owner_id = :media"),
        (
            "passage_anchors",
            ("selector",),
            "owner_scheme = 'media' AND owner_id = :media",
        ),
        (
            "message_retrievals",
            ("locator", "context_ref", "result_ref"),
            "media_id = :media",
        ),
    ):
        rows = connection.execute(
            sa.text(f"SELECT id, {', '.join(columns)} FROM {table} WHERE {predicate}"),
            {"media": media_id},
        ).mappings()
        for row in rows:
            for column in columns:
                value = row[column]
                if value is None:
                    continue
                address = row["locator"] if table == "content_blocks" else value
                updated = repair(value, address)
                if updated != value:
                    connection.execute(
                        sa.text(
                            f"UPDATE {table} SET {column} = CAST(:value AS jsonb) WHERE id = :id"
                        ),
                        {"id": row["id"], "value": json.dumps(updated)},
                    )
    rows = connection.execute(
        sa.text(
            "SELECT id, locator, deep_link FROM message_retrievals WHERE media_id = :media"
        ),
        {"media": media_id},
    ).mappings()
    for row in rows:
        link = row["deep_link"]
        if link is None:
            continue
        locator = row["locator"]
        updated = repair_link(link, locator if isinstance(locator, dict) else {})
        if updated != link:
            connection.execute(
                sa.text(
                    "UPDATE message_retrievals SET deep_link = :link WHERE id = :id"
                ),
                {"id": row["id"], "link": updated},
            )

    for row in connection.execute(
        sa.text(
            "SELECT id, snapshot FROM resource_edges "
            "WHERE origin = 'citation' AND snapshot ? 'deep_link'"
        )
    ).mappings():
        snapshot = row["snapshot"]
        link = snapshot["deep_link"]
        if not isinstance(link, str) or urlsplit(link).path != f"/media/{media_id}":
            continue
        address = citation_address(row["id"])
        updated = repair(snapshot, address if isinstance(address, dict) else {})
        if updated != snapshot:
            connection.execute(
                sa.text(
                    "UPDATE resource_edges SET snapshot = CAST(:value AS jsonb) WHERE id = :id"
                ),
                {"id": row["id"], "value": json.dumps(updated)},
            )

    def belongs_to_media(value: dict) -> bool:
        locator = value.get("locator")
        return value.get("media_id") == str(media_id) or (
            isinstance(locator, dict) and locator.get("fragment_id") in fragments
        )

    for row in connection.execute(
        sa.text(
            "SELECT id, result_refs, selected_context_refs FROM message_tool_calls WHERE id IN (SELECT tool_call_id FROM message_retrievals WHERE media_id = :media)"
        ),
        {"media": media_id},
    ).mappings():
        for column in ("result_refs", "selected_context_refs"):
            updated = [
                repair(value, value) if belongs_to_media(value) else value
                for value in row[column]
            ]
            if updated != row[column]:
                connection.execute(
                    sa.text(
                        f"UPDATE message_tool_calls SET {column} = CAST(:value AS jsonb) WHERE id = :id"
                    ),
                    {"id": row["id"], "value": json.dumps(updated)},
                )

    # Replay presents these typed navigation projections as current capabilities.
    # Event identity, sequence, timestamps, generated text and audit facts survive.
    for row in connection.execute(
        sa.text(
            "SELECT id, event_type, payload FROM chat_run_events WHERE event_type IN ('tool_result', 'citation_index', 'context_ref_added')"
        )
    ).mappings():
        payload = row["payload"]
        if row["event_type"] == "tool_result":
            updated = {
                **payload,
                "results": [
                    repair(value, value) if belongs_to_media(value) else value
                    for value in payload["results"]
                ],
            }
        elif row["event_type"] == "citation_index":
            citations = []
            for item in payload["citations"]:
                citation = item["citation"]
                if belongs_to_media(citation):
                    address = citation.get("locator")
                    if not isinstance(address, dict):
                        address = citation_address(UUID(item["citation_edge_id"]))
                    citation = repair(
                        citation, address if isinstance(address, dict) else {}
                    )
                citations.append({**item, "citation": citation})
            updated = {**payload, "citations": citations}
        else:
            activation = payload["activation"]
            href = activation.get("href")
            if not isinstance(href, str) or urlsplit(href).path != f"/media/{media_id}":
                continue
            reference = payload["resource_ref"]
            scheme, _, identity = reference.partition(":")
            address = resource_address(scheme, UUID(identity))
            updated = repair(payload, address if isinstance(address, dict) else {})
        if updated != payload:
            connection.execute(
                sa.text(
                    "UPDATE chat_run_events SET payload = CAST(:value AS jsonb) WHERE id = :id"
                ),
                {"id": row["id"], "value": json.dumps(updated)},
            )


def _advance_publication_generation(
    connection: Connection, media_id: UUID, expected_kind: str
) -> None:
    """Fence the repair in Alembic's transaction using only the fixed 0228 schema."""
    kind = connection.scalar(
        sa.text("SELECT kind FROM media WHERE id = :media FOR UPDATE"),
        {"media": media_id},
    )
    if kind != expected_kind:
        raise RuntimeError(
            f"Reader structure repair requires {expected_kind} media: {media_id}"
        )
    generation = connection.scalar(
        sa.text(
            """
            INSERT INTO reader_publications (id, media_id, generation, changed_at)
            VALUES (:id, :media, 1, now())
            ON CONFLICT (media_id) DO UPDATE
            SET generation = reader_publications.generation + 1, changed_at = now()
            WHERE reader_publications.generation > 0
            RETURNING generation
            """
        ),
        {"id": new_uuid7(), "media": media_id},
    )
    if generation is None:
        raise RuntimeError(
            f"Reader structure repair found a nonpositive publication generation: {media_id}"
        )


def upgrade() -> None:
    op.add_column(
        "epub_nav_locations", sa.Column("parent_section_id", sa.Text(), nullable=True)
    )
    op.add_column(
        "epub_nav_locations", sa.Column("end_fragment_idx", sa.Integer(), nullable=True)
    )
    op.alter_column("epub_nav_locations", "end_offset", nullable=True)
    op.drop_constraint(
        "ck_epub_nav_locations_source_valid", "epub_nav_locations", type_="check"
    )
    op.add_column(
        "epub_toc_nodes", sa.Column("target_offset", sa.Integer(), nullable=True)
    )
    op.drop_constraint(
        "fk_epub_nav_locations_fragment", "epub_nav_locations", type_="foreignkey"
    )
    for suffix, column in (
        ("start_fragment", "fragment_idx"),
        ("end_fragment", "end_fragment_idx"),
    ):
        op.create_foreign_key(
            f"fk_epub_nav_locations_{suffix}",
            "epub_nav_locations",
            "fragments",
            ["media_id", column],
            ["media_id", "idx"],
        )
    op.create_foreign_key(
        "fk_epub_nav_locations_parent",
        "epub_nav_locations",
        "epub_nav_locations",
        ["media_id", "parent_section_id"],
        ["media_id", "location_id"],
        deferrable=True,
        initially="DEFERRED",
    )
    connection = op.get_bind()
    media_ids = list(
        connection.scalars(
            sa.text(
                "SELECT DISTINCT media_id FROM fragments WHERE media_id IN "
                "(SELECT id FROM media WHERE kind = 'epub') ORDER BY media_id"
            )
        )
    )
    for media_id in media_ids:
        _advance_publication_generation(connection, media_id, "epub")
        fragment_rows = list(
            connection.execute(
                sa.text(
                    "SELECT f.id, f.idx, f.canonical_text, f.html_sanitized, s.package_href "
                    "FROM fragments f LEFT JOIN epub_fragment_sources s ON s.fragment_id = f.id "
                    "AND s.media_id = f.media_id WHERE f.media_id = :media ORDER BY f.idx"
                ),
                {"media": media_id},
            ).mappings()
        )
        toc_rows = list(
            connection.execute(
                sa.text(
                    "SELECT node_id, nav_type, parent_node_id, label, href, fragment_idx, depth, order_key "
                    "FROM epub_toc_nodes WHERE media_id = :media ORDER BY nav_type, order_key"
                ),
                {"media": media_id},
            ).mappings()
        )
        toc = [EpubStructureTocNode(**row) for row in toc_rows]
        fragments = []
        for row in fragment_rows:
            if row["package_href"] is None:
                raise RuntimeError(
                    f"Reader structure repair lacks EPUB source metadata: {row['id']}"
                )
            canonical = canonicalize_structure(row["html_sanitized"])
            if canonical.text != row["canonical_text"]:
                canonical = canonicalize_structure(
                    _repair_historical_fragment(connection, row)
                )
            fragments.append(
                EpubStructureFragment(
                    fragment_id=row["id"],
                    fragment_idx=row["idx"],
                    package_href=row["package_href"],
                    canonical=canonical,
                )
            )
        old_sections = list(
            connection.execute(
                sa.text(
                    "SELECT location_id, source_node_id, fragment_idx, href_path, href_fragment, source, start_offset "
                    "FROM epub_nav_locations WHERE media_id = :media"
                ),
                {"media": media_id},
            ).mappings()
        )
        by_section = {row["location_id"]: row for row in old_sections}
        by_index = {row["idx"]: row for row in fragment_rows}
        source_by_index = {
            fragment.fragment_idx: fragment.canonical for fragment in fragments
        }
        surviving_ids = {
            row["source_node_id"]: row["location_id"]
            for row in old_sections
            if row["source_node_id"] is not None and row["source"] == "toc"
        }
        for row in old_sections:
            if row["source"] != "toc" or row["source_node_id"] is not None:
                continue
            candidates = [
                node.node_id
                for node in toc
                if node.nav_type == "toc"
                and node.node_id not in surviving_ids
                and node.fragment_idx == row["fragment_idx"]
                and node.href is not None
                and unquote(node.href.split("#", 1)[1] if "#" in node.href else "")
                == (row["href_fragment"] or "")
            ]
            if len(candidates) != 1:
                raise RuntimeError(
                    f"Reader structure repair cannot identify authored section: {media_id}/{row['location_id']}"
                )
            surviving_ids[candidates[0]] = row["location_id"]
        for node in toc:
            if node.node_id not in surviving_ids or node.fragment_idx is None:
                continue
            anchor = (
                unquote(node.href.split("#", 1)[1])
                if node.href and "#" in node.href
                else ""
            )
            if not anchor or anchor in source_by_index[node.fragment_idx].anchors:
                continue
            old = by_section[surviving_ids[node.node_id]]
            fragment = by_index[node.fragment_idx]
            if (
                old["start_offset"] != 0
                or old["fragment_idx"] != node.fragment_idx
                or old["href_path"] != fragment["package_href"]
                or old["href_fragment"] != anchor
            ):
                raise RuntimeError(
                    f"Reader structure repair cannot preserve authored target: {media_id}/{node.node_id}"
                )
            html = connection.scalar(
                sa.text("SELECT html_sanitized FROM fragments WHERE id = :id"),
                {"id": fragment["id"]},
            )
            try:
                repaired = repair_epub_body_anchor(
                    html, fragment["canonical_text"], anchor
                )
            except ValueError as exc:
                raise RuntimeError(
                    f"Reader structure repair cannot preserve authored anchor: {media_id}/{node.node_id}"
                ) from exc
            connection.execute(
                sa.text("UPDATE fragments SET html_sanitized = :html WHERE id = :id"),
                {"id": fragment["id"], "html": repaired},
            )
            canonical = canonicalize_structure(repaired)
            source_by_index[node.fragment_idx] = canonical
            fragments = [
                replace(item, canonical=canonical)
                if item.fragment_idx == node.fragment_idx
                else item
                for item in fragments
            ]
        sections = build_epub_structure(
            media_id=media_id,
            fragments=fragments,
            toc_nodes=toc,
            existing_location_ids=surviving_ids,
        )
        if not set(surviving_ids.values()) <= {
            section.location_id for section in sections
        }:
            raise RuntimeError(
                f"Reader structure repair lost authored section identity: {media_id}"
            )
        retired = {
            row["location_id"] for row in old_sections if row["source"] == "spine"
        }
        cursors = connection.execute(
            sa.text(
                "SELECT id, locator FROM reader_media_state WHERE media_id = :media AND locator IS NOT NULL"
            ),
            {"media": media_id},
        ).mappings()
        for cursor in cursors:
            locator = cursor["locator"]
            target = locator["target"]
            section = by_section.get(target.get("section_id"))
            if (
                locator["kind"] != "epub"
                or section is None
                or section["fragment_idx"] not in by_index
            ):
                raise RuntimeError(
                    f"Reader structure repair cannot resolve accepted cursor: {cursor['id']}"
                )
            fragment = by_index[section["fragment_idx"]]
            if target["href_path"] != fragment["package_href"]:
                raise RuntimeError(
                    f"Reader structure repair found contradictory cursor source: {cursor['id']}"
                )
            anchor = target["anchor_id"]
            offset = locator["locations"]["text_offset"]
            if (
                anchor is None
                and all(value is None for value in locator["locations"].values())
                and all(value is None for value in locator["text"].values())
            ):
                # The old manual, unanchored navigation opened the whole
                # fragment at scrollTop=0, regardless of its section label.
                locator["locations"] = {**locator["locations"], "text_offset": 0}
                offset = 0
            if (
                offset is None
                and anchor not in source_by_index[section["fragment_idx"]].anchors
            ) or (
                offset is not None
                and (
                    type(offset) is not int
                    or not 0 <= offset <= len(fragment["canonical_text"])
                )
            ):
                raise RuntimeError(
                    f"Reader structure repair cannot resolve accepted cursor locus: {cursor['id']}"
                )
            locator["target"] = {
                "fragment_id": str(fragment["id"]),
                "href_path": target["href_path"],
                "anchor_id": {"kind": "Absent"}
                if anchor is None
                else {"kind": "Present", "value": anchor},
            }
            connection.execute(
                sa.text(
                    "UPDATE reader_media_state SET locator = CAST(:locator AS jsonb), "
                    "revision = revision + 1, updated_at = now() WHERE id = :id"
                ),
                {"id": cursor["id"], "locator": json.dumps(locator)},
            )
        _repair_references(
            connection,
            media_id,
            retired,
            {str(row["id"]): len(row["canonical_text"]) for row in fragment_rows},
        )

        connection.execute(
            sa.text("DELETE FROM epub_nav_locations WHERE media_id = :media"),
            {"media": media_id},
        )
        for ordinal, section in enumerate(sections):
            connection.execute(
                sa.text(
                    "INSERT INTO epub_nav_locations (media_id, location_id, ordinal, source_node_id, "
                    "parent_section_id, label, fragment_idx, href_path, href_fragment, start_offset, "
                    "end_fragment_idx, end_offset, source) VALUES (:media, :id, :ordinal, :source_node, "
                    ":parent, :label, :fragment, :href, :anchor, :start, :end_fragment, :end, :source)"
                ),
                {
                    "media": media_id,
                    "id": section.location_id,
                    "ordinal": ordinal,
                    "source_node": section.source_node_id.value
                    if isinstance(section.source_node_id, Present)
                    else None,
                    "parent": section.parent_section_id.value
                    if isinstance(section.parent_section_id, Present)
                    else None,
                    "label": section.label,
                    "fragment": section.fragment_idx,
                    "href": section.href_path,
                    "anchor": section.href_fragment.value
                    if isinstance(section.href_fragment, Present)
                    else None,
                    "start": section.start_offset,
                    "end_fragment": section.end.value.fragment_idx
                    if isinstance(section.end, Present)
                    else None,
                    "end": section.end.value.offset
                    if isinstance(section.end, Present)
                    else None,
                    "source": section.source,
                },
            )
        for node in toc:
            connection.execute(
                sa.text(
                    "UPDATE epub_toc_nodes SET target_offset = :offset WHERE media_id = :media AND node_id = :id"
                ),
                {
                    "media": media_id,
                    "id": node.node_id,
                    "offset": node.target_offset,
                },
            )

    web_media = (
        connection.execute(
            sa.text(
                "SELECT id, title FROM media WHERE kind = 'web_article' AND ("
                "EXISTS (SELECT 1 FROM fragments WHERE media_id = media.id) OR "
                "EXISTS (SELECT 1 FROM reader_media_state WHERE media_id = media.id "
                "AND locator IS NOT NULL)) ORDER BY id"
            )
        )
        .mappings()
        .all()
    )
    for media in web_media:
        _advance_publication_generation(connection, media["id"], "web_article")
        fragments = list(
            connection.execute(
                sa.text(
                    "SELECT id, idx, canonical_text, html_sanitized FROM fragments "
                    "WHERE media_id = :media ORDER BY idx"
                ),
                {"media": media["id"]},
            ).mappings()
        )
        _repair_web_cursors(connection, media["id"], fragments)
        specs = {}
        for fragment in fragments:
            html = fragment["html_sanitized"]
            if canonicalize_structure(html).text != fragment["canonical_text"]:
                html = _repair_historical_fragment(connection, fragment)
                if add_heading_anchors(html, fragment_idx=fragment["idx"]) != html:
                    raise RuntimeError(
                        f"Reader structure repair changed web heading identity: {fragment['id']}"
                    )
            for spec in build_web_article_index_blocks(
                html_sanitized=html,
                canonical_text=fragment["canonical_text"],
                fragment_idx=fragment["idx"],
            ):
                specs[(str(fragment["id"]), spec.start_offset, spec.end_offset)] = spec

        for block in connection.execute(
            sa.text(
                "SELECT id, locator, selector, metadata FROM content_blocks WHERE owner_kind = 'media' AND owner_id = :media ORDER BY block_idx"
            ),
            {"media": media["id"]},
        ).mappings():
            locator = block["locator"]
            key = (
                locator.get("fragment_id"),
                locator.get("start_offset"),
                locator.get("end_offset"),
            )
            if key not in specs:
                raise RuntimeError(
                    f"Reader structure repair cannot locate web block: {block['id']}"
                )
            spec = specs[key]
            updates = {}
            for column in ("locator", "selector", "metadata"):
                value = dict(block[column])
                for field in (
                    "section_id",
                    "anchor_id",
                    "heading_level",
                    "depth",
                    "ordinal",
                    "parent_section_id",
                    "owns_container",
                    "container_end_offset",
                ):
                    value.pop(field, None)
                if spec.section_id is not None:
                    value["section_id"] = spec.section_id
                if spec.anchor_id is not None:
                    value["anchor_id"] = spec.anchor_id
                if spec.heading_level is not None:
                    value["heading_level"] = spec.heading_level
                if column == "metadata":
                    if spec.depth is not None:
                        value["depth"] = spec.depth
                    if spec.ordinal is not None:
                        value["ordinal"] = spec.ordinal
                else:
                    if spec.section_id is not None:
                        value["parent_section_id"] = spec.parent_section_id.model_dump(
                            mode="json"
                        )
                        value["owns_container"] = spec.owns_container
                    if isinstance(spec.container_end_offset, Present):
                        value["container_end_offset"] = spec.container_end_offset.value
                updates[column] = json.dumps(value)
            connection.execute(
                sa.text(
                    "UPDATE content_blocks SET block_kind = :kind, heading_path = CAST(:path AS jsonb), locator = CAST(:locator AS jsonb), selector = CAST(:selector AS jsonb), metadata = CAST(:metadata AS jsonb) WHERE id = :id"
                ),
                {
                    "id": block["id"],
                    "kind": spec.block_kind,
                    "path": json.dumps(spec.heading_path),
                    **updates,
                },
            )


def downgrade() -> None:
    raise NotImplementedError(
        "0228 preserves accepted cursor identities; its hard cut is irreversible"
    )
