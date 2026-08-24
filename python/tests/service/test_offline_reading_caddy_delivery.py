from __future__ import annotations

import json
import os
from pathlib import Path

import httpx

from nexus_test_control.services import (
    offline_reading_caddy_ports,
    start_caddy_process,
    start_offline_reading_caddy_origin_process,
    wait_offline_reading_caddy_ready,
)
from tests.testkit.offline_reading_caddy_origin import (
    ACCOUNT_ID,
    FALLBACK_TEXT,
    PACKAGE_BYTES,
    PACKAGE_DIGEST,
)

REPO_ROOT = Path(__file__).parents[3]
TEST_ENV = {"NEXUS_ENV": "test"}
MEDIA_ID = "11111111-1111-4111-8111-111111111111"


def test_production_caddy_proxy_preserves_exact_package_identity_bytes_without_encoding() -> None:
    run_id = os.environ["NEXUS_TEST_RUN_ID"]
    origin = start_offline_reading_caddy_origin_process(REPO_ROOT, os.environ, run_id)
    wait_offline_reading_caddy_ready(REPO_ROOT, TEST_ENV, origin, "/readyz")
    caddy = start_caddy_process(REPO_ROOT, os.environ, run_id)
    wait_offline_reading_caddy_ready(REPO_ROOT, TEST_ENV, caddy, "/readyz")

    ports = offline_reading_caddy_ports(REPO_ROOT, TEST_ENV, run_id)
    package_path = f"/offline-reading/packages/{MEDIA_ID}"
    with httpx.Client(
        base_url=f"http://127.0.0.1:{ports.site}",
        headers={"Accept-Encoding": "gzip", "Authorization": "Bearer package-proof"},
        timeout=5,
        trust_env=False,
    ) as client:
        package = client.get(package_path)
        fallback = client.get(package_path + "/extra")

    assert package.status_code == 200
    assert package.content == PACKAGE_BYTES
    assert package.headers["content-type"] == "application/vnd.nexus.offline-reading+zip"
    assert package.headers["content-length"] == str(len(PACKAGE_BYTES))
    assert package.headers["content-digest"] == PACKAGE_DIGEST
    assert package.headers["nexus-account-id"] == ACCOUNT_ID
    assert package.headers["nexus-reader-generation"] == "7"
    assert "content-encoding" not in package.headers

    assert fallback.status_code == 200
    assert fallback.content.decode() == FALLBACK_TEXT
    assert fallback.headers.get("content-encoding") == "gzip", (
        "fallback path escaped the general compressed proxy lane"
    )

    audit_path = (
        REPO_ROOT
        / "test-results"
        / "runs"
        / run_id
        / "offline-reading-caddy"
        / "origin-audit.jsonl"
    )
    rows = [json.loads(line) for line in audit_path.read_text(encoding="utf-8").splitlines()]
    package_request = next(row for row in rows if row["path"] == package_path)
    assert package_request == {
        "accept_encoding": "gzip",
        "authorization": "Bearer package-proof",
        "path": package_path,
    }
    assert {row["path"] for row in rows} >= {package_path, package_path + "/extra"}
