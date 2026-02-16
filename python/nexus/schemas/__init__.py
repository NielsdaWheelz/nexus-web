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
    AcceptLibraryInviteResponse,
    AddMediaRequest,
    CreateLibraryInviteRequest,
    CreateLibraryRequest,
    DeclineLibraryInviteResponse,
    DefaultLibraryBackfillJobOut,
    InviteAcceptMembershipOut,
    LibraryInvitationOut,
    LibraryMediaOut,
    LibraryMemberOut,
    LibraryOut,
    RequeueDefaultLibraryBackfillJobRequest,
    TransferLibraryOwnershipRequest,
    UpdateLibraryMemberRequest,
    UpdateLibraryRequest,
)
from nexus.schemas.media import FragmentOut, MediaOut
from nexus.schemas.search import (
    SearchPageInfo,
    SearchResponse,
    SearchResultOut,
)

__all__ = [
    # Library schemas
    "CreateLibraryRequest",
    "UpdateLibraryRequest",
    "AddMediaRequest",
    "LibraryOut",
    "LibraryMediaOut",
    # S4 Library schemas
    "LibraryMemberOut",
    "LibraryInvitationOut",
    "UpdateLibraryMemberRequest",
    "TransferLibraryOwnershipRequest",
    # S4 PR-04 invite schemas
    "CreateLibraryInviteRequest",
    "AcceptLibraryInviteResponse",
    "DeclineLibraryInviteResponse",
    "InviteAcceptMembershipOut",
    # S4 PR-05 backfill requeue schemas
    "RequeueDefaultLibraryBackfillJobRequest",
    "DefaultLibraryBackfillJobOut",
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
    # Search schemas (Slice 3, PR-06)
    "SearchResultOut",
    "SearchPageInfo",
    "SearchResponse",
]
