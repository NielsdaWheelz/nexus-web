"""CP1 RED contract tests — Universal Dossier build lifecycle & concurrency (T4).

Test-first for the hard cutover in
``docs/cutovers/resource-inspector-and-universal-dossiers-hard-cutover.md``.

These import the CANONICAL A19 target identifiers (``services/artifacts/engine``
public API, ``services/artifacts/dossier_types``, ``services/artifacts/handles``)
which do NOT exist yet, so this module fails at COLLECTION with ImportError.
That is the intended RED. Once CP2 lands those modules and they behave per
CONTRACTS.md §A5/§A6/§A19, these pass WITHOUT edits.

Contract source: CONTRACTS.md A6 (rules 1-10), A5 (data contract), A19
(create_build/run_build/cancel_build/make_current/read_head/on_subject_deleted,
BuildTicket, typed exceptions, ArtifactBuildEventType). REDTESTS.md T4.
"""

from __future__ import annotations

import asyncio
import json
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Contributor, ContributorCredit, Page
from nexus.jobs.queue import JobExecutionContext

# --- CANONICAL A19 targets (do not exist yet -> ImportError == the RED) -------
from nexus.services.artifacts.bindings import BINDINGS  # noqa: E402
from nexus.services.artifacts.dossier_types import (  # noqa: E402
    ArtifactBuildEventType,
    AudienceUser,
    BuildNotActive,
    DossierBuildFailureCode,
    DossierGenerationInProgress,
    DossierSubjectLocator,  # noqa: F401  (pins the union name)
    InvalidSubjectLocator,
    RevisionNotFound,
    RevisionNotOwnedByHead,
    SubjectContributor,
    SubjectResource,
)
from nexus.services.artifacts.engine import (  # noqa: E402
    BuildTicket,
    cancel_build,
    create_build,
    make_current,
    on_subject_audience_removed,
    on_subject_deleted,
    on_user_deleted,
    read_head,
    run_build,
)
from nexus.services.artifacts.handles import (  # noqa: E402
    InvalidArtifactBuildHandle,
    seal_artifact_build,
    unseal_artifact_build,
)
from nexus.services.artifacts.subject_policy import SUBJECT_POLICIES
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_taxonomy import parse_contributor_handle
from nexus.services.contributors import prune_contributors_if_orphaned
from nexus.services.library_governance import delete_library, remove_library_member
from nexus.services.media_deletion import delete_document_for_viewer
from nexus.services.resource_graph.citations import record_citation
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot
from tests.factories import (
    add_library_member,
    add_media_to_library,
    create_searchable_media_in_library,
    create_test_conversation,
    create_test_library,
    create_test_library_artifact,
    create_test_message,
)
from tests.utils.dossier_jobs import claim_dossier_build_job

pytestmark = pytest.mark.integration


# --- local fixtures (kept LOCAL to this module; no shared-conftest edits) -----


@pytest.fixture(autouse=True)
def _engine_session_factory(monkeypatch, db_session):
    """Route the engine's internal ``get_session_factory()`` onto this test's
    savepoint connection (same pattern as test_media_intelligence)."""
    from tests.utils.db import task_session_factory

    monkeypatch.setattr(
        "nexus.services.artifacts.engine.get_session_factory",
        lambda: task_session_factory(db_session),
        raising=False,
    )


@pytest.fixture(autouse=True)
def _rate_limiter(db_session):
    from nexus.services.rate_limit import RateLimiter, get_rate_limiter, set_rate_limiter
    from tests.utils.db import task_session_factory

    previous = get_rate_limiter()
    set_rate_limiter(RateLimiter(session_factory=task_session_factory(db_session)))
    yield
    set_rate_limiter(previous)


class _NoDispatchRuntime:
    """A fake ExecutionRuntime that FAILS the test if the provider is dispatched.

    Pre-dispatch modeled failures (e.g. NoSourceMaterial) must never call the
    provider — CONTRACTS A7 precedence rule 1 fires before dispatch.
    """

    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, intent, plan, credential):  # noqa: ANN001
        self.calls += 1
        raise AssertionError("provider dispatch must not occur for a pre-dispatch failure")

    def stream(self, intent, plan, credential, *, cancel):  # noqa: ANN001, pragma: no cover
        raise NotImplementedError


def _user(db: Session) -> UUID:
    uid = uuid4()
    ensure_user_and_default_library(db, uid)
    return uid


def _conversation_locator(db: Session, owner_id: UUID, *, with_messages: bool) -> SubjectResource:
    conv_id = create_test_conversation(db, owner_id)
    if with_messages:
        create_test_message(db, conv_id, seq=1, role="user", content="Discuss the core idea.")
        create_test_message(
            db, conv_id, seq=2, role="assistant", content="A substantive settled answer."
        )
    return SubjectResource(ref=ResourceRef(scheme="conversation", id=conv_id))


def _claim_build_ctx(
    db: Session,
    *,
    build_id: UUID,
    worker_id: str = "w-test",
) -> JobExecutionContext:
    job = claim_dossier_build_job(
        db,
        build_id=build_id,
        worker_id=worker_id,
    )
    return JobExecutionContext(job_id=job.id, worker_id=worker_id, attempt_no=job.attempts)


def test_last_library_visibility_path_removal_purges_user_dossier(
    db_session: Session,
) -> None:
    owner_id = _user(db_session)
    member_id = _user(db_session)
    library_id = create_test_library(db_session, owner_id)
    add_library_member(db_session, library_id, member_id)
    media_id = create_searchable_media_in_library(
        db_session,
        owner_id,
        library_id,
        title="Shared only",
    )
    ticket = create_build(
        db_session,
        locator=SubjectResource(ref=ResourceRef(scheme="media", id=media_id)),
        requester_user_id=member_id,
        idempotency_key="visibility-loss",
        instruction=None,
    )

    remove_library_member(db_session, owner_id, library_id, member_id)

    assert db_session.execute(
        text("SELECT count(*) FROM artifacts WHERE id = :artifact_id"),
        {"artifact_id": ticket.artifact_id},
    ).scalar_one() == 0
    assert db_session.execute(
        text("SELECT count(*) FROM background_jobs WHERE dedupe_key = :dedupe_key"),
        {"dedupe_key": f"dossier_build:{ticket.build_id}"},
    ).scalar_one() == 0


def test_shared_library_delete_rechecks_every_members_user_dossiers(
    db_session: Session,
) -> None:
    owner_id = _user(db_session)
    member_id = _user(db_session)
    surviving_owner_id = _user(db_session)
    shared_library_id = create_test_library(db_session, owner_id)
    add_library_member(db_session, shared_library_id, member_id)
    surviving_library_id = create_test_library(db_session, surviving_owner_id)
    media_id = create_searchable_media_in_library(
        db_session,
        owner_id,
        shared_library_id,
        title="Shared path removed",
    )
    add_media_to_library(db_session, surviving_library_id, media_id)
    db_session.commit()
    tickets = [
        create_build(
            db_session,
            locator=SubjectResource(ref=ResourceRef(scheme="media", id=media_id)),
            requester_user_id=user_id,
            idempotency_key=f"shared-library-delete-{user_id}",
            instruction=None,
        )
        for user_id in (owner_id, member_id)
    ]
    surviving_ticket = create_build(
        db_session,
        locator=SubjectResource(ref=ResourceRef(scheme="media", id=media_id)),
        requester_user_id=surviving_owner_id,
        idempotency_key="shared-library-delete-survivor",
        instruction=None,
    )

    delete_library(db_session, owner_id, shared_library_id)

    assert db_session.execute(
        text("SELECT count(*) FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).scalar_one() == 1
    for ticket in tickets:
        assert db_session.execute(
            text("SELECT count(*) FROM artifacts WHERE id = :artifact_id"),
            {"artifact_id": ticket.artifact_id},
        ).scalar_one() == 0
        assert db_session.execute(
            text("SELECT count(*) FROM background_jobs WHERE dedupe_key = :dedupe_key"),
            {"dedupe_key": f"dossier_build:{ticket.build_id}"},
        ).scalar_one() == 0
    assert db_session.execute(
        text("SELECT count(*) FROM artifacts WHERE id = :artifact_id"),
        {"artifact_id": surviving_ticket.artifact_id},
    ).scalar_one() == 1


def test_last_visible_work_removal_purges_media_and_contributor_user_dossiers(
    db_session: Session,
) -> None:
    viewer_id = _user(db_session)
    surviving_owner_id = _user(db_session)
    viewer_library_id = create_test_library(db_session, viewer_id)
    surviving_library_id = create_test_library(db_session, surviving_owner_id)
    media_id = create_searchable_media_in_library(
        db_session,
        viewer_id,
        viewer_library_id,
        title="Last visible authored work",
    )
    add_media_to_library(db_session, surviving_library_id, media_id)
    contributor = Contributor(
        id=uuid4(),
        handle=f"last-visible-{uuid4().hex[:12]}",
        display_name="Last Visible Contributor",
    )
    db_session.add(contributor)
    db_session.flush()
    db_session.add(
        ContributorCredit(
            media_id=media_id,
            contributor_id=contributor.id,
            credited_name=contributor.display_name,
            normalized_credited_name="last visible contributor",
            role="author",
            ordinal=0,
            source="manual",
        )
    )
    db_session.commit()
    media_ticket = create_build(
        db_session,
        locator=SubjectResource(ref=ResourceRef(scheme="media", id=media_id)),
        requester_user_id=viewer_id,
        idempotency_key="last-visible-media",
        instruction=None,
    )
    contributor_ticket = create_build(
        db_session,
        locator=SubjectContributor(
            handle=parse_contributor_handle(contributor.handle),
        ),
        requester_user_id=viewer_id,
        idempotency_key="last-visible-contributor",
        instruction=None,
    )

    delete_document_for_viewer(db_session, viewer_id, media_id)

    assert db_session.execute(
        text("SELECT count(*) FROM media WHERE id = :media_id"),
        {"media_id": media_id},
    ).scalar_one() == 1
    assert db_session.get(Contributor, contributor.id) is not None
    for ticket in (media_ticket, contributor_ticket):
        assert db_session.execute(
            text("SELECT count(*) FROM artifacts WHERE id = :artifact_id"),
            {"artifact_id": ticket.artifact_id},
        ).scalar_one() == 0
        assert db_session.execute(
            text("SELECT count(*) FROM background_jobs WHERE dedupe_key = :dedupe_key"),
            {"dedupe_key": f"dossier_build:{ticket.build_id}"},
        ).scalar_one() == 0


def test_user_teardown_purges_private_heads_and_cancels_shared_active_builds(
    db_session: Session,
) -> None:
    library_owner_id = _user(db_session)
    departing_user_id = uuid4()
    db_session.execute(
        text("INSERT INTO users (id) VALUES (:user_id)"),
        {"user_id": departing_user_id},
    )
    db_session.commit()
    library_id = create_test_library(db_session, library_owner_id)
    add_library_member(db_session, library_id, departing_user_id)
    private_conversation = create_test_conversation(db_session, departing_user_id)
    private = create_build(
        db_session,
        locator=SubjectResource(
            ref=ResourceRef(scheme="conversation", id=private_conversation)
        ),
        requester_user_id=departing_user_id,
        idempotency_key="private",
        instruction=None,
    )
    shared = create_build(
        db_session,
        locator=SubjectResource(ref=ResourceRef(scheme="library", id=library_id)),
        requester_user_id=departing_user_id,
        idempotency_key="shared",
        instruction=None,
    )

    on_user_deleted(db_session, user_id=departing_user_id)
    db_session.commit()

    assert db_session.execute(
        text("SELECT count(*) FROM artifacts WHERE id = :artifact_id"),
        {"artifact_id": private.artifact_id},
    ).scalar_one() == 0
    assert db_session.execute(
        text("SELECT requester_user_id FROM artifact_builds WHERE id = :build_id"),
        {"build_id": shared.build_id},
    ).scalar_one() is None
    assert db_session.execute(
        text(
            "SELECT actor_user_id FROM artifact_build_cancellations "
            "WHERE build_id = :build_id"
        ),
        {"build_id": shared.build_id},
    ).scalar_one() is None
    assert db_session.execute(
        text("SELECT count(*) FROM background_jobs WHERE dedupe_key = :dedupe_key"),
        {"dedupe_key": f"dossier_build:{shared.build_id}"},
    ).scalar_one() == 0


def test_user_teardown_rehomes_surviving_library_citations(
    db_session: Session,
) -> None:
    library_owner_id = _user(db_session)
    departing_user_id = uuid4()
    db_session.execute(
        text("INSERT INTO users (id) VALUES (:user_id)"),
        {"user_id": departing_user_id},
    )
    db_session.commit()
    library_id = create_test_library(db_session, library_owner_id)
    add_library_member(db_session, library_id, departing_user_id)
    _, revision_id = create_test_library_artifact(
        db_session,
        library_id=library_id,
        requester_user_id=departing_user_id,
    )
    db_session.execute(
        text(
            "UPDATE artifact_revisions SET creator_user_id = :user_id WHERE id = :revision_id"
        ),
        {"user_id": departing_user_id, "revision_id": revision_id},
    )
    cited_page = Page(
        id=uuid4(),
        user_id=departing_user_id,
        title="Preserved citation target",
    )
    db_session.add(cited_page)
    db_session.flush()
    record_citation(
        db_session,
        viewer_id=departing_user_id,
        source=ResourceRef(scheme="artifact_revision", id=revision_id),
        target=ResourceRef(scheme="page", id=cited_page.id),
        ordinal=1,
        kind="supports",
        snapshot=CitationSnapshot(excerpt="Preserved snapshot."),
    )
    db_session.commit()

    on_user_deleted(db_session, user_id=departing_user_id)
    db_session.commit()

    revision = db_session.execute(
        text(
            "SELECT citation_owner_user_id, creator_user_id "
            "FROM artifact_revisions WHERE id = :revision_id"
        ),
        {"revision_id": revision_id},
    ).one()
    assert revision == (library_owner_id, None)
    assert db_session.execute(
        text(
            "SELECT user_id FROM resource_edges "
            "WHERE source_scheme = 'artifact_revision' AND source_id = :revision_id"
        ),
        {"revision_id": revision_id},
    ).scalar_one() == library_owner_id


def test_contributor_orphan_pruning_purges_its_dossier(
    db_session: Session,
) -> None:
    user_id = _user(db_session)
    library_id = create_test_library(db_session, user_id)
    media_id = create_searchable_media_in_library(
        db_session,
        user_id,
        library_id,
        title="Contributor work",
    )
    contributor = Contributor(
        id=uuid4(),
        handle=f"orphan-{uuid4().hex[:12]}",
        display_name="Orphaned Contributor",
    )
    db_session.add(contributor)
    db_session.flush()
    db_session.add(
        ContributorCredit(
            media_id=media_id,
            contributor_id=contributor.id,
            credited_name=contributor.display_name,
            normalized_credited_name="orphaned contributor",
            role="author",
            ordinal=0,
            source="manual",
        )
    )
    db_session.commit()
    ticket = create_build(
        db_session,
        locator=SubjectContributor(
            handle=parse_contributor_handle(contributor.handle),
        ),
        requester_user_id=user_id,
        idempotency_key="contributor-orphan",
        instruction=None,
    )
    db_session.execute(
        text(
            "DELETE FROM contributor_credits "
            "WHERE contributor_id = :contributor_id"
        ),
        {"contributor_id": contributor.id},
    )

    prune_contributors_if_orphaned(
        db_session,
        contributor_ids=[contributor.id],
    )
    db_session.commit()

    assert db_session.get(Contributor, contributor.id) is None
    assert db_session.execute(
        text("SELECT count(*) FROM artifacts WHERE id = :artifact_id"),
        {"artifact_id": ticket.artifact_id},
    ).scalar_one() == 0
    assert db_session.execute(
        text(
            "SELECT count(*) FROM background_jobs "
            "WHERE dedupe_key = :dedupe_key"
        ),
        {"dedupe_key": f"dossier_build:{ticket.build_id}"},
    ).scalar_one() == 0


def _children(db: Session, build_id: UUID) -> tuple[int, int, int]:
    """(#revisions, #failures, #cancellations) terminal children for a build."""
    rev = db.execute(
        text("SELECT count(*) FROM artifact_revisions WHERE build_id = :b"), {"b": build_id}
    ).scalar_one()
    fail = db.execute(
        text("SELECT count(*) FROM artifact_build_failures WHERE build_id = :b"), {"b": build_id}
    ).scalar_one()
    canc = db.execute(
        text("SELECT count(*) FROM artifact_build_cancellations WHERE build_id = :b"),
        {"b": build_id},
    ).scalar_one()
    return int(rev), int(fail), int(canc)


# --- Rule 1 / Rule 2 (create_build; no worker needed) ------------------------


def test_r1_same_idempotency_key_returns_original_build(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=True)
    t1 = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    t2 = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    assert isinstance(t1, BuildTicket)
    assert t2.build_id == t1.build_id
    assert t2.artifact_id == t1.artifact_id
    assert t1.created is True
    assert t2.created is False


def test_r2_different_key_while_active_raises_generation_in_progress(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=True)
    create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    with pytest.raises(DossierGenerationInProgress):
        create_build(
            db_session, locator=loc, requester_user_id=uid, idempotency_key="k-2", instruction=None
        )


def test_cancel_A_permits_build_B_immediately(db_session: Session) -> None:
    """CONTRACTS A6: conflict key is the build_id — cancelling A permits B now."""
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=True)
    a = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    cancel_build(db_session, build_id=a.build_id, actor_user_id=uid)
    b = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-2", instruction=None
    )
    assert b.created is True
    assert b.build_id != a.build_id


def test_ineligible_subject_scheme_raises_invalid_subject_locator(db_session: Session) -> None:
    """A1: exactly 7 eligible subjects; a message subject is not one."""
    uid = _user(db_session)
    loc = SubjectResource(ref=ResourceRef(scheme="message", id=uuid4()))
    with pytest.raises(InvalidSubjectLocator):
        create_build(
            db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
        )


# --- Rule 8 cancel symmetry + BuildNotActive ---------------------------------


def test_r8_cancel_is_idempotent_no_op(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=True)
    t = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    cancel_build(db_session, build_id=t.build_id, actor_user_id=uid)
    # Repeating the winning terminal mutation is an idempotent no-op (rule 4/8):
    cancel_build(db_session, build_id=t.build_id, actor_user_id=uid)
    assert _children(db_session, t.build_id) == (0, 0, 1)


def test_r7r8_run_after_cancel_returns_existing_without_new_child(db_session: Session) -> None:
    """Rule 3/5/7: first committed terminal wins; a late run selects the existing
    child under the head lock and returns it — not a defect, no revision."""
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=True)
    t = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    ctx = _claim_build_ctx(db_session, build_id=t.build_id)
    cancel_build(db_session, build_id=t.build_id, actor_user_id=uid)
    rt = _NoDispatchRuntime()
    asyncio.run(run_build(db_session, build_id=t.build_id, ctx=ctx, runtime=rt))
    assert _children(db_session, t.build_id) == (0, 0, 1)
    assert rt.calls == 0


def test_no_source_material_then_cancel_raises_build_not_active(db_session: Session) -> None:
    """An empty subject fails NoSourceMaterial BEFORE dispatch (A7 rule 1). A
    succeeded/failed build is not active -> cancel raises BuildNotActive (A9/A19)."""
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=False)  # empty conversation
    t = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    ctx = _claim_build_ctx(db_session, build_id=t.build_id)
    rt = _NoDispatchRuntime()
    asyncio.run(run_build(db_session, build_id=t.build_id, ctx=ctx, runtime=rt))
    assert rt.calls == 0
    assert _children(db_session, t.build_id) == (0, 1, 0)
    code = db_session.execute(
        text("SELECT failure_code FROM artifact_build_failures WHERE build_id = :b"),
        {"b": t.build_id},
    ).scalar_one()
    assert code == DossierBuildFailureCode.NoSourceMaterial
    with pytest.raises(BuildNotActive):
        cancel_build(db_session, build_id=t.build_id, actor_user_id=uid)


# --- Rule 6 persisted conflicting terminal children = defect -----------------


def test_r6_persisted_conflicting_terminal_children_is_defect(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=True)
    t = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    # Illegal state: a cancellation AND a failure child for one build (A5 §643).
    db_session.execute(
        text("INSERT INTO artifact_build_cancellations (id, build_id) VALUES (:i, :b)"),
        {"i": uuid4(), "b": t.build_id},
    )
    db_session.execute(
        text(
            "INSERT INTO artifact_build_failures (id, build_id, failure_code) "
            "VALUES (:i, :b, :c)"
        ),
        {"i": uuid4(), "b": t.build_id, "c": str(DossierBuildFailureCode.NoSourceMaterial)},
    )
    db_session.commit()
    with pytest.raises(AssertionError):  # persisted impossible state is a defect
        read_head(db_session, locator=loc, requester_user_id=uid)


# --- Rule 9 make current (authorize + repoint + freshness, no revision mutate) -


def _seed_success_revision(db: Session, *, build_id: UUID, owner_id: UUID, body: str) -> UUID:
    subject_scheme, subject_id = db.execute(
        text(
            "SELECT a.subject_scheme, a.subject_id "
            "FROM artifact_builds b JOIN artifacts a ON a.id = b.artifact_id "
            "WHERE b.id = :build_id"
        ),
        {"build_id": build_id},
    ).one()
    assert subject_scheme == "conversation"
    locator = SubjectResource(
        ref=ResourceRef(scheme="conversation", id=UUID(str(subject_id))),
    )
    policy = SUBJECT_POLICIES["conversation"]
    resolved = policy.resolve_locator(db, locator, owner_id)
    audience = policy.derive_audience(resolved, owner_id)
    manifest = BINDINGS["conversation"].live_manifest(db, resolved, audience)
    rid = uuid4()
    db.execute(
        text(
            "INSERT INTO artifact_revisions "
            "(id, build_id, content_md, input_manifest, citation_owner_user_id, creator_user_id) "
            "VALUES (:id, :b, :c, CAST(:manifest AS jsonb), :owner, :owner)"
        ),
        {
            "id": rid,
            "b": build_id,
            "c": body,
            "manifest": json.dumps(manifest.model_dump(mode="json")),
            "owner": owner_id,
        },
    )
    db.commit()
    return rid


def test_read_head_hides_older_failure_after_later_success(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=False)
    failed = create_build(
        db_session,
        locator=loc,
        requester_user_id=uid,
        idempotency_key="failed-first",
        instruction=None,
    )
    asyncio.run(
        run_build(
            db_session,
            build_id=failed.build_id,
            ctx=_claim_build_ctx(db_session, build_id=failed.build_id),
            runtime=_NoDispatchRuntime(),
        )
    )
    db_session.execute(
        text(
            "UPDATE artifact_builds SET created_at = '2026-07-22T00:00:00Z' "
            "WHERE id = :build_id"
        ),
        {"build_id": failed.build_id},
    )
    create_test_message(
        db_session,
        loc.ref.id,
        seq=1,
        role="user",
        content="Now there is source material.",
    )
    create_test_message(
        db_session,
        loc.ref.id,
        seq=2,
        role="assistant",
        content="And a settled answer to synthesize.",
    )
    succeeded = create_build(
        db_session,
        locator=loc,
        requester_user_id=uid,
        idempotency_key="success-second",
        instruction=None,
    )
    db_session.execute(
        text(
            "UPDATE artifact_builds SET created_at = '2026-07-23T00:00:00Z' "
            "WHERE id = :build_id"
        ),
        {"build_id": succeeded.build_id},
    )
    revision_id = _seed_success_revision(
        db_session,
        build_id=succeeded.build_id,
        owner_id=uid,
        body="Recovered dossier.",
    )
    make_current(db_session, revision_id=revision_id, actor_user_id=uid)

    head = read_head(db_session, locator=loc, requester_user_id=uid)

    assert head.current_revision_id == revision_id
    assert head.latest_unsuccessful_build is None


def test_read_head_hides_older_cancellation_after_later_success(
    db_session: Session,
) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=True)
    cancelled = create_build(
        db_session,
        locator=loc,
        requester_user_id=uid,
        idempotency_key="cancelled-first",
        instruction=None,
    )
    cancel_build(db_session, build_id=cancelled.build_id, actor_user_id=uid)
    db_session.execute(
        text(
            "UPDATE artifact_builds SET created_at = '2026-07-22T00:00:00Z' "
            "WHERE id = :build_id"
        ),
        {"build_id": cancelled.build_id},
    )
    succeeded = create_build(
        db_session,
        locator=loc,
        requester_user_id=uid,
        idempotency_key="success-after-cancel",
        instruction=None,
    )
    db_session.execute(
        text(
            "UPDATE artifact_builds SET created_at = '2026-07-23T00:00:00Z' "
            "WHERE id = :build_id"
        ),
        {"build_id": succeeded.build_id},
    )
    revision_id = _seed_success_revision(
        db_session,
        build_id=succeeded.build_id,
        owner_id=uid,
        body="Successful dossier.",
    )
    make_current(db_session, revision_id=revision_id, actor_user_id=uid)

    head = read_head(db_session, locator=loc, requester_user_id=uid)

    assert head.current_revision_id == revision_id
    assert head.latest_unsuccessful_build is None


def test_r9_make_current_repoints_head_without_mutating_revision(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=True)
    t = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    rid = _seed_success_revision(db_session, build_id=t.build_id, owner_id=uid, body="Body text.")
    make_current(db_session, revision_id=rid, actor_user_id=uid)
    current = db_session.execute(
        text("SELECT current_revision_id FROM artifacts WHERE id = :a"), {"a": t.artifact_id}
    ).scalar_one()
    assert UUID(str(current)) == rid
    # Make current never mutates the revision body.
    body = db_session.execute(
        text("SELECT content_md FROM artifact_revisions WHERE id = :r"), {"r": rid}
    ).scalar_one()
    assert body == "Body text."


def test_r9_make_current_unknown_revision_raises_revision_not_found(db_session: Session) -> None:
    uid = _user(db_session)
    _conversation_locator(db_session, uid, with_messages=True)
    with pytest.raises(RevisionNotFound):
        make_current(db_session, revision_id=uuid4(), actor_user_id=uid)


def test_r9_make_current_foreign_actor_is_rejected(db_session: Session) -> None:
    """A revision under user A's private head cannot be made current by user B.
    (Exact typed error is integrator-owned: RevisionNotOwnedByHead or masked
    RevisionNotFound — both A19 exceptions.)"""
    owner = _user(db_session)
    other = _user(db_session)
    loc = _conversation_locator(db_session, owner, with_messages=True)
    t = create_build(
        db_session, locator=loc, requester_user_id=owner, idempotency_key="k-1", instruction=None
    )
    rid = _seed_success_revision(db_session, build_id=t.build_id, owner_id=owner, body="Body.")
    with pytest.raises((RevisionNotOwnedByHead, RevisionNotFound)):
        make_current(db_session, revision_id=rid, actor_user_id=other)


# --- Rule 10 cleanup wins over a late worker promote -------------------------


def test_r10_cleanup_wins_over_late_run(db_session: Session) -> None:
    uid = _user(db_session)
    conv_ref = ResourceRef(scheme="conversation", id=create_test_conversation(db_session, uid))
    create_test_message(db_session, conv_ref.id, seq=1, role="user", content="Something.")
    create_test_message(db_session, conv_ref.id, seq=2, role="assistant", content="A reply.")
    loc = SubjectResource(ref=conv_ref)
    t = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    ctx = _claim_build_ctx(db_session, build_id=t.build_id)
    on_subject_deleted(db_session, conv_ref)  # deletes/invalidates the locked head first
    db_session.commit()
    rt = _NoDispatchRuntime()
    asyncio.run(run_build(db_session, build_id=t.build_id, ctx=ctx, runtime=rt))  # must no-op
    head_rows = db_session.execute(
        text("SELECT count(*) FROM artifacts WHERE id = :a"), {"a": t.artifact_id}
    ).scalar_one()
    assert head_rows == 0
    assert _children(db_session, t.build_id) == (0, 0, 0)
    assert rt.calls == 0


def test_r10_audience_removal_preserves_other_audience_head(db_session: Session) -> None:
    first_user = _user(db_session)
    second_user = _user(db_session)
    subject = ResourceRef(scheme="media", id=uuid4())
    first_head = uuid4()
    second_head = uuid4()
    db_session.execute(
        text(
            "INSERT INTO artifacts "
            "(id, subject_scheme, subject_id, audience_scheme, audience_id) "
            "VALUES (:first_head, 'media', :subject_id, 'user', :first_user), "
            "(:second_head, 'media', :subject_id, 'user', :second_user)"
        ),
        {
            "first_head": first_head,
            "second_head": second_head,
            "subject_id": subject.id,
            "first_user": str(first_user),
            "second_user": str(second_user),
        },
    )

    on_subject_audience_removed(
        db_session,
        subject_ref=subject,
        audience=AudienceUser(user_id=first_user),
    )

    assert db_session.execute(
        text("SELECT id FROM artifacts WHERE subject_id = :subject_id ORDER BY id"),
        {"subject_id": subject.id},
    ).scalars().all() == [second_head]


# --- Event seq allocation under head lock (no dup / monotonic) ---------------


def test_build_events_seq_unique_monotonic_with_terminal(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=False)  # -> NoSourceMaterial
    t = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    ctx = _claim_build_ctx(db_session, build_id=t.build_id)
    asyncio.run(run_build(db_session, build_id=t.build_id, ctx=ctx, runtime=_NoDispatchRuntime()))
    rows = db_session.execute(
        text("SELECT seq, event_type FROM artifact_build_events WHERE build_id = :b ORDER BY seq"),
        {"b": t.build_id},
    ).all()
    seqs = [int(r[0]) for r in rows]
    assert seqs, "a completed build has at least one event"
    assert seqs == sorted(seqs)
    assert len(seqs) == len(set(seqs)), "seq allocation under head lock -> no duplicate seq"
    types = [ArtifactBuildEventType(str(r[1])) for r in rows]
    assert types[-1] == ArtifactBuildEventType.Failed  # exactly-one matching terminal event


# --- ArtifactBuildHandle: identifies, never authorizes (seal/unseal) ---------


def test_handle_seal_unseal_roundtrip(db_session: Session) -> None:
    uid = _user(db_session)
    loc = _conversation_locator(db_session, uid, with_messages=True)
    t = create_build(
        db_session, locator=loc, requester_user_id=uid, idempotency_key="k-1", instruction=None
    )
    assert isinstance(t.handle, str)
    assert unseal_artifact_build(t.handle) == t.build_id
    assert unseal_artifact_build(seal_artifact_build(t.build_id)) == t.build_id


def test_unseal_rejects_garbage_handle() -> None:
    with pytest.raises(InvalidArtifactBuildHandle):
        unseal_artifact_build("not-a-sealed-build-handle")
