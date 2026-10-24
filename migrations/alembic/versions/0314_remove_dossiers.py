"""remove dossiers and their live references, preserving surrounding authored work.

revision: 0314; parent: 0313. data effects: interrupt open dossier generations;
strip retired note links/embeds, saved scopes, evidence facts and navigation;
retire deleted authored links; invalidate changed note indexes; drop dossier
storage. closed generation/tool audit and usage, message prose, surviving citation
ordinals and unrelated resources stay intact. preflight precedes every mutation.
writers must be stopped; rollback requires the verified matching backup and build.
"""

import json
import math
import re
from collections.abc import Sequence
from copy import deepcopy
from typing import Any
from urllib.parse import unquote, urlsplit
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op

revision: str = "0314"
down_revision: str | Sequence[str] | None = "0313"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_RETIRED = {"artifact", "artifact_revision"}
_SCHEMES = {
    "media",
    "library",
    "evidence_span",
    "content_chunk",
    "highlight",
    "page",
    "note_block",
    "fragment",
    "conversation",
    "message",
    "oracle_reading",
    "oracle_passage_anchor",
    "external_snapshot",
    "contributor",
    "podcast",
    "reader_apparatus_item",
    "passage_anchor",
}
_OPERATIONS = {
    "dossier_page",
    "dossier_note",
    "dossier_media",
    "dossier_conversation",
    "dossier_library",
    "dossier_podcast",
    "dossier_contributor",
    "dossier_idea",
}
_SURFACES = {
    "resource-contents": "resource-inspector",
    "resource-members": "resource-inspector",
    "resource-connections": "resource-inspector",
    "resource-forks": "resource-inspector",
    "resource-dossier": "resource-inspector",
    "import-detail": "imports-inspector",
}


def _require(condition: bool, detail: str) -> None:
    if not condition:
        raise RuntimeError(f"0314 preflight: {detail}")


def _uuid(value: object) -> bool:
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except ValueError:
        return False


def _ref(value: object) -> bool:
    """Validate an owned nullable resource-ref field; return whether it is retired."""
    if value is None:
        return False
    _require(isinstance(value, str), "resource ref is not text")
    scheme, separator, ident = value.partition(":")
    _require(
        bool(separator) and scheme in _SCHEMES | _RETIRED and _uuid(ident),
        "invalid resource ref",
    )
    return scheme in _RETIRED


def _href(value: object) -> bool:
    """Only the retired route namespace, including its encoded resource segment."""
    _require(isinstance(value, str), "href is not text")
    parts = urlsplit(value)
    if parts.scheme or parts.netloc:
        return False
    path = unquote(parts.path)
    if not path.startswith("/artifacts/"):
        return False
    tail = path.removeprefix("/artifacts/")
    _require("/" not in tail and _ref(tail), "unknown artifact route")
    return True


def _safe_href(href: object) -> bool:
    if not isinstance(href, str) or not href:
        return False
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 or c == "\\" for c in href):
        return False
    if href.startswith("/"):
        return not href.startswith("//")
    try:
        parts = urlsplit(href)
        if parts.scheme in ("http", "https"):
            _ = parts.port
            return "%" not in parts.netloc and bool(parts.hostname)
        return parts.scheme == "mailto" and bool(parts.path) and not parts.netloc
    except ValueError:
        return False


def _body(node: Any, allowed: set[str] | None = None, code_marks: bool = True) -> Any:
    """Frozen single-block grammar and transformation from schemas/note_bodies.py."""
    allowed = (
        {"paragraph", "code_block", "object_embed"} if allowed is None else allowed
    )
    _require(
        isinstance(node, dict) and node.get("type") in allowed, "unknown note node"
    )
    _require(
        not set(node) - {"type", "attrs", "content", "marks", "text"},
        "unknown note fields",
    )
    kind = node["type"]
    attrs = node.get("attrs")
    _require(attrs is None or isinstance(attrs, dict), "invalid note attrs")
    attrs = attrs or {}
    marks = node.get("marks", [])
    _require(isinstance(marks, list), "invalid note marks")
    changed = deepcopy(node)
    kept = []
    for mark in marks:
        _require(
            isinstance(mark, dict)
            and mark.get("type")
            in {"strong", "em", "code", "link", "strikethrough", "underline"}
            and not set(mark) - {"type", "attrs"},
            "unknown note mark",
        )
        mark_attrs = mark.get("attrs")
        _require(
            mark_attrs is None or isinstance(mark_attrs, dict), "invalid mark attrs"
        )
        if mark["type"] == "link":
            mark_attrs = mark_attrs or {}
            _require(
                _safe_href(mark_attrs.get("href"))
                and (
                    mark_attrs.get("title") is None
                    or isinstance(mark_attrs["title"], str)
                ),
                "invalid note link",
            )
            if _href(mark_attrs["href"]):
                continue
        kept.append(mark)
    if kept != marks:
        if kept:
            changed["marks"] = kept
        else:
            changed.pop("marks", None)
    if kind == "object_embed":
        _require(
            attrs.get("objectType") in _SCHEMES | _RETIRED
            and isinstance(attrs.get("objectId"), str),
            "unknown note embed",
        )
        try:
            UUID(attrs["objectId"])
        except ValueError:
            _require(False, "invalid note embed id")
        _require(
            all(
                attrs.get(key) is None or isinstance(attrs[key], str)
                for key in ("label", "displayMode")
            )
            and attrs.get("relationType") in (None, "embeds"),
            "invalid note embed attrs",
        )
    if kind == "image":
        _require(
            isinstance(attrs.get("src"), str)
            and all(
                attrs.get(key) is None or isinstance(attrs[key], str)
                for key in ("alt", "title")
            ),
            "invalid note image",
        )
    if kind == "text":
        _require(
            isinstance(node.get("text"), str)
            and bool(node["text"])
            and "content" not in node
            and (not marks or code_marks),
            "invalid note text",
        )
        return changed
    _require("text" not in node, "text outside a text node")
    if node.get("content") is not None:
        children = {
            "paragraph": {"text", "hard_break", "image"},
            "code_block": {"text"},
        }
        _require(
            kind in children and isinstance(node["content"], list),
            "invalid note children",
        )
        changed["content"] = [
            _body(child, children[kind], kind != "code_block")
            for child in node["content"]
        ]
    if kind == "object_embed" and attrs["objectType"] in _RETIRED:
        label = attrs.get("label")
        return (
            {"type": "paragraph", "content": [{"type": "text", "text": label}]}
            if label
            else {"type": "paragraph"}
        )
    return changed


def _body_text(value: dict[str, Any]) -> str:
    """Frozen services/note_bodies.text_from_pm_json, including whitespace rules."""
    parts: list[str] = []

    def visit(node: Any) -> None:
        if isinstance(node, list):
            for child in node:
                visit(child)
        elif isinstance(node, dict):
            kind, attrs = node.get("type"), node.get("attrs")
            if kind == "text":
                parts.append(node["text"])
            elif kind == "object_embed" and isinstance(attrs, dict):
                parts.append(
                    attrs.get("label")
                    or f"{attrs.get('objectType')}:{attrs.get('objectId')}"
                )
            elif (
                kind == "image"
                and isinstance(attrs, dict)
                and isinstance(attrs.get("alt"), str)
            ):
                parts.append(attrs["alt"])
            elif kind == "hard_break":
                parts.append("\n")
            visit(node.get("content"))
            if kind in ("paragraph", "code_block"):
                parts.append("\n")

    visit(value)
    return "\n".join(line.rstrip() for line in "".join(parts).splitlines()).strip()


def _retired_ref(value: Any) -> bool:
    # Recognition is scoped to the typed field; unrelated malformed values are not ours.
    if not isinstance(value, str) or value.partition(":")[0] not in _RETIRED:
        return False
    return _ref(value)


def _body_affected(node: Any) -> bool:
    if not isinstance(node, dict):
        return False
    attrs = node.get("attrs")
    if (
        node.get("type") == "object_embed"
        and isinstance(attrs, dict)
        and attrs.get("objectType") in _RETIRED
    ):
        return True
    marks = node.get("marks")
    if isinstance(marks, list):
        for mark in marks:
            if (
                isinstance(mark, dict)
                and mark.get("type") == "link"
                and isinstance(mark.get("attrs"), dict)
            ):
                href = mark["attrs"].get("href")
                if isinstance(href, str) and _href(href):
                    return True
    children = node.get("content")
    return isinstance(children, list) and any(
        _body_affected(child) for child in children
    )


def _evidence(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    source, target = value.get("source"), value.get("target")
    retired = any(
        (
            _retired_ref(source.get("ref")) if isinstance(source, dict) else False,
            _retired_ref(target.get("owner_ref"))
            if isinstance(target, dict)
            else False,
        )
    )
    if retired:
        _require(
            set(value) == {"quote", "source", "target"}
            and isinstance(source, dict)
            and isinstance(target, dict),
            "unknown affected evidence shape",
        )
        _require(
            set(source)
            == {"ref", "title", "media_kind", "contributors", "location_label"},
            "unknown affected evidence source",
        )
        _ref(source["ref"])
        kind = target.get("kind")
        fields = {
            "resource": {"kind", "owner_ref"},
            "unavailable": {"kind", "owner_ref"},
            "passage": {"kind", "owner_ref", "locator", "precision", "source_identity"},
        }
        _require(
            kind in fields and set(target) == fields[kind],
            "unknown affected evidence target",
        )
        _ref(target["owner_ref"])
    return retired


def _snapshot(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    retired = _evidence(value.get("evidence"))
    if retired:
        _require(
            not set(value) - {"evidence", "rationale"},
            "unknown affected snapshot fields",
        )
    return retired


def _context(value: Any) -> bool:
    if not isinstance(value, dict) or value.get("type") not in _RETIRED:
        return False
    _require(
        set(value) <= {"type", "id", "evidence_span_ids"} and _uuid(value.get("id")),
        "unknown retired retrieval context",
    )
    return True


def _retrieval(row: Any) -> bool:
    result = row.result_ref
    if not isinstance(result, dict):
        return False
    retired = [
        row.result_type in _RETIRED,
        result.get("type") in _RETIRED,
        result.get("result_type") in _RETIRED,
        _context(row.context_ref),
        _context(result.get("context_ref")),
        _evidence(row.captured_evidence),
    ]
    for key in (
        "citation_target",
        "subject_ref",
        "resource_ref",
        "owner_resource_ref",
        "action_ref",
        "result_ref",
    ):
        retired.append(_retired_ref(result.get(key)))
    retired.append(
        _href(result["deep_link"])
        if isinstance(result.get("deep_link"), str)
        else False
    )
    if any(retired):
        fields = {
            "type",
            "id",
            "result_type",
            "source_id",
            "title",
            "source_label",
            "snippet",
            "deep_link",
            "citation_target",
            "context_ref",
            "locator",
            "media_id",
            "media_kind",
            "score",
            "selected",
            "source_kind",
            "evidence_span_ids",
            "contributor_handle",
            "body_text",
            "highlight_excerpt",
            "color",
            "exact",
            "conversation_id",
            "seq",
            "apparatus_kind",
            "revision_id",
            "subject_ref",
            "citation_label",
            "evidence_span_id",
            "contributors",
            "result_ref",
            "url",
            "display_url",
            "extra_snippets",
            "published_at",
            "source_name",
            "rank",
            "provider",
            "provider_request_id",
            "resource_ref",
            "owner_resource_ref",
            "action_ref",
        }
        _require(
            not set(result) - fields and isinstance(row.context_ref, dict),
            "unknown affected retrieval",
        )
    return any(retired)


def _layout_affected(state: Any) -> bool:
    if not isinstance(state, dict) or not isinstance(state.get("panes"), list):
        return False
    for pane in state["panes"]:
        if not isinstance(pane, dict):
            continue
        secondary = pane.get("secondary")
        if (
            isinstance(secondary, dict)
            and secondary.get("active_surface_id") == "resource-dossier"
        ):
            return True
        visits = [pane.get("current_visit")]
        history = pane.get("history")
        if isinstance(history, dict):
            for direction in ("back", "forward"):
                if isinstance(history.get(direction), list):
                    visits.extend(history[direction])
        for visit in visits:
            if (
                isinstance(visit, dict)
                and isinstance(visit.get("href"), str)
                and _href(visit["href"])
            ):
                return True
    return False


def _scope(spec: Any) -> list[str]:
    # Historical chats are still decoded whole by chat.reads.spec, not just for scope membership.
    fields = {
        "operation",
        "selection",
        "display_at_dispatch",
        "tool_plan",
        "tool_scope",
        "effect_mode",
        "context_budget_tokens",
        "output_budget_tokens",
    }
    _require(
        isinstance(spec, dict)
        and set(spec) == fields
        and isinstance(spec["tool_scope"], list),
        "unknown affected generation spec",
    )
    _require(
        spec["operation"]
        in _OPERATIONS
        | {
            "chat",
            "metadata_enrichment",
            "media_title",
            "media_summary",
            "connection_discovery",
            "oracle",
        }
        and (spec["tool_plan"] is None or isinstance(spec["tool_plan"], str))
        and spec["effect_mode"] in {None, "ReadOnly", "AdditiveWrites"}
        and all(
            spec[key] is None
            or (isinstance(spec[key], int) and not isinstance(spec[key], bool))
            for key in ("context_budget_tokens", "output_budget_tokens")
        ),
        "unknown affected generation policy",
    )
    selection = spec["selection"]
    _require(isinstance(selection, dict), "unknown affected generation selection")
    route = selection.get("route")
    model = "model" if route == "CodexPersonal" else "model_ref"
    _require(
        route in {"CodexPersonal", "ProviderApi"}
        and set(selection) == {"route", model, "reasoning"}
        and isinstance(selection[model], str)
        and 1 <= len(selection[model]) <= 256
        and re.fullmatch(r"[^\s]+", selection[model]) is not None
        and isinstance(selection["reasoning"], str)
        and re.fullmatch(r"[!-~]{1,64}", selection["reasoning"]) is not None,
        "invalid affected generation selection",
    )
    presentation = spec["display_at_dispatch"]
    if presentation is not None:
        _require(
            isinstance(presentation, dict)
            and set(presentation)
            == {
                "route_label",
                "model_label",
                "reasoning_label",
                "billing",
                "privacy",
                "processor_chain",
            },
            "unknown affected generation presentation",
        )
        for key, maximum in (
            ("route_label", 128),
            ("model_label", 256),
            ("reasoning_label", 128),
        ):
            _require(
                isinstance(presentation[key], str)
                and 1 <= len(presentation[key]) <= maximum,
                "invalid affected generation label",
            )
        _require(
            presentation["billing"]
            in (
                {"kind": "Subscription", "label": "Codex subscription"},
                {"kind": "MeteredApi", "label": "Metered API"},
            ),
            "unknown affected generation billing",
        )
        privacy, chain = presentation["privacy"], presentation["processor_chain"]
        _require(
            isinstance(privacy, dict)
            and set(privacy) == {"summary", "retention", "training"}
            and all(
                isinstance(value, str) and 1 <= len(value) <= 1000
                for value in privacy.values()
            ),
            "unknown affected generation privacy",
        )
        _require(
            isinstance(chain, dict)
            and set(chain) == {"processors"}
            and isinstance(chain["processors"], list)
            and 1 <= len(chain["processors"]) <= 4
            and all(isinstance(value, str) for value in chain["processors"]),
            "unknown affected processor chain",
        )
    for value in spec["tool_scope"]:
        _require(isinstance(value, str), "saved generation scope member is not text")
        _ref(value)
    return spec["tool_scope"]


def _layout(state: Any) -> dict[str, Any]:
    """Frozen workspace shape; discard only retired visits and inspector selection."""
    _require(
        isinstance(state, dict) and set(state) == {"active_primary_pane_id", "panes"},
        "unknown workspace state",
    )
    panes = state["panes"]
    _require(isinstance(panes, list) and bool(panes), "empty workspace panes")
    visits: set[str] = set()
    ids: set[str] = set()
    history_count = 0

    def visit(value: Any) -> bool:
        _require(
            isinstance(value, dict) and set(value) == {"id", "href", "title_hint"},
            "unknown workspace visit",
        )
        _require(
            _uuid(value["id"]) and value["id"] not in visits,
            "invalid workspace visit id",
        )
        visits.add(value["id"])
        href, hint = value["href"], value["title_hint"]
        _require(
            isinstance(href, str)
            and len(href) <= 4096
            and re.fullmatch(r"/(?!/)[!-~]*", href) is not None
            and re.search(
                r"\\|(?:^|/)(?:\.|%2e){1,2}(?:/|$)",
                re.split(r"[?#]", href, maxsplit=1)[0],
                re.I,
            )
            is None,
            "invalid workspace href",
        )
        _require(
            hint is None
            or (
                isinstance(hint, str)
                and 1 <= len(hint) <= 512
                and re.sub(
                    "[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+",
                    " ",
                    hint,
                ).strip(" ")
                == hint
            ),
            "invalid workspace title hint",
        )
        return _href(href)

    def width(value: Any, nullable: bool = False) -> None:
        _require(
            (nullable and value is None)
            or (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
                and value > 0
            ),
            "invalid workspace width",
        )

    surviving: list[tuple[int, dict[str, Any]]] = []
    active_index = None
    for index, pane in enumerate(panes):
        _require(
            isinstance(pane, dict)
            and set(pane)
            == {
                "id",
                "current_visit",
                "primary_width_px",
                "visibility",
                "history",
                "secondary",
            },
            "unknown workspace pane",
        )
        ident = pane["id"]
        _require(
            isinstance(ident, str) and 1 <= len(ident) <= 64 and ident not in ids,
            "invalid workspace pane id",
        )
        ids.add(ident)
        if ident == state["active_primary_pane_id"]:
            active_index = index
            _require(pane["visibility"] == "visible", "active pane is hidden")
        _require(
            pane["visibility"] in {"visible", "minimized"}, "invalid pane visibility"
        )
        width(pane["primary_width_px"], nullable=True)
        retired = visit(pane["current_visit"])
        history = pane["history"]
        _require(
            isinstance(history, dict)
            and set(history) == {"back", "forward"}
            and all(isinstance(history[key], list) for key in ("back", "forward")),
            "unknown pane history",
        )
        count = len(history["back"]) + len(history["forward"])
        _require(count <= 12, "oversized pane history")
        history_count += count
        changed = deepcopy(pane)
        for key in ("back", "forward"):
            changed["history"][key] = [item for item in history[key] if not visit(item)]
        secondary = changed["secondary"]
        if secondary is not None:
            _require(
                isinstance(secondary, dict)
                and set(secondary)
                == {"id", "group_id", "active_surface_id", "width_px", "visibility"},
                "unknown workspace secondary",
            )
            _require(
                isinstance(secondary["id"], str)
                and 1 <= len(secondary["id"]) <= 64
                and secondary["active_surface_id"] in _SURFACES
                and secondary["group_id"] == _SURFACES[secondary["active_surface_id"]]
                and secondary["visibility"] in {"visible", "collapsed"},
                "invalid secondary",
            )
            width(secondary["width_px"])
            if secondary["active_surface_id"] == "resource-dossier":
                secondary["active_surface_id"] = "resource-connections"
        if not retired:
            surviving.append((index, changed))
    _require(
        active_index is not None and history_count <= 48, "invalid active pane/history"
    )
    if not surviving:
        ident = str(uuid4())
        return {
            "active_primary_pane_id": ident,
            "panes": [
                {
                    "id": ident,
                    "current_visit": {
                        "id": str(uuid4()),
                        "href": "/lectern",
                        "title_hint": None,
                    },
                    "primary_width_px": None,
                    "visibility": "visible",
                    "history": {"back": [], "forward": []},
                    "secondary": None,
                }
            ],
        }
    active = next(
        (
            pane
            for _, pane in surviving
            if pane["id"] == state["active_primary_pane_id"]
        ),
        None,
    )
    if active is None:
        visible = [
            (index, pane)
            for index, pane in surviving
            if pane["visibility"] == "visible"
        ]
        active = next((pane for index, pane in visible if index > active_index), None)
        if active is None:
            active = next(
                (pane for index, pane in reversed(visible) if index < active_index),
                None,
            )
        if active is None:
            _, active = min(
                surviving,
                key=lambda member: (abs(member[0] - active_index), -member[0]),
            )
            active["visibility"] = "visible"
    return {
        "active_primary_pane_id": active["id"],
        "panes": [pane for _, pane in surviving],
    }


def _bump(db: Any, user: Any, scheme: str, ident: Any, lane: str) -> None:
    db.execute(
        sa.text("""
        INSERT INTO resource_versions(user_id,resource_scheme,resource_id,lane,version)
        VALUES (:user,:scheme,:id,:lane,2)
        ON CONFLICT (user_id,resource_scheme,resource_id,lane) DO UPDATE
        SET version=resource_versions.version+1,updated_at=now()
    """),
        {"user": user, "scheme": scheme, "id": ident, "lane": lane},
    )


def upgrade() -> None:
    db = op.get_bind()
    # Deployment stops writers. Locks keep that cut stable across all preflight reads.
    db.execute(
        sa.text("""LOCK TABLE artifacts,artifact_builds,artifact_idea_seeds,
        artifact_idea_subjects,llm_calls,tool_calls,background_jobs,background_job_capacity_leases,
        note_blocks,authored_identities,resource_versions,resource_edges,resource_view_states,
        message_retrievals,messages,chat_runs,workspace_sessions,nexus_usages,
        media_source_attempts,content_index_states,suggestion_shortlists
        IN SHARE ROW EXCLUSIVE MODE""")
    )
    notes = []
    for row in db.execute(
        sa.text("SELECT id,user_id,body_pm_json,body_text FROM note_blocks")
    ):
        if not _body_affected(row.body_pm_json):
            continue
        changed = _body(row.body_pm_json)
        if changed != row.body_pm_json:
            _require(
                row.body_text == _body_text(row.body_pm_json),
                "affected note projection disagrees",
            )
            identity = db.execute(
                sa.text("""SELECT user_id,canonical_identity_id,retired_at
                FROM authored_identities WHERE kind='note_block' AND resource_id=:id"""),
                {"id": row.id},
            ).first()
            _require(
                identity is not None
                and identity.user_id == row.user_id
                and identity.canonical_identity_id is None
                and identity.retired_at is None,
                "affected note has inconsistent authored identity",
            )
            notes.append((row, changed, _body_text(changed)))
    layouts = []
    for row in db.execute(sa.text("SELECT id,state FROM workspace_sessions")):
        if not _layout_affected(row.state):
            continue
        changed = _layout(row.state)
        if changed != row.state:
            layouts.append((row.id, changed))
    usages = [
        row.id
        for row in db.execute(sa.text("SELECT id,target_href FROM nexus_usages"))
        if _href(row.target_href)
    ]
    edges = list(db.execute(sa.text("SELECT * FROM resource_edges")))
    removed = {
        row.id: row
        for row in edges
        if any(
            (
                row.source_scheme in _RETIRED,
                row.target_scheme in _RETIRED,
                _snapshot(row.snapshot),
            )
        )
    }
    retrievals = list(
        db.execute(
            sa.text("""SELECT mr.*,m.conversation_id FROM message_retrievals mr
        JOIN messages m ON m.id=mr.assistant_message_id""")
        )
    )
    dead_retrievals = [
        row for row in retrievals if _retrieval(row) or row.cited_edge_id in removed
    ]
    for row in dead_retrievals:
        if row.cited_edge_id is not None:
            linked = next(
                (edge for edge in edges if edge.id == row.cited_edge_id), None
            )
            _require(
                linked is not None
                and linked.source_scheme == "message"
                and linked.source_id == row.assistant_message_id,
                "retrieval citation ownership disagrees",
            )
            removed[linked.id] = linked
    # Include every record whose cited fact was marked by a neighboring retrieval.
    dead_retrievals = [
        row for row in retrievals if _retrieval(row) or row.cited_edge_id in removed
    ]
    affected_views = list(
        db.execute(
            sa.text("""SELECT * FROM resource_view_states
        WHERE edge_id=ANY(CAST(:ids AS uuid[])) OR surface_scheme IN ('artifact','artifact_revision')
        OR target_scheme IN ('artifact','artifact_revision')"""),
            {"ids": list(removed)},
        )
    )
    by_id = {edge.id: edge for edge in edges}
    for view in affected_views:
        if view.edge_id is None:
            continue
        edge = by_id.get(view.edge_id)
        _require(
            edge is not None and edge.user_id == view.user_id,
            "affected view has unknown edge owner",
        )
        endpoints = {
            (edge.source_scheme, edge.source_id),
            (edge.target_scheme, edge.target_id),
        }
        surface = (view.surface_scheme, view.surface_id)
        target = (view.target_scheme, view.target_id)
        _require(
            surface in endpoints
            and (target == (None, None) or target in endpoints - {surface}),
            "affected view endpoints disagree with edge",
        )
    chats = {row.conversation_id for row in dead_retrievals}
    for edge in removed.values():
        if edge.origin == "user":
            for scheme, ident in (
                (edge.source_scheme, edge.source_id),
                (edge.target_scheme, edge.target_id),
            ):
                if scheme == "conversation":
                    chats.add(ident)
        elif (
            edge.origin in {"citation", "system"}
            and edge.ordinal is None
            and edge.source_scheme == "conversation"
        ):
            chats.add(edge.source_id)
    scopes = []
    for row in db.execute(
        sa.text("SELECT id,conversation_id,status,generation_spec FROM chat_runs")
    ):
        raw_scope = (
            row.generation_spec.get("tool_scope")
            if isinstance(row.generation_spec, dict)
            else None
        )
        if not isinstance(raw_scope, list) or not any(
            _retired_ref(value) for value in raw_scope
        ):
            continue
        old = _scope(row.generation_spec)
        _require(
            row.generation_spec["operation"] == "chat",
            "affected chat has unknown generation owner",
        )
        changed = [value for value in old if not _ref(value)]
        if changed != old:
            scopes.append((row.id, row.generation_spec | {"tool_scope": changed}))
            chats.add(row.conversation_id)
        _require(
            row.status not in {"queued", "running"} or row.conversation_id not in chats,
            "drain/cancel affected live chats through the old application",
        )
    # A later run in this iteration can expose a chat after an earlier run was inspected.
    _require(
        not db.scalar(
            sa.text("""SELECT count(*) FROM chat_runs WHERE
        status IN ('queued','running') AND conversation_id=ANY(CAST(:ids AS uuid[]))"""),
            {"ids": list(chats)},
        ),
        "drain/cancel affected live chats through the old application",
    )
    for row in db.execute(
        sa.text(
            "SELECT reader_selection_snapshot FROM messages WHERE reader_selection_snapshot IS NOT NULL"
        )
    ):
        snapshot = row.reader_selection_snapshot
        _require(
            isinstance(snapshot, dict) and not _evidence(snapshot.get("evidence")),
            "reader selection unexpectedly names a dossier",
        )
    for row in db.execute(sa.text("SELECT target_refs FROM suggestion_shortlists")):
        _require(
            not (
                isinstance(row.target_refs, list)
                and any(_retired_ref(value) for value in row.target_refs)
            ),
            "suggestion publication unexpectedly names a dossier",
        )
    canonical_links = []
    for edge in removed.values():
        if edge.origin != "user":
            continue
        binding = db.execute(
            sa.text("""SELECT i.*,c.user_id AS canonical_user,c.kind AS canonical_kind,
            c.canonical_identity_id AS canonical_parent,c.retired_at AS canonical_retired,c.resource_id AS canonical_resource
            FROM authored_identities i LEFT JOIN authored_identities c
            ON c.id=COALESCE(i.canonical_identity_id,i.id)
            WHERE i.kind='link' AND i.resource_id=:id"""),
            {"id": edge.id},
        ).first()
        _require(
            binding is not None
            and binding.user_id == edge.user_id
            and binding.canonical_user == edge.user_id
            and binding.canonical_kind == "link"
            and binding.canonical_parent is None
            and binding.canonical_retired is None
            and binding.canonical_resource == edge.id
            and binding.source_ref == f"{edge.source_scheme}:{edge.source_id}",
            "removed user link has inconsistent authored identity",
        )
        canonical_links.append(binding.canonical_identity_id or binding.id)
    dossier_jobs = list(
        db.execute(
            sa.text("SELECT id,payload FROM background_jobs WHERE kind='dossier_build'")
        )
    )
    build_ids = set(db.scalars(sa.text("SELECT id FROM artifact_builds")))
    for row in dossier_jobs:
        _require(
            isinstance(row.payload, dict)
            and not set(row.payload) - {"build_id", "web_picks"}
            and _uuid(row.payload["build_id"])
            and UUID(row.payload["build_id"]) in build_ids,
            "unknown dossier queue ownership",
        )
        if "web_picks" in row.payload:
            picks = row.payload["web_picks"]
            _require(
                isinstance(picks, dict)
                and set(picks)
                == {"ok", "urls", "expected_removal_revision", "search_completed"}
                and isinstance(picks["ok"], bool)
                and isinstance(picks["search_completed"], bool)
                and isinstance(picks["urls"], list)
                and all(isinstance(url, str) for url in picks["urls"])
                and isinstance(picks["expected_removal_revision"], str)
                and re.fullmatch(
                    r"[1-9][0-9]{0,18}", picks["expected_removal_revision"]
                )
                is not None
                and int(picks["expected_removal_revision"])
                <= 9_223_372_036_854_775_807,
                "unknown dossier research checkpoint",
            )
    job_ids = [row.id for row in dossier_jobs]
    job_builds = {row.id: UUID(row.payload["build_id"]) for row in dossier_jobs}
    open_calls = []
    for row in db.execute(sa.text("SELECT * FROM llm_calls WHERE outcome IS NULL")):
        spec = row.generation_spec
        operation = spec.get("operation") if isinstance(spec, dict) else None
        dossier = row.owner_kind == "artifact_build" or operation in _OPERATIONS
        if dossier:
            _require(
                row.owner_kind == "artifact_build"
                and operation in _OPERATIONS
                and row.owner_id in build_ids
                and (row.job_id is None or job_builds.get(row.job_id) == row.owner_id)
                and isinstance(row.generation_spec.get("selection"), dict)
                and row.generation_spec["selection"].get("route")
                in {"CodexPersonal", "ProviderApi"},
                "unknown open dossier generation ownership",
            )
            _scope(spec)
            open_calls.append(row.id)
        else:
            scope = spec.get("tool_scope") if isinstance(spec, dict) else None
            _require(
                not (
                    isinstance(scope, list)
                    and any(_retired_ref(value) for value in scope)
                )
                and row.job_id not in job_ids,
                "unfinished non-dossier generation depends on removed identities",
            )
    for row in db.execute(
        sa.text("SELECT kind,payload FROM background_jobs WHERE kind<>'dossier_build'")
    ):
        _require(isinstance(row.payload, dict), "invalid queue payload")
        _require(
            not _retired_ref(row.payload.get("ref")),
            "non-dossier queued work depends on removed identity",
        )
    _require(
        not db.scalar(
            sa.text("""SELECT count(*) FROM media_source_attempts
        WHERE source_payload ? 'ingest_purpose'
          AND (source_payload->>'ingest_purpose') IS DISTINCT FROM 'artifact_research'""")
        ),
        "unknown ingest-purpose flag",
    )
    # Cross-owner queue references cannot be silently detached by deletion or an old FK cascade.
    for table, column in (
        ("media_source_attempts", "job_id"),
        ("metadata_result_reviews", "job_id"),
        ("suggestion_feeds", "current_job_id"),
    ):
        _require(
            not db.scalar(
                sa.text(
                    f"SELECT count(*) FROM {table} WHERE {column}=ANY(CAST(:ids AS uuid[]))"
                ),
                {"ids": job_ids},
            ),
            "non-dossier owner references a dossier job",
        )

    # 1. execution: preserve closed calls, usage and every landed/terminal receipt.
    db.execute(
        sa.text("""UPDATE llm_calls SET outcome='Failed',failure_code='interrupted',
        completed_at=now(),terminal=jsonb_build_object('kind','Failed','failure_code','interrupted',
        'detail','dossiers removed','route',generation_spec #>> '{selection,route}','evidence','{}'::jsonb)
        WHERE id=ANY(CAST(:ids AS uuid[])) AND outcome IS NULL"""),
        {"ids": open_calls},
    )
    db.execute(
        sa.text("""UPDATE tool_calls SET status='error'
        WHERE status='running' AND generation_id=ANY(CAST(:ids AS uuid[]))"""),
        {"ids": open_calls},
    )
    db.execute(
        sa.text("""UPDATE background_job_capacity_leases SET job_id=NULL,lease_expires_at=NULL,
        updated_at=now() WHERE job_id=ANY(CAST(:ids AS uuid[]))"""),
        {"ids": job_ids},
    )
    db.execute(
        sa.text("DELETE FROM background_jobs WHERE id=ANY(CAST(:ids AS uuid[]))"),
        {"ids": job_ids},
    )
    # 2. bodies: same note, placement and prose; index admission closes until ordinary reindex.
    for row, body, text in notes:
        db.execute(
            sa.text("""UPDATE note_blocks SET body_pm_json=CAST(:body AS jsonb),body_text=:text,
            updated_at=now() WHERE id=:id"""),
            {"body": json.dumps(body), "text": text, "id": row.id},
        )
        _bump(db, row.user_id, "note_block", row.id, "body")
        db.execute(
            sa.text("""INSERT INTO content_index_states(owner_kind,owner_id,status,status_reason)
            VALUES ('note_block',:id,'pending','dossier_removal')
            ON CONFLICT (owner_kind,owner_id) DO UPDATE SET status='pending',
            status_reason='dossier_removal',active_embedding_provider=NULL,active_embedding_model=NULL,
            updated_at=now()"""),
            {"id": row.id},
        )
        db.execute(
            sa.text("""INSERT INTO background_jobs(kind,payload)
            SELECT 'note_reindex_job',jsonb_build_object('note_block_id',CAST(:id AS text),'reason','dossier_removal')
            WHERE NOT EXISTS (SELECT 1 FROM background_jobs WHERE kind='note_reindex_job'
                AND payload->>'note_block_id'=CAST(:id AS text) AND status IN ('pending','failed'))"""),
            {"id": row.id},
        )
    # 3. chats: prompt prose and unrelated evidence remain byte-for-byte.
    for ident, spec in scopes:
        db.execute(
            sa.text(
                "UPDATE chat_runs SET generation_spec=CAST(:spec AS jsonb) WHERE id=:id"
            ),
            {"id": ident, "spec": json.dumps(spec)},
        )
    db.execute(
        sa.text("DELETE FROM message_retrievals WHERE id=ANY(CAST(:ids AS uuid[]))"),
        {"ids": [row.id for row in dead_retrievals]},
    )
    # 4. graph/protocol: dependent views precede every edge; canonical tombstones persist.
    edge_ids = list(removed)
    db.execute(
        sa.text(
            "DELETE FROM resource_view_states WHERE edge_id=ANY(CAST(:ids AS uuid[]))"
        ),
        {"ids": edge_ids},
    )
    db.execute(
        sa.text(
            "UPDATE authored_identities SET retired_at=now() WHERE id=ANY(CAST(:ids AS uuid[]))"
        ),
        {"ids": canonical_links},
    )
    affected_lanes = set()
    for edge in removed.values():
        for scheme, ident in (
            (edge.source_scheme, edge.source_id),
            (edge.target_scheme, edge.target_id),
        ):
            if scheme not in _RETIRED:
                affected_lanes.add((edge.user_id, scheme, ident, "links"))
                if scheme == "conversation" and (
                    edge.origin == "user"
                    or (edge.origin in {"citation", "system"} and edge.ordinal is None)
                ):
                    affected_lanes.add((edge.user_id, scheme, ident, "context"))
    for view in affected_views:
        if view.surface_scheme not in _RETIRED:
            affected_lanes.add(
                (view.user_id, view.surface_scheme, view.surface_id, "links")
            )
            if (
                view.surface_scheme == "conversation"
                and view.context_order_key is not None
            ):
                affected_lanes.add(
                    (view.user_id, view.surface_scheme, view.surface_id, "context")
                )
    for args in affected_lanes:
        _bump(db, *args)
    db.execute(
        sa.text("DELETE FROM resource_edges WHERE id=ANY(CAST(:ids AS uuid[]))"),
        {"ids": edge_ids},
    )
    db.execute(
        sa.text("""DELETE FROM resource_view_states WHERE surface_scheme IN ('artifact','artifact_revision')
        OR target_scheme IN ('artifact','artifact_revision')""")
    )
    db.execute(
        sa.text(
            "DELETE FROM resource_versions WHERE resource_scheme IN ('artifact','artifact_revision')"
        )
    )
    # 5. server navigation.
    for ident, state in layouts:
        db.execute(
            sa.text(
                "UPDATE workspace_sessions SET state=CAST(:state AS jsonb),updated_at=now() WHERE id=:id"
            ),
            {"id": ident, "state": json.dumps(state)},
        )
    db.execute(
        sa.text("DELETE FROM nexus_usages WHERE id=ANY(CAST(:ids AS uuid[]))"),
        {"ids": usages},
    )
    # 6. owned storage and existing discriminator constraints, without CASCADE.
    db.execute(
        sa.text(
            "UPDATE media_source_attempts SET source_payload=source_payload-'ingest_purpose' WHERE source_payload ? 'ingest_purpose'"
        )
    )
    op.execute("DROP TRIGGER artifact_builds_notify ON artifact_builds")
    op.execute("DROP FUNCTION notify_artifact_build()")
    for table in (
        "artifact_idea_seeds",
        "artifact_builds",
        "artifacts",
        "artifact_idea_subjects",
    ):
        op.drop_table(table)
    schemes = ",".join(f"'{scheme}'" for scheme in sorted(_SCHEMES))
    for table, column in (
        ("resource_edges", "source_scheme"),
        ("resource_edges", "target_scheme"),
        ("resource_versions", "resource_scheme"),
        ("resource_view_states", "surface_scheme"),
        ("resource_view_states", "target_scheme"),
    ):
        name = f"ck_{table}_{column}"
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, f"{column} IN ({schemes})")
    op.drop_constraint(
        "ck_resource_edges_citation_shape", "resource_edges", type_="check"
    )
    op.create_check_constraint(
        "ck_resource_edges_citation_shape",
        "resource_edges",
        """
        origin <> 'citation' OR
        (ordinal IS NULL AND kind='context' AND source_scheme='conversation' AND snapshot IS NULL) OR
        (ordinal IS NOT NULL AND source_scheme IN ('message','oracle_reading'))
    """,
    )
    # 7. re-read owned live fields. Historical raw audit payloads are deliberately excluded.
    for row in db.execute(sa.text("SELECT body_pm_json,body_text FROM note_blocks")):
        _require(
            not _body_affected(row.body_pm_json), "retired reference remains in note"
        )
    for row, _, _ in notes:
        current = db.execute(
            sa.text("SELECT body_pm_json,body_text FROM note_blocks WHERE id=:id"),
            {"id": row.id},
        ).one()
        _require(
            _body(current.body_pm_json) == current.body_pm_json
            and current.body_text == _body_text(current.body_pm_json),
            "changed note body is invalid",
        )
    for row in db.execute(sa.text("SELECT state FROM workspace_sessions")):
        _require(not _layout_affected(row.state), "retired navigation remains")
    for ident, _ in layouts:
        current = db.scalar(
            sa.text("SELECT state FROM workspace_sessions WHERE id=:id"), {"id": ident}
        )
        _require(_layout(current) == current, "changed workspace is invalid")
    for row in db.execute(sa.text("SELECT target_href FROM nexus_usages")):
        _require(not _href(row.target_href), "retired launcher navigation remains")
    _require(
        not db.scalar(
            sa.text(
                "SELECT count(*) FROM media_source_attempts WHERE source_payload ? 'ingest_purpose'"
            )
        ),
        "retired ingest purpose remains",
    )
    for row in db.execute(sa.text("SELECT generation_spec FROM chat_runs")):
        spec = row.generation_spec
        scope = spec.get("tool_scope") if isinstance(spec, dict) else None
        _require(
            not (
                isinstance(scope, list) and any(_retired_ref(value) for value in scope)
            ),
            "retired saved scope remains",
        )
    for row in db.execute(sa.text("SELECT * FROM message_retrievals")):
        _require(not _retrieval(row), "retired retrieval remains")
    for row in db.execute(sa.text("SELECT snapshot FROM resource_edges")):
        _require(not _snapshot(row.snapshot), "retired graph snapshot remains")
    _require(
        not db.scalar(
            sa.text("SELECT count(*) FROM background_jobs WHERE kind='dossier_build'")
        ),
        "dossier job remains",
    )
    _require(
        not db.scalar(
            sa.text(
                "SELECT count(*) FROM llm_calls WHERE outcome IS NULL AND owner_kind='artifact_build'"
            )
        ),
        "open dossier generation remains",
    )
    _require(
        not db.scalar(
            sa.text(
                "SELECT count(*) FROM background_job_capacity_leases WHERE job_id=ANY(CAST(:ids AS uuid[]))"
            ),
            {"ids": job_ids},
        ),
        "dossier capacity lease remains",
    )
    for table in (
        "artifact_idea_seeds",
        "artifact_builds",
        "artifacts",
        "artifact_idea_subjects",
    ):
        _require(
            db.scalar(sa.text("SELECT to_regclass(:table)"), {"table": table}) is None,
            "dossier table remains",
        )


def downgrade() -> None:
    raise NotImplementedError(
        "0314 is irreversible; restore the verified matching backup and build"
    )
