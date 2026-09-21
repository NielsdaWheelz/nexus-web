"""Dependency-light admission failures for domain workers.

``chat_runs`` and ``llm_execution`` catch these without importing the model-tool
runtime, whose executable definitions exceed the interactive worker memory cap.
"""

from __future__ import annotations


class GenerationOperationUnavailable(RuntimeError):
    """Current route or required tool readiness blocks work without fallback."""

    def __init__(self, operation: str, reason: object) -> None:
        super().__init__(f"generation operation {operation!r} is currently unavailable")
        self.operation = operation
        self.reason = reason


class GenerationConfigurationDefect(AssertionError):
    """Reviewed policy/catalog/tool facts cannot compose one exact admission."""
