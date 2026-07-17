"""Deploy-config drift gate for the R2 direct-upload staging lifecycle rule.

The one-day R2 lifecycle on ``uploads/`` is a load-bearing durable backstop for
browser direct uploads whose PUT lands after the signed URL expires (spec §3.1).
This gate fails if the deployed lifecycle rule's prefix drifts from the staging
prefix that :mod:`nexus.storage.paths` actually writes, if the 24h max-age drifts,
or if the apply script stops pointing at the checked-in rule file.
"""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from nexus.storage.paths import build_upload_staging_storage_path

pytestmark = pytest.mark.unit

# python/tests/ -> python/ -> repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_LIFECYCLE_JSON = _REPO_ROOT / "deploy" / "cloudflare" / "r2-lifecycle.example.json"
_APPLY_SCRIPT = _REPO_ROOT / "deploy" / "cloudflare" / "apply-r2-lifecycle.sh"

# The direct-upload staging TTL: 24h in seconds. Mirrors the migration backfill and
# storage_orphan_sweep_min_age default (spec §3.1).
_EXPECTED_MAX_AGE_SECONDS = 86400
_EXPECTED_STAGING_PREFIX = "uploads/"


def _staging_rule() -> dict:
    document = json.loads(_LIFECYCLE_JSON.read_text(encoding="utf-8"))
    rules = document["rules"]
    staging_rules = [
        rule
        for rule in rules
        if rule.get("conditions", {}).get("prefix") == _EXPECTED_STAGING_PREFIX
    ]
    assert len(staging_rules) == 1, (
        f"expected exactly one rule with prefix {_EXPECTED_STAGING_PREFIX!r}; got {rules}"
    )
    return staging_rules[0]


def test_lifecycle_prefix_matches_staging_path_builder():
    rule = _staging_rule()
    prefix = rule["conditions"]["prefix"]
    staging_path = build_upload_staging_storage_path(uuid4(), "pdf")
    assert prefix == _EXPECTED_STAGING_PREFIX, (
        f"lifecycle rule prefix {prefix!r} must equal the staging prefix "
        f"{_EXPECTED_STAGING_PREFIX!r}"
    )
    assert staging_path.startswith(prefix), (
        f"staging path {staging_path!r} does not start with the lifecycle prefix {prefix!r}; "
        "the R2 lifecycle would not cover direct-upload staging objects"
    )


def test_lifecycle_max_age_is_one_day():
    rule = _staging_rule()
    delete_max_age = rule["deleteObjectsTransition"]["condition"]["maxAge"]
    abort_max_age = rule["abortMultipartUploadsTransition"]["condition"]["maxAge"]
    assert delete_max_age == _EXPECTED_MAX_AGE_SECONDS, (
        f"delete maxAge {delete_max_age} must be {_EXPECTED_MAX_AGE_SECONDS} (24h)"
    )
    assert abort_max_age == _EXPECTED_MAX_AGE_SECONDS, (
        f"abort maxAge {abort_max_age} must be {_EXPECTED_MAX_AGE_SECONDS} (24h)"
    )


def test_apply_script_references_lifecycle_file():
    script = _APPLY_SCRIPT.read_text(encoding="utf-8")
    assert _LIFECYCLE_JSON.name in script, (
        f"{_APPLY_SCRIPT.name} must reference {_LIFECYCLE_JSON.name} so deploys apply the "
        "checked-in lifecycle rule"
    )
