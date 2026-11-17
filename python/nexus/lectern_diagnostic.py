"""One settings-free, read-only Lectern profile; deployment owns its isolated lifetime."""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import sys
import time
from pathlib import Path
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from nexus.release_artifact import load_runtime_identity

type DiagnosticError = Literal[
    "maintenance_busy",
    "deployment_changed",
    "database_refused",
    "profile_failed",
    "deadline",
    "cleanup_unconfirmed",
]
_Hash = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
_Milliseconds = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class StatementTiming(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    sql_sha256: _Hash
    execute_ms: _Milliseconds
    sqlstate: Annotated[str, Field(pattern=r"^[A-Z0-9]{5}$")] | None


class LecternDiagnosticReport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    run_id: str
    status: Literal["complete", "refused", "failed", "cleanup_unconfirmed"] = "refused"
    source_sha: Annotated[str, Field(pattern=r"^[0-9a-f]{40}$")] | None = None
    image_id: Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")] | None = None
    owner_ms: _Milliseconds | None = None
    db_execute_ms: _Milliseconds | None = None
    item_count: Annotated[int, Field(ge=0)] | None = None
    result_sha256: _Hash | None = None
    statements: list[StatementTiming] = Field(default_factory=list)
    error_code: DiagnosticError | None = None
    cleanup_complete: bool | None = None
    serving_unchanged: bool | None = None


def profile(viewer: UUID, run_id: UUID, expected_source: str) -> LecternDiagnosticReport:
    report = LecternDiagnosticReport(run_id=str(run_id))
    engine = None
    measuring = False
    active: tuple[str, float] | None = None

    def interrupted(_signum: int, _frame: object) -> None:
        raise TimeoutError

    def record(sqlstate: str | None = None) -> None:
        nonlocal active
        if active is not None:
            digest, started = active
            report.statements.append(
                StatementTiming(
                    sql_sha256=digest,
                    execute_ms=(time.monotonic() - started) * 1000,
                    sqlstate=sqlstate,
                )
            )
            active = None

    signal.signal(signal.SIGTERM, interrupted)
    try:
        identity = load_runtime_identity(Path("/app/runtime-identity.json"))
        report.source_sha = identity.source_sha
        if identity.source_sha != expected_source:
            report.error_code = "deployment_changed"
            return report
        url = make_url(os.environ["DATABASE_URL"])
        if (url.drivername, url.host, url.port, url.database, url.username) != (
            "postgresql+psycopg",
            "postgres",
            5432,
            "nexus",
            "nexus_runtime",
        ):
            report.error_code = "database_refused"
            return report
        engine = create_engine(
            url,
            poolclass=NullPool,
            hide_parameters=True,
            connect_args={
                "connect_timeout": 2,
                "prepare_threshold": None,
                "application_name": f"nexus:inspect:lectern:{run_id}",
                "options": "-c jit=off -c default_transaction_read_only=on"
                " -c statement_timeout=30000 -c lock_timeout=1000"
                " -c idle_in_transaction_session_timeout=60000",
            },
        )

        @event.listens_for(engine, "before_cursor_execute")
        def before(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
            nonlocal active
            if measuring:
                active = hashlib.sha256(statement.encode()).hexdigest(), time.monotonic()

        @event.listens_for(engine, "after_cursor_execute")
        def after(*_args: Any) -> None:
            record()

        @event.listens_for(engine, "handle_error")
        def failed(context: Any) -> None:
            state = getattr(context.original_exception, "sqlstate", None)
            record(
                state if isinstance(state, str) and re.fullmatch(r"[A-Z0-9]{5}", state) else None
            )

        with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
            with Session(connection, autoflush=False, expire_on_commit=False) as db:
                try:
                    db.execute(text("SET TRANSACTION READ ONLY"))
                    facts = db.execute(
                        text("""SELECT current_user,
                        current_setting('transaction_read_only'),
                        current_setting('transaction_isolation'),
                        (SELECT version_num FROM alembic_version),
                        EXISTS(SELECT 1 FROM users WHERE id=:viewer)"""),
                        {"viewer": viewer},
                    ).one()
                    if tuple(facts) != (
                        "nexus_runtime",
                        "on",
                        "repeatable read",
                        identity.expected_database_revision,
                        True,
                    ):
                        report.error_code = "database_refused"
                        return report
                    report.status = "failed"
                    from nexus.services.consumption import lectern, observation

                    measuring = True
                    started = time.monotonic()
                    data = lectern.get_lectern(db, viewer)
                    result = observation.stamp(
                        db, viewer, data, [item.media_summary.media_id for item in data.items]
                    ).model_dump(mode="json")
                    result["episode_consumption"].sort(key=lambda entry: entry["media_id"])
                    encoded = json.dumps(
                        result, sort_keys=True, separators=(",", ":"), ensure_ascii=False
                    )
                    report.owner_ms = (time.monotonic() - started) * 1000
                    report.db_execute_ms = sum(entry.execute_ms for entry in report.statements)
                    report.item_count = len(data.items)
                    report.result_sha256 = hashlib.sha256(encoded.encode()).hexdigest()
                finally:
                    measuring = False
                    db.rollback()
        report.status = "complete"
    except TimeoutError:
        report.status, report.error_code = "failed", "deadline"
    except Exception:
        # justify-defect: this operator privacy boundary reports failure, never raw SQL/row inputs.
        report.status, report.error_code = "failed", "profile_failed"
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if engine is not None:
            try:
                engine.dispose()
            except Exception:
                # justify-defect: cleanup failure invalidates the profile without leaking driver inputs.
                report.status, report.error_code = "failed", "profile_failed"
    return report


if __name__ == "__main__":
    result = profile(UUID(sys.argv[1]), UUID(sys.argv[2]), sys.argv[3])
    print(result.model_dump_json())
    sys.exit(0 if result.status == "complete" else 1)
