#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys

from tests.reader_apparatus_corpus import MANIFEST_PATH, load_reader_apparatus_manifest
from tests.reader_apparatus_frontend_payloads import (
    FRONTEND_PAYLOAD_INDEX_PATH,
    build_frontend_payload_index,
    frontend_payload_artifacts,
    frontend_payload_manifest_entries,
    frontend_surface_contract_entries,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate committed frontend reader-apparatus payload fixtures."
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Write payload JSON, generated TypeScript index, and manifest metadata.",
    )
    args = parser.parse_args()

    artifacts = frontend_payload_artifacts()
    expected_index = build_frontend_payload_index(artifacts)
    expected_manifest = _manifest_with_frontend_payloads(artifacts)
    stale: list[str] = []

    for artifact in artifacts:
        if not artifact.path.exists() or artifact.path.read_bytes() != artifact.payload_bytes:
            stale.append(str(artifact.path))
            if args.write:
                artifact.path.parent.mkdir(parents=True, exist_ok=True)
                artifact.path.write_bytes(artifact.payload_bytes)

    if (
        not FRONTEND_PAYLOAD_INDEX_PATH.exists()
        or FRONTEND_PAYLOAD_INDEX_PATH.read_text(encoding="utf-8") != expected_index
    ):
        stale.append(str(FRONTEND_PAYLOAD_INDEX_PATH))
        if args.write:
            FRONTEND_PAYLOAD_INDEX_PATH.write_text(expected_index, encoding="utf-8")

    current_manifest = MANIFEST_PATH.read_text(encoding="utf-8")
    if current_manifest != expected_manifest:
        stale.append(str(MANIFEST_PATH))
        if args.write:
            MANIFEST_PATH.write_text(expected_manifest, encoding="utf-8")

    if stale and not args.write:
        print("Reader apparatus frontend payload fixtures are stale:", file=sys.stderr)
        for path in stale:
            print(f"  {path}", file=sys.stderr)
        print(
            "Run: uv run --directory python python scripts/generate_reader_apparatus_frontend_payloads.py --write",
            file=sys.stderr,
        )
        return 1

    if stale:
        print(f"Updated {len(stale)} reader apparatus frontend fixture artifacts.")
    else:
        print("Reader apparatus frontend payload fixtures are up to date.")
    return 0


def _manifest_with_frontend_payloads(artifacts) -> str:
    manifest = load_reader_apparatus_manifest()
    manifest["frontend_api_payload_fixtures"] = frontend_payload_manifest_entries(artifacts)
    manifest["frontend_surface_contract_schema_version"] = 3
    manifest["frontend_surface_contracts"] = frontend_surface_contract_entries(artifacts)
    return json.dumps(manifest, indent=4) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
