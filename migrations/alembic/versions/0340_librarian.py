"""Replace conversation trees and captured chat sources with account timelines.

Preserve accounts, literal messages, pairs, dates, receipts, authored identities
and immutable change bytes. Flatten supported parent trees in admission order;
parent references retain their meaning. Convert typed references before dropping
conversation ownership. Discard derived selections and obsolete chat source copies.
Preserve source-edge lookup indexing; serializable edge writers own bare-pair
uniqueness after the obsolete source-order indexes are removed.
Requires stopped writers, drained replicas and the verified backup. Devices 4/5
reprovision from a fenced format-6 snapshot without changing source counters.
"""

import base64
import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0340"
down_revision = "0339"
branch_labels = None
depends_on = None

# Owner-approved removal: these four already-deleted conversations have no
# surviving message anchor. Their four links and stubs are the only exception.
_REMOVED_CONVERSATIONS = {
    "conversation:cff334ed-0534-4b3b-bcf7-70841ede9d86",
    "conversation:63bbb466-ca09-4f57-8692-b15db852c616",
    "conversation:3dbc3f00-2305-4bcd-aecb-51d80e470f3e",
    "conversation:c10cde0c-bb19-4859-a5ac-a4e57d3a06b5",
}
_REMOVED_LINKS = {
    "001ef0d2-e058-470a-bb5b-3fb88f5f096e",
    "5c87effc-dbe4-43e3-a324-545f5584be60",
    "9156f53c-1cd3-4a8f-8ace-d7d619611342",
    "e77a6d47-cc88-4e15-ae67-a60aada201d4",
}


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _require(condition, record, reason):
    if not condition:
        raise RuntimeError(
            f"0340 {record}: {reason}; repair this record before retrying"
        )


def _ref(value, mapping):
    if isinstance(value, str) and value.startswith("conversation:"):
        _require(value in mapping, value, "linked empty or unknown conversation")
        return mapping[value]
    return value


def _href(value, mapping):
    if value in ("/conversations", "/conversations/new"):
        return "/librarian"
    match = re.fullmatch(
        r"/conversations/([0-9a-f-]{36})(?:\?[^#]*)?(?:#message-([0-9a-f-]{36}))?",
        value,
    )
    if match is None:
        _require(
            not value.startswith("/conversations/"),
            value,
            "unsupported conversation destination",
        )
        return value
    target = mapping.get(f"conversation:{match[1]}")
    anchors = parse_qs(urlsplit(value).query).get("message", [])
    _require(len(anchors) <= 1, value, "ambiguous message destination")
    anchor = anchors[0] if anchors else match[2]
    _require(
        anchor is None or re.fullmatch(r"[0-9a-f-]{36}", anchor),
        value,
        "invalid message destination",
    )
    if anchor is not None:
        return f"/librarian?message={anchor}"
    return "/librarian" if target is None else f"/librarian?message={target[8:]}"


def _typed(value, mapping):
    """Convert typed identities only. Literal source and authored prose never change."""
    if isinstance(value, list):
        return [_typed(item, mapping) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        if key == "conversation_id" and value.get("type") == "message_offsets":
            continue
        if key in (
            "resource_ref",
            "owner_ref",
            "source_ref",
            "target_ref",
            "endpoint_a",
            "endpoint_b",
            "ref",
        ):
            result[key] = _ref(item, mapping)
        elif key == "href" and isinstance(item, str):
            result[key] = _href(item, mapping)
        elif (
            key == "secondary"
            and isinstance(item, dict)
            and item.get("active_surface_id") == "resource-forks"
        ):
            result[key] = None
        else:
            result[key] = _typed(item, mapping)
    locator = result.get("locator")
    if (
        isinstance(locator, dict)
        and locator.get("type") == "message_offsets"
        and "owner_ref" in result
    ):
        result["owner_ref"] = f"message:{locator['message_id']}"
    if "source_ref" in result and isinstance(result.get("capture"), dict):
        locator = result["capture"].get("value", {}).get("locator")
        if isinstance(locator, dict) and locator.get("type") == "message_offsets":
            result["source_ref"] = f"message:{locator['message_id']}"
    return result


def _live(evidence, mapping, record):
    target = evidence["target"]
    owner = _ref(target.get("owner_ref"), mapping)
    _require(owner is not None, record, "captured source has no surviving identity")
    field = target.get("field")
    raw = target.get("locator")
    locator = None
    if raw is not None:
        kind = raw["type"]
        if kind in ("web_text_offsets", "epub_fragment_offsets", "x_capture_offsets"):
            locator = {
                "kind": "EpubTextOffsets"
                if kind == "epub_fragment_offsets"
                else "WebTextOffsets",
                "fragment_id": raw["fragment_id"],
                "start_offset": raw["start_offset"],
                "end_offset": raw["end_offset"],
            }
            if kind == "x_capture_offsets":
                owner = f"fragment:{raw['fragment_id']}"
        elif kind in (
            "message_offsets",
            "note_block_offsets",
            "highlight_annotation_offsets",
        ):
            locator = {
                "kind": "TextOffsets",
                "start_offset": raw["start_offset"],
                "end_offset": raw["end_offset"],
            }
            if kind == "message_offsets":
                owner = f"message:{raw['message_id']}"
        elif kind in ("transcript_time_range", "audio_time_range", "video_time_range"):
            locator = {
                "kind": "TimeRange",
                "start_ms": raw["t_start_ms"],
                "end_ms": raw["t_end_ms"],
            }
        elif kind in ("pdf_page", "pdf_page_geometry"):
            locator = {
                "kind": "PdfPage" if kind == "pdf_page" else "PdfPageGeometry",
                "page_number": raw["page_number"],
            }
            if kind == "pdf_page_geometry":
                locator["quads"] = raw["quads"]
        else:
            _require(False, record, f"unsupported source coordinates {kind}")
    return {"resource_ref": owner, "field": field, "locator": locator}


def _bodies(db, mapping):
    rows = list(
        db.execute(
            sa.text("""SELECT r.account_id,r.ref,r.merge_bytes,
        CASE r.state->>'kind' WHEN 'note' THEN n.body_pm_json ELSE h.annotation_body_pm_json END AS projection
        FROM authored_resources r
        LEFT JOIN note_blocks n ON r.ref='note_block:'||n.id::text
        LEFT JOIN highlights h ON r.ref='highlight:'||h.id::text
        WHERE r.state->>'kind' IN ('note','highlight') ORDER BY r.account_id,r.ref""")
        ).mappings()
    )
    converted = []
    for start in range(0, len(rows), 100):
        batch = rows[start : start + 100]
        payload = {
            "mapping": mapping,
            "bodies": [
                {
                    "ref": row["ref"],
                    "state": base64.urlsafe_b64encode(row["merge_bytes"])
                    .decode()
                    .rstrip("="),
                    "projection": row["projection"],
                }
                for row in batch
            ],
        }
        process = subprocess.run(
            [
                "node",
                "--max-old-space-size=256",
                str(Path(__file__).with_suffix(".mjs")),
            ],
            input=_json(payload),
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
        )
        _require(process.returncode == 0, "authored bodies", process.stderr.strip())
        converted.extend(
            (row, body)
            for row, body in zip(
                batch, json.loads(process.stdout)["bodies"], strict=True
            )
            if body["changed"]
        )
    return converted


def upgrade() -> None:
    db = op.get_bind()
    db.execute(
        sa.text("SELECT account_id FROM authored_heads ORDER BY account_id FOR UPDATE")
    ).all()
    messages = {
        row["id"]: dict(row)
        for row in db.execute(
            sa.text("SELECT * FROM messages ORDER BY conversation_id,seq")
        ).mappings()
    }
    chats = {
        row["id"]: row["owner_user_id"]
        for row in db.execute(
            sa.text("SELECT id,owner_user_id FROM conversations")
        ).mappings()
    }
    runs = list(db.execute(sa.text("SELECT * FROM chat_runs ORDER BY id")).mappings())
    used = set()
    per_account = defaultdict(list)
    mapping = {}
    for message in messages.values():
        conversation = message["conversation_id"]
        _require(conversation in chats, message["id"], "unowned message")
        if message["role"] == "user":
            mapping.setdefault(
                f"conversation:{conversation}", f"message:{message['id']}"
            )
        parent = message["parent_message_id"]
        if parent is not None:
            _require(
                parent in messages
                and messages[parent]["conversation_id"] == conversation
                and messages[parent]["seq"] < message["seq"],
                message["id"],
                "parent is missing, foreign or cyclic",
            )
    for run in runs:
        question, answer = (
            messages.get(run["user_message_id"]),
            messages.get(run["assistant_message_id"]),
        )
        _require(
            run["status"] in ("complete", "error", "cancelled"),
            run["id"],
            "settle active work before migration",
        )
        _require(
            question is not None and answer is not None,
            run["id"],
            "missing message pair",
        )
        _require(
            question["role"] == "user"
            and answer["role"] == "assistant"
            and answer["parent_message_id"] == question["id"],
            run["id"],
            "unsupported pair roles",
        )
        _require(
            question["conversation_id"]
            == answer["conversation_id"]
            == run["conversation_id"]
            and chats[run["conversation_id"]] == run["owner_user_id"],
            run["id"],
            "pair owner mismatch",
        )
        _require(
            not {question["id"], answer["id"]} & used,
            run["id"],
            "message shared by multiple runs",
        )
        used.update((question["id"], answer["id"]))
        per_account[run["owner_user_id"]].append((question, answer, run))
    _require(used == messages.keys(), "message pairs", "unpaired historical messages")
    converted_messages = []
    for account, turns in per_account.items():
        turns.sort(
            key=lambda turn: (
                turn[0]["created_at"],
                turn[0]["conversation_id"],
                turn[0]["seq"],
                turn[2]["id"],
            )
        )
        for index, (question, answer, _) in enumerate(turns):
            refs = []
            if question["parent_message_id"] is not None:
                refs.append(
                    {
                        "resource_ref": f"message:{question['parent_message_id']}",
                        "field": None,
                        "locator": None,
                    }
                )
            snapshot = question["reader_selection_snapshot"]
            if snapshot is not None:
                refs.append(
                    {
                        "resource_ref": snapshot["highlight_ref"],
                        "field": None,
                        "locator": None,
                    }
                    if snapshot["highlight_ref"]
                    else _live(snapshot["evidence"], mapping, question["id"])
                )
            anchor = question["branch_anchor"]
            if question["branch_anchor_kind"] == "assistant_selection":
                selected = messages.get(UUID(anchor["message_id"]))
                _require(
                    selected is not None
                    and selected["role"] == "assistant"
                    and chats[selected["conversation_id"]] == account,
                    question["id"],
                    "selected answer message is missing or foreign",
                )
                source = selected["content"]
                exact = anchor["exact"]
                positions = [
                    match.start() for match in re.finditer(re.escape(exact), source)
                ]
                positions = [
                    position
                    for position in positions
                    if (
                        not anchor.get("prefix")
                        or source[:position].endswith(anchor["prefix"])
                    )
                    and (
                        not anchor.get("suffix")
                        or source[position + len(exact) :].startswith(anchor["suffix"])
                    )
                ]
                _require(
                    len(positions) == 1,
                    question["id"],
                    "selected answer passage cannot be mapped uniquely",
                )
                refs = [
                    reference
                    for reference in refs
                    if reference["resource_ref"] != f"message:{anchor['message_id']}"
                ]
                refs.append(
                    {
                        "resource_ref": f"message:{anchor['message_id']}",
                        "field": None,
                        "locator": {
                            "kind": "TextOffsets",
                            "start_offset": positions[0],
                            "end_offset": positions[0] + len(exact),
                        },
                    }
                )
            converted_messages.extend(
                (
                    (question["id"], account, index * 2 + 1, refs),
                    (answer["id"], account, index * 2 + 2, []),
                )
            )
    retrievals = []
    edges = {
        row["id"]: row
        for row in db.execute(
            sa.text(
                "SELECT * FROM resource_edges WHERE source_scheme='message' AND ordinal IS NOT NULL"
            )
        ).mappings()
    }
    external = {
        str(row["id"]): row["url"]
        for row in db.execute(
            sa.text("SELECT id,url FROM resource_external_snapshots")
        ).mappings()
    }
    cited = set()
    for row in db.execute(
        sa.text(
            "SELECT * FROM message_retrievals ORDER BY assistant_message_id,ordinal"
        )
    ).mappings():
        evidence = row["captured_evidence"]
        owner = evidence["target"].get("owner_ref")
        if row["result_type"] == "web_result" or (
            owner and owner.startswith("external_snapshot:")
        ):
            identity = owner.split(":", 1)[1] if owner else row["source_id"]
            _require(identity in external, row["id"], "external citation has no url")
            url = external[identity]
            _require(
                urlsplit(url).scheme in ("http", "https") and urlsplit(url).hostname,
                row["id"],
                "unsupported external url",
            )
            target = {"kind": "url", "url": url}
        else:
            target = {
                "kind": "resource",
                "reference": _live(evidence, mapping, row["id"]),
            }
        edge = edges.get(row["cited_edge_id"])
        if edge is not None:
            cited.add(edge["id"])
        retrievals.append(
            (row["id"], target, None if edge is None else edge["ordinal"])
        )
    _require(
        cited == edges.keys(),
        "message citations",
        "citation edge has no owning retrieval",
    )
    _require(
        not any(
            ref in mapping or UUID(ref[13:]) in chats for ref in _REMOVED_CONVERSATIONS
        ),
        "approved dangling records",
        "an approved absent conversation now exists",
    )
    converted = {}
    for table, key in (
        ("authored_links", "link_id"),
        ("authored_passages", "anchor_id"),
        ("authored_source_stubs", "source_ref"),
        ("authored_resources", "ref"),
    ):
        rows = []
        bindings = set()
        for row in db.execute(
            sa.text(f"SELECT * FROM {table} ORDER BY account_id,{key}")
        ).mappings():
            if table == "authored_links" and str(row[key]) in _REMOVED_LINKS:
                _require(
                    bool(
                        {row["state"]["endpoint_a"], row["state"]["endpoint_b"]}
                        & _REMOVED_CONVERSATIONS
                    ),
                    row[key],
                    "approved dangling link changed its endpoints",
                )
                continue
            if table == "authored_source_stubs" and row[key] in _REMOVED_CONVERSATIONS:
                continue
            state = _typed(row["state"], mapping)
            identity = _ref(row[key], mapping)
            if table == "authored_links":
                if state["endpoint_a"] > state["endpoint_b"]:
                    state["endpoint_a"], state["endpoint_b"] = (
                        state["endpoint_b"],
                        state["endpoint_a"],
                    )
                    state["position_a"], state["position_b"] = (
                        state["position_b"],
                        state["position_a"],
                    )
                _require(
                    state["endpoint_a"] != state["endpoint_b"],
                    identity,
                    "reference conversion creates self-link",
                )
                binding = (row["account_id"], state["endpoint_a"], state["endpoint_b"])
            else:
                binding = (row["account_id"], identity)
            _require(
                binding not in bindings,
                identity,
                "converted semantic identity collides",
            )
            bindings.add(binding)
            rows.append((row, identity, state))
        converted[table] = (key, rows)
    # Conversations had no readable passage body; reject impossible typed owners.
    _require(
        not db.scalar(
            sa.text(
                "SELECT EXISTS(SELECT 1 FROM passage_anchors WHERE owner_scheme='conversation')"
            )
        ),
        "passage anchors",
        "conversation-owned passage has no convertible body",
    )
    for edge in db.execute(
        sa.text(
            "SELECT id,source_scheme,source_id,target_scheme,target_id FROM resource_edges WHERE origin NOT IN ('system','citation')"
        )
    ).mappings():
        if str(edge["id"]) in _REMOVED_LINKS:
            continue
        source = _ref(f"{edge['source_scheme']}:{edge['source_id']}", mapping)
        target = _ref(f"{edge['target_scheme']}:{edge['target_id']}", mapping)
        _require(source != target, edge["id"], "reference conversion creates self-edge")
    invalid_tool = db.execute(
        sa.text(
            "SELECT t.id FROM tool_calls t JOIN llm_calls c ON c.id=t.generation_id WHERE c.owner_kind='chat_run' AND ((t.arguments IS NOT NULL AND jsonb_typeof(t.arguments)<>'object') OR (t.result->>'type'='Success' AND t.result ? 'value' AND jsonb_typeof(t.result->'value')<>'object')) LIMIT 1"
        )
    ).scalar()
    _require(
        invalid_tool is None, invalid_tool, "unsupported historical tool receipt shape"
    )
    bodies = _bodies(db, mapping)
    for identity, target_id in db.execute(
        sa.text(
            "SELECT id,target_id FROM resource_view_states WHERE target_scheme='conversation'"
        )
    ):
        ref = f"conversation:{target_id}"
        _require(
            ref in mapping or ref in _REMOVED_CONVERSATIONS,
            identity,
            "view state targets an empty or unknown conversation",
        )
    workspaces = [
        (row["id"], _typed(row["state"], mapping))
        for row in db.execute(
            sa.text("SELECT id,state FROM workspace_sessions")
        ).mappings()
    ]
    # All supported data has been converted in memory before the first schema/data write.
    op.add_column("llm_calls", sa.Column("native_execution", JSONB(), nullable=True))
    op.rename_table("chat_deletion_revisions", "librarian_state")
    op.alter_column("librarian_state", "revision", new_column_name="deletion_revision")
    op.add_column(
        "librarian_state",
        sa.Column("next_seq", sa.BigInteger(), nullable=False, server_default="1"),
    )
    op.add_column("users", sa.Column("reading_brief", sa.Text(), nullable=True))
    op.add_column(
        "users",
        sa.Column(
            "reading_brief_version", sa.BigInteger(), nullable=False, server_default="1"
        ),
    )
    op.add_column("messages", sa.Column("owner_user_id", sa.Uuid(), nullable=True))
    op.add_column(
        "messages",
        sa.Column("attachments", JSONB(), nullable=False, server_default="[]"),
    )
    op.drop_constraint("uix_messages_conversation_seq", "messages", type_="unique")
    op.alter_column("messages", "seq", type_=sa.BigInteger())
    for identity, account, seq, refs in converted_messages:
        db.execute(
            sa.text(
                "UPDATE messages SET owner_user_id=:account,seq=:seq,attachments=CAST(:refs AS jsonb) WHERE id=:id"
            ),
            {"id": identity, "account": account, "seq": seq, "refs": _json(refs)},
        )
    op.alter_column("messages", "owner_user_id", nullable=False)
    op.create_foreign_key(
        "fk_messages_owner", "messages", "users", ["owner_user_id"], ["id"]
    )
    op.create_unique_constraint(
        "uq_messages_account_seq", "messages", ["owner_user_id", "seq"]
    )
    op.create_unique_constraint(
        "uq_messages_account_id", "messages", ["id", "owner_user_id"]
    )
    for role in ("user", "assistant"):
        op.drop_constraint(
            f"chat_runs_{role}_message_id_fkey", "chat_runs", type_="foreignkey"
        )
        op.create_foreign_key(
            f"fk_chat_runs_{role}_owner",
            "chat_runs",
            "messages",
            [f"{role}_message_id", "owner_user_id"],
            ["id", "owner_user_id"],
        )
    op.create_unique_constraint(
        "uq_chat_runs_user_message", "chat_runs", ["user_message_id"]
    )
    op.drop_index("ix_chat_runs_user_message", table_name="chat_runs")
    op.add_column("chat_runs", sa.Column("retry_of_run_id", sa.Uuid(), nullable=True))
    op.add_column("message_retrievals", sa.Column("target", JSONB(), nullable=True))
    op.add_column(
        "message_retrievals", sa.Column("citation_ordinal", sa.Integer(), nullable=True)
    )
    for identity, target, ordinal in retrievals:
        db.execute(
            sa.text(
                "UPDATE message_retrievals SET target=CAST(:target AS jsonb),citation_ordinal=:ordinal WHERE id=:id"
            ),
            {"id": identity, "target": _json(target), "ordinal": ordinal},
        )
    op.alter_column("message_retrievals", "target", nullable=False)
    op.create_index(
        "uq_message_retrievals_citation",
        "message_retrievals",
        ["assistant_message_id", "citation_ordinal"],
        unique=True,
        postgresql_where=sa.text("citation_ordinal IS NOT NULL"),
    )
    db.execute(
        sa.text(
            "INSERT INTO librarian_state(user_id,next_seq,deletion_revision) SELECT id,1,1 FROM users ON CONFLICT(user_id) DO NOTHING"
        )
    )
    db.execute(
        sa.text(
            "UPDATE librarian_state s SET next_seq=COALESCE((SELECT max(seq)+1 FROM messages m WHERE m.owner_user_id=s.user_id),1)"
        )
    )
    # These retired domain constraints contain deleted schemes and context rules.
    for table, names in (
        (
            "resource_edges",
            (
                "ck_resource_edges_source_scheme",
                "ck_resource_edges_target_scheme",
                "ck_resource_edges_system_shape",
            ),
        ),
        (
            "resource_view_states",
            (
                "ck_resource_view_states_surface_scheme",
                "ck_resource_view_states_target_scheme",
            ),
        ),
    ):
        for name in names:
            op.drop_constraint(name, table, type_="check")
    for identity in _REMOVED_LINKS:
        db.execute(
            sa.text("DELETE FROM resource_view_states WHERE edge_id=:id"),
            {"id": UUID(identity)},
        )
        db.execute(
            sa.text("DELETE FROM resource_edges WHERE id=:id"), {"id": UUID(identity)}
        )
    for ref in _REMOVED_CONVERSATIONS:
        db.execute(
            sa.text(
                "DELETE FROM resource_view_states WHERE (surface_scheme='conversation' AND surface_id=:id) OR (target_scheme='conversation' AND target_id=:id)"
            ),
            {"id": UUID(ref[13:])},
        )
    # Remove automatic conversation membership; retain authored links and source evidence.
    db.execute(
        sa.text(
            "DELETE FROM resource_view_states WHERE edge_id IN (SELECT id FROM resource_edges WHERE origin='system' OR (origin='citation' AND ordinal IS NULL))"
        )
    )
    db.execute(
        sa.text(
            "DELETE FROM resource_edges WHERE origin='system' OR (origin='citation' AND ordinal IS NULL)"
        )
    )
    op.drop_constraint(
        "ck_resource_edges_citation_has_snapshot", "resource_edges", type_="check"
    )
    db.execute(
        sa.text(
            "DELETE FROM resource_view_states WHERE edge_id IN (SELECT id FROM resource_edges WHERE source_scheme='message' AND origin='citation' AND target_scheme='external_snapshot')"
        )
    )
    db.execute(
        sa.text(
            "DELETE FROM resource_edges WHERE source_scheme='message' AND origin='citation' AND target_scheme='external_snapshot'"
        )
    )
    db.execute(
        sa.text(
            "UPDATE message_retrievals SET cited_edge_id=NULL WHERE target->>'kind'='url'"
        )
    )
    db.execute(
        sa.text(
            "UPDATE resource_edges SET snapshot=NULL WHERE source_scheme='message' AND origin='citation'"
        )
    )
    for old, new in mapping.items():
        old_id, new_id = UUID(old[13:]), UUID(new[8:])
        for side in ("source", "target"):
            db.execute(
                sa.text(
                    f"UPDATE resource_edges SET {side}_scheme='message',{side}_id=:new WHERE {side}_scheme='conversation' AND {side}_id=:old"
                ),
                {"new": new_id, "old": old_id},
            )
        db.execute(
            sa.text(
                "UPDATE resource_view_states SET target_scheme='message',target_id=:new WHERE target_scheme='conversation' AND target_id=:old"
            ),
            {"new": new_id, "old": old_id},
        )
    _require(
        not db.scalar(
            sa.text(
                "SELECT EXISTS(SELECT 1 FROM resource_edges WHERE source_scheme='conversation' OR target_scheme='conversation')"
            )
        ),
        "resource edges",
        "linked empty conversation",
    )
    # Authored state owns endpoint identity and position. Rewrite its relational
    # projection too; endpoint sorting can reverse during conversation conversion.
    for row, identity, state in converted["authored_links"][1]:
        if state == row["state"]:
            continue
        a_scheme, a_id = state["endpoint_a"].split(":", 1)
        b_scheme, b_id = state["endpoint_b"].split(":", 1)
        db.execute(
            sa.text(
                "UPDATE resource_edges SET source_scheme=:ss,source_id=:si,target_scheme=:ts,target_id=:ti WHERE id=:id AND user_id=:a AND origin='user'"
            ),
            {
                "ss": a_scheme,
                "si": UUID(a_id),
                "ts": b_scheme,
                "ti": UUID(b_id),
                "id": UUID(identity),
                "a": row["account_id"],
            },
        )
        db.execute(
            sa.text(
                "DELETE FROM resource_view_states WHERE user_id=:a AND edge_id=:id"
            ),
            {"a": row["account_id"], "id": UUID(identity)},
        )
        for endpoint, position in (
            (state["endpoint_a"], state["position_a"]),
            (state["endpoint_b"], state["position_b"]),
        ):
            if position is not None:
                scheme, resource_id = endpoint.split(":", 1)
                db.execute(
                    sa.text(
                        "INSERT INTO resource_view_states(user_id,surface_scheme,surface_id,edge_id,order_key) VALUES(:a,:s,:r,:id,:p)"
                    ),
                    {
                        "a": row["account_id"],
                        "s": scheme,
                        "r": UUID(resource_id),
                        "id": UUID(identity),
                        "p": position["value"],
                    },
                )
    db.execute(
        sa.text("DELETE FROM resource_view_states WHERE surface_scheme='conversation'")
    )
    db.execute(
        sa.text(
            "DELETE FROM resource_versions WHERE resource_scheme='conversation' OR lane='context'"
        )
    )
    for table, (key, rows) in converted.items():
        if table in ("authored_links", "authored_source_stubs"):
            db.execute(sa.text(f"DELETE FROM {table}"))
            for row, identity, state in rows:
                db.execute(
                    sa.text(
                        f"INSERT INTO {table}(account_id,{key},state) VALUES(:a,:id,CAST(:state AS jsonb))"
                    ),
                    {"a": row["account_id"], "id": identity, "state": _json(state)},
                )
        else:
            for row, identity, state in rows:
                db.execute(
                    sa.text(
                        f"UPDATE {table} SET state=CAST(:state AS jsonb) WHERE account_id=:a AND {key}=:id"
                    ),
                    {"a": row["account_id"], "id": identity, "state": _json(state)},
                )
    for row, body in bodies:
        db.execute(
            sa.text(
                "UPDATE authored_resources SET merge_bytes=:bytes WHERE account_id=:a AND ref=:ref"
            ),
            {
                "a": row["account_id"],
                "ref": row["ref"],
                "bytes": base64.urlsafe_b64decode(
                    body["state"] + "=" * (-len(body["state"]) % 4)
                ),
            },
        )
        table, column = (
            ("note_blocks", "body_pm_json")
            if row["ref"].startswith("note_block:")
            else ("highlights", "annotation_body_pm_json")
        )
        db.execute(
            sa.text(f"UPDATE {table} SET {column}=CAST(:body AS jsonb) WHERE id=:id"),
            {
                "id": UUID(row["ref"].split(":")[1]),
                "body": None
                if body["projection"] is None
                else _json(body["projection"]),
            },
        )
    for table, column in (
        ("passage_anchors", "selector"),
        ("resource_edges", "snapshot"),
    ):
        for row in db.execute(
            sa.text(f"SELECT id,{column} value FROM {table} WHERE {column} IS NOT NULL")
        ).mappings():
            value = _typed(row["value"], mapping)
            if value != row["value"]:
                db.execute(
                    sa.text(
                        f"UPDATE {table} SET {column}=CAST(:value AS jsonb) WHERE id=:id"
                    ),
                    {"id": row["id"], "value": _json(value)},
                )
    for identity, state in workspaces:
        db.execute(
            sa.text(
                "UPDATE workspace_sessions SET state=CAST(:state AS jsonb) WHERE id=:id"
            ),
            {"id": identity, "state": _json(state)},
        )
    db.execute(sa.text("UPDATE authored_heads SET snapshot_floor_seq=head_seq"))
    db.execute(
        sa.text(
            "UPDATE authored_replicas SET format_revision=6 WHERE format_revision=5"
        )
    )
    op.alter_column("authored_replicas", "format_revision", server_default="6")
    db.execute(
        sa.text(
            "DELETE FROM keyword_occurrences WHERE family IN ('conversation','web_result')"
        )
    )
    db.execute(
        sa.text("UPDATE keyword_occurrences SET owner_ref=ref WHERE family='message'")
    )
    db.execute(
        sa.text(
            "UPDATE tool_calls t SET arguments=CASE WHEN t.arguments IS NULL THEN NULL ELSE (SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(t.arguments) WHERE key IN ('uri','url','resource_uri','media_uri','source_uri','target_uri','page_uri','note_uri','highlight_uri','library_uri','library_id')) END,result=CASE WHEN result->>'type'='Success' THEN jsonb_build_object('type','Success','value',(SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(t.result->'value') WHERE key IN ('uri','url','resource_uri','media_uri','source_uri','target_uri','page_uri','note_uri','highlight_uri','library_uri','library_id') OR (t.tool_id='memory.save_note' AND key='id'))) ELSE result END WHERE EXISTS(SELECT 1 FROM llm_calls c WHERE c.id=t.generation_id AND c.owner_kind='chat_run')"
        )
    )
    db.execute(
        sa.text("DELETE FROM chat_run_events WHERE event_type='context_ref_added'")
    )
    for column in (
        "result_type",
        "source_id",
        "media_id",
        "evidence_span_id",
        "context_ref",
        "captured_evidence",
        "result_ref",
        "locator",
    ):
        op.drop_column("message_retrievals", column)
    for column in ("conversation_id", "admitted_context_version", "generation_intent"):
        op.drop_column("chat_runs", column)
    for column in (
        "conversation_id",
        "parent_message_id",
        "branch_anchor_kind",
        "branch_anchor",
        "fork_title",
        "reader_selection_snapshot",
    ):
        op.drop_column("messages", column)
    op.drop_column("resource_view_states", "context_order_key")
    for name in (
        "ix_resource_edges_user_source",
        "uq_resource_edges_nonuser_orderless_pair",
        "uq_resource_edges_source_order",
    ):
        op.drop_index(name, table_name="resource_edges")
    op.drop_column("resource_edges", "source_order_key")
    op.create_index(
        "ix_resource_edges_user_source",
        "resource_edges",
        ["user_id", "source_scheme", "source_id", "id"],
    )
    op.drop_table("conversations")
    db.execute(
        sa.text(
            "DELETE FROM resource_external_snapshots x WHERE x.user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM resource_edges e WHERE e.target_scheme='external_snapshot' AND e.target_id=x.id) AND NOT EXISTS(SELECT 1 FROM authored_source_stubs s WHERE s.source_ref='external_snapshot:'||x.id::text) AND NOT EXISTS(SELECT 1 FROM authored_links l WHERE l.state->>'endpoint_a'='external_snapshot:'||x.id::text OR l.state->>'endpoint_b'='external_snapshot:'||x.id::text)"
        )
    )
    db.execute(sa.text("DELETE FROM suggestion_shortlists"))
    db.execute(sa.text("UPDATE suggestion_feeds SET current_job_id=NULL"))
    db.execute(
        sa.text("DELETE FROM background_jobs WHERE kind='suggestion_shortlist_refresh'")
    )
    op.drop_column("suggestion_shortlists", "target_refs")
    op.add_column("suggestion_shortlists", sa.Column("items", JSONB(), nullable=False))
    op.add_column(
        "suggestion_feeds",
        sa.Column("last_admitted_at", sa.DateTime(timezone=True), nullable=True),
    )
    for check in sa.inspect(db).get_check_constraints("suggestion_feeds"):
        if "mode" in check["sqltext"]:
            op.drop_constraint(check["name"], "suggestion_feeds", type_="check")


def downgrade() -> None:
    raise NotImplementedError(
        "0340 requires restoring the verified backup and matching clients"
    )
