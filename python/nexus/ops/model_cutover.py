"""Apply the reviewed model-history reset through the production migration boundary.

python -m nexus.ops.model_cutover < reviewed.json
"""

import argparse
import sys
from pathlib import Path

from alembic import command
from alembic.config import Config

from nexus.model_cutover_archive import ModelCutoverAuthority, ReviewedModelCutover
from nexus.release_artifact import load_runtime_identity


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    reviewed = ReviewedModelCutover.model_validate_json(sys.stdin.buffer.read())
    runtime = load_runtime_identity(Path("/app/runtime-identity.json"))
    if (
        runtime.source_sha != reviewed.target_source_sha
        or runtime.expected_database_revision != reviewed.restore.target_revision
    ):
        raise ValueError("model cutover restore proof names different installed target bytes")
    config = Config("/app/migrations/alembic.ini")
    config.set_main_option("script_location", "/app/migrations/alembic")
    config.attributes["model_cutover_authority"] = ModelCutoverAuthority(
        reviewed=reviewed,
        execution_database_identity=reviewed.source_database_identity,
    )
    command.upgrade(config, "head")


if __name__ == "__main__":
    main()
