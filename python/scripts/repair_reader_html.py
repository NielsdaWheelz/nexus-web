"""Apply one reviewed HTML shape repair through the ordinary reader publication owner.

Run in the maintenance environment after release preflights. The JSON input maps
EVERY fragment UUID to its reviewed original HTML sha256; no discovery or replay.
"""

import argparse
import json
from pathlib import Path
from uuid import UUID

from nexus.db.engine import bind_database_role
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.services.reader_publication import repair_reader_html


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--media-id", type=UUID, required=True)
    parser.add_argument("--expected-generation", type=int, required=True)
    parser.add_argument("--fragment-sha256", type=Path, required=True)
    args = parser.parse_args()
    raw = json.loads(args.fragment_sha256.read_text())
    if (
        not isinstance(raw, dict)
        or not raw
        or any(
            not isinstance(value, str)
            or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)
            for value in raw.values()
        )
    ):
        parser.error("fragment-sha256 must map fragment UUIDs to lowercase sha256 values")
    expected = {UUID(key): value for key, value in raw.items()}
    bind_database_role("maintenance")
    with get_session_factory()() as db:
        generation = retry_serializable(
            db,
            "reader.repair_html",
            lambda: repair_reader_html(
                db,
                media_id=args.media_id,
                expected_generation=args.expected_generation,
                fragment_sha256=expected,
            ),
        )
    print(json.dumps({"media_id": str(args.media_id), "generation": generation}))


if __name__ == "__main__":
    main()
