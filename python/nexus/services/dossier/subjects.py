"""The dossier subject table and the one head-visibility rule.

What differs between subject kinds is a row here: the prompt phrase, the operation
(model tier), who may see the subject (one sql predicate, used for the single check and
the batch ``CASE`` alike), how its inputs are collected, whether media intelligence must
be ensured first, whether the head is shared by a library, and how a route handle
resolves. A head is visible iff its audience admits the viewer and its subject is
visible to the viewer.
"""

from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from typing import Final
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    visible_contributor_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.services.contributor_taxonomy import try_parse_contributor_handle
from nexus.services.dossier import inputs
from nexus.services.dossier.inputs import Collected, Readiness
from nexus.services.generation.contract import BackgroundOperation


def invalid_subject() -> InvalidRequestError:
    return InvalidRequestError(ApiErrorCode.E_DOSSIER_INVALID_SUBJECT, "Invalid dossier subject")


def _uuid_handle(db: Session, handle: str) -> UUID:
    try:
        return UUID(handle)
    except ValueError:
        raise invalid_subject() from None


def _contributor_handle(db: Session, handle: str) -> UUID:
    if try_parse_contributor_handle(handle) is None:
        raise invalid_subject()
    subject_id = db.execute(
        text("SELECT id FROM contributors WHERE handle = :handle"), {"handle": handle}
    ).scalar()
    if subject_id is None:
        raise NotFoundError(message="Dossier subject not found")
    return subject_id


@dataclass(frozen=True, slots=True)
class Binding:
    label: str  # the prompt's subject phrase
    operation: BackgroundOperation
    visible: str  # sql boolean over "{s}", the subject id; binds :viewer_id
    inputs: Callable[[Session, UUID, UUID], Collected] | None  # None: idea research
    ensure: Callable[[Session, UUID, UUID], Readiness] | None = None
    shared: bool = False  # the library is the audience
    handle: Callable[[Session, str], UUID] | None = _uuid_handle  # None: not routable


def _owned(table: str, owner: str = "user_id") -> str:
    return f"EXISTS (SELECT 1 FROM {table} t WHERE t.id = {{s}} AND t.{owner} = :viewer_id)"


BINDINGS: Final[dict[str, Binding]] = {
    "media": Binding(
        "one source document",
        "dossier_media",
        f"{{s}} IN ({visible_media_ids_cte_sql()})",
        inputs.media,
        partial(inputs.ensure, "media"),
    ),
    "conversation": Binding(
        "a complete, branched conversation",
        "dossier_conversation",
        _owned("conversations", "owner_user_id"),
        inputs.conversation,
    ),
    "page": Binding(
        "a note page and its current connections", "dossier_page", _owned("pages"), inputs.page
    ),
    "note_block": Binding(
        "one atomic note and its current connections",
        "dossier_note",
        _owned("note_blocks"),
        inputs.note,
    ),
    "library": Binding(
        "a shared research library",
        "dossier_library",
        "EXISTS (SELECT 1 FROM memberships t WHERE t.library_id = {s} AND t.user_id = :viewer_id)",
        partial(inputs.aggregate, "library"),
        partial(inputs.ensure, "library"),
        shared=True,
    ),
    "podcast": Binding(
        "a podcast across all of its available episodes",
        "dossier_podcast",
        f"{{s}} IN ({visible_podcast_ids_cte_sql()})",
        partial(inputs.aggregate, "podcast"),
        partial(inputs.ensure, "podcast"),
    ),
    "contributor": Binding(
        "a contributor across all visible credited works",
        "dossier_contributor",
        f"{{s}} IN ({visible_contributor_ids_cte_sql()})",
        partial(inputs.aggregate, "contributor"),
        partial(inputs.ensure, "contributor"),
        handle=_contributor_handle,
    ),
    "idea": Binding(
        "one user-owned idea, grounded in its Nexus contexts and bounded Web research",
        "dossier_idea",
        _owned("artifact_idea_subjects"),
        None,
        handle=None,
    ),
}


def resolve(db: Session, scheme: str, handle: str, viewer_id: UUID) -> UUID:
    """A route's subject id: 400 for an unroutable scheme or bad handle, 404 if unseen."""
    binding = BINDINGS.get(scheme)
    if binding is None or binding.handle is None:
        raise invalid_subject()
    subject_id = binding.handle(db, handle)
    if not subject_visible(db, scheme, subject_id, viewer_id):
        raise NotFoundError(message="Dossier subject not found")
    return subject_id


def subject_visible(db: Session, scheme: str, subject_id: UUID, viewer_id: UUID) -> bool:
    predicate = BINDINGS[scheme].visible.replace("{s}", "CAST(:subject_id AS uuid)")
    return db.execute(
        text(f"SELECT {predicate}"), {"subject_id": subject_id, "viewer_id": viewer_id}
    ).scalar_one()


def audience_of(scheme: str, subject_id: UUID, viewer_id: UUID) -> tuple[str, UUID]:
    """The server-derived audience: the library for a library subject, else the viewer."""
    return ("library", subject_id) if BINDINGS[scheme].shared else ("user", viewer_id)


def input_viewer(db: Session, audience_scheme: str, audience_id: UUID) -> UUID:
    """Whose visibility collects inputs and owns citation edges: the user, or the library's owner."""
    if audience_scheme == "user":
        return audience_id
    return db.execute(
        text("SELECT owner_user_id FROM libraries WHERE id = :id"), {"id": audience_id}
    ).scalar_one()


def audience_sql(alias: str) -> str:
    """A head's audience admits ``:viewer_id``."""
    return (
        f"(({alias}.audience_scheme = 'user' AND {alias}.audience_id = :viewer_id) "
        f"OR ({alias}.audience_scheme = 'library' AND EXISTS (SELECT 1 FROM memberships am "
        f"WHERE am.library_id = {alias}.audience_id AND am.user_id = :viewer_id)))"
    )


def head_visible_sql(alias: str) -> str:
    """A head is visible to ``:viewer_id``: its audience admits them and they see its subject."""
    subject = f"{alias}.subject_id"
    cases = " ".join(
        f"WHEN '{scheme}' THEN {binding.visible.replace('{s}', subject)}"
        for scheme, binding in BINDINGS.items()
    )
    return f"({audience_sql(alias)} AND CASE {alias}.subject_scheme {cases} ELSE false END)"
