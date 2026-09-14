"""A bounds acknowledgment describes state loaded after the actual row lock."""

import threading
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import Highlight
from nexus.schemas.highlights import PdfAnchorUpdateRequest, UpdateHighlightRequest
from nexus.services.highlight_access import get_highlight_for_author_write_or_404
from nexus.services.highlights import update_highlight
from tests.testkit.reader_pdf import published_pdf_sources
from tests.testkit.worker import wait_for_backend_lock


def test_pdf_bounds_acknowledge_state_reloaded_after_competing_commit(
    engine: Engine,
) -> None:
    with published_pdf_sources(engine) as fixture:
        engine, factory, user_id, quad, digests = (
            fixture.engine,
            fixture.factory,
            fixture.user_id,
            fixture.quad,
            fixture.digests,
        )
        highlight_id = fixture.highlights[0]
        # Pane A loads its old selection before pane B commits a different source.
        # Hold B's real transaction open after its service-level savepoint commit;
        # observe A waiting in PostgreSQL, then release B. The final database
        # state, not the stale response object, is the acknowledgment oracle.
        loaded, proceed = threading.Event(), threading.Event()
        backend_pid = []

        def restore_old_selection():
            with factory() as stale:
                value = get_highlight_for_author_write_or_404(stale, user_id, highlight_id)
                assert value.pdf_anchor.source_sha256 == digests[0]
                assert len(value.pdf_quads) == 1
                backend_pid.append(stale.scalar(text("SELECT pg_backend_pid()")))
                loaded.set()
                assert proceed.wait(timeout=5)
                return update_highlight(
                    stale,
                    user_id,
                    highlight_id,
                    UpdateHighlightRequest(
                        anchor=PdfAnchorUpdateRequest(
                            reader_generation=1, page_number=1, quads=[quad]
                        ),
                        exact="original",
                    ),
                )

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(restore_old_selection)
            assert loaded.wait(timeout=5)
            with engine.connect() as connection:
                transaction = connection.begin()
                try:
                    with Session(
                        bind=connection, join_transaction_mode="create_savepoint"
                    ) as competing:
                        displaced = quad.model_copy(update={"x1": 30, "x4": 30, "x2": 40, "x3": 40})
                        update_highlight(
                            competing,
                            user_id,
                            highlight_id,
                            UpdateHighlightRequest(
                                anchor=PdfAnchorUpdateRequest(
                                    reader_generation=2, page_number=1, quads=[displaced]
                                ),
                                exact="replacement",
                            ),
                        )
                    proceed.set()
                    wait_for_backend_lock(engine, backend_pid[0])
                    transaction.commit()
                finally:
                    if transaction.is_active:
                        transaction.rollback()
                    proceed.set()
            acknowledged = future.result(timeout=5)
        assert acknowledged.anchor.source_sha256 == digests[0]
        with factory() as db:
            restored = db.get(Highlight, highlight_id)
            assert restored.pdf_anchor.source_sha256 == digests[0], (
                "pdf bounds acknowledged a stale source"
            )
            assert restored.exact == "original" and restored.pdf_quads[0].x1 == 10
