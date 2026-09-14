"""Measure unmodified image imports inside its own memory cgroup."""

import asyncio
import json
import os
import resource
import sys
import time
from pathlib import Path


def record(phase: str) -> None:
    cgroup = Path("/sys/fs/cgroup")
    memory = {
        name: int(value)
        for name, value in (
            line.split() for line in (cgroup / "memory.stat").read_text().splitlines()
        )
    }
    print(
        json.dumps(
            {
                "phase": phase,
                "pid": os.getpid(),
                "monotonic_seconds": time.monotonic(),
                "memory_current_bytes": int((cgroup / "memory.current").read_text()),
                "memory_peak_bytes": int((cgroup / "memory.peak").read_text()),
                "memory_stat_bytes": {
                    key: memory[key] for key in ("anon", "file", "kernel")
                },
                "memory_events": {
                    name: int(value)
                    for name, value in (
                        line.split()
                        for line in (cgroup / "memory.events").read_text().splitlines()
                    )
                },
                "process_maxrss_bytes": resource.getrusage(
                    resource.RUSAGE_SELF
                ).ru_maxrss
                * 1024,
                "vendor_modules": sorted(
                    name
                    for name in ("openai", "anthropic", "google.genai")
                    if name in sys.modules
                ),
            }
        ),
        flush=True,
    )


record("interpreter")

from provider_runtime import Credentials, ProviderRuntime  # noqa: E402

ProviderRuntime(Credentials())
record("provider-runtime-construction")

import nexus.app  # noqa: E402

record("api-import")
nexus.app.create_app()
record("api-created")

from capacity_provider_first_request import first_request  # noqa: E402

asyncio.run(first_request())
record("selected-provider-first-request")
