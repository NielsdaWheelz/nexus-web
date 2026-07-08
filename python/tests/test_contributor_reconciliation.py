from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.jobs.registry import get_default_registry
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_credits import (
    replace_media_contributor_credits,
    replace_podcast_contributor_credits,
)
from nexus.services.contributor_reconciliation import (
    accept_contributor_reconciliation_candidate,
    generate_contributor_reconciliation_run_for_contributors,
    generate_contributor_reconciliation_run_for_media,
    generate_contributor_reconciliation_run_for_podcast,
    list_contributor_reconciliation_candidates,
    list_contributor_reconciliation_runs,
    reject_contributor_reconciliation_candidate,
)
from nexus.tasks.contributor_reconciliation import contributor_reconciliation
from tests.factories import create_test_media_in_library

CURATOR_ROLES = frozenset({"contributor_curator"})


def _credit_row_for_media(db_session, media_id: UUID, source: str) -> tuple[UUID, str]:
    row = db_session.execute(
        text(
            """
            SELECT c.id, c.handle
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.media_id = :media_id
              AND cc.source = :source
            """
        ),
        {"media_id": media_id, "source": source},
    ).one()
    return row.id, row.handle


def _credit_row_for_podcast(db_session, podcast_id: UUID, source: str) -> tuple[UUID, str]:
    row = db_session.execute(
        text(
            """
            SELECT c.id, c.handle
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.podcast_id = :podcast_id
              AND cc.source = :source
            """
        ),
        {"podcast_id": podcast_id, "source": source},
    ).one()
    return row.id, row.handle


def _create_visible_contributor(
    db_session,
    *,
    viewer_id: UUID,
    library_id: UUID,
    display_name: str,
    source: str,
) -> tuple[UUID, str, UUID]:
    media_id = create_test_media_in_library(
        db_session,
        viewer_id,
        library_id,
        title=f"{display_name} {source} {uuid4()}",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": display_name, "role": "author", "source": source}],
        source=source,
    )
    contributor_id, handle = _credit_row_for_media(db_session, media_id, source)
    return contributor_id, handle, media_id


@pytest.mark.integration
def test_media_credit_replacement_enqueues_reconciliation_job(db_session):
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    media_id = create_test_media_in_library(
        db_session,
        viewer_id,
        library_id,
        title=f"Reconciliation Job Media {uuid4()}",
    )

    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": f"Queued Author {uuid4()}", "role": "author", "source": "rss"}],
        source="rss",
    )

    payload = db_session.execute(
        text(
            """
            SELECT payload
            FROM background_jobs
            WHERE kind = 'contributor_reconciliation'
              AND payload->>'media_id' = :media_id
            ORDER BY created_at DESC
            LIMIT 1
            """
        ),
        {"media_id": str(media_id)},
    ).scalar_one()
    assert payload["scope"] == "media"
    assert payload["reason"] == "contributor_credit_replace:rss"


@pytest.mark.integration
def test_podcast_credit_replacement_enqueues_reconciliation_job(db_session):
    podcast_id = uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url)
            VALUES (:id, 'test', :provider_podcast_id, :title, :feed_url)
            """
        ),
        {
            "id": podcast_id,
            "provider_podcast_id": f"recon-job-podcast-{podcast_id}",
            "title": "Reconciliation Job Podcast",
            "feed_url": f"https://example.com/podcasts/{podcast_id}.xml",
        },
    )

    replace_podcast_contributor_credits(
        db_session,
        podcast_id=podcast_id,
        credits=[{"name": f"Queued Host {uuid4()}", "role": "author", "source": "rss"}],
        source="rss",
    )

    payload = db_session.execute(
        text(
            """
            SELECT payload
            FROM background_jobs
            WHERE kind = 'contributor_reconciliation'
              AND payload->>'podcast_id' = :podcast_id
            ORDER BY created_at DESC
            LIMIT 1
            """
        ),
        {"podcast_id": str(podcast_id)},
    ).scalar_one()
    assert payload["scope"] == "podcast"
    assert payload["reason"] == "contributor_credit_replace:rss"


def test_contributor_reconciliation_job_rejects_malformed_payload(db_session):
    with pytest.raises(ValueError, match="podcast scope requires podcast_id"):
        contributor_reconciliation(scope="podcast", reason="test")


def test_registry_forwards_podcast_reconciliation_payload(monkeypatch):
    calls: list[dict[str, str | None]] = []

    def fake_contributor_reconciliation(
        *,
        scope: str,
        media_id: str | None = None,
        podcast_id: str | None = None,
        reason: str = "unspecified",
        request_id: str | None = None,
    ) -> dict[str, str | None]:
        call = {
            "scope": scope,
            "media_id": media_id,
            "podcast_id": podcast_id,
            "reason": reason,
            "request_id": request_id,
        }
        calls.append(call)
        return call

    monkeypatch.setattr(
        "nexus.tasks.contributor_reconciliation.contributor_reconciliation",
        fake_contributor_reconciliation,
    )
    podcast_id = str(uuid4())
    result = get_default_registry()["contributor_reconciliation"].handler(
        payload={
            "scope": "podcast",
            "podcast_id": podcast_id,
            "reason": "registry_test",
            "request_id": "request-1",
        }
    )

    assert result == {
        "scope": "podcast",
        "media_id": None,
        "podcast_id": podcast_id,
        "reason": "registry_test",
        "request_id": "request-1",
    }
    assert calls == [result]


@pytest.mark.integration
def test_generate_reconciliation_run_persists_candidates(db_session):
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    duplicate_name = f"Recon Duplicate {uuid4()}"

    media_id = create_test_media_in_library(
        db_session,
        viewer_id,
        library_id,
        title=f"Shared Duplicate Work {uuid4()}",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "rss"}],
        source="rss",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "metadata_enrichment"}],
        source="metadata_enrichment",
    )
    rss_id, rss_handle = _credit_row_for_media(db_session, media_id, "rss")
    metadata_id, metadata_handle = _credit_row_for_media(
        db_session,
        media_id,
        "metadata_enrichment",
    )

    run = generate_contributor_reconciliation_run_for_contributors(
        db_session,
        contributor_ids=[rss_id, metadata_id],
        reason="test_generate",
    )

    assert run.candidate_count == 1
    assert run.evaluated_pair_count == 1
    assert len(run.candidates) == 1
    candidate = run.candidates[0]
    assert candidate.run_id == run.id
    assert {candidate.source_contributor.handle, candidate.target_contributor.handle} == {
        rss_handle,
        metadata_handle,
    }
    assert candidate.score >= 70
    assert candidate.evidence.reason == "test_generate"
    assert candidate.evidence.shared_work_count == 1

    listed = list_contributor_reconciliation_candidates(
        db_session,
        viewer_id=viewer_id,
        run_id=run.id,
        status="pending",
    )
    assert [item.id for item in listed] == [candidate.id]

    runs = list_contributor_reconciliation_runs(db_session, limit=1)
    assert runs[0].id == run.id


@pytest.mark.integration
def test_refresh_stales_pending_candidates_that_disappear(db_session):
    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    duplicate_name = f"Recon Vanishing {uuid4()}"

    shared_media_id = create_test_media_in_library(
        db_session,
        viewer_id,
        library_id,
        title=f"Shared Vanishing Work {uuid4()}",
    )
    replacement_media_id = create_test_media_in_library(
        db_session,
        viewer_id,
        library_id,
        title=f"Replacement Visibility Work {uuid4()}",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=shared_media_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "rss"}],
        source="rss",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=shared_media_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "metadata_enrichment"}],
        source="metadata_enrichment",
    )
    metadata_id, _metadata_handle = _credit_row_for_media(
        db_session,
        shared_media_id,
        "metadata_enrichment",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=replacement_media_id,
        credits=[
            {
                "contributor_id": str(metadata_id),
                "name": f"Replacement {duplicate_name}",
                "role": "author",
                "source": "manual",
            }
        ],
        source="manual",
    )

    first_run = generate_contributor_reconciliation_run_for_media(
        db_session,
        media_id=shared_media_id,
        reason="test_stale_first",
    )
    assert first_run is not None
    assert first_run.candidates
    candidate_id = first_run.candidates[0].id

    replace_media_contributor_credits(
        db_session,
        media_id=shared_media_id,
        credits=[
            {
                "name": f"Different {duplicate_name}",
                "role": "author",
                "source": "metadata_enrichment",
            }
        ],
        source="metadata_enrichment",
    )

    second_run = generate_contributor_reconciliation_run_for_media(
        db_session,
        media_id=shared_media_id,
        reason="test_stale_second",
    )
    assert second_run is not None

    status = db_session.execute(
        text("SELECT status FROM contributor_reconciliation_candidates WHERE id = :id"),
        {"id": candidate_id},
    ).scalar_one()
    assert status == "stale"
    pending = list_contributor_reconciliation_candidates(
        db_session,
        viewer_id=viewer_id,
        run_id=first_run.id,
        status="pending",
    )
    assert pending == []


@pytest.mark.integration
def test_generate_reconciliation_run_for_podcast_contributors(db_session):
    duplicate_name = f"Recon Podcast {uuid4()}"
    podcast_id = uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO podcasts (id, provider, provider_podcast_id, title, feed_url)
            VALUES (:id, 'test', :provider_podcast_id, :title, :feed_url)
            """
        ),
        {
            "id": podcast_id,
            "provider_podcast_id": f"recon-podcast-{podcast_id}",
            "title": "Reconciliation Podcast",
            "feed_url": f"https://example.com/podcasts/{podcast_id}.xml",
        },
    )
    replace_podcast_contributor_credits(
        db_session,
        podcast_id=podcast_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "rss"}],
        source="rss",
    )
    replace_podcast_contributor_credits(
        db_session,
        podcast_id=podcast_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "metadata_enrichment"}],
        source="metadata_enrichment",
    )
    _rss_id, rss_handle = _credit_row_for_podcast(db_session, podcast_id, "rss")
    _metadata_id, metadata_handle = _credit_row_for_podcast(
        db_session,
        podcast_id,
        "metadata_enrichment",
    )

    run = generate_contributor_reconciliation_run_for_podcast(
        db_session,
        podcast_id=podcast_id,
        reason="test_podcast",
    )

    assert run is not None
    assert run.candidate_count == 1
    candidate = run.candidates[0]
    assert {candidate.source_contributor.handle, candidate.target_contributor.handle} == {
        rss_handle,
        metadata_handle,
    }
    assert {candidate.evidence.source_handle, candidate.evidence.target_handle} == {
        rss_handle,
        metadata_handle,
    }
    assert candidate.score >= 70
    assert candidate.evidence.reason == "test_podcast"
    assert candidate.evidence.shared_work_count == 1


@pytest.mark.integration
def test_accept_reconciliation_candidate_uses_merge_and_stales_related_candidates(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})

    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    duplicate_name = f"Recon Accept {uuid4()}"

    shared_media_id = create_test_media_in_library(
        db_session,
        viewer_id,
        library_id,
        title=f"Shared Accept Work {uuid4()}",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=shared_media_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "rss"}],
        source="rss",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=shared_media_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "metadata_enrichment"}],
        source="metadata_enrichment",
    )
    rss_id, rss_handle = _credit_row_for_media(db_session, shared_media_id, "rss")
    metadata_id, _metadata_handle = _credit_row_for_media(
        db_session,
        shared_media_id,
        "metadata_enrichment",
    )

    curated_id, _curated_handle, _curated_media_id = _create_visible_contributor(
        db_session,
        viewer_id=viewer_id,
        library_id=library_id,
        display_name=duplicate_name,
        source="youtube_metadata",
    )

    run = generate_contributor_reconciliation_run_for_contributors(
        db_session,
        contributor_ids=[rss_id, metadata_id, curated_id],
        reason="test_accept",
    )

    target_candidate = run.candidates[0]

    merged = accept_contributor_reconciliation_candidate(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        candidate_id=target_candidate.id,
    )

    assert merged.handle == target_candidate.target_contributor.handle

    accepted_status = db_session.execute(
        text(
            """
            SELECT status
            FROM contributor_reconciliation_candidates
            WHERE id = :candidate_id
            """
        ),
        {"candidate_id": target_candidate.id},
    ).scalar_one()
    assert accepted_status == "accepted"
    accepted = list_contributor_reconciliation_candidates(
        db_session,
        viewer_id=viewer_id,
        run_id=run.id,
        status="accepted",
    )
    assert [item.id for item in accepted] == [target_candidate.id]

    related_statuses = db_session.execute(
        text(
            """
            SELECT status
            FROM contributor_reconciliation_candidates
            WHERE id != :candidate_id
              AND run_id = :run_id
            ORDER BY id
            """
        ),
        {"candidate_id": target_candidate.id, "run_id": run.id},
    ).fetchall()
    assert related_statuses
    assert all(row.status == "stale" for row in related_statuses)
    stale = list_contributor_reconciliation_candidates(
        db_session,
        viewer_id=viewer_id,
        run_id=run.id,
        status="stale",
    )
    assert {item.id for item in stale} == {
        row.id
        for row in db_session.execute(
            text(
                """
                SELECT id
                FROM contributor_reconciliation_candidates
                WHERE id != :candidate_id
                  AND run_id = :run_id
                """
            ),
            {"candidate_id": target_candidate.id, "run_id": run.id},
        )
    }

    source_status = db_session.execute(
        text("SELECT status FROM contributors WHERE handle = :handle"),
        {"handle": target_candidate.source_contributor.handle},
    ).scalar_one()
    assert source_status == "merged"


@pytest.mark.integration
def test_reject_reconciliation_candidate_marks_candidate_rejected(db_session):
    actor_user_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": actor_user_id})

    viewer_id = uuid4()
    library_id = ensure_user_and_default_library(db_session, viewer_id)
    duplicate_name = f"Recon Reject {uuid4()}"

    media_id = create_test_media_in_library(
        db_session,
        viewer_id,
        library_id,
        title=f"Shared Reject Work {uuid4()}",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "rss"}],
        source="rss",
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": duplicate_name, "role": "author", "source": "metadata_enrichment"}],
        source="metadata_enrichment",
    )
    rss_id, _rss_handle = _credit_row_for_media(db_session, media_id, "rss")
    metadata_id, _metadata_handle = _credit_row_for_media(
        db_session,
        media_id,
        "metadata_enrichment",
    )

    run = generate_contributor_reconciliation_run_for_contributors(
        db_session,
        contributor_ids=[rss_id, metadata_id],
        reason="test_reject",
    )

    candidate = reject_contributor_reconciliation_candidate(
        db_session,
        actor_user_id=actor_user_id,
        actor_roles=CURATOR_ROLES,
        candidate_id=run.candidates[0].id,
    )

    assert candidate.status == "rejected"
    assert candidate.decided_by_user_id == actor_user_id
    rejected = list_contributor_reconciliation_candidates(
        db_session,
        viewer_id=viewer_id,
        run_id=run.id,
        status="rejected",
    )
    assert [item.id for item in rejected] == [candidate.id]
