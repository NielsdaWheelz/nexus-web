"""The dossier binding table: one entry per subject kind.

Every scheme-specific decision — how a route handle resolves, who may read and
generate, what inputs the model is offered, how freshness and the pre-publish
recheck are computed — is one plain function reachable from :data:`BINDINGS`.
The engine carries no subject branches. ``visible_persisted_subject`` and its
SQL twin spell the one audience-plus-subject visibility rule for a stored head.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_media,
    is_library_member,
    visible_contributor_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.errors import NotFoundError
from nexus.schemas.artifact import (
    MediaAbstractBuildingOut,
    MediaAbstractFailedOut,
    MediaAbstractNotAvailableOut,
    MediaAbstractOut,
    MediaAbstractReadyOut,
    MediaAbstractStaleOut,
)
from nexus.schemas.presence import Presence, absent, present
from nexus.services import contributors
from nexus.services.artifacts.collect import (
    EXCERPT_CHARS,
    Candidate,
    Collected,
    DossierInputTooLarge,
    aggregate_media_fanout,
    live_aggregate_entries,
    media_inputs_are_current,
    one_hop_connection_candidates,
    span_texts,
    synthesis_prompt,
)
from nexus.services.artifacts.coordination import DossierBuildRuntime
from nexus.services.artifacts.dossier_types import (
    AudienceLibrary,
    AudienceScope,
    AudienceUser,
    InvalidSubjectLocator,
)
from nexus.services.artifacts.idea import IdeaSubject, get_idea_subject
from nexus.services.artifacts.manifests import (
    AggregateManifestV1,
    ContributorInputManifestV1,
    ConversationComplete,
    ConversationInputManifestV1,
    EvidenceOmission,
    InputManifestV1,
    LibraryInputManifestV1,
    MediaInputManifestV1,
    MediaManifestEntry,
    NoteInputManifestV1,
    PageInputManifestV1,
    PodcastInputManifestV1,
    aggregate_entries,
)
from nexus.services.artifacts.research import (
    collect_idea_inputs,
    idea_evidence_is_current,
    idea_live_manifest,
)
from nexus.services.contributor_credits import load_visible_contributor_media_ids
from nexus.services.contributor_taxonomy import parse_contributor_handle
from nexus.services.generation_spec import BackgroundOperationKey
from nexus.services.media_intelligence import (
    MediaUnit,
    current_content_fingerprint,
    get_media_unit,
    read_single,
)
from nexus.services.resource_graph.adjacency import load_page_surface
from nexus.services.resource_graph.context import list_context_refs
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceScheme,
    assert_resource_ref,
)
from nexus.services.resource_graph.schemas import CitationSnapshot

Subject = ResourceRef | IdeaSubject
DossierSubjectScheme = ResourceScheme | Literal["idea"]

_MEDIA_INPUT_CHAR_BUDGET = 60_000
_INPUT_CHAR_BUDGET = 80_000
_MAX_MESSAGES = 1_000
_MAX_BLOCKS = 1_000


@dataclass(frozen=True, slots=True)
class SubjectBinding:
    """One subject kind's whole dossier pipeline as plain functions."""

    scheme: str
    operation: BackgroundOperationKey
    system_prompt: str
    resolve: Callable[[Session, str, UUID], Subject]
    authorize: Callable[[Session, Subject, UUID], None]
    collect: Callable[[Session, Subject, AudienceScope, DossierBuildRuntime], Awaitable[Collected]]
    recheck: Callable[[Session, Subject, AudienceScope, Collected], bool]
    live_manifest: Callable[[Session, Subject, AudienceScope], InputManifestV1]


def binding_for(subject_scheme: str) -> SubjectBinding | None:
    return BINDINGS.get(subject_scheme)


def subject_key(subject: Subject) -> tuple[str, UUID]:
    """The head's ``(subject_scheme, subject_id)`` columns."""
    if isinstance(subject, IdeaSubject):
        return "idea", subject.id
    return subject.scheme, subject.id


def audience_for(subject: Subject, requester_user_id: UUID) -> AudienceScope:
    """The server-derived audience a head is keyed by; never client-supplied.

    Every binding's ``authorize`` proves the requester is the subject's own
    reader, so the user audience is always the requester; a Library head is
    shared by the whole library instead.
    """
    if isinstance(subject, ResourceRef) and subject.scheme == "library":
        return AudienceLibrary(library_id=subject.id)
    return AudienceUser(user_id=requester_user_id)


def audience_user(audience: AudienceScope) -> UUID:
    if isinstance(audience, AudienceLibrary):
        raise AssertionError("this dossier audience must be a user")
    return audience.user_id


def citation_owner(db: Session, audience: AudienceScope) -> UUID:
    """The stable citation-edge owner: the user, or the library's owner."""
    if isinstance(audience, AudienceLibrary):
        return _library_owner(db, audience.library_id)
    return audience.user_id


def media_abstract(
    db: Session,
    *,
    subject_scheme: str,
    subject_id: UUID,
    requester_user_id: UUID,
) -> Presence[MediaAbstractOut]:
    """The compact Media Intelligence projection shown beside a Media dossier."""
    if subject_scheme != "media":
        return absent()
    projection = read_single(db, media_id=subject_id, requester_user_id=requester_user_id)
    abstract: MediaAbstractOut
    if projection.status == "building":
        abstract = MediaAbstractBuildingOut()
    elif projection.status == "ready":
        abstract = MediaAbstractReadyOut(summary_md=projection.summary_md or "")
    elif projection.status == "stale":
        abstract = MediaAbstractStaleOut(summary_md=projection.summary_md or "")
    elif projection.status == "failed":
        abstract = MediaAbstractFailedOut()
    else:
        abstract = MediaAbstractNotAvailableOut()
    return present(abstract)


# ---------------------------------------------------------------------------
# Stored-head visibility: one rule, spelled in Python and in SQL.
# ---------------------------------------------------------------------------


def visible_persisted_subject(
    db: Session,
    *,
    subject_scheme: str,
    subject_id: UUID,
    audience_scheme: str,
    audience_id: str,
    viewer_id: UUID,
) -> Subject | None:
    """Resolve a stored head's subject only while head and subject stay visible."""
    if audience_scheme == "user":
        if audience_id != str(viewer_id):
            return None
    elif audience_scheme == "library":
        if not is_library_member(db, viewer_id, UUID(audience_id)):
            return None
    else:
        return None

    if subject_scheme == "idea":
        if audience_scheme != "user":
            return None
        return get_idea_subject(db, user_id=viewer_id, idea_subject_id=subject_id)

    binding = binding_for(subject_scheme)
    if binding is None:
        return None
    subject = ResourceRef(scheme=cast("ResourceScheme", binding.scheme), id=subject_id)
    try:
        binding.authorize(db, subject, viewer_id)
    except NotFoundError:
        return None
    return subject


def audience_visible_sql(artifact_alias: str) -> str:
    """The audience half of head visibility, over an ``artifacts`` row alias."""
    return f"""(
        (
            (
                {artifact_alias}.audience_scheme = 'user'
                AND {artifact_alias}.audience_id = :viewer_id_text
            )
            OR (
                {artifact_alias}.audience_scheme = 'library'
                AND EXISTS (
                    SELECT 1 FROM memberships vps_audience
                    WHERE vps_audience.library_id::text = {artifact_alias}.audience_id
                      AND vps_audience.user_id = :viewer_id
                )
            )
        )
        AND (
            {artifact_alias}.subject_scheme != 'idea'
            OR EXISTS (
                SELECT 1 FROM artifact_idea_subjects vps_idea
                WHERE vps_idea.id = {artifact_alias}.subject_id
                  AND vps_idea.user_id = :viewer_id
            )
        )
    )"""


def visible_persisted_subject_sql(artifact_alias: str) -> str:
    """The set-membership SQL twin of :func:`visible_persisted_subject`.

    A boolean predicate over an ``artifacts`` row alias binding ``:viewer_id``
    and ``:viewer_id_text``, so a batched reader filters its rows inside its own
    query instead of reauthorizing one row at a time.
    """
    artifact = artifact_alias
    return f"""(
        {audience_visible_sql(artifact)}
        AND CASE {artifact}.subject_scheme
            WHEN 'idea' THEN {artifact}.audience_scheme = 'user'
            WHEN 'media' THEN {artifact}.subject_id IN ({visible_media_ids_cte_sql()})
            WHEN 'podcast' THEN {artifact}.subject_id IN ({visible_podcast_ids_cte_sql()})
            WHEN 'contributor' THEN (
                {artifact}.subject_id IN ({visible_contributor_ids_cte_sql()})
            )
            WHEN 'library' THEN EXISTS (
                SELECT 1 FROM memberships vps_library
                WHERE vps_library.library_id = {artifact}.subject_id
                  AND vps_library.user_id = :viewer_id
            )
            WHEN 'conversation' THEN EXISTS (
                SELECT 1 FROM conversations vps_conversation
                WHERE vps_conversation.id = {artifact}.subject_id
                  AND vps_conversation.owner_user_id = :viewer_id
            )
            WHEN 'page' THEN EXISTS (
                SELECT 1 FROM pages vps_page
                WHERE vps_page.id = {artifact}.subject_id
                  AND vps_page.user_id = :viewer_id
            )
            WHEN 'note_block' THEN EXISTS (
                SELECT 1 FROM note_blocks vps_note
                WHERE vps_note.id = {artifact}.subject_id
                  AND vps_note.user_id = :viewer_id
            )
            ELSE FALSE
        END
    )"""


# ---------------------------------------------------------------------------
# Media.
# ---------------------------------------------------------------------------


def _resource_handle(scheme: ResourceScheme, subject_handle: str) -> ResourceRef:
    try:
        return ResourceRef(scheme=scheme, id=UUID(subject_handle))
    except ValueError as exc:
        raise InvalidSubjectLocator() from exc


def _resolve_media(db: Session, subject_handle: str, requester_user_id: UUID) -> Subject:
    ref = _resource_handle("media", subject_handle)
    _authorize_media(db, ref, requester_user_id)
    return ref


def _authorize_media(db: Session, subject: Subject, requester_user_id: UUID) -> None:
    if not can_read_media(db, requester_user_id, subject_key(subject)[1]):
        raise NotFoundError(message="Media not found")


def _media_inputs(db: Session, subject: Subject, audience: AudienceScope) -> Collected:
    """Offer the document's current MI claims, each bound to its evidence span."""
    ref = _require_resource(subject)
    viewer = audience_user(audience)
    try:
        projection = read_single(db, media_id=ref.id, requester_user_id=viewer)
    except NotFoundError:
        return _empty_media(ref, current_content_fingerprint(db, media_id=ref.id))
    unit = get_media_unit(db, media_id=ref.id) if projection.status == "ready" else None
    if not isinstance(unit, MediaUnit) or not unit.claims:
        return _empty_media(ref, projection.content_fingerprint)

    spans = span_texts(db, [claim.evidence_span_id for claim in unit.claims])
    title = db.execute(
        text("SELECT title FROM media WHERE id = :id"), {"id": ref.id}
    ).scalar_one_or_none()
    candidates: list[Candidate] = []
    omitted: list[EvidenceOmission] = []
    used_chars = 0
    for claim in unit.claims:
        span_ref = ResourceRef(scheme="evidence_span", id=claim.evidence_span_id)
        span = spans.get(claim.evidence_span_id)
        if span is None:
            omitted.append(EvidenceOmission(evidence_ref=span_ref.uri))
            continue
        span_text, section_label = span
        excerpt = (span_text or claim.claim_text)[:EXCERPT_CHARS]
        cost = len(claim.claim_text) + len(excerpt)
        if candidates and used_chars + cost > _MEDIA_INPUT_CHAR_BUDGET:
            omitted.append(EvidenceOmission(evidence_ref=span_ref.uri))
            continue
        used_chars += cost
        candidates.append(
            Candidate(
                index=len(candidates),
                target=span_ref,
                text=claim.claim_text,
                snapshot=CitationSnapshot(
                    title=str(title) if title is not None else None,
                    excerpt=excerpt,
                    section_label=section_label,
                    result_type="evidence_span",
                    deep_link=f"/media/{ref.id}#evidence-{claim.evidence_span_id}",
                ),
            )
        )
    return Collected(
        candidates=candidates,
        manifest=MediaInputManifestV1(
            media_ref=ref.uri,
            content_fingerprint=unit.content_fingerprint,
            offered_claim_count=len(candidates),
            omitted_evidence=omitted,
        ),
        heading="DOCUMENT CLAIMS",
        context=f"DOCUMENT SUMMARY:\n{unit.summary_md}",
    )


def _empty_media(ref: ResourceRef, content_fingerprint: str) -> Collected:
    return Collected(
        candidates=[],
        manifest=MediaInputManifestV1(
            media_ref=ref.uri,
            content_fingerprint=content_fingerprint,
            offered_claim_count=0,
        ),
        heading="DOCUMENT CLAIMS",
        context="",
    )


# ---------------------------------------------------------------------------
# Conversation.
# ---------------------------------------------------------------------------


def _resolve_conversation(db: Session, subject_handle: str, requester_user_id: UUID) -> Subject:
    ref = _resource_handle("conversation", subject_handle)
    _authorize_conversation(db, ref, requester_user_id)
    return ref


def _authorize_conversation(db: Session, subject: Subject, requester_user_id: UUID) -> None:
    owner = db.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": subject_key(subject)[1]},
    ).scalar_one_or_none()
    if owner is None or UUID(str(owner)) != requester_user_id:
        raise NotFoundError(message="Conversation not found")


def _conversation_inputs(db: Session, subject: Subject, audience: AudienceScope) -> Collected:
    """Every complete message across all branches plus attached context."""
    ref = _require_resource(subject)
    owner_id = audience_user(audience)
    rows = (
        db.execute(
            text(
                "SELECT id, seq, role, content, parent_message_id, updated_at "
                "FROM messages WHERE conversation_id = :conversation_id "
                "AND status = 'complete' ORDER BY seq, id"
            ),
            {"conversation_id": ref.id},
        )
        .mappings()
        .all()
    )
    message_chars = sum(len(str(row["content"] or "")) for row in rows)
    if len(rows) > _MAX_MESSAGES or message_chars > _INPUT_CHAR_BUDGET:
        raise DossierInputTooLarge
    candidates: list[Candidate] = []
    topology: list[dict[str, object]] = []
    for row in rows:
        message_id = UUID(str(row["id"]))
        content = str(row["content"] or "")
        topology.append(
            {
                "id": str(message_id),
                "seq": int(row["seq"]),
                "parent": (
                    str(row["parent_message_id"]) if row["parent_message_id"] is not None else None
                ),
                "role": str(row["role"]),
                "content_sha256": _sha256(content),
                "updated_at": str(row["updated_at"]),
            }
        )
        if content.strip():
            candidates.append(
                Candidate(
                    index=len(candidates),
                    target=ResourceRef(scheme="message", id=message_id),
                    text=(
                        f"{row['role']} message seq={row['seq']} "
                        f"parent={row['parent_message_id'] or 'root'}:\n{content}"
                    ),
                    snapshot=CitationSnapshot(
                        title=f"{str(row['role']).title()} message",
                        excerpt=content[:EXCERPT_CHARS],
                        result_type="message",
                        deep_link=f"/conversations/{ref.id}?message={message_id}",
                    ),
                )
            )

    contexts = list_context_refs(db, viewer_id=owner_id, conversation_id=ref.id)
    context_chars = sum(
        len(context.resolved.inline_body or context.resolved.summary or context.resolved.label)
        for context in contexts
    )
    if context_chars + message_chars > _INPUT_CHAR_BUDGET:
        raise DossierInputTooLarge
    context_rows: list[dict[str, str]] = []
    for context in contexts:
        if context.resolved.missing:
            continue
        body = context.resolved.inline_body or context.resolved.summary or context.resolved.label
        context_rows.append({"ref": context.target.uri, "content_sha256": _sha256(body)})
        candidates.append(
            Candidate(
                index=len(candidates),
                target=context.target,
                text=f"Attached Context — {context.resolved.label}:\n{body}",
                snapshot=CitationSnapshot(
                    title=context.resolved.label,
                    excerpt=body[:EXCERPT_CHARS],
                    result_type=context.target.scheme,
                    deep_link=context.activation.href,
                ),
            )
        )
    return Collected(
        candidates=candidates,
        manifest=ConversationInputManifestV1(
            conversation_ref=ref.uri,
            message_refs=[
                ResourceRef(scheme="message", id=UUID(str(row["id"]))).uri for row in rows
            ],
            context_refs=[context.target.uri for context in contexts],
            topology_fingerprint=present(
                _sha256(_canonical({"messages": topology, "contexts": context_rows}))
            ),
            completeness=ConversationComplete(),
        ),
        heading="ALL-BRANCH CONVERSATION MESSAGES AND ATTACHED CONTEXT",
        context=(
            "Shared prefixes occur once. Parent facts in each message describe "
            "the branch topology; synthesize across every branch."
        ),
    )


# ---------------------------------------------------------------------------
# Page.
# ---------------------------------------------------------------------------


def _resolve_page(db: Session, subject_handle: str, requester_user_id: UUID) -> Subject:
    ref = _resource_handle("page", subject_handle)
    _authorize_page(db, ref, requester_user_id)
    return ref


def _authorize_page(db: Session, subject: Subject, requester_user_id: UUID) -> None:
    owner = db.execute(
        text("SELECT user_id FROM pages WHERE id = :id"), {"id": subject_key(subject)[1]}
    ).scalar_one_or_none()
    if owner is None or UUID(str(owner)) != requester_user_id:
        raise NotFoundError(message="Page not found")


def _page_inputs(db: Session, subject: Subject, audience: AudienceScope) -> Collected:
    """The page's ordered blocks in reading order plus its one-hop connections."""
    ref = _require_resource(subject)
    viewer_id = audience_user(audience)
    surface = load_page_surface(db, user_id=viewer_id, page_id=ref.id)
    blocks: list[dict[str, str]] = []
    candidates: list[Candidate] = []
    used_chars = 0

    def walk(nodes) -> None:  # noqa: ANN001 - recursive PageSurface nodes
        nonlocal used_chars
        for node in nodes:
            body = node.block.body_text
            if len(blocks) >= _MAX_BLOCKS or used_chars + len(body) > _INPUT_CHAR_BUDGET:
                raise DossierInputTooLarge
            used_chars += len(body)
            block_ref = ResourceRef(scheme="note_block", id=node.block.id)
            blocks.append(
                {
                    "ref": block_ref.uri,
                    "body_sha256": _sha256(body),
                    "order_key": node.source_order_key,
                    "updated_at": str(node.block.updated_at),
                }
            )
            if body.strip():
                candidates.append(
                    Candidate(
                        index=len(candidates),
                        target=block_ref,
                        text=f"Contained note block ({node.source_order_key}):\n{body}",
                        snapshot=CitationSnapshot(
                            title=surface.page.title,
                            excerpt=body[:EXCERPT_CHARS],
                            result_type="note_block",
                            deep_link=f"/notes/{node.block.id}",
                        ),
                    )
                )
            walk(node.children)

    walk(surface.roots)
    connections, connection_refs = one_hop_connection_candidates(
        db, viewer_id=viewer_id, subject=ref, start_index=len(candidates)
    )
    candidates.extend(connections)
    fingerprint = _sha256(
        _canonical(
            {
                "title": surface.page.title,
                "page_updated_at": str(surface.page.updated_at),
                "blocks": blocks,
                "connections": [
                    {"ref": item.target.uri, "text": item.text} for item in connections
                ],
            }
        )
    )
    return Collected(
        candidates=candidates,
        manifest=PageInputManifestV1(
            page_ref=ref.uri,
            input_fingerprint=fingerprint,
            block_refs=[row["ref"] for row in blocks],
            connection_refs=connection_refs,
        ),
        heading="ORDERED NOTE BLOCKS AND ONE-HOP CONNECTIONS",
        context=f"PAGE: {surface.page.title}",
    )


# ---------------------------------------------------------------------------
# Note block.
# ---------------------------------------------------------------------------


def _resolve_note(db: Session, subject_handle: str, requester_user_id: UUID) -> Subject:
    ref = _resource_handle("note_block", subject_handle)
    _authorize_note(db, ref, requester_user_id)
    return ref


def _authorize_note(db: Session, subject: Subject, requester_user_id: UUID) -> None:
    owner = db.execute(
        text("SELECT user_id FROM note_blocks WHERE id = :id"), {"id": subject_key(subject)[1]}
    ).scalar_one_or_none()
    if owner is None or UUID(str(owner)) != requester_user_id:
        raise NotFoundError(message="Note not found")


def _note_inputs(db: Session, subject: Subject, audience: AudienceScope) -> Collected:
    """One atomic note: its owned evidence spans, or its body, plus connections."""
    ref = _require_resource(subject)
    viewer_id = audience_user(audience)
    note = (
        db.execute(
            text(
                "SELECT body_text, updated_at FROM note_blocks "
                "WHERE id = :id AND user_id = :viewer_id"
            ),
            {"id": ref.id, "viewer_id": viewer_id},
        )
        .mappings()
        .first()
    )
    if note is None:
        raise NotFoundError(message="Note not found")
    body = str(note["body_text"] or "")
    evidence_rows = (
        db.execute(
            text(
                "SELECT id, span_text, citation_label FROM evidence_spans "
                "WHERE owner_kind = 'note_block' AND owner_id = :id ORDER BY id"
            ),
            {"id": ref.id},
        )
        .mappings()
        .all()
    )
    if len(body) + sum(len(str(row["span_text"] or "")) for row in evidence_rows) > (
        _INPUT_CHAR_BUDGET
    ):
        raise DossierInputTooLarge
    candidates: list[Candidate] = []
    evidence_facts: list[dict[str, str]] = []
    for evidence in evidence_rows:
        span_id = UUID(str(evidence["id"]))
        span_text = str(evidence["span_text"] or body)
        evidence_facts.append({"id": str(span_id), "text_sha256": _sha256(span_text)})
        if span_text.strip():
            candidates.append(
                Candidate(
                    index=len(candidates),
                    target=ResourceRef(scheme="evidence_span", id=span_id),
                    text=f"Owned note evidence:\n{span_text}",
                    snapshot=CitationSnapshot(
                        excerpt=span_text[:EXCERPT_CHARS],
                        section_label=(
                            str(evidence["citation_label"])
                            if evidence["citation_label"] is not None
                            else None
                        ),
                        result_type="evidence_span",
                        deep_link=f"/notes/{ref.id}#evidence-{span_id}",
                    ),
                )
            )
    if body.strip() and not candidates:
        candidates.append(
            Candidate(
                index=0,
                target=ref,
                text=f"Exact atomic note body:\n{body}",
                snapshot=CitationSnapshot(
                    excerpt=body[:EXCERPT_CHARS],
                    result_type="note_block",
                    deep_link=f"/notes/{ref.id}",
                ),
            )
        )
    connections, connection_refs = one_hop_connection_candidates(
        db, viewer_id=viewer_id, subject=ref, start_index=len(candidates)
    )
    candidates.extend(connections)
    fingerprint = _sha256(
        _canonical(
            {
                "body": _sha256(body),
                "updated_at": str(note["updated_at"]),
                "evidence": evidence_facts,
                "connections": [
                    {"ref": item.target.uri, "text": item.text} for item in connections
                ],
            }
        )
    )
    return Collected(
        candidates=candidates,
        manifest=NoteInputManifestV1(
            note_ref=ref.uri,
            input_fingerprint=fingerprint,
            body_fingerprint=present(_sha256(body)),
            connection_refs=connection_refs,
        ),
        heading="ATOMIC NOTE BODY AND ONE-HOP CONNECTIONS",
        context=(
            "Treat the note as one atomic body. Evidence-span candidates are "
            "exact owned evidence; otherwise the note candidate snapshots the body."
        ),
    )


# ---------------------------------------------------------------------------
# Library, Podcast, Contributor: one bounded Media Intelligence aggregate.
# ---------------------------------------------------------------------------


def _resolve_library(db: Session, subject_handle: str, requester_user_id: UUID) -> Subject:
    ref = _resource_handle("library", subject_handle)
    _authorize_library(db, ref, requester_user_id)
    return ref


def _authorize_library(db: Session, subject: Subject, requester_user_id: UUID) -> None:
    if not is_library_member(db, requester_user_id, subject_key(subject)[1]):
        raise NotFoundError(message="Library not found")


def _library_owner(db: Session, library_id: UUID) -> UUID:
    owner = db.execute(
        text("SELECT owner_user_id FROM libraries WHERE id = :id"), {"id": library_id}
    ).scalar_one_or_none()
    if owner is None:
        raise NotFoundError(message="Library not found")
    return UUID(str(owner))


def _resolve_podcast(db: Session, subject_handle: str, requester_user_id: UUID) -> Subject:
    ref = _resource_handle("podcast", subject_handle)
    _authorize_podcast(db, ref, requester_user_id)
    return ref


def _authorize_podcast(db: Session, subject: Subject, requester_user_id: UUID) -> None:
    visible = db.execute(
        text(
            f"SELECT 1 FROM ({visible_podcast_ids_cte_sql()}) visible "
            "WHERE visible.podcast_id = :podcast_id LIMIT 1"
        ),
        {"viewer_id": requester_user_id, "podcast_id": subject_key(subject)[1]},
    ).first()
    if visible is None:
        raise NotFoundError(message="Podcast not found")


def _resolve_contributor(db: Session, subject_handle: str, requester_user_id: UUID) -> Subject:
    try:
        handle = parse_contributor_handle(subject_handle)
    except ValueError as exc:
        raise InvalidSubjectLocator() from exc
    return contributors.resolve_contributor_ref_by_handle(
        db, viewer_id=requester_user_id, contributor_handle=str(handle)
    )


def _authorize_contributor(db: Session, subject: Subject, requester_user_id: UUID) -> None:
    contributors.resolve_contributor_ref_by_handle(
        db,
        viewer_id=requester_user_id,
        contributor_handle=_contributor_handle(db, subject_key(subject)[1]),
    )


def _contributor_handle(db: Session, contributor_id: UUID) -> str:
    handle = db.execute(
        text("SELECT handle FROM contributors WHERE id = :id"), {"id": contributor_id}
    ).scalar_one_or_none()
    if handle is None:
        raise NotFoundError(message="Contributor not found")
    return str(handle)


def _aggregate_viewer(db: Session, subject: Subject, audience: AudienceScope) -> UUID:
    ref = _require_resource(subject)
    if ref.scheme == "library":
        return _library_owner(db, ref.id)
    return audience_user(audience)


def _aggregate_media_ids(db: Session, subject: Subject, viewer_id: UUID) -> list[UUID]:
    """The subject's audience-visible media members, in its own stable order."""
    ref = _require_resource(subject)
    if ref.scheme == "contributor":
        return list(
            dict.fromkeys(
                load_visible_contributor_media_ids(db, contributor_id=ref.id, viewer_id=viewer_id)
            )
        )
    if ref.scheme == "podcast":
        rows = db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()})
                SELECT pe.media_id
                FROM podcast_episodes pe
                JOIN visible_media vm ON vm.media_id = pe.media_id
                WHERE pe.podcast_id = :subject_id
                ORDER BY pe.published_at DESC NULLS LAST, pe.media_id
                """
            ),
            {"viewer_id": viewer_id, "subject_id": ref.id},
        )
    else:
        rows = db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()}),
                expanded AS (
                    SELECT le.media_id, le.position, 0 AS lane,
                           NULL::timestamptz AS published_at
                    FROM library_entries le
                    WHERE le.library_id = :subject_id AND le.media_id IS NOT NULL

                    UNION ALL

                    SELECT pe.media_id, le.position, 1 AS lane, pe.published_at
                    FROM library_entries le
                    JOIN podcast_episodes pe ON pe.podcast_id = le.podcast_id
                    WHERE le.library_id = :subject_id AND le.podcast_id IS NOT NULL
                )
                SELECT expanded.media_id
                FROM expanded
                JOIN visible_media vm ON vm.media_id = expanded.media_id
                ORDER BY expanded.position, expanded.lane,
                         expanded.published_at DESC NULLS LAST, expanded.media_id
                """
            ),
            {"viewer_id": viewer_id, "subject_id": ref.id},
        )
    return list(dict.fromkeys(UUID(str(row[0])) for row in rows))


def _aggregate_manifest(
    db: Session, subject: Subject, entries: list[MediaManifestEntry]
) -> AggregateManifestV1:
    ref = _require_resource(subject)
    if ref.scheme == "library":
        return LibraryInputManifestV1(library_ref=ref.uri, media=entries)
    if ref.scheme == "podcast":
        return PodcastInputManifestV1(podcast_ref=ref.uri, episodes=entries)
    return ContributorInputManifestV1(
        contributor_handle=_contributor_handle(db, ref.id), works=entries
    )


# Per aggregate scheme: the candidates heading, and the table and column its
# subject context line is read from.
_AGGREGATE_LABELS = {
    "library": ("GROUNDED CLAIMS FROM LIBRARY MEDIA", "LIBRARY", "libraries", "name"),
    "podcast": ("GROUNDED CLAIMS FROM PODCAST EPISODES", "PODCAST", "podcasts", "title"),
    "contributor": (
        "GROUNDED CLAIMS FROM CONTRIBUTOR WORKS",
        "CONTRIBUTOR",
        "contributors",
        "display_name",
    ),
}


def _aggregate_context(db: Session, ref: ResourceRef) -> str:
    _, prefix, table, column = _AGGREGATE_LABELS[ref.scheme]
    name = db.execute(
        text(f"SELECT {column} FROM {table} WHERE id = :id"), {"id": ref.id}
    ).scalar_one()
    return f"{prefix}: {name}"


async def _collect_aggregate(
    db: Session,
    subject: Subject,
    audience: AudienceScope,
    runtime: DossierBuildRuntime,
) -> Collected:
    del runtime  # Media Intelligence ensures are durable and non-blocking.
    ref = _require_resource(subject)
    viewer_id = _aggregate_viewer(db, subject, audience)
    fanout = aggregate_media_fanout(
        db, media_ids=_aggregate_media_ids(db, subject, viewer_id), viewer_id=viewer_id
    )
    return Collected(
        candidates=fanout.candidates,
        manifest=_aggregate_manifest(db, subject, fanout.entries),
        heading=_AGGREGATE_LABELS[ref.scheme][0],
        context="\n\n".join((_aggregate_context(db, ref), *fanout.summaries)),
        dependency_failed=fanout.dependency_failed,
    )


def _aggregate_live_manifest(
    db: Session, subject: Subject, audience: AudienceScope
) -> InputManifestV1:
    viewer_id = _aggregate_viewer(db, subject, audience)
    entries = live_aggregate_entries(
        db, media_ids=_aggregate_media_ids(db, subject, viewer_id), viewer_id=viewer_id
    )
    return _aggregate_manifest(db, subject, entries)


def _recheck_aggregate(
    db: Session, subject: Subject, audience: AudienceScope, collected: Collected
) -> bool:
    viewer_id = _aggregate_viewer(db, subject, audience)
    entries = aggregate_entries(_require_aggregate(collected.manifest))
    frozen_ids = [assert_resource_ref(entry.media_ref).id for entry in entries]
    if _aggregate_media_ids(db, subject, viewer_id) != frozen_ids:
        return False
    return media_inputs_are_current(
        db, viewer_id=viewer_id, entries=entries, candidates=collected.candidates
    )


# ---------------------------------------------------------------------------
# The table.
# ---------------------------------------------------------------------------


def _not_locatable(db: Session, subject_handle: str, requester_user_id: UUID) -> Subject:
    del db, subject_handle, requester_user_id
    raise InvalidSubjectLocator()


def _authorize_idea(db: Session, subject: Subject, requester_user_id: UUID) -> None:
    if not isinstance(subject, IdeaSubject) or subject.user_id != requester_user_id:
        raise NotFoundError(message="Dossier not found")
    if get_idea_subject(db, user_id=requester_user_id, idea_subject_id=subject.id) is None:
        raise NotFoundError(message="Dossier not found")


def _recollecting(
    *,
    scheme: str,
    operation: BackgroundOperationKey,
    subject_label: str,
    resolve: Callable[[Session, str, UUID], Subject],
    authorize: Callable[[Session, Subject, UUID], None],
    inputs: Callable[[Session, Subject, AudienceScope], Collected],
) -> SubjectBinding:
    """A subject cheap enough to re-collect.

    Its freshness read and its pre-publish recheck are the same collection the
    build ran, compared by manifest.
    """

    async def collect(
        db: Session, subject: Subject, audience: AudienceScope, runtime: DossierBuildRuntime
    ) -> Collected:
        del runtime
        return inputs(db, subject, audience)

    return SubjectBinding(
        scheme=scheme,
        operation=operation,
        system_prompt=synthesis_prompt(subject_label),
        resolve=resolve,
        authorize=authorize,
        collect=collect,
        recheck=lambda db, subject, audience, collected: (
            inputs(db, subject, audience).manifest == collected.manifest
        ),
        live_manifest=lambda db, subject, audience: inputs(db, subject, audience).manifest,
    )


BINDINGS: dict[str, SubjectBinding] = {
    "media": _recollecting(
        scheme="media",
        operation="dossier_media",
        subject_label="one source document",
        resolve=_resolve_media,
        authorize=_authorize_media,
        inputs=_media_inputs,
    ),
    "conversation": _recollecting(
        scheme="conversation",
        operation="dossier_conversation",
        subject_label="a complete, branched conversation",
        resolve=_resolve_conversation,
        authorize=_authorize_conversation,
        inputs=_conversation_inputs,
    ),
    "library": SubjectBinding(
        scheme="library",
        operation="dossier_library",
        system_prompt=synthesis_prompt("a shared research library"),
        resolve=_resolve_library,
        authorize=_authorize_library,
        collect=_collect_aggregate,
        recheck=_recheck_aggregate,
        live_manifest=_aggregate_live_manifest,
    ),
    "podcast": SubjectBinding(
        scheme="podcast",
        operation="dossier_podcast",
        system_prompt=synthesis_prompt("a podcast across all of its available episodes"),
        resolve=_resolve_podcast,
        authorize=_authorize_podcast,
        collect=_collect_aggregate,
        recheck=_recheck_aggregate,
        live_manifest=_aggregate_live_manifest,
    ),
    "contributor": SubjectBinding(
        scheme="contributor",
        operation="dossier_contributor",
        system_prompt=synthesis_prompt("a contributor across all visible credited works"),
        resolve=_resolve_contributor,
        authorize=_authorize_contributor,
        collect=_collect_aggregate,
        recheck=_recheck_aggregate,
        live_manifest=_aggregate_live_manifest,
    ),
    "page": _recollecting(
        scheme="page",
        operation="dossier_page",
        subject_label="a note page and its current connections",
        resolve=_resolve_page,
        authorize=_authorize_page,
        inputs=_page_inputs,
    ),
    "note_block": _recollecting(
        scheme="note_block",
        operation="dossier_note",
        subject_label="one atomic note and its current connections",
        resolve=_resolve_note,
        authorize=_authorize_note,
        inputs=_note_inputs,
    ),
    "idea": SubjectBinding(
        scheme="idea",
        operation="dossier_idea",
        system_prompt=synthesis_prompt(
            "one user-owned idea, grounded in its Nexus contexts and bounded Web research"
        ),
        resolve=_not_locatable,
        authorize=_authorize_idea,
        collect=collect_idea_inputs,
        recheck=idea_evidence_is_current,
        live_manifest=idea_live_manifest,
    ),
}


def _require_resource(subject: Subject) -> ResourceRef:
    if isinstance(subject, IdeaSubject):
        raise AssertionError("a Resource dossier binding received an Idea subject")
    return subject


def _require_aggregate(manifest: InputManifestV1) -> AggregateManifestV1:
    if not isinstance(
        manifest,
        LibraryInputManifestV1 | PodcastInputManifestV1 | ContributorInputManifestV1,
    ):
        raise AssertionError("an aggregate dossier has the wrong manifest")
    return manifest


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))
