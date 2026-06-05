"""Typed X provider snapshots and provider identities."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum

X_AUTHOR_THREAD_PROVIDER_ID_PREFIX = "author-thread:"
X_POST_PROVIDER_ID_PREFIX = "post:"


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


@dataclass(frozen=True)
class XUserSnapshot:
    id: str
    name: str
    username: str


@dataclass(frozen=True)
class XPostReference:
    type: str
    id: str


@dataclass(frozen=True)
class XUrlEntity:
    url: str
    expanded_url: str | None
    display_url: str | None
    title: str | None


@dataclass(frozen=True)
class XMediaSnapshot:
    media_key: str
    type: str
    url: str | None
    preview_image_url: str | None
    alt_text: str | None


@dataclass(frozen=True)
class XPostSnapshot:
    id: str
    author_id: str
    text: str
    created_at: str | None
    conversation_id: str | None
    referenced_tweets: tuple[XPostReference, ...]
    media_keys: tuple[str, ...]
    urls: tuple[XUrlEntity, ...]

    @property
    def permalink(self) -> str:
        return canonical_x_post_url(self.id)

    @property
    def quoted_post_ids(self) -> tuple[str, ...]:
        return tuple(ref.id for ref in self.referenced_tweets if ref.type == "quoted")


@dataclass(frozen=True)
class XAuthorThreadSnapshot:
    requested_post_id: str
    conversation_id: str
    canonical_anchor_post_id: str
    canonical_url: str
    author: XUserSnapshot
    posts: tuple[XPostSnapshot, ...]
    quoted_posts: Mapping[str, XPostSnapshot]
    users: Mapping[str, XUserSnapshot]
    media: Mapping[str, XMediaSnapshot]


def canonical_x_post_url(post_id: str) -> str:
    return f"https://x.com/i/status/{post_id}"


def x_author_thread_provider_id(author_id: str, conversation_id: str) -> str:
    return f"{X_AUTHOR_THREAD_PROVIDER_ID_PREFIX}{author_id}:{conversation_id}"


def x_post_provider_id(post_id: str) -> str:
    return f"{X_POST_PROVIDER_ID_PREFIX}{post_id}"
