"""One resource-reference contract and immutable evidence, wire 4.

Writers must be stopped. Convert every saved quote, ordinal citation and retrieval;
keep identities and exact captured text, never consult current highlights for history.
Old citation locators come only from their saved retrieval provenance. Unknown source
metadata and location proof become explicit null/unavailable. Search emphasis is
removed only when saved unmarked locator evidence proves those exact injected tags.
Oracle inline facts are promoted to canonical ordinal edges; conflicting identity
refuses the transaction. Context-added events become identity facts. Existing runs
get no admitted context version and cannot add context automatically.
Uncitable named retrievals retain their saved identity; saved contributor handles
resolve only to their immutable id. Missing or conflicting identities refuse the
transaction. That lookup never supplies historical words, attribution or location.
Old note/message offsets without a captured full-range selector (or the note's
captured body version) become unavailable; a truncated preview cannot prove extent.

Irreversible: restore the release backup for wire 3. No compatibility reader remains.
"""

import re
from collections.abc import Sequence
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB


revision = "0289"
down_revision: str | Sequence[str] | None = "0288"
branch_labels = None
depends_on = None


def _owner(
    locator: dict | None, target: str | None, deep_link: str | None
) -> str | None:
    if locator:
        if locator.get("media_id"):
            return f"media:{locator['media_id']}"
        if locator.get("block_id"):
            return f"note_block:{locator['block_id']}"
        if locator.get("conversation_id"):
            return f"conversation:{locator['conversation_id']}"
        if (
            locator.get("type") == "external_url"
            and target
            and target.startswith("external_snapshot:")
        ):
            return target
    if target and target.split(":", 1)[0] in (
        "media",
        "note_block",
        "page",
        "conversation",
        "library",
        "podcast",
        "contributor",
        "artifact",
        "artifact_revision",
        "oracle_reading",
        "external_snapshot",
    ):
        return target
    match = re.match(
        r"^/(media|notes|conversations)/([0-9a-f-]{36})(?:[?#]|$)", deep_link or ""
    )
    if match:
        UUID(match[2])
        scheme = {
            "media": "media",
            "notes": "note_block",
            "conversations": "conversation",
        }[match[1]]
        return f"{scheme}:{match[2]}"

    return None


def _locator(raw: dict) -> dict:
    """Frozen 0289 locator grammar, independent of later application schemas."""
    defaults = {
        "web_text_offsets": {"media_kind": None, "text_quote_selector": None},
        "epub_fragment_offsets": {
            "section_id": None,
            "media_kind": None,
            "text_quote_selector": None,
        },
        "note_block_offsets": {"text_quote_selector": None, "body_version": None},
        "message_offsets": {"message_seq": None, "text_quote_selector": None},
        "pdf_page_geometry": {
            "prefix": None,
            "suffix": None,
            "text_quote_selector": None,
            "projection": None,
        },
        "pdf_page": {},
        "transcript_time_range": {"text_quote_selector": None},
        "audio_time_range": {},
        "video_time_range": {},
        "external_url": {"title": None, "display_url": None, "accessed_at": None},
    }
    required = {
        "web_text_offsets": {"media_id", "fragment_id", "start_offset", "end_offset"},
        "epub_fragment_offsets": {
            "media_id",
            "fragment_id",
            "start_offset",
            "end_offset",
        },
        "note_block_offsets": {"block_id", "start_offset", "end_offset"},
        "message_offsets": {
            "conversation_id",
            "message_id",
            "start_offset",
            "end_offset",
        },
        "pdf_page_geometry": {"media_id", "page_number", "quads", "exact"},
        "pdf_page": {"media_id", "page_number"},
        "transcript_time_range": {"media_id", "t_start_ms", "t_end_ms"},
        "audio_time_range": {"media_id", "t_start_ms", "t_end_ms"},
        "video_time_range": {"media_id", "t_start_ms", "t_end_ms"},
        "external_url": {"url"},
    }
    kind = raw.get("type")
    if (
        kind not in required
        or not required[kind] <= raw.keys()
        or raw.keys() - required[kind] - defaults[kind].keys() - {"type"}
    ):
        raise ValueError(f"Unrecognized frozen locator {kind}")
    for key in ("media_id", "fragment_id", "block_id", "conversation_id", "message_id"):
        if raw.get(key) is not None:
            UUID(raw[key])
    for start, end in (("start_offset", "end_offset"), ("t_start_ms", "t_end_ms")):
        if start in raw and (
            not isinstance(raw[start], int)
            or not isinstance(raw[end], int)
            or not 0 <= raw[start] < raw[end]
        ):
            raise ValueError(f"Invalid frozen {kind} range")
    return defaults[kind] | raw


def _evidence(
    *,
    exact: str | None,
    title: str | None,
    target: str | None,
    locator: dict | None,
    deep_link: str | None = None,
    location_label: str | None = None,
    prefix: str | None = None,
    suffix: str | None = None,
    color: str | None = None,
    contributors: list | None = None,
    media_kind: str | None = None,
) -> dict:
    owner = _owner(locator, target, deep_link)
    quote = (
        None
        if exact is None
        else {"exact": exact, "prefix": prefix, "suffix": suffix, "color": color}
    )
    # The saved locator is the only historical extent. It is never reconstructed
    # from today's highlight, evidence span or content chunk.
    captured_target = {"kind": "unavailable", "owner_ref": owner}
    if exact is None and owner is not None:
        captured_target = {"kind": "resource", "owner_ref": owner}
    elif locator is not None and owner is not None:
        locator = _locator(locator)
        for key in (
            ("text_quote_selector", "body_version")
            if locator["type"] == "note_block_offsets"
            else ("text_quote_selector",)
            if locator["type"] == "message_offsets"
            else ()
        ):
            locator.setdefault(key, None)
        precision = (
            "time"
            if locator["type"]
            in ("transcript_time_range", "audio_time_range", "video_time_range")
            else "approximate"
            if locator.get("projection") == "proportional_text_offsets"
            else "page"
            if locator["type"] == "pdf_page"
            else "exact"
        )
        full_selector = bool((locator.get("text_quote_selector") or {}).get("exact"))
        proven = (
            full_selector or locator.get("body_version") is not None
            if locator["type"] == "note_block_offsets"
            else full_selector
            if locator["type"] == "message_offsets"
            else True
        )
        if proven:
            captured_target = {
                "kind": "passage",
                "owner_ref": owner,
                "locator": locator,
                "precision": precision,
                "source_identity": None,
            }
    return {
        "quote": quote,
        "source": {
            "ref": owner,
            "title": title,
            "media_kind": media_kind,
            "contributors": contributors,
            "location_label": location_label,
        },
        "target": captured_target,
    }


def _plain_proven(exact: str | None, locator: dict | None) -> str | None:
    if exact is None or "<b>" not in exact or locator is None:
        return exact
    known = (locator.get("text_quote_selector") or {}).get("exact")
    if not isinstance(known, str) or exact in known:
        return exact
    plain = re.sub(r"</?b>", "", exact)
    return plain if plain in known else exact


def _retrieval_ref(conn, row) -> str | None:
    """Recover only a saved named identity; never fetch historical display facts."""
    result = row["result_ref"]
    if result.get("citation_target") is not None:
        return result["citation_target"]
    kind = result["type"]
    schemes = {
        "media": "media",
        "episode": "media",
        "video": "media",
        "podcast": "podcast",
        "page": "page",
        "conversation": "conversation",
        "contributor": "contributor",
    }
    if kind not in schemes:
        return None
    identity = str(result["id"])
    if (
        row["result_type"] != kind
        or str(row["source_id"]) != identity
        or str(result["source_id"]) != identity
        or str(result["context_ref"]["id"]) != identity
    ):
        raise ValueError(f"Retrieval {row['id']} has conflicting saved named identity")
    if kind == "contributor":
        if result["contributor_handle"] != identity:
            raise ValueError(
                f"Retrieval {row['id']} has conflicting contributor identity"
            )
        found = conn.execute(
            sa.text("SELECT id FROM contributors WHERE handle=:handle"),
            {"handle": identity},
        ).scalar_one_or_none()
        if found is None:
            raise ValueError(
                f"Retrieval {row['id']} has an unresolvable contributor handle"
            )
        identity = str(found)
    else:
        identity = str(UUID(identity))
    return f"{schemes[kind]}:{identity}"


def _update(conn, table: str, column: str, id_, value) -> None:
    conn.execute(
        sa.text(f"UPDATE {table} SET {column}=:value WHERE id=:id").bindparams(
            sa.bindparam("value", type_=JSONB)
        ),
        {"id": id_, "value": value},
    )


def upgrade() -> None:
    conn = op.get_bind()
    op.drop_constraint("ck_resource_versions_lane", "resource_versions", type_="check")
    op.create_check_constraint(
        "ck_resource_versions_lane",
        "resource_versions",
        "lane IN ('title','body','links','context')",
    )
    op.add_column(
        "chat_runs", sa.Column("admitted_context_version", sa.Integer(), nullable=True)
    )
    op.add_column(
        "message_retrievals", sa.Column("captured_evidence", JSONB, nullable=True)
    )
    retrieved = {}
    for row in conn.execute(
        sa.text("SELECT * FROM message_retrievals ORDER BY id")
    ).mappings():
        result = row["result_ref"]
        target = _retrieval_ref(conn, row)
        locator = row["locator"]
        exact = _plain_proven(row["exact_snippet"], locator)
        selector = (locator or {}).get("text_quote_selector") or {}
        same_quote = selector.get("exact") == exact
        evidence = _evidence(
            exact=exact,
            prefix=selector.get("prefix") if same_quote else None,
            suffix=selector.get("suffix") if same_quote else None,
            color=result.get("color") if result.get("exact") == exact else None,
            title=row["source_title"],
            target=target,
            locator=locator,
            deep_link=row["deep_link"],
            location_label=row["section_label"],
            contributors=result.get("contributors"),
            media_kind=result.get("media_kind"),
        )
        if target is None and evidence["target"]["owner_ref"] is None:
            raise ValueError(
                f"Retrieval {row['id']} has no recoverable resource identity"
            )
        _update(conn, "message_retrievals", "captured_evidence", row["id"], evidence)
        if row["cited_edge_id"] is not None:
            previous = retrieved.get(row["cited_edge_id"])
            if previous is not None and any(
                previous[key] != row[key]
                for key in (
                    "locator",
                    "exact_snippet",
                    "assistant_message_id",
                    "result_ref",
                )
            ):
                raise ValueError(
                    f"Citation {row['cited_edge_id']} has conflicting saved provenance"
                )
            retrieved[row["cited_edge_id"]] = dict(row)
    op.alter_column("message_retrievals", "captured_evidence", nullable=False)
    for row in conn.execute(
        sa.text(
            "SELECT id,reader_selection_snapshot FROM messages WHERE reader_selection_snapshot IS NOT NULL"
        )
    ).mappings():
        old = row["reader_selection_snapshot"]
        if set(old) != {"key", "source_label", "exact", "prefix", "suffix", "locator"}:
            raise ValueError(f"Unrecognized reader quote shape on {row['id']}")
        evidence = _evidence(
            exact=old["exact"],
            title=old["source_label"],
            target=f"highlight:{old['key']['highlight_id']}",
            locator=old["locator"],
            prefix=old["prefix"],
            suffix=old["suffix"],
        )
        _update(
            conn,
            "messages",
            "reader_selection_snapshot",
            row["id"],
            {"key": old["key"], "evidence": evidence},
        )
    for row in conn.execute(
        sa.text("SELECT * FROM resource_edges WHERE snapshot IS NOT NULL ORDER BY id")
    ).mappings():
        old = row["snapshot"]
        if set(old) - {"title", "excerpt", "section_label", "result_type", "deep_link"}:
            raise ValueError(f"Unrecognized edge snapshot shape on {row['id']}")
        if row["ordinal"] is None:
            if row["origin"] not in ("assistant", "discovery") or not old.get(
                "excerpt"
            ):
                raise ValueError(
                    f"Noncitation snapshot without rationale on {row['id']}"
                )
            snapshot = {"evidence": None, "rationale": old["excerpt"]}
        else:
            provenance = retrieved.get(row["id"])
            if provenance is not None and (
                row["source_scheme"] != "message"
                or row["source_id"] != provenance["assistant_message_id"]
                or provenance["result_ref"].get("citation_target")
                != f"{row['target_scheme']}:{row['target_id']}"
                or old.get("excerpt") != provenance["exact_snippet"]
            ):
                raise ValueError(
                    f"Citation {row['id']} disagrees with its saved retrieval provenance"
                )
            locator = provenance["locator"] if provenance else None
            exact = old.get("excerpt")
            if provenance and exact == provenance["exact_snippet"]:
                exact = _plain_proven(exact, locator)
            selector = (locator or {}).get("text_quote_selector") or {}
            same_quote = selector.get("exact") == exact
            result = provenance["result_ref"] if provenance else {}
            evidence = _evidence(
                exact=exact,
                prefix=selector.get("prefix") if same_quote else None,
                suffix=selector.get("suffix") if same_quote else None,
                color=result.get("color") if result.get("exact") == exact else None,
                title=old.get("title"),
                target=f"{row['target_scheme']}:{row['target_id']}",
                locator=locator,
                deep_link=old.get("deep_link"),
                location_label=old.get("section_label"),
            )
            snapshot = {"evidence": evidence, "rationale": None}
        _update(
            conn,
            "resource_edges",
            "snapshot",
            row["id"],
            snapshot,
        )
    for row in conn.execute(
        sa.text(
            "SELECT id,user_id,passages FROM oracle_readings WHERE jsonb_array_length(passages)>0"
        )
    ).mappings():
        passages = []
        seen_ordinals = set()
        for passage in row["passages"]:
            facts = passage.get("citation")
            ordinal = passage.get("ordinal")
            if facts is not None:
                ordinal = ordinal or facts["ordinal"]
                if ordinal != facts["ordinal"]:
                    raise ValueError(
                        f"Conflicting oracle citation ordinal on {row['id']}"
                    )
                target = facts["target_ref"]
                existing = conn.execute(
                    sa.text(
                        "SELECT id,target_scheme,target_id,kind,snapshot FROM resource_edges WHERE source_scheme='oracle_reading' AND source_id=:source AND origin='citation' AND ordinal=:ordinal"
                    ),
                    {"source": row["id"], "ordinal": ordinal},
                ).one_or_none()
                if existing and (existing.target_scheme, str(existing.target_id)) != (
                    target["type"],
                    target["id"],
                ):
                    raise ValueError(
                        f"Conflicting oracle citation target on {row['id']}"
                    )
                old = facts.get("snapshot") or {}
                evidence = _evidence(
                    exact=old.get("excerpt", passage["quote"]),
                    title=old.get("title"),
                    target=f"{target['type']}:{target['id']}",
                    locator=None,
                    deep_link=facts.get("deep_link"),
                    location_label=old.get("section_label"),
                )
                snapshot = {"evidence": evidence, "rationale": None}
                if existing:
                    captured = existing.snapshot["evidence"]
                    if (
                        existing.kind != facts["role"]
                        or captured["quote"] != evidence["quote"]
                        or any(
                            evidence["source"][key] is not None
                            and captured["source"][key] != evidence["source"][key]
                            for key in (
                                "ref",
                                "title",
                                "media_kind",
                                "contributors",
                                "location_label",
                            )
                        )
                    ):
                        raise ValueError(
                            f"Conflicting oracle captured evidence on {row['id']} ordinal {ordinal}"
                        )
                    # Compatible inline facts cannot erase the edge's reliable extent.

                else:
                    conn.execute(
                        sa.text("""INSERT INTO resource_edges(id,user_id,source_scheme,source_id,target_scheme,target_id,kind,origin,ordinal,snapshot)
                        VALUES(:id,:user_id,'oracle_reading',:source,:target_scheme,:target_id,:kind,'citation',:ordinal,:snapshot)""").bindparams(
                            sa.bindparam("snapshot", type_=JSONB)
                        ),
                        {
                            "id": uuid4(),
                            "user_id": row["user_id"],
                            "source": row["id"],
                            "target_scheme": target["type"],
                            "target_id": UUID(target["id"]),
                            "kind": facts["role"],
                            "ordinal": ordinal,
                            "snapshot": snapshot,
                        },
                    )
            if ordinal is not None:
                if ordinal in seen_ordinals:
                    raise ValueError(f"Repeated oracle citation ordinal on {row['id']}")
                seen_ordinals.add(ordinal)
            passages.append(
                {key: value for key, value in passage.items() if key != "citation"}
                | {"ordinal": ordinal}
            )
        _update(conn, "oracle_readings", "passages", row["id"], passages)
    conn.execute(
        sa.text(
            "UPDATE chat_run_events SET payload=payload-'label'-'missing' WHERE event_type='context_ref_added'"
        )
    )


def downgrade() -> None:
    raise RuntimeError("0289 is a hard cutover; restore the pre-migration backup")
