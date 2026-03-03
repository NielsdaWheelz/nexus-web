"""Integration tests for ingest remediation contract hardening.

Covers:
- Task catalog as single source of truth
- Worker registration contract
- Deployment-visible task contract fingerprint in health response
"""

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration


def test_celery_routes_match_task_catalog_contract():
    from nexus.celery import celery_app
    from nexus.celery_contract import build_task_routes

    expected = build_task_routes()
    actual = celery_app.conf.task_routes or {}
    assert actual == expected, (
        "Celery task routes must be generated from the canonical task catalog. "
        f"Expected routes: {expected}, Actual routes: {actual}"
    )


def test_worker_required_tasks_match_catalog_contract():
    from apps.worker.main import REQUIRED_TASK_NAMES

    from nexus.celery_contract import REQUIRED_WORKER_TASK_NAMES

    assert REQUIRED_TASK_NAMES == REQUIRED_WORKER_TASK_NAMES, (
        "Worker required task names drifted from task catalog contract. "
        f"Worker: {sorted(REQUIRED_TASK_NAMES)}, Catalog: {sorted(REQUIRED_WORKER_TASK_NAMES)}"
    )


def test_health_exposes_task_contract_version(client: TestClient):
    from nexus.celery_contract import TASK_CONTRACT_VERSION

    response = client.get("/health")
    assert response.status_code == 200, (
        f"Expected /health to return 200, got {response.status_code}: {response.text}"
    )
    payload = response.json()["data"]
    assert payload.get("task_contract_version") == TASK_CONTRACT_VERSION, (
        "Health response must expose canonical task contract version for deployment checks. "
        f"Expected {TASK_CONTRACT_VERSION}, got {payload}"
    )
