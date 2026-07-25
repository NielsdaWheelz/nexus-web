"""Read-only capacity review for Consumption Activity's append-only facts."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.db.session import get_session_factory

ACTIVITY_SPAN_REVIEW_THRESHOLD = 500_000
ACTIVITY_REPLAY_REVIEW_THRESHOLD = 100_000


@dataclass(frozen=True, slots=True)
class ConsumptionActivityCounts:
    """Global fact and replay-ledger cardinalities for an operator review."""

    activity_spans: int
    completion_facts: int
    activity_replays: int


def read_global_counts(db: Session) -> ConsumptionActivityCounts:
    """Read the three global counts without mutating data or applying a policy."""
    row = (
        db.execute(
            text(
                """
            SELECT
                (SELECT count(*) FROM consumption_activity_spans) AS activity_spans,
                (SELECT count(*) FROM consumption_completion_facts) AS completion_facts,
                (
                    SELECT count(*)
                    FROM resource_mutations
                    WHERE mutation_scope = 'Consumption.Activity'
                ) AS activity_replays
            """
            )
        )
        .mappings()
        .one()
    )
    return ConsumptionActivityCounts(
        activity_spans=int(row["activity_spans"]),
        completion_facts=int(row["completion_facts"]),
        activity_replays=int(row["activity_replays"]),
    )


def report_payload(counts: ConsumptionActivityCounts) -> dict[str, object]:
    """Serialize the review report; thresholds are deliberately advisory only."""
    values = asdict(counts)
    return {
        "counts": values,
        "review_thresholds": {
            "activity_spans": ACTIVITY_SPAN_REVIEW_THRESHOLD,
            "activity_replays": ACTIVITY_REPLAY_REVIEW_THRESHOLD,
        },
        "review_recommended": {
            "activity_spans": counts.activity_spans >= ACTIVITY_SPAN_REVIEW_THRESHOLD,
            "activity_replays": counts.activity_replays >= ACTIVITY_REPLAY_REVIEW_THRESHOLD,
        },
    }


def main() -> None:
    """Print counts and succeed regardless of advisory threshold state."""
    db = get_session_factory()()
    try:
        print(json.dumps(report_payload(read_global_counts(db)), sort_keys=True))
    except SQLAlchemyError as exc:
        print(f"consumption activity count query failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    finally:
        db.close()


if __name__ == "__main__":
    main()
