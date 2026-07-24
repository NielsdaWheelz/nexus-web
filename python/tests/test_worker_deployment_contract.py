"""Worker lane contracts across runtime and deployment entrypoints."""

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

_ROOT = Path(__file__).resolve().parents[2]


def _service_block(path: str, service: str) -> str:
    source = (_ROOT / path).read_text()
    match = re.search(
        rf"^  {re.escape(service)}:\n(?P<body>(?:    .*\n|[ \t]*\n)*)",
        source,
        re.MULTILINE,
    )
    assert match is not None, f"{service} is missing from {path}"
    return match.group("body")


@pytest.mark.parametrize(
    "path",
    [
        "deploy/hetzner/docker-compose.yml",
        "docker/docker-compose.worker.yml",
    ],
)
def test_compose_declares_exact_worker_lanes(path: str):
    source = (_ROOT / path).read_text()

    assert not re.search(r"^  worker:", source, re.MULTILINE)
    for lane in ("interactive", "background"):
        service = _service_block(path, f"worker-{lane}")
        assert f"WORKER_LANE: {lane}" in service or f"WORKER_LANE={lane}" in service
        assert re.search(
            r'DATABASE_STATEMENT_TIMEOUT_MS(?:: "?|=)300000"?$',
            service,
            re.MULTILINE,
        )
        assert "WORKER_ALLOWED_JOB_KINDS" not in service
        assert '["CMD-SHELL", "kill -0 1"]' in service


def test_normal_entrypoints_name_both_lanes_and_no_legacy_worker_target():
    makefile = (_ROOT / "Makefile").read_text()
    deploy = (_ROOT / "deploy" / "hetzner" / "deploy.sh").read_text()
    cutover = (_ROOT / "deploy" / "hetzner" / "resource-sharing-cutover.sh").read_text()

    assert re.search(r"^worker-interactive:", makefile, re.MULTILINE)
    assert re.search(r"^worker-background:", makefile, re.MULTILINE)
    assert not re.search(r"^worker:", makefile, re.MULTILINE)
    assert "WORKER_LANE=interactive DATABASE_STATEMENT_TIMEOUT_MS=300000" in makefile
    assert "WORKER_LANE=background DATABASE_STATEMENT_TIMEOUT_MS=300000" in makefile

    for script in (deploy, cutover):
        assert "worker-interactive" in script
        assert "worker-background" in script
        assert not re.search(r"\b(?:stop|exec|run)\b[^\n]*\bworker(?:\s|$)", script)


def test_only_background_lane_owns_production_periodic_jobs():
    from nexus.config import (
        BACKGROUND_WORKER_JOB_KINDS,
        INTERACTIVE_WORKER_JOB_KINDS,
        MAINTENANCE_JOB_KINDS,
    )
    from nexus.jobs.registry import get_default_registry

    periodic = {
        kind
        for kind, definition in get_default_registry().items()
        if definition.periodic_interval_seconds is not None
    }

    assert not periodic & set(INTERACTIVE_WORKER_JOB_KINDS)
    assert periodic - set(MAINTENANCE_JOB_KINDS) <= set(BACKGROUND_WORKER_JOB_KINDS)


def test_oracle_seed_drains_source_and_reindex_jobs_through_shared_contract():
    from nexus.config import ORACLE_SEED_WORKER_JOB_KINDS
    from nexus.jobs.registry import get_default_registry

    assert ORACLE_SEED_WORKER_JOB_KINDS == (
        "ingest_media_source",
        "media_content_reindex_job",
    )
    assert set(ORACLE_SEED_WORKER_JOB_KINDS) <= set(get_default_registry())
    seed_script = (_ROOT / "scripts" / "oracle" / "seed_corpus_library.py").read_text()
    assert "allowed_kinds=ORACLE_SEED_WORKER_JOB_KINDS" in seed_script
