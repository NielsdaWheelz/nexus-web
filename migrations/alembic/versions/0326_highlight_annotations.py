"""Consume attached notes into permanent highlight bodies at authored format 3.

All writers and workers must be stopped and a verified backup retained. This one
transaction inventories recoverable canonical state and typed references, refuses
ambiguous conversion with record ids, transfers Yjs structs and index identities,
and retires consumed notes. Accepted feed bytes and replica prefixes are immutable.
The sibling converter is frozen and bundled; no application code runs here.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import subprocess
from collections import defaultdict
from functools import cache
from pathlib import Path
from uuid import UUID, uuid5

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0326"
down_revision = "0325"
branch_labels = None
depends_on = None

_MAX_COUNTER = (1 << 63) - 1
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_NOTE_HREF = re.compile(r"^/notes/([0-9a-f-]{36})(\?[^#]*)?(#.*)?$")
_REF_KEYS = frozenset(
    {
        "ref",
        "resource_ref",
        "owner_ref",
        "source_ref",
        "target_ref",
        "action_ref",
        "candidate_ref",
        "activation_ref",
        "citation_target",
        "resource_uri",
        "uri",
        "source_uri",
        "target_uri",
        "context_ref",
        "admission_scope",
        "note_uri",
    }
)
# These are literal captures, never destinations, even when they contain a URI.
_LITERAL_KEYS = frozenset(
    {
        "quote",
        "text_quote",
        "text_quote_selector",
        "label",
        "title",
        "text",
        "content",
        "body_text",
        "exact",
        "quote_exact",
        "prefix",
        "suffix",
        "rationale",
        "snippet",
        "reader_quote",
        "annotation",
        "note",
        "markdown",
        "content_sha256",
    }
)


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _ref(scheme, ident) -> str:
    return f"{scheme}:{ident}"


def _parts(ref: str) -> tuple[str, UUID]:
    scheme, sep, ident = ref.partition(":")
    if not sep or not _UUID.fullmatch(ident):
        _refuse(ref, "invalid canonical resource reference", "repair its identity")
    return scheme, UUID(ident)


def _refuse(record, reason, repair="repair the named records before retrying"):
    raise RuntimeError(f"0326 {record}: {reason}; {repair}")


@cache
def _node_binary() -> str:
    return subprocess.run(
        ["node", "-p", "process.execPath"],
        text=True,
        capture_output=True,
        timeout=30,
        check=True,
    ).stdout.strip()


def _helper(value: dict) -> dict:
    result = subprocess.run(
        [
            _node_binary(),
            "--max-old-space-size=256",
            str(Path(__file__).with_suffix(".mjs")),
        ],
        input=_json(value),
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
        env={"NODE_ENV": "production", "PATH": "/usr/local/bin:/usr/bin:/bin"},
    )
    if result.returncode:
        _refuse(
            "frozen converter", result.stderr.strip(), "repair the named source state"
        )
    return json.loads(result.stdout)


def _live(add: dict, remove: dict) -> bool:
    return any(
        int(value) > int(remove.get(replica, "0")) for replica, value in add.items()
    )


def _counter(value, record, *, positive=False) -> int:
    if not isinstance(value, str) or re.fullmatch(r"0|[1-9][0-9]*", value) is None:
        _refuse(record, f"noncanonical counter {value!r}")
    count = int(value)
    if count > _MAX_COUNTER or (positive and count == 0):
        _refuse(record, f"counter outside signed bigint range: {value}")
    return count


def _causality(value, replicas, record) -> int:
    maximum = 0
    if isinstance(value, dict):
        if "stamp" in value:
            stamp = value["stamp"]
            if not isinstance(stamp, dict) or set(stamp) != {"lamport", "replica_id"}:
                _refuse(record, "unsupported register stamp")
            if stamp["replica_id"] not in replicas:
                _refuse(record, f"unregistered stamp replica {stamp['replica_id']}")
            maximum = _counter(stamp["lamport"], record, positive=True)
        for key, child in value.items():
            if key in {"touch_vv", "delete_vv", "add_vv", "remove_vv"}:
                if not isinstance(child, dict):
                    _refuse(record, f"invalid {key}")
                for replica, sequence in child.items():
                    count = _counter(sequence, record)
                    if replica not in replicas or count > replicas[replica]:
                        _refuse(
                            record,
                            f"{key} exceeds registered accepted prefix {replica}:{sequence}",
                        )
            maximum = max(maximum, _causality(child, replicas, record))
    elif isinstance(value, list):
        for child in value:
            maximum = max(maximum, _causality(child, replicas, record))
    return maximum


def _rows(db, table, columns="*", where="", params=None):
    return [
        dict(row)
        for row in db.execute(
            sa.text(f"SELECT {columns} FROM {table} {where}"), params or {}
        ).mappings()
    ]


def _inventory(db):
    heads = {
        str(row["account_id"]): row
        for row in _rows(db, "authored_heads", where="ORDER BY account_id FOR UPDATE")
    }
    notes = {str(row["id"]): row for row in _rows(db, "note_blocks")}
    highlights = {str(row["id"]): row for row in _rows(db, "highlights")}
    resources = _rows(db, "authored_resources", where="ORDER BY account_id,ref")
    links = _rows(db, "authored_links", where="ORDER BY account_id,link_id")
    passages = _rows(db, "authored_passages", where="ORDER BY account_id,anchor_id")
    stubs = _rows(db, "authored_source_stubs", where="ORDER BY account_id,source_ref")
    replicas = defaultdict(dict)
    for row in _rows(db, "authored_replicas"):
        replicas[str(row["account_id"])][str(row["replica_id"])] = row["accepted_seq"]
    by_ref = {}
    maxima = {account: int(head["lamport"]) for account, head in heads.items()}
    for table, rows, identity in (
        ("authored_resources", resources, "ref"),
        ("authored_links", links, "link_id"),
        ("authored_passages", passages, "anchor_id"),
        ("authored_source_stubs", stubs, "source_ref"),
    ):
        for row in rows:
            account, state = str(row["account_id"]), row["state"]
            record = f"{table} {row[identity]} account {account}"
            if (
                account not in heads
                or not isinstance(state, dict)
                or state.get(identity) != row[identity]
            ):
                _refuse(record, "missing account head or inconsistent state identity")
            maxima[account] = max(
                maxima[account], _causality(state, replicas[account], record)
            )
            if table != "authored_resources":
                expected = {
                    "authored_links": {
                        "link_id",
                        "endpoint_a",
                        "endpoint_b",
                        "add_vv",
                        "remove_vv",
                        "position_a",
                        "position_b",
                    },
                    "authored_passages": {
                        "anchor_id",
                        "source_ref",
                        "normalized_exact",
                        "prefix",
                        "suffix",
                        "capture",
                    },
                    "authored_source_stubs": {"source_ref", "capture"},
                }[table]
                if set(state) != expected:
                    _refuse(
                        record,
                        f"unsupported canonical fields {sorted(set(state) ^ expected)}",
                    )
                if table == "authored_links":
                    for side in ("position_a", "position_b"):
                        position = state[side]
                        if position is not None and (
                            not isinstance(position, dict)
                            or set(position) != {"value", "stamp"}
                            or not isinstance(position["value"], str)
                            or not position["value"]
                        ):
                            _refuse(record, f"unsupported {side} register")
                continue
            scheme, ident = _parts(row["ref"])
            kind = state.get("kind")
            if {"note": "note_block", "page": "page", "highlight": "highlight"}.get(
                kind
            ) != scheme:
                _refuse(record, "resource kind disagrees with its ref")
            expected = {"ref", "kind", "touch_vv", "delete_vv"} | {
                "note": set(),
                "page": {"local_date"},
                "highlight": {"source_ref", "selection", "color"},
            }[kind]
            if set(state) != expected:
                _refuse(
                    record,
                    f"unsupported old resource fields {sorted(set(state) ^ expected)}",
                )
            if (kind in ("note", "page")) != (row["merge_bytes"] is not None):
                _refuse(record, "body/title merge-byte shape disagrees with old format")
            live = _live(state["touch_vv"], state["delete_vv"])
            if live != row["visible"]:
                _refuse(record, "canonical visibility disagrees with causal liveness")
            if kind in ("note", "highlight"):
                relational = (notes if kind == "note" else highlights).get(str(ident))
                if relational is None or relational["user_id"] != row["account_id"]:
                    _refuse(record, "missing or cross-owner relational projection")
                if relational["authored_visible"] != live:
                    _refuse(
                        record, "relational liveness disagrees with canonical state"
                    )
            by_ref[(account, row["ref"])] = row
    for scheme, values in (("note_block", notes), ("highlight", highlights)):
        for ident, row in values.items():
            if (str(row["user_id"]), _ref(scheme, ident)) not in by_ref:
                _refuse(f"{scheme}:{ident}", "projection has no canonical resource")
    _helper(
        {
            "op": "validate_positions",
            "positions": [
                {"record": row["link_id"], "value": row["state"][side]["value"]}
                for row in links
                for side in ("position_a", "position_b")
                if row["state"][side] is not None
            ],
        }
    )
    mapping, attachments = {}, {}
    for row in links:
        account, state = str(row["account_id"]), row["state"]
        a, b = state["endpoint_a"], state["endpoint_b"]
        if a >= b:
            _refuse(f"link {row['link_id']}", "unsorted or self endpoints")
        for endpoint in (a, b):
            scheme, _ = _parts(endpoint)
            if (
                scheme in {"note_block", "highlight", "page"}
                and (account, endpoint) not in by_ref
            ):
                _refuse(
                    f"link {row['link_id']} {endpoint}",
                    "missing or cross-owner authored endpoint",
                )
        kinds = {a.split(":")[0], b.split(":")[0]}
        if kinds != {"note_block", "highlight"}:
            continue
        note, highlight = (a, b) if a.startswith("note_block:") else (b, a)
        if note in mapping or highlight in attachments:
            _refuse(
                f"link {row['link_id']} note {note} highlight {highlight}",
                "multiple or shared recoverable annotation attachments",
                "reduce each note/highlight to one unambiguous attachment, including hidden bindings",
            )
        if not _live(state["add_vv"], state["remove_vv"]):
            _refuse(
                f"link {row['link_id']} note {note} highlight {highlight}",
                "removed attachment cannot become a permanent body without reviving writing",
                "explicitly restore or retire this attachment before retrying",
            )
        if (
            by_ref[(account, note)]["visible"]
            != by_ref[(account, highlight)]["visible"]
        ):
            _refuse(
                f"link {row['link_id']} note {note} highlight {highlight}",
                "annotation and highlight liveness differ",
                "reconcile their liveness before retrying",
            )
        mapping[note] = highlight
        attachments[highlight] = row["link_id"]
    for account, maximum in maxima.items():
        server = str(uuid5(UUID(account), "authored:server:3"))
        if server in replicas[account] or maximum >= _MAX_COUNTER:
            _refuse(
                f"account {account}",
                "format-3 reserved replica collision or lamport exhaustion",
            )
    return {
        "notes": notes,
        "highlights": highlights,
        "resources": resources,
        "links": links,
        "passages": passages,
        "stubs": stubs,
        "heads": heads,
        "maxima": maxima,
        "by_ref": by_ref,
        "mapping": mapping,
        "attachments": attachments,
    }


def _convert_bodies(inventory):
    mapping = inventory["mapping"]
    bodies, batch, size = {}, [], 0

    def flush():
        if not batch:
            return
        result = _helper({"op": "bodies", "mapping": mapping, "bodies": batch})
        bodies.update((body["ref"], body) for body in result["bodies"])
        batch.clear()

    for row in inventory["resources"]:
        if row["state"]["kind"] not in {"note", "highlight"}:
            continue
        state = (
            base64.urlsafe_b64encode(bytes(row["merge_bytes"])).decode().rstrip("=")
            if row["merge_bytes"] is not None
            else None
        )
        if batch and (len(batch) >= 16 or size + len(state or "") > 4 * 1024 * 1024):
            flush()
            size = 0
        batch.append({"ref": row["ref"], "state": state})
        size += len(state or "")
    flush()
    for note, highlight in mapping.items():
        bodies[highlight] = dict(bodies[note], ref=highlight)
    inventory["bodies"] = bodies


def _retarget_links(inventory):
    mapping, removed = inventory["mapping"], set(inventory["attachments"].values())
    rows, incident = {}, defaultdict(list)
    for row in inventory["links"]:
        state = row["state"]
        rows[row["link_id"]] = row
        for endpoint in (state["endpoint_a"], state["endpoint_b"]):
            incident[(str(row["account_id"]), endpoint)].append(state)

    def order(links, endpoint):
        def key(link):
            position = (
                link["position_a"]
                if link["endpoint_a"] == endpoint
                else link["position_b"]
            )
            return (
                position is None,
                position["value"] if position is not None else "",
                link["link_id"],
            )

        return sorted(links, key=key)

    # Save explicit endpoint positions before changing endpoint sort order.
    positions = {}
    for identity, row in rows.items():
        state = row["state"]
        positions[identity] = {
            state["endpoint_a"]: state["position_a"],
            state["endpoint_b"]: state["position_b"],
        }
    for note, highlight in mapping.items():
        account = str(inventory["highlights"][highlight.split(":")[1]]["user_id"])
        attachment = inventory["attachments"][highlight]
        adjacency = order(incident[(account, highlight)], highlight)
        neighbours = [
            link
            for link in order(incident[(account, note)], note)
            if link["link_id"] != attachment
        ]
        replacement = []
        for link in adjacency:
            replacement.extend(neighbours if link["link_id"] == attachment else [link])
        # Re-space this endpoint only. Opposite endpoints retain their original keys,
        # including ties and null positions, and therefore their exact relative order.
        keys = _helper(
            {"op": "positions", "lower": None, "upper": None, "count": len(replacement)}
        )["positions"]
        stamp = {
            "lamport": str(inventory["maxima"][account] + 1),
            "replica_id": str(uuid5(UUID(account), "authored:server:3")),
        }
        for link, key in zip(replacement, keys, strict=True):
            identity = link["link_id"]
            positions[identity].pop(note, None)
            previous = positions[identity].get(highlight)
            positions[identity][highlight] = (
                previous
                if previous is not None and previous["value"] == key
                else {"value": key, "stamp": stamp}
            )
    pairs, converted = {}, []
    for identity, row in rows.items():
        if identity in removed:
            continue
        state, account = dict(row["state"]), str(row["account_id"])
        old_a, old_b = state["endpoint_a"], state["endpoint_b"]
        a, b = sorted((mapping.get(old_a, old_a), mapping.get(old_b, old_b)))
        if a == b:
            _refuse(f"link {identity}", f"retargeting creates self-link at {a}")
        pair = (account, a, b)
        if pair in pairs:
            _refuse(
                f"links {identity} and {pairs[pair]}",
                f"retargeting collides at {a} ↔ {b}, including hidden bindings",
            )
        pairs[pair] = identity
        endpoint_positions = positions[identity]
        state.update(
            endpoint_a=a,
            endpoint_b=b,
            position_a=endpoint_positions[a],
            position_b=endpoint_positions[b],
        )
        converted.append(dict(row, state=state))
    inventory["converted_links"] = converted
    inventory["removed_links"] = removed


def _href(value, inventory, record):
    if not isinstance(value, str):
        return value
    match = _NOTE_HREF.fullmatch(value)
    if match is None:
        return value
    target = inventory["mapping"].get(_ref("note_block", match[1]))
    if target is None:
        return value
    fragment = match[3]
    if fragment and (
        not fragment.startswith("#passage-") or _UUID.fullmatch(fragment[9:]) is None
    ):
        _refuse(
            record,
            f"unsupported saved note fragment {value!r}",
            "repair this destination explicitly",
        )
    return (
        f"/highlights/{target.split(':')[1]}{match[2] or ''}{fragment or '#annotation'}"
    )


def _quote(value):
    if not isinstance(value, dict) or not isinstance(value.get("exact"), str):
        return None
    if any(
        value.get(key) is not None and not isinstance(value[key], str)
        for key in ("prefix", "suffix")
    ):
        return None
    return {**value, "prefix": value.get("prefix"), "suffix": value.get("suffix")}


def _locator(
    value,
    inventory,
    record,
    quote=None,
    publication=None,
    *,
    internal=False,
    proved_hash=None,
):
    if not isinstance(value, dict):
        _refuse(record, "locator is not an object")
    ident = value.get("note_block_id" if internal else "block_id")
    target = inventory["mapping"].get(_ref("note_block", ident))
    if target is None:
        return dict(value)
    expected_kind = "note_text" if internal else "note_block_offsets"
    if value.get("kind" if internal else "type") != expected_kind:
        _refuse(record, f"unsupported note locator {value!r}")
    allowed = (
        {"kind", "note_block_id", "start_offset", "end_offset", "text_quote"}
        if internal
        else {
            "type",
            "block_id",
            "start_offset",
            "end_offset",
            "text_quote_selector",
            "body_version",
        }
    )
    if set(value) - allowed:
        _refuse(record, f"unknown note locator fields {sorted(set(value) - allowed)}")
    start, end = value.get("start_offset"), value.get("end_offset")
    if type(start) is not int or type(end) is not int or not 0 <= start < end:
        _refuse(record, "annotation offsets are not a nonempty codepoint range")
    selector = _quote(
        value.get("text_quote" if internal else "text_quote_selector")
    ) or _quote(quote)
    if selector is None or not selector["exact"]:
        _refuse(
            record,
            "annotation evidence lacks its frozen quote selector",
            "recover the original selector; current body text cannot substitute for historical evidence",
        )
    digest = proved_hash
    if isinstance(publication, dict) and publication.get("kind") == "note_text":
        digest = publication.get("sha256")
    if digest is not None and (
        not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None
    ):
        _refuse(record, "invalid original full-text provenance hash")
    return {
        "kind" if internal else "type": "highlight_annotation_text"
        if internal
        else "highlight_annotation_offsets",
        "highlight_id": target.split(":")[1],
        "start_offset": start,
        "end_offset": end,
        "text_quote" if internal else "text_quote_selector": selector,
        "body_sha256": digest,
    }


def _convert_json(
    value, inventory, record, *, owner=None, quote=None, publication=None
):
    """Rewrite only closed typed destinations. Literal words and evidence remain frozen."""
    mapping = inventory["mapping"]
    if isinstance(value, list):
        return [
            _convert_json(
                item,
                inventory,
                f"{record}[{index}]",
                owner=owner,
                quote=quote,
                publication=publication,
            )
            for index, item in enumerate(value)
        ]
    if not isinstance(value, dict):
        return value
    original = value
    value = dict(value)
    if isinstance(value.get("quote"), dict):
        quote = value["quote"]
    elif isinstance(value.get("quote_exact"), str):
        quote = {
            "exact": value["quote_exact"],
            "prefix": value.get("prefix"),
            "suffix": value.get("suffix"),
        }
    publication = value.get("publication", publication)
    if value.get("type") == "note_block_offsets":
        return _locator(value, inventory, record, quote, publication)
    if value.get("kind") == "note_text":
        return _locator(value, inventory, record, quote, publication, internal=True)
    if value.get("kind") == "resource_embed":
        _refuse(record, "rich body appeared outside its authoritative Yjs converter")
    field_ref = None
    if (
        value.get("kind") in {"resource", "passage", "unavailable"}
        and "owner_ref" in value
    ):
        field_ref = value["owner_ref"]
    elif value.get("kind") in {"route", "external", "none"} and "resource_ref" in value:
        field_ref = value["resource_ref"]
    elif value.get("type") in {
        "media",
        "podcast",
        "episode",
        "video",
        "content_chunk",
        "fragment",
        "contributor",
        "page",
        "note_block",
        "highlight",
        "message",
        "evidence_span",
        "conversation",
        "web_result",
        "reader_apparatus_item",
    } and (
        "evidence_span_ids" in value
        or "passage_target" in value
        or record.endswith(".context_ref")
    ):
        field_ref = _ref(value["type"], value.get("id"))
    elif "resource_uri" in value and "admission_scope" in value:
        field_ref = value["resource_uri"]
    elif "target_kind" in value and "target_id" in value:
        field_ref = _ref(value["target_kind"], value["target_id"])
    elif value.get("kind") == "resource" and "resource_ref" in value:
        field_ref = value["resource_ref"]
    elif value.get("kind") == "reference" and "target_ref" in value:
        field_ref = value["target_ref"]
    elif (
        value.get("kind") in {"entry", "note_block", "highlight", "edge", "queue"}
        and "id" in value
        and "label" in value
    ):
        field_ref = _ref(value["kind"], value["id"])
    if field_ref is not None and not isinstance(field_ref, str):
        _refuse(record, "typed field target is not a resource reference")
    field_shape = field_ref is not None or (
        value.get("kind") == "unavailable" and "owner_ref" in value
    )
    if field_shape:
        if "field" in value:
            _refuse(record, "old-format target already contains a field")
        value["field"] = "annotation" if field_ref in mapping else None
    if field_ref in mapping:
        note_id = field_ref.split(":")[1]
        note_owner = inventory["notes"][note_id]["user_id"]
        if owner is not None and UUID(str(owner)) != note_owner:
            _refuse(record, f"cross-owner private annotation target {field_ref}")
        target_id = mapping[field_ref].split(":")[1]
        if value.get("type") == "note_block" and "id" in value:
            value.update(type="highlight", id=target_id)
        if value.get("kind") == "note_block":
            value.update(kind="highlight", id=target_id)
        if value.get("target_kind") == "note_block":
            value.update(target_kind="highlight", target_id=target_id)
    # Persisted search results keep the exact witness but adopt its annotation owner.
    old_result = (
        _ref("note_block", original.get("id"))
        if original.get("type") == "note_block"
        else None
    )
    if old_result in mapping:
        value.update(type="highlight", id=mapping[old_result].split(":")[1])
        if any(
            key in original
            for key in ("source_id", "result_type", "captured_evidence", "resource_ref")
        ):
            value["matched_field"] = "annotation"
        if "source_id" in value:
            value["source_id"] = mapping[old_result].split(":")[1]
        if "result_type" in value:
            value["result_type"] = "highlight"
        value.pop("note_origin", None)
        value.pop("highlight_excerpt", None)
    if (
        value.get("type") == "highlight"
        and "source_id" in value
        and "matched_field" not in value
    ):
        value["matched_field"] = "annotation" if field_ref in mapping else "quote"
    for key, child in list(value.items()):
        path = f"{record}.{key}"
        if key in _LITERAL_KEYS:
            continue
        if key in _REF_KEYS or key == "owner_resource_ref":
            if isinstance(child, str):
                value[key] = mapping.get(child, child)
                continue
        if key in {"href", "deep_link"}:
            value[key] = _href(child, inventory, path)
            continue
        if key == "locator" and isinstance(child, str) and child.startswith("{"):
            try:
                stored = json.loads(child)
            except ValueError:
                _refuse(path, "malformed serialized evidence locator")
            value[key] = _json(
                _convert_json(
                    stored,
                    inventory,
                    path,
                    owner=owner,
                    quote=quote,
                    publication=publication,
                )
            )
            continue
        value[key] = _convert_json(
            child, inventory, path, owner=owner, quote=quote, publication=publication
        )
    if (
        "passage_target" in value
        and isinstance(value["passage_target"], dict)
        and "field" in value
    ):
        value["field"] = value["passage_target"]["field"]
    # Receipt labels and captured source titles never follow current names.
    if "note_uri" in original and original["note_uri"] in mapping:
        if (
            "highlight_uri" in value
            and value["highlight_uri"] != mapping[original["note_uri"]]
        ):
            _refuse(record, "tool result names a different highlight and consumed note")
        value["highlight_uri"] = mapping[original["note_uri"]]
        value.pop("note_uri")
    return value


def _passages(inventory):
    pairs = {}
    for row in inventory["passages"]:
        account, state = str(row["account_id"]), dict(row["state"])
        old = state["source_ref"]
        target = inventory["mapping"].get(old, old)
        state = _convert_json(
            state, inventory, f"authored passage {row['anchor_id']}", owner=account
        )
        state["source_ref"] = target
        if old != target:
            state["capture"] = dict(
                state["capture"],
                stamp={
                    "lamport": str(inventory["maxima"][account] + 1),
                    "replica_id": str(uuid5(UUID(account), "authored:server:3")),
                },
            )
        semantic = (
            account,
            target,
            state["normalized_exact"],
            state["prefix"],
            state["suffix"],
        )
        if semantic in pairs:
            _refuse(
                f"passages {row['anchor_id']} and {pairs[semantic]}",
                "retargeted passage semantic-key collision",
            )
        quote = {
            "exact": state["normalized_exact"],
            "prefix": state["prefix"],
            "suffix": state["suffix"],
        }
        if hashlib.sha256(_json(quote).encode()).hexdigest() != row["semantic_key"]:
            _refuse(
                f"passage {row['anchor_id']}",
                "stored semantic key disagrees with its frozen quote",
            )
        pairs[semantic] = row["anchor_id"]
        row["state"] = state


def _receipts(db, inventory):
    seen, converted = {}, []
    for row in _rows(db, "tool_calls", "id,principal_user_id,created_refs"):
        refs = row["created_refs"]
        if not isinstance(refs, list):
            _refuse(f"tool call {row['id']}", "created_refs is not an array")
        result = []
        for index, receipt in enumerate(refs):
            record = f"tool call {row['id']} receipt {index}"
            if (
                not isinstance(receipt, dict)
                or receipt.get("kind")
                not in {"entry", "note_block", "highlight", "edge", "queue"}
                or "field" in receipt
            ):
                _refuse(record, "unsupported old creation authority")
            receipt = dict(receipt, field=None)
            old = _ref(receipt["kind"], receipt.get("id"))
            if old in inventory["mapping"]:
                note = inventory["notes"][str(receipt["id"])]
                if note["user_id"] != row["principal_user_id"]:
                    _refuse(record, "creation authority belongs to another account")
                receipt.update(
                    kind="highlight",
                    id=inventory["mapping"][old].split(":")[1],
                    field="annotation",
                )
            key = (
                str(row["principal_user_id"]),
                receipt["kind"],
                str(receipt["id"]),
                receipt["field"],
            )
            if key in seen:
                _refuse(
                    f"{record} and tool call {seen[key]}",
                    f"ambiguous independent creation authorities for {key[1:]}",
                    "repair creation provenance without merging authorities",
                )
            seen[key] = row["id"]
            result.append(receipt)
        converted.append((row["id"], result))
    inventory["receipts"] = converted


def _audit_json(value, inventory, record):
    if isinstance(value, list):
        for index, child in enumerate(value):
            _audit_json(child, inventory, f"{record}[{index}]")
    elif isinstance(value, dict):
        if (
            any(value.get(key) == "note_block" for key in ("type", "kind", "scheme"))
            and _ref("note_block", value.get("id")) in inventory["mapping"]
        ):
            _refuse(record, "unsupported typed consumed-note identity")
        for key, child in value.items():
            if key in _LITERAL_KEYS:
                continue
            if isinstance(child, str):
                if child in inventory["mapping"] or (
                    (
                        key in {"note_block_id", "block_id"}
                        or "note" in key
                        and key.endswith("_id")
                    )
                    and _ref("note_block", child) in inventory["mapping"]
                ):
                    _refuse(
                        f"{record}.{key}",
                        f"unsupported surviving consumed-note target {child}",
                        "add an explicit lossless conversion for this typed shape",
                    )
                match = _NOTE_HREF.fullmatch(child)
                if match and _ref("note_block", match[1]) in inventory["mapping"]:
                    _refuse(
                        f"{record}.{key}",
                        f"unsupported surviving consumed-note destination {child}",
                    )
            _audit_json(child, inventory, f"{record}.{key}")
        if value.get("field") == "annotation":
            ref = value.get(
                "owner_ref", value.get("resource_ref", value.get("resource_uri"))
            )
            if ref is not None and (
                not isinstance(ref, str) or not ref.startswith("highlight:")
            ):
                _refuse(record, "annotation field targets a non-highlight")


def _plan_relational(db, inventory):
    mapping = inventory["mapping"]
    converted_links = {row["link_id"]: row for row in inventory["converted_links"]}
    edges = _rows(db, "resource_edges", where="ORDER BY id")
    old_edges = {str(row["id"]): row for row in edges}
    old_links = {row["link_id"]: row for row in inventory["links"]}
    planned_edges, pairs = [], {}
    for edge in edges:
        identity = str(edge["id"])
        account = str(edge["user_id"])
        source, target = (
            _ref(edge["source_scheme"], edge["source_id"]),
            _ref(edge["target_scheme"], edge["target_id"]),
        )
        if identity in old_links:
            canonical = old_links[identity]
            if canonical["account_id"] != edge["user_id"] or {source, target} != {
                canonical["state"]["endpoint_a"],
                canonical["state"]["endpoint_b"],
            }:
                _refuse(
                    f"edge {identity}",
                    "canonical/relational endpoint or owner mismatch",
                )
        if identity in inventory["removed_links"]:
            continue
        for endpoint in (source, target):
            if (
                endpoint in mapping
                and inventory["notes"][endpoint.split(":")[1]]["user_id"]
                != edge["user_id"]
            ):
                _refuse(f"edge {identity}", f"cross-owner consumed note {endpoint}")
        if identity in converted_links:
            canonical = converted_links[identity]
            old_state = old_links[identity]["state"]
            expected_live = _live(old_state["add_vv"], old_state["remove_vv"]) and all(
                inventory["by_ref"].get((account, endpoint), {"visible": True})[
                    "visible"
                ]
                for endpoint in (source, target)
            )
            if edge["authored_visible"] != expected_live:
                _refuse(
                    f"edge {identity}",
                    "relational link visibility disagrees with canonical liveness",
                )
            state = canonical["state"]
            source, target = state["endpoint_a"], state["endpoint_b"]
            edge["origin"] = "user"
            edge["authored_visible"] = _live(
                state["add_vv"], state["remove_vv"]
            ) and all(
                inventory["by_ref"].get((account, endpoint), {"visible": True})[
                    "visible"
                ]
                for endpoint in (source, target)
            )
        elif edge["origin"] in {"user", "highlight_note", "link_note"}:
            _refuse(
                f"edge {identity}", "authored relational link has no canonical binding"
            )
        else:
            source, target = mapping.get(source, source), mapping.get(target, target)
        if source == target:
            _refuse(f"edge {identity}", f"retargeting creates a self-link at {source}")
        edge["source_scheme"], edge["source_id"] = _parts(source)
        edge["target_scheme"], edge["target_id"] = _parts(target)
        edge["snapshot"] = _convert_json(
            edge["snapshot"],
            inventory,
            f"edge {identity}.snapshot",
            owner=edge["user_id"],
        )
        _audit_json(edge["snapshot"], inventory, f"edge {identity}.snapshot")
        if (
            edge["origin"] != "user"
            and edge["ordinal"] is None
            and edge["source_order_key"] is None
        ):
            key = (account, edge["origin"], source, target)
            if key in pairs:
                _refuse(
                    f"edges {identity} and {pairs[key]}",
                    "retargeting collides in nonuser pair binding",
                )
            pairs[key] = identity
        planned_edges.append(edge)
    missing = set(converted_links) - set(old_edges)
    if missing:
        _refuse(
            f"links {sorted(missing)}", "canonical links have no relational projection"
        )
    inventory["edges"] = planned_edges
    views, view_keys = [], {}
    for row in _rows(db, "resource_view_states", where="ORDER BY id"):
        edge_id = str(row["edge_id"]) if row["edge_id"] is not None else None
        if edge_id in inventory["removed_links"]:
            continue
        for side in ("surface", "target"):
            if row[f"{side}_scheme"] is None:
                continue
            ref = _ref(row[f"{side}_scheme"], row[f"{side}_id"])
            if ref in mapping:
                if inventory["notes"][ref.split(":")[1]]["user_id"] != row["user_id"]:
                    _refuse(f"view state {row['id']}", "cross-owner consumed-note view")
                row[f"{side}_scheme"], row[f"{side}_id"] = _parts(mapping[ref])
        if edge_id in converted_links:
            state = converted_links[edge_id]["state"]
            ref = _ref(row["surface_scheme"], row["surface_id"])
            if ref not in (state["endpoint_a"], state["endpoint_b"]):
                _refuse(f"view state {row['id']}", "link rank is at a non-endpoint")
            position = (
                state["position_a"]
                if ref == state["endpoint_a"]
                else state["position_b"]
            )
            row["order_key"] = position["value"] if position is not None else None
        if edge_id is not None:
            key = (row["user_id"], row["surface_scheme"], row["surface_id"], edge_id)
            if key in view_keys:
                _refuse(
                    f"view states {row['id']} and {view_keys[key]}",
                    "retargeted endpoint occurrence collision",
                )
            view_keys[key] = row["id"]
        views.append(row)
    inventory["views"] = views
    versions, version_keys = [], {}
    for row in _rows(db, "resource_versions"):
        ref = _ref(row["resource_scheme"], row["resource_id"])
        if ref in mapping:
            row["resource_scheme"], row["resource_id"] = _parts(mapping[ref])
        key = (row["user_id"], row["resource_scheme"], row["resource_id"], row["lane"])
        if key in version_keys:
            _refuse(
                f"versions {row['id']} and {version_keys[key]}",
                "retargeted concurrency-lane collision",
            )
        version_keys[key] = row["id"]
        versions.append(row)
    inventory["versions"] = versions
    canonical_passages = {
        (str(row["account_id"]), row["anchor_id"]): row for row in inventory["passages"]
    }
    anchors, anchor_keys = [], {}
    for row in _rows(db, "passage_anchors"):
        canonical = canonical_passages.get((str(row["user_id"]), str(row["id"])))
        if canonical is None:
            _refuse(f"passage anchor {row['id']}", "missing canonical passage")
        source = _ref(row["owner_scheme"], row["owner_id"])
        if source in mapping:
            if inventory["notes"][source.split(":")[1]]["user_id"] != row["user_id"]:
                _refuse(
                    f"passage anchor {row['id']}", "cross-owner consumed annotation"
                )
            row["owner_scheme"], row["owner_id"] = _parts(mapping[source])
            selector = row["selector"]
            if not isinstance(selector, dict) or set(selector) != {
                "quote",
                "locator_hint",
            }:
                _refuse(f"passage anchor {row['id']}", "unsupported passage selector")
            locator = canonical["state"]["capture"]["value"]["locator"]
            hint = None
            if locator is not None:
                if locator["type"] != "highlight_annotation_offsets":
                    _refuse(
                        f"passage anchor {row['id']}",
                        "annotation passage has a non-annotation locator",
                    )
                hint = {
                    "kind": "highlight_annotation_text",
                    "highlight_id": locator["highlight_id"],
                    "start_offset": locator["start_offset"],
                    "end_offset": locator["end_offset"],
                    "body_sha256": locator["body_sha256"],
                }
            row["selector"] = dict(selector, locator_hint=hint)
        key = (row["user_id"], row["owner_scheme"], row["owner_id"], row["anchor_key"])
        if key in anchor_keys:
            _refuse(
                f"passage anchors {row['id']} and {anchor_keys[key]}",
                "retargeted semantic-key collision",
            )
        anchor_keys[key] = row["id"]
        anchors.append(row)
    inventory["anchors"] = anchors
    # Grants cannot become private-field grants. They were never valid note grants.
    for grant in _rows(db, "resource_grants"):
        if _ref(grant["subject_scheme"], grant["subject_id"]) in mapping:
            _refuse(
                f"grant {grant['id']}",
                "consumed note has a sharing grant",
                "revoke the unsupported note grant explicitly; a quote grant cannot authorize an annotation",
            )


def _plan_json(db, inventory):
    updates = []
    owners = {
        str(row["id"]): row["owner_user_id"]
        for row in _rows(db, "conversations", "id,owner_user_id")
    }
    message_owners = {
        str(row["id"]): owners[str(row["conversation_id"])]
        for row in _rows(db, "messages", "id,conversation_id")
    }
    definitions = (
        ("workspace_sessions", ("state",), "user_id"),
        ("messages", ("reader_selection_snapshot", "branch_anchor"), None),
        ("tool_calls", ("arguments", "result"), "principal_user_id"),
        (
            "message_retrievals",
            ("context_ref", "result_ref", "captured_evidence", "locator"),
            None,
        ),
        ("chat_run_events", ("payload",), None),
        ("llm_calls", ("generation_spec", "terminal"), None),
        ("background_jobs", ("payload",), None),
    )
    for table, columns, owner_column in definitions:
        for row in _rows(db, table):
            if table == "background_jobs" and row["kind"] == "note_reindex_job":
                continue
            owner = (
                row.get(owner_column)
                if owner_column
                else message_owners.get(str(row["id"]))
                if table == "messages"
                else message_owners.get(str(row.get("assistant_message_id")))
                if table == "message_retrievals"
                else None
            )
            changes = {}
            context_quote = (
                row.get("captured_evidence", {}).get("quote")
                if isinstance(row.get("captured_evidence"), dict)
                else None
            )
            for column in columns:
                value = row[column]
                if value is None:
                    continue
                record = f"{table} {row['id']}.{column}"
                converted = _convert_json(
                    value, inventory, record, owner=owner, quote=context_quote
                )
                if (
                    table == "tool_calls"
                    and column == "arguments"
                    and row["tool_id"] == "nexus.resource.read"
                    and isinstance(converted, dict)
                ):
                    converted["field"] = (
                        "annotation"
                        if value.get("uri") in inventory["mapping"]
                        else None
                    )
                if (
                    table == "tool_calls"
                    and row["tool_id"] == "nexus.highlight.create"
                    and isinstance(converted, dict)
                ):
                    if column == "arguments" and "note" in converted:
                        if (
                            "annotation" in converted
                            and converted["annotation"] != converted["note"]
                        ):
                            _refuse(
                                record,
                                "historical highlight input has conflicting note and annotation values",
                                "repair the recorded input without changing its literal writing",
                            )
                        converted["annotation"] = converted.pop("note")
                    elif column == "result" and converted.get("type") == "Success":
                        success = converted.get("value")
                        if not isinstance(success, dict):
                            _refuse(
                                record,
                                "historical successful highlight result is not an object",
                            )
                        success.pop("note_uri", None)
                _audit_json(converted, inventory, record)
                if converted != value:
                    changes[column] = converted
            if (
                table == "message_retrievals"
                and row["result_type"] == "note_block"
                and _ref("note_block", row["source_id"]) in inventory["mapping"]
            ):
                target = inventory["mapping"][_ref("note_block", row["source_id"])]
                changes.update(result_type="highlight", source_id=target.split(":")[1])
            if changes:
                updates.append((table, row["id"], changes))
    for row in _rows(db, "suggestion_shortlists", "id,target_refs"):
        refs = [inventory["mapping"].get(ref, ref) for ref in row["target_refs"]]
        if len(set(refs)) != len(refs):
            _refuse(
                f"suggestion shortlist {row['id']}",
                "retargeted shortlist identities collide",
            )
        if refs != row["target_refs"]:
            updates.append(("suggestion_shortlists", row["id"], {"target_refs": refs}))
    inventory["json_updates"] = updates


def _plan_indexes(db, inventory):
    mapping = inventory["mapping"]
    states = _rows(db, "content_index_states")
    by_owner = {(row["owner_kind"], str(row["owner_id"])): row for row in states}
    changed = set()
    for ident, note in inventory["notes"].items():
        ref = _ref("note_block", ident)
        if note["body_text"] != inventory["bodies"][ref]["body_text"]:
            changed.add(mapping.get(ref, ref))
        state = by_owner.get(("note_block", ident))
        if state is None:
            _refuse(
                ref,
                "note has no indexing owner state",
                "repair or explicitly publish its text index before retrying",
            )
        if ref in mapping and ("highlight", mapping[ref].split(":")[1]) in by_owner:
            _refuse(
                f"index state {state['id']}",
                f"annotation owner {mapping[ref]} already has an index state",
            )
    inventory["changed_text"] = changed
    converted_states, new_states = {}, {}
    for row in states:
        old = _ref(row["owner_kind"], row["owner_id"])
        new = mapping.get(old, old)
        if new != old:
            row["owner_kind"], row["owner_id"] = _parts(new)
        if new in changed:
            if row["revision"] >= _MAX_COUNTER:
                _refuse(f"index state {row['id']}", "text revision exhausted")
            row.update(
                revision=row["revision"] + 1,
                status="pending",
                status_reason="highlight_annotations",
                active_embedding_provider=None,
                active_embedding_model=None,
            )
        converted_states[(row["owner_kind"], str(row["owner_id"]))] = row
        new_states[old] = row
    publications = []
    for table, column, literal in (
        ("content_chunks", "summary_locator", "chunk_text"),
        ("evidence_spans", "selector", "span_text"),
    ):
        for row in _rows(db, table):
            old = _ref(row["owner_kind"], row["owner_id"])
            if old in mapping.values():
                _refuse(
                    f"{table} {row['id']}",
                    f"annotation publication owner {old} already exists",
                )
            if old not in mapping:
                continue
            state = new_states.get(old)
            if state is None:
                _refuse(
                    f"{table} {row['id']}", "annotation publication has no index state"
                )
            target = mapping[old]
            if target in inventory["changed_text"]:
                proved = None
            elif state["lexical_revision"] == state["revision"]:
                source = inventory["bodies"][old]["body_text"]
                start, end = (
                    row[column].get("start_offset"),
                    row[column].get("end_offset"),
                )
                if (
                    type(start) is not int
                    or type(end) is not int
                    or not 0 <= start < end <= len(source)
                    or source[start:end] != row[literal]
                ):
                    _refuse(
                        f"{table} {row['id']}",
                        "current annotation publication text/offsets disagree with canonical text",
                    )
                proved = hashlib.sha256(source.encode()).hexdigest()
            else:
                proved = None
            row[column] = _locator(
                row[column],
                inventory,
                f"{table} {row['id']}",
                internal=True,
                proved_hash=proved,
            )
            row["owner_kind"], row["owner_id"] = _parts(target)
            if table == "content_chunks":
                if row["source_kind"] != "note":
                    _refuse(
                        f"chunk {row['id']}", "consumed note has a non-note source kind"
                    )
                row["source_kind"] = "highlight_annotation"
            else:
                if row["resolver_kind"] != "note":
                    _refuse(
                        f"span {row['id']}", "consumed note has a non-note resolver"
                    )
                row["resolver_kind"] = "highlight_annotation"
            publications.append((table, row))
    # Every retryable old job changes contract, including unrelated ordinary notes.
    jobs, enqueue = [], set()
    for row in _rows(
        db,
        "background_jobs",
        where="WHERE kind='note_reindex_job' AND status IN ('pending','failed','running') ORDER BY id",
    ):
        payload = row["payload"]
        if (
            not isinstance(payload, dict)
            or set(payload) != {"note_block_id", "revision", "reason"}
            or not isinstance(payload["reason"], str)
        ):
            _refuse(f"job {row['id']}", "unsupported retryable note indexing payload")
        old = _ref("note_block", payload["note_block_id"])
        target = mapping.get(old, old)
        kind, ident = _parts(target)
        state = converted_states.get((kind, str(ident)))
        revision = payload["revision"]
        if (
            type(revision) is not int
            or revision < 0
            or state is None
            or revision > state["revision"]
        ):
            _refuse(
                f"job {row['id']}",
                "retryable indexing revision lacks a matching owner state",
            )
        converted_payload = {
            "owner_kind": kind,
            "owner_id": str(ident),
            "revision": revision,
            "reason": payload["reason"],
        }
        if row["status"] == "running" or target in changed:
            row.update(
                status="succeeded",
                result={"status": "superseded"},
                execution_id=None,
                claimed_by=None,
                lease_expires_at=None,
            )
            enqueue.add(target)
        else:
            row.update(kind="authored_text_reindex_job", payload=converted_payload)
        jobs.append(row)
    enqueue |= changed
    # Existing retryable work retains its identity. Only interrupted running
    # claims and changed text request new work; terminal/hidden owners stay put.
    waiting = {
        (
            _ref(job["payload"]["owner_kind"], job["payload"]["owner_id"]),
            job["payload"]["revision"],
        )
        for job in jobs
        if job["status"] in {"pending", "failed"}
        and job["kind"] == "authored_text_reindex_job"
    }
    indexable = {
        row["ref"]
        for row in inventory["resources"]
        if row["ref"] not in mapping
        and row["state"]["kind"] in {"note", "highlight"}
        and row["visible"]
        and (
            row["state"]["kind"] == "note"
            or inventory["bodies"][row["ref"]]["has_content"]
        )
    }
    enqueue &= indexable
    inventory["index_states"] = states
    inventory["publications"] = publications
    inventory["jobs"] = jobs
    inventory["enqueue"] = [
        (ref, converted_states[(ref.split(":")[0], ref.split(":")[1])]["revision"])
        for ref in sorted(enqueue)
        if (ref, converted_states[(ref.split(":")[0], ref.split(":")[1])]["revision"])
        not in waiting
    ]


def _write_json_updates(db, inventory):
    json_columns = {
        "state",
        "reader_selection_snapshot",
        "branch_anchor",
        "arguments",
        "result",
        "context_ref",
        "result_ref",
        "captured_evidence",
        "locator",
        "payload",
        "generation_spec",
        "terminal",
        "target_refs",
    }
    for table, ident, changes in inventory["json_updates"]:
        assignments = [
            f"{column}=CAST(:{column} AS jsonb)"
            if column in json_columns
            else f"{column}=:{column}"
            for column in changes
        ]
        params = {
            column: _json(value) if column in json_columns else value
            for column, value in changes.items()
        }
        db.execute(
            sa.text(f"UPDATE {table} SET {','.join(assignments)} WHERE id=:id"),
            dict(params, id=ident),
        )
    for ident, receipts in inventory["receipts"]:
        db.execute(
            sa.text(
                "UPDATE tool_calls SET created_refs=CAST(:refs AS jsonb) WHERE id=:id"
            ),
            {"id": ident, "refs": _json(receipts)},
        )


def _write_canonical(db, inventory):
    mapping = inventory["mapping"]
    for account, maximum in inventory["maxima"].items():
        db.execute(
            sa.text(
                "INSERT INTO authored_replicas(account_id,replica_id,accepted_seq,format_revision) VALUES (:a,:r,0,3)"
            ),
            {"a": UUID(account), "r": uuid5(UUID(account), "authored:server:3")},
        )
        db.execute(
            sa.text(
                "UPDATE authored_heads SET lamport=:l,snapshot_floor_seq=head_seq WHERE account_id=:a"
            ),
            {"a": UUID(account), "l": maximum + 1},
        )
    for row in inventory["resources"]:
        if row["ref"] in mapping:
            continue
        kind = row["state"]["kind"]
        if kind not in {"note", "highlight"}:
            continue
        body = inventory["bodies"][row["ref"]]
        db.execute(
            sa.text(
                "UPDATE authored_resources SET merge_bytes=:body WHERE account_id=:a AND ref=:ref"
            ),
            {
                "a": row["account_id"],
                "ref": row["ref"],
                "body": base64.urlsafe_b64decode(
                    body["body_state"] + "=" * (-len(body["body_state"]) % 4)
                ),
            },
        )
        if kind == "highlight":
            db.execute(
                sa.text(
                    "UPDATE highlights SET annotation_body_pm_json=CAST(:body AS jsonb),annotation_body_text=:text WHERE id=:id"
                ),
                {
                    "id": _parts(row["ref"])[1],
                    "body": _json(body["body_pm_json"])
                    if body["has_content"]
                    else None,
                    "text": body["body_text"] if body["has_content"] else None,
                },
            )
        else:
            db.execute(
                sa.text(
                    "UPDATE note_blocks SET body_pm_json=CAST(:body AS jsonb),body_text=:text WHERE id=:id"
                ),
                {
                    "id": _parts(row["ref"])[1],
                    "body": _json(body["body_pm_json"]),
                    "text": body["body_text"],
                },
            )
    # Delete bindings first so retargeted pairs can never hit a transient key collision.
    for row in inventory["links"]:
        db.execute(
            sa.text("DELETE FROM authored_links WHERE account_id=:a AND link_id=:id"),
            {"a": row["account_id"], "id": row["link_id"]},
        )
    for row in inventory["converted_links"]:
        db.execute(
            sa.text(
                "INSERT INTO authored_links(account_id,link_id,state) VALUES (:a,:id,CAST(:s AS jsonb))"
            ),
            {"a": row["account_id"], "id": row["link_id"], "s": _json(row["state"])},
        )
    for row in inventory["passages"]:
        db.execute(
            sa.text(
                "UPDATE authored_passages SET state=CAST(:s AS jsonb) WHERE account_id=:a AND anchor_id=:id"
            ),
            {"a": row["account_id"], "id": row["anchor_id"], "s": _json(row["state"])},
        )
    stubs, keys = [], set()
    for row in inventory["stubs"]:
        state = _convert_json(
            row["state"],
            inventory,
            f"source stub {row['source_ref']}",
            owner=row["account_id"],
        )
        source = mapping.get(row["source_ref"], row["source_ref"])
        key = (row["account_id"], source)
        if key in keys:
            _refuse(
                f"source stub {source}", "retargeting collides with another source stub"
            )
        keys.add(key)
        state["source_ref"] = source
        stubs.append(dict(row, state=state, source_ref=source))
    db.execute(sa.text("DELETE FROM authored_source_stubs"))
    for row in stubs:
        db.execute(
            sa.text(
                "INSERT INTO authored_source_stubs(account_id,source_ref,state) VALUES (:a,:ref,CAST(:s AS jsonb))"
            ),
            {
                "a": row["account_id"],
                "ref": row["source_ref"],
                "s": _json(row["state"]),
            },
        )


def _write_relational(db, inventory):
    for identity in inventory["removed_links"]:
        db.execute(
            sa.text("DELETE FROM resource_view_states WHERE edge_id=:id"),
            {"id": UUID(identity)},
        )
        db.execute(
            sa.text("DELETE FROM resource_edges WHERE id=:id"), {"id": UUID(identity)}
        )
    for row in inventory["edges"]:
        db.execute(
            sa.text(
                "UPDATE resource_edges SET source_scheme=:source_scheme,source_id=:source_id,target_scheme=:target_scheme,target_id=:target_id,origin=:origin,authored_visible=:authored_visible,snapshot=CAST(:snapshot AS jsonb) WHERE id=:id"
            ),
            dict(
                row,
                snapshot=_json(row["snapshot"])
                if row["snapshot"] is not None
                else None,
            ),
        )
    for row in inventory["views"]:
        db.execute(
            sa.text(
                "UPDATE resource_view_states SET surface_scheme=:surface_scheme,surface_id=:surface_id,target_scheme=:target_scheme,target_id=:target_id,order_key=:order_key WHERE id=:id"
            ),
            row,
        )
    for row in inventory["versions"]:
        db.execute(
            sa.text(
                "UPDATE resource_versions SET resource_scheme=:resource_scheme,resource_id=:resource_id WHERE id=:id"
            ),
            row,
        )
    for row in inventory["anchors"]:
        db.execute(
            sa.text(
                "UPDATE passage_anchors SET owner_scheme=:owner_scheme,owner_id=:owner_id,selector=CAST(:selector AS jsonb) WHERE id=:id"
            ),
            dict(row, selector=_json(row["selector"])),
        )
    for row in inventory["index_states"]:
        db.execute(
            sa.text(
                "UPDATE content_index_states SET owner_kind=:owner_kind,owner_id=:owner_id,revision=:revision,status=:status,status_reason=:status_reason,active_embedding_provider=:active_embedding_provider,active_embedding_model=:active_embedding_model WHERE id=:id"
            ),
            row,
        )
    for table, row in inventory["publications"]:
        column, kind = (
            ("summary_locator", "source_kind")
            if table == "content_chunks"
            else ("selector", "resolver_kind")
        )
        db.execute(
            sa.text(
                f"UPDATE {table} SET owner_kind=:owner_kind,owner_id=:owner_id,{kind}=:{kind},{column}=CAST(:{column} AS jsonb) WHERE id=:id"
            ),
            dict(row, **{column: _json(row[column])}),
        )
    for row in inventory["jobs"]:
        if row["status"] == "succeeded":
            db.execute(
                sa.text(
                    "UPDATE background_jobs SET status='succeeded',result=CAST(:result AS jsonb),finished_at=now(),updated_at=now(),execution_id=NULL,claimed_by=NULL,lease_expires_at=NULL WHERE id=:id"
                ),
                {"id": row["id"], "result": _json(row["result"])},
            )
            db.execute(
                sa.text(
                    "UPDATE background_job_capacity_leases SET job_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE job_id=:id"
                ),
                {"id": row["id"]},
            )
        else:
            db.execute(
                sa.text(
                    "UPDATE background_jobs SET kind=:kind,payload=CAST(:payload AS jsonb),updated_at=now() WHERE id=:id"
                ),
                {
                    "id": row["id"],
                    "kind": row["kind"],
                    "payload": _json(row["payload"]),
                },
            )
    for ref, version in inventory["enqueue"]:
        kind, ident = _parts(ref)
        db.execute(
            sa.text(
                "INSERT INTO background_jobs(kind,payload,max_attempts) VALUES ('authored_text_reindex_job',CAST(:payload AS jsonb),3)"
            ),
            {
                "payload": _json(
                    {
                        "owner_kind": kind,
                        "owner_id": str(ident),
                        "revision": version,
                        "reason": "highlight_annotations",
                    }
                )
            },
        )
    if inventory["enqueue"] or inventory["jobs"]:
        db.execute(
            sa.text(
                "SELECT pg_notify('nexus_background_jobs','authored_text_reindex_job')"
            )
        )
    for note, highlight in inventory["mapping"].items():
        account = inventory["notes"][note.split(":")[1]]["user_id"]
        db.execute(
            sa.text("DELETE FROM authored_resources WHERE account_id=:a AND ref=:ref"),
            {"a": account, "ref": note},
        )
        db.execute(
            sa.text("DELETE FROM note_blocks WHERE id=:id"), {"id": _parts(note)[1]}
        )
        # This is a derived invalidation clock, not an authorship identity.
        db.execute(
            sa.text("DELETE FROM suggestion_inputs WHERE id=:ref"), {"ref": note}
        )
        db.execute(
            sa.text(
                "INSERT INTO suggestion_inputs(id,revision) VALUES (:ref,1) ON CONFLICT(id) DO UPDATE SET revision=suggestion_inputs.revision+1"
            ),
            {"ref": highlight},
        )


def _rebuild_derived(db, inventory):
    # Retain surviving embed-fact ids; regenerate only missing/stale derived facts.
    existing = {
        (
            str(row["user_id"]),
            _ref(row["source_scheme"], row["source_id"]),
            _ref(row["target_scheme"], row["target_id"]),
        ): row
        for row in inventory["edges"]
        if row["origin"] == "note_body"
    }
    wanted = {}
    embeddable = {
        "media",
        "library",
        "highlight",
        "page",
        "note_block",
        "fragment",
        "conversation",
        "message",
        "oracle_reading",
        "contributor",
        "podcast",
        "passage_anchor",
    }
    for row in inventory["resources"]:
        source = row["ref"]
        if source in inventory["mapping"] or row["state"]["kind"] not in {
            "note",
            "highlight",
        }:
            continue
        body = inventory["bodies"][source]
        account = str(row["account_id"])
        for target in body["embedded_refs"]:
            if target != source and target.split(":")[0] in embeddable:
                wanted[(account, source, target)] = row["account_id"]
    for key, edge in existing.items():
        if key not in wanted:
            db.execute(
                sa.text("DELETE FROM resource_view_states WHERE edge_id=:id"),
                {"id": edge["id"]},
            )
            db.execute(
                sa.text("DELETE FROM resource_edges WHERE id=:id"), {"id": edge["id"]}
            )
    for key, account in wanted.items():
        if key in existing:
            continue
        _, source, target = key
        ss, si = _parts(source)
        ts, ti = _parts(target)
        ident = uuid5(account, f"0325:body-embed:{source}:{target}")
        if db.scalar(
            sa.text("SELECT EXISTS(SELECT 1 FROM resource_edges WHERE id=:id)"),
            {"id": ident},
        ):
            _refuse(f"derived embed {ident}", "deterministic fact id collision")
        db.execute(
            sa.text(
                "INSERT INTO resource_edges(id,user_id,kind,origin,source_scheme,source_id,target_scheme,target_id) VALUES (:id,:a,'context','note_body',:ss,:si,:ts,:ti)"
            ),
            {"id": ident, "a": account, "ss": ss, "si": si, "ts": ts, "ti": ti},
        )
    # Quote rows remain source-only. Annotation words have their own private family.
    db.execute(
        sa.text("""UPDATE keyword_occurrences k SET body=h.exact,prefix=h.prefix,suffix=h.suffix
        FROM highlights h WHERE k.family='highlight' AND k.ref='highlight:'||h.id::text""")
    )
    db.execute(
        sa.text(
            "DELETE FROM keyword_occurrences WHERE family IN ('note_block','highlight_annotation')"
        )
    )
    db.execute(
        sa.text("""INSERT INTO keyword_occurrences
        (doc_key,ref,owner_ref,family,admission_key,source_revision,body)
        SELECT 'note_block:'||id::text,'note_block:'||id::text,'note_block:'||id::text,
        'note_block','note_block:'||id::text||':'||encode(digest(convert_to(body_text,'UTF8'),'sha256'),'hex'),
        NULL,body_text FROM note_blocks WHERE authored_visible AND body_text<>''""")
    )
    db.execute(
        sa.text("""INSERT INTO keyword_occurrences
        (doc_key,ref,owner_ref,family,admission_key,source_revision,body)
        SELECT 'highlight:annotation:'||id::text,'highlight:'||id::text,'highlight:'||id::text,
        'highlight_annotation','highlight:annotation:'||id::text||':'||encode(digest(convert_to(annotation_body_text,'UTF8'),'sha256'),'hex'),
        NULL,annotation_body_text FROM highlights
        WHERE authored_visible AND annotation_body_pm_json IS NOT NULL AND annotation_body_text<>''""")
    )


def _validate(db, inventory):
    legacy = list(
        db.scalars(
            sa.text(
                "SELECT id FROM resource_edges WHERE origin='highlight_note' ORDER BY id"
            )
        )
    )
    if legacy:
        _refuse(
            f"edges {','.join(str(ident) for ident in legacy)}",
            "unsupported highlight_note origins survived conversion",
            "repair their canonical bindings before retrying",
        )
    for note in inventory["mapping"]:
        ident = _parts(note)[1]
        for table, condition in (
            ("authored_resources", "ref=:ref"),
            (
                "authored_links",
                "state->>'endpoint_a'=:ref OR state->>'endpoint_b'=:ref",
            ),
            ("authored_passages", "state->>'source_ref'=:ref"),
            ("authored_source_stubs", "source_ref=:ref"),
            ("note_blocks", "id=:id"),
            (
                "resource_edges",
                "(source_scheme='note_block' AND source_id=:id) OR (target_scheme='note_block' AND target_id=:id)",
            ),
            (
                "resource_view_states",
                "(surface_scheme='note_block' AND surface_id=:id) OR (target_scheme='note_block' AND target_id=:id)",
            ),
            ("resource_versions", "resource_scheme='note_block' AND resource_id=:id"),
            ("passage_anchors", "owner_scheme='note_block' AND owner_id=:id"),
            ("content_index_states", "owner_kind='note_block' AND owner_id=:id"),
            ("content_chunks", "owner_kind='note_block' AND owner_id=:id"),
            ("evidence_spans", "owner_kind='note_block' AND owner_id=:id"),
            ("keyword_occurrences", "ref=:ref OR owner_ref=:ref"),
        ):
            if db.scalar(
                sa.text(f"SELECT EXISTS(SELECT 1 FROM {table} WHERE {condition})"),
                {"id": ident, "ref": note},
            ):
                _refuse(
                    f"{table} {note}",
                    "post-conversion live target still addresses a consumed note",
                )
    if db.scalar(
        sa.text(
            "SELECT EXISTS(SELECT 1 FROM authored_resources WHERE state->>'kind' IN ('note','highlight') AND merge_bytes IS NULL)"
        )
    ):
        _refuse("authored_resources", "converted authored body is missing merge bytes")
    if db.scalar(
        sa.text(
            "SELECT EXISTS(SELECT 1 FROM background_jobs WHERE kind='note_reindex_job' AND status IN ('pending','failed','running'))"
        )
    ):
        _refuse(
            "background_jobs", "retryable old indexing contract survived conversion"
        )
    for row in inventory["resources"]:
        if row["ref"] in inventory["mapping"] or row["state"]["kind"] not in {
            "note",
            "highlight",
        }:
            continue
        body = inventory["bodies"][row["ref"]]
        for node in body["body_pm_json"].get("content", []):
            if node["type"] != "resource_embed":
                continue
            attrs = node["attrs"]
            if "field" not in attrs:
                _refuse(row["ref"], "embed field normalization was incomplete")
            if attrs["field"] == "annotation":
                target = inventory["highlights"].get(
                    attrs["resource_ref"].split(":")[1]
                )
                if target is None or target["user_id"] != row["account_id"]:
                    _refuse(
                        row["ref"],
                        f"cross-owner annotation embed {attrs['resource_ref']}",
                    )
    # Feed and replica records are never updated; only the new replica is inserted.
    for account, head in inventory["heads"].items():
        actual = db.execute(
            sa.text(
                "SELECT head_seq,snapshot_floor_seq,lamport FROM authored_heads WHERE account_id=:a"
            ),
            {"a": UUID(account)},
        ).one()
        if (
            actual.head_seq != head["head_seq"]
            or actual.snapshot_floor_seq != head["head_seq"]
            or actual.lamport != inventory["maxima"][account] + 1
        ):
            _refuse(
                f"account {account}",
                "snapshot causal boundary disagrees with converted state",
            )


def upgrade() -> None:
    db = op.get_bind()
    # Alembic's transactional DDL owns the complete cut. Any refusal rolls it back.
    inventory = _inventory(db)
    _convert_bodies(inventory)
    _retarget_links(inventory)
    _passages(inventory)
    _receipts(db, inventory)
    _plan_relational(db, inventory)
    _plan_indexes(db, inventory)
    _plan_json(db, inventory)
    op.add_column(
        "highlights", sa.Column("annotation_body_pm_json", JSONB(), nullable=True)
    )
    op.add_column(
        "highlights", sa.Column("annotation_body_text", sa.Text(), nullable=True)
    )
    op.create_check_constraint(
        "ck_highlights_annotation_body_pair",
        "highlights",
        "(annotation_body_pm_json IS NULL) = (annotation_body_text IS NULL)",
    )
    for table, constraint in (
        ("content_chunks", "ck_content_chunks_source_kind"),
        ("evidence_spans", "ck_evidence_spans_resolver"),
        ("resource_edges", "ck_resource_edges_note_body_shape"),
    ):
        op.drop_constraint(constraint, table, type_="check")
    op.execute(
        "ALTER TABLE authored_replicas ALTER COLUMN format_revision SET DEFAULT 3"
    )
    _write_canonical(db, inventory)
    _write_json_updates(db, inventory)
    _write_relational(db, inventory)
    _rebuild_derived(db, inventory)
    _validate(db, inventory)


def downgrade() -> None:
    raise NotImplementedError(
        "0326 is irreversible; restore the verified backup and matching clients"
    )
