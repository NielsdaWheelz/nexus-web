"""Pydantic schemas for request/response models.

All schemas are re-exported here for convenient imports.
"""

from nexus.schemas.conversation import (
    ConversationListResponse,
    ConversationOut,
    ConversationSharesOut,
    ConversationShareTargetOut,
    MessageListResponse,
    MessageOut,
    PageInfo,
    SetConversationSharesRequest,
)
from nexus.schemas.highlights import (
    AnnotationOut,
    CreateHighlightRequest,
    HighlightOut,
    UpdateHighlightRequest,
    UpsertAnnotationRequest,
)
from nexus.schemas.ingest import IngestReconcileEnqueueOut, IngestRecoveryHealthOut
from nexus.schemas.library import (
    AcceptLibraryInviteResponse,
    AddMediaRequest,
    AddPodcastRequest,
    CreateLibraryInviteRequest,
    CreateLibraryRequest,
    DeclineLibraryInviteResponse,
    DefaultLibraryBackfillJobOut,
    InviteAcceptMembershipOut,
    LibraryEntryOrderRequest,
    LibraryEntryOut,
    LibraryInvitationOut,
    LibraryMemberOut,
    LibraryOut,
    LibraryPodcastOut,
    LibraryPodcastSubscriptionOut,
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
    "AddPodcastRequest",
    "LibraryOut",
    "LibraryEntryOut",
    "LibraryEntryOrderRequest",
    "LibraryPodcastOut",
    "LibraryPodcastSubscriptionOut",
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
    # Ingest recovery operator schemas
    "IngestReconcileEnqueueOut",
    "IngestRecoveryHealthOut",
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
    # S4 PR-06 conversation share schemas
    "SetConversationSharesRequest",
    "ConversationShareTargetOut",
    "ConversationSharesOut",
    # Search schemas (Slice 3, PR-06)
    "SearchResultOut",
    "SearchPageInfo",
    "SearchResponse",
]
