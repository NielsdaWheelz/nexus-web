"""Read-only identity census for the destructive 0246 history cutover.

This compares database facts only. A matching census does not authorize the
cutover: process drain, grant revocation, effect review, and a verified backup
need independent evidence. Migration 0246 remains the final fail-closed gate.
"""

import argparse
import hashlib
import json
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.engine import Connection

from nexus.db.engine import get_engine


def _rows(connection: Connection, query: str) -> list[dict[str, object]]:
    rows = [dict(row) for row in connection.execute(text(query)).mappings()]
    for row in rows:
        if "evidence" in row:
            row["evidence_sha256"] = hashlib.sha256(
                json.dumps(row.pop("evidence"), sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
    return rows


def _census(connection: Connection) -> dict[str, object]:
    revisions = _rows(connection, "SELECT version_num FROM alembic_version")
    if len(revisions) != 1:
        raise ValueError("expected exactly one database revision")

    calls = _rows(
        connection,
        """
        SELECT c.id::text, c.owner_kind, c.owner_id::text, c.generation_seq,
               c.generation_fingerprint, to_jsonb(c) AS evidence
        FROM llm_calls AS c WHERE c.outcome IS NULL ORDER BY c.id
        """,
    )
    turns = _rows(
        connection,
        """
        SELECT t.id::text, t.generation_id::text, t.turn_seq,
               t.request_fingerprint, t.dispatch_started_at IS NOT NULL AS dispatched,
               t.accepted_at IS NOT NULL AS accepted,
               t.terminal IS NOT NULL AS terminal_recorded, to_jsonb(t) AS evidence
        FROM llm_model_turns AS t
        JOIN llm_calls AS c ON c.id = t.generation_id
        WHERE c.outcome IS NULL ORDER BY t.generation_id, t.turn_seq
        """,
    )
    continuations = _rows(
        connection,
        """
        SELECT k.id::text, k.generation_id::text, k.source_model_turn_id::text,
               k.successor_turn_seq, k.target_fingerprint, to_jsonb(k) AS evidence
        FROM llm_model_turn_continuations AS k
        JOIN llm_calls AS c ON c.id = k.generation_id
        WHERE c.outcome IS NULL ORDER BY k.generation_id, k.successor_turn_seq
        """,
    )
    positions = _rows(
        connection,
        """
        SELECT p.id::text, p.generation_id::text, p.position,
               p.canonical_tool_id, p.canonical_input_digest, to_jsonb(p) AS evidence
        FROM llm_tool_positions AS p
        JOIN llm_calls AS c ON c.id = p.generation_id
        WHERE c.outcome IS NULL ORDER BY p.generation_id, p.position
        """,
    )
    runs = _rows(
        connection,
        """
        SELECT r.id::text, r.status, to_jsonb(r) AS evidence FROM chat_runs AS r
        WHERE r.status NOT IN ('complete', 'error', 'cancelled') ORDER BY r.id
        """,
    )
    jobs = _rows(
        connection,
        """
        SELECT j.id::text, j.kind, j.status, j.attempts,
               j.payload->>'run_id' AS run_id, j.payload->>'media_id' AS media_id,
               to_jsonb(j) AS evidence
        FROM background_jobs AS j
        WHERE j.kind = 'chat_run'
           OR (j.status <> 'succeeded' AND j.payload ? 'generation_admissions')
        ORDER BY j.id
        """,
    )
    return {
        "schema_revision": revisions[0]["version_num"],
        "unsettled_calls": calls,
        "unsettled_turns": turns,
        "unsettled_continuations": continuations,
        "unsettled_tool_positions": positions,
        "nonterminal_chat_runs": runs,
        "affected_jobs": jobs,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument(
        "--snapshot", action="store_true", help="print current database identities"
    )
    actions.add_argument("--expect", type=Path, help="compare with a reviewed snapshot")
    args = parser.parse_args()

    with get_engine().connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        with connection.begin():
            connection.execute(text("SET TRANSACTION READ ONLY"))
            actual = _census(connection)

    if args.snapshot:
        print(json.dumps(actual, indent=2, sort_keys=True))
        return
    expected = json.loads(args.expect.read_text())
    if expected != actual:
        raise SystemExit("model cutover identities changed; review a fresh census")
    print("model cutover database identities match; external release evidence remains required")


if __name__ == "__main__":
    main()
