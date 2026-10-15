"""Direct placement commands: one transaction commits the effect or its refusal receipt."""

from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.library import (
    ConfirmedLibraryPlacementOut,
    LibraryPlacementCommand,
    LibraryPlacementCommandOut,
    LibraryPlacementRefusalCode,
    MediaLibraryPlacementCommand,
    RefusedLibraryPlacementOut,
)
from nexus.services import library_entries, library_governance
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

_REFUSALS: dict[ApiErrorCode, LibraryPlacementRefusalCode] = {
    ApiErrorCode.E_MEDIA_NOT_FOUND: "E_MEDIA_NOT_FOUND",
    ApiErrorCode.E_NOT_FOUND: "E_NOT_FOUND",
    ApiErrorCode.E_LIBRARY_NOT_FOUND: "E_LIBRARY_NOT_FOUND",
    ApiErrorCode.E_FORBIDDEN: "E_FORBIDDEN",
    ApiErrorCode.E_LIBRARY_FORBIDDEN: "E_LIBRARY_FORBIDDEN",
    ApiErrorCode.E_DEFAULT_LIBRARY_FORBIDDEN: "E_DEFAULT_LIBRARY_FORBIDDEN",
    ApiErrorCode.E_INVALID_REQUEST: "E_INVALID_REQUEST",
    ApiErrorCode.E_MEDIA_DELETING: "E_MEDIA_DELETING",
    ApiErrorCode.E_MEDIA_LAST_REFERENCE: "E_MEDIA_LAST_REFERENCE",
    ApiErrorCode.E_PODCAST_SUBSCRIPTION_REQUIRED: "E_PODCAST_SUBSCRIPTION_REQUIRED",
    ApiErrorCode.E_PODCAST_REPLACES_EPISODES: "E_PODCAST_REPLACES_EPISODES",
}


def execute_library_placement_command(
    db: Session, *, viewer_id: UUID, command: LibraryPlacementCommand
) -> LibraryPlacementCommandOut:
    """Replay exact identities before reauthorization; never reapply a terminal command.

    The four direct domain helpers refuse BEFORE their first write. In particular,
    direct podcast filing cannot confirm replacement, so child conflicts refuse
    before inserts. Catching those refusals therefore commits only their receipt.
    Other exceptions roll back everything. Do not compose acquisition here: its
    multi-effect path can refuse after writes and owns a different transaction.

    A duplicate receipt's unique conflict rolls the WHOLE attempt back. Its retry
    reads the winning receipt, including when a delayed copy ran after an inverse
    command. Domain locks alone cannot establish that replay ordering.
    """
    request_bytes = canonical_json_bytes(command.model_dump(mode="json", by_alias=True))
    client_mutation_id = str(command.client_mutation_id)

    def attempt() -> LibraryPlacementCommandOut:
        with transaction(db):
            replay = lookup_replay(
                db,
                viewer_id=viewer_id,
                scope="Library.Placement",
                client_mutation_id=client_mutation_id,
                request_bytes=request_bytes,
            )
            if replay is not None:
                return LibraryPlacementCommandOut.model_validate(replay)

            outcome: ConfirmedLibraryPlacementOut | RefusedLibraryPlacementOut
            try:
                if isinstance(command, MediaLibraryPlacementCommand):
                    saved = command.destination.kind == "SavedInNexus"
                    if command.destination.kind == "SavedInNexus":
                        library_id = library_governance.default_library_id_for_user(db, viewer_id)
                    else:
                        library_id = command.destination.library_id
                        if command.kind == "AddMedia":
                            library_governance.resolve_writable_non_default_library_ids(
                                db, viewer_id, [library_id]
                            )
                    if command.kind == "AddMedia":
                        library_entries.ensure_media_in_library_in_current_transaction(
                            db,
                            viewer_id=viewer_id,
                            library_id=library_id,
                            media_id=command.media_id,
                        )
                    else:
                        library_entries.remove_media_from_library_in_current_transaction(
                            db, viewer_id, command.media_id, library_id, allow_default=saved
                        )
                elif command.kind == "AddPodcast":
                    library_entries.place_subscribed_podcast_in_named_library_in_current_transaction(
                        db,
                        viewer_id=viewer_id,
                        library_id=command.library_id,
                        podcast_id=command.podcast_id,
                    )
                else:
                    library_entries.undo_podcast_filing_for_viewer_in_current_transaction(
                        db,
                        viewer_id=viewer_id,
                        library_id=command.library_id,
                        podcast_id=command.podcast_id,
                    )
            except ApiError as error:
                refusal = _REFUSALS.get(error.code)
                if refusal is None:
                    raise
                outcome = RefusedLibraryPlacementOut(code=refusal)
            else:
                outcome = ConfirmedLibraryPlacementOut()

            result = LibraryPlacementCommandOut(
                client_mutation_id=command.client_mutation_id, outcome=outcome
            )
            record_replay(
                db,
                viewer_id=viewer_id,
                scope="Library.Placement",
                client_mutation_id=client_mutation_id,
                request_bytes=request_bytes,
                response_json=result.model_dump(mode="json", by_alias=True),
            )
            return result

    return retry_read_committed(db, "library_placement_command", attempt)
