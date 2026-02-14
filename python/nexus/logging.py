"""Structured logging configuration using structlog.

Provides JSON-formatted logs with consistent context including:
- request_id: Correlation ID for request tracing
- user_id: Authenticated user (when available)
- path: Raw request path (never includes query string)
- method: HTTP method
- route_template: FastAPI route template (when available after routing)
- flow_id: Correlation ID for multi-phase send-message flows
- stream_jti: JWT ID from stream token (streaming only)
- task_name / task_id: Celery task context
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

# PR-09: Additional context variables for observability
path_var: ContextVar[str | None] = ContextVar("path", default=None)
method_var: ContextVar[str | None] = ContextVar("method", default=None)
route_template_var: ContextVar[str | None] = ContextVar("route_template", default=None)
flow_id_var: ContextVar[str | None] = ContextVar("flow_id", default=None)
stream_jti_var: ContextVar[str | None] = ContextVar("stream_jti", default=None)


def add_request_context(logger: logging.Logger, method_name: str, event_dict: dict) -> dict:
    """Add request context to all log entries.

    Injects all non-None ContextVar values into the log event dict.
    """
    request_id = request_id_var.get()
    user_id = user_id_var.get()
    task_name = task_name_var.get()
    task_id = task_id_var.get()
    path = path_var.get()
    method = method_var.get()
    route_template = route_template_var.get()
    flow_id = flow_id_var.get()
    stream_jti = stream_jti_var.get()

    if request_id:
        event_dict["request_id"] = request_id
    if user_id:
        event_dict["user_id"] = user_id
    if task_name:
        event_dict["task_name"] = task_name
    if task_id:
        event_dict["task_id"] = task_id
    if path:
        event_dict["path"] = path
    if method:
        event_dict["method"] = method
    if route_template:
        event_dict["route_template"] = route_template
    if flow_id:
        event_dict["flow_id"] = flow_id
    if stream_jti:
        event_dict["stream_jti"] = stream_jti

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


def set_request_context(
    request_id: str | None,
    user_id: str | None = None,
    path: str | None = None,
    method: str | None = None,
) -> None:
    """Set request context for the current async context.

    Args:
        request_id: The request correlation ID.
        user_id: The authenticated user ID (optional).
        path: Raw request path (optional, no query string).
        method: HTTP method (optional).
    """
    request_id_var.set(request_id)
    if user_id is not None:
        user_id_var.set(user_id)
    if path is not None:
        path_var.set(path)
    if method is not None:
        method_var.set(method)


def set_route_template(template: str | None) -> None:
    """Set route template after routing has matched.

    Called downstream (in route handlers or dependencies) once
    the FastAPI route path template is known.

    Args:
        template: The route path template (e.g., "/conversations/{id}/messages").
    """
    route_template_var.set(template)


def set_flow_id(flow_id: str | None) -> None:
    """Set flow_id for multi-phase send-message correlation.

    Args:
        flow_id: UUID string for the current send flow.
    """
    flow_id_var.set(flow_id)


def set_stream_jti(jti: str | None) -> None:
    """Set stream JTI for stream token correlation.

    Args:
        jti: JWT ID from verified stream token.
    """
    stream_jti_var.set(jti)


def clear_request_context() -> None:
    """Clear all request-scoped context at the end of a request."""
    request_id_var.set(None)
    user_id_var.set(None)
    path_var.set(None)
    method_var.set(None)
    route_template_var.set(None)
    flow_id_var.set(None)
    stream_jti_var.set(None)


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
