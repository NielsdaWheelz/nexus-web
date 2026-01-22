"""Structured logging configuration using structlog.

Provides JSON-formatted logs with consistent context including:
- request_id: Correlation ID for request tracing
- user_id: Authenticated user (when available)
- timestamp: ISO8601 formatted timestamp

Usage:
    from nexus.logging import get_logger, configure_logging

    # Configure once at startup
    configure_logging()

    # Get a logger for a module
    logger = get_logger(__name__)
    logger.info("something_happened", extra_field="value")

Celery Task Logging:
    from nexus.logging import configure_task_logging, get_logger

    @celery.task
    def my_task(arg, request_id: str | None = None):
        configure_task_logging(request_id=request_id, task_name="my_task", task_id=self.request.id)
        logger = get_logger(__name__)
        logger.info("task_started")
"""

import logging
import sys
from contextvars import ContextVar

import structlog

# Context variables for request-scoped logging
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)
task_name_var: ContextVar[str | None] = ContextVar("task_name", default=None)
task_id_var: ContextVar[str | None] = ContextVar("task_id", default=None)


def add_request_context(logger: logging.Logger, method_name: str, event_dict: dict) -> dict:
    """Add request context (request_id, user_id, task_name, task_id) to all log entries."""
    request_id = request_id_var.get()
    user_id = user_id_var.get()
    task_name = task_name_var.get()
    task_id = task_id_var.get()

    if request_id:
        event_dict["request_id"] = request_id
    if user_id:
        event_dict["user_id"] = user_id
    if task_name:
        event_dict["task_name"] = task_name
    if task_id:
        event_dict["task_id"] = task_id

    return event_dict


def configure_logging(json_format: bool = True) -> None:
    """Configure structlog for the application.

    Args:
        json_format: If True, output JSON logs. If False, output console-friendly logs.
    """
    # Shared processors for both stdlib and structlog loggers
    shared_processors = [
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        add_request_context,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
    ]

    if json_format:
        # JSON format for production/structured logging
        renderer = structlog.processors.JSONRenderer()
    else:
        # Console format for development
        renderer = structlog.dev.ConsoleRenderer()

    structlog.configure(
        processors=shared_processors
        + [
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    # Configure stdlib logging to use structlog formatting
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared_processors,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            renderer,
        ],
    )

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.handlers.clear()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)

    # Silence noisy loggers
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """Get a structlog logger for the given name.

    Args:
        name: Logger name (typically __name__).

    Returns:
        A bound structlog logger.
    """
    return structlog.get_logger(name)


def set_request_context(request_id: str | None, user_id: str | None = None) -> None:
    """Set request context for the current async context.

    Args:
        request_id: The request correlation ID.
        user_id: The authenticated user ID (optional).
    """
    request_id_var.set(request_id)
    user_id_var.set(user_id)


def clear_request_context() -> None:
    """Clear request context at the end of a request."""
    request_id_var.set(None)
    user_id_var.set(None)


def get_request_id() -> str | None:
    """Get the current request ID from context."""
    return request_id_var.get()


def configure_task_logging(
    request_id: str | None = None,
    task_name: str | None = None,
    task_id: str | None = None,
) -> None:
    """Configure logging context for a Celery task.

    Call this at the start of each Celery task to set up proper logging context.
    All subsequent log entries in the task will include these fields.

    Args:
        request_id: The request correlation ID (passed from FastAPI when task was enqueued).
        task_name: The name of the Celery task.
        task_id: The Celery task ID (from self.request.id).

    Example:
        @celery.task(bind=True)
        def my_task(self, arg, request_id: str | None = None):
            configure_task_logging(
                request_id=request_id,
                task_name="my_task",
                task_id=self.request.id
            )
            logger.info("task_started")
    """
    request_id_var.set(request_id)
    task_name_var.set(task_name)
    task_id_var.set(task_id)


def clear_task_context() -> None:
    """Clear task context at the end of a task."""
    request_id_var.set(None)
    task_name_var.set(None)
    task_id_var.set(None)
    user_id_var.set(None)
