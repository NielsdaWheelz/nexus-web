"""Freeze saved excerpt words without reconstructing historical source structure.

After actual head 0325, stopped writers are required. Convert only canonical
highlight/passage captures and the three listed historical evidence paths; retain
ids, stamps, vectors, metadata, accepted source prefixes and feed rows unchanged.
Add bounded preview projections and fence old opaque feed receipts at account head.
The sibling frozen kernel owns canonical JSON, unicode and numeric spelling.
Unsupported shapes or oversized converted captures abort the transaction.
"""

import json
import subprocess
import unicodedata
from pathlib import Path
from shutil import which

import sqlalchemy as sa
from alembic import op

revision = "0326"
down_revision = "0325"
branch_labels = None
depends_on = None


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _plain(exact: str, prefix: str | None, suffix: str | None, plain: bool) -> dict:
    if (
        not isinstance(exact, str)
        or not isinstance(prefix, str | None)
        or not isinstance(suffix, str | None)
    ):
        raise RuntimeError("0326 unsupported saved quote strings")
    before, after = prefix or "", suffix or ""
    return {
        "structure": "plain" if plain else "unknown",
        "lang": None,
        "dir": None,
        "content": [{"kind": "text", "text": before + exact + after}],
        "selection": {
            "start": {"path": [0], "offset": len(before)},
            "end": {"path": [0], "offset": len(before) + len(exact)},
        },
        "source_extent": None,
        "truncated_before": None,
        "truncated_after": None,
    }


def _is_plain(locator: dict | None, source: dict | None = None) -> bool:
    kind = (locator or {}).get("type")
    if kind not in (
        None,
        "x_capture_offsets",
        "web_text_offsets",
        "epub_fragment_offsets",
        "note_block_offsets",
        "pdf_page_geometry",
        "pdf_page",
        "transcript_time_range",
        "audio_time_range",
        "video_time_range",
        "message_offsets",
        "external_url",
    ):
        raise RuntimeError(f"0326 unsupported saved locator {kind}")
    return (
        kind
        in (
            "pdf_page",
            "pdf_page_geometry",
            "note_block_offsets",
            "message_offsets",
        )
        or (source or {}).get("media_kind") == "pdf"
    )


def _check(value: dict, identity: str) -> None:
    if len(_json(value).encode()) > 2 * 1024 * 1024:
        raise RuntimeError(
            f"0326 {identity} exceeds the 2 MiB converted capture budget"
        )


def _project(items: list[dict]) -> list[dict]:
    node = which("node")
    if node is None:
        raise RuntimeError("0326 requires the paired node runtime")
    result = subprocess.run(
        [
            node,
            "--max-old-space-size=128",
            str(Path(__file__).with_name("0326_excerpt_projection.mjs")),
        ],
        input=_json({"op": "project_excerpts", "items": items}),
        text=True,
        capture_output=True,
        timeout=30,
        check=True,
        env={"NODE_ENV": "production", "PATH": "/usr/local/bin:/usr/bin:/bin"},
    )
    return json.loads(result.stdout)["items"]


def _normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


def _evidence(value: dict, identity: str) -> dict:
    if set(value) != {"quote", "source", "target"}:
        raise RuntimeError(f"0326 unsupported evidence {identity}")
    quote = value["quote"]
    if quote is not None:
        if set(quote) != {"exact", "prefix", "suffix", "color"}:
            raise RuntimeError(f"0326 unsupported historical quote {identity}")
        quote["excerpt"] = _plain(
            quote["exact"],
            quote["prefix"],
            quote["suffix"],
            _is_plain(value["target"].get("locator"), value["source"]),
        )
        _check(value, identity)
    return value


def upgrade() -> None:
    connection = op.get_bind()
    op.execute("ALTER TABLE highlights ADD COLUMN excerpt_preview jsonb")
    op.execute("ALTER TABLE passage_anchors ADD COLUMN excerpt_preview jsonb")
    previews = []
    for row in connection.execute(
        sa.text(
            "SELECT account_id,ref,state FROM authored_resources WHERE state->>'kind'='highlight' ORDER BY account_id,ref"
        )
    ).mappings():
        state = row["state"]
        capture = state["selection"]["value"]
        if set(capture) != {
            "publication",
            "locator",
            "quote_exact",
            "prefix",
            "suffix",
            "passage_ref",
        }:
            raise RuntimeError(f"0326 unsupported selection {row['ref']}")
        capture["excerpt"] = _plain(
            capture["quote_exact"],
            capture["prefix"],
            capture["suffix"],
            _is_plain(capture["locator"]),
        )
        _check(
            {
                "command_seq": "9223372036854775807",
                "lamport": "9223372036854775807",
                "resources": [state],
                "links": [],
                "passages": [],
                "source_stubs": [],
            },
            row["ref"],
        )
        previews.append(
            (
                row["account_id"],
                row["ref"],
                {
                    "source_ref": state["source_ref"],
                    "capture": {"kind": "selection", "value": capture},
                    "mode": "compact",
                    "scope": {"kind": "capture"},
                },
            )
        )
        connection.execute(
            sa.text(
                "UPDATE authored_resources SET state=CAST(:state AS jsonb) WHERE account_id=:account AND ref=:ref"
            ),
            {"state": _json(state), "account": row["account_id"], "ref": row["ref"]},
        )
    for row in connection.execute(
        sa.text(
            "SELECT p.account_id,p.anchor_id,p.state,a.selector,a.owner_scheme,a.owner_id FROM authored_passages p LEFT JOIN passage_anchors a ON a.user_id=p.account_id AND a.id::text=p.anchor_id ORDER BY p.account_id,p.anchor_id"
        )
    ).mappings():
        state, selector = row["state"], row["selector"]
        capture = state["capture"]["value"]
        if set(capture) != {"quote_exact", "publication", "locator"}:
            raise RuntimeError(f"0326 unsupported passage {row['anchor_id']}")
        if selector is None:
            raise RuntimeError(f"0326 passage projection missing {row['anchor_id']}")
        quote = selector["quote"]
        affixes = (
            state["source_ref"] == f"{row['owner_scheme']}:{row['owner_id']}"
            and quote["exact"] == capture["quote_exact"]
            and _normalize(quote["exact"]) == state["normalized_exact"]
            and _normalize(quote.get("prefix") or "") == state["prefix"]
            and _normalize(quote.get("suffix") or "") == state["suffix"]
        )
        prefix, suffix = (
            (quote.get("prefix"), quote.get("suffix")) if affixes else (None, None)
        )
        capture["excerpt"] = _plain(
            capture["quote_exact"],
            prefix,
            suffix,
            _is_plain(capture["locator"])
            or (selector.get("locator_hint") or {}).get("kind") == "pdf",
        )
        _check(
            {
                "command_seq": "9223372036854775807",
                "lamport": "9223372036854775807",
                "resources": [],
                "links": [],
                "passages": [state],
                "source_stubs": [],
            },
            row["anchor_id"],
        )
        previews.append(
            (
                row["account_id"],
                "passage_anchor:" + row["anchor_id"],
                {
                    "source_ref": state["source_ref"],
                    "capture": {"kind": "passage", "value": capture},
                    "mode": "compact",
                    "scope": {"kind": "capture"},
                },
            )
        )
        connection.execute(
            sa.text(
                "UPDATE authored_passages SET state=CAST(:state AS jsonb) WHERE account_id=:account AND anchor_id=:anchor"
            ),
            {
                "state": _json(state),
                "account": row["account_id"],
                "anchor": row["anchor_id"],
            },
        )
    batch = []
    batch_size = 64

    def flush() -> None:
        for (account, ref, _), projection in zip(
            batch, _project([item[2] for item in batch]), strict=True
        ):
            table = "highlights" if ref.startswith("highlight:") else "passage_anchors"
            identity = ref.split(":", 1)[1]
            changed = connection.execute(
                sa.text(
                    f"UPDATE {table} SET excerpt_preview=CAST(:preview AS jsonb) WHERE user_id=:account AND id::text=:identity"
                ),
                {
                    "preview": _json(
                        {
                            "excerpt": projection["view"],
                            "capture_revision": projection["capture_revision"],
                        }
                    ),
                    "account": account,
                    "identity": identity,
                },
            )
            if changed.rowcount != 1:
                raise RuntimeError(f"0326 projection owner mismatch {ref}")

    for entry in previews:
        size = len(_json(entry[2]).encode())
        if batch and batch_size + size > 10 * 1024 * 1024:
            flush()
            batch, batch_size = [], 64
        batch.append(entry)
        batch_size += size + 1
    if batch:
        flush()
    for table, column, nested, predicate in (
        (
            "messages",
            "reader_selection_snapshot",
            True,
            "reader_selection_snapshot IS NOT NULL",
        ),
        (
            "message_retrievals",
            "captured_evidence",
            False,
            "captured_evidence IS NOT NULL",
        ),
        (
            "resource_edges",
            "snapshot",
            True,
            "origin='citation' AND snapshot IS NOT NULL AND snapshot->'evidence' IS NOT NULL AND snapshot->'evidence'<>'null'::jsonb",
        ),
    ):
        for row in connection.execute(
            sa.text(
                f"SELECT id,{column} AS value FROM {table} WHERE {predicate} ORDER BY id"
            )
        ).mappings():
            value = row["value"]
            if nested:
                value["evidence"] = _evidence(value["evidence"], f"{table}:{row['id']}")
            else:
                value = _evidence(value, f"{table}:{row['id']}")
            connection.execute(
                sa.text(
                    f"UPDATE {table} SET {column}=CAST(:value AS jsonb) WHERE id=:id"
                ),
                {"id": row["id"], "value": _json(value)},
            )
    op.execute("ALTER TABLE highlights ALTER COLUMN excerpt_preview SET NOT NULL")
    op.execute("ALTER TABLE passage_anchors ALTER COLUMN excerpt_preview SET NOT NULL")
    op.execute("UPDATE authored_heads SET snapshot_floor_seq=head_seq")
    op.execute(
        "UPDATE authored_replicas SET format_revision=3 WHERE format_revision IN (1,2)"
    )
    op.execute(
        "ALTER TABLE authored_replicas ALTER COLUMN format_revision SET DEFAULT 3"
    )


def downgrade() -> None:
    raise RuntimeError("0326 requires restoring the paired database and device backups")
