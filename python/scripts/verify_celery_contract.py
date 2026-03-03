"""Verify Celery task contract consistency across API + worker wiring.

Exit code:
- 0: contract is consistent
- 1: mismatch detected
"""

from __future__ import annotations

from apps.worker.main import celery_app

from nexus.celery_contract import (
    REQUIRED_WORKER_TASK_NAMES,
    TASK_CONTRACT_VERSION,
    build_task_routes,
)


def main() -> int:
    failures: list[str] = []

    expected_routes = build_task_routes()
    actual_routes = celery_app.conf.task_routes or {}
    if actual_routes != expected_routes:
        failures.append(f"task_routes mismatch: expected={expected_routes}, actual={actual_routes}")

    registered = set(celery_app.tasks.keys())
    missing = sorted(REQUIRED_WORKER_TASK_NAMES - registered)
    if missing:
        failures.append(f"missing worker task registrations: {missing}")

    beat_schedule = celery_app.conf.beat_schedule or {}
    for beat_job in ("podcast_active_subscription_poll", "reconcile_stale_ingest_media"):
        if beat_job not in beat_schedule:
            failures.append(f"missing beat schedule entry: {beat_job}")

    if failures:
        print("celery_contract_check=FAILED")
        for item in failures:
            print(f"- {item}")
        return 1

    print("celery_contract_check=OK")
    print(f"task_contract_version={TASK_CONTRACT_VERSION}")
    print(f"required_tasks={len(REQUIRED_WORKER_TASK_NAMES)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
