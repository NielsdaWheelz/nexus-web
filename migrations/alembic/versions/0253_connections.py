"""Neutral user links, prose-only inline references and discovery vocabulary.

Stop writers, drain/export client journals and reconcile old discovery first.
The cutover is intentionally irreversible; restore the matching backup before
new writes, or repair forward. Historical generation/job documents are immutable.

Revision ID: 0253
Revises: 0252
"""

from collections import defaultdict
from collections.abc import Sequence
import json
from uuid import UUID, uuid4

from alembic import op
import sqlalchemy as sa

revision: str = "0253"
down_revision: str | Sequence[str] | None = "0252"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LEGACY_TABLES = {
    "media": "media",
    "library": "libraries",
    "highlight": "highlights",
    "page": "pages",
    "note_block": "note_blocks",
    "conversation": "conversations",
    "message": "messages",
    "oracle_reading": "oracle_readings",
    "artifact": "artifacts",
    "contributor": "contributors",
    "podcast": "podcasts",
    "passage_anchor": "passage_anchors",
    "content_chunk": "content_chunks",
    "evidence_span": "evidence_spans",
    "fragment": "fragments",
    "oracle_passage_anchor": "oracle_passage_anchors",
    "reader_apparatus_item": "reader_apparatus_items",
    "external_snapshot": "resource_external_snapshots",
}
_ORDERED = {"page", "note_block", "conversation"}


def _text(value):
    """Frozen prior-head canonical body projection, also used after conversion."""
    parts = []

    def visit(node):
        if isinstance(node, list):
            for child in node:
                visit(child)
            return
        if not isinstance(node, dict):
            return
        kind = node.get("type")
        if kind == "text" and isinstance(node.get("text"), str):
            parts.append(node["text"])
        elif kind in {"object_ref", "object_embed"} and isinstance(
            node.get("attrs"), dict
        ):
            attrs = node["attrs"]
            label = (
                attrs.get("label")
                or f"{attrs.get('objectType')}:{attrs.get('objectId')}"
            )
            if isinstance(label, str):
                parts.append(label)
        elif kind == "image" and isinstance(node.get("attrs"), dict):
            if isinstance(node["attrs"].get("alt"), str):
                parts.append(node["attrs"]["alt"])
        elif kind == "hard_break":
            parts.append("\n")
        visit(node.get("content"))
        if kind in {"paragraph", "code_block"}:
            parts.append("\n")

    visit(value)
    return "\n".join(line.rstrip() for line in "".join(parts).splitlines()).strip()


def _mapped(db, viewer, ref):
    if ref[0] != "artifact_revision":
        return ref
    row = db.execute(
        sa.text("""SELECT a.id FROM artifact_revisions r
        JOIN artifact_builds b ON b.id=r.build_id JOIN artifacts a ON a.id=b.artifact_id
        WHERE r.id=:id"""),
        {"id": ref[1]},
    ).first()
    if row is None:
        raise RuntimeError(
            f"revision {ref[1]} has no durable head; repair before cutover"
        )
    head = ("artifact", row[0])
    if _visibility(db, viewer, head) != "visible":
        raise RuntimeError(f"revision {ref[1]} has an inaccessible head")
    return head


def _visibility(db, viewer, ref):
    """Frozen visibility for the durable endpoints admitted by this cutover."""
    scheme, identity = ref
    if scheme not in _LEGACY_TABLES:
        raise RuntimeError(
            f"unsupported legacy endpoint {scheme}:{identity}; explicit repair required"
        )
    row = (
        db.execute(
            sa.text(f"SELECT * FROM {_LEGACY_TABLES[scheme]} WHERE id=:id"),
            {"id": identity},
        )
        .mappings()
        .first()
    )
    if row is None:
        return "deleted"
    if scheme in {
        "content_chunk",
        "evidence_span",
        "fragment",
        "oracle_passage_anchor",
        "reader_apparatus_item",
        "external_snapshot",
    }:
        raise RuntimeError(
            f"unsupported legacy endpoint {scheme}:{identity}; explicit repair required"
        )
    if scheme in {"page", "note_block", "oracle_reading", "passage_anchor"}:
        visible = row["user_id"] == viewer
    elif scheme == "conversation":
        visible = row["owner_user_id"] == viewer
    elif scheme == "message":
        return _visibility(db, viewer, ("conversation", row["conversation_id"]))
    elif scheme == "contributor":
        visible = True
    elif scheme == "library":
        visible = db.scalar(
            sa.text(
                "SELECT EXISTS(SELECT 1 FROM memberships WHERE library_id=:id AND user_id=:viewer)"
            ),
            {"id": identity, "viewer": viewer},
        )
    elif scheme == "podcast":
        visible = db.scalar(
            sa.text("""SELECT EXISTS(SELECT 1 FROM podcast_subscriptions WHERE podcast_id=:id AND user_id=:viewer)
            OR EXISTS(SELECT 1 FROM library_entries e JOIN memberships m ON m.library_id=e.library_id
                WHERE e.podcast_id=:id AND m.user_id=:viewer)"""),
            {"id": identity, "viewer": viewer},
        )
    elif scheme == "media":
        visible = db.scalar(
            sa.text("""SELECT (
            EXISTS(SELECT 1 FROM library_entries e JOIN memberships m ON m.library_id=e.library_id WHERE e.media_id=:id AND m.user_id=:viewer)
            OR EXISTS(SELECT 1 FROM resource_grants g LEFT JOIN highlights h ON g.subject_scheme='highlight' AND h.id=g.subject_id
                WHERE ((g.subject_scheme='media' AND g.subject_id=:id) OR h.anchor_media_id=:id)
                AND (g.grantee_user_id=:viewer OR g.created_by_user_id=:viewer)))
            AND NOT EXISTS(SELECT 1 FROM user_media_deletions WHERE media_id=:id AND user_id=:viewer)
            AND NOT EXISTS(SELECT 1 FROM media_teardown_intents WHERE media_id=:id)"""),
            {"id": identity, "viewer": viewer},
        )
    elif scheme == "highlight":
        visible = (
            row["anchor_media_id"] is not None
            and _visibility(db, viewer, ("media", row["anchor_media_id"])) == "visible"
        )
        if visible and row["user_id"] != viewer:
            visible = db.scalar(
                sa.text("""SELECT EXISTS(SELECT 1 FROM library_entries e
                JOIN memberships v ON v.library_id=e.library_id JOIN memberships a ON a.library_id=e.library_id
                WHERE e.media_id=:media AND v.user_id=:viewer AND a.user_id=:author)
                OR EXISTS(SELECT 1 FROM resource_grants WHERE subject_scheme='highlight' AND subject_id=:id
                    AND (grantee_user_id=:viewer OR created_by_user_id=:viewer))"""),
                {
                    "id": identity,
                    "media": row["anchor_media_id"],
                    "viewer": viewer,
                    "author": row["user_id"],
                },
            )
    else:
        if row["audience_scheme"] == "user":
            visible = row["audience_id"] == str(viewer)
        elif row["audience_scheme"] == "library":
            visible = db.scalar(
                sa.text(
                    "SELECT EXISTS(SELECT 1 FROM memberships WHERE library_id::text=:id AND user_id=:viewer)"
                ),
                {"id": row["audience_id"], "viewer": viewer},
            )
        else:
            visible = False
        if visible and row["subject_scheme"] == "idea":
            visible = row["audience_scheme"] == "user" and db.scalar(
                sa.text(
                    "SELECT EXISTS(SELECT 1 FROM artifact_idea_subjects WHERE id=:id AND user_id=:viewer)"
                ),
                {"id": row["subject_id"], "viewer": viewer},
            )
        elif visible:
            visible = (
                _visibility(db, viewer, (row["subject_scheme"], row["subject_id"]))
                == "visible"
            )
    return "visible" if visible else "forbidden"


def _bump_version(db, viewer, scheme, identity, lane):
    existing = db.scalar(
        sa.text(
            "SELECT id FROM resource_versions WHERE user_id=:viewer AND resource_scheme=:scheme AND resource_id=:id AND lane=:lane"
        ),
        {"viewer": viewer, "scheme": scheme, "id": identity, "lane": lane},
    )
    if existing is None:
        db.execute(
            sa.text(
                "INSERT INTO resource_versions(id,user_id,resource_scheme,resource_id,lane,version) VALUES(:version_id,:viewer,:scheme,:id,:lane,2)"
            ),
            {
                "version_id": uuid4(),
                "viewer": viewer,
                "scheme": scheme,
                "id": identity,
                "lane": lane,
            },
        )
    else:
        db.execute(
            sa.text(
                "UPDATE resource_versions SET version=version+1,updated_at=now() WHERE id=:id"
            ),
            {"id": existing},
        )


def upgrade() -> None:
    db = op.get_bind()
    if db.scalar(
        sa.text("""SELECT EXISTS(SELECT 1 FROM background_jobs WHERE kind='synapse_scan'
        AND status NOT IN ('succeeded','dead')) OR EXISTS(SELECT 1 FROM llm_calls
        WHERE owner_kind='synapse_scan' AND outcome IS NULL)""")
    ):
        raise RuntimeError(
            "unsettled discovery blocks cutover; settle through its old owner first"
        )
    retired_tool = db.execute(
        sa.text("""WITH unfinished AS (
        SELECT id,'generation' AS owner,generation_spec FROM llm_calls WHERE outcome IS NULL
        UNION ALL
        SELECT id,'chat run' AS owner,generation_spec FROM chat_runs
        WHERE status NOT IN ('complete','error','cancelled')
    )
    SELECT id,owner FROM unfinished
    CROSS JOIN LATERAL (VALUES
        (generation_spec #> '{authority,api_plan}'),
        (generation_spec #> '{authority,model_tool_plan_snapshot,value}')
    ) plans(plan)
    WHERE plan->>'plan_id' IN ('CodexGenerationApi','ChatReadAdditiveWrite')
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(plan->'grants') tool_grant
        WHERE tool_grant->>'id'='nexus.resource.read'
          AND tool_grant->>'tool_contract_revision'='fd788383ca8b323afd90a940897ccfd77edeede68b1d45e071ecd7a6417d6e88')
    ORDER BY owner,id LIMIT 1""")
    ).first()
    if retired_tool is not None:
        raise RuntimeError(
            f"unsettled retired tool plan blocks cutover: {retired_tool[1]} {retired_tool[0]}; "
            "settle through its old owner first"
        )

    # Remove only incompatible domain CHECKs. Shape remains owned by the writer;
    # real pair/occurrence keys below remain database uniqueness.
    for name in (
        "ck_resource_edges_origin",
        "ck_resource_edges_snapshot_origin",
        "ck_resource_edges_snapshot_has_ordinal",
        "ck_resource_edges_synapse_shape",
        "ck_resource_edges_synapse_snapshot_excerpt",
        "ck_resource_edges_source_order_key_shape",
        "ck_resource_edges_neutral_canonical",
    ):
        op.drop_constraint(name, "resource_edges", type_="check")
    op.drop_constraint(
        "ck_resource_view_states_order_endpoint", "resource_view_states", type_="check"
    )
    op.drop_index(
        "uq_resource_edges_user_stance_directed_pair", table_name="resource_edges"
    )
    op.drop_index(
        "uq_resource_edges_user_context_link_pair", table_name="resource_edges"
    )

    user_rows = (
        db.execute(
            sa.text(
                "SELECT * FROM resource_edges WHERE origin='user' ORDER BY created_at,id"
            )
        )
        .mappings()
        .all()
    )
    states = (
        db.execute(sa.text("SELECT * FROM resource_view_states ORDER BY created_at,id"))
        .mappings()
        .all()
    )
    motifs = (
        db.execute(
            sa.text(
                "SELECT * FROM resource_edges WHERE origin='link_note' ORDER BY created_at,id"
            )
        )
        .mappings()
        .all()
    )
    groups = defaultdict(list)
    changed_refs = set()
    collapsed = []
    for row in user_rows:
        if (
            row["kind"] not in {"context", "supports", "contradicts"}
            or row["ordinal"] is not None
            or row["snapshot"] is not None
        ):
            raise RuntimeError(f"unexplained user link {row['id']}")
        if row["source_order_key"] is not None and (
            row["source_scheme"] != "conversation" or row["kind"] != "context"
        ):
            raise RuntimeError(f"unexplained ordered user link {row['id']}")
        old = (
            (row["source_scheme"], row["source_id"]),
            (row["target_scheme"], row["target_id"]),
        )
        a, b = (_mapped(db, row["user_id"], endpoint) for endpoint in old)
        for endpoint in (a, b):
            if _visibility(db, row["user_id"], endpoint) != "visible":
                raise RuntimeError(
                    f"user link {row['id']} has an inaccessible/missing endpoint"
                )
            changed_refs.add((row["user_id"], *endpoint))
        pair = tuple(sorted((a, b), key=lambda ref: f"{ref[0]}:{ref[1]}"))
        if a == b:
            collapsed.append(row)
        else:
            groups[(row["user_id"], *pair)].append(row)

    # Preflight note motifs before any deletion. Their ordinary bodies always survive.
    mapped_motifs = defaultdict(list)
    for row in motifs:
        target = _mapped(db, row["user_id"], (row["target_scheme"], row["target_id"]))
        mapped_motifs[(row["user_id"], row["source_id"])].append((row, target))
    for (viewer, note_id), members in mapped_motifs.items():
        targets = {target for _, target in members}
        if len(members) != 2 or len(targets) != 2:
            raise RuntimeError(
                f"annotated identity collapse/ambiguous note {note_id}; retain body and repair"
            )
        pair = tuple(sorted(targets, key=lambda ref: f"{ref[0]}:{ref[1]}"))
        key = (viewer, *pair)
        if key in groups:
            others = [
                other_id
                for (u, other_id), values in mapped_motifs.items()
                if u == viewer and {target for _, target in values} == targets
            ]
            if len(others) != 1:
                raise RuntimeError(
                    f"conflicting link notes {others}; repair explicitly"
                )
    inline_pairs = set()
    body_changes = []
    removed_inline = []
    for block in db.execute(
        sa.text("SELECT id,user_id,body_pm_json,body_text FROM note_blocks ORDER BY id")
    ).mappings():
        found = []

        def rewrite(node):
            if isinstance(node, list):
                return [rewrite(child) for child in node]
            if not isinstance(node, dict):
                return node
            if node.get("type") == "object_ref":
                attrs = node.get("attrs")
                if not isinstance(attrs, dict) or not isinstance(
                    attrs.get("objectType"), str
                ):
                    raise RuntimeError(f"invalid inline target in note {block['id']}")
                target = (attrs["objectType"], UUID(attrs["objectId"]))
                label = (
                    attrs.get("label")
                    or f"{attrs.get('objectType')}:{attrs.get('objectId')}"
                )
                if not isinstance(label, str) or not label:
                    raise RuntimeError(f"invalid inline label in note {block['id']}")
                found.append(target)
                replacement = {"type": "text", "text": label}
                if "marks" in node:
                    replacement["marks"] = node["marks"]
                return replacement
            return {
                key: rewrite(value) if key == "content" else value
                for key, value in node.items()
            }

        body = rewrite(block["body_pm_json"])
        if not found:
            continue
        if (
            _text(block["body_pm_json"]) != block["body_text"]
            or _text(body) != block["body_text"]
        ):
            raise RuntimeError(
                f"canonical text mismatch in note {block['id']}; repair before cutover"
            )
        source = ("note_block", block["id"])
        for original in found:
            if original == source:
                removed_inline.append((block["id"], original, "self"))
                continue
            if original[0] == "artifact_revision":
                exists = db.scalar(
                    sa.text(
                        "SELECT EXISTS(SELECT 1 FROM artifact_revisions WHERE id=:id)"
                    ),
                    {"id": original[1]},
                )
                if not exists:
                    removed_inline.append((block["id"], original, "deleted"))
                    continue
            target = _mapped(db, block["user_id"], original)
            visibility = _visibility(db, block["user_id"], target)
            if visibility == "forbidden":
                raise RuntimeError(
                    f"forbidden inline target {original} in note {block['id']}"
                )
            if visibility == "deleted" or target == source:
                removed_inline.append((block["id"], original, visibility))
                continue
            a, b = sorted((source, target), key=lambda ref: f"{ref[0]}:{ref[1]}")
            inline_pairs.add((block["user_id"], a, b))
            changed_refs.update(((block["user_id"], *a), (block["user_id"], *b)))
        body_changes.append((block, body))

    selected_states = []
    survivors = {}
    for key, members in groups.items():
        viewer, a, b = key
        survivor = next(
            (
                row
                for row in members
                if row["kind"] == "context" and row["source_order_key"] is None
            ),
            members[0],
        )
        survivors[key] = survivor["id"]
        candidate_states = [
            dict(state)
            for state in states
            if state["edge_id"] in {row["id"] for row in members}
        ]
        surfaces = {
            _mapped(db, viewer, (state["surface_scheme"], state["surface_id"]))
            for state in candidate_states
        } | {a, b}
        for surface in surfaces:
            candidates = [
                state
                for state in candidate_states
                if _mapped(db, viewer, (state["surface_scheme"], state["surface_id"]))
                == surface
            ]
            saved_states = {
                json.dumps(candidate["state"], sort_keys=True): candidate["state"]
                for candidate in candidates
                if candidate["state"]
            }
            if len(saved_states) > 1:
                raise RuntimeError(
                    f"conflicting endpoint view state at {surface}; repair before cutover"
                )
            state = next(
                (state for state in candidates if state["edge_id"] == survivor["id"]),
                candidates[0] if candidates else None,
            )
            if state is None and surface[0] not in _ORDERED:
                continue
            if state is None:
                state = {
                    "id": uuid4(),
                    "user_id": viewer,
                    "state": {},
                    "order_key": None,
                }
            state = dict(state)
            if saved_states:
                state["state"] = next(iter(saved_states.values()))
            state.update(
                surface_scheme=surface[0], surface_id=surface[1], edge_id=survivor["id"]
            )
            if surface in (a, b):
                target = b if surface == a else a
                state.update(target_scheme=target[0], target_id=target[1])
                old_ranks = [
                    candidate["order_key"]
                    for candidate in candidates
                    if candidate["order_key"] is not None
                ]
                old_ranks += [
                    row["source_order_key"]
                    for row in members
                    if _mapped(db, viewer, (row["source_scheme"], row["source_id"]))
                    == surface
                    and row["source_order_key"] is not None
                ]
                if old_ranks:
                    state["order_key"] = min(old_ranks)
            elif state.get("target_scheme") is not None:
                target = _mapped(
                    db, viewer, (state["target_scheme"], state["target_id"])
                )
                state.update(target_scheme=target[0], target_id=target[1])
            selected_states.append(state)

    if user_rows:
        ids = [row["id"] for row in user_rows]
        db.execute(
            sa.text("DELETE FROM resource_view_states WHERE edge_id=ANY(:ids)"),
            {"ids": ids},
        )
        keep = set(survivors.values())
        drop = [identity for identity in ids if identity not in keep]
        if drop:
            db.execute(
                sa.text("DELETE FROM resource_edges WHERE id=ANY(:ids)"), {"ids": drop}
            )
    for (viewer, a, b), identity in survivors.items():
        db.execute(
            sa.text("""UPDATE resource_edges SET kind='context',source_scheme=:ascheme,source_id=:aid,
            target_scheme=:bscheme,target_id=:bid,source_order_key=NULL WHERE id=:id"""),
            {
                "ascheme": a[0],
                "aid": a[1],
                "bscheme": b[0],
                "bid": b[1],
                "id": identity,
            },
        )
    for viewer, a, b in sorted(inline_pairs, key=str):
        if (viewer, a, b) in survivors:
            continue
        identity = uuid4()
        db.execute(
            sa.text("""INSERT INTO resource_edges(id,user_id,kind,origin,source_scheme,source_id,target_scheme,target_id)
            VALUES(:id,:viewer,'context','user',:ascheme,:aid,:bscheme,:bid)"""),
            {
                "id": identity,
                "viewer": viewer,
                "ascheme": a[0],
                "aid": a[1],
                "bscheme": b[0],
                "bid": b[1],
            },
        )
        survivors[(viewer, a, b)] = identity
        for endpoint, target in ((a, b), (b, a)):
            if endpoint[0] in _ORDERED:
                selected_states.append(
                    {
                        "id": uuid4(),
                        "user_id": viewer,
                        "surface_scheme": endpoint[0],
                        "surface_id": endpoint[1],
                        "edge_id": identity,
                        "target_scheme": target[0],
                        "target_id": target[1],
                        "order_key": None,
                        "state": {},
                    }
                )

    # Reuse the earliest rank of a target after an identity merge. Two rank stores
    # may agree for the same target; distinct targets must retain distinct ranks.
    by_surface = defaultdict(list)
    for state in selected_states:
        by_surface[
            (state["user_id"], state["surface_scheme"], state["surface_id"])
        ].append(state)
    for (viewer, scheme, identity), entries in by_surface.items():
        automatic = (
            db.execute(
                sa.text("""SELECT id,target_scheme,target_id,source_order_key FROM resource_edges
            WHERE user_id=:viewer AND source_scheme=:scheme AND source_id=:id AND source_order_key IS NOT NULL
            AND origin IN ('citation','system')"""),
                {"viewer": viewer, "scheme": scheme, "id": identity},
            )
            .mappings()
            .all()
        )
        by_target = defaultdict(list)
        for row in automatic:
            by_target[(row["target_scheme"], row["target_id"])].append(row)
        if any(len(rows) != 1 for rows in by_target.values()):
            raise RuntimeError(
                f"multiple automatic attachment slots at {scheme}:{identity}"
            )
        ranks = {}
        for row in automatic:
            ranks[row["source_order_key"]] = (row["target_scheme"], row["target_id"])
        for entry in entries:
            target = (entry.get("target_scheme"), entry.get("target_id"))
            autos = by_target.get(target, [])
            if autos:
                earliest = (
                    min(entry["order_key"], autos[0]["source_order_key"])
                    if entry["order_key"] is not None
                    else autos[0]["source_order_key"]
                )
                if earliest in ranks and ranks[earliest] != target:
                    raise RuntimeError(f"rank conflict at {scheme}:{identity}")
                del ranks[autos[0]["source_order_key"]]
                db.execute(
                    sa.text(
                        "UPDATE resource_edges SET source_order_key=:key WHERE id=:id"
                    ),
                    {"key": earliest, "id": autos[0]["id"]},
                )
                entry["order_key"] = earliest
                ranks[earliest] = target
            if entry["order_key"] is not None:
                key = entry["order_key"]
                if key in ranks and ranks[key] != target:
                    raise RuntimeError(f"rank conflict at {scheme}:{identity}")
                ranks[key] = target
        for entry in entries:
            if entry["order_key"] is None and scheme in _ORDERED:
                # Existing ranks use the graph's decimal append format.
                try:
                    next_rank = max((int(key) for key in ranks), default=0) + 1
                except ValueError as error:
                    raise RuntimeError(
                        f"unexpected rank format at {scheme}:{identity}"
                    ) from error
                entry["order_key"] = f"{next_rank:010d}"
                ranks[entry["order_key"]] = (entry["target_scheme"], entry["target_id"])
            db.execute(
                sa.text("""INSERT INTO resource_view_states(id,user_id,surface_scheme,surface_id,edge_id,target_scheme,target_id,order_key,state)
                VALUES(:id,:user_id,:surface_scheme,:surface_id,:edge_id,:target_scheme,:target_id,:order_key,CAST(:state_json AS jsonb))"""),
                {**entry, "state_json": json.dumps(entry["state"])},
            )

    for (_, _), members in mapped_motifs.items():
        for row, target in members:
            db.execute(
                sa.text(
                    "UPDATE resource_edges SET target_scheme=:scheme,target_id=:id WHERE id=:edge"
                ),
                {"scheme": target[0], "id": target[1], "edge": row["id"]},
            )
    for block, body in body_changes:
        db.execute(
            sa.text(
                "UPDATE note_blocks SET body_pm_json=CAST(:body AS jsonb),updated_at=now() WHERE id=:id"
            ),
            {"body": json.dumps(body), "id": block["id"]},
        )
        # Rebuild this source's derived body facts exclusively from surviving embeds.
        old_ids = (
            db.execute(
                sa.text(
                    "SELECT id FROM resource_edges WHERE user_id=:viewer AND source_scheme='note_block' AND source_id=:id AND origin='note_body'"
                ),
                {"viewer": block["user_id"], "id": block["id"]},
            )
            .scalars()
            .all()
        )
        if old_ids:
            db.execute(
                sa.text("DELETE FROM resource_view_states WHERE edge_id=ANY(:ids)"),
                {"ids": old_ids},
            )
            db.execute(
                sa.text("DELETE FROM resource_edges WHERE id=ANY(:ids)"),
                {"ids": old_ids},
            )
        embeds = set()

        def collect(node):
            if isinstance(node, list):
                for child in node:
                    collect(child)
            elif isinstance(node, dict):
                if node.get("type") == "object_embed":
                    attrs = node["attrs"]
                    embeds.add((attrs["objectType"], UUID(attrs["objectId"])))
                collect(node.get("content"))

        collect(body)
        for target in embeds:
            if target == ("note_block", block["id"]):
                continue
            db.execute(
                sa.text("""INSERT INTO resource_edges(id,user_id,kind,origin,source_scheme,source_id,target_scheme,target_id)
                VALUES(:edge,:viewer,'context','note_body','note_block',:id,:scheme,:target)"""),
                {
                    "edge": uuid4(),
                    "viewer": block["user_id"],
                    "id": block["id"],
                    "scheme": target[0],
                    "target": target[1],
                },
            )
        changed_refs.add((block["user_id"], "note_block", block["id"]))
        _bump_version(db, block["user_id"], "note_block", block["id"], "body")
    for viewer, scheme, identity in changed_refs:
        _bump_version(db, viewer, scheme, identity, "links")

    op.create_index(
        "uq_resource_edges_user_link_pair",
        "resource_edges",
        ["user_id", "source_scheme", "source_id", "target_scheme", "target_id"],
        unique=True,
        postgresql_where=sa.text("origin='user'"),
    )
    op.execute("UPDATE resource_edges SET origin='discovery' WHERE origin='synapse'")
    op.drop_constraint(
        "ck_synapse_suppressions_source_scheme", "synapse_suppressions", type_="check"
    )
    op.drop_constraint(
        "ck_synapse_suppressions_target_scheme", "synapse_suppressions", type_="check"
    )
    op.rename_table("synapse_suppressions", "connection_discovery_suppressions")
    op.execute(
        "ALTER TABLE connection_discovery_suppressions RENAME CONSTRAINT synapse_suppressions_pkey TO connection_discovery_suppressions_pkey"
    )
    op.execute(
        "ALTER TABLE connection_discovery_suppressions RENAME CONSTRAINT synapse_suppressions_user_id_fkey TO connection_discovery_suppressions_user_id_fkey"
    )
    op.execute(
        "ALTER INDEX ix_synapse_suppressions_user_target RENAME TO ix_connection_discovery_suppressions_user_target"
    )
    op.execute("""DELETE FROM resource_mutations WHERE mutation_scope='resource_graph:link'
        OR mutation_scope LIKE 'resource:%' OR mutation_scope LIKE 'link_note:%'
        OR mutation_scope='daily:capture' OR mutation_scope LIKE 'highlight_note:%'""")
    # Identity/count evidence contains no discarded stance labels or prose bodies.
    print(
        f"connections cutover: {len(user_rows)} old user facts -> {len(survivors)} pairs; "
        f"{len(body_changes)} bodies; {len(collapsed)} unannotated self collapses; "
        f"inline self/deleted identities={removed_inline}"
    )


def downgrade() -> None:
    raise RuntimeError(
        "connections cutover requires matching backup restore or forward repair"
    )
