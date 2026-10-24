"""queue adapter for the piece discovery owner; no independent state or retry loop."""

from collections.abc import Mapping
from typing import Any

from nexus.jobs.queue import JobExecutionContext, JobResult
from nexus.services.part_discovery import run_discovery_job


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    return run_discovery_job(payload=payload, context=context)
