"""Hard-cut durable Chat tool records to canonical llm-tools identity.

Revision ID: 0217
Revises: 0216
Create Date: 2026-08-17

The preflight is SELECT-only. It refuses live work, rows outside the four
reviewed historical variants, malformed or ambiguous typed tool events, and
contradictory durable Chat step state before any schema or data mutation.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Sequence
from typing import Any, Never, cast

import sqlalchemy as sa
from alembic import op
from llm_tools import canonical_json_bytes
from sqlalchemy.dialects import postgresql
from sqlalchemy.engine import RowMapping

revision: str = "0217"
down_revision: str | Sequence[str] | None = "0216"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TOOL_STEP_PATH = re.compile(r"turn/\d+/tool/\d+\Z")
_TERMINAL_TOOL_STATUSES = ("complete", "error", "cancelled")

# Frozen migration-owned history. The two revision values for each old id are
# literal SHA256(JCS(...)) attestations reviewed independently by the migration
# proof; they never import or impersonate a current declaration/binding revision.
# tuple fields: canonical id, tool-contract attestation, binding-policy
# attestation, effect, result kind, activity label.
_HISTORICAL_TOOLS: dict[str, tuple[str, str, str, str, str, str]] = {
    "app_search": (
        "nexus.search",
        "d1c8f823aef01b881579b71163c0e3071ab3e596efcc2aa45805db3878f465bb",
        "f8731f6eefe1417042bc5df503b37a54c86c5a2d456083b4dafe772cef543c30",
        "Read",
        "retrieval",
        "Searching Nexus",
    ),
    "web_search": (
        "web.search",
        "aad6364a2e2fe69779ffbf60d398f0859750c2d1e657c9571fd82735182d5d1b",
        "47bb5782180fe4523475c300678b2c6b69da25bce294e5f1826e60874704bd43",
        "Read",
        "retrieval",
        "Searching the web",
    ),
    "read_resource": (
        "nexus.resource.read",
        "372fc75f6296f24660f7db2945389a06963636514101564f7135ebfa6578a503",
        "60d7fff8bb08a98d3a5e96ec640171e6866ca977c5504885c538900a88051443",
        "Read",
        "retrieval",
        "Reading a resource",
    ),
    "inspect_resource": (
        "nexus.resource.inspect",
        "90834fafb0d24e3de526a551051886a93dcbb5f936f1f024f7c7bcb66961eef0",
        "2715414c17264bd2883f299c328c49070fcc470cfa5d6b5103c8d2459b71625c",
        "Read",
        "navigation",
        "Mapping this document",
    ),
    "add_to_library": (
        "nexus.library.add",
        "6e9a5c5e2be1f4b173b5c6ee1ab6bd8703334c7c822722157ca2444730cfcdc3",
        "d5f578f326e56b9521b8c365378040e364615c884da0955d950897f7636b0f83",
        "Write",
        "mutation",
        "Adding to a library",
    ),
    "jot_note": (
        "nexus.note.create",
        "f7869475114f4f493b935f54901da75be5cdabf8ea06076c474365477178c7e1",
        "f24656bdc18691978ebec7648a38fde17da4367b3e3acfd99b4b942ad3884959",
        "Write",
        "mutation",
        "Creating a note",
    ),
    "create_highlight": (
        "nexus.highlight.create",
        "b057eb05eb4905b8d3a3254e57429eee3410b129a44ff42ed687ae8365433c40",
        "7ba9ddd5d08a315a6b8afbe5a7c2f18a906e0916dc20370ab1a0db9315b6d6ee",
        "Write",
        "mutation",
        "Creating a highlight",
    ),
    "mint_edge": (
        "nexus.edge.create",
        "c0d481a523e5d2b82b4d2d29e2b81d6f925bc69dae3fce6c95084da4d8064214",
        "3e0aa318f1b36e2ddfc459844c959aa1013527de02180221eb6fcd689e30c6c9",
        "Write",
        "mutation",
        "Creating a connection",
    ),
    "queue_add": (
        "nexus.queue.add",
        "9c15eeb3521da405523f099bc83d2defe7ea6e78ccb1009656d0f77418c3b3c7",
        "7932c98ea936d4f5075c662d764ffa84f59cb6cbf9d5d83cbd9a82dccbbdd68d",
        "Write",
        "mutation",
        "Adding to the queue",
    ),
}


def _fail(message: str) -> Never:
    raise RuntimeError(f"0217 preflight: {message}")


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _legacy_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _required_object(value: object, *, location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(f"malformed {location}: expected one JSON object")
    return cast(dict[str, Any], value)


def _record_plan(row: RowMapping) -> dict[str, Any]:
    old_id = row["tool_name"]
    status = row["status"]
    if old_id == "attached_resources":
        if not (
            row["scope"] == "attached_context"
            and row["tool_call_index"] == 0
            and status == "complete"
            and row["error_code"] is None
        ):
            _fail(f"malformed attached-context tool row {row['id']}")
        return {
            "id": row["id"],
            "assistant_message_id": row["assistant_message_id"],
            "old_id": old_id,
            "tool_call_index": row["tool_call_index"],
            "canonical_tool_id": None,
            "record_kind": "attached_context",
            "provider_wire_name": None,
            "canonical_input_sha256": None,
            "tool_contract_revision": None,
            "binding_policy_revision": None,
            "effect": None,
            "result_kind": "attached_context",
            "activity_label": "Attached conversation context",
        }
    historical = _HISTORICAL_TOOLS.get(old_id)
    if historical is not None:
        if row["tool_call_index"] < 1 or status not in _TERMINAL_TOOL_STATUSES:
            _fail(f"historical tool row {row['id']} is malformed or nonterminal")
        canonical, tool_revision, binding_revision, effect, result_kind, label = (
            historical
        )
        return {
            "id": row["id"],
            "assistant_message_id": row["assistant_message_id"],
            "old_id": old_id,
            "tool_call_index": row["tool_call_index"],
            "canonical_tool_id": canonical,
            "record_kind": "historical_execution",
            "provider_wire_name": None,
            "canonical_input_sha256": None,
            "tool_contract_revision": tool_revision,
            "binding_policy_revision": binding_revision,
            "effect": effect,
            "result_kind": result_kind,
            "activity_label": label,
        }
    if not (
        isinstance(old_id, str)
        and 1 <= len(old_id) <= 128
        and row["tool_call_index"] >= 1
        and row["scope"] == "provider_tool"
        and status == "error"
        and row["error_code"] == "unknown_tool"
    ):
        _fail(f"unknown or malformed provider tool row {row['id']}")
    return {
        "id": row["id"],
        "assistant_message_id": row["assistant_message_id"],
        "old_id": old_id,
        "tool_call_index": row["tool_call_index"],
        "canonical_tool_id": None,
        "record_kind": "rejected_provider_call",
        "provider_wire_name": old_id,
        "canonical_input_sha256": None,
        "tool_contract_revision": None,
        "binding_policy_revision": None,
        "effect": None,
        "result_kind": "rejected_provider_call",
        "activity_label": "Skipped an unavailable tool",
    }


def _validate_event_identity(
    *, payload: dict[str, Any], plan: dict[str, Any], event_id: object
) -> None:
    if (
        payload.get("tool_name") != plan["old_id"]
        or payload.get("tool_call_id") != str(plan["id"])
        or payload.get("assistant_message_id") != str(plan["assistant_message_id"])
        or payload.get("tool_call_index") != plan["tool_call_index"]
    ):
        _fail(f"contradictory typed tool event {event_id}")


def _event_payload(payload: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
    migrated = {key: value for key, value in payload.items() if key != "tool_name"}
    migrated.update(
        {
            "canonical_tool_id": plan["canonical_tool_id"],
            "record_kind": plan["record_kind"],
            "provider_wire_name": plan["provider_wire_name"],
            "canonical_input_sha256": plan["canonical_input_sha256"],
            "tool_contract_revision": plan["tool_contract_revision"],
            "binding_policy_revision": plan["binding_policy_revision"],
            "effect": plan["effect"],
            "result_kind": plan["result_kind"],
            "activity_label": plan["activity_label"],
            "error_type": None,
        }
    )
    return migrated


def _rewrite_completed_tool_step(
    *,
    state: dict[str, Any],
    plans: dict[str, dict[str, Any]],
    done_events: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if state.get("dispatch_phase") != "Completed":
        _fail("nonterminal durable Chat tool step survived on a terminal run")
    fingerprint = _required_object(
        state.get("request_fingerprint"), location="durable tool request fingerprint"
    )
    terminal = _required_object(
        state.get("terminal_result"), location="durable tool result"
    )
    if fingerprint.get("kind") != "Present" or not isinstance(
        fingerprint.get("value"), str
    ):
        _fail("malformed durable tool request fingerprint")
    if terminal.get("kind") != "Present" or not isinstance(terminal.get("value"), str):
        _fail("malformed durable tool terminal result")
    try:
        result = json.loads(terminal["value"])
    except (TypeError, ValueError) as exc:
        _fail(f"malformed durable tool terminal JSON: {exc}")
    result = _required_object(result, location="durable tool terminal result")
    raw_tool_call_id = result.get("tool_call_id")
    if not isinstance(raw_tool_call_id, str):
        _fail("durable Chat tool step has no tool-call identity")
    tool_call_id = cast(str, raw_tool_call_id)
    plan = plans.get(tool_call_id)
    if plan is None or plan["record_kind"] not in {
        "historical_execution",
        "rejected_provider_call",
    }:
        _fail("durable Chat tool step has no migratable execution row")
    result_event = _required_object(
        result.get("result_event"), location="durable tool result event"
    )
    if (
        result.get("tool_name") != plan["old_id"]
        or result_event.get("tool_name") != plan["old_id"]
        or result_event.get("tool_call_id") != tool_call_id
        or result_event.get("assistant_message_id") != str(plan["assistant_message_id"])
        or result.get("tool_call_index") != plan["tool_call_index"]
        or result.get("tool_call_index") != result_event.get("tool_call_index")
    ):
        _fail("contradictory durable Chat tool result identity")
    model_output = _required_object(
        result.get("model_output"), location="durable model output"
    )
    provider_call_id = model_output.get("call_id")
    done_event = done_events.get(tool_call_id)
    arguments = done_event.get("input") if done_event is not None else None
    if (
        not isinstance(provider_call_id, str)
        or not isinstance(arguments, dict)
        or done_event is None
        or done_event.get("provider_tool_call_id") != provider_call_id
    ):
        _fail("durable Chat tool step cannot reconstruct its typed input")
    legacy_request = {
        "provider_call_id": provider_call_id,
        "tool_name": plan["old_id"],
        "tool_call_index": result["tool_call_index"],
        "arguments": arguments,
    }
    if fingerprint["value"] != _legacy_sha256(legacy_request):
        _fail("contradictory durable Chat tool request fingerprint")
    migrated_result = {
        key: value for key, value in result.items() if key != "tool_name"
    }
    migrated_result.update(
        {
            "canonical_tool_id": plan["canonical_tool_id"],
            "record_kind": plan["record_kind"],
            "canonical_input_sha256": plan["canonical_input_sha256"],
            "tool_contract_revision": plan["tool_contract_revision"],
            "binding_policy_revision": plan["binding_policy_revision"],
            "result_event": _event_payload(result_event, plan),
        }
    )
    if plan["record_kind"] == "historical_execution":
        canonical_request = {
            "provider_call_id": provider_call_id,
            "canonical_tool_id": plan["canonical_tool_id"],
            "tool_call_index": result["tool_call_index"],
            "arguments": arguments,
        }
        migrated_fingerprint = {**fingerprint, "value": _sha256(canonical_request)}
    else:
        # A rejected provider call is terminal audit history, never canonical
        # replay authority. Retain its already-proved opaque fingerprint and
        # provider wire name without manufacturing a canonical request.
        migrated_result["provider_wire_name"] = plan["provider_wire_name"]
        migrated_fingerprint = fingerprint
    return {
        **state,
        "request_fingerprint": migrated_fingerprint,
        "terminal_result": {**terminal, "value": _json(migrated_result)},
    }


def _preflight(
    bind: Any,
) -> tuple[
    list[dict[str, Any]],
    list[tuple[object, dict[str, Any]]],
    list[tuple[object, dict[str, Any]]],
]:
    live_chat_ids = (
        bind.execute(
            sa.text(
                "SELECT id FROM chat_runs WHERE status NOT IN "
                "('complete', 'error', 'cancelled') ORDER BY id LIMIT 20"
            )
        )
        .scalars()
        .all()
    )
    if live_chat_ids:
        _fail(
            f"nonterminal Chat runs must be drained: {[str(value) for value in live_chat_ids]}"
        )

    active_idea_ids = (
        bind.execute(
            sa.text(
                """
            SELECT build.id
            FROM artifact_builds build
            JOIN artifacts artifact ON artifact.id = build.artifact_id
            WHERE artifact.subject_scheme = 'idea'
              AND NOT EXISTS (
                  SELECT 1 FROM artifact_revisions revision WHERE revision.build_id = build.id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM artifact_build_failures failure WHERE failure.build_id = build.id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM artifact_build_cancellations cancellation
                  WHERE cancellation.build_id = build.id
              )
            ORDER BY build.id
            LIMIT 20
            """
            )
        )
        .scalars()
        .all()
    )
    if active_idea_ids:
        _fail(
            "active Idea dossier builds must be drained: "
            f"{[str(value) for value in active_idea_ids]}"
        )

    rows = (
        bind.execute(
            sa.text(
                """
            SELECT id, assistant_message_id, tool_name, tool_call_index,
                   scope, status, error_code
            FROM message_tool_calls
            ORDER BY id
            """
            )
        )
        .mappings()
        .all()
    )
    plans = [_record_plan(row) for row in rows]
    plans_by_id = {str(plan["id"]): plan for plan in plans}
    done_events: dict[str, list[dict[str, Any]]] = {}
    event_rows = (
        bind.execute(
            sa.text(
                """
            SELECT id, event_type, payload
            FROM chat_run_events
            WHERE event_type IN ('tool_call_start', 'tool_call_delta', 'tool_call_done', 'tool_result')
            ORDER BY id
            """
            )
        )
        .mappings()
        .all()
    )
    for event in event_rows:
        payload = _required_object(
            event["payload"], location=f"typed tool event {event['id']}"
        )
        raw_tool_call_id = payload.get("tool_call_id")
        if not isinstance(raw_tool_call_id, str):
            _fail(f"typed tool event {event['id']} has no tool-call identity")
        tool_call_id = cast(str, raw_tool_call_id)
        plan = plans_by_id.get(tool_call_id)
        if plan is None:
            _fail(f"typed tool event {event['id']} has no exact tool row")
        _validate_event_identity(payload=payload, plan=plan, event_id=event["id"])
        if event["event_type"] == "tool_call_done":
            value = payload.get("input")
            if not isinstance(value, dict):
                _fail(f"malformed tool_call_done input for tool row {tool_call_id}")
            if plan["record_kind"] in {
                "historical_execution",
                "rejected_provider_call",
            }:
                done_events.setdefault(tool_call_id, []).append(payload)

    unique_done_events: dict[str, dict[str, Any]] = {}
    for tool_call_id, values in done_events.items():
        if len(values) != 1:
            _fail(f"ambiguous typed tool input history for tool row {tool_call_id}")
        unique_done_events[tool_call_id] = values[0]
        if plans_by_id[tool_call_id]["record_kind"] == "historical_execution":
            plans_by_id[tool_call_id]["canonical_input_sha256"] = _sha256(
                values[0]["input"]
            )

    event_rewrites = [
        (
            event["id"],
            _event_payload(
                _required_object(
                    event["payload"], location=f"typed tool event {event['id']}"
                ),
                plans_by_id[str(event["payload"]["tool_call_id"])],
            ),
        )
        for event in event_rows
    ]

    job_rewrites: list[tuple[object, dict[str, Any]]] = []
    jobs = (
        bind.execute(
            sa.text(
                "SELECT id, payload FROM background_jobs WHERE kind = 'chat_run' ORDER BY id"
            )
        )
        .mappings()
        .all()
    )
    for job in jobs:
        payload = _required_object(
            job["payload"], location=f"Chat job {job['id']} payload"
        )
        raw_coordination = payload.get("coordination")
        if raw_coordination is None:
            continue
        coordination = _required_object(
            raw_coordination, location=f"Chat job {job['id']} coordination"
        )
        migrated_coordination = dict(coordination)
        changed = False
        for path, raw_state in coordination.items():
            if not isinstance(path, str) or _TOOL_STEP_PATH.fullmatch(path) is None:
                continue
            state = _required_object(raw_state, location=f"Chat tool step {path}")
            migrated_coordination[path] = _rewrite_completed_tool_step(
                state=state,
                plans=plans_by_id,
                done_events=unique_done_events,
            )
            changed = True
        if changed:
            job_rewrites.append(
                (job["id"], {**payload, "coordination": migrated_coordination})
            )
    return plans, event_rewrites, job_rewrites


def upgrade() -> None:
    bind = op.get_bind()
    plans, event_rewrites, job_rewrites = _preflight(bind)

    op.add_column("chat_runs", sa.Column("tool_profile_id", sa.Text(), nullable=True))
    op.add_column(
        "chat_runs", sa.Column("tool_profile_revision", sa.Text(), nullable=True)
    )
    op.add_column(
        "chat_runs",
        sa.Column(
            "tool_profile_snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )

    op.alter_column(
        "message_tool_calls",
        "tool_name",
        new_column_name="canonical_tool_id",
        existing_type=sa.Text(),
        existing_nullable=False,
        nullable=True,
    )
    op.alter_column(
        "message_tool_calls",
        "query_hash",
        new_column_name="search_query_fingerprint",
        existing_type=sa.Text(),
        existing_nullable=True,
    )
    op.execute(
        "ALTER TABLE message_tool_calls RENAME CONSTRAINT "
        "ck_message_tool_calls_tool_name_length TO "
        "ck_message_tool_calls_canonical_tool_id_length"
    )
    op.execute(
        "ALTER TABLE message_tool_calls RENAME CONSTRAINT "
        "ck_message_tool_calls_query_hash_length TO "
        "ck_message_tool_calls_search_query_fingerprint_length"
    )
    op.execute(
        "ALTER INDEX idx_message_tool_calls_tool_status "
        "RENAME TO idx_message_tool_calls_canonical_tool_status"
    )
    op.add_column(
        "message_tool_calls", sa.Column("record_kind", sa.Text(), nullable=True)
    )
    op.add_column(
        "message_tool_calls", sa.Column("provider_wire_name", sa.Text(), nullable=True)
    )
    op.add_column(
        "message_tool_calls",
        sa.Column("canonical_input_sha256", sa.Text(), nullable=True),
    )
    op.add_column(
        "message_tool_calls",
        sa.Column("tool_contract_revision", sa.Text(), nullable=True),
    )
    op.add_column(
        "message_tool_calls",
        sa.Column("binding_policy_revision", sa.Text(), nullable=True),
    )
    op.create_check_constraint(
        "ck_message_tool_calls_provider_wire_name_length",
        "message_tool_calls",
        "provider_wire_name IS NULL OR char_length(provider_wire_name) BETWEEN 1 AND 128",
    )

    for plan in plans:
        bind.execute(
            sa.text(
                """
                UPDATE message_tool_calls
                SET canonical_tool_id = :canonical_tool_id,
                    record_kind = :record_kind,
                    provider_wire_name = :provider_wire_name,
                    canonical_input_sha256 = :canonical_input_sha256,
                    tool_contract_revision = :tool_contract_revision,
                    binding_policy_revision = :binding_policy_revision
                WHERE id = :id
                """
            ),
            plan,
        )
    op.alter_column(
        "message_tool_calls",
        "record_kind",
        existing_type=sa.Text(),
        existing_nullable=True,
        nullable=False,
    )

    for event_id, payload in event_rewrites:
        bind.execute(
            sa.text(
                "UPDATE chat_run_events SET payload = CAST(:payload AS jsonb) WHERE id = :id"
            ),
            {"id": event_id, "payload": _json(payload)},
        )
    for job_id, payload in job_rewrites:
        bind.execute(
            sa.text(
                "UPDATE background_jobs SET payload = CAST(:payload AS jsonb) WHERE id = :id"
            ),
            {"id": job_id, "payload": _json(payload)},
        )
    bind.execute(
        sa.text(
            "UPDATE message_retrievals SET scope = 'resource_read' "
            "WHERE scope = 'read_resource'"
        )
    )

    missing_kinds = bind.execute(
        sa.text("SELECT count(*) FROM message_tool_calls WHERE record_kind IS NULL")
    ).scalar_one()
    if missing_kinds:
        raise RuntimeError("0217 postcondition: a tool record lacks record_kind")


def downgrade() -> None:
    raise NotImplementedError("0217 is an irreversible llm-tools hard cutover")
