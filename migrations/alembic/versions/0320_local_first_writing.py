"""Seed one durable authored graph, preserving identities, prose and relationships.

0320 follows actual head 0319. All writers must be stopped. Conversion uses the
frozen sibling semantic bundle, never application imports. Any unsupported body,
duplicate semantic binding or missing annotation extent aborts this transaction.
Existing source provenance is unknown unless independently proved; this migration
retains literal captures with null publication rather than invent a generation.
"""

import base64
import hashlib
import json
import subprocess
from datetime import date
from functools import cache
from pathlib import Path
from uuid import UUID, uuid5

import sqlalchemy as sa
from alembic import op

revision = "0320"
down_revision = "0319"
branch_labels = None
depends_on = None


def _json(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, sort_keys=True)


@cache
def _node_binary() -> str:
    return subprocess.run(
        ["node", "-p", "process.execPath"],
        text=True,
        capture_output=True,
        timeout=30,
        check=True,
    ).stdout.strip()


def _helper(value: object) -> dict:
    result = subprocess.run(
        [
            _node_binary(),
            "--max-old-space-size=128",
            str(Path(__file__).with_name("0320_authored_seed.mjs")),
        ],
        input=_json(value),
        text=True,
        capture_output=True,
        timeout=30,
        check=True,
        env={"NODE_ENV": "production", "PATH": "/usr/local/bin:/usr/bin:/bin"},
    )
    return json.loads(result.stdout)


def _insert(
    connection, table: str, key: str, account, identity: str, state: dict
) -> None:
    if len(_json(state).encode()) > 2 * 1024 * 1024:
        raise RuntimeError(
            f"0320 {table} {identity} exceeds the 2 MiB atomic-change budget"
        )
    if table == "authored_resources" and state["kind"] in ("note", "page"):
        value = dict(state)
        encoded = value.pop("body_state" if state["kind"] == "note" else "title_state")
        connection.execute(
            sa.text(
                "INSERT INTO authored_resources(account_id,ref,state,merge_bytes) "
                "VALUES (:a,:k,CAST(:state AS jsonb),:bytes)"
            ),
            {
                "a": account,
                "k": identity,
                "state": _json(value),
                "bytes": base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)),
            },
        )
        return
    connection.execute(
        sa.text(
            f"INSERT INTO {table}(account_id,{key},state) "
            "VALUES (:a,:k,CAST(:state AS jsonb))"
        ),
        {"a": account, "k": identity, "state": _json(state)},
    )


def upgrade() -> None:
    connection = op.get_bind()
    op.execute(
        "CREATE TEMP TABLE authored_changed_note_text(id uuid PRIMARY KEY) ON COMMIT DROP"
    )
    op.execute("""CREATE TABLE authored_heads (
        account_id uuid PRIMARY KEY REFERENCES users(id), head_seq bigint NOT NULL CHECK(head_seq>=0),
        lamport bigint NOT NULL DEFAULT 1 CHECK(lamport>0))""")
    op.execute("""CREATE TABLE authored_replicas (
        account_id uuid NOT NULL REFERENCES users(id), replica_id uuid NOT NULL,
        accepted_seq bigint NOT NULL CHECK(accepted_seq>=0),
        PRIMARY KEY(account_id,replica_id))""")
    for table, key in (
        ("authored_resources", "ref"),
        ("authored_links", "link_id"),
        ("authored_passages", "anchor_id"),
        ("authored_source_stubs", "source_ref"),
    ):
        op.execute(f"""CREATE TABLE {table} (
            account_id uuid NOT NULL REFERENCES users(id), {key} text NOT NULL,
            state jsonb NOT NULL CHECK(jsonb_typeof(state)='object'),
            PRIMARY KEY(account_id,{key}))""")
    op.execute(
        "ALTER TABLE authored_resources ADD COLUMN visible boolean NOT NULL DEFAULT true"
    )
    op.execute("ALTER TABLE authored_resources ADD COLUMN merge_bytes bytea")
    op.execute("""CREATE UNIQUE INDEX authored_daily_binding ON authored_resources
        (account_id,(state->>'local_date')) WHERE state->>'kind'='page'
        AND state->>'local_date' IS NOT NULL""")
    op.execute("""CREATE UNIQUE INDEX authored_link_binding ON authored_links
        (account_id,(state->>'endpoint_a'),(state->>'endpoint_b'))""")
    op.execute(
        """ALTER TABLE authored_passages ADD COLUMN semantic_key text NOT NULL DEFAULT ''"""
    )
    op.execute("""CREATE UNIQUE INDEX authored_passage_binding ON authored_passages
        (account_id,(state->>'source_ref'),semantic_key)""")
    op.execute(
        """CREATE INDEX authored_link_a ON authored_links(account_id,(state->>'endpoint_a'),(state #>> '{position_a,value}') COLLATE "C" DESC NULLS LAST,link_id DESC)"""
    )
    op.execute(
        """CREATE INDEX authored_link_b ON authored_links(account_id,(state->>'endpoint_b'),(state #>> '{position_b,value}') COLLATE "C" DESC NULLS LAST,link_id DESC)"""
    )
    op.execute("""CREATE TABLE authored_changes (
        account_id uuid NOT NULL REFERENCES users(id),server_seq bigint NOT NULL CHECK(server_seq>0),
        replica_id uuid NOT NULL,command_seq bigint NOT NULL CHECK(command_seq>0),change jsonb NOT NULL,
        PRIMARY KEY(account_id,server_seq),UNIQUE(account_id,replica_id,command_seq),
        FOREIGN KEY(account_id,replica_id) REFERENCES authored_replicas(account_id,replica_id))""")
    for table in ("note_blocks", "pages", "highlights", "resource_edges"):
        op.execute(
            f"ALTER TABLE {table} ADD COLUMN authored_visible boolean NOT NULL DEFAULT true"
        )
    op.drop_constraint("ck_pages_title_length", "pages", type_="check")
    op.drop_constraint(
        "highlight_pdf_anchors_media_id_fkey",
        "highlight_pdf_anchors",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_highlights_anchor_media_id", "highlights", type_="foreignkey"
    )
    op.execute("DELETE FROM resource_versions WHERE lane<>'context'")
    for table in ("pages", "note_blocks"):
        op.drop_column(table, "last_activity_at")
    op.execute("DELETE FROM background_jobs WHERE kind='empty_resource_cleanup'")
    op.execute("DROP INDEX uix_resource_view_states_endpoint_order")
    # Equal positions are legal. Their link ids provide a deterministic tie break.
    _seed(connection)
    _publish_note_search(connection)
    op.drop_table("authored_identities")


def _batches(rows):
    batch = []
    size = 0
    for row in rows:
        row_size = len(
            _json(
                {
                    key: str(value) if isinstance(value, (UUID, date)) else value
                    for key, value in row.items()
                }
            ).encode()
        )
        if batch and (len(batch) == 100 or size + row_size > 4 * 1024 * 1024):
            yield batch
            batch, size = [], 0
        batch.append(row)
        size += row_size
    if batch:
        yield batch


def _seed(connection) -> None:
    for account in connection.scalars(sa.text("SELECT id FROM users ORDER BY id")):
        replica = str(uuid5(account, "authored:server"))
        stamp = {"lamport": "1", "replica_id": replica}
        dot = {replica: "1"}
        connection.execute(
            sa.text("INSERT INTO authored_heads(account_id,head_seq) VALUES (:a,0)"),
            {"a": account},
        )
        connection.execute(
            sa.text("INSERT INTO authored_replicas VALUES (:a,:r,1)"),
            {"a": account, "r": replica},
        )
        note_rows = connection.execute(
            sa.text(
                "SELECT id,body_pm_json,body_text FROM note_blocks WHERE user_id=:a ORDER BY id"
            ),
            {"a": account},
        ).mappings()
        for batch in _batches(note_rows):
            seeds = _helper(
                {
                    "op": "seed_many",
                    "notes": [
                        {"id": str(r["id"]), "body_pm_json": r["body_pm_json"]}
                        for r in batch
                    ],
                    "pages": [],
                }
            )["notes"]
            before = {str(row["id"]): row["body_text"] for row in batch}
            for seed in seeds:
                ref = f"note_block:{seed['id']}"
                state = {
                    "ref": ref,
                    "kind": "note",
                    "touch_vv": dot,
                    "delete_vv": {},
                    "body_state": seed["body_state"],
                }
                _insert(connection, "authored_resources", "ref", account, ref, state)
                if seed["body_text"] != before[seed["id"]]:
                    connection.execute(
                        sa.text("INSERT INTO authored_changed_note_text VALUES (:id)"),
                        {"id": UUID(seed["id"])},
                    )
                connection.execute(
                    sa.text(
                        "UPDATE note_blocks SET body_pm_json=CAST(:body AS jsonb),body_text=:words WHERE id=:id"
                    ),
                    {
                        "id": UUID(seed["id"]),
                        "body": _json(seed["body_pm_json"]),
                        "words": seed["body_text"],
                    },
                )
        page_rows = connection.execute(
            sa.text(
                "SELECT p.id,p.title,d.local_date FROM pages p "
                "LEFT JOIN daily_page_bindings d ON d.page_id=p.id "
                "WHERE p.user_id=:a ORDER BY p.id"
            ),
            {"a": account},
        ).mappings()
        for batch in _batches(page_rows):
            seeds = _helper(
                {
                    "op": "seed_many",
                    "notes": [],
                    "pages": [{"id": str(r["id"]), "title": r["title"]} for r in batch],
                }
            )["pages"]
            for row, seed in zip(batch, seeds, strict=True):
                ref = f"page:{row['id']}"
                _insert(
                    connection,
                    "authored_resources",
                    "ref",
                    account,
                    ref,
                    {
                        "ref": ref,
                        "kind": "page",
                        "touch_vv": dot,
                        "delete_vv": {},
                        "local_date": str(row["local_date"])
                        if row["local_date"]
                        else None,
                        "title_state": seed["title_state"],
                    },
                )
        _highlights(connection, account, dot, stamp)
        _passages(connection, account, stamp)
        _links(connection, account, dot, stamp)
        _stubs(connection, account, stamp)


def _publish_note_search(connection) -> None:
    """Freeze the new exact-text token; invalidate only changed text publications."""
    connection.execute(sa.text("SET LOCAL paradedb.global_mutable_segment_rows=0"))
    previous = None
    while True:
        after = "WHERE id>:p" if previous is not None else ""
        ids = list(
            connection.scalars(
                sa.text(f"SELECT id FROM note_blocks {after} ORDER BY id LIMIT 256"),
                {"p": previous},
            )
        )
        if not ids:
            break
        refs = [f"note_block:{identity}" for identity in ids]
        connection.execute(
            sa.text(
                "DELETE FROM keyword_occurrences WHERE family='note_block' AND ref=ANY(:refs)"
            ),
            {"refs": refs},
        )
        connection.execute(
            sa.text("""INSERT INTO keyword_occurrences
            (doc_key,ref,owner_ref,family,admission_key,source_revision,body)
            SELECT 'note_block:'||id::text,'note_block:'||id::text,'note_block:'||id::text,
                'note_block','note_block:'||id::text||':'||encode(digest(convert_to(body_text,'UTF8'),'sha256'),'hex'),
                NULL,body_text FROM note_blocks WHERE id=ANY(:ids) AND body_text<>''"""),
            {"ids": ids},
        )
        previous = ids[-1]
    connection.execute(
        sa.text("""INSERT INTO content_index_states
        (owner_kind,owner_id,status,status_reason,active_embedding_provider,active_embedding_model,revision)
        SELECT 'note_block',id,'pending','local_first_writing',NULL,NULL,1 FROM authored_changed_note_text
        ON CONFLICT ON CONSTRAINT uq_content_index_states_owner DO UPDATE SET
            status='pending',status_reason='local_first_writing',active_embedding_provider=NULL,
            active_embedding_model=NULL,revision=content_index_states.revision+1,updated_at=now()""")
    )
    connection.execute(
        sa.text("""UPDATE background_jobs j SET status='succeeded',result='{"status":"superseded"}',
        finished_at=now(),updated_at=now(),execution_id=NULL,claimed_by=NULL,lease_expires_at=NULL
        WHERE j.kind='note_reindex_job' AND j.status IN ('pending','failed','running')
          AND EXISTS (SELECT 1 FROM authored_changed_note_text changed WHERE changed.id::text=j.payload->>'note_block_id')""")
    )
    connection.execute(
        sa.text("""INSERT INTO background_jobs(kind,payload,max_attempts)
        SELECT 'note_reindex_job',jsonb_build_object('note_block_id',changed.id::text,
            'revision',state.revision,'reason','local_first_writing'),3
        FROM authored_changed_note_text changed JOIN content_index_states state
          ON state.owner_kind='note_block' AND state.owner_id=changed.id""")
    )
    connection.execute(
        sa.text("""INSERT INTO suggestion_inputs(id,revision)
        SELECT 'note_block:'||id::text,1 FROM authored_changed_note_text ORDER BY id
        ON CONFLICT(id) DO UPDATE SET revision=suggestion_inputs.revision+1""")
    )
    connection.execute(
        sa.text("SELECT pg_notify('nexus_background_jobs','note_reindex_job')")
    )


def _highlights(connection, account, dot, stamp) -> None:
    rows = connection.execute(
        sa.text("""SELECT h.*,f.fragment_id,f.start_offset,f.end_offset,
        p.page_number FROM highlights h
        LEFT JOIN highlight_fragment_anchors f ON f.highlight_id=h.id
        LEFT JOIN highlight_pdf_anchors p ON p.highlight_id=h.id
        WHERE h.user_id=:a ORDER BY h.id"""),
        {"a": account},
    ).mappings()
    for row in rows:
        source = f"media:{row['anchor_media_id']}"
        quote = {
            "exact": row["exact"],
            "prefix": row["prefix"],
            "suffix": row["suffix"],
        }
        if row["anchor_kind"] == "fragment_offsets" and row["fragment_id"] is not None:
            locator = {
                "type": "web_text_offsets",
                "media_id": str(row["anchor_media_id"]),
                "fragment_id": str(row["fragment_id"]),
                "start_offset": row["start_offset"],
                "end_offset": row["end_offset"],
                "media_kind": None,
                "text_quote_selector": quote,
            }
        elif (
            row["anchor_kind"] == "pdf_page_geometry" and row["page_number"] is not None
        ):
            quads = [
                {key: float(value) for key, value in q.items()}
                for q in connection.execute(
                    sa.text(
                        "SELECT x1,y1,x2,y2,x3,y3,x4,y4 FROM highlight_pdf_quads "
                        "WHERE highlight_id=:id ORDER BY quad_idx"
                    ),
                    {"id": row["id"]},
                ).mappings()
            ]
            if not quads:
                raise RuntimeError(f"0320 highlight {row['id']} has no geometry")
            locator = {
                "type": "pdf_page_geometry",
                "media_id": str(row["anchor_media_id"]),
                "page_number": row["page_number"],
                "quads": quads,
                **quote,
                "text_quote_selector": quote,
                "projection": None,
            }
        else:
            raise RuntimeError(
                f"0320 cannot convert highlight {row['id']} anchor {row['anchor_kind']}"
            )
        ref = f"highlight:{row['id']}"
        capture = {
            "publication": None,
            "locator": locator,
            "quote_exact": row["exact"],
            "prefix": row["prefix"],
            "suffix": row["suffix"],
            "passage_ref": None,
        }
        _insert(
            connection,
            "authored_resources",
            "ref",
            account,
            ref,
            {
                "kind": "highlight",
                "ref": ref,
                "touch_vv": dot,
                "delete_vv": {},
                "source_ref": source,
                "selection": {"value": capture, "stamp": stamp},
                "color": {"value": row["color"], "stamp": stamp},
            },
        )


def _passages(connection, account, stamp) -> None:
    for row in connection.execute(
        sa.text("SELECT * FROM passage_anchors WHERE user_id=:a ORDER BY id"),
        {"a": account},
    ).mappings():
        quote = row["selector"]["quote"]
        key = hashlib.sha256(
            _json(
                {
                    "exact": quote["exact"],
                    "prefix": quote.get("prefix", ""),
                    "suffix": quote.get("suffix", ""),
                }
            ).encode()
        ).hexdigest()
        if key != row["anchor_key"]:
            raise RuntimeError(
                f"0320 passage {row['id']} has an inconsistent semantic key"
            )
        source = f"{row['owner_scheme']}:{row['owner_id']}"
        hint = row["selector"].get("locator_hint")
        locator = _locator(source, quote, hint)
        state = {
            "anchor_id": str(row["id"]),
            "source_ref": source,
            "normalized_exact": quote["exact"],
            "prefix": quote.get("prefix", ""),
            "suffix": quote.get("suffix", ""),
            "capture": {
                "value": {
                    "quote_exact": quote["exact"],
                    "publication": None,
                    "locator": locator,
                },
                "stamp": stamp,
            },
        }
        connection.execute(
            sa.text(
                "INSERT INTO authored_passages(account_id,anchor_id,state,semantic_key) "
                "VALUES (:a,:id,CAST(:s AS jsonb),:key)"
            ),
            {"a": account, "id": str(row["id"]), "s": _json(state), "key": key},
        )


def _locator(source: str, quote: dict, hint: dict | None) -> dict | None:
    if hint is None:
        return None
    scheme, ident = source.split(":")
    if hint["kind"] == "text":
        locator = {
            "type": "note_block_offsets"
            if scheme == "note_block"
            else "epub_fragment_offsets"
            if hint.get("section_id")
            else "web_text_offsets",
            "start_offset": hint["start_offset"],
            "end_offset": hint["end_offset"],
            "text_quote_selector": quote,
        }
        if scheme == "note_block":
            locator.update(block_id=ident, body_version=None)
        else:
            if not hint.get("fragment_id"):
                raise RuntimeError("0320 text passage lacks fragment identity")
            locator.update(
                media_id=ident, fragment_id=hint["fragment_id"], media_kind=None
            )
            if hint.get("section_id"):
                locator["section_id"] = hint["section_id"]
        return locator
    if hint["kind"] == "pdf":
        if not hint.get("quads"):
            return {
                "type": "pdf_page",
                "media_id": ident,
                "page_number": hint["page_number"],
            }
        return {
            "type": "pdf_page_geometry",
            "media_id": ident,
            "page_number": hint["page_number"],
            "quads": [{k: float(v) for k, v in q.items()} for q in hint["quads"]],
            **quote,
            "text_quote_selector": quote,
            "projection": None,
        }
    if hint["kind"] == "time":
        return {
            "type": "transcript_time_range",
            "media_id": ident,
            "t_start_ms": hint["t_start_ms"],
            "t_end_ms": hint["t_end_ms"],
            "text_quote_selector": quote,
        }
    raise RuntimeError(f"0320 unsupported passage locator {hint!r}")


def _links(connection, account, dot, stamp) -> None:
    rows = list(
        connection.execute(
            sa.text(
                "SELECT * FROM resource_edges WHERE user_id=:a "
                "AND origin IN ('user','highlight_note','link_note') ORDER BY id"
            ),
            {"a": account},
        ).mappings()
    )
    # Frozen fractional keys generated in the seed kernel preserve each endpoint's
    # observed ordering, including the old created_at/id tie break.
    positions = {}
    position_keys = {}
    endpoints = {
        f"{r[s + '_scheme']}:{r[s + '_id']}" for r in rows for s in ("source", "target")
    }
    for endpoint in sorted(endpoints):
        scheme, ident = endpoint.split(":")
        incident = list(
            connection.scalars(
                sa.text("""SELECT e.id FROM resource_edges e
            LEFT JOIN resource_view_states v ON v.edge_id=e.id AND v.user_id=:a
              AND v.surface_scheme=:scheme AND v.surface_id=:id
            WHERE e.user_id=:a AND e.origin IN ('user','highlight_note','link_note')
              AND ((e.source_scheme=:scheme AND e.source_id=:id) OR
                   (e.target_scheme=:scheme AND e.target_id=:id))
            ORDER BY v.order_key NULLS LAST,e.created_at,e.id"""),
                {"a": account, "scheme": scheme, "id": UUID(ident)},
            )
        )
        count = len(incident)
        if count not in position_keys:
            position_keys[count] = _helper({"op": "positions", "count": count})[
                "positions"
            ]
        keys = position_keys[count]
        for identity, key in zip(incident, keys, strict=True):
            positions[(endpoint, str(identity))] = {"value": key, "stamp": stamp}
    for row in rows:
        a, b = sorted(
            (
                f"{row['source_scheme']}:{row['source_id']}",
                f"{row['target_scheme']}:{row['target_id']}",
            )
        )
        for endpoint in (a, b):
            scheme, identity = endpoint.split(":")
            if scheme in ("note_block", "page", "highlight"):
                if (
                    connection.scalar(
                        sa.text(
                            "SELECT 1 FROM authored_resources WHERE account_id=:a AND ref=:r"
                        ),
                        {"a": account, "r": endpoint},
                    )
                    is None
                ):
                    raise RuntimeError(
                        f"0320 link {row['id']} has unresolved authored endpoint {endpoint}"
                    )
            elif scheme == "passage_anchor":
                if (
                    connection.scalar(
                        sa.text(
                            "SELECT 1 FROM authored_passages WHERE account_id=:a AND anchor_id=:id"
                        ),
                        {"a": account, "id": identity},
                    )
                    is None
                ):
                    raise RuntimeError(
                        f"0320 link {row['id']} has unresolved passage endpoint {endpoint}"
                    )
        identity = str(row["id"])
        _insert(
            connection,
            "authored_links",
            "link_id",
            account,
            identity,
            {
                "link_id": identity,
                "endpoint_a": a,
                "endpoint_b": b,
                "add_vv": dot,
                "remove_vv": {},
                "position_a": positions[(a, identity)],
                "position_b": positions[(b, identity)],
            },
        )
        for endpoint in (a, b):
            scheme, ident = endpoint.split(":")
            connection.execute(
                sa.text(
                    "INSERT INTO resource_view_states(user_id,surface_scheme,surface_id,edge_id,order_key) "
                    "VALUES (:a,:s,:id,:edge,:key) ON CONFLICT "
                    "(user_id,surface_scheme,surface_id,edge_id) WHERE edge_id IS NOT NULL "
                    "DO UPDATE SET order_key=excluded.order_key"
                ),
                {
                    "a": account,
                    "s": scheme,
                    "id": UUID(ident),
                    "edge": row["id"],
                    "key": positions[(endpoint, identity)]["value"],
                },
            )


def _stubs(connection, account, stamp) -> None:
    refs = connection.scalars(
        sa.text("""SELECT DISTINCT ref FROM (
        SELECT state->>'endpoint_a' ref FROM authored_links WHERE account_id=:a UNION
        SELECT state->>'endpoint_b' FROM authored_links WHERE account_id=:a UNION
        SELECT state->>'source_ref' FROM authored_passages WHERE account_id=:a UNION
        SELECT state->>'source_ref' FROM authored_resources WHERE account_id=:a AND state->>'kind'='highlight' UNION
        SELECT item->'attrs'->>'resource_ref' FROM note_blocks n
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(n.body_pm_json->'content','[]'::jsonb)) item
        WHERE n.user_id=:a AND item->>'type'='resource_embed'
        ) sources WHERE ref IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM authored_resources r WHERE r.account_id=:a AND r.ref=sources.ref)"""),
        {"a": account},
    )
    for ref in refs:
        scheme, identity = ref.split(":")
        label = None
        if scheme == "passage_anchor":
            label = connection.scalar(
                sa.text(
                    "SELECT state #>> '{capture,value,quote_exact}' FROM authored_passages "
                    "WHERE account_id=:a AND anchor_id=:id"
                ),
                {"a": account, "id": identity},
            )
        # Frozen, exact sufficient admission paths only. A lingering reference is
        # never itself permission to read newly private source metadata.
        labels = {
            "media": """SELECT m.title FROM media m WHERE m.id=:id
                AND EXISTS (SELECT 1 FROM library_entries le JOIN memberships member
                    ON member.library_id=le.library_id AND member.user_id=:a WHERE le.media_id=m.id)
                AND NOT EXISTS (SELECT 1 FROM user_media_deletions d WHERE d.media_id=m.id AND d.user_id=:a)
                AND NOT EXISTS (SELECT 1 FROM media_teardown_intents t WHERE t.media_id=m.id)""",
            "conversation": "SELECT title FROM conversations WHERE id=:id AND owner_user_id=:a",
            "library": """SELECT l.name FROM libraries l WHERE l.id=:id AND
                EXISTS (SELECT 1 FROM memberships m WHERE m.library_id=l.id AND m.user_id=:a)""",
            "podcast": """SELECT p.title FROM podcasts p WHERE p.id=:id AND EXISTS (
                SELECT 1 FROM library_podcast_subscriptions ps JOIN libraries l ON l.id=ps.library_id
                JOIN memberships m ON m.library_id=l.id AND m.user_id=:a
                WHERE ps.podcast_id=p.id AND l.system_key IS NULL)""",
            "contributor": """SELECT c.display_name FROM contributors c WHERE c.id=:id AND EXISTS (
                SELECT 1 FROM resource_edges e WHERE e.user_id=:a AND
                ((e.source_scheme='contributor' AND e.source_id=c.id) OR
                 (e.target_scheme='contributor' AND e.target_id=c.id)))""",
            "external_snapshot": "SELECT title FROM resource_external_snapshots WHERE id=:id AND user_id=:a",
        }
        if not label and scheme in labels:
            label = connection.scalar(
                sa.text(labels[scheme]), {"a": account, "id": UUID(identity)}
            )
        if not label:
            label = connection.scalar(
                sa.text(
                    "SELECT item->'attrs'->>'label' FROM note_blocks n "
                    "CROSS JOIN LATERAL jsonb_array_elements(COALESCE(n.body_pm_json->'content','[]'::jsonb)) item "
                    "WHERE n.user_id=:a AND item->>'type'='resource_embed' "
                    "AND item->'attrs'->>'resource_ref'=:ref AND item->'attrs'->>'label' IS NOT NULL "
                    "ORDER BY n.id LIMIT 1"
                ),
                {"a": account, "ref": ref},
            )
        _insert(
            connection,
            "authored_source_stubs",
            "source_ref",
            account,
            ref,
            {
                "source_ref": ref,
                "capture": {
                    "value": {
                        "kind": scheme,
                        "label": label or ref,
                        "publication": None,
                    },
                    "stamp": stamp,
                },
            },
        )


def downgrade() -> None:
    raise NotImplementedError(
        "0320 is irreversible; restore the drained pre-release backup"
    )
