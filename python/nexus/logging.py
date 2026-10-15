"""Structured json logs (structlog), each line carrying its request's context.

The edge middleware binds ``request_id``, ``path`` and ``method`` per request; chat runs
bind ``flow_id``. A line carries the ones that are set; ``path`` never includes the query.
"""

import logging
import sys
from contextvars import ContextVar

import structlog

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
_path: ContextVar[str | None] = ContextVar("path", default=None)
_method: ContextVar[str | None] = ContextVar("method", default=None)
_flow_id: ContextVar[str | None] = ContextVar("flow_id", default=None)
_CONTEXT = {"request_id": _request_id, "path": _path, "method": _method, "flow_id": _flow_id}


def _add_context(logger: logging.Logger, method_name: str, event: dict) -> dict:
    for name, var in _CONTEXT.items():
        value = var.get()
        if value:
            event[name] = value
    return event


def configure_logging() -> None:
    shared = [
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        _add_context,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
    ]
    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=shared,
            processors=[
                structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                structlog.processors.JSONRenderer(),
            ],
        )
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    for noisy in ("httpx", "httpcore", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)


def bind_request(request_id: str, *, path: str, method: str) -> None:
    """This request's context, for the rest of its task (each request runs in its own)."""
    _request_id.set(request_id)
    _path.set(path)
    _method.set(method)
    _flow_id.set(None)


def set_flow_id(flow_id: str | None) -> None:
    _flow_id.set(flow_id)


def get_request_id() -> str | None:
    return _request_id.get()
