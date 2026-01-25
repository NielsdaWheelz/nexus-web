"""Pydantic schemas for request/response models.

All schemas are re-exported here for convenient imports.
"""

from nexus.schemas.conversation import (
    ConversationListResponse,
    ConversationOut,
    MessageListResponse,
    MessageOut,
    PageInfo,
)
from nexus.schemas.highlights import (
    AnnotationOut,
    CreateHighlightRequest,
    HighlightOut,
    UpdateHighlightRequest,
    UpsertAnnotationRequest,
)
from nexus.schemas.library import (
    AddMediaRequest,
    CreateLibraryRequest,
    LibraryMediaOut,
    LibraryOut,
    UpdateLibraryRequest,
)
from nexus.schemas.media import FragmentOut, MediaOut

__all__ = [
    # Library schemas
    "CreateLibraryRequest",
    "UpdateLibraryRequest",
    "AddMediaRequest",
    "LibraryOut",
    "LibraryMediaOut",
    # Media schemas
    "MediaOut",
    "FragmentOut",
    # Highlight schemas (Slice 2)
    "HighlightOut",
    "AnnotationOut",
    "CreateHighlightRequest",
    "UpdateHighlightRequest",
    "UpsertAnnotationRequest",
    # Conversation schemas (Slice 3)
    "ConversationOut",
    "MessageOut",
    "ConversationListResponse",
    "MessageListResponse",
    "PageInfo",
]
