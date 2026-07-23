from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.resolve import load_resource_batch
from nexus.services.resource_items.capabilities import capability_for_ref, resource_can_attach
from nexus.services.resource_items.surfaces import resource_item_out


@dataclass(frozen=True, slots=True)
class ResolvedChatSubject:
    requested_ref: ResourceRef
    subject_ref: ResourceRef
    subject_item: ResourceItemOut
    context_refs: tuple[ResourceRef, ...]
    companion_refs: tuple[ResourceRef, ...]
    prompt_mode: Literal["label", "scope", "inline_body", "quote", "generated_output"]


def resolve_chat_subject(
    db: Session,
    *,
    viewer_id: UUID,
    requested_ref: ResourceRef,
    extra_context_refs: Sequence[ResourceRef] = (),
) -> ResolvedChatSubject:
    requested_loaded = load_resource_batch(db, [requested_ref], viewer_id=viewer_id)[
        requested_ref.uri
    ]
    if requested_loaded.missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")

    requested_capability = capability_for_ref(requested_ref)
    if requested_capability.chat_subject == "none":
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Resource cannot be a chat subject",
        )

    subject_ref = requested_ref
    if requested_ref.scheme == "artifact":
        if requested_loaded.related_revision_id is None:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Artifact has no current revision",
            )
        subject_ref = ResourceRef(
            scheme="artifact_revision",
            id=requested_loaded.related_revision_id,
        )

    subject_loaded = requested_loaded
    if subject_ref != requested_ref:
        subject_loaded = load_resource_batch(db, [subject_ref], viewer_id=viewer_id)[
            subject_ref.uri
        ]
        if subject_loaded.missing:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")

    subject_capability = capability_for_ref(subject_ref)
    if subject_capability.chat_subject == "none" or not subject_capability.attachable:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Resource cannot be a chat subject",
        )

    subject_item = resource_item_out(db, viewer_id=viewer_id, ref=subject_ref)
    if subject_item.missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")

    companion_refs: tuple[ResourceRef, ...] = ()
    if (
        subject_ref.scheme == "artifact_revision"
        and subject_loaded.related_subject_scheme is not None
        and subject_loaded.related_subject_id is not None
    ):
        companion_refs = (
            ResourceRef(
                scheme=subject_loaded.related_subject_scheme,
                id=subject_loaded.related_subject_id,
            ),
        )

    refs: list[ResourceRef] = []
    seen: set[str] = set()
    for ref in (subject_ref, *companion_refs, *extra_context_refs):
        if ref.uri in seen:
            continue
        seen.add(ref.uri)
        if ref != subject_ref:
            if not resource_can_attach(ref):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Resource cannot be attached to conversation context",
                )
            item = resource_item_out(db, viewer_id=viewer_id, ref=ref)
            if item.missing:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")
        refs.append(ref)

    if subject_capability.chat_subject == "scope":
        prompt_mode: Literal["label", "scope", "inline_body", "quote", "generated_output"] = "scope"
    elif subject_capability.chat_subject == "quote":
        prompt_mode = "quote"
    elif subject_capability.chat_subject == "generated_output":
        prompt_mode = "generated_output"
    elif subject_capability.chat_subject == "readable":
        prompt_mode = (
            "inline_body" if subject_capability.prompt_render == "inline_body" else "label"
        )
    else:
        prompt_mode = "label"

    return ResolvedChatSubject(
        requested_ref=requested_ref,
        subject_ref=subject_ref,
        subject_item=subject_item,
        context_refs=tuple(refs),
        companion_refs=companion_refs,
        prompt_mode=prompt_mode,
    )
