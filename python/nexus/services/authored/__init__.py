"""Account-wide authored replication, canonical state and relational projections.

Retry rule: a provisioned replica submits immutable contiguous source commands.
Accepted prefixes are compared with their retained feed bytes and skipped. The
account head lock linearizes causal merge, projections, acceptance and feed.
"""

import base64
import hashlib
import json
from collections.abc import Iterator
from datetime import date
from typing import Any
from uuid import UUID, uuid5

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.authored import (
    AcceptedChanges,
    Change,
    Corpus,
    DownloadChanges,
    FeedChange,
    MergeResult,
    ProvisionReplica,
    UploadChanges,
)
from nexus.services.authored import helper
from nexus.services.resource_graph.refs import require_ref
from nexus.services.resource_items.versions import annotations_revision

MAX_CHANGE_BYTES = 2 * 1024 * 1024
MAX_ENVELOPE_BYTES = 3 * 1024 * 1024
TABLES = {
    "resources": ("authored_resources", "ref"),
    "links": ("authored_links", "link_id"),
    "passages": ("authored_passages", "anchor_id"),
    "source_stubs": ("authored_source_stubs", "source_ref"),
}


def _state_sql(table: str) -> str:
    if table != "authored_resources":
        return "state"
    return (
        "state || CASE WHEN state->>'kind' IN ('note','page') THEN "
        "jsonb_build_object(CASE state->>'kind' WHEN 'note' THEN 'body_state' ELSE 'title_state' END,"
        "rtrim(translate(replace(encode(merge_bytes,'base64'),E'\\n',''),'+/','-_'),'=')) "
        "ELSE '{}'::jsonb END"
    )


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def head(db: Session, account_id: UUID) -> int:
    return (
        db.scalar(
            text("SELECT head_seq FROM authored_heads WHERE account_id=:a"), {"a": account_id}
        )
        or 0
    )


def lock_account(db: Session, account_id: UUID) -> int:
    db.execute(
        text(
            "INSERT INTO authored_heads(account_id,head_seq) VALUES (:a,0) ON CONFLICT DO NOTHING"
        ),
        {"a": account_id},
    )
    return db.execute(
        text("SELECT head_seq FROM authored_heads WHERE account_id=:a FOR UPDATE"),
        {"a": account_id},
    ).scalar_one()


def provision(db: Session, account_id: UUID, request: ProvisionReplica) -> AcceptedChanges:
    if request.format_revision != 1:
        raise ApiError(ApiErrorCode.E_WIRE_MISMATCH, "Update nexus to sync")
    if request.replica_id == uuid5(account_id, "authored:server"):
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Reserved server replica")
    with transaction(db):
        cursor = lock_account(db, account_id)
        db.execute(
            text(
                "INSERT INTO authored_replicas(account_id,replica_id,accepted_seq) "
                "VALUES (:a,:r,0) ON CONFLICT DO NOTHING"
            ),
            {"a": account_id, "r": request.replica_id},
        )
        accepted = _accepted(db, account_id, request.replica_id)
    return AcceptedChanges(accepted_command_seq=str(accepted), head_cursor=str(cursor))


def _accepted(db: Session, account_id: UUID, replica_id: UUID) -> int:
    value = db.scalar(
        text("SELECT accepted_seq FROM authored_replicas WHERE account_id=:a AND replica_id=:r"),
        {"a": account_id, "r": replica_id},
    )
    if value is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Replica is not provisioned")
    return value


def _states(db: Session, account_id: UUID, changes: list[Change]) -> Corpus:
    endpoints = {
        ref
        for change in changes
        for link in change.links
        for ref in (link.endpoint_a, link.endpoint_b)
    }
    sources = {
        resource.source_ref
        for change in changes
        for resource in change.resources
        if resource.kind == "highlight"
    }
    sources |= {passage.source_ref for change in changes for passage in change.passages}
    keys = {
        "resources": {p.ref for c in changes for p in c.resources} | endpoints,
        "links": {str(p.link_id) for c in changes for p in c.links},
        "passages": {str(p.anchor_id) for c in changes for p in c.passages}
        | {
            ref.removeprefix("passage_anchor:")
            for ref in endpoints
            if ref.startswith("passage_anchor:")
        },
        "source_stubs": {p.source_ref for c in changes for p in c.source_stubs}
        | endpoints
        | sources,
    }
    values = {}
    for name, (table, key) in TABLES.items():
        values[name] = list(
            db.scalars(
                text(
                    f"SELECT {_state_sql(table)} FROM {table} WHERE account_id=:a AND {key}=ANY(:keys)"
                ),
                {"a": account_id, "keys": list(keys[name])},
            )
        )
    dates = [
        p.local_date
        for c in changes
        for p in c.resources
        if p.kind == "page" and p.local_date is not None
    ]
    semantic = {
        "resources": (
            f"SELECT {_state_sql('authored_resources')} FROM authored_resources WHERE account_id=:a AND state->>'local_date'=ANY(:dates)",
            {"dates": dates},
        ),
        "links": (
            "SELECT l.state FROM jsonb_to_recordset(CAST(:pairs AS jsonb)) AS k(a text,b text) "
            "JOIN authored_links l ON l.account_id=:a AND l.state->>'endpoint_a'=k.a AND l.state->>'endpoint_b'=k.b",
            {
                "pairs": _json(
                    [{"a": p.endpoint_a, "b": p.endpoint_b} for c in changes for p in c.links]
                )
            },
        ),
        "passages": (
            "SELECT l.state FROM jsonb_to_recordset(CAST(:pairs AS jsonb)) AS k(source_ref text,exact text,prefix text,suffix text) "
            "JOIN authored_passages l ON l.account_id=:a AND l.state->>'source_ref'=k.source_ref "
            "AND l.state->>'normalized_exact'=k.exact AND l.state->>'prefix'=k.prefix AND l.state->>'suffix'=k.suffix",
            {
                "pairs": _json(
                    [
                        {
                            "source_ref": p.source_ref,
                            "exact": p.normalized_exact,
                            "prefix": p.prefix,
                            "suffix": p.suffix,
                        }
                        for c in changes
                        for p in c.passages
                    ]
                )
            },
        ),
    }
    for name, (query, parameters) in semantic.items():
        _, key = TABLES[name]
        extra = list(db.scalars(text(query), {"a": account_id, **parameters}))
        values[name] = list({row[key]: row for row in values[name] + extra}.values())
    return Corpus.model_validate(values)


def upload(db: Session, account_id: UUID, request: UploadChanges) -> AcceptedChanges:
    if request.replica_id == uuid5(account_id, "authored:server"):
        raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Reserved server replica")
    if len(_json(request.model_dump(mode="json")).encode()) > MAX_ENVELOPE_BYTES:
        raise InvalidRequestError(ApiErrorCode.E_CAPTURE_TOO_LARGE, "Upload exceeds 3 MiB")
    for change in request.changes:
        if len(_json(change.model_dump(mode="json")).encode()) > MAX_CHANGE_BYTES:
            raise InvalidRequestError(ApiErrorCode.E_CAPTURE_TOO_LARGE, "Command exceeds 2 MiB")
    with transaction(db):
        cursor = lock_account(db, account_id)
        accepted = _accepted(db, account_id, request.replica_id)
        frontier = {
            str(replica): int(sequence)
            for replica, sequence in db.execute(
                text("SELECT replica_id,accepted_seq FROM authored_replicas WHERE account_id=:a"),
                {"a": account_id},
            )
        }
        remaining = []
        previous = None
        for change in request.changes:
            sequence = int(change.command_seq)
            if previous is not None and sequence != previous + 1:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Noncontiguous upload")
            previous = sequence
            if sequence <= accepted:
                stored = db.scalar(
                    text(
                        "SELECT change FROM authored_changes WHERE "
                        "account_id=:a AND replica_id=:r AND command_seq=:s"
                    ),
                    {"a": account_id, "r": request.replica_id, "s": sequence},
                )
                if stored != change.model_dump(mode="json"):
                    raise ConflictError(
                        ApiErrorCode.E_RESOURCE_CONFLICT, "Accepted command bytes changed"
                    )
                continue
            if sequence != accepted + len(remaining) + 1:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Source sequence gap")
            _validate_source(change, str(request.replica_id), frontier)
            remaining.append(change)
        if remaining:
            result = _touched(
                helper.merge(account_id, _states(db, account_id, remaining), remaining), remaining
            )
            _persist(db, account_id, result)
            for change in remaining:
                cursor += 1
                db.execute(
                    text(
                        "INSERT INTO authored_changes "
                        "(account_id,server_seq,replica_id,command_seq,change) "
                        "VALUES (:a,:s,:r,:c,CAST(:v AS jsonb))"
                    ),
                    {
                        "a": account_id,
                        "s": cursor,
                        "r": request.replica_id,
                        "c": int(change.command_seq),
                        "v": _json(change.model_dump(mode="json")),
                    },
                )
            accepted = int(remaining[-1].command_seq)
            db.execute(
                text(
                    "UPDATE authored_replicas SET accepted_seq=:s "
                    "WHERE account_id=:a AND replica_id=:r"
                ),
                {"a": account_id, "r": request.replica_id, "s": accepted},
            )
            db.execute(
                text(
                    "UPDATE authored_heads SET head_seq=:s,lamport=GREATEST(lamport,:l) WHERE account_id=:a"
                ),
                {"a": account_id, "s": cursor, "l": max(int(c.lamport) for c in remaining)},
            )
            db.execute(text("SELECT pg_notify('nexus_writing',:a)"), {"a": str(account_id)})
    return AcceptedChanges(accepted_command_seq=str(accepted), head_cursor=str(cursor))


def _validate_source(change: Change, replica_id: str, frontier: dict[str, int]) -> None:
    sequence = int(change.command_seq)
    if sequence < 1 or int(change.lamport) < 1:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Command counters must be positive"
        )
    vectors = [v for patch in change.resources for v in (patch.touch_vv, patch.delete_vv)]
    vectors += [v for link in change.links for v in (link.add_vv, link.remove_vv)]
    for vector in vectors:
        for source, dot in vector.items():
            limit = sequence if source == replica_id else frontier.get(source, 0)
            if int(dot) > limit:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, "Unaccepted causal counter"
                )
    stamps = [
        register.stamp
        for resource in change.resources
        if resource.kind == "highlight"
        for register in (resource.selection, resource.color)
    ]
    stamps += [
        register.stamp
        for link in change.links
        for register in (link.position_a, link.position_b)
        if register is not None
    ]
    stamps += [passage.capture.stamp for passage in change.passages]
    stamps += [stub.capture.stamp for stub in change.source_stubs]
    for stamp in stamps:
        if int(stamp.lamport) > int(change.lamport) or (
            str(stamp.replica_id) != replica_id and str(stamp.replica_id) not in frontier
        ):
            raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Unobserved register clock")


def _touched(merged: MergeResult, changes: list[Change]) -> MergeResult:
    refs = {patch.ref for change in changes for patch in change.resources}
    links = {patch.link_id for change in changes for patch in change.links}
    passages = {patch.anchor_id for change in changes for patch in change.passages}
    stubs = {patch.source_ref for change in changes for patch in change.source_stubs}
    return MergeResult(
        resources=[r for r in merged.resources if r.ref in refs],
        links=[r for r in merged.links if r.link_id in links],
        passages=[r for r in merged.passages if r.anchor_id in passages],
        source_stubs=[r for r in merged.source_stubs if r.source_ref in stubs],
        projections=[r for r in merged.projections if r.ref in refs],
    )


def _persist(db: Session, account_id: UUID, result: MergeResult) -> None:
    try:
        _persist_unchecked(db, account_id, result)
    except IntegrityError as exc:
        raise ConflictError(
            ApiErrorCode.E_RESOURCE_CONFLICT, "Conflicting authored identity binding"
        ) from exc


def _persist_unchecked(db: Session, account_id: UUID, result: MergeResult) -> None:
    for table, identities in (
        (
            "note_blocks",
            [str(require_ref(item.ref).id) for item in result.resources if item.kind == "note"],
        ),
        (
            "pages",
            [str(require_ref(item.ref).id) for item in result.resources if item.kind == "page"],
        ),
        (
            "highlights",
            [
                str(require_ref(item.ref).id)
                for item in result.resources
                if item.kind == "highlight"
            ],
        ),
        ("resource_edges", [str(item.link_id) for item in result.links]),
        ("passage_anchors", [str(item.anchor_id) for item in result.passages]),
    ):
        if identities and db.scalar(
            text(
                f"SELECT EXISTS (SELECT 1 FROM {table} WHERE id=ANY(CAST(:ids AS uuid[])) AND user_id<>:a)"
            ),
            {"a": account_id, "ids": identities},
        ):
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Identity belongs to another account"
            )
    for name, (table, key) in TABLES.items():
        for state in getattr(result, name):
            value = state.model_dump(mode="json")
            if name == "resources" and value["kind"] in ("note", "page"):
                encoded = value.pop("body_state" if value["kind"] == "note" else "title_state")
                merge_bytes = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
                db.execute(
                    text(
                        "INSERT INTO authored_resources(account_id,ref,state,merge_bytes) "
                        "VALUES (:a,:k,CAST(:v AS jsonb),:b) ON CONFLICT(account_id,ref) "
                        "DO UPDATE SET state=excluded.state,merge_bytes=excluded.merge_bytes"
                    ),
                    {"a": account_id, "k": str(value[key]), "v": _json(value), "b": merge_bytes},
                )
                continue
            db.execute(
                text(
                    f"INSERT INTO {table}(account_id,{key},state) "
                    f"VALUES (:a,:k,CAST(:v AS jsonb)) ON CONFLICT(account_id,{key}) "
                    "DO UPDATE SET state=excluded.state"
                ),
                {"a": account_id, "k": str(value[key]), "v": _json(value)},
            )
            if name == "passages":
                semantic_key = hashlib.sha256(
                    _json(
                        {
                            "exact": value["normalized_exact"],
                            "prefix": value["prefix"],
                            "suffix": value["suffix"],
                        }
                    ).encode()
                ).hexdigest()
                db.execute(
                    text(
                        "UPDATE authored_passages SET semantic_key=:s WHERE account_id=:a AND anchor_id=:id"
                    ),
                    {"a": account_id, "id": str(value[key]), "s": semantic_key},
                )
    for projection in result.projections:
        db.execute(
            text("UPDATE authored_resources SET visible=:v WHERE account_id=:a AND ref=:r"),
            {"a": account_id, "r": projection.ref, "v": projection.visible},
        )
    from nexus.services.authored.projections import project

    project(db, account_id, result)


def read_states(
    db: Session, account_id: UUID, *, resource_refs: list[str], link_ids: list[str]
) -> Corpus:
    """Read exact command baselines inside the caller's transaction."""
    resources = list(
        db.scalars(
            text(
                f"SELECT {_state_sql('authored_resources')} FROM authored_resources WHERE account_id=:a AND ref=ANY(:refs)"
            ),
            {"a": account_id, "refs": resource_refs},
        )
    )
    links = list(
        db.scalars(
            text("SELECT state FROM authored_links WHERE account_id=:a AND link_id=ANY(:ids)"),
            {"a": account_id, "ids": link_ids},
        )
    )
    return Corpus.model_validate(
        {"resources": resources, "links": links, "passages": [], "source_stubs": []}
    )


def link_id(db: Session, account_id: UUID, endpoint_a: str, endpoint_b: str) -> str:
    """Resolve a permanent pair binding; the shared identity owner mints unseen ids."""
    lock_account(db, account_id)
    a, b = sorted((endpoint_a, endpoint_b))
    known = db.scalar(
        text(
            "SELECT link_id FROM authored_links WHERE account_id=:a "
            "AND state->>'endpoint_a'=:left AND state->>'endpoint_b'=:right"
        ),
        {"a": account_id, "left": a, "right": b},
    )
    if known is not None:
        return known
    return helper.call(
        {
            "op": "identity",
            "account_id": str(account_id),
            "kind": "link",
            "endpoint_a": a,
            "endpoint_b": b,
        }
    )["id"]


def daily_page_ref(db: Session, account_id: UUID, local_date: date) -> str:
    """Resolve a permanent date binding without materializing a latent day."""
    lock_account(db, account_id)
    known = db.scalar(
        text(
            "SELECT ref FROM authored_resources WHERE account_id=:a "
            "AND state->>'kind'='page' AND state->>'local_date'=:day"
        ),
        {"a": account_id, "day": local_date.isoformat()},
    )
    if known is not None:
        return known
    return helper.call(
        {
            "op": "identity",
            "account_id": str(account_id),
            "kind": "daily",
            "local_date": local_date.isoformat(),
        }
    )["ref"]


def server_command(
    db: Session,
    account_id: UUID,
    *,
    command: dict[str, Any],
    resource_refs: list[str],
    link_ids: list[str],
) -> MergeResult:
    """Flush one server intent into the caller's transaction; never commits.

    Existing tool-call completion must fence retries before calling. No tool may
    synthesize a stale replacement body: edits carry an actual Yjs baseline delta.
    """
    cursor = lock_account(db, account_id)
    replica = uuid5(account_id, "authored:server")
    db.execute(
        text(
            "INSERT INTO authored_replicas(account_id,replica_id,accepted_seq) VALUES (:a,:r,0) "
            "ON CONFLICT DO NOTHING"
        ),
        {"a": account_id, "r": replica},
    )
    sequence = _accepted(db, account_id, replica) + 1
    lamport = db.execute(
        text("SELECT lamport+1 FROM authored_heads WHERE account_id=:a"), {"a": account_id}
    ).scalar_one()
    intents = []

    def collect(intent: dict[str, Any]) -> None:
        if intent["kind"] == "batch":
            for child in intent["intents"]:
                collect(child)
        else:
            intents.append(intent)

    collect(command)
    endpoints = {
        intent[field]
        for intent in intents
        if intent["kind"] == "add_link"
        for field in ("endpoint_a", "endpoint_b")
    }
    sources = {intent["source_ref"] for intent in intents if "source_ref" in intent}
    states = read_states(
        db, account_id, resource_refs=list(set(resource_refs) | endpoints), link_ids=link_ids
    )
    # One untouched tail survives at most one removal/move per intent. This
    # bounded prefix lets the kernel append after earlier effects in the same
    # command without sending a large page's entire adjacency to Node. Ignore
    # this root's current visibility: an earlier intent may restore it. Link
    # membership and the opposite endpoint still determine candidate liveness.
    incident = []
    for endpoint in endpoints:
        for side in ("a", "b"):
            incident.extend(
                db.scalars(
                    text(
                        "SELECT l.state FROM authored_links l "
                        f"WHERE l.account_id=:a AND l.state->>'endpoint_{side}'=:ref "
                        "AND EXISTS (SELECT 1 FROM jsonb_each_text(l.state->'add_vv') dot "
                        "WHERE dot.value::bigint>COALESCE((l.state->'remove_vv'->>dot.key)::bigint,0)) "
                        "AND NOT EXISTS (SELECT 1 FROM authored_resources r WHERE r.account_id=:a "
                        f"AND r.ref=l.state->>'endpoint_{'b' if side == 'a' else 'a'}' AND NOT r.visible) "
                        f"ORDER BY (l.state #>> '{{position_{side},value}}') COLLATE \"C\" DESC NULLS LAST,l.link_id DESC "
                        "LIMIT :limit"
                    ),
                    {"a": account_id, "ref": endpoint, "limit": len(intents) + 1},
                )
            )
    pairs = [
        {"a": intent["endpoint_a"], "b": intent["endpoint_b"]}
        for intent in intents
        if intent["kind"] == "add_link"
    ]
    incident.extend(
        db.scalars(
            text(
                "SELECT l.state FROM jsonb_to_recordset(CAST(:pairs AS jsonb)) AS k(a text,b text) "
                "JOIN authored_links l ON l.account_id=:a AND l.state->>'endpoint_a'=k.a AND l.state->>'endpoint_b'=k.b"
            ),
            {"a": account_id, "pairs": _json(pairs)},
        )
    )
    values = states.model_dump(mode="json")
    values["links"] = list({row["link_id"]: row for row in values["links"] + incident}.values())
    values["passages"] = list(
        db.scalars(
            text(
                "SELECT state FROM authored_passages WHERE account_id=:a "
                "AND state->>'source_ref'=ANY(:refs)"
            ),
            {
                "a": account_id,
                "refs": [
                    intent["source_ref"]
                    for intent in intents
                    if intent["kind"] == "capture_passage"
                ],
            },
        )
    )
    values["source_stubs"] = list(
        db.scalars(
            text(
                "SELECT state FROM authored_source_stubs WHERE account_id=:a "
                "AND source_ref=ANY(:refs)"
            ),
            {"a": account_id, "refs": list(sources | endpoints)},
        )
    )
    states = Corpus.model_validate(values)
    prepared = helper.call(
        {
            "op": "prepare_server",
            "account_id": str(account_id),
            "states": states.model_dump(mode="json"),
            "replica_id": str(replica),
            "command_seq": str(sequence),
            "lamport": str(lamport),
            "command": command,
        }
    )
    change = Change.model_validate(prepared["change"])
    merged = MergeResult.model_validate(prepared["states"])
    result = _touched(merged, [change])
    _persist(db, account_id, result)
    db.execute(
        text(
            "INSERT INTO authored_changes(account_id,server_seq,replica_id,command_seq,change) "
            "VALUES (:a,:s,:r,:c,CAST(:v AS jsonb))"
        ),
        {
            "a": account_id,
            "s": cursor + 1,
            "r": replica,
            "c": sequence,
            "v": _json(change.model_dump(mode="json")),
        },
    )
    db.execute(
        text("UPDATE authored_replicas SET accepted_seq=:s WHERE account_id=:a AND replica_id=:r"),
        {"a": account_id, "r": replica, "s": sequence},
    )
    db.execute(
        text("UPDATE authored_heads SET head_seq=:s,lamport=:l WHERE account_id=:a"),
        {"a": account_id, "s": cursor + 1, "l": lamport},
    )
    db.execute(text("SELECT pg_notify('nexus_writing',:a)"), {"a": str(account_id)})
    return result


def download(db: Session, account_id: UUID, after: int) -> DownloadChanges:
    watermark = head(db, account_id)
    if after > watermark:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Cursor exceeds account head")
    changes: list[FeedChange] = []
    size = 256
    for row in db.execute(
        text(
            "SELECT server_seq,replica_id,change FROM authored_changes "
            "WHERE account_id=:a AND server_seq>:s AND server_seq<=:h "
            "ORDER BY server_seq LIMIT 100"
        ),
        {"a": account_id, "s": after, "h": watermark},
    ).mappings():
        change = FeedChange(
            server_seq=str(row["server_seq"]), replica_id=row["replica_id"], change=row["change"]
        )
        size += len(change.model_dump_json().encode()) + 1
        if size > MAX_ENVELOPE_BYTES:
            break
        changes.append(change)
    return DownloadChanges(
        annotations_revision=annotations_revision(db, viewer_id=account_id),
        changes=changes,
        next_cursor=changes[-1].server_seq if changes else str(after),
        head_cursor=str(watermark),
    )


def snapshot(db: Session, account_id: UUID) -> Iterator[str]:
    """Caller owns a fresh repeatable-read transaction until footer or cancellation."""
    captured = db.execute(
        text("SELECT head_seq,lamport FROM authored_heads WHERE account_id=:a"), {"a": account_id}
    ).one_or_none()
    watermark, lamport = (
        (str(captured[0]), str(captured[1])) if captured is not None else ("0", "1")
    )
    yield (
        _json(
            {"type": "header", "format_revision": 1, "head_cursor": watermark, "lamport": lamport}
        )
        + "\n"
    )
    counts = {}
    for name, (table, key) in TABLES.items():
        count = 0
        kind = {
            "resources": "resource",
            "links": "link",
            "passages": "passage",
            "source_stubs": "source_stub",
        }[name]
        for state in db.scalars(
            text(f"SELECT {_state_sql(table)} FROM {table} WHERE account_id=:a ORDER BY {key}"),
            {"a": account_id},
            # Bound buffering by one encoded state, even for heavily edited notes.
            execution_options={"yield_per": 1},
        ):
            count += 1
            yield _json({"type": kind, "state": state}) + "\n"
        counts[name] = count
    yield (
        _json(
            {
                "type": "footer",
                "format_revision": 1,
                "head_cursor": watermark,
                "lamport": lamport,
                "counts": counts,
            }
        )
        + "\n"
    )
