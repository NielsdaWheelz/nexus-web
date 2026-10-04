"""Finite 0246/0257 preservation of original completed additive-write facts.

This data migration reads no executable generation spec. The two source shapes
are explicit: original Chat ownership before 0246, and persisted principals
after 0256. Missing facts and unresolved writes abort the enclosing migration.
"""

from collections import Counter, defaultdict
from typing import Literal
from uuid import UUID

from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Connection, RowMapping

_WRITE_TOOL_IDS = (
    "nexus.library.add",
    "nexus.note.create",
    "nexus.highlight.create",
    "nexus.edge.create",
    "nexus.queue.add",
)
_REF_TARGET_KIND = {
    "entry": "library_entry",
    "note_block": "note_block",
    "highlight": "highlight",
    "edge": "resource_edge",
    "queue": "queue_item",
}
_TARGET_BOUNDS = {
    "nexus.library.add": {"library_entry": (0, 1)},
    "nexus.note.create": {"note_block": (1, 1)},
    "nexus.highlight.create": {"highlight": (1, 1), "note_block": (0, 1)},
    "nexus.edge.create": {"resource_edge": (1, 1)},
    "nexus.queue.add": {"queue_item": (0, 1)},
}


def _created_targets(*, position_id: UUID, tool_id: str, evidence: object) -> set[tuple[str, UUID]]:
    if not isinstance(evidence, dict):
        raise ValueError(f"write position {position_id} lacks original result evidence")
    result = evidence.get("tool_result")
    refs = evidence.get("created_refs")
    if (
        not isinstance(result, dict)
        or result.get("type") not in {"Success", "Failure"}
        or not isinstance(refs, list)
        or (result["type"] == "Failure" and refs)
    ):
        raise ValueError(f"write position {position_id} lacks its closed original result")
    targets = []
    for ref in refs:
        if (
            not isinstance(ref, dict)
            or ref.get("kind") not in _REF_TARGET_KIND
            or not isinstance(ref.get("id"), str)
        ):
            raise ValueError(f"write position {position_id} has an invalid created ref")
        try:
            targets.append((_REF_TARGET_KIND[ref["kind"]], UUID(ref["id"])))
        except ValueError as error:
            raise ValueError(f"write position {position_id} has an invalid target id") from error
    if len(set(targets)) != len(targets):
        raise ValueError(f"write position {position_id} repeats a created target")
    if result["type"] == "Success":
        bounds = _TARGET_BOUNDS.get(tool_id)
        if bounds is None or any(kind not in bounds for kind, _id in targets):
            raise ValueError(f"write position {position_id} has unknown created-target semantics")
        counts = Counter(kind for kind, _id in targets)
        if any(not low <= counts[kind] <= high for kind, (low, high) in bounds.items()):
            raise ValueError(f"write position {position_id} has incomplete created targets")
    return set(targets)


def preserve_generation_effect_receipts(
    connection: Connection, *, source: Literal["Before0246", "After0256"]
) -> None:
    """Create on either known migration path; preserve and validate every write."""

    connection.execute(
        text("""
        CREATE TABLE IF NOT EXISTS generation_effect_receipts (
            id uuid PRIMARY KEY,
            principal_user_id uuid NOT NULL REFERENCES users(id),
            owner_kind text NOT NULL,
            owner_id uuid NOT NULL,
            generation_id uuid NOT NULL,
            generation_seq integer NOT NULL,
            tool_position integer NOT NULL,
            canonical_tool_id text NOT NULL,
            effect_identity jsonb NOT NULL,
            result_evidence jsonb NOT NULL,
            created_at timestamptz NOT NULL,
            completed_at timestamptz NOT NULL,
            reverted_at timestamptz
        );
    """)
    )
    principal_column = "c.tool_principal_user_id" if source == "After0256" else "NULL::uuid"
    positions = (
        connection.execute(
            text(f"""
            SELECT p.*, c.owner_kind, c.owner_id, c.generation_seq,
                   {principal_column} AS principal_user_id,
                   r.owner_user_id AS chat_principal_user_id,
                   r.conversation_id AS chat_conversation_id,
                   r.user_message_id AS chat_user_message_id,
                   r.assistant_message_id AS chat_assistant_message_id
            FROM llm_tool_positions p JOIN llm_calls c ON c.id=p.generation_id
            LEFT JOIN chat_runs r ON c.owner_kind='chat_run' AND r.id=c.owner_id
            WHERE p.canonical_tool_id=ANY(CAST(:write_ids AS text[]))
               OR p.effect_identity IS NOT NULL
            ORDER BY p.id
        """),
            {"write_ids": list(_WRITE_TOOL_IDS)},
        )
        .mappings()
        .all()
    )
    position_ids = [p["id"] for p in positions]
    projections: dict[UUID, list[RowMapping]] = defaultdict(list)
    if position_ids:
        for row in connection.execute(
            text("""
                SELECT m.*, c.owner_user_id AS projection_user_id,
                       u.role AS user_message_role, u.conversation_id AS user_conversation_id,
                       a.role AS assistant_message_role, a.conversation_id AS assistant_conversation_id
                FROM message_tool_calls m JOIN conversations c ON c.id=m.conversation_id
                LEFT JOIN messages u ON u.id=m.user_message_id
                LEFT JOIN messages a ON a.id=m.assistant_message_id
                WHERE m.tool_position_id=ANY(CAST(:position_ids AS uuid[]))
            """),
            {"position_ids": position_ids},
        ).mappings():
            projections[row["tool_position_id"]].append(row)
    authorships: dict[UUID, list[RowMapping]] = defaultdict(list)
    for row in connection.execute(text("SELECT * FROM assistant_write_authorships")).mappings():
        authorships[row["tool_position_id"]].append(row)
    receipts = {
        row["id"]: dict(row)
        for row in connection.execute(text("SELECT * FROM generation_effect_receipts")).mappings()
    }
    insert = text("""
        INSERT INTO generation_effect_receipts (
            id,principal_user_id,owner_kind,owner_id,generation_id,generation_seq,
            tool_position,canonical_tool_id,effect_identity,result_evidence,
            created_at,completed_at,reverted_at
        ) VALUES (
            :id,:principal_user_id,:owner_kind,:owner_id,:generation_id,:generation_seq,
            :tool_position,:canonical_tool_id,:effect_identity,:result_evidence,
            :created_at,:completed_at,:reverted_at
        )
    """).bindparams(
        bindparam("effect_identity", type_=JSONB), bindparam("result_evidence", type_=JSONB)
    )
    for position in positions:
        position_id = position["id"]
        if (
            position["replay_status"] != "Completed"
            or position["completed_at"] is None
            or position["canonical_tool_id"] not in _WRITE_TOOL_IDS
        ):
            raise ValueError(f"unresolved or unknown write position {position_id} blocks cutover")
        expected_identity = {
            "effect_id": str(position_id),
            "generation_id": str(position["generation_id"]),
            "position_path": f"generation/{position['generation_seq']}/tool/{position['position']}",
        }
        if position["effect_identity"] != expected_identity:
            raise ValueError(f"write position {position_id} changed its stable effect identity")
        principal = (
            position["chat_principal_user_id"]
            if source == "Before0246"
            else position["principal_user_id"]
        )
        if principal is None or (source == "Before0246" and position["owner_kind"] != "chat_run"):
            raise ValueError(f"write position {position_id} lacks its original principal")
        chat_principal = position["chat_principal_user_id"]
        if chat_principal is not None and chat_principal != principal:
            raise ValueError(f"write position {position_id} changed its Chat principal")
        projection_rows = projections.get(position_id, [])
        projection = projection_rows[0] if len(projection_rows) == 1 else None
        if position["owner_kind"] == "chat_run":
            if chat_principal is not None and projection is None:
                raise ValueError(f"write position {position_id} lacks its exact Chat projection")
            if projection_rows and chat_principal is None:
                raise ValueError(f"write position {position_id} has an unowned Chat projection")
        elif projection_rows:
            raise ValueError(f"write position {position_id} has a different owner's projection")
        evidence = position["result_evidence"]
        if source == "Before0246":
            assert projection is not None
            if not isinstance(evidence, dict) or (
                "created_refs" in evidence and evidence["created_refs"] != projection["result_refs"]
            ):
                raise ValueError(f"write position {position_id} has conflicting original refs")
            # The original owner stored refs in Chat, separate from the terminal result.
            # Compose those retained facts without changing either source row.
            evidence = {**evidence, "created_refs": projection["result_refs"]}
        expected_targets = _created_targets(
            position_id=position_id,
            tool_id=position["canonical_tool_id"],
            evidence=evidence,
        )
        original_authorships = authorships.get(position_id, [])
        actual_targets = {(a["target_kind"], a["target_id"]) for a in original_authorships}
        if len(original_authorships) != len(actual_targets) or actual_targets != expected_targets:
            raise ValueError(f"write position {position_id} lacks exact original authorship")
        if projection is not None and (
            projection["record_kind"] != "current_execution"
            or projection["projection_user_id"] != principal
            or projection["conversation_id"] != position["chat_conversation_id"]
            or projection["user_message_id"] != position["chat_user_message_id"]
            or projection["assistant_message_id"] != position["chat_assistant_message_id"]
            or projection["user_message_role"] != "user"
            or projection["assistant_message_role"] != "assistant"
            or projection["user_conversation_id"] != position["chat_conversation_id"]
            or projection["assistant_conversation_id"] != position["chat_conversation_id"]
            or projection["tool_call_index"] != position["position"]
            or projection["canonical_tool_id"] != position["canonical_tool_id"]
            or projection["result_refs"] != evidence["created_refs"]
            or projection["status"]
            != ("complete" if evidence["tool_result"]["type"] == "Success" else "error")
        ):
            raise ValueError(f"write position {position_id} changed its original Chat projection")
        if source == "Before0246":
            assert projection is not None
            reverted_at = projection["reverted_at"]
        else:
            reverted_at = position["reverted_at"]
            authored_stamps = {a["reverted_at"] for a in original_authorships}
            if len(authored_stamps) > 1:
                raise ValueError(
                    f"write position {position_id} has conflicting authored undo stamps"
                )
            authored_stamp = next(iter(authored_stamps)) if authored_stamps else None
            if (
                projection is not None
                and authored_stamps
                and projection["reverted_at"] != authored_stamp
            ):
                raise ValueError(
                    f"write position {position_id} has conflicting projected undo stamps"
                )
            original_stamp = projection["reverted_at"] if projection is not None else authored_stamp
            if (
                reverted_at is not None
                and (authored_stamps or projection is not None)
                and reverted_at != original_stamp
            ):
                raise ValueError(
                    f"write position {position_id} has conflicting position undo stamps"
                )
            if reverted_at is None and original_stamp is not None:
                reverted_at = original_stamp
                connection.execute(
                    text("UPDATE llm_tool_positions SET reverted_at=:stamp WHERE id=:id"),
                    {"stamp": reverted_at, "id": position_id},
                )
            for authorship in original_authorships:
                if (
                    authorship["generation_id"] != position["generation_id"]
                    or authorship["generation_seq"] != position["generation_seq"]
                    or authorship["tool_position"] != position["position"]
                    or authorship["canonical_tool_id"] != position["canonical_tool_id"]
                    or authorship["reverted_at"] != reverted_at
                ):
                    raise ValueError(f"authorship {authorship['id']} changed original write facts")
        facts = {
            "id": position_id,
            "principal_user_id": principal,
            "owner_kind": position["owner_kind"],
            "owner_id": position["owner_id"],
            "generation_id": position["generation_id"],
            "generation_seq": position["generation_seq"],
            "tool_position": position["position"],
            "canonical_tool_id": position["canonical_tool_id"],
            "effect_identity": position["effect_identity"],
            "result_evidence": evidence,
            "created_at": position["created_at"],
            "completed_at": position["completed_at"],
            "reverted_at": reverted_at,
        }
        if position_id in receipts:
            if receipts[position_id] != facts:
                raise ValueError(f"effect receipt {position_id} changed original write facts")
        else:
            connection.execute(insert, facts)
            receipts[position_id] = facts
    for position_id, original_authorships in authorships.items():
        receipt = receipts.get(position_id)
        if receipt is None:
            raise ValueError(
                f"authorship position {position_id} lacks recoverable original write evidence"
            )
        expected = _created_targets(
            position_id=position_id,
            tool_id=receipt["canonical_tool_id"],
            evidence=receipt["result_evidence"],
        )
        if {(a["target_kind"], a["target_id"]) for a in original_authorships} != expected:
            raise ValueError(f"authorship position {position_id} changed its exact created targets")
        if source == "After0256" and any(
            a["generation_id"] != receipt["generation_id"]
            or a["generation_seq"] != receipt["generation_seq"]
            or a["tool_position"] != receipt["tool_position"]
            or a["canonical_tool_id"] != receipt["canonical_tool_id"]
            or a["reverted_at"] != receipt["reverted_at"]
            for a in original_authorships
        ):
            raise ValueError(
                f"authorship position {position_id} changed its preserved receipt facts"
            )
    connection.execute(
        text("""
        DO $$ BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid='assistant_write_authorships'::regclass
                  AND conname='fk_assistant_write_authorships_effect_receipt'
            ) THEN
                ALTER TABLE assistant_write_authorships ADD CONSTRAINT
                    fk_assistant_write_authorships_effect_receipt
                    FOREIGN KEY (tool_position_id) REFERENCES generation_effect_receipts(id);
            END IF;
        END $$;
    """)
    )
