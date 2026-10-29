"""Finite search watchdogs, not latency targets.

Foreground provider work, admission and reads share the caller's original deadline.
Background computation starts after provider work; retirement has its own owner.
"""

BACKGROUND_COMPUTATION_SECONDS = 30.0
FOREGROUND_SEARCH_SECONDS = 115.0
