"""Read-only capacity review for Consumption Activity's append-only facts."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from time import perf_counter

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
    activity_adjustments: int
    completion_facts: int
    activity_replays: int
    accepted_spans: int
    deduplicated_spans: int
    capture_key_duplicates: int
    capture_key_conflicts: int
    query_latency_ms: int


def read_global_counts(db: Session) -> ConsumptionActivityCounts:
    """Read global ledger and replay counts without mutating product data."""
    started = perf_counter()
    row = (
        db.execute(
            text(
                """
            SELECT
                (SELECT count(*) FROM consumption_activity_spans) AS activity_spans,
                (SELECT count(*) FROM consumption_activity_adjustments)
                    AS activity_adjustments,
                (SELECT count(*) FROM consumption_completion_facts) AS completion_facts,
                (
                    SELECT count(*)
                    FROM resource_mutations
                    WHERE mutation_scope = 'Consumption.Activity'
                ) AS activity_replays,
                (
                    SELECT coalesce(sum((response_json ->> 'acceptedCount')::bigint), 0)
                    FROM resource_mutations
                    WHERE mutation_scope = 'Consumption.Activity'
                ) AS accepted_spans,
                (
                    SELECT coalesce(sum((response_json ->> 'deduplicatedCount')::bigint), 0)
                    FROM resource_mutations
                    WHERE mutation_scope = 'Consumption.Activity'
                ) AS deduplicated_spans,
                (
                    SELECT count(*) - count(DISTINCT (user_id, capture_key))
                    FROM consumption_activity_spans
                ) AS capture_key_duplicates,
                (
                    SELECT coalesce(sum(conflicting.duplicate_count - 1), 0)
                    FROM (
                        SELECT count(*) AS duplicate_count
                        FROM consumption_activity_spans
                        GROUP BY user_id, capture_key
                        HAVING count(DISTINCT jsonb_build_object(
                            'mediaId', media_id,
                            'modality', modality,
                            'deviceId', device_id,
                            'deviceClass', device_class,
                            'occurredAt', occurred_at,
                            'durationMs', duration_ms,
                            'progressStart', progress_start,
                            'progressEnd', progress_end,
                            'wordStart', word_start,
                            'wordEnd', word_end,
                            'mediaPositionStartMs', media_position_start_ms,
                            'mediaPositionEndMs', media_position_end_ms
                        )) > 1
                    ) conflicting
                ) AS capture_key_conflicts
            """
            )
        )
        .mappings()
        .one()
    )
    return ConsumptionActivityCounts(
        activity_spans=int(row["activity_spans"]),
        activity_adjustments=int(row["activity_adjustments"]),
        completion_facts=int(row["completion_facts"]),
        activity_replays=int(row["activity_replays"]),
        accepted_spans=int(row["accepted_spans"]),
        deduplicated_spans=int(row["deduplicated_spans"]),
        capture_key_duplicates=int(row["capture_key_duplicates"]),
        capture_key_conflicts=int(row["capture_key_conflicts"]),
        query_latency_ms=max(0, int((perf_counter() - started) * 1000)),
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
