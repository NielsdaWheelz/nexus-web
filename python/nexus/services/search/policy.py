"""Finite search watchdogs, not latency targets.

Foreground provider work, admission and reads share the caller's original deadline.
Background reads use the configured child wall allowance, not a separate short
ceiling. The child still bounds the whole handler, including work before the read
and retirement; starting a read cannot extend that owner's wall clock.
Forced child termination does not promise joined cleanup.
"""

import asyncio

from nexus.config import get_settings

FOREGROUND_SEARCH_SECONDS = 115.0


def background_computation_deadline() -> float:
    """The existing child allowance; its earlier whole-handler watchdog still wins."""
    return (
        asyncio.get_running_loop().time() + get_settings().background_process_wall_timeout_seconds
    )
