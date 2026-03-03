# S6 PR-09: Ingest Reliability Hardening

## Scope

This PR hardens PDF/EPUB ingest against task-registration drift, dropped jobs, and malformed extracted text.

## Failure Modes Addressed

1. **Unregistered Celery task** (`Received unregistered task of type 'ingest_pdf'`) caused silent job drop.
2. **No recovery path** for `media.processing_status='extracting'` rows when worker execution never completed.
3. **DB write failures** when extracted PDF text contained NUL bytes (`\x00`) rejected by PostgreSQL.

## Implemented Controls

### 1) Canonical Celery Contract

- `python/nexus/celery_contract.py` is the single source of truth for:
  - required worker task names
  - `task_routes`
  - beat job task wiring
  - deterministic `task_contract_version` fingerprint
- `python/nexus/celery.py` builds routes/schedules from this contract.
- `apps/worker/main.py` fail-fast asserts required task registrations at startup.

### 2) Deployment Preflight

- `python/scripts/verify_celery_contract.py` validates runtime route + registration + beat parity.
- `make verify-celery-contract` runs that preflight check.
- `make verify-fast` now includes the contract verifier.
- `/health` now exposes `task_contract_version` for API/worker compatibility checks.

### 3) Operational Recovery for Stale Ingest

- New beat task: `reconcile_stale_ingest_media_job`
  - scans stale `extracting` rows for kinds `pdf` and `epub`
  - requeues bounded retries
  - fail-closes after max attempts with timeout error metadata
- New internal operator endpoints:
  - `POST /internal/ingest/reconcile`
  - `GET /internal/ingest/reconcile/health`
- Runtime controls:
  - `INGEST_RECONCILE_SCHEDULE_SECONDS`
  - `INGEST_STALE_EXTRACTING_SECONDS`
  - `INGEST_STALE_REQUEUE_MAX_ATTEMPTS`

### 4) Text Safety

- `normalize_pdf_text` now strips NUL bytes before persistence.
- Regression test added to prevent reintroduction.

## Verification Checklist

```bash
make verify-celery-contract
make verify
make e2e
```

Manual CLI smoke checks:

- `/health` returns `task_contract_version`
- reconciler task can execute safely and return a structured result

## Known Follow-ups

1. Add alerting for:
   - `Received unregistered task`
   - `stale_ingest_failed_closed`
2. Add deploy gate that blocks API rollout when contract preflight fails on candidate image.
3. Extend stale reconciler policy to additional ingest kinds only after explicit retry-safety contracts are defined.
