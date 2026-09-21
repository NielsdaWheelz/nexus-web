"""X provider snapshots, the provider error taxonomy, and X provider identities."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, model_validator

X_AUTHOR_THREAD_PROVIDER_ID_PREFIX = "author-thread:"
X_POST_PROVIDER_ID_PREFIX = "post:"


def canonical_x_post_url(post_id: str) -> str:
    return f"https://x.com/i/status/{post_id}"


def x_author_thread_provider_id(author_id: str, conversation_id: str) -> str:
    return f"{X_AUTHOR_THREAD_PROVIDER_ID_PREFIX}{author_id}:{conversation_id}"


def x_post_provider_id(post_id: str) -> str:
    return f"{X_POST_PROVIDER_ID_PREFIX}{post_id}"


class XProviderErrorCode(str, Enum):
    CREDITS_DEPLETED = "credits_depleted"
    AUTH_REJECTED = "auth_rejected"
    RATE_LIMITED = "rate_limited"
    TIMEOUT = "timeout"
    UNAVAILABLE = "unavailable"
    POST_UNAVAILABLE = "post_unavailable"


@dataclass(frozen=True)
class XProviderError(Exception):
    code: XProviderErrorCode
    message: str
    operation: str
    provider_status_code: int | None = None
    provider_error_type: str | None = None
    provider_error_title: str | None = None
    retry_after_seconds: int | None = None


def _blank_to_none(value: Any) -> Any:
    return (value.strip() or None) if isinstance(value, str) else value


type Text = Annotated[str | None, BeforeValidator(_blank_to_none)]


class _XModel(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)


class XPostReference(_XModel):
    type: str
    id: str


class XUrlEntity(_XModel):
    url: str
    expanded_url: Text = None
    display_url: Text = None
    title: Text = None


class XMediaSnapshot(_XModel):
    media_key: str
    type: str
    url: Text = None
    preview_image_url: Text = None
    alt_text: Text = None


class XUserSnapshot(_XModel):
    id: str
    name: str = ""
    username: str


class XPostSnapshot(_XModel):
    """One post, flattened from the API's nested attachments/entities/note_tweet."""

    id: str
    author_id: str
    text: str = ""
    created_at: Text = None
    conversation_id: Text = None
    referenced_tweets: tuple[XPostReference, ...] = ()
    media_keys: tuple[str, ...] = ()
    urls: tuple[XUrlEntity, ...] = ()

    @model_validator(mode="before")
    @classmethod
    def _flatten(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        raw_note = value.get("note_tweet")
        note: dict[str, Any] = raw_note if isinstance(raw_note, dict) else {}
        note_text = str(note.get("text") or "").strip()
        entities = note.get("entities") if note_text else value.get("entities")
        attachments = value.get("attachments")
        raw_keys = attachments.get("media_keys") if isinstance(attachments, dict) else []
        raw_urls = entities.get("urls") if isinstance(entities, dict) else []
        raw_refs = value.get("referenced_tweets")
        return {
            **value,
            "text": note_text or value.get("text") or "",
            "media_keys": [key for key in _items(raw_keys) if isinstance(key, str) and key],
            "urls": [item for item in _items(raw_urls) if _has_text(item, "url")],
            "referenced_tweets": [
                item
                for item in _items(raw_refs)
                if _has_text(item, "type") and _has_text(item, "id")
            ],
        }

    @property
    def permalink(self) -> str:
        return canonical_x_post_url(self.id)

    @property
    def quoted_post_ids(self) -> tuple[str, ...]:
        return tuple(ref.id for ref in self.referenced_tweets if ref.type == "quoted")


def _items(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _has_text(item: Any, key: str) -> bool:
    return isinstance(item, dict) and bool(str(item.get(key) or "").strip())


@dataclass(frozen=True)
class XResolvedQuoteReference:
    kind: Literal["resolved"] = field(default="resolved", init=False)
    post: XPostSnapshot


@dataclass(frozen=True)
class XUnavailableQuoteReference:
    kind: Literal["unavailable"] = field(default="unavailable", init=False)
    post_id: str
    canonical_url: str


type XQuoteReference = XResolvedQuoteReference | XUnavailableQuoteReference


@dataclass(frozen=True)
class XAuthorThreadSnapshot:
    requested_post_id: str
    conversation_id: str
    canonical_anchor_post_id: str
    canonical_url: str
    author: XUserSnapshot
    posts: tuple[XPostSnapshot, ...]
    quote_references: Mapping[str, XQuoteReference]
    users: Mapping[str, XUserSnapshot]
    media: Mapping[str, XMediaSnapshot]


@dataclass(frozen=True)
class XSinglePostSnapshot:
    requested_post_id: str
    canonical_url: str
    post: XPostSnapshot
    users: Mapping[str, XUserSnapshot]
    media: Mapping[str, XMediaSnapshot]
