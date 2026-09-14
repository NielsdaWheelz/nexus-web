"""Dossier evidence counts apply both captured audience and current subject access."""

from uuid import uuid4

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ArtifactIdeaSubject,
    Contributor,
    ContributorCredit,
    Conversation,
    Library,
    LibraryEntry,
    Media,
    Membership,
    NoteBlock,
    Page,
    Podcast,
    SynthesisArtifact,
    UserMediaDeletion,
)
from nexus.services.artifacts.registry import (
    _registrations,
    persisted_subject_visible_sql,
    visible_persisted_subject,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.library_entries import ensure_media_in_default_library


def test_dossier_visibility_filters_before_paging_without_widening_subject_access(
    engine: Engine,
) -> None:
    viewers = (uuid4(), uuid4())
    with Session(engine, expire_on_commit=False) as db:
        subjects = {}
        heads = []
        for user in viewers:
            library_id = ensure_user_and_default_library(
                db, user, f"dossier-visibility-{user}@example.invalid"
            )
            media = Media(kind="web_article", title="Source", created_by_user_id=user)
            contributor = Contributor(handle=f"source-{uuid4().hex}", display_name="Author")
            podcast = Podcast(
                provider="test",
                provider_podcast_id=str(uuid4()),
                title="Podcast",
                feed_url=f"https://example.invalid/feed/{user}",
            )
            rows = {
                "media": media,
                # Public conversation visibility must not widen private Dossier access.
                "conversation": Conversation(owner_user_id=user, title="Public", sharing="public"),
                "library": db.get(Library, library_id),
                "podcast": podcast,
                "contributor": contributor,
                "page": Page(user_id=user, title="Page"),
                "note_block": NoteBlock(
                    user_id=user,
                    body_text="Private note",
                    body_pm_json={"type": "doc", "content": []},
                ),
                "idea": ArtifactIdeaSubject(
                    user_id=user,
                    idea_key={"version": "v1", "title_key": "source"},
                    display_title="Source",
                ),
            }
            # The registry is the authority on which subject schemes exist. A new
            # registration with no fixture row here would otherwise pass this
            # equivalence pin by never being projected at all.
            assert rows.keys() == _registrations().keys(), (
                "Dossier subject fixtures and the registered schemes disagree"
            )
            db.add_all(rows.values())
            db.flush()
            ensure_media_in_default_library(db, user, media.id)
            db.add(LibraryEntry(library_id=library_id, podcast_id=podcast.id, position=1))
            db.add(
                ContributorCredit(
                    contributor_id=contributor.id,
                    media_id=media.id,
                    credited_name="Author",
                    normalized_credited_name="author",
                    role="author",
                    ordinal=0,
                    source="test",
                )
            )
            subjects[user] = rows
            for scheme, subject in rows.items():
                # A retained audience grant cannot substitute for lost subject access.
                for audience in viewers:
                    head = SynthesisArtifact(
                        subject_scheme=scheme,
                        subject_id=subject.id,
                        audience_scheme="user",
                        audience_id=str(audience),
                    )
                    db.add(head)
                    heads.append(head)
        shared = Library(owner_user_id=viewers[0], name="Shared")
        db.add(shared)
        db.flush()
        for user in viewers:
            db.add(Membership(library_id=shared.id, user_id=user, role="member"))
        shared_head = SynthesisArtifact(
            subject_scheme="library",
            subject_id=shared.id,
            audience_scheme="library",
            audience_id=str(shared.id),
        )
        db.add(shared_head)
        heads.append(shared_head)
        db.commit()

        query = text(
            f"SELECT a.id FROM artifacts a WHERE a.id = ANY(:ids) AND ({persisted_subject_visible_sql()}) ORDER BY a.id LIMIT :limit"
        )
        for viewer in viewers:
            expected = {
                head.id
                for head in heads
                if head.audience_id == str(viewer)
                and head.subject_id in {subject.id for subject in subjects[viewer].values()}
            } | {shared_head.id}
            actual = set(
                db.scalars(
                    query, {"ids": [head.id for head in heads], "viewer_id": viewer, "limit": 100}
                )
            )
            assert actual == expected, "Dossier projection widened audience or subject access"
            first = db.scalars(
                query, {"ids": [head.id for head in heads], "viewer_id": viewer, "limit": 1}
            ).all()
            assert first == sorted(expected)[:1]
            for head in heads:
                resolved = visible_persisted_subject(
                    db,
                    subject_scheme=head.subject_scheme,
                    subject_id=head.subject_id,
                    audience_scheme=head.audience_scheme,
                    audience_id=head.audience_id,
                    viewer_id=viewer,
                )
                assert (resolved is not None) == (head.id in expected)

        viewer = viewers[0]
        db.delete(db.get(Membership, (shared.id, viewer)))
        db.add(UserMediaDeletion(user_id=viewer, media_id=subjects[viewer]["media"].id))
        db.flush()
        remaining = set(
            db.scalars(
                query, {"ids": [head.id for head in heads], "viewer_id": viewer, "limit": 100}
            )
        )
        assert shared_head.id not in remaining
        for scheme in ("media", "contributor"):
            assert not any(
                head.id in remaining and head.subject_id == subjects[viewer][scheme].id
                for head in heads
            )
