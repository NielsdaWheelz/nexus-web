"""Actual image, authentication, database, and reader-response allocation evidence."""

import base64
import hashlib
import json
import os
import random
import struct
import subprocess
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from pathlib import Path
from threading import Barrier, Event, Thread
from typing import Literal
from uuid import UUID, uuid4

import httpx
from sqlalchemy import create_engine, delete, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import (
    Fragment,
    LibraryEntry,
    Media,
    NexusUsage,
    ProcessingStatus,
    ReaderPublication,
)
from nexus_test_control.containers import (
    close_owned_container,
    create_owned_container,
    local_docker,
    wait_api_container_ready,
)
from nexus_test_control.evidence import redact_text
from nexus_test_control.runner import environment_secrets
from nexus_test_control.runtime import read_runtime
from nexus_test_control.services import create_supabase_user, read_supabase_credentials

REPO_ROOT = Path(__file__).parents[3]
MANIFEST = REPO_ROOT / "testdata/capacity/incident-api.json"


def _sample(cgroup: Path, phase: str, *, detailed: bool = True) -> dict:
    sample = {
        "phase": phase,
        "monotonic_seconds": time.monotonic(),
        **{name: int((cgroup / name).read_text()) for name in ("memory.current", "memory.peak")},
        "memory.events": {
            key: int(value)
            for key, value in (
                line.split() for line in (cgroup / "memory.events").read_text().splitlines()
            )
        },
    }
    if detailed:
        sample["memory.stat"] = {
            key: int(value)
            for key, value in (
                line.split() for line in (cgroup / "memory.stat").read_text().splitlines()
            )
        }
    return sample


def _image_arguments(
    database_url: str,
    memory_bytes: int,
    *,
    readonly: bool = True,
    loopback_worker: bool = False,
) -> tuple[str, ...]:
    environment = {
        key: os.environ[key]
        for key in (
            "NEXUS_ENV",
            "SUPABASE_JWKS_URL",
            "SUPABASE_ISSUER",
            "SUPABASE_AUDIENCES",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
            "R2_S3_API_ORIGIN",
            "R2_REGION",
            "R2_BUCKET",
        )
    }
    project = read_runtime(REPO_ROOT).compose_project
    environment.update(
        {
            "DATABASE_URL": database_url
            if loopback_worker
            else make_url(database_url)
            .set(host="postgres", port=5432)
            .render_as_string(hide_password=False),
            "R2_S3_API_ORIGIN": environment["R2_S3_API_ORIGIN"]
            if loopback_worker
            else "http://minio:9000",
            "SUPABASE_JWKS_URL": environment["SUPABASE_JWKS_URL"]
            if loopback_worker
            else f"http://supabase_kong_{project}:8000/auth/v1/.well-known/jwks.json",
            "PYTHONDONTWRITEBYTECODE": "1",
            "NEXUS_RUNTIME_IDENTITY_FILE": "/app/runtime-identity.json",
            "API_READ_ADMISSION_LIMITS": os.environ["API_READ_ADMISSION_LIMITS"],
            "IMAGE_DECODER_LIMITS": os.environ["IMAGE_DECODER_LIMITS"],
        }
    )
    return (
        "--memory",
        str(memory_bytes),
        "--memory-swap",
        str(memory_bytes),
        *(
            ("--network=host",)
            if loopback_worker
            else (f"--network={project}_default", f"--network=supabase_network_{project}")
        ),
        *(("--read-only",) if readonly else ()),
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        *(f"--env={key}={value}" for key, value in environment.items()),
    )


@contextmanager
def _running_capacity_worker(
    engine,
    user_id: UUID,
    receipt: dict,
    source_shape: Literal["pdf", "epub", "epub-dense"],
    client: httpx.Client,
):
    """Upload a maximum source through the actual background service image."""
    from sqlalchemy import select

    from nexus.config import (
        BACKGROUND_WORKER_MEMORY_LIMIT_BYTES,
        get_settings,
        require_reader_publication_limits,
    )
    from nexus.db.models import MediaSourceAttempt, ReaderPublicationArtifact
    from nexus.db.session import transaction
    from nexus.jobs.queue import get_job
    from nexus.schemas.media import CreateUploadSessionRequest
    from nexus.services import library_entries, media_deletion
    from nexus.services.media_upload_sessions import confirm_upload_session, create_upload_session
    from nexus.services.sealed_handles import unseal_upload_session
    from nexus.storage.client import get_storage_client
    from nexus.storage.paths import build_upload_session_staging_storage_path
    from tests.testkit.reader_capacity_sources import epub_capacity_source, pdf_capacity_source

    run_id = os.environ["NEXUS_TEST_RUN_ID"]
    storage = get_storage_client()
    source_kind = "pdf" if source_shape == "pdf" else "epub"
    if source_kind == "pdf":
        source_bytes, source_profile = pdf_capacity_source(
            page_count=10_000, text_bytes=32 * 1024 * 1024, source_bytes=100 * 1024 * 1024
        )
        content_type, upload_kind = "application/pdf", "Pdf"
    else:
        source_bytes, source_profile = epub_capacity_source(
            rendered_bytes=64 * 1024 * 1024, dense_words=source_shape == "epub-dense"
        )
        content_type, upload_kind = "application/epub+zip", "Epub"
    with Session(engine) as db:
        created = create_upload_session(
            db,
            viewer_id=user_id,
            request=CreateUploadSessionRequest(
                kind=upload_kind,
                filename=f"capacity.{source_kind}",
                content_type=content_type,
                size_bytes=len(source_bytes),
                library_ids=[],
            ),
            request_id="capacity-create",
            idempotency_key=f"capacity-{run_id}",
            storage_client=storage,
        )
        assert created.kind == "UploadRequired"
        storage.put_object(
            build_upload_session_staging_storage_path(
                unseal_upload_session(created.session_handle), created.generation, source_kind
            ),
            source_bytes,
            content_type,
        )
        published = confirm_upload_session(
            db,
            viewer_id=user_id,
            session_handle=created.session_handle,
            generation=created.generation,
            request_id="capacity-confirm",
            storage_client=storage,
        )
        attempt = db.get(MediaSourceAttempt, published.source_attempt_id)
        assert attempt is not None and attempt.job_id is not None
        job_id = attempt.job_id
    del source_bytes
    profile = receipt["worker"] = {
        "image": os.environ["NEXUS_TEST_CANDIDATE_WORKER_IMAGE"],
        "preparation_scope": "actual uploaded maximum source; archive preparation and other source shapes remain separate",
        **source_profile,
        "source_kind": source_kind,
        "job_id": str(job_id),
        "memory_limit_bytes": BACKGROUND_WORKER_MEMORY_LIMIT_BYTES,
        "publication_experiment": json.loads(os.environ["READER_PUBLICATION_LIMITS"]),
        "samples": [],
        "sampling_interval_seconds": 0.5,
        "job_observations": [],
        "children": {},
        "memory_meaning": "total container cgroup includes supervisor, source child, page cache and actual lane-health invocation; child RSS/HWM is separate",
        "transport_scope": "host-network image reaches exact run-owned loopback database/storage and external Codex/embedding peers outside the worker cgroup; not production network-latency equivalence",
    }
    peer_socket = Path(os.environ["NEXUS_CODEX_AGENT_SOCKET"])
    profile["codex_socket_mode"] = oct(peer_socket.stat().st_mode & 0o777)
    profile["codex_peer_modes"] = json.loads(os.environ["NEXUS_TEST_CAPACITY_CODEX_PEER_MODES"])
    profile["codex_socket_scope"] = (
        "secret-free owned socket permits local connects across rootless uid/gid mapping; "
        "private host parent/audit, exact read-only socket mount, unchanged image uid 10001"
    )
    guard_directory = Path(os.environ["NEXUS_TEST_CAPACITY_WORKER_GUARD"])
    profile["network_guard_sha256"] = {
        filename: hashlib.sha256((guard_directory / filename).read_bytes()).hexdigest()
        for filename in ("sitecustomize.py", "network.py", "ca.pem")
    }
    stopped = Event()
    sampler = None
    name = None
    try:
        name = create_owned_container(
            REPO_ROOT,
            {"NEXUS_ENV": "test"},
            run_id,
            role="capacity-worker",
            image=profile["image"],
            arguments=(
                *_image_arguments(
                    os.environ["NEXUS_MIGRATION_DATABASE_URL"],
                    BACKGROUND_WORKER_MEMORY_LIMIT_BYTES,
                    readonly=False,
                    loopback_worker=True,
                ),
                "--init",
                "--pids-limit=256",
                f"--volume={peer_socket}:/capacity-codex.sock:ro",
                f"--volume={guard_directory}:/capacity-network:ro",
                "--env=NEXUS_CODEX_AGENT_SOCKET=/capacity-codex.sock",
                "--env=PYTHONPATH=/capacity-network:/app",
                "--env=NEXUS_TEST_DENY_EXTERNAL_NETWORK=1",
                "--env=NEXUS_TEST_TLS_CA_CERT=/capacity-network/ca.pem",
                f"--env=NEXUS_TEST_STATIC_DNS={os.environ['NEXUS_TEST_STATIC_DNS']}",
                f"--env=OPENAI_API_KEY={os.environ['OPENAI_API_KEY']}",
                "--env=WORKER_LANE=background",
                "--env=DATABASE_STATEMENT_TIMEOUT_MS=300000",
                "--env=DATABASE_IDLE_IN_TX_TIMEOUT_MS=0",
                f"--env=READER_PUBLICATION_LIMITS={os.environ['READER_PUBLICATION_LIMITS']}",
            ),
            command=("python", "-m", "apps.worker.main"),
        )
        local_docker(("start", name))
        state = json.loads(local_docker(("inspect", name)))[0]
        profile["source_sha"] = state["Config"]["Labels"]["org.opencontainers.image.revision"]
        profile["container_pid"] = state["State"]["Pid"]
        relative = (
            Path(f"/proc/{profile['container_pid']}/cgroup").read_text().strip().removeprefix("0::")
        )
        cgroup = Path("/sys/fs/cgroup") / relative.lstrip("/")
        profile["samples"].append(_sample(cgroup, "worker-started"))

        def observe():
            # memory.peak retains peaks between samples; this bounds the receipt
            # during the existing worker's complete 900-second job deadline.
            observed_pressure = False
            while not stopped.wait(0.5):
                try:
                    sample = _sample(cgroup, "worker-running", detailed=False)
                    profile["samples"].append(sample)
                    if not observed_pressure and sample["memory.events"]["max"] > 0:
                        observed_pressure = True
                        profile["samples"].append(_sample(cgroup, "first-observed-pressure"))
                    for raw_pid in (cgroup / "cgroup.procs").read_text().splitlines():
                        process = Path("/proc") / raw_pid
                        try:
                            argv = (process / "cmdline").read_bytes().split(b"\0")
                            if argv[1:3] == [b"-m", b"nexus.jobs.process_executor"]:
                                module = "nexus.jobs.process_executor"
                            elif (
                                len(argv) >= 2
                                and Path(os.fsdecode(argv[0])).name in {"node", "nodejs"}
                                and Path(os.fsdecode(argv[1])).name
                                in {"word_boundaries.mjs", "epub_paths.mjs"}
                            ):
                                module = Path(os.fsdecode(argv[1])).name
                            else:
                                continue
                            stat = (process / "stat").read_text().rsplit(")", 1)[1].split()
                            status = dict(
                                line.split(":", 1)
                                for line in (process / "status").read_text().splitlines()
                            )
                            if "VmRSS" not in status or "VmHWM" not in status:
                                continue
                            now = time.monotonic()
                            child = profile["children"].setdefault(
                                f"{raw_pid}:{stat[19]}",
                                {
                                    "pid": int(raw_pid),
                                    "start_ticks": int(stat[19]),
                                    "module": module,
                                    "first_observed": now,
                                    "rss_bytes": 0,
                                    "high_water_bytes": 0,
                                },
                            )
                            child["last_observed"] = now
                            child["rss_bytes"] = max(
                                child["rss_bytes"], int(status["VmRSS"].split()[0]) * 1024
                            )
                            child["high_water_bytes"] = max(
                                child["high_water_bytes"], int(status["VmHWM"].split()[0]) * 1024
                            )
                        except (FileNotFoundError, ProcessLookupError):
                            continue
                except FileNotFoundError:
                    return

        def record_job_observation(db, job):
            stage, completed, total, unit = db.execute(
                select(
                    MediaSourceAttempt.processing_stage,
                    MediaSourceAttempt.progress_completed,
                    MediaSourceAttempt.progress_total,
                    MediaSourceAttempt.progress_unit,
                ).where(MediaSourceAttempt.id == published.source_attempt_id)
            ).one()
            profile["job_observations"].append(
                {
                    "status": job.status,
                    "at": time.monotonic(),
                    "stage": stage,
                    "completed": completed,
                    "total": total,
                    "unit": unit,
                }
            )

        sampler = Thread(target=observe)
        sampler.start()
        deadline = time.monotonic() + get_settings().background_process_wall_timeout_seconds + 60
        with Session(engine) as db:
            while time.monotonic() < deadline:
                job = get_job(db, job_id)
                assert job is not None
                record_job_observation(db, job)
                db.rollback()
                if job.status == "running":
                    profile["source_job_started_at"] = (
                        job.started_at.isoformat() if job.started_at else None
                    )
                    break
                assert job.status == "pending", (
                    f"capacity worker ended before overlap: {job.status}"
                )
                assert json.loads(local_docker(("inspect", name)))[0]["State"]["Running"], (
                    "capacity worker exited before claim"
                )
                stopped.wait(0.5)
            else:
                raise AssertionError(
                    "capacity background worker did not claim its actual uploaded source"
                )
        yield
        with Session(engine) as db:
            while time.monotonic() < deadline:
                job = get_job(db, job_id)
                assert job is not None
                record_job_observation(db, job)
                db.rollback()
                if job.status != "running":
                    break
                stopped.wait(0.5)
            assert job.status == "succeeded", (
                f"capacity source job did not complete: {job.status}/{job.error_code}"
            )
            profile["source_job_finished_at"] = (
                job.finished_at.isoformat() if job.finished_at else None
            )
            profile["samples"].append(_sample(cgroup, "source-finished"))
            generation = db.scalar(
                select(ReaderPublication.generation).where(
                    ReaderPublication.media_id == published.media_id
                )
            )
            assert generation is not None
            artifacts = list(
                db.scalars(
                    select(ReaderPublicationArtifact).where(
                        ReaderPublicationArtifact.media_id == published.media_id,
                        ReaderPublicationArtifact.generation == generation,
                    )
                )
            )
            assert artifacts, "capacity source worker omitted its retained artifacts"
            profile["retained_artifact_count"] = len(artifacts)
            base = f"/media/{published.media_id}/reader-publications/{generation}"
            descriptor_response = client.get(f"{base}/descriptor")
            assert descriptor_response.status_code == 200, descriptor_response.text
            descriptor = descriptor_response.json()
            assert descriptor["reader_generation"] == generation
            limits = require_reader_publication_limits()
            assert len(descriptor_response.content) <= limits.descriptor_bytes
            profile["generation"] = generation
            profile["descriptor_sha256"] = hashlib.sha256(descriptor_response.content).hexdigest()
            original_retained = False
            # These post-job reads are measured separately from source execution.
            # Stream assets; only bounded descriptor/index/unit bodies are decoded.
            for artifact in artifacts:
                digest, size = hashlib.sha256(), 0
                if artifact.role in ("descriptor", "index", "unit"):
                    if artifact.role == "descriptor":
                        result = descriptor_response
                        bound = limits.descriptor_bytes
                    elif artifact.role == "index":
                        result = client.get(f"{base}/index", params={"after": artifact.path})
                        bound = limits.index_bytes
                    else:
                        result = client.get(f"{base}/{artifact.path}")
                        bound = limits.unit_bytes
                    assert result.status_code == 200, result.text
                    assert len(result.content) <= bound
                    digest.update(result.content)
                    size = len(result.content)
                else:
                    for chunk in storage.stream_object(artifact.storage_path):
                        digest.update(chunk)
                        size += len(chunk)
                assert (size, digest.hexdigest()) == (artifact.size_bytes, artifact.sha256)
                if (size, digest.hexdigest()) == (
                    source_profile["source_bytes"],
                    source_profile["source_sha256"],
                ):
                    original_retained = True
            assert original_retained, "publication lost or changed its original uploaded source"
            if source_kind == "pdf":
                assert descriptor["page_count"] == source_profile["page_count"]
                asset = descriptor["document_asset_ref"]
                assert asset["bytes"] == source_profile["source_bytes"]
                assert asset["sha256"] == source_profile["source_sha256"]
                frozen = db.execute(
                    text(
                        "SELECT octet_length(canonical_text), "
                        "encode(sha256(convert_to(canonical_text, 'UTF8')), 'hex'), "
                        "pdf_page_spans, pdf_page_heights FROM reader_publication_search_sources "
                        "WHERE media_id=:media AND generation=:generation AND source_ordinal=0"
                    ),
                    {"media": published.media_id, "generation": generation},
                ).one()
                assert frozen[0] == source_profile["text_bytes"]
                assert frozen[1] == source_profile["text_sha256"]
                assert len(frozen[2]) == len(frozen[3]) == source_profile["page_count"]
                offset = 0
                for page, length in enumerate(source_profile["page_text_bytes"], 1):
                    assert frozen[2][page - 1] == [page, offset, offset + length]
                    assert frozen[3][page - 1] == 792
                    offset += length + 2
                profile["frozen_text_sha256"] = frozen[1]
                quotes = [source_profile["first_quote"], source_profile["last_quote"]]
            else:
                observed = db.execute(
                    text(
                        "SELECT idx, octet_length(html_sanitized)+octet_length(canonical_text), "
                        "octet_length(canonical_text), "
                        "encode(sha256(convert_to(canonical_text, 'UTF8')), 'hex') "
                        "FROM fragments WHERE media_id=:media ORDER BY idx"
                    ),
                    {"media": published.media_id},
                ).all()
                assert len(observed) == 4
                assert sum(row[1] for row in observed) == source_profile["rendered_bytes"]
                for row, chapter in zip(observed, source_profile["chapters"], strict=True):
                    assert row[2] == chapter["canonical_bytes"]
                    assert row[3] == chapter["canonical_sha256"]
                digests = [hashlib.sha256() for _ in range(4)]
                offsets = [0] * 4
                fragment_ids = [None] * 4
                last_boundaries = [-1] * 4
                boundary_counts = [0] * 4
                unit_keys = set()
                index_keys = set()
                index_ref = descriptor["index_ref"]
                while index_ref is not None:
                    assert index_ref["key"] not in index_keys, "publication index cycles"
                    index_keys.add(index_ref["key"])
                    response = client.get(f"{base}/index", params={"after": index_ref["key"]})
                    assert response.status_code == 200, response.text
                    assert (
                        len(response.content),
                        hashlib.sha256(response.content).hexdigest(),
                    ) == (index_ref["bytes"], index_ref["sha256"])
                    page = response.json()
                    for entry in page["units"]:
                        ref = entry["member"]
                        assert ref["key"] not in unit_keys, "publication repeats a reading unit"
                        unit_keys.add(ref["key"])
                        response = client.get(f"{base}/{ref['key']}")
                        assert response.status_code == 200, response.text
                        assert (
                            len(response.content),
                            hashlib.sha256(response.content).hexdigest(),
                        ) == (ref["bytes"], ref["sha256"])
                        unit = response.json()
                        index = unit["fragment_idx"]
                        chapter = source_profile["chapters"][index]
                        if fragment_ids[index] is None:
                            fragment_ids[index] = unit["fragment_id"]
                        assert unit["fragment_id"] == fragment_ids[index]
                        assert unit["epub_target"]["href_path"] == chapter["href_path"]
                        assert unit["start_cp"] == offsets[index]
                        offsets[index] += len(unit["canonical_text"])
                        assert unit["end_cp"] == offsets[index]
                        digests[index].update(unit["canonical_text"].encode())
                        for boundary in unit["word_boundaries"]:
                            assert unit["start_cp"] <= boundary <= unit["end_cp"]
                            assert boundary >= last_boundaries[index]
                            if boundary > last_boundaries[index]:
                                boundary_counts[index] += 1
                                last_boundaries[index] = boundary
                    index_ref = page["next_ref"]
                assert len(unit_keys) == descriptor["unit_count"]
                assert unit_keys == {row.path for row in artifacts if row.role == "unit"}
                for index, chapter in enumerate(source_profile["chapters"]):
                    assert offsets[index] == chapter["canonical_bytes"]
                    assert digests[index].hexdigest() == chapter["canonical_sha256"]
                    assert boundary_counts[index] == chapter["word_boundary_count"]
                profile["verified_unit_count"] = len(unit_keys)
                profile["verified_word_boundary_counts"] = boundary_counts
                for index, chapter in enumerate(source_profile["chapters"]):
                    response = client.post(
                        f"{base}/resolve",
                        json={
                            "target": {
                                "kind": "EpubHref",
                                "pathname": chapter["href_path"],
                                "anchor_id": None,
                            }
                        },
                    )
                    assert response.status_code == 200, response.text
                    resolved = response.json()["data"]
                    assert resolved["kind"] == "Text", resolved
                    assert resolved["fragment_id"] == fragment_ids[index]
                    assert resolved["offset_cp"] == resolved["local_offset_cp"] == 0
                    assert resolved["locator"]["target"]["href_path"] == chapter["href_path"]
                    assert resolved["locator"]["locations"]["text_offset"] == 0
                quotes = [
                    quote
                    for chapter in source_profile["chapters"]
                    for quote in (chapter["first_quote"], chapter["last_quote"])
                ]
            profile["source_queries"] = []
            profile["source_resolutions"] = []
            for quote_index, quote in enumerate(quotes):
                started = time.monotonic()
                if source_kind == "pdf":
                    from nexus.services.reader_publication_search import (
                        reader_publication_quote_matches_sql,
                    )

                    # PDF literal Find remains the SDK's capability. This is the
                    # existing server quote projection, outside the API cgroup.
                    occurrence = dict(
                        db.execute(
                            text(
                                reader_publication_quote_matches_sql(
                                    "SELECT CAST(:exact AS text) AS exact, "
                                    "''::text AS prefix, ''::text AS suffix"
                                )
                            ),
                            {
                                "media_id": published.media_id,
                                "generation": generation,
                                "exact": quote,
                            },
                        )
                        .mappings()
                        .one()
                    )
                    assert occurrence["hit_count"] == 1
                    assert occurrence["page_number"] == (1 if quote_index == 0 else 10_000)
                    assert occurrence["raw_start"] is None and occurrence["raw_end"] is None
                    pages = 1
                else:
                    after, occurrence, pages = None, None, 0
                    while True:
                        response = client.post(
                            f"{base}/find",
                            json={
                                "query": quote,
                                "match_case": True,
                                "whole_word": False,
                                "scope": {"kind": "EntireResource"},
                                "after": after,
                            },
                        )
                        assert response.status_code == 200, response.text
                        found = response.json()["data"]
                        pages += 1
                        assert pages <= descriptor["unit_count"] + 1, "find failed to advance"
                        for match in found["occurrences"]:
                            assert occurrence is None, "find repeated an original source match"
                            occurrence = match
                        after = found["next_cursor"]
                        if after is None:
                            break
                    assert occurrence is not None, "find omitted the original source quote"
                    index = quote_index // 2
                    chapter = source_profile["chapters"][index]
                    start = 0 if quote_index % 2 == 0 else chapter["canonical_bytes"] - len(quote)
                    assert occurrence["fragment_idx"] == index
                    assert occurrence["fragment_id"] == fragment_ids[index]
                    assert occurrence["start_offset"] == start
                    assert occurrence["end_offset"] == start + len(quote)
                    assert occurrence["locator"]["target"]["href_path"] == chapter["href_path"]
                    assert occurrence["locator"]["locations"]["text_offset"] == start
                profile["source_queries"].append(
                    {
                        "query": quote,
                        "seconds": time.monotonic() - started,
                        "pages": pages,
                        "occurrence": occurrence,
                    }
                )
                if source_kind == "epub":
                    for exact in (quote, "a") if quote_index == len(quotes) - 1 else (quote,):
                        locator = {
                            **occurrence["locator"],
                            "locations": {
                                **occurrence["locator"]["locations"],
                                "text_offset": None,
                            },
                            "text": {"quote": exact, "quote_prefix": None, "quote_suffix": None},
                        }
                        started = time.monotonic()
                        response = client.post(
                            f"{base}/resolve",
                            json={"target": {"kind": "Locator", "locator": locator}},
                        )
                        seconds = time.monotonic() - started
                        assert response.status_code == 200, response.text
                        resolved = response.json()["data"]
                        if exact == "a":
                            assert resolved["kind"] == "Unresolved"
                            assert resolved["reason"] == "QuoteAmbiguous"
                        else:
                            assert resolved["kind"] == "Text"
                            assert resolved["fragment_id"] == fragment_ids[index]
                            assert resolved["offset_cp"] == start
                            assert (
                                resolved["locator"]["target"]["href_path"] == chapter["href_path"]
                            )
                            assert resolved["locator"] == locator
                        # The existing browser semantic-read budget is 30 seconds.
                        assert seconds < 30, "quote resolution exceeded the reader operation budget"
                        profile["source_resolutions"].append(
                            {"query": exact, "seconds": seconds, "resolution": resolved}
                        )
        # The source transaction requests both real follow-up owners. A ready
        # descriptor alone does not attest their configured external boundaries.
        followup_deadline = (
            time.monotonic() + 2 * get_settings().background_process_wall_timeout_seconds + 60
        )
        with Session(engine) as db:
            while time.monotonic() < followup_deadline:
                rows = (
                    db.execute(
                        text("""
                        SELECT id, kind, status, error_code, result
                        FROM background_jobs
                        WHERE payload ->> 'media_id' = :media_id
                          AND kind IN ('enrich_metadata', 'media_content_reindex_job')
                        ORDER BY created_at, id
                    """),
                        {"media_id": str(published.media_id)},
                    )
                    .mappings()
                    .all()
                )
                profile["followup_jobs"] = [{**dict(row), "id": str(row["id"])} for row in rows]
                db.rollback()
                assert all(row["status"] in {"pending", "running", "succeeded"} for row in rows), (
                    f"capacity follow-up job failed: {profile['followup_jobs']}"
                )
                assert {row["kind"] for row in rows} == {
                    "enrich_metadata",
                    "media_content_reindex_job",
                }, "successful source omitted its committed follow-up jobs"
                if all(row["status"] == "succeeded" for row in rows):
                    break
                stopped.wait(0.5)
            else:
                raise AssertionError("capacity source follow-up jobs did not complete")
            assert any(
                row["kind"] == "enrich_metadata" and row["result"]["status"] == "success"
                for row in rows
            ), "capacity metadata follow-up did not publish its actual generated fields"
            assert any(
                row["kind"] == "media_content_reindex_job"
                and row["result"]["status"] == "ready"
                and row["result"]["chunk_count"] > 0
                for row in rows
            ), "capacity indexing follow-up did not publish its complete actual index"
        profile["health"] = json.loads(
            local_docker(
                ("exec", name, "python", "-S", "-m", "apps.worker.health", "--lane", "background")
            )
        )
        assert profile["health"]["status"] == "ready"
        assert profile["health"]["source_sha"] == profile["source_sha"]
        profile["samples"].append(_sample(cgroup, "worker-verified"))
    finally:
        stopped.set()
        if sampler is not None:
            sampler.join()
        try:
            if name is not None:
                profile["state"] = json.loads(local_docker(("inspect", name)))[0]["State"]
                profile["logs"] = local_docker(("logs", name))
        finally:
            try:
                close_owned_container(REPO_ROOT, run_id, "capacity-worker")
            finally:
                with Session(engine) as cleanup:
                    with transaction(cleanup):
                        library_entries.delete_all_entries_for_media(cleanup, published.media_id)
                        paths = media_deletion.delete_document_media_if_unreferenced(
                            cleanup, published.media_id
                        )
                    media_deletion.delete_document_storage_objects(paths or [], storage)


def _reader_workload(
    image: str,
    role: str,
    *,
    artwork: bool = False,
    metadata_only: bool = False,
    worker: Literal["pdf", "epub", "epub-dense"] | None = None,
) -> dict:
    """Read the same source shape through the selected real image and schema."""
    manifest = json.loads(MANIFEST.read_text())
    assert artwork or not metadata_only
    assert not worker or (artwork and role == "candidate")
    run_id = os.environ["NEXUS_TEST_RUN_ID"]
    database_url = os.environ["NEXUS_MIGRATION_DATABASE_URL"]
    # Approved measurement trial after the 320MiB failures, not a release profile.
    memory_bytes = manifest["memory_bytes"] if role == "baseline" else 512 * 1024 * 1024
    arguments = _image_arguments(database_url, memory_bytes)
    if role == "candidate":
        arguments = (
            *arguments,
            f"--env=READER_PUBLICATION_LIMITS={os.environ['READER_PUBLICATION_LIMITS']}",
        )
    name = create_owned_container(
        REPO_ROOT,
        {"NEXUS_ENV": "test"},
        run_id,
        role=f"api-{role}",
        image=image,
        arguments=(*arguments, "--workdir=/app/migrations"),
        command=("alembic", "-c", "/app/migrations/alembic.ini", "upgrade", "head"),
    )
    try:
        try:
            local_docker(("start", "--attach", name), timeout=300)
        except subprocess.CalledProcessError as error:
            state = json.loads(local_docker(("inspect", name)))[0]["State"]
            detail = redact_text(
                f"{error.stdout or ''}\n{error.stderr or ''}\nstate={json.dumps(state)}",
                (*environment_secrets(os.environ), make_url(database_url).password or ""),
            )
            raise AssertionError(f"capacity migration failed for {image}:\n{detail}") from None
        assert json.loads(local_docker(("inspect", name)))[0]["State"]["ExitCode"] == 0
    finally:
        close_owned_container(REPO_ROOT, run_id, f"api-{role}")

    credentials = read_supabase_credentials(REPO_ROOT, {"NEXUS_ENV": "test"})
    user = create_supabase_user(
        REPO_ROOT, {"NEXUS_ENV": "test"}, run_id, "api-capacity", credentials
    )
    with httpx.Client(trust_env=False) as auth:
        response = auth.post(
            f"{credentials.url}/auth/v1/token?grant_type=password",
            headers={"apikey": credentials.anon_key},
            json={"email": user.email, "password": user.password},
        )
        response.raise_for_status()
        token = response.json()["access_token"]

    port = read_runtime(REPO_ROOT).ports.api
    image_fixture = {}
    if artwork:
        fixture_directory = REPO_ROOT / "test-results/runs" / run_id / "image-origin"
        fixture_directory.mkdir(parents=True, exist_ok=True)

        def chunk(kind: bytes, data: bytes) -> bytes:
            return (
                struct.pack(">I", len(data))
                + kind
                + data
                + struct.pack(">I", zlib.crc32(kind + data))
            )

        # Existing accepted contracts: <=10MiB wire, <=4096 dimensions,
        # <=1MiB text/chunk and <=64MiB aggregate PNG text. Generate outside API.
        pixels = random.Random(0).randbytes(2048 * 1700 * 3)
        scanlines = b"".join(b"\0" + pixels[n : n + 6144] for n in range(0, len(pixels), 6144))
        metadata = zlib.compress(b"x" * 1024 * 1024)
        fixtures = {
            "wire": (2048, 1700, b"", zlib.compress(scanlines, level=0)),
            "metadata": (
                1,
                1,
                b"".join(
                    chunk(b"zTXt", f"caption{n}".encode() + b"\0\0" + metadata) for n in range(64)
                ),
                zlib.compress(b"\0\0\0\0"),
            ),
        }
        for fixture, (width, height, text_chunks, compressed_pixels) in fixtures.items():
            data = (
                b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                + text_chunks
                + chunk(b"IDAT", compressed_pixels)
                + chunk(b"IEND", b"")
            )
            assert len(data) <= 10 * 1024 * 1024
            (fixture_directory / f"{fixture}.png").write_bytes(data)
            image_fixture[fixture] = {
                "encoded_bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "width": width,
                "height": height,
                "expanded_text_bytes": 64 * 1024 * 1024 if fixture == "metadata" else 0,
            }
        del pixels, scanlines, fixtures, data
        # Valid private TIFF tags share one value region. The old JPEG DPI
        # lookup eagerly copies every unselected value inside the API cgroup.
        source_image = json.loads((REPO_ROOT / "testdata/capacity/artwork.json").read_text())[
            "cases"
        ][0]
        jpeg = base64.b64decode(source_image["base64"])
        assert hashlib.sha256(jpeg).hexdigest() == source_image["sha256"]
        offset = 2
        jpeg_parts = [jpeg[:2]]
        while jpeg[offset + 1] != 0xDA:
            end = offset + 2 + int.from_bytes(jpeg[offset + 2 : offset + 4], "big")
            if not 0xE0 <= jpeg[offset + 1] <= 0xEF:
                jpeg_parts.append(jpeg[offset:end])
            offset = end
        jpeg_parts.append(jpeg[offset:])
        tag_count = 2600
        value_bytes = 32000
        value_offset = 8 + 2 + tag_count * 12 + 4
        exif = b"MM\0*\0\0\0\x08" + struct.pack(">H", tag_count)
        exif += (
            b"".join(
                struct.pack(">HHII", 0x8000 + tag, 7, value_bytes, value_offset)
                for tag in range(tag_count)
            )
            + b"\0\0\0\0"
            + b"x" * value_bytes
        )
        segment = b"Exif\0\0" + exif
        encoded_exif = (
            b"\xff\xd8\xff\xe1"
            + struct.pack(">H", len(segment) + 2)
            + segment
            + b"".join(jpeg_parts)[2:]
        )
        (fixture_directory / "exif.jpg").write_bytes(encoded_exif)
        image_fixture["exif"] = {
            "encoded_bytes": len(encoded_exif),
            "sha256": hashlib.sha256(encoded_exif).hexdigest(),
            "base_jpeg_sha256": source_image["sha256"],
            "width": 6,
            "height": 2,
            "private_ifd_tags": tag_count,
            "shared_value_bytes": value_bytes,
            "referenced_value_bytes": tag_count * value_bytes,
        }
        del exif, segment, encoded_exif, jpeg_parts, jpeg
        # Only these generated public image bytes cross the read-only mount.
        # The API image runs as its own uid; the run's private parent stays private.
        fixture_directory.chmod(0o755)
        for filename in ("wire.png", "metadata.png", "exif.jpg"):
            (fixture_directory / filename).chmod(0o644)
        startup = REPO_ROOT / "testdata/capacity/api_image_origin.py"
        provider_probe = REPO_ROOT / "testdata/capacity/api_provider_first_request.py"
        arguments = (
            *arguments,
            f"--volume={fixture_directory}:/capacity:ro",
            f"--volume={startup}:/capacity-origin.py:ro",
            f"--volume={provider_probe}:/capacity_provider_first_request.py:ro",
            "--env=PYTHONPATH=/app",
        )
        image_fixture["transport_sha256"] = hashlib.sha256(startup.read_bytes()).hexdigest()
        image_fixture["provider_probe_sha256"] = hashlib.sha256(
            provider_probe.read_bytes()
        ).hexdigest()
    name = create_owned_container(
        REPO_ROOT,
        {"NEXUS_ENV": "test"},
        run_id,
        role=f"api-{role}",
        image=image,
        arguments=(*arguments, "--publish", f"127.0.0.1:{port}:8000"),
        command=(
            "python",
            "/capacity-origin.py",
            *(("--provider-warmed",) if role == "candidate" else ()),
        )
        if artwork
        else ("uvicorn", "apps.api.main:app", "--host", "0.0.0.0", "--port", "8000"),
    )
    samples = []
    requests = []
    stop_sampling = Event()
    sampler: Thread | None = None
    generated = hashlib.sha256()
    receipt = {
        "scope": (
            "incident-source-published-unit-and-artwork"
            if artwork
            else "incident-source-published-unit"
        )
        if role == "candidate"
        else ("legacy-reader-and-artwork-workload" if artwork else "legacy-reader-workload"),
        # Each baseline shape establishes one named claim; a characterization
        # pass must never be read back as a reproduction of the incident kill.
        "baseline_claim": None
        if role != "baseline"
        else "artwork overlap reproduces the container memory kill"
        if artwork
        else "four-way reader overlap reaches the cgroup memory ceiling without a kill",
        "metadata_only": metadata_only,
        "provider_warmed_startup": role == "candidate" and artwork,
        "image": image,
        "source_sha": manifest["source_sha"] if role == "baseline" else None,
        "memory_limit_bytes": memory_bytes,
        "fixture_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "manifest_sha256": hashlib.sha256(MANIFEST.read_bytes()).hexdigest(),
        "samples": samples,
        "requests": requests,
        "sampling_interval_seconds": 0.5 if worker else 0.02,
        "readiness_attestation": "container PID1 listening socket and exact published port",
        "image_upstream": {
            "seam": "mounted startup replaces only fixture-origin DNS and HTTPX transport; actual ASGI/auth/SSRF/stream/validation",
            "fixtures": image_fixture,
        }
        if artwork
        else "not exercised in this legacy-reader stage",
        "admission_experiment": json.loads(os.environ["API_READ_ADMISSION_LIMITS"])
        if role == "candidate"
        else None,
        "decoder_experiment": json.loads(os.environ["IMAGE_DECODER_LIMITS"])
        if role == "candidate"
        else None,
    }
    try:
        local_docker(("start", name))
        inspection = json.loads(local_docker(("inspect", name)))[0]
        receipt["source_sha"] = inspection["Config"]["Labels"]["org.opencontainers.image.revision"]
        if role == "candidate":
            receipt["build_inputs"] = json.loads(
                (REPO_ROOT / "test-results/runs" / run_id / "api-build-inputs.json").read_text()
            )
        pid = inspection["State"]["Pid"]
        relative = Path(f"/proc/{pid}/cgroup").read_text().strip().removeprefix("0::")
        cgroup = Path("/sys/fs/cgroup") / relative.lstrip("/")
        receipt["container_pid"] = pid

        def sample_during_work() -> None:
            while not stop_sampling.wait(0.5 if worker else 0.02):
                try:
                    samples.append(_sample(cgroup, "running", detailed=False))
                except FileNotFoundError:
                    # Docker promptly removes an exited container's cgroup.
                    return

        sampler = Thread(target=sample_during_work)
        sampler.start()
        with httpx.Client(
            base_url=f"http://127.0.0.1:{port}",
            trust_env=False,
            timeout=30,
            headers={"Authorization": f"Bearer {token}"},
        ) as client:
            wait_api_container_ready(name, pid, port, client)
            profile = client.get("/me")
            profile.raise_for_status()
            library_id = UUID(profile.json()["data"]["default_library_id"])
            samples.append(_sample(cgroup, "authenticated-idle"))

            engine = create_engine(database_url)
            media_id = None
            try:
                with engine.begin() as db:
                    receipt["database_revision"] = db.scalar(
                        text("SELECT version_num FROM alembic_version")
                    )
                history_targets = []
                if worker:
                    from tests.testkit.unreachable_state import seed_nexus_history_growth

                    history_contract = REPO_ROOT / "testdata/contracts/nexus-history.json"
                    assert json.loads(history_contract.read_text())["maxTargets"] == 95
                    history_targets = [f"/media/{UUID(int=index + 1)}" for index in range(95)]
                    with Session(engine) as db:
                        history_recipe = seed_nexus_history_growth(
                            db, UUID(user.id), first=0, last=99_999
                        )
                        db.execute(text("ANALYZE nexus_usages"))
                        db.commit()
                    receipt["history_growth"] = {
                        "retained_rows": 100_000,
                        "candidate_count": len(history_targets),
                        "recipe_sha256": history_recipe,
                        "contract_sha256": hashlib.sha256(
                            history_contract.read_bytes()
                        ).hexdigest(),
                        "scope": "first history endpoint execution in a fresh API process, then repeat; database warm from fixture insertion and ANALYZE; no cache reset or cold-database claim",
                    }
                shape = manifest["reader_source_shape"]
                media_id = uuid4()
                first_fragment_id = uuid4()
                with Session(engine) as db:
                    db.add(
                        Media(
                            id=media_id,
                            kind="web_article",
                            title="Capacity source",
                            processing_status=ProcessingStatus.ready_for_reading,
                            created_by_user_id=UUID(user.id),
                        )
                    )
                    db.flush()
                    db.add(LibraryEntry(library_id=library_id, media_id=media_id, position=0))
                    if role == "candidate":
                        # The candidate backfills this immutable source through its
                        # actual publication owner before measuring addressed reads.
                        db.add(ReaderPublication(id=uuid4(), media_id=media_id, generation=1))
                    for index in range(shape["fragments"]):
                        # Preserve measured total bytes and largest source allocation.
                        fraction = shape["canonical_text_bytes"] / (
                            shape["html_bytes"] + shape["canonical_text_bytes"]
                        )
                        largest_text = int(shape["largest_fragment_combined_bytes"] * fraction)
                        largest_html = shape["largest_fragment_combined_bytes"] - largest_text
                        remaining = shape["fragments"] - 1
                        text_bytes = (
                            largest_text
                            if index == 0
                            else (shape["canonical_text_bytes"] - largest_text) // remaining
                        )
                        html_bytes = (
                            largest_html
                            if index == 0
                            else (shape["html_bytes"] - largest_html) // remaining
                        )
                        if index == remaining:
                            text_bytes += (shape["canonical_text_bytes"] - largest_text) % remaining
                            html_bytes += (shape["html_bytes"] - largest_html) % remaining
                        plain = ("capacity " * ((text_bytes + 8) // 9))[:text_bytes]
                        if role == "candidate" and plain.endswith(" "):
                            # Preserve the exact incident byte shape while making
                            # canonical text agree with normal HTML trailing-space trimming.
                            plain = plain[:-1] + "x"
                        html = "<p>" + plain + " " * (html_bytes - text_bytes - 7) + "</p>"
                        for value in (plain, html):
                            generated.update(len(value.encode()).to_bytes(8, "big"))
                            generated.update(value.encode())
                        db.add(
                            Fragment(
                                id=first_fragment_id if index == 0 else uuid4(),
                                media_id=media_id,
                                idx=index,
                                canonical_text=plain,
                                html_sanitized=html,
                            )
                        )
                    db.commit()

                receipt["generated_source_sha256"] = generated.hexdigest()
                with engine.begin() as db:
                    observed = db.execute(
                        text(
                            "SELECT count(*), sum(octet_length(html_sanitized)), "
                            "sum(octet_length(canonical_text)), "
                            "max(octet_length(html_sanitized)+octet_length(canonical_text)) "
                            "FROM fragments WHERE media_id=:media"
                        ),
                        {"media": media_id},
                    ).one()
                receipt["observed_source_shape"] = dict(
                    zip(
                        (
                            "fragments",
                            "html_bytes",
                            "canonical_text_bytes",
                            "largest_fragment_combined_bytes",
                        ),
                        observed,
                        strict=True,
                    )
                )
                assert receipt["observed_source_shape"] == shape
                reader_path = f"/media/{media_id}/fragments"
                reader_ref = None
                if role == "candidate":
                    from nexus.config import require_reader_publication_limits
                    from nexus.services.reader_publication import install_current_reader_publication
                    from nexus.services.reader_publication_backfill import (
                        prepare_current_reader_publication,
                    )

                    # Fixture preparation runs outside the measured API. The
                    # separate worker profile owns preparation-process capacity.
                    with prepare_current_reader_publication(
                        sessionmaker(engine, expire_on_commit=False),
                        media_id=media_id,
                        expected_generation=1,
                        limits=require_reader_publication_limits(),
                    ) as prepared:
                        with Session(engine) as db:
                            assert install_current_reader_publication(db, prepared=prepared)
                            db.commit()
                    selected = client.get(f"/media/{media_id}/reader-publication")
                    assert selected.status_code == 200, selected.text
                    descriptor = selected.json()
                    assert descriptor["media_id"] == str(media_id)
                    assert descriptor["reader_generation"] == 1
                    assert descriptor["kind"] == "web_article"
                    assert (
                        len(selected.content)
                        <= require_reader_publication_limits().descriptor_bytes
                    )
                    reader_ref = descriptor["first_unit_ref"]
                    reader_path = f"/media/{media_id}/reader-publications/1/{reader_ref['key']}"
                    receipt["publication"] = {
                        "reader_generation": 1,
                        "descriptor_bytes": len(selected.content),
                        "descriptor_sha256": hashlib.sha256(selected.content).hexdigest(),
                        "unit_count": descriptor["unit_count"],
                        "selected_unit": reader_ref,
                        "limits": json.loads(os.environ["READER_PUBLICATION_LIMITS"]),
                    }
                progress_revision = 0

                def read(path: str | None = None) -> dict:
                    nonlocal progress_revision
                    barrier.wait(timeout=30)
                    started = time.monotonic()
                    started_unix = time.time()
                    history_observation = None
                    try:
                        if path == "progress":
                            result = client.put(
                                f"/media/{media_id}/offline-reader-state",
                                headers={"X-Nexus-Expected-Account-Id": user.id},
                                json={
                                    "expectedReaderGeneration": 1,
                                    "baseRevision": progress_revision,
                                    "locator": {
                                        "kind": "web",
                                        "target": {"fragment_id": str(first_fragment_id)},
                                        "locations": {
                                            "text_offset": progress_revision + 1,
                                            "progression": None,
                                            "total_progression": None,
                                            "position": None,
                                        },
                                        "text": {
                                            "quote": None,
                                            "quote_prefix": None,
                                            "quote_suffix": None,
                                        },
                                    },
                                },
                            )
                            if result.status_code == 200:
                                state = result.json()["data"]
                                assert state["accountId"] == user.id
                                assert state["readerGeneration"] == 1
                                assert state["cursor"]["revision"] == progress_revision + 1
                                progress_revision += 1
                        elif path == "history":
                            result = client.post(
                                "/nexus/history/query",
                                json={"query": "reader", "target_hrefs": history_targets},
                            )
                            if result.status_code == 200:
                                history = result.json()["data"]
                                recent = [
                                    (row["target_href"], row["label_snapshot"], row["source"])
                                    for row in history["recent"]
                                ]
                                assert recent == [
                                    (history_targets[index], f"target-{index}:reader", "Search")
                                    for index in range(5)
                                ], "history overlap lost exact recency, tie or source semantics"
                                assert history["frecency_by_href"] == dict.fromkeys(
                                    history_targets, round(270 / 370, 6)
                                ), "history overlap changed the complete candidate scores"
                                history_observation = {
                                    "recent": recent,
                                    "frecency_by_href": history["frecency_by_href"],
                                }
                        else:
                            result = client.get(path or reader_path)
                            if (
                                path is None
                                and result.status_code == 200
                                and reader_ref is not None
                            ):
                                assert len(result.content) == reader_ref["bytes"]
                                assert (
                                    hashlib.sha256(result.content).hexdigest()
                                    == reader_ref["sha256"]
                                )
                                assert result.headers["X-Nexus-Reader-Generation"] == "1"
                                unit = result.json()
                                assert unit["fragment_id"] == str(first_fragment_id)
                                assert unit["start_cp"] == 0 and unit["end_cp"] > 0
                        error = None
                        error_parse = None
                        if result.status_code != 200:
                            try:
                                payload = result.json()
                                if isinstance(payload, dict):
                                    error = payload.get("error")
                                else:
                                    error_parse = "non-object JSON response"
                            except ValueError:
                                error_parse = "non-JSON response"
                        return {
                            "path": path or "reader",
                            "started_monotonic_seconds": started,
                            "started_unix_seconds": started_unix,
                            "status": result.status_code,
                            "error": error,
                            "error_parse": error_parse,
                            "error_body_prefix": result.content[:512].decode(
                                "utf-8", errors="replace"
                            )
                            if result.status_code != 200
                            else None,
                            "retry_after": result.headers.get("retry-after"),
                            "bytes": len(result.content),
                            "seconds": time.monotonic() - started,
                            **({"history": history_observation} if path == "history" else {}),
                        }
                    except httpx.HTTPError as exc:
                        return {
                            "path": path or "reader",
                            "started_monotonic_seconds": started,
                            "started_unix_seconds": started_unix,
                            "transport_error": type(exc).__name__,
                            "seconds": time.monotonic() - started,
                        }

                workloads = [(f"incident-read-{n}", [None] * n) for n in (1, 2, 4)]
                if artwork:
                    workloads = [
                        (
                            f"wire-cache-fill-{n}",
                            [f"/media/image?url=https://capacity-images.example/wire/{n}.png"],
                        )
                        for n in range(16)
                    ]
                    workloads += [
                        (
                            f"{fixture}-and-reader-{n}",
                            [None, None, "/readyz"]
                            + [
                                f"/media/image?url=https://capacity-images.example/{fixture}/overlap-{n}-{i}.png"
                                for i in range(n)
                            ],
                        )
                        for fixture in ("wire", "metadata")
                        for n in (1, 2, 4)
                    ]
                if metadata_only:
                    image_path = (
                        "/media/image?url=https://capacity-images.example/metadata/isolated.png"
                    )
                    workloads = [("metadata-alone", [image_path])]
                    workloads += [
                        (f"metadata-and-reader-{n}", [None] * n + ["/readyz", image_path])
                        for n in (1, 2)
                    ]
                if artwork:
                    exif_path = "/media/image?url=https://capacity-images.example/exif/isolated.jpg"
                    workloads = [("aliased-exif-alone", [exif_path])] + workloads
                if role == "candidate" and artwork:
                    workloads = [
                        (phase, paths + ["progress"] if "/readyz" in paths else paths)
                        for phase, paths in workloads
                    ]
                if worker:
                    workloads = [
                        (
                            "worker-image-reader-progress",
                            [
                                None,
                                "/readyz",
                                "progress",
                                "/media/image?url=https://capacity-images.example/metadata/worker.png",
                            ],
                        ),
                        (
                            "worker-history-first-image-progress",
                            [
                                "history",
                                "/readyz",
                                "progress",
                                "/media/image?url=https://capacity-images.example/metadata/history.png",
                            ],
                        ),
                        (
                            "worker-history-warm-progress",
                            ["history", "/readyz", "progress"],
                        ),
                    ]
                with (
                    _running_capacity_worker(engine, UUID(user.id), receipt, worker, client)
                    if worker
                    else nullcontext()
                ):
                    for phase, paths in workloads:
                        barrier = Barrier(len(paths))
                        with ThreadPoolExecutor(max_workers=len(paths)) as threads:
                            batch = list(threads.map(read, paths))
                        requests.append(
                            {"phase": phase, "concurrency": len(paths), "results": batch}
                        )
                        if not json.loads(local_docker(("inspect", name)))[0]["State"]["Running"]:
                            break
                        samples.append(_sample(cgroup, phase))
                if role == "candidate" and artwork:
                    receipt["acknowledged_progress_writes"] = progress_revision
            finally:
                try:
                    if role == "candidate" and media_id is not None:
                        from nexus.db.session import transaction
                        from nexus.services import library_entries, media_deletion
                        from nexus.storage.client import get_storage_client

                        with Session(engine) as cleanup:
                            with transaction(cleanup):
                                library_entries.delete_all_entries_for_media(cleanup, media_id)
                                paths = media_deletion.delete_document_media_if_unreferenced(
                                    cleanup, media_id
                                )
                        media_deletion.delete_document_storage_objects(
                            paths or [], get_storage_client()
                        )
                finally:
                    try:
                        if worker:
                            with Session(engine) as cleanup:
                                cleanup.execute(
                                    delete(NexusUsage).where(NexusUsage.user_id == UUID(user.id))
                                )
                                cleanup.commit()
                    finally:
                        engine.dispose()
    finally:
        stop_sampling.set()
        if sampler is not None:
            sampler.join()
        receipt["state"] = json.loads(local_docker(("inspect", name)))[0]["State"]
        receipt["logs"] = local_docker(("logs", name))
        stage = (
            "worker-epub-dense"
            if worker == "epub-dense"
            else "worker-epub"
            if worker == "epub"
            else "worker"
            if worker
            else "metadata"
            if metadata_only
            else "artwork"
            if artwork
            else "reader"
        )
        evidence = REPO_ROOT / "test-results/runs" / run_id / f"api-capacity-{role}-{stage}.json"
        # Keep every observed sample without spending the bounded artifact on
        # repeated indentation; this file remains ordinary lossless JSON.
        evidence.write_text(json.dumps(receipt, separators=(",", ":")) + "\n")
        close_owned_container(REPO_ROOT, run_id, f"api-{role}")
    assert samples and requests, "reader workload did not reach its incident evidence collection"
    return receipt


def test_incident_reader_workload() -> None:
    """Measure the incident shape: four-way reader overlap reaches the cgroup ceiling.

    This shape does not kill the container, so it owns the measurement rather
    than the kill: the deployed image drives reader reads into the configured
    memory limit, which is the headroom the candidate must stop consuming.
    """
    manifest = json.loads(MANIFEST.read_text())
    receipt = _reader_workload(manifest["image"], "baseline")
    assert any(sample["memory.events"]["max"] > 0 for sample in receipt["samples"]), (
        "reader overlap never reached the container memory ceiling on the incident image"
    )
    assert (
        max(sample["memory.peak"] for sample in receipt["samples"]) == receipt["memory_limit_bytes"]
    ), "reader overlap peaked below its own cgroup limit on the incident image"


def test_candidate_reader_admission_under_incident_overlap() -> None:
    """Serve an addressed unit of the incident source under bounded admission."""
    receipt = _reader_workload(os.environ["NEXUS_TEST_CANDIDATE_API_IMAGE"], "candidate")
    assert not receipt["state"]["OOMKilled"], "candidate reader overlap killed the API"
    assert receipt["state"]["Running"], "candidate reader overlap lost the API"
    assert all(sample["memory.events"]["max"] == 0 for sample in receipt["samples"]), (
        "candidate reader overlap exhausted its cgroup memory headroom"
    )
    results = [result for batch in receipt["requests"] for result in batch["results"]]
    assert any(result.get("status") == 503 for result in results), (
        "overlap did not exercise admission"
    )
    assert all(
        result.get("status") == 200
        or (
            result.get("status") == 503
            and result["error"]["code"] == "E_READ_CAPACITY"
            and result["retry_after"] == "1"
        )
        for result in results
    ), "candidate reader overlap escaped its success/capacity contract"


def test_incident_artwork_overlap() -> None:
    """Reproduce the incident: artwork overlap kills the deployed image's container."""
    manifest = json.loads(MANIFEST.read_text())
    receipt = _reader_workload(manifest["image"], "baseline", artwork=True)
    assert receipt["state"]["OOMKilled"], (
        "artwork overlap did not reproduce the incident's container memory kill"
    )


def test_candidate_artwork_overlap() -> None:
    receipt = _reader_workload(
        os.environ["NEXUS_TEST_CANDIDATE_API_IMAGE"], "candidate", artwork=True
    )
    _assert_candidate_artwork(receipt)


def test_candidate_metadata_overlap() -> None:
    receipt = _reader_workload(
        os.environ["NEXUS_TEST_CANDIDATE_API_IMAGE"], "candidate", artwork=True, metadata_only=True
    )
    _assert_candidate_artwork(receipt)


def test_candidate_background_worker_overlap() -> None:
    receipt = _reader_workload(
        os.environ["NEXUS_TEST_CANDIDATE_API_IMAGE"], "candidate", artwork=True, worker="pdf"
    )
    _assert_candidate_worker(receipt)


def test_candidate_epub_background_worker_overlap() -> None:
    receipt = _reader_workload(
        os.environ["NEXUS_TEST_CANDIDATE_API_IMAGE"], "candidate", artwork=True, worker="epub"
    )
    _assert_candidate_worker(receipt)


def test_candidate_dense_epub_background_worker_overlap() -> None:
    receipt = _reader_workload(
        os.environ["NEXUS_TEST_CANDIDATE_API_IMAGE"], "candidate", artwork=True, worker="epub-dense"
    )
    _assert_candidate_worker(receipt)


def _assert_candidate_worker(receipt: dict) -> None:
    from datetime import datetime

    _assert_candidate_artwork(receipt)
    worker = receipt["worker"]
    assert worker["state"]["Running"] and not worker["state"]["OOMKilled"]
    assert worker["health"]["status"] == "ready"
    assert all(sample["memory.events"]["max"] == 0 for sample in worker["samples"]), (
        "worker exhausted its actual cgroup headroom"
    )
    assert all(
        sample["memory.events"]["oom"] == 0 and sample["memory.events"]["oom_kill"] == 0
        for sample in worker["samples"]
    ), "worker child exhausted its actual cgroup"
    accepted = [
        result
        for batch in receipt["requests"]
        for result in batch["results"]
        if result.get("status") == 200
        and (result["path"] in {"reader", "history"} or result["path"].startswith("/media/image?"))
    ]
    assert len(accepted) == 5, (
        "worker composition did not admit all five reader, history and image results"
    )
    assert [
        result["path"] for result in accepted if not result["path"].startswith("/media/image?")
    ] == ["reader", "history", "history"], (
        "worker overlap omitted the first or repeated history request"
    )
    source_start = datetime.fromisoformat(worker["source_job_started_at"]).timestamp()
    source_end = datetime.fromisoformat(worker["source_job_finished_at"]).timestamp()
    assert all(
        max(source_start, result["started_unix_seconds"])
        < min(source_end, result["started_unix_seconds"] + result["seconds"])
        for result in accepted
    ), "accepted reads did not overlap the actual source job interval"
    assert all(
        any(
            max(child["first_observed"], result["started_monotonic_seconds"])
            < min(child["last_observed"], result["started_monotonic_seconds"] + result["seconds"])
            for child in worker["children"].values()
        )
        for result in accepted
    ), "accepted reads did not overlap an observed actual worker child"


def _assert_candidate_artwork(receipt: dict) -> None:
    assert not receipt["state"]["OOMKilled"], "candidate artwork overlap killed the API"
    assert receipt["state"]["Running"], "candidate artwork overlap lost the API"
    assert "capacity_provider_first_request=passed" in receipt["logs"], (
        "candidate artwork workload omitted actual selected provider first use"
    )
    assert all(sample["memory.events"]["max"] == 0 for sample in receipt["samples"]), (
        "candidate artwork overlap exhausted its cgroup memory headroom"
    )
    assert all(
        result.get("status") == 200
        or (
            (result["path"] == "reader" or result["path"].startswith("/media/image?"))
            and result.get("status") == 503
            and isinstance(result["error"], dict)
            and result["error"].get("code") == "E_READ_CAPACITY"
            and result["retry_after"] == "1"
        )
        for batch in receipt["requests"]
        for result in batch["results"]
    ), "candidate artwork overlap escaped its success/capacity contract"
