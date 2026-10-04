"""Read-only full census for the reviewed 0246 application reset.

--snapshot prints facts, not disposal authority. The release owner supplies the
reviewer, exact disposition and backup/actual-restore binding separately.
"""

import argparse
from pathlib import Path

from sqlalchemy import text

from nexus.db.engine import get_engine
from nexus.model_cutover_archive import ReviewedModelCutover, model_cutover_snapshot


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument(
        "--snapshot", action="store_true", help="print complete current database facts"
    )
    actions.add_argument("--expect", type=Path, help="compare with a reviewed reset input")
    args = parser.parse_args()
    with get_engine().connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        with connection.begin():
            connection.execute(text("SET TRANSACTION READ ONLY"))
            connection.execute(text("SET LOCAL TIME ZONE 'UTC'"))
            actual = model_cutover_snapshot(connection)
    if args.snapshot:
        print(actual.model_dump_json(indent=2))
        return
    reviewed = ReviewedModelCutover.model_validate_json(args.expect.read_bytes())
    if (
        actual.database_identity != reviewed.source_database_identity
        or actual.starting_revision != reviewed.starting_revision
        or actual.census != reviewed.census
    ):
        raise SystemExit("model cutover facts changed; review a fresh complete census")
    print(
        "model cutover complete census matches; stopped writers and verified archive remain release-owned"
    )


if __name__ == "__main__":
    main()
