// GENERATED from the FastAPI wire schema by scripts/gen-wire.mjs; do not edit.
// Regenerate: cd apps/web && bun run gen:wire

export const WIRE_REVISION = 14;

export interface paths {
    "/artifact-builds/{artifact_build_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel Dossier Build */
        post: operations["cancel_dossier_build_artifact_builds__artifact_build_id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/artifacts/dossiers/learn": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Learn Dossier */
        post: operations["learn_dossier_artifacts_dossiers_learn_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/artifacts/dossiers/{subject_scheme}/{subject_handle}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Dossier */
        get: operations["get_dossier_artifacts_dossiers__subject_scheme___subject_handle__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/artifacts/dossiers/{subject_scheme}/{subject_handle}/builds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Dossier Build */
        post: operations["create_dossier_build_artifacts_dossiers__subject_scheme___subject_handle__builds_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/artifacts/{artifact_ref}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Dossier By Ref */
        get: operations["get_dossier_by_ref_artifacts__artifact_ref__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/artifacts/{artifact_ref}/builds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Regenerate Dossier */
        post: operations["regenerate_dossier_artifacts__artifact_ref__builds_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/assistant-writes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Assistant Writes */
        get: operations["list_assistant_writes_assistant_writes_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/assistant-writes/{tool_call_id}/undo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Undo Assistant Write
         * @description Idempotent: an undone write answers 204 again.
         */
        post: operations["undo_assistant_write_assistant_writes__tool_call_id__undo_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/atlas": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read Atlas */
        get: operations["read_atlas_atlas_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/extension-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create Session
         * @description A new token per call; the extension keeps the last and may revoke any.
         */
        post: operations["create_session_auth_extension_sessions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/extension-sessions/current": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read Session
         * @description The account behind the bearer and the byte limits its captures must respect.
         */
        get: operations["read_session_auth_extension_sessions_current_get"];
        put?: never;
        post?: never;
        /**
         * Revoke Session
         * @description A revoked or unknown token is 401, which the extension reads as done.
         */
        delete: operations["revoke_session_auth_extension_sessions_current_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/handoff-codes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Auth Handoff Code Route */
        post: operations["create_auth_handoff_code_route_auth_handoff_codes_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/handoff-codes/consume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Consume Auth Handoff Code Route */
        post: operations["consume_auth_handoff_code_route_auth_handoff_codes_consume_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browse": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Browse Content */
        get: operations["browse_content_browse_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browse/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Browse Preview */
        get: operations["browse_preview_browse_preview_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chat-reader-selections/highlights/{highlight_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Reader Selection Preview */
        get: operations["get_reader_selection_preview_chat_reader_selections_highlights__highlight_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chat-runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Chat Run */
        post: operations["create_chat_run_chat_runs_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chat-runs/{run_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Chat Run */
        get: operations["get_chat_run_chat_runs__run_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chat-runs/{run_id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel Chat Run */
        post: operations["cancel_chat_run_chat_runs__run_id__cancel_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/connection-discovery/scans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read Scan */
        get: operations["read_scan_connection_discovery_scans_get"];
        put?: never;
        /** Request Scan */
        post: operations["request_scan_connection_discovery_scans_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/consumption/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Post Activity */
        post: operations["post_activity_consumption_activity_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/consumption/exclusions/{exclusion_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Exclude Session */
        put: operations["exclude_session_consumption_exclusions__exclusion_id__put"];
        post?: never;
        /** Restore Session */
        delete: operations["restore_session_consumption_exclusions__exclusion_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/consumption/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Sessions */
        get: operations["get_sessions_consumption_sessions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/consumption/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Stats */
        get: operations["get_stats_consumption_stats_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/contributors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search Contributors */
        get: operations["search_contributors_contributors_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/contributors/{contributor_handle}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Contributor */
        get: operations["get_contributor_contributors__contributor_handle__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/contributors/{contributor_handle}/works": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Contributor Works */
        get: operations["list_contributor_works_contributors__contributor_handle__works_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Conversations
         * @description The owned-chat index: four views, literal title search and keyset paging.
         *
         *     Optional ``media_id`` scopes current direct context by its endpoint's media owner.
         *
         *     Errors:
         *         E_INVALID_REQUEST (400): a view outside the advertised four, an unknown query
         *             or repeated key, invalid media id, or title search over 200 characters.
         *         E_INVALID_CURSOR (400): malformed or mismatched viewer, media, search or view.
         *         E_MEDIA_NOT_FOUND (404): scoped media is missing or unreadable, including
         *             viewer tombstones and pending teardown.
         */
        get: operations["list_conversations_conversations_get"];
        put?: never;
        /**
         * Create Conversation
         * @description An empty chat with its initial context refs (a resource's "chat" action).
         */
        post: operations["create_conversation_conversations_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversation_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Conversation */
        delete: operations["delete_conversation_conversations__conversation_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversation_id}/context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Context */
        get: operations["get_context_conversations__conversation_id__context_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversation_id}/context/{target_ref}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Detach Context */
        delete: operations["detach_context_conversations__conversation_id__context__target_ref__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversation_id}/tree": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Conversation Tree */
        get: operations["get_conversation_tree_conversations__conversation_id__tree_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/extension/capture-target": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Capture Target */
        get: operations["capture_target_extension_capture_target_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/extension/captures": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Capture */
        post: operations["create_capture_extension_captures_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/extension/captures/{session_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Capture */
        delete: operations["delete_capture_extension_captures__session_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/extension/captures/{session_id}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm Capture */
        post: operations["confirm_capture_extension_captures__session_id__confirm_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/extension/library-destinations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Library Destinations
         * @description The viewer's writable named libraries; the extension cannot create one.
         */
        get: operations["list_library_destinations_extension_library_destinations_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/highlights/{highlight_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Highlight */
        get: operations["get_highlight_highlights__highlight_id__get"];
        put?: never;
        post?: never;
        /** Delete Highlight */
        delete: operations["delete_highlight_highlights__highlight_id__delete"];
        options?: never;
        head?: never;
        /** Update Highlight */
        patch: operations["update_highlight_highlights__highlight_id__patch"];
        trace?: never;
    };
    "/highlights/{highlight_id}/note": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Put Highlight Note
         * @description Create in the loaded empty slot or update the exact attached note.
         */
        put: operations["put_highlight_note_highlights__highlight_id__note_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/highlights/{highlight_id}/note/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Delete Highlight Note */
        post: operations["delete_highlight_note_highlights__highlight_id__note_delete_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/highlights/{highlight_id}/note/{note_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Detach Highlight Note
         * @description Detach the note (idempotent); the note stays.
         */
        delete: operations["detach_highlight_note_highlights__highlight_id__note__note_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/imports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Imports */
        get: operations["list_imports_imports_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/imports/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Import Summary */
        get: operations["get_import_summary_imports_summary_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/imports/{ref}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Import */
        get: operations["get_import_imports__ref__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/imports/{ref}/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Import History */
        get: operations["get_import_history_imports__ref__history_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ingest/email": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Post Email Ingest
         * @description Configuration, size, signature, recipient and owner, all before any MIME parse.
         */
        post: operations["post_email_ingest_ingest_email_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/lectern": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Lectern */
        get: operations["get_lectern_lectern_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/lectern/items/{media_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Place On Lectern */
        put: operations["place_on_lectern_lectern_items__media_id__put"];
        post?: never;
        /** Remove From Lectern */
        delete: operations["remove_from_lectern_lectern_items__media_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/lectern/items/{media_id}/position": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Move On Lectern */
        put: operations["move_on_lectern_lectern_items__media_id__position_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/lectern/quick-reads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Quick Reads */
        get: operations["get_quick_reads_lectern_quick_reads_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/lectern/suggestions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Lectern Suggestions */
        get: operations["get_lectern_suggestions_lectern_suggestions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/lectern/suggestions/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Refresh Lectern Suggestions */
        post: operations["refresh_lectern_suggestions_lectern_suggestions_refresh_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/lectern/suggestions/view": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reconcile Lectern Suggestions */
        post: operations["reconcile_lectern_suggestions_lectern_suggestions_view_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Libraries
         * @description `sort` = created_desc | name_asc | name_desc; absent is oldest created.
         */
        get: operations["list_libraries_libraries_get"];
        put?: never;
        /** Create Library */
        post: operations["create_library_libraries_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/destinations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Destinations
         * @description The complete named libraries the viewer may file into.
         */
        get: operations["list_destinations_libraries_destinations_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/invites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Viewer Invitations */
        get: operations["list_viewer_invitations_libraries_invites_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/invites/{invitation_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke Invitation */
        delete: operations["revoke_invitation_libraries_invites__invitation_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/invites/{invitation_id}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Accept Invitation */
        post: operations["accept_invitation_libraries_invites__invitation_id__accept_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/invites/{invitation_id}/decline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Decline Invitation */
        post: operations["decline_invitation_libraries_invites__invitation_id__decline_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/placements/{ref}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Placements
         * @description Where one media or show sits among the viewer's libraries.
         */
        get: operations["list_placements_libraries_placements__ref__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Library
         * @description Members only; anyone else gets 404.
         */
        get: operations["get_library_libraries__library_id__get"];
        put?: never;
        post?: never;
        /** Delete Library */
        delete: operations["delete_library_libraries__library_id__delete"];
        options?: never;
        head?: never;
        /** Rename Library */
        patch: operations["rename_library_libraries__library_id__patch"];
        trace?: never;
    };
    "/libraries/{library_id}/entries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Entries
         * @description `sort`, `entry_type`, `projection`, `completion`: see `library_listing`.
         */
        get: operations["list_entries_libraries__library_id__entries_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/entries/{entry_id}/position": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Move Entry */
        put: operations["move_entry_libraries__library_id__entries__entry_id__position_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/invites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Invitations
         * @description Pending invitations, newest first.
         */
        get: operations["list_invitations_libraries__library_id__invites_get"];
        put?: never;
        /** Create Invitation */
        post: operations["create_invitation_libraries__library_id__invites_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/items/{ref}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Place Item */
        put: operations["place_item_libraries__library_id__items__ref__put"];
        post?: never;
        /** Unplace Item */
        delete: operations["unplace_item_libraries__library_id__items__ref__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Members */
        get: operations["list_members_libraries__library_id__members_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/members/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove Member */
        delete: operations["remove_member_libraries__library_id__members__user_id__delete"];
        options?: never;
        head?: never;
        /** Set Member Role */
        patch: operations["set_member_role_libraries__library_id__members__user_id__patch"];
        trace?: never;
    };
    "/libraries/{library_id}/membership": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Leave Library */
        delete: operations["leave_library_libraries__library_id__membership_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/order": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Library Order */
        get: operations["get_library_order_libraries__library_id__order_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/suggestions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Suggestions
         * @description The library's Reading Slate.
         */
        get: operations["get_suggestions_libraries__library_id__suggestions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/suggestions/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Refresh Library Suggestions */
        post: operations["refresh_library_suggestions_libraries__library_id__suggestions_refresh_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/suggestions/view": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reconcile Library Suggestions */
        post: operations["reconcile_library_suggestions_libraries__library_id__suggestions_view_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/transfer-ownership": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Transfer Ownership */
        post: operations["transfer_ownership_libraries__library_id__transfer_ownership_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/livez": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Liveness
         * @description Prove only that this API process can serve a request.
         */
        get: operations["get_liveness_livez_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/llm-catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Llm Catalog
         * @description Return exact selectable and visible-ineligible generation facts.
         */
        get: operations["get_llm_catalog_llm_catalog_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Me
         * @description Get current user information.
         *
         *     Requires authentication. Returns the authenticated user's ID,
         *     default library ID, email, display name, and the Post Room ingest address
         *     to the account that owns the Post Room.
         */
        get: operations["get_me_me_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch Me
         * @description Update supplied user profile fields.
         */
        patch: operations["patch_me_me_patch"];
        trace?: never;
    };
    "/me/nexus-history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Nexus History
         * @description Get Nexus usage history for the current viewer.
         */
        get: operations["get_nexus_history_me_nexus_history_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/nexus-selections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Post Nexus Selection
         * @description Record one accepted internal Nexus selection for the current viewer.
         */
        post: operations["post_nexus_selection_me_nexus_selections_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/reader-profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Reader Profile
         * @description Get reader profile (per-user defaults). Returns defaults when none exists.
         */
        get: operations["get_reader_profile_me_reader_profile_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Patch Reader Profile
         * @description Update reader profile (partial).
         */
        patch: operations["patch_reader_profile_me_reader_profile_patch"];
        trace?: never;
    };
    "/me/workspace-presentations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Post Workspace Presentations
         * @description Read ordered, visible destination identities without loading their content.
         */
        post: operations["post_workspace_presentations_me_workspace_presentations_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/workspace-session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Workspace Session
         * @description This device's own workspace session and the newest one saved elsewhere.
         */
        get: operations["get_workspace_session_me_workspace_session_get"];
        /**
         * Put Workspace Session
         * @description Replace this device's workspace session (last write wins).
         */
        put: operations["put_workspace_session_me_workspace_session_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/from-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create From Url
         * @description Accept a url; resolve its attempt before opening a potentially deduplicated media.
         */
        post: operations["create_from_url_media_from_url_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/image": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Proxied Image
         * @description Proxy one external image behind SSRF validation; the browser caches it for a day.
         */
        get: operations["get_proxied_image_media_image_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/source-attempts/{source_attempt_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read Source Attempt */
        get: operations["read_source_attempt_media_source_attempts__source_attempt_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/summaries/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resolve Media Summaries
         * @description Input order; an id the viewer cannot read resolves to null.
         */
        post: operations["resolve_media_summaries_media_summaries_resolve_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/transcript/forecasts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Forecast Podcast Transcripts */
        post: operations["forecast_podcast_transcripts_media_transcript_forecasts_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/transcript/request/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Request Podcast Transcript Batch */
        post: operations["request_podcast_transcript_batch_media_transcript_request_batch_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Upload */
        post: operations["create_upload_media_uploads_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/uploads/{session_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Upload */
        delete: operations["delete_upload_media_uploads__session_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/uploads/{session_id}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm Upload */
        post: operations["confirm_upload_media_uploads__session_id__confirm_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Media
         * @description 404 when the media does not exist or the viewer cannot read it.
         */
        get: operations["get_media_media__media_id__get"];
        put?: never;
        post?: never;
        /**
         * Remove Media
         * @description Idempotent: a media the viewer cannot read is already removed (204); one reachable
         *     only through a system library is 403.
         */
        delete: operations["remove_media_media__media_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/assets/{asset_key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Epub Asset
         * @description Serve one private EPUB image asset; the service owns every policy decision.
         */
        get: operations["get_epub_asset_media__media_id__assets__asset_key__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/authors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Put Media Authors
         * @description The contributors facade owns its own session, re-check and mutation.
         */
        put: operations["put_media_authors_media__media_id__authors_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/document-map": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Reader Document Map */
        get: operations["get_reader_document_map_media__media_id__document_map_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/file": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Media File
         * @description A short-lived signed download URL: url and expires_at.
         */
        get: operations["get_media_file_media__media_id__file_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/finish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Finish */
        post: operations["finish_media__media_id__finish_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/finish/undo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Undo Finish */
        post: operations["undo_finish_media__media_id__finish_undo_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/highlights": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Ensure Highlight */
        post: operations["ensure_highlight_media__media_id__highlights_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/listening-state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Put Listening State */
        put: operations["put_listening_state_media__media_id__listening_state_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/metadata-enrichment": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Enrich Media Metadata
         * @description A resend after the job landed answers that job (it is newer than ``expected_job_id``).
         */
        post: operations["enrich_media_metadata_media__media_id__metadata_enrichment_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/metadata-enrichment/{job_id}/review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Review Media Metadata Result
         * @description Idempotent: an existing review stands.
         */
        post: operations["review_media_metadata_result_media__media_id__metadata_enrichment__job_id__review_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/natural-end": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Settle Natural End */
        post: operations["settle_natural_end_media__media_id__natural_end_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/player": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Player */
        get: operations["get_player_media__media_id__player_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/preview-position": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Install Preview Position */
        post: operations["install_preview_position_media__media_id__preview_position_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/progress/reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reset Progress */
        post: operations["reset_progress_media__media_id__progress_reset_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/reader": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Reader Document
         * @description The whole publication the reader mounts, from one snapshot.
         */
        get: operations["get_reader_document_media__media_id__reader_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/reader-apparatus/{item_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Reader Apparatus Detail
         * @description Complete source-note targets; no locator repair or reading-progress write.
         */
        get: operations["get_reader_apparatus_detail_media__media_id__reader_apparatus__item_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/reader-state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Reader State */
        get: operations["get_reader_state_media__media_id__reader_state_get"];
        /** Put Reader State */
        put: operations["put_reader_state_media__media_id__reader_state_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/reading-copy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create Reading Copy
         * @description Build the offline reading copy, store it and hand back a signed url.
         *
         *     Each call stores a fresh object under the media's prefix that no row owns, so the
         *     storage orphan sweep reclaims it after its minimum age; a retry builds another.
         */
        post: operations["create_reading_copy_media__media_id__reading_copy_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Refresh Source */
        post: operations["refresh_source_media__media_id__refresh_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/repair": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Repair Media
         * @description Requeue the exact dead job the viewer inspected: source or search.
         */
        post: operations["repair_media_media__media_id__repair_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry Source */
        post: operations["retry_source_media__media_id__retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/transcript/request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request Media Transcript
         * @description 202 when it enqueued work, else 200.
         */
        post: operations["request_media_transcript_media__media_id__transcript_request_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/unread": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mark Unread */
        post: operations["mark_unread_media__media_id__unread_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/messages/{assistant_message_id}/regenerate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Regenerate Assistant Message */
        post: operations["regenerate_assistant_message_messages__assistant_message_id__regenerate_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/messages/{assistant_message_id}/rerun": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rerun Assistant Message */
        post: operations["rerun_assistant_message_messages__assistant_message_id__rerun_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/messages/{message_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete Message
         * @description Delete a message and its subtree; the conversation too when it was the last.
         */
        delete: operations["delete_message_messages__message_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/messages/{message_id}/fork-title": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Rename Fork */
        patch: operations["rename_fork_messages__message_id__fork_title_patch"];
        trace?: never;
    };
    "/notes/blocks/{note_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read Note */
        get: operations["read_note_notes_blocks__note_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notes/daily/{local_date}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read Daily Page
         * @description The day's page outline, or a latent one; writes nothing.
         */
        get: operations["read_daily_page_notes_daily__local_date__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notes/daily/{local_date}/captures": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Capture
         * @description Append the text last on the day's page. A retry with the same note id has landed.
         *
         *     Errors: E_EMPTY_NOTE_BODY (400) for blank text; E_NOTE_CONFLICT (409) for another
         *     owner's note id.
         */
        post: operations["capture_notes_daily__local_date__captures_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notes/pages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Pages
         * @description Keyset pages of the viewer's pages in the chats index's four views.
         */
        get: operations["list_pages_notes_pages_get"];
        put?: never;
        /**
         * Create Page
         * @description Create by the client's id; a retry returns the page, another owner's id is 409.
         */
        post: operations["create_page_notes_pages_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notes/pages/{page_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete Page
         * @description Idempotent: a missing page is 204. The page's notes stay.
         */
        delete: operations["delete_page_notes_pages__page_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/oracle/readings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Oracle Readings */
        get: operations["list_oracle_readings_oracle_readings_get"];
        put?: never;
        /** Create Oracle Reading */
        post: operations["create_oracle_reading_oracle_readings_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/oracle/readings/{reading_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Oracle Reading */
        get: operations["get_oracle_reading_oracle_readings__reading_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/oracle/readings/{reading_id}/concordance": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Oracle Concordance */
        get: operations["get_oracle_concordance_oracle_readings__reading_id__concordance_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/podcast-episodes/from-discovery": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Acquire Podcast Episode */
        post: operations["acquire_podcast_episode_podcast_episodes_from_discovery_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/podcasts/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Refresh Podcasts */
        post: operations["refresh_podcasts_podcasts_refresh_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/podcasts/subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Subscriptions */
        get: operations["list_subscriptions_podcasts_subscriptions_get"];
        put?: never;
        /** Subscribe To Podcast */
        post: operations["subscribe_to_podcast_podcasts_subscriptions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/podcasts/subscriptions/{podcast_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Subscription Status */
        get: operations["get_subscription_status_podcasts_subscriptions__podcast_id__get"];
        put?: never;
        post?: never;
        /** Unsubscribe From Podcast */
        delete: operations["unsubscribe_from_podcast_podcasts_subscriptions__podcast_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/podcasts/subscriptions/{podcast_id}/backfill/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry Subscription Backfill */
        post: operations["retry_subscription_backfill_podcasts_subscriptions__podcast_id__backfill_retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/podcasts/subscriptions/{podcast_id}/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Patch Subscription Settings */
        patch: operations["patch_subscription_settings_podcasts_subscriptions__podcast_id__settings_patch"];
        trace?: never;
    };
    "/podcasts/{podcast_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Podcast Detail */
        get: operations["get_podcast_detail_podcasts__podcast_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/podcasts/{podcast_id}/episodes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Podcast Episodes */
        get: operations["list_podcast_episodes_podcasts__podcast_id__episodes_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/podcasts/{podcast_id}/episodes/consumption": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Set Podcast Episode Consumption */
        put: operations["set_podcast_episode_consumption_podcasts__podcast_id__episodes_consumption_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/podcasts/{podcast_id}/episodes/consumption/prepare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Prepare Podcast Episode Consumption */
        post: operations["prepare_podcast_episode_consumption_podcasts__podcast_id__episodes_consumption_prepare_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/public/resource-share": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Public Resource Share */
        get: operations["get_public_resource_share_public_resource_share_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/public/resource-share/assets/{ordinal}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Public Resource Share Asset */
        get: operations["get_public_resource_share_asset_public_resource_share_assets__ordinal__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/public/resource-share/document": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Public Resource Share Document */
        get: operations["get_public_resource_share_document_public_resource_share_document_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/public/resource-share/file": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Public Resource Share File */
        get: operations["get_public_resource_share_file_public_resource_share_file_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/readyz": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Readiness
         * @description Prove bounded database reachability and exact schema identity.
         */
        get: operations["get_readiness_readyz_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-graph/commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Commands */
        post: operations["commands_resource_graph_commands_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-graph/connections/query": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Query Connections */
        post: operations["query_connections_resource_graph_connections_query_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-graph/outline/{ref}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read Outline */
        get: operations["read_outline_resource_graph_outline__ref__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-graph/versions/query": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Query Versions */
        post: operations["query_versions_resource_graph_versions_query_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-items/source-targets/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve Source Target */
        post: operations["resolve_source_target_resource_items_source_targets_resolve_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-items/targets/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Search Resource Targets */
        post: operations["search_resource_targets_resource_items_targets_search_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-items/{resource_ref}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Resource Item
         * @description An invisible ref answers 200 with ``missing: true``.
         */
        get: operations["get_resource_item_resource_items__resource_ref__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-items/{resource_ref}/actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Resource Actions
         * @description The viewer's verbs on one ref now; an invisible ref has none.
         */
        get: operations["get_resource_actions_resource_items__resource_ref__actions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-items/{resource_ref}/shares": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Resource Shares */
        get: operations["get_resource_shares_resource_items__resource_ref__shares_get"];
        put?: never;
        /** Create Resource Share */
        post: operations["create_resource_share_resource_items__resource_ref__shares_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-shares/{grant_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete Resource Share
         * @description Revoke or decline; absent or not the viewer's is 204 too.
         */
        delete: operations["delete_resource_share_resource_shares__grant_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search */
        get: operations["search_search_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/search/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search Preview */
        get: operations["search_preview_search_preview_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stream/artifact-builds/{artifact_build_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stream Artifact Build Events
         * @description The build on each change; ``done`` once it is not Active.
         */
        get: operations["stream_artifact_build_events_stream_artifact_builds__artifact_build_id__events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stream/chat-runs/{run_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stream Chat Run Events
         * @description Each committed run event after ``after``, then ``done``; advisories carry no id.
         *
         *     Every read re-asserts the viewer's ownership in its own session, so no event crosses
         *     the stream after ownership or visibility is revoked.
         */
        get: operations["stream_chat_run_events_stream_chat_runs__run_id__events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stream/lectern/suggestions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Stream Lectern Suggestions */
        get: operations["stream_lectern_suggestions_stream_lectern_suggestions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stream/libraries/{library_id}/suggestions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Stream Library Suggestions */
        get: operations["stream_library_suggestions_stream_libraries__library_id__suggestions_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stream/media/{media_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stream Media Events
         * @description Work and publication changes while mounted; access loss ends the stream.
         */
        get: operations["stream_media_events_stream_media__media_id__events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stream/media/{media_id}/metadata/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stream Metadata Events
         * @description Metadata enrichment state until nothing is unfinished (an idle media: one frame).
         *
         *     Only a new run changes the view then; the client reopens the stream on admission and
         *     on every read that can follow one.
         */
        get: operations["stream_metadata_events_stream_media__media_id__metadata_events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stream/oracle-readings/{reading_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stream Oracle Reading Events
         * @description The reading on each change; ``done`` once complete or failed.
         */
        get: operations["stream_oracle_reading_events_stream_oracle_readings__reading_id__events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stream/podcast-subscriptions/{podcast_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stream Podcast Subscription Events
         * @description One subscription until sync and backfill settle; a deleted or transferred one ends
         *     silently (each read names the subscription the stream opened on).
         */
        get: operations["stream_podcast_subscription_events_stream_podcast_subscriptions__podcast_id__events_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/stream/writing": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Stream Writing
         * @description Listen first, then read the durable wake token in every fresh snapshot.
         */
        get: operations["stream_writing_stream_writing_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/telemetry/client-defects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Post Client Defect
         * @description Log a client's render failure with the request id it came from, if any.
         */
        post: operations["post_client_defect_telemetry_client_defects_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search Users
         * @description Display name contains `q` (at least 3 characters), or email is exactly `q`.
         */
        get: operations["search_users_users_search_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/version": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Version
         * @description Return only the immutable, image-baked release contract.
         */
        get: operations["get_version_version_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** AbsentHighlightNoteExpected */
        AbsentHighlightNoteExpected: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "absent";
            /** Version */
            version: number;
        };
        /** AcceptedChatAdmission */
        AcceptedChatAdmission: {
            /**
             * Assistant Message Id
             * Format: uuid
             */
            assistant_message_id: string;
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Accepted";
            /**
             * Run Id
             * Format: uuid
             */
            run_id: string;
        };
        /** ActiveExclusionOut */
        ActiveExclusionOut: {
            device: components["schemas"]["DeviceSummaryOut"];
            /** Excluded Active Ms */
            excluded_active_ms: number;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Modality
             * @enum {string}
             */
            modality: "Reading" | "Listening" | "Viewing";
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
            /** Title */
            title: string;
        };
        /**
         * ActivityRecordIn
         * @description A batch of one media, modality and device class; the device is the header the bff
         *     stamps (I13).
         */
        ActivityRecordIn: {
            /** Batch */
            batch: components["schemas"]["ReadingActivityBatchIn"] | components["schemas"]["ListeningActivityBatchIn"] | components["schemas"]["ViewingActivityBatchIn"];
            /**
             * Device Class
             * @enum {string}
             */
            device_class: "Desktop" | "Mobile";
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
        };
        /** ActivitySessionOut */
        ActivitySessionOut: {
            /** Active Ms */
            active_ms: number;
            /** Continues After Range */
            continues_after_range: boolean;
            /** Continues Before Range */
            continues_before_range: boolean;
            device: components["schemas"]["DeviceSummaryOut"];
            /**
             * Ended At
             * Format: date-time
             */
            ended_at: string;
            /** Forward Media Position Ms */
            forward_media_position_ms: number;
            /** Forward Word Position */
            forward_word_position: number;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /**
             * Modality
             * @enum {string}
             */
            modality: "Reading" | "Listening" | "Viewing";
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
            /** Title */
            title: string;
        };
        /** ActivitySessionPageOut */
        ActivitySessionPageOut: {
            /** Items */
            items: components["schemas"]["ActivitySessionOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** ActivityStatsSectionOut */
        ActivityStatsSectionOut: {
            /** Active Exclusions */
            active_exclusions: components["schemas"]["ActiveExclusionOut"][];
            /** Applied Filters */
            applied_filters: string[];
            contributors: components["schemas"]["ContributorActivityBreakdownOut"];
            /** Devices */
            devices: components["schemas"]["DeviceActivityOut"][];
            /** Inapplicable Filters */
            inapplicable_filters: string[];
            /** Local Days */
            local_days: components["schemas"]["LocalDayOut"][];
            /** Local Hours */
            local_hours: components["schemas"]["LocalHourOut"][];
            longest_session: components["schemas"]["ActivitySessionOut"] | null;
            media: components["schemas"]["MediaActivityBreakdownOut"];
            /** Timeline */
            timeline: components["schemas"]["ActivityTimelineRowOut"][];
            totals: components["schemas"]["ActivityTotalsOut"];
        };
        /** ActivityTimelineRowOut */
        ActivityTimelineRowOut: {
            /** Active Ms */
            active_ms: number;
            /**
             * End
             * Format: date-time
             */
            end: string;
            /** Listening Active Ms */
            listening_active_ms: number;
            /** Local Label */
            local_label: string;
            /** Reading Active Ms */
            reading_active_ms: number;
            /**
             * Start
             * Format: date-time
             */
            start: string;
            /** Utc Offset Minutes */
            utc_offset_minutes: number;
            /** Viewing Active Ms */
            viewing_active_ms: number;
        };
        /** ActivityTotalsOut */
        ActivityTotalsOut: {
            /** Active Days */
            active_days: number;
            /** Active Ms */
            active_ms: number;
            /** Forward Media Position Ms */
            forward_media_position_ms: number;
            /** Forward Word Position */
            forward_word_position: number;
            /** Longest Streak */
            longest_streak: number;
            /** Recorded Active Ms */
            recorded_active_ms: number;
            /** Session Count */
            session_count: number;
            /** Streak */
            streak: number;
        };
        /**
         * AfterPlacement
         * @description After this media's visible row; first when it has none.
         */
        AfterPlacement: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "After";
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
        };
        /** AssistantMessageBranchAnchor */
        AssistantMessageBranchAnchor: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "assistant_message";
            /**
             * Message Id
             * Format: uuid
             */
            message_id: string;
        };
        /**
         * AssistantSelectionBranchAnchor
         * @description Selected answer text; the browser never maps it to offsets.
         */
        AssistantSelectionBranchAnchor: {
            /** Client Selection Id */
            client_selection_id: string;
            /** Exact */
            exact: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "assistant_selection";
            /**
             * Message Id
             * Format: uuid
             */
            message_id: string;
            /**
             * Offset Status
             * @constant
             */
            offset_status: "unmapped";
            /** Prefix */
            prefix: string | null;
            /** Suffix */
            suffix: string | null;
        };
        /**
         * AssistantTrustTrailOut
         * @description An answer's run as admitted (every answer has one), its saved context, its actions.
         */
        AssistantTrustTrailOut: {
            /** Context */
            context: components["schemas"]["ResourceItemOut"][];
            run: components["schemas"]["TrustRunOut"];
            /** Tool Calls */
            tool_calls: components["schemas"]["TrustToolCallOut"][];
        };
        /** AssistantWriteOut */
        AssistantWriteOut: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Created Refs */
            created_refs: components["schemas"]["CreatedRefOut"][];
            /** Error Type */
            error_type: string | null;
            /**
             * Generation Id
             * Format: uuid
             */
            generation_id: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Reverted At */
            reverted_at: string | null;
            /** Tool Id */
            tool_id: string;
            /** Undo Allowed */
            undo_allowed: boolean;
        };
        /** AssistantWritePage */
        AssistantWritePage: {
            /** Items */
            items: components["schemas"]["AssistantWriteOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** AtlasEdgeOut */
        AtlasEdgeOut: {
            /**
             * Kind
             * @enum {string}
             */
            kind: "context" | "contradicts";
            /**
             * Source Media Id
             * Format: uuid
             */
            source_media_id: string;
            /**
             * Target Media Id
             * Format: uuid
             */
            target_media_id: string;
        };
        /** AtlasOut */
        AtlasOut: {
            /** Constellations */
            constellations: components["schemas"]["ConstellationOut"][];
            /** Edges */
            edges: components["schemas"]["AtlasEdgeOut"][];
            /** Stars */
            stars: components["schemas"]["StarOut"][];
        };
        /** AudienceAvailableOut */
        AudienceAvailableOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Available";
        };
        /** AudienceUnavailableOut */
        AudienceUnavailableOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Unavailable";
            /**
             * Reason
             * @enum {string}
             */
            reason: "UnsupportedSubject" | "Deleting" | "InsufficientAuthority" | "HighlightUnresolved" | "ProjectionNotReady" | "ProjectionUnsupported";
        };
        /** AutomaticMediaAuthorsRequest */
        AutomaticMediaAuthorsRequest: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            mode: "automatic";
        };
        BrowseCandidate: components["schemas"]["OwnedMediaCandidate"] | components["schemas"]["EpubCandidate"] | components["schemas"]["WebArticleCandidate"] | components["schemas"]["VideoCandidate"] | components["schemas"]["PodcastCandidate"];
        /**
         * BrowseKind
         * @enum {string}
         */
        BrowseKind: "Pdf" | "Epub" | "WebArticle" | "Video" | "Podcast";
        /** BrowsePage */
        BrowsePage: {
            /** Items */
            items: components["schemas"]["BrowseCandidate"][];
            kind: components["schemas"]["BrowseKind"];
            /** Next Cursor */
            next_cursor: string | null;
            /** Query */
            query: string;
            sort: components["schemas"]["BrowseSort"] | null;
            source: components["schemas"]["BrowseSource"];
        };
        BrowsePreview: components["schemas"]["EpubPreview"] | components["schemas"]["WebArticlePreview"] | components["schemas"]["VideoPreview"] | components["schemas"]["PodcastPreview"] | components["schemas"]["EpisodePreview"];
        BrowseResolution: components["schemas"]["InNexusMediaResolution"] | components["schemas"]["InNexusPodcastResolution"] | components["schemas"]["PreviewResolution"];
        /**
         * BrowseSort
         * @enum {string}
         */
        BrowseSort: "Relevance" | "Newest";
        /**
         * BrowseSource
         * @enum {string}
         */
        BrowseSource: "Nexus" | "ProjectGutenberg" | "Brave" | "YouTube" | "PodcastIndex";
        /**
         * CapabilitiesOut
         * @description What this viewer can do with the media's text now; ``can_retry``: the source owner
         *     offers a retry of the same source.
         */
        CapabilitiesOut: {
            /** Can Highlight */
            can_highlight: boolean;
            /** Can Quote */
            can_quote: boolean;
            /** Can Read */
            can_read: boolean;
            /** Can Replace X Article */
            can_replace_x_article: boolean;
            /** Can Retry */
            can_retry: boolean;
        };
        /**
         * CaptureLimits
         * @description The byte limits the extension checks before it sends anything.
         */
        CaptureLimits: {
            /** Max Article Packet Bytes */
            max_article_packet_bytes: number;
            /** Max Epub Bytes */
            max_epub_bytes: number;
            /** Max Pdf Bytes */
            max_pdf_bytes: number;
        };
        /** CaptureTargetOut */
        CaptureTargetOut: {
            /** Target Title */
            target_title: string | null;
            x_article_binding: components["schemas"]["XArticleBinding"] | null;
        };
        /** CapturedEvidence */
        CapturedEvidence: {
            quote: components["schemas"]["CapturedQuote"] | null;
            source: components["schemas"]["CapturedSource"];
            /** Target */
            target: components["schemas"]["CapturedResourceTarget"] | components["schemas"]["CapturedPassageTarget"] | components["schemas"]["CapturedUnavailableTarget"];
        };
        /** CapturedPassageTarget */
        CapturedPassageTarget: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "passage";
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["PdfPageLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Owner Ref */
            owner_ref: string;
            /**
             * Precision
             * @enum {string}
             */
            precision: "exact" | "approximate" | "page" | "time";
            /** Source Identity */
            source_identity: string | null;
        };
        /** CapturedQuote */
        CapturedQuote: {
            /** Color */
            color: ("yellow" | "green" | "blue" | "pink" | "purple") | null;
            /** Exact */
            exact: string;
            /** Prefix */
            prefix: string | null;
            /** Suffix */
            suffix: string | null;
        };
        /** CapturedResourceTarget */
        CapturedResourceTarget: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource";
            /** Owner Ref */
            owner_ref: string;
        };
        /** CapturedSource */
        CapturedSource: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][] | null;
            /** Location Label */
            location_label: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Ref */
            ref: string | null;
            /** Title */
            title: string | null;
        };
        /** CapturedUnavailableTarget */
        CapturedUnavailableTarget: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "unavailable";
            /** Owner Ref */
            owner_ref: string | null;
        };
        /** ChapterOut */
        ChapterOut: {
            /** End Ms */
            end_ms: number | null;
            /** Start Ms */
            start_ms: number;
            /** Title */
            title: string;
        };
        /**
         * ChatAdmissionReceipt
         * @description Create's and repeat's one answer for a run id: an acceptance answers every resend;
         *     a rejection is not stored (a resend decides again).
         */
        ChatAdmissionReceipt: {
            /** Outcome */
            outcome: components["schemas"]["AcceptedChatAdmission"] | components["schemas"]["RejectedChatAdmission"];
        };
        /** ChatAdmissionRejection */
        ChatAdmissionRejection: {
            /**
             * Code
             * @enum {string}
             */
            code: "E_CONVERSATION_CHANGED" | "E_MESSAGE_TOO_LONG" | "E_INVALID_GENERATION_SELECTION" | "E_GENERATION_SELECTION_UNAVAILABLE" | "E_INVALID_REQUEST" | "E_BRANCH_PATH_INVALID" | "E_BRANCH_ANCHOR_INVALID" | "E_FORBIDDEN" | "E_NOT_FOUND" | "E_CONVERSATION_NOT_FOUND" | "E_MESSAGE_NOT_FOUND" | "E_RETRY_NOT_ALLOWED" | "E_REGENERATION_NOT_ALLOWED" | "E_READER_SELECTION_STALE" | "E_READER_SELECTION_NOT_FOUND" | "E_READER_SELECTION_FORBIDDEN" | "E_READER_SELECTION_GEOMETRY_ONLY" | "E_READER_SELECTION_TOO_LARGE" | "E_CONVERSATION_NO_LONGER_EMPTY" | "E_GENERATION_CONTEXT_TOO_LARGE";
        };
        /** ChatFailureOut */
        ChatFailureOut: {
            /**
             * Code
             * @enum {string}
             */
            code: "cancelled" | "context_too_large" | "invalid_output" | "incomplete" | "assistant_unavailable" | "operator_defect";
        };
        /** ChatPublicationWarning */
        ChatPublicationWarning: {
            /**
             * Code
             * @default CitationsUnavailable
             * @constant
             */
            code: "CitationsUnavailable";
        };
        /** ChatRunAssistantTextDeltaEventPayload */
        ChatRunAssistantTextDeltaEventPayload: {
            /** Text */
            text: string;
        };
        /**
         * ChatRunContextRefAddedEventPayload
         * @description A resource a published citation added to the chat's context.
         */
        ChatRunContextRefAddedEventPayload: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Resource Ref */
            resource_ref: string;
        };
        /**
         * ChatRunCreateRequest
         * @description Content retains authored whitespace but cannot be blank; the quote is compared on send.
         */
        ChatRunCreateRequest: {
            /** Content */
            content: string;
            /** Destination */
            destination: components["schemas"]["NewChatDestination"] | components["schemas"]["ExistingChatDestination"];
            reader_selection: components["schemas"]["ReaderSelectionInput"] | null;
            /** Selection */
            selection: components["schemas"]["CodexPersonalSelection"] | components["schemas"]["ProviderApiSelection"];
        };
        /**
         * ChatRunDoneEventPayload
         * @description The run's one terminal frame; the browser then re-reads the saved answer.
         */
        ChatRunDoneEventPayload: {
            /**
             * Status
             * @enum {string}
             */
            status: "complete" | "error" | "cancelled";
        };
        /**
         * ChatRunExecutionOut
         * @description The live run's queue phase and stop intent, in one observation.
         */
        ChatRunExecutionOut: {
            /** Cancel Requested */
            cancel_requested: boolean;
            phase: components["schemas"]["DurableExecutionPhase"];
        };
        /** ChatRunRepeatRequest */
        ChatRunRepeatRequest: {
            /** Expected Revision */
            expected_revision: number;
            /** Selection */
            selection: components["schemas"]["CodexPersonalSelection"] | components["schemas"]["ProviderApiSelection"];
        };
        /** ChatRunResponse */
        ChatRunResponse: {
            assistant_message: components["schemas"]["MessageOut"];
            conversation: components["schemas"]["ConversationOut"];
            user_message: components["schemas"]["MessageOut"];
        };
        /** ChatRunToolCallStartEventOut */
        ChatRunToolCallStartEventOut: {
            activity: components["schemas"]["ToolActivityOut"];
            /** Canonical Tool Id */
            canonical_tool_id: string;
            effect: components["schemas"]["ToolEffect"];
            /**
             * Error Type
             * @enum {unknown}
             */
            error_type: "BudgetExceeded" | "Conflict" | "DeadlineExceeded" | "InvalidCursor" | "InvalidInput" | "InvalidUpstreamResponse" | "InvalidUrl" | "MemoryFailure" | "QuoteAmbiguous" | "QuoteNotFound" | "RateLimited" | "ResourceUnavailable" | "StaleCursor" | "TargetAmbiguous" | "TooLarge" | "ToolUnavailable" | "Uninspectable" | "Unreadable" | "UnsafeDestination" | "UnsupportedContent" | "UpstreamUnavailable" | "WriteCapReached" | null;
            /**
             * Result Kind
             * @enum {string}
             */
            result_kind: "mutation" | "navigation" | "retrieval";
            /**
             * Tool Call Id
             * Format: uuid
             */
            tool_call_id: string;
            /** Tool Call Index */
            tool_call_index: number;
        };
        /** ChatRunToolResultEventOut */
        ChatRunToolResultEventOut: {
            activity: components["schemas"]["ToolActivityOut"];
            /** Canonical Tool Id */
            canonical_tool_id: string;
            /** Created Refs */
            created_refs: components["schemas"]["CreatedRefOut"][];
            effect: components["schemas"]["ToolEffect"];
            /**
             * Error Type
             * @enum {unknown}
             */
            error_type: "BudgetExceeded" | "Conflict" | "DeadlineExceeded" | "InvalidCursor" | "InvalidInput" | "InvalidUpstreamResponse" | "InvalidUrl" | "MemoryFailure" | "QuoteAmbiguous" | "QuoteNotFound" | "RateLimited" | "ResourceUnavailable" | "StaleCursor" | "TargetAmbiguous" | "TooLarge" | "ToolUnavailable" | "Uninspectable" | "Unreadable" | "UnsafeDestination" | "UnsupportedContent" | "UpstreamUnavailable" | "WriteCapReached" | null;
            /**
             * Result Kind
             * @enum {string}
             */
            result_kind: "mutation" | "navigation" | "retrieval";
            /** Retrievals */
            retrievals: components["schemas"]["TrustRetrievalOut"][];
            /**
             * Status
             * @enum {string}
             */
            status: "running" | "complete" | "error" | "cancelled";
            /**
             * Tool Call Id
             * Format: uuid
             */
            tool_call_id: string;
            /** Tool Call Index */
            tool_call_index: number;
        };
        /** ChatSeed */
        ChatSeed: {
            presentation: components["schemas"]["SelectionPresentation"];
            /** Selection */
            selection: components["schemas"]["CodexPersonalSelection"] | components["schemas"]["ProviderApiSelection"];
            /** State */
            state: components["schemas"]["Selectable"] | components["schemas"]["Ineligible"] | components["schemas"]["OperatorActionRequired"] | components["schemas"]["TemporarilyUnavailable"];
        };
        /** CitationOut */
        CitationOut: {
            /**
             * Edge Id
             * Format: uuid
             */
            edge_id: string;
            item: components["schemas"]["ResourceItemOut"];
            /** Ordinal */
            ordinal: number;
            /**
             * Role
             * @enum {string}
             */
            role: "context" | "supports" | "contradicts";
        };
        /**
         * CitationSnapshot
         * @description Exactly one captured citation evidence or machine relationship rationale.
         */
        CitationSnapshot: {
            evidence: components["schemas"]["CapturedEvidence"] | null;
            /** Rationale */
            rationale: string | null;
        };
        /** CitationSourceTargetKey */
        CitationSourceTargetKey: {
            /**
             * Edge Id
             * Format: uuid
             */
            edge_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "citation";
        };
        /**
         * ClientDefectRequest
         * @description One bounded structural failure report; no exception or request payload.
         */
        ClientDefectRequest: {
            /** Component Stack */
            component_stack: string;
            /** Error Code */
            error_code: string;
            /** Pane Id */
            pane_id: string;
            /** Release */
            release: string;
            /** Request Id */
            request_id: string | null;
            /** Visit Id */
            visit_id: string;
        };
        /** CodexPersonalRoute */
        CodexPersonalRoute: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "CodexPersonal";
        };
        /** CodexPersonalSelection */
        CodexPersonalSelection: {
            /** Model */
            model: string;
            /** Reasoning */
            reasoning: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            route: "CodexPersonal";
        };
        /** CollectionPage[Annotated[Union[MediaContributorWorkItemOut, PodcastContributorWorkItemOut, ExternalContributorWorkItemOut], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        CollectionPage_Annotated_Union_MediaContributorWorkItemOut__PodcastContributorWorkItemOut__ExternalContributorWorkItemOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /** Items */
            items: (components["schemas"]["MediaContributorWorkItemOut"] | components["schemas"]["PodcastContributorWorkItemOut"] | components["schemas"]["ExternalContributorWorkItemOut"])[];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** CollectionPage[ConversationListItemOut] */
        CollectionPage_ConversationListItemOut_: {
            /** Items */
            items: components["schemas"]["ConversationListItemOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** CollectionPage[LibraryInvitationOut] */
        CollectionPage_LibraryInvitationOut_: {
            /** Items */
            items: components["schemas"]["LibraryInvitationOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** CollectionPage[LibraryMemberOut] */
        CollectionPage_LibraryMemberOut_: {
            /** Items */
            items: components["schemas"]["LibraryMemberOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** CollectionPage[LibraryOut] */
        CollectionPage_LibraryOut_: {
            /** Items */
            items: components["schemas"]["LibraryOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** CollectionPage[NotePageSummaryOut] */
        CollectionPage_NotePageSummaryOut_: {
            /** Items */
            items: components["schemas"]["NotePageSummaryOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** CollectionPage[PodcastEpisodeListItemOut] */
        CollectionPage_PodcastEpisodeListItemOut_: {
            /** Items */
            items: components["schemas"]["PodcastEpisodeListItemOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** CollectionPage[PodcastSubscriptionListItemOut] */
        CollectionPage_PodcastSubscriptionListItemOut_: {
            /** Items */
            items: components["schemas"]["PodcastSubscriptionListItemOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** CollectionPage[ViewerInvitationOut] */
        CollectionPage_ViewerInvitationOut_: {
            /** Items */
            items: components["schemas"]["ViewerInvitationOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** CompletionStatsSectionOut */
        CompletionStatsSectionOut: {
            /** Applied Filters */
            applied_filters: string[];
            /** Contributors */
            contributors: components["schemas"]["ContributorCompletionOut"][];
            /** Inapplicable Filters */
            inapplicable_filters: string[];
            /** Media */
            media: components["schemas"]["MediaCompletionOut"][];
            /** Total */
            total: number;
        };
        /** ConfirmUploadRequest */
        ConfirmUploadRequest: {
            /** Generation */
            generation: number;
        };
        /**
         * ConnectionCreationOut
         * @description Who created an assistant link: its tool call, and the answer while the chat exists.
         */
        ConnectionCreationOut: {
            authorship: components["schemas"]["MachineAuthorshipOut"];
            /** Conversation Id */
            conversation_id: string | null;
            /**
             * Generation Id
             * Format: uuid
             */
            generation_id: string;
            /** Message Id */
            message_id: string | null;
            /**
             * Tool Call Id
             * Format: uuid
             */
            tool_call_id: string;
        };
        /** ConnectionDiscoveryScanOut */
        ConnectionDiscoveryScanOut: {
            /** Outcome */
            outcome: ("ok" | "skipped" | "terminal_failed") | null;
            /**
             * Status
             * @enum {string}
             */
            status: "idle" | "pending" | "running" | "failed";
        };
        /** ConnectionDiscoveryScanRequest */
        ConnectionDiscoveryScanRequest: {
            /** Ref */
            ref: string;
        };
        /** ConnectionFiltersRequest */
        ConnectionFiltersRequest: {
            /** Kinds */
            kinds?: ("context" | "supports" | "contradicts")[] | null;
            /** Origins */
            origins?: ("user" | "citation" | "system" | "note_body" | "highlight_note" | "discovery" | "document_embed" | "assistant")[] | null;
            /** Source Schemes */
            source_schemes?: ("media" | "library" | "evidence_span" | "content_chunk" | "highlight" | "page" | "note_block" | "fragment" | "conversation" | "message" | "oracle_reading" | "oracle_passage_anchor" | "artifact" | "artifact_revision" | "external_snapshot" | "contributor" | "podcast" | "reader_apparatus_item" | "passage_anchor")[] | null;
            /** Target Schemes */
            target_schemes?: ("media" | "library" | "evidence_span" | "content_chunk" | "highlight" | "page" | "note_block" | "fragment" | "conversation" | "message" | "oracle_reading" | "oracle_passage_anchor" | "artifact" | "artifact_revision" | "external_snapshot" | "contributor" | "podcast" | "reader_apparatus_item" | "passage_anchor")[] | null;
        };
        /**
         * ConnectionOut
         * @description One fact seen from a queried ref: ``other`` is the far endpoint, a user link is
         *     ``undirected``, and ``mutation`` names the one command that may remove it.
         */
        ConnectionOut: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            creation: components["schemas"]["ConnectionCreationOut"] | null;
            /**
             * Direction
             * @enum {string}
             */
            direction: "incoming" | "outgoing" | "undirected";
            /**
             * Edge Id
             * Format: uuid
             */
            edge_id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "context" | "supports" | "contradicts";
            /** Mutation */
            mutation: (components["schemas"]["UnlinkMutation"] | components["schemas"]["DetachContextMutation"]) | null;
            /** Ordinal */
            ordinal: number | null;
            /**
             * Origin
             * @enum {string}
             */
            origin: "user" | "citation" | "system" | "note_body" | "highlight_note" | "discovery" | "document_embed" | "assistant";
            other: components["schemas"]["ResourceItemOut"];
            snapshot: components["schemas"]["CitationSnapshot"] | null;
            source: components["schemas"]["ResourceItemOut"];
            target: components["schemas"]["ResourceItemOut"];
        };
        /** ConnectionPageOut */
        ConnectionPageOut: {
            /** Items */
            items: components["schemas"]["ConnectionOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** ConnectionQueryRequest */
        ConnectionQueryRequest: {
            /** Cursor */
            cursor?: string | null;
            /**
             * Direction
             * @enum {string}
             */
            direction: "incoming" | "outgoing" | "both";
            filters?: components["schemas"]["ConnectionFiltersRequest"];
            /**
             * Limit
             * @default 100
             */
            limit: number;
            /** Refs */
            refs: string[];
            /**
             * Rollup
             * @default exact
             * @enum {string}
             */
            rollup: "exact" | "owner";
        };
        /** ConstellationOut */
        ConstellationOut: {
            /**
             * Library Id
             * Format: uuid
             */
            library_id: string;
            /** Member Media Ids */
            member_media_ids: string[];
            /** Name */
            name: string;
        };
        /** ConsumeHandoffCodeRequest */
        ConsumeHandoffCodeRequest: {
            /** Code */
            code: string;
            /** Verifier */
            verifier: string;
        };
        /** ConsumeNote */
        ConsumeNote: {
            /** Endpoint */
            endpoint: string;
            /** Expected Body Version */
            expected_body_version: number;
            /** Expected Links Version */
            expected_links_version: number | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "consume_note";
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
        };
        /** ConsumptionAction */
        ConsumptionAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /** Episode */
            episode: boolean;
            /** Finished */
            finished: boolean;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Consumption";
        };
        /**
         * ConsumptionOut
         * @description The viewer's read state of the media: the override, else progress, else engagement.
         */
        ConsumptionOut: {
            /** Progress */
            progress: number | null;
            /**
             * State
             * @enum {string}
             */
            state: "Unread" | "InProgress" | "Finished";
        };
        /** ConsumptionStatsOut */
        ConsumptionStatsOut: {
            activity: components["schemas"]["ActivityStatsSectionOut"];
            completion: components["schemas"]["CompletionStatsSectionOut"];
            retained_artifacts: components["schemas"]["RetainedArtifactsOut"];
        };
        /** ContextItemOut */
        ContextItemOut: {
            /** Admission Edge Ids */
            admission_edge_ids: string[];
            item: components["schemas"]["ResourceItemOut"];
            mutation: components["schemas"]["DetachContextMutation"];
        };
        /** ContextOut */
        ContextOut: {
            /** Items */
            items: components["schemas"]["ContextItemOut"][];
        };
        /** ContributorActivityBreakdownOut */
        ContributorActivityBreakdownOut: {
            /** Rows */
            rows: components["schemas"]["ContributorActivityOut"][];
        };
        /** ContributorActivityOut */
        ContributorActivityOut: {
            /** Active Ms */
            active_ms: number;
            /** Contributor Handle */
            contributor_handle: string;
            /** Display Name */
            display_name: string;
            /** Roles */
            roles: string[];
        };
        /** ContributorCompletionOut */
        ContributorCompletionOut: {
            /** Contributor Handle */
            contributor_handle: string;
            /** Display Name */
            display_name: string;
            /** Roles */
            roles: string[];
            /** Total */
            total: number;
        };
        /**
         * ContributorCreditOut
         * @description One ordered credit fact; discovery text facts have no handle or href.
         */
        ContributorCreditOut: {
            /** Contributor Display Name */
            contributor_display_name: string | null;
            /** Contributor Handle */
            contributor_handle: string | null;
            /** Credited Name */
            credited_name: string;
            /** Href */
            href: string | null;
            /** Ordinal */
            ordinal: number | null;
            /** Raw Role */
            raw_role: string | null;
            /**
             * Role
             * @enum {string}
             */
            role: "author" | "editor" | "translator" | "host" | "guest" | "narrator" | "creator" | "producer" | "publisher" | "channel" | "organization" | "unknown";
        };
        /** ContributorDetailOut */
        ContributorDetailOut: {
            /** Action Ref */
            action_ref: string;
            /** Display Name */
            display_name: string;
            /** Handle */
            handle: string;
            /** Href */
            href: string;
            /** Other Names */
            other_names: string[];
            /** Resource Ref */
            resource_ref: string;
        };
        /** ContributorRoleFactOut */
        ContributorRoleFactOut: {
            /** Credited Name */
            credited_name: string;
            /** Raw Role */
            raw_role: string | null;
            /**
             * Role
             * @enum {string}
             */
            role: "author" | "editor" | "translator" | "host" | "guest" | "narrator" | "creator" | "producer" | "publisher" | "channel" | "organization" | "unknown";
        };
        /** ContributorSearchItemOut */
        ContributorSearchItemOut: {
            /** Display Name */
            display_name: string;
            /** Handle */
            handle: string;
            /** Href */
            href: string;
            /** Matched Alias */
            matched_alias: string | null;
            /** Work Count */
            work_count: number;
            /** Work Examples */
            work_examples: components["schemas"]["ContributorWorkExampleOut"][];
        };
        /** ContributorSearchPageOut */
        ContributorSearchPageOut: {
            /** Contributors */
            contributors: components["schemas"]["ContributorSearchItemOut"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** ContributorWorkExampleOut */
        ContributorWorkExampleOut: {
            /** Href */
            href: string;
            /** Title */
            title: string;
        };
        /** ConversationListItemOut */
        ConversationListItemOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Message Count */
            message_count: number;
            /** Title */
            title: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** ConversationOut */
        ConversationOut: {
            /** Branch Revision */
            branch_revision: number;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Title */
            title: string;
        };
        /**
         * ConversationTreeOut
         * @description Every message once, in seq order, and the active leaf.
         */
        ConversationTreeOut: {
            /** Active Leaf Message Id */
            active_leaf_message_id: string | null;
            conversation: components["schemas"]["ConversationOut"];
            /** Messages */
            messages: components["schemas"]["MessageOut"][];
        };
        /**
         * CreateCaptureRequest
         * @description ``id`` is the extension's session id, minted once per draft and resent on retry.
         */
        CreateCaptureRequest: {
            /**
             * Content Type
             * @enum {string}
             */
            content_type: "application/pdf" | "application/epub+zip" | "application/json";
            /** Filename */
            filename: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "web_article" | "pdf" | "epub";
            /** Library Ids */
            library_ids?: string[];
            /** Sha256 */
            sha256: string;
            /** Size Bytes */
            size_bytes: number;
            /** Source Url */
            source_url: string;
            x_article_binding: components["schemas"]["XArticleBinding"] | null;
        };
        /**
         * CreateConversationRequest
         * @description A client-minted id: a resend answers the viewer's chat; another owner's id is 409.
         */
        CreateConversationRequest: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Initial Context Refs */
            initial_context_refs: string[];
        };
        /**
         * CreateInvitationRequest
         * @description Retry: resend the same client-minted id. `invitee_email` is the email the inviter
         *     typed to find the invitee (theirs, in any case), or null when found by name.
         */
        CreateInvitationRequest: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Invitee Email */
            invitee_email: string | null;
            /**
             * Invitee User Id
             * Format: uuid
             */
            invitee_user_id: string;
            /**
             * Role
             * @enum {string}
             */
            role: "admin" | "member";
        };
        /**
         * CreateLibraryRequest
         * @description Retry: resend the same client-minted id.
         */
        CreateLibraryRequest: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Name */
            name: string;
        };
        /** CreatePageRequest */
        CreatePageRequest: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Initial Item */
            initial_item: components["schemas"]["InitialNote"] | components["schemas"]["InitialResource"];
            /** Title */
            title: string;
        };
        /** CreateResourceShareOut */
        CreateResourceShareOut: {
            /** Created */
            created: boolean;
            /** Share */
            share: components["schemas"]["UserShareOut"] | components["schemas"]["LinkShareOut"];
        };
        /**
         * CreateResourceShareRequest
         * @description Retry: resend the same client-minted id.
         */
        CreateResourceShareRequest: {
            /** Audience */
            audience: components["schemas"]["UserAudienceIn"] | components["schemas"]["LinkAudienceIn"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
        };
        /**
         * CreateUploadRequest
         * @description ``id`` is the client's session id; a resend advances an unpublished session.
         */
        CreateUploadRequest: {
            /** Content Type */
            content_type: string;
            /** Filename */
            filename: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "pdf" | "epub";
            /** Library Ids */
            library_ids?: string[];
            /** Size Bytes */
            size_bytes: number;
        };
        /**
         * CreatedRefOut
         * @description A target one write inserted; its undo removes exactly these.
         */
        CreatedRefOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "entry" | "note_block" | "highlight" | "edge" | "queue";
            /** Label */
            label: string;
        };
        /** CreationAvailabilityOut */
        CreationAvailabilityOut: {
            /** Link */
            link: components["schemas"]["AudienceAvailableOut"] | components["schemas"]["AudienceUnavailableOut"];
            /** User */
            user: components["schemas"]["AudienceAvailableOut"] | components["schemas"]["AudienceUnavailableOut"];
        };
        /**
         * CursorWrite
         * @description Conditional cursor replacement against an acknowledged base revision.
         */
        CursorWrite: {
            /**
             * Adopt Unresolved
             * @default false
             */
            adopt_unresolved: boolean;
            /** Base Revision */
            base_revision: number;
            /** Expected Reader Generation */
            expected_reader_generation?: number | null;
            /** Locator */
            locator: components["schemas"]["PdfReaderResumeState"] | components["schemas"]["WebReaderResumeState"] | components["schemas"]["TranscriptReaderResumeState"] | components["schemas"]["EpubReaderResumeState"] | components["schemas"]["XReaderResumeState"];
        };
        /** DailyCaptureRequest */
        DailyCaptureRequest: {
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            /**
             * Note Id
             * Format: uuid
             */
            note_id: string;
            /** Text */
            text: string;
        };
        /**
         * DailyPageOut
         * @description A latent day carries its page's future id and default title, and no links.
         */
        DailyPageOut: {
            /**
             * Local Date
             * Format: date
             */
            local_date: string;
            /** Materialized */
            materialized: boolean;
            outline: components["schemas"]["OutlineOut"];
        };
        /** Data[ActivitySessionPageOut] */
        Data_ActivitySessionPageOut_: {
            data: components["schemas"]["ActivitySessionPageOut"];
        };
        /** Data[Annotated[Union[LearnDossierOpenedOut, LearnDossierBuildAcceptedOut], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        Data_Annotated_Union_LearnDossierOpenedOut__LearnDossierBuildAcceptedOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /** Data */
            data: components["schemas"]["LearnDossierOpenedOut"] | components["schemas"]["LearnDossierBuildAcceptedOut"];
        };
        /** Data[Annotated[Union[ReaderTextDocumentOut, ReaderPdfDocumentOut], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        Data_Annotated_Union_ReaderTextDocumentOut__ReaderPdfDocumentOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /** Data */
            data: components["schemas"]["ReaderTextDocumentOut"] | components["schemas"]["ReaderPdfDocumentOut"];
        };
        /** Data[Annotated[Union[SourceRepairAdmission, SearchRepairAdmission], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        Data_Annotated_Union_SourceRepairAdmission__SearchRepairAdmission___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /** Data */
            data: components["schemas"]["SourceRepairAdmission"] | components["schemas"]["SearchRepairAdmission"];
        };
        /** Data[Annotated[Union[UploadRequired, Published, Rejected], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        Data_Annotated_Union_UploadRequired__Published__Rejected___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /** Data */
            data: components["schemas"]["UploadRequired"] | components["schemas"]["Published"] | components["schemas"]["Rejected"];
        };
        /** Data[AssistantWritePage] */
        Data_AssistantWritePage_: {
            data: components["schemas"]["AssistantWritePage"];
        };
        /** Data[AtlasOut] */
        Data_AtlasOut_: {
            data: components["schemas"]["AtlasOut"];
        };
        /** Data[BrowsePage] */
        Data_BrowsePage_: {
            data: components["schemas"]["BrowsePage"];
        };
        /** Data[BrowsePreview] */
        Data_BrowsePreview_: {
            data: components["schemas"]["BrowsePreview"];
        };
        /** Data[CaptureTargetOut] */
        Data_CaptureTargetOut_: {
            data: components["schemas"]["CaptureTargetOut"];
        };
        /** Data[ChatAdmissionReceipt] */
        Data_ChatAdmissionReceipt_: {
            data: components["schemas"]["ChatAdmissionReceipt"];
        };
        /** Data[ChatRunResponse] */
        Data_ChatRunResponse_: {
            data: components["schemas"]["ChatRunResponse"];
        };
        /** Data[CollectionPage[Annotated[Union[MediaContributorWorkItemOut, PodcastContributorWorkItemOut, ExternalContributorWorkItemOut], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]]] */
        Data_CollectionPage_Annotated_Union_MediaContributorWorkItemOut__PodcastContributorWorkItemOut__ExternalContributorWorkItemOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind_____: {
            data: components["schemas"]["CollectionPage_Annotated_Union_MediaContributorWorkItemOut__PodcastContributorWorkItemOut__ExternalContributorWorkItemOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
        };
        /** Data[CollectionPage[ConversationListItemOut]] */
        Data_CollectionPage_ConversationListItemOut__: {
            data: components["schemas"]["CollectionPage_ConversationListItemOut_"];
        };
        /** Data[CollectionPage[LibraryInvitationOut]] */
        Data_CollectionPage_LibraryInvitationOut__: {
            data: components["schemas"]["CollectionPage_LibraryInvitationOut_"];
        };
        /** Data[CollectionPage[LibraryMemberOut]] */
        Data_CollectionPage_LibraryMemberOut__: {
            data: components["schemas"]["CollectionPage_LibraryMemberOut_"];
        };
        /** Data[CollectionPage[LibraryOut]] */
        Data_CollectionPage_LibraryOut__: {
            data: components["schemas"]["CollectionPage_LibraryOut_"];
        };
        /** Data[CollectionPage[NotePageSummaryOut]] */
        Data_CollectionPage_NotePageSummaryOut__: {
            data: components["schemas"]["CollectionPage_NotePageSummaryOut_"];
        };
        /** Data[CollectionPage[PodcastEpisodeListItemOut]] */
        Data_CollectionPage_PodcastEpisodeListItemOut__: {
            data: components["schemas"]["CollectionPage_PodcastEpisodeListItemOut_"];
        };
        /** Data[CollectionPage[PodcastSubscriptionListItemOut]] */
        Data_CollectionPage_PodcastSubscriptionListItemOut__: {
            data: components["schemas"]["CollectionPage_PodcastSubscriptionListItemOut_"];
        };
        /** Data[CollectionPage[ViewerInvitationOut]] */
        Data_CollectionPage_ViewerInvitationOut__: {
            data: components["schemas"]["CollectionPage_ViewerInvitationOut_"];
        };
        /** Data[ConnectionDiscoveryScanOut] */
        Data_ConnectionDiscoveryScanOut_: {
            data: components["schemas"]["ConnectionDiscoveryScanOut"];
        };
        /** Data[ConnectionPageOut] */
        Data_ConnectionPageOut_: {
            data: components["schemas"]["ConnectionPageOut"];
        };
        /** Data[ConsumptionStatsOut] */
        Data_ConsumptionStatsOut_: {
            data: components["schemas"]["ConsumptionStatsOut"];
        };
        /** Data[ContextOut] */
        Data_ContextOut_: {
            data: components["schemas"]["ContextOut"];
        };
        /** Data[ContributorDetailOut] */
        Data_ContributorDetailOut_: {
            data: components["schemas"]["ContributorDetailOut"];
        };
        /** Data[ContributorSearchPageOut] */
        Data_ContributorSearchPageOut_: {
            data: components["schemas"]["ContributorSearchPageOut"];
        };
        /** Data[ConversationOut] */
        Data_ConversationOut_: {
            data: components["schemas"]["ConversationOut"];
        };
        /** Data[ConversationTreeOut] */
        Data_ConversationTreeOut_: {
            data: components["schemas"]["ConversationTreeOut"];
        };
        /** Data[CreateResourceShareOut] */
        Data_CreateResourceShareOut_: {
            data: components["schemas"]["CreateResourceShareOut"];
        };
        /** Data[DailyPageOut] */
        Data_DailyPageOut_: {
            data: components["schemas"]["DailyPageOut"];
        };
        /** Data[DossierBuildCreatedOut] */
        Data_DossierBuildCreatedOut_: {
            data: components["schemas"]["DossierBuildCreatedOut"];
        };
        /** Data[DossierHeadOut] */
        Data_DossierHeadOut_: {
            data: components["schemas"]["DossierHeadOut"];
        };
        /** Data[ExtensionSessionOut] */
        Data_ExtensionSessionOut_: {
            data: components["schemas"]["ExtensionSessionOut"];
        };
        /** Data[ExtensionTokenOut] */
        Data_ExtensionTokenOut_: {
            data: components["schemas"]["ExtensionTokenOut"];
        };
        /** Data[Finish] */
        Data_Finish_: {
            data: components["schemas"]["Finish"];
        };
        /** Data[ForkTitleOut] */
        Data_ForkTitleOut_: {
            data: components["schemas"]["ForkTitleOut"];
        };
        /** Data[FromUrlOut] */
        Data_FromUrlOut_: {
            data: components["schemas"]["FromUrlOut"];
        };
        /** Data[GenerationCatalog] */
        Data_GenerationCatalog_: {
            data: components["schemas"]["GenerationCatalog"];
        };
        /** Data[HistoryPage] */
        Data_HistoryPage_: {
            data: components["schemas"]["HistoryPage"];
        };
        /** Data[ImportDetail] */
        Data_ImportDetail_: {
            data: components["schemas"]["ImportDetail"];
        };
        /** Data[ImportPage] */
        Data_ImportPage_: {
            data: components["schemas"]["ImportPage"];
        };
        /** Data[ImportSummary] */
        Data_ImportSummary_: {
            data: components["schemas"]["ImportSummary"];
        };
        /** Data[LecternOrderOut] */
        Data_LecternOrderOut_: {
            data: components["schemas"]["LecternOrderOut"];
        };
        /** Data[LecternOut] */
        Data_LecternOut_: {
            data: components["schemas"]["LecternOut"];
        };
        /** Data[LecternWriteOut] */
        Data_LecternWriteOut_: {
            data: components["schemas"]["LecternWriteOut"];
        };
        /** Data[LibraryEntriesPageOut] */
        Data_LibraryEntriesPageOut_: {
            data: components["schemas"]["LibraryEntriesPageOut"];
        };
        /** Data[LibraryInvitationOut] */
        Data_LibraryInvitationOut_: {
            data: components["schemas"]["LibraryInvitationOut"];
        };
        /** Data[LibraryOrderOut] */
        Data_LibraryOrderOut_: {
            data: components["schemas"]["LibraryOrderOut"];
        };
        /** Data[LibraryOut] */
        Data_LibraryOut_: {
            data: components["schemas"]["LibraryOut"];
        };
        /** Data[ListeningPositionOut] */
        Data_ListeningPositionOut_: {
            data: components["schemas"]["ListeningPositionOut"];
        };
        /** Data[MediaAuthorsOut] */
        Data_MediaAuthorsOut_: {
            data: components["schemas"]["MediaAuthorsOut"];
        };
        /** Data[MediaFileOut] */
        Data_MediaFileOut_: {
            data: components["schemas"]["MediaFileOut"];
        };
        /** Data[MediaOut] */
        Data_MediaOut_: {
            data: components["schemas"]["MediaOut"];
        };
        /** Data[MessageDeleteOut] */
        Data_MessageDeleteOut_: {
            data: components["schemas"]["MessageDeleteOut"];
        };
        /** Data[MetadataEnrichmentAccepted] */
        Data_MetadataEnrichmentAccepted_: {
            data: components["schemas"]["MetadataEnrichmentAccepted"];
        };
        /** Data[NexusHistoryOut] */
        Data_NexusHistoryOut_: {
            data: components["schemas"]["NexusHistoryOut"];
        };
        /** Data[NexusSelectionRecordOut] */
        Data_NexusSelectionRecordOut_: {
            data: components["schemas"]["NexusSelectionRecordOut"];
        };
        /** Data[NoteBlockOut] */
        Data_NoteBlockOut_: {
            data: components["schemas"]["NoteBlockOut"];
        };
        /** Data[OracleReadingCreatedOut] */
        Data_OracleReadingCreatedOut_: {
            data: components["schemas"]["OracleReadingCreatedOut"];
        };
        /** Data[OracleReadingOut] */
        Data_OracleReadingOut_: {
            data: components["schemas"]["OracleReadingOut"];
        };
        /** Data[OutlineOut] */
        Data_OutlineOut_: {
            data: components["schemas"]["OutlineOut"];
        };
        /** Data[PlayerDescriptor] */
        Data_PlayerDescriptor_: {
            data: components["schemas"]["PlayerDescriptor"];
        };
        /** Data[PodcastBackfillRetryOut] */
        Data_PodcastBackfillRetryOut_: {
            data: components["schemas"]["PodcastBackfillRetryOut"];
        };
        /** Data[PodcastDetailOut] */
        Data_PodcastDetailOut_: {
            data: components["schemas"]["PodcastDetailOut"];
        };
        /** Data[PodcastEpisodeConsumptionOut] */
        Data_PodcastEpisodeConsumptionOut_: {
            data: components["schemas"]["PodcastEpisodeConsumptionOut"];
        };
        /** Data[PodcastEpisodeConsumptionPreparedOut] */
        Data_PodcastEpisodeConsumptionPreparedOut_: {
            data: components["schemas"]["PodcastEpisodeConsumptionPreparedOut"];
        };
        /** Data[PodcastEpisodeFromDiscoveryOut] */
        Data_PodcastEpisodeFromDiscoveryOut_: {
            data: components["schemas"]["PodcastEpisodeFromDiscoveryOut"];
        };
        /** Data[PodcastEpisodeQueryTranscriptForecastOut] */
        Data_PodcastEpisodeQueryTranscriptForecastOut_: {
            data: components["schemas"]["PodcastEpisodeQueryTranscriptForecastOut"];
        };
        /** Data[PodcastEpisodeQueryTranscriptRequestOut] */
        Data_PodcastEpisodeQueryTranscriptRequestOut_: {
            data: components["schemas"]["PodcastEpisodeQueryTranscriptRequestOut"];
        };
        /** Data[PodcastRefreshAcceptedOut] */
        Data_PodcastRefreshAcceptedOut_: {
            data: components["schemas"]["PodcastRefreshAcceptedOut"];
        };
        /** Data[PodcastSubscribeOut] */
        Data_PodcastSubscribeOut_: {
            data: components["schemas"]["PodcastSubscribeOut"];
        };
        /** Data[PodcastSubscriptionStatusOut] */
        Data_PodcastSubscriptionStatusOut_: {
            data: components["schemas"]["PodcastSubscriptionStatusOut"];
        };
        /** Data[PodcastUnsubscribeOut] */
        Data_PodcastUnsubscribeOut_: {
            data: components["schemas"]["PodcastUnsubscribeOut"];
        };
        /** Data[PublicShareOut] */
        Data_PublicShareOut_: {
            data: components["schemas"]["PublicShareOut"];
        };
        /** Data[Published] */
        Data_Published_: {
            data: components["schemas"]["Published"];
        };
        /** Data[QuickReadsOut] */
        Data_QuickReadsOut_: {
            data: components["schemas"]["QuickReadsOut"];
        };
        /** Data[ReaderApparatusDetailOut] */
        Data_ReaderApparatusDetailOut_: {
            data: components["schemas"]["ReaderApparatusDetailOut"];
        };
        /** Data[ReaderDocumentMapOut] */
        Data_ReaderDocumentMapOut_: {
            data: components["schemas"]["ReaderDocumentMapOut"];
        };
        /** Data[ReaderProfileOut] */
        Data_ReaderProfileOut_: {
            data: components["schemas"]["ReaderProfileOut"];
        };
        /** Data[ReaderSelectionPreview] */
        Data_ReaderSelectionPreview_: {
            data: components["schemas"]["ReaderSelectionPreview"];
        };
        /** Data[ReadingCopyOut] */
        Data_ReadingCopyOut_: {
            data: components["schemas"]["ReadingCopyOut"];
        };
        /** Data[ResolvedMediaSummariesOut] */
        Data_ResolvedMediaSummariesOut_: {
            data: components["schemas"]["ResolvedMediaSummariesOut"];
        };
        /** Data[ResourceActionsOut] */
        Data_ResourceActionsOut_: {
            data: components["schemas"]["ResourceActionsOut"];
        };
        /** Data[ResourceItemOut] */
        Data_ResourceItemOut_: {
            data: components["schemas"]["ResourceItemOut"];
        };
        /** Data[ResourceShareSnapshotOut] */
        Data_ResourceShareSnapshotOut_: {
            data: components["schemas"]["ResourceShareSnapshotOut"];
        };
        /** Data[ResourceTargetSearchResponse] */
        Data_ResourceTargetSearchResponse_: {
            data: components["schemas"]["ResourceTargetSearchResponse"];
        };
        /** Data[ResourceVersionsOut] */
        Data_ResourceVersionsOut_: {
            data: components["schemas"]["ResourceVersionsOut"];
        };
        /** Data[SourceAdmission] */
        Data_SourceAdmission_: {
            data: components["schemas"]["SourceAdmission"];
        };
        /** Data[SourceAttemptOut] */
        Data_SourceAttemptOut_: {
            data: components["schemas"]["SourceAttemptOut"];
        };
        /** Data[SourceTargetOut] */
        Data_SourceTargetOut_: {
            data: components["schemas"]["SourceTargetOut"];
        };
        /** Data[SuggestionStateOut] */
        Data_SuggestionStateOut_: {
            data: components["schemas"]["SuggestionStateOut"];
        };
        /** Data[SuggestionViewOut] */
        Data_SuggestionViewOut_: {
            data: components["schemas"]["SuggestionViewOut"];
        };
        /** Data[SuggestionsOut] */
        Data_SuggestionsOut_: {
            data: components["schemas"]["SuggestionsOut"];
        };
        /** Data[TranscriptRequestOut] */
        Data_TranscriptRequestOut_: {
            data: components["schemas"]["TranscriptRequestOut"];
        };
        /** Data[TypedHighlightOut] */
        Data_TypedHighlightOut_: {
            data: components["schemas"]["TypedHighlightOut"];
        };
        /** Data[Union[ReaderCursorEmpty, ReaderCursorPositioned, ReaderCursorUnresolved]] */
        Data_Union_ReaderCursorEmpty__ReaderCursorPositioned__ReaderCursorUnresolved__: {
            /** Data */
            data: components["schemas"]["ReaderCursorEmpty"] | components["schemas"]["ReaderCursorPositioned"] | components["schemas"]["ReaderCursorUnresolved"];
        };
        /** Data[UserProfileOut] */
        Data_UserProfileOut_: {
            data: components["schemas"]["UserProfileOut"];
        };
        /** Data[WorkspacePresentationsOut] */
        Data_WorkspacePresentationsOut_: {
            data: components["schemas"]["WorkspacePresentationsOut"];
        };
        /** Data[WorkspaceSessionsOut] */
        Data_WorkspaceSessionsOut_: {
            data: components["schemas"]["WorkspaceSessionsOut"];
        };
        /** Data[WritingAck] */
        Data_WritingAck_: {
            data: components["schemas"]["WritingAck"];
        };
        /** Data[list[LibraryDestinationOut]] */
        Data_list_LibraryDestinationOut__: {
            /** Data */
            data: components["schemas"]["LibraryDestinationOut"][];
        };
        /** Data[list[LibraryPlacementOut]] */
        Data_list_LibraryPlacementOut__: {
            /** Data */
            data: components["schemas"]["LibraryPlacementOut"][];
        };
        /** Data[list[OracleConcordanceOut]] */
        Data_list_OracleConcordanceOut__: {
            /** Data */
            data: components["schemas"]["OracleConcordanceOut"][];
        };
        /** Data[list[OracleReadingSummaryOut]] */
        Data_list_OracleReadingSummaryOut__: {
            /** Data */
            data: components["schemas"]["OracleReadingSummaryOut"][];
        };
        /** Data[list[UserSearchOut]] */
        Data_list_UserSearchOut__: {
            /** Data */
            data: components["schemas"]["UserSearchOut"][];
        };
        /** DeleteHighlightNoteRequest */
        DeleteHighlightNoteRequest: {
            /** Expected Version */
            expected_version: number;
            /**
             * Note Id
             * Format: uuid
             */
            note_id: string;
        };
        /** DetachContextMutation */
        DetachContextMutation: {
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
            /** Expected Context Version */
            expected_context_version: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "detach_context";
            /** Target Ref */
            target_ref: string;
        };
        /** DeviceActivityOut */
        DeviceActivityOut: {
            /** Active Ms */
            active_ms: number;
            /** Device Id */
            device_id: string;
            /** Is Current */
            is_current: boolean;
            /** Label */
            label: string;
        };
        /** DeviceSummaryOut */
        DeviceSummaryOut: {
            /** Device Id */
            device_id: string;
            /** Label */
            label: string;
        };
        /** @enum {string} */
        DiscoveryKind: "documents" | "notes" | "highlights" | "conversations" | "people" | "web" | "libraries" | "readings" | "dossiers" | "saved_passages";
        /** DocumentEmbedDisplayActionOut */
        DocumentEmbedDisplayActionOut: {
            /**
             * Disabled
             * @default false
             */
            disabled: boolean;
            /** Href */
            href: string | null;
            /**
             * Kind
             * @enum {string}
             */
            kind: "open_child_media" | "open_original" | "view_import" | "retry_child" | "refresh_parent";
            /** Label */
            label: string;
        };
        /** DocumentEmbedDisplayOut */
        DocumentEmbedDisplayOut: {
            /** Actions */
            actions: components["schemas"]["DocumentEmbedDisplayActionOut"][];
            /** Description */
            description: string | null;
            /** Label */
            label: string;
            /** Mode */
            mode: ("resolved" | "pending" | "unsupported" | "failed") | null;
        };
        /** DocumentEmbedLocatorOut */
        DocumentEmbedLocatorOut: {
            /** Canonical End Offset */
            canonical_end_offset: number | null;
            /** Canonical Start Offset */
            canonical_start_offset: number | null;
            /** Document Order Key */
            document_order_key: string;
            /** Fragment Id */
            fragment_id: string | null;
            /**
             * Kind
             * @enum {string}
             */
            kind: "anchored" | "unanchored";
            /** Placeholder Text */
            placeholder_text: string;
            /** Unit Id */
            unit_id: string | null;
        };
        /** DocumentEmbedOut */
        DocumentEmbedOut: {
            authored_text: components["schemas"]["DocumentEmbedTextOut"];
            canonical_url: components["schemas"]["DocumentEmbedUrlOut"];
            description: components["schemas"]["DocumentEmbedTextOut"];
            display: components["schemas"]["DocumentEmbedDisplayOut"];
            error_code: components["schemas"]["DocumentEmbedTextOut"];
            /** Fragment Id */
            fragment_id: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "video" | "post" | "audio" | "link_preview" | "unknown";
            locator: components["schemas"]["DocumentEmbedLocatorOut"];
            /** Media Id */
            media_id: string | null;
            /** Occurrence Key */
            occurrence_key: string;
            /** Ordinal */
            ordinal: number;
            /**
             * Provider
             * @enum {string}
             */
            provider: "youtube" | "x" | "substack" | "vimeo" | "spotify" | "generic" | "unknown";
            provider_target_ref: components["schemas"]["DocumentEmbedProviderRefOut"];
            /** Resolution Status */
            resolution_status: ("resolving" | "resolved" | "unsupported" | "failed") | null;
            /**
             * Source Shape
             * @enum {string}
             */
            source_shape: "iframe" | "blockquote" | "anchor" | "video_tag" | "provider_json" | "unknown";
            source_url: components["schemas"]["DocumentEmbedUrlOut"];
            target: components["schemas"]["DocumentEmbedTargetOut"];
            thumbnail_url: components["schemas"]["DocumentEmbedUrlOut"];
            title: components["schemas"]["DocumentEmbedTextOut"];
        };
        /** DocumentEmbedProviderRefOut */
        DocumentEmbedProviderRefOut: {
            /**
             * Kind
             * @enum {string}
             */
            kind: "present" | "absent";
            /** Reason */
            reason: ("unsupported_provider" | "unparseable" | "not_applicable") | null;
            /** Value */
            value: string | null;
        };
        /** DocumentEmbedTargetOut */
        DocumentEmbedTargetOut: {
            /** Byline */
            byline: string | null;
            /** Href */
            href: string | null;
            /** Kind */
            kind: string | null;
            /** Media Id */
            media_id: string | null;
            playback: components["schemas"]["PlaybackSourceOut"] | null;
            /** Resource Ref */
            resource_ref: string | null;
            /**
             * Status
             * @enum {string}
             */
            status: "exact" | "container" | "missing" | "forbidden" | "unanchorable" | "stale" | "unsupported" | "partial";
            /** Thumbnail Url */
            thumbnail_url: string | null;
            /** Title */
            title: string | null;
            x_article_content: components["schemas"]["XArticleContent"] | null;
        };
        /** DocumentEmbedTextOut */
        DocumentEmbedTextOut: {
            /**
             * Kind
             * @enum {string}
             */
            kind: "present" | "absent";
            /** Reason */
            reason: ("not_in_source" | "redacted" | "not_applicable") | null;
            /** Value */
            value: string | null;
        };
        /** DocumentEmbedUrlOut */
        DocumentEmbedUrlOut: {
            /** Error Code */
            error_code: string | null;
            /** Reason */
            reason: ("not_in_source" | "not_applicable") | null;
            /**
             * Status
             * @enum {string}
             */
            status: "present" | "malformed" | "absent";
            /** Value */
            value: string | null;
        };
        /** DossierBuildCreatedOut */
        DossierBuildCreatedOut: {
            /** Artifact Ref */
            artifact_ref: string;
            /** Build Handle */
            build_handle: string;
            /** Created */
            created: boolean;
        };
        /**
         * DossierBuildOut
         * @description One build; also the SSE snapshot. ``phase`` is set only while Active.
         */
        DossierBuildOut: {
            failure_code: components["schemas"]["DossierFailureCode"] | null;
            /** Handle */
            handle: string;
            /** Instruction */
            instruction: string | null;
            phase: components["schemas"]["DurableExecutionPhase"] | null;
            /**
             * Status
             * @enum {string}
             */
            status: "Active" | "Succeeded" | "Failed" | "Cancelled";
        };
        /** DossierCoverageOut */
        DossierCoverageOut: {
            /** Included */
            included: number;
            /** Omitted */
            omitted: number;
            /**
             * Unit
             * @enum {string}
             */
            unit: "claim" | "media" | "episode" | "work" | "source";
        };
        /**
         * DossierFailureCode
         * @enum {string}
         */
        DossierFailureCode: "NoSourceMaterial" | "InputsChanged" | "DependencyProjectionFailed" | "ContextTooLarge" | "Auth" | "Quota" | "Timeout" | "OutputLimit" | "InvalidOutput" | "PolicyViolation" | "RuntimeUnavailable" | "DocumentValidationFailed" | "CitationValidationFailed";
        /** DossierGenerateRequest */
        DossierGenerateRequest: {
            /** Instruction */
            instruction: string | null;
        };
        /**
         * DossierHeadOut
         * @description ``artifact_ref`` null: never generated (a head read never inserts a head).
         */
        DossierHeadOut: {
            active_build: components["schemas"]["DossierBuildOut"] | null;
            /** Artifact Ref */
            artifact_ref: string | null;
            last_failure: components["schemas"]["DossierBuildOut"] | null;
            media_abstract: components["schemas"]["MediaAbstractOut"] | null;
            revision: components["schemas"]["DossierRevisionOut"] | null;
            subject_activation: components["schemas"]["ResourceActivationOut"] | null;
            /** Title */
            title: string;
        };
        /** DossierRevisionOut */
        DossierRevisionOut: {
            /** By Viewer */
            by_viewer: boolean;
            /** Citations */
            citations: components["schemas"]["CitationOut"][];
            /** Content Html */
            content_html: string;
            coverage: components["schemas"]["DossierCoverageOut"];
            /**
             * Generated At
             * Format: date-time
             */
            generated_at: string;
            /** Instruction */
            instruction: string | null;
            /** Model */
            model: string | null;
            /** Revision Ref */
            revision_ref: string;
            /** Stale */
            stale: boolean;
            /** Total Tokens */
            total_tokens: number | null;
        };
        /**
         * DownloadAction
         * @description What android needs to keep this media offline: an episode's audio or a reading copy.
         */
        DownloadAction: {
            /** Audio Url */
            audio_url: string | null;
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Download";
            /**
             * Media Kind
             * @enum {string}
             */
            media_kind: "podcast_episode" | "pdf" | "epub" | "web_article";
            /** Title */
            title: string;
        };
        /**
         * DurableExecutionPhase
         * @description Advisory liveness projected from one live queue job.
         * @enum {string}
         */
        DurableExecutionPhase: "Queued" | "Running" | "Recovering" | "Suspended";
        /**
         * EmptyInsertion
         * @description The first turn of a context-bearing chat made by ``POST /conversations``.
         */
        EmptyInsertion: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Empty";
        };
        /** EnsureDaily */
        EnsureDaily: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "ensure_daily";
            /**
             * Local Date
             * Format: date
             */
            local_date: string;
            /**
             * Page Id
             * Format: uuid
             */
            page_id: string;
        };
        /**
         * EnsureMediaHighlightRequest
         * @description Create or reuse the viewer's exact text span or canonical page geometry.
         */
        EnsureMediaHighlightRequest: {
            /** Anchor */
            anchor: components["schemas"]["TextHighlightAnchorIn"] | components["schemas"]["PdfHighlightAnchorIn"];
            /**
             * Color
             * @enum {string}
             */
            color: "yellow" | "green" | "blue" | "pink" | "purple";
            /** Expected Reader Generation */
            expected_reader_generation: number;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            initial_note: components["schemas"]["InitialHighlightNote"] | null;
        };
        /** EpisodePreview */
        EpisodePreview: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Description */
            description: string | null;
            /** Image */
            image: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Episode";
            kind_facts: components["schemas"]["EpisodePreviewFacts"];
            /** Published At */
            published_at: string | null;
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default PodcastIndex
             * @constant
             */
            source: "PodcastIndex";
            /** Source Href */
            source_href: string;
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** EpisodePreviewFacts */
        EpisodePreviewFacts: {
            /** Audio Href */
            audio_href: string;
            /** Duration Seconds */
            duration_seconds: number | null;
            /** Episode Ref */
            episode_ref: string;
            /** Podcast Ref */
            podcast_ref: string;
            /** Podcast Title */
            podcast_title: string;
        };
        /** EpubCandidate */
        EpubCandidate: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Description */
            description: string | null;
            /** Image */
            image: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Epub";
            kind_facts: components["schemas"]["EpubFacts"];
            /** Published At */
            published_at: string | null;
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default ProjectGutenberg
             * @constant
             */
            source: "ProjectGutenberg";
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** EpubFacts */
        EpubFacts: {
            /** Ebook Ref */
            ebook_ref: string | null;
        };
        /** EpubFragmentOffsetsLocator */
        EpubFragmentOffsetsLocator: {
            /** End Offset */
            end_offset: number;
            /** Fragment Id */
            fragment_id: string;
            /** Media Id */
            media_id: string;
            /** Media Kind */
            media_kind?: string | null;
            /** Section Id */
            section_id?: string | null;
            /** Start Offset */
            start_offset: number;
            text_quote_selector?: components["schemas"]["TextQuoteSelector"] | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "epub_fragment_offsets";
        };
        /** EpubPreview */
        EpubPreview: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Description */
            description: string | null;
            /** Image */
            image: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Epub";
            kind_facts: components["schemas"]["EpubPreviewFacts"];
            /** Published At */
            published_at: string | null;
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default ProjectGutenberg
             * @constant
             */
            source: "ProjectGutenberg";
            /** Source Href */
            source_href: string;
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** EpubPreviewFacts */
        EpubPreviewFacts: {
            /** Ebook Ref */
            ebook_ref: string;
            /** Import Href */
            import_href: string;
        };
        /** EpubReaderResumeState */
        EpubReaderResumeState: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "epub";
            locations: components["schemas"]["ReaderTextLocations"];
            target: components["schemas"]["ReaderEpubTarget"];
            text: components["schemas"]["ReaderQuoteContext"];
        };
        /** ExcerptOut */
        ExcerptOut: {
            /** Text */
            text: string;
            /** Truncated After */
            truncated_after: boolean;
            /** Truncated Before */
            truncated_before: boolean;
        };
        /**
         * ExcludeSessionIn
         * @description One exact all-time session (``PUT /consumption/exclusions/{id}``).
         */
        ExcludeSessionIn: {
            /** Device Id */
            device_id: string;
            /**
             * Ended At
             * Format: date-time
             */
            ended_at: string;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /**
             * Modality
             * @enum {string}
             */
            modality: "Reading" | "Listening" | "Viewing";
            /**
             * Started At
             * Format: date-time
             */
            started_at: string;
        };
        /** ExistingAuthorBinding */
        ExistingAuthorBinding: {
            /** Contributor Handle */
            contributor_handle: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "existing";
        };
        /** ExistingChatDestination */
        ExistingChatDestination: {
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
            /** Expected Revision */
            expected_revision: number;
            /** Insertion */
            insertion: components["schemas"]["EmptyInsertion"] | components["schemas"]["ReplyInsertion"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Existing";
        };
        /** ExistingHighlightNoteExpected */
        ExistingHighlightNoteExpected: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "version";
            /** Version */
            version: number;
        };
        /** ExtensionSessionOut */
        ExtensionSessionOut: {
            /** Display Name */
            display_name: string | null;
            /** Email */
            email: string | null;
            limits: components["schemas"]["CaptureLimits"];
            /**
             * User Id
             * Format: uuid
             */
            user_id: string;
        };
        /** ExtensionTokenOut */
        ExtensionTokenOut: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Token */
            token: string;
        };
        /** ExternalActivityTargetOut */
        ExternalActivityTargetOut: {
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "external";
        };
        /**
         * ExternalContributorWorkItemOut
         * @description External identity: the sealed target acquires it; href retains provenance only.
         */
        ExternalContributorWorkItemOut: {
            /**
             * Content Kind
             * @constant
             */
            content_kind: "project_gutenberg_ebook";
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "ExternalWork";
            /** Role Facts */
            role_facts: components["schemas"]["ContributorRoleFactOut"][];
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** ExternalUrlLocator */
        ExternalUrlLocator: {
            /** Accessed At */
            accessed_at?: string | null;
            /** Display Url */
            display_url?: string | null;
            /** Title */
            title?: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "external_url";
            /** Url */
            url: string;
        };
        /**
         * Finish
         * @description A finish's answer and its undo's body: the revision it wrote, the status it replaced, the
         *     completion fact it recorded and the row it removed.
         */
        Finish: {
            /** Completion Id */
            completion_id: string | null;
            /** Prior Status */
            prior_status: ("finished" | "unread") | null;
            removed: components["schemas"]["RemovedItem"] | null;
            /** Revision */
            revision: number;
        };
        /** FinishIn */
        FinishIn: {
            /** Leave Lectern */
            leave_lectern: boolean;
        };
        /** FirstPlacement */
        FirstPlacement: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "First";
        };
        /** FooterAudioActivation */
        FooterAudioActivation: {
            descriptor: components["schemas"]["PlayerDescriptor"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "FooterAudio";
        };
        /** ForkTitleOut */
        ForkTitleOut: {
            /** Fork Title */
            fork_title: string | null;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /**
         * ForkTitleRequest
         * @description An absolute title and the one the client saw; a landed retry finds current = desired.
         */
        ForkTitleRequest: {
            /** Expected Title */
            expected_title: string | null;
            /** Title */
            title: string | null;
        };
        /** FragmentAnchorOut */
        FragmentAnchorOut: {
            /** End Offset */
            end_offset: number | null;
            /** Fragment Id */
            fragment_id: string | null;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Start Offset */
            start_offset: number | null;
            /**
             * Type
             * @default fragment_offsets
             * @constant
             */
            type: "fragment_offsets";
        };
        /** FragmentAnchorUpdateRequest */
        FragmentAnchorUpdateRequest: {
            /** End Offset */
            end_offset: number;
            /** Start Offset */
            start_offset: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "fragment_offsets";
            /**
             * Unit Id
             * Format: uuid
             */
            unit_id: string;
        };
        /** FromUrlOut */
        FromUrlOut: {
            /** Created */
            created: boolean;
            /** Import Ref */
            import_ref: string;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            processing_status: components["schemas"]["ProcessingStatus"];
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /**
         * FromUrlRequest
         * @description ``id`` is the client-minted attempt id: resending it answers the same acceptance.
         *
         *     Version 4 only: successor and system ids are version 5 (``uuid5``), so a client id
         *     can never name an attempt the server derives (I10).
         */
        FromUrlRequest: {
            /**
             * Id
             * Format: uuid4
             */
            id: string;
            /** Library Ids */
            library_ids?: string[];
            /**
             * Url
             * @description The URL to ingest. Must be an absolute http/https URL, including PDF, EPUB, article, or video URLs.
             */
            url: string;
        };
        /** @enum {string} */
        GenerationApiProvider: "openai" | "anthropic" | "gemini" | "deepseek" | "xai";
        /** GenerationCatalog */
        GenerationCatalog: {
            chat_seed: components["schemas"]["ChatSeed"];
            /**
             * Observed At
             * Format: date-time
             */
            observed_at: string;
            /** Routes */
            routes: components["schemas"]["GenerationCatalogRoute"][];
        };
        /** GenerationCatalogRoute */
        GenerationCatalogRoute: {
            /** Billing */
            billing: components["schemas"]["SubscriptionBilling"] | components["schemas"]["MeteredApiBilling"];
            /** Label */
            label: string;
            /** Models */
            models: components["schemas"]["GenerationModelRow"][];
            privacy: components["schemas"]["PrivacyDisclosure"];
            processor_chain: components["schemas"]["ProcessorChain"];
            /** Readiness */
            readiness: components["schemas"]["Ready"] | components["schemas"]["OperatorActionRequired"] | components["schemas"]["TemporarilyUnavailable"];
            /** Route */
            route: components["schemas"]["CodexPersonalRoute"] | components["schemas"]["ProviderApiRoute"];
        };
        /** GenerationModelRow */
        GenerationModelRow: {
            /** Description */
            description: string;
            /** Effective Chat Context Budget Tokens */
            effective_chat_context_budget_tokens: number;
            /** Effective Chat Output Budget Tokens */
            effective_chat_output_budget_tokens: number;
            /** Input Modalities */
            input_modalities: ("text" | "image")[];
            /** Key */
            key: string;
            /** Label */
            label: string;
            /** Readiness */
            readiness: components["schemas"]["Ready"] | components["schemas"]["OperatorActionRequired"] | components["schemas"]["TemporarilyUnavailable"];
            /** Reasoning */
            reasoning: components["schemas"]["GenerationReasoningRow"][];
            /** Source Context Window */
            source_context_window: number | null;
            /** Source Default Reasoning */
            source_default_reasoning: string | null;
            /** Source Max Output Tokens */
            source_max_output_tokens: number | null;
        };
        /** GenerationReasoningRow */
        GenerationReasoningRow: {
            /** Chat State */
            chat_state: components["schemas"]["Selectable"] | components["schemas"]["Ineligible"] | components["schemas"]["OperatorActionRequired"] | components["schemas"]["TemporarilyUnavailable"];
            /** Effort */
            effort: string;
            /** Effort Order */
            effort_order: number;
            /** Key */
            key: string;
            /** Label */
            label: string;
            /** Mode */
            mode: string | null;
            /** Readiness */
            readiness: components["schemas"]["Ready"] | components["schemas"]["OperatorActionRequired"] | components["schemas"]["TemporarilyUnavailable"];
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /** HighlightNoteAction */
        HighlightNoteAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "HighlightNote";
            /** Note Block Id */
            note_block_id: string | null;
        };
        /** HighlightTargetPdfQuadOut */
        HighlightTargetPdfQuadOut: {
            /** X1 */
            x1: number;
            /** X2 */
            x2: number;
            /** X3 */
            x3: number;
            /** X4 */
            x4: number;
            /** Y1 */
            y1: number;
            /** Y2 */
            y2: number;
            /** Y3 */
            y3: number;
            /** Y4 */
            y4: number;
        };
        /**
         * HistoryEntry
         * @description One recorded event or metadata operation; `id` is `upload:`, `processing:` or
         *     `metadata:` and the row's uuid.
         */
        HistoryEntry: {
            /** Facts */
            facts: components["schemas"]["UploadAccepted"] | components["schemas"]["UploadRecoveryAccepted"] | components["schemas"]["UploadPublished"] | components["schemas"]["UploadFailed"] | components["schemas"]["UploadHistoryBaseline"] | components["schemas"]["SourceAccepted"] | components["schemas"]["SourceExecutionStarted"] | components["schemas"]["SourceStageChanged"] | components["schemas"]["SourceRetryScheduled"] | components["schemas"]["SourceFailed"] | components["schemas"]["SourceRecoveryAccepted"] | components["schemas"]["SourceSucceeded"] | components["schemas"]["SourceHistoryBaseline"] | components["schemas"]["IndexAccepted"] | components["schemas"]["IndexExecutionStarted"] | components["schemas"]["IndexRetryScheduled"] | components["schemas"]["IndexFailed"] | components["schemas"]["IndexRecoveryAccepted"] | components["schemas"]["IndexSucceeded"] | components["schemas"]["IndexSuperseded"] | components["schemas"]["MetadataOperationFacts"];
            failure_code: components["schemas"]["ImportFailureCode"] | null;
            /** Id */
            id: string;
            /**
             * Occurred At
             * Format: date-time
             */
            occurred_at: string;
            /** Stage */
            stage: ("Upload" | "Validate" | "Extract" | "Finalize" | "SourceProcessing" | "Index" | "Metadata") | null;
        };
        /** HistoryPage */
        HistoryPage: {
            /** Entries */
            entries: components["schemas"]["HistoryEntry"][];
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** ImagesResourceBodyOut */
        ImagesResourceBodyOut: {
            /** Alts */
            alts: (components["schemas"]["ExcerptOut"] | null)[];
            /** Count */
            count: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "images";
        };
        /** ImportDetail */
        ImportDetail: {
            item: components["schemas"]["ImportItem"];
            /** Related Imports */
            related_imports: components["schemas"]["RelatedImport"][];
            /** Source Issues */
            source_issues: (components["schemas"]["MissingImage"] | components["schemas"]["UnresolvedNavigationTarget"] | components["schemas"]["TooManyNotes"])[];
        };
        ImportFailureCode: ("E_SOURCE_INTEGRITY" | "E_INVALID_FILE_TYPE" | "E_FILE_TOO_LARGE" | "E_CAPTURE_TOO_LARGE") | ("E_ARCHIVE_UNSAFE" | "E_CAPTURE_TOO_LARGE" | "E_EMBEDDING_PROVIDER_UNAVAILABLE" | "E_FORBIDDEN" | "E_INGEST_FAILED" | "E_INGEST_TIMEOUT" | "E_INTERNAL" | "E_INVALID_CONTENT_TYPE" | "E_INVALID_KIND" | "E_INVALID_REQUEST" | "E_MEDIA_NOT_FOUND" | "E_MEDIA_NOT_READY" | "E_OWNER_REQUIRED" | "E_PDF_PASSWORD_REQUIRED" | "E_PDF_TEXT_UNAVAILABLE" | "E_PODCAST_PROVIDER_UNAVAILABLE" | "E_REPAIR_NOT_ALLOWED" | "E_RESOURCE_CONFLICT" | "E_RESOURCE_LIMIT" | "E_RETRY_INVALID_STATE" | "E_RETRY_NOT_ALLOWED" | "E_SANITIZATION_FAILED" | "E_SELECTION_CHANGED" | "E_SIGN_UPLOAD_FAILED" | "E_SOURCE_ACCESS_DENIED" | "E_SOURCE_FETCH_FAILED" | "E_SOURCE_GONE" | "E_SOURCE_NOT_READABLE" | "E_SOURCE_POSITION_UNMAPPABLE" | "E_SOURCE_TOO_LARGE" | "E_SSRF_BLOCKED" | "E_STORAGE_ERROR" | "E_STORAGE_MISSING" | "E_TRANSCRIPTION_FAILED" | "E_TRANSCRIPTION_TIMEOUT" | "E_TRANSCRIPT_UNAVAILABLE" | "E_UPLOAD_CAPABILITY_EXPIRED" | "E_WORKER_HANDLER_FAILED" | "E_WORKER_INTERRUPTED" | "E_X_POST_UNAVAILABLE" | "E_X_ARTICLE_BODY_UNAVAILABLE" | "E_X_ARTICLE_IDENTITY_CHANGED" | "E_X_IDENTITY_CONFLICT" | "E_X_SOURCE_CONFLICT" | "E_X_PROVIDER_AUTH_REJECTED" | "E_X_PROVIDER_CREDITS_DEPLETED" | "E_X_PROVIDER_RATE_LIMITED" | "E_X_PROVIDER_TIMEOUT" | "E_X_PROVIDER_UNAVAILABLE") | components["schemas"]["MetadataFailureCode"];
        /** ImportItem */
        ImportItem: {
            /**
             * Accepted At
             * Format: date-time
             */
            accepted_at: string;
            /** Can Play */
            can_play: boolean;
            /** Can Read */
            can_read: boolean;
            /**
             * Classification
             * @enum {string}
             */
            classification: "Active" | "NeedsAttention" | "Complete";
            matched_event: components["schemas"]["HistoryEntry"] | null;
            /** Media Id */
            media_id: string | null;
            media_kind: components["schemas"]["MediaKind"];
            obligations: components["schemas"]["ImportObligations"];
            /** Original Filename */
            original_filename: string | null;
            /** Primary */
            primary: ("source" | "search" | "metadata") | null;
            /** Ref */
            ref: string;
            /** Source Issue Count */
            source_issue_count: number;
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /**
         * ImportObligation
         * @description One source or search obligation as it stands. `status`, `waiting_reason`, `progress`
         *     and `next_retry_at` describe Active work, `failure_code` NeedsAttention work; the
         *     owner's answer is an offer, a restriction, or neither.
         */
        ImportObligation: {
            /**
             * Classification
             * @enum {string}
             */
            classification: "Active" | "NeedsAttention" | "Complete";
            /** Failure Code */
            failure_code: ("E_SOURCE_INTEGRITY" | "E_INVALID_FILE_TYPE" | "E_FILE_TOO_LARGE" | "E_CAPTURE_TOO_LARGE") | ("E_ARCHIVE_UNSAFE" | "E_CAPTURE_TOO_LARGE" | "E_EMBEDDING_PROVIDER_UNAVAILABLE" | "E_FORBIDDEN" | "E_INGEST_FAILED" | "E_INGEST_TIMEOUT" | "E_INTERNAL" | "E_INVALID_CONTENT_TYPE" | "E_INVALID_KIND" | "E_INVALID_REQUEST" | "E_MEDIA_NOT_FOUND" | "E_MEDIA_NOT_READY" | "E_OWNER_REQUIRED" | "E_PDF_PASSWORD_REQUIRED" | "E_PDF_TEXT_UNAVAILABLE" | "E_PODCAST_PROVIDER_UNAVAILABLE" | "E_REPAIR_NOT_ALLOWED" | "E_RESOURCE_CONFLICT" | "E_RESOURCE_LIMIT" | "E_RETRY_INVALID_STATE" | "E_RETRY_NOT_ALLOWED" | "E_SANITIZATION_FAILED" | "E_SELECTION_CHANGED" | "E_SIGN_UPLOAD_FAILED" | "E_SOURCE_ACCESS_DENIED" | "E_SOURCE_FETCH_FAILED" | "E_SOURCE_GONE" | "E_SOURCE_NOT_READABLE" | "E_SOURCE_POSITION_UNMAPPABLE" | "E_SOURCE_TOO_LARGE" | "E_SSRF_BLOCKED" | "E_STORAGE_ERROR" | "E_STORAGE_MISSING" | "E_TRANSCRIPTION_FAILED" | "E_TRANSCRIPTION_TIMEOUT" | "E_TRANSCRIPT_UNAVAILABLE" | "E_UPLOAD_CAPABILITY_EXPIRED" | "E_WORKER_HANDLER_FAILED" | "E_WORKER_INTERRUPTED" | "E_X_POST_UNAVAILABLE" | "E_X_ARTICLE_BODY_UNAVAILABLE" | "E_X_ARTICLE_IDENTITY_CHANGED" | "E_X_IDENTITY_CONFLICT" | "E_X_SOURCE_CONFLICT" | "E_X_PROVIDER_AUTH_REJECTED" | "E_X_PROVIDER_CREDITS_DEPLETED" | "E_X_PROVIDER_RATE_LIMITED" | "E_X_PROVIDER_TIMEOUT" | "E_X_PROVIDER_UNAVAILABLE") | null;
            /** Next Retry At */
            next_retry_at: string | null;
            /** Progress */
            progress: (components["schemas"]["SourceStageProgress"] | components["schemas"]["SourceCountedProgress"]) | null;
            /** Recovery */
            recovery: components["schemas"]["RetryUploadOffer"] | components["schemas"]["RetrySourceOffer"] | components["schemas"]["RepairSourceOffer"] | components["schemas"]["RepairSearchOffer"] | null;
            /**
             * Stage
             * @enum {string}
             */
            stage: "Upload" | "Validate" | "Extract" | "Finalize" | "SourceProcessing" | "Index" | "Metadata";
            /** Status */
            status: ("Queued" | "Processing") | null;
            /** Unavailable Reason */
            unavailable_reason: ("NotOwner" | "SameSourceTerminal" | "SourceNotReacquirable" | "UploadRejected") | null;
            /** Waiting Reason */
            waiting_reason: ("Queue" | "Capacity" | "RetryBackoff" | "AwaitingUploadConfirmation") | null;
        };
        /** ImportObligations */
        ImportObligations: {
            metadata: components["schemas"]["MetadataEnrichmentView"] | null;
            search: components["schemas"]["ImportObligation"] | null;
            source: components["schemas"]["ImportObligation"] | null;
        };
        /** ImportPage */
        ImportPage: {
            /** Items */
            items: components["schemas"]["ImportItem"][];
            /** Matched Count */
            matched_count: number;
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** ImportSummary */
        ImportSummary: {
            /** Active Count */
            active_count: number;
            /** Needs Attention Count */
            needs_attention_count: number;
            /**
             * Observed At
             * Format: date-time
             */
            observed_at: string;
            /** Unfinished Work Count */
            unfinished_work_count: number;
        };
        /** InNexusMediaResolution */
        InNexusMediaResolution: {
            /** Action Ref */
            action_ref: string;
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "InNexusMedia";
            media_summary: components["schemas"]["MediaSummaryOut"];
        };
        /** InNexusPodcastResolution */
        InNexusPodcastResolution: {
            /** Action Ref */
            action_ref: string;
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "InNexusPodcast";
            /** Resource Ref */
            resource_ref: string;
        };
        /** IndexAccepted */
        IndexAccepted: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "IndexAccepted";
            /** Revision */
            revision: number;
        };
        /** IndexExecutionStarted */
        IndexExecutionStarted: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "IndexExecutionStarted";
            /** Revision */
            revision: number;
        };
        /** IndexFailed */
        IndexFailed: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "IndexFailed";
            /** Revision */
            revision: number;
            /** Terminal */
            terminal: boolean;
        };
        /** IndexRecoveryAccepted */
        IndexRecoveryAccepted: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "IndexRecoveryAccepted";
            /** Revision */
            revision: number;
        };
        /** IndexRetryScheduled */
        IndexRetryScheduled: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "IndexRetryScheduled";
            /** Revision */
            revision: number;
        };
        /** IndexSucceeded */
        IndexSucceeded: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "IndexSucceeded";
            /** Revision */
            revision: number;
        };
        /**
         * IndexSuperseded
         * @description A claimed execution observed a newer revision and stopped.
         */
        IndexSuperseded: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "IndexSuperseded";
            /** Revision */
            revision: number;
        };
        /** Ineligible */
        Ineligible: {
            /**
             * Code
             * @enum {string}
             */
            code: "unsupported_capability" | "selection_not_configured";
            /** Explanation */
            explanation: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Ineligible";
        };
        /** InitialHighlightNote */
        InitialHighlightNote: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            /**
             * Note Id
             * Format: uuid
             */
            note_id: string;
        };
        /** InitialNote */
        InitialNote: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "note";
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            /**
             * Note Id
             * Format: uuid
             */
            note_id: string;
        };
        /** InitialResource */
        InitialResource: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource";
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            /** Target */
            target: components["schemas"]["LinkResourceEndpoint"] | components["schemas"]["LinkPassageEndpoint"];
        };
        /** InsertLink */
        InsertLink: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "insert_link";
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            position: components["schemas"]["Position"] | null;
            /** Require Created */
            require_created: boolean;
            /** Source */
            source: components["schemas"]["LinkResourceEndpoint"] | components["schemas"]["LinkPassageEndpoint"] | components["schemas"]["LinkFragmentSelectionSource"] | components["schemas"]["LinkPdfSelectionSource"] | components["schemas"]["LinkDailyPageSource"];
            /** Target */
            target: components["schemas"]["LinkResourceEndpoint"] | components["schemas"]["LinkPassageEndpoint"];
        };
        /** InsertNote */
        InsertNote: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "insert_note";
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            /**
             * Note Id
             * Format: uuid
             */
            note_id: string;
            position: components["schemas"]["Position"] | null;
            /** Source */
            source: components["schemas"]["LinkResourceEndpoint"] | components["schemas"]["LinkPassageEndpoint"] | components["schemas"]["LinkFragmentSelectionSource"] | components["schemas"]["LinkPdfSelectionSource"] | components["schemas"]["LinkDailyPageSource"];
        };
        /** LearnDossierBuildAcceptedOut */
        LearnDossierBuildAcceptedOut: {
            /** Artifact Ref */
            artifact_ref: string;
            /** Build Handle */
            build_handle: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "BuildAccepted";
        };
        /** LearnDossierOpenedOut */
        LearnDossierOpenedOut: {
            /** Artifact Ref */
            artifact_ref: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Opened";
        };
        /** LearnDossierRequest */
        LearnDossierRequest: {
            /** Highlight Ref */
            highlight_ref: string;
        };
        /** LecternItemOut */
        LecternItemOut: {
            /** Activation */
            activation: components["schemas"]["FooterAudioActivation"] | components["schemas"]["ReadableActivation"] | components["schemas"]["OpenPaneActivation"];
            /**
             * Added At
             * Format: date-time
             */
            added_at: string;
            media_summary: components["schemas"]["MediaSummaryOut"];
        };
        /** LecternMembershipAction */
        LecternMembershipAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "LecternMembership";
            /** Lectern Item Id */
            lectern_item_id: string | null;
        };
        /** LecternOrderOut */
        LecternOrderOut: {
            /** Media Ids */
            media_ids: string[];
            order_revision: components["schemas"]["OrderRevision"];
        };
        /**
         * LecternOut
         * @description The visible rows; ``at_capacity`` counts the whole membership, hidden rows included.
         */
        LecternOut: {
            /** At Capacity */
            at_capacity: boolean;
            /** Items */
            items: components["schemas"]["LecternItemOut"][];
            order_revision: components["schemas"]["OrderRevision"];
        };
        /** LecternWriteOut */
        LecternWriteOut: {
            order_revision: components["schemas"]["OrderRevision"];
        };
        /** LibraryDestinationOut */
        LibraryDestinationOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Name */
            name: string;
        };
        /**
         * LibraryEntriesPageOut
         * @description Only the unfiltered manual-order view carries a structural revision.
         */
        LibraryEntriesPageOut: {
            /** Items */
            items: (components["schemas"]["LibraryMediaEntryOut"] | components["schemas"]["LibraryPodcastEntryOut"])[];
            /** Next Cursor */
            next_cursor: string | null;
            order_revision: components["schemas"]["OrderRevision"] | null;
        };
        /** LibraryInvitationOut */
        LibraryInvitationOut: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Invitee Display Name */
            invitee_display_name: string | null;
            /** Invitee Email */
            invitee_email: string | null;
            /**
             * Invitee User Id
             * Format: uuid
             */
            invitee_user_id: string;
            /**
             * Library Id
             * Format: uuid
             */
            library_id: string;
            /**
             * Role
             * @enum {string}
             */
            role: "admin" | "member";
            /**
             * Status
             * @enum {string}
             */
            status: "pending" | "accepted" | "declined" | "revoked";
        };
        /** LibraryMediaEntryOut */
        LibraryMediaEntryOut: {
            /**
             * Added At
             * Format: date-time
             */
            added_at: string;
            /** Entry Id */
            entry_id: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "media";
            media_summary: components["schemas"]["MediaSummaryOut"];
        };
        /** LibraryMemberOut */
        LibraryMemberOut: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Display Name */
            display_name: string | null;
            /** Email */
            email: string | null;
            /** Is Owner */
            is_owner: boolean;
            /**
             * Role
             * @enum {string}
             */
            role: "admin" | "member";
            /**
             * User Id
             * Format: uuid
             */
            user_id: string;
        };
        /** LibraryOrderOut */
        LibraryOrderOut: {
            /** Entry Ids */
            entry_ids: string[];
            order_revision: components["schemas"]["OrderRevision"];
        };
        /** LibraryOut */
        LibraryOut: {
            /** Can Delete */
            can_delete: boolean;
            /** Can Leave */
            can_leave: boolean;
            /** Can Manage */
            can_manage: boolean;
            /** Can Transfer Ownership */
            can_transfer_ownership: boolean;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Is Default */
            is_default: boolean;
            /** Name */
            name: string;
            /**
             * Role
             * @enum {string}
             */
            role: "admin" | "member";
        };
        /**
         * LibraryPlacementOut
         * @description One library the item could sit in; `is_default` is the viewer's All (Saved in
         *     Nexus). Inherited: an episode included through its filed show.
         */
        LibraryPlacementOut: {
            /** Blocked */
            blocked: ("RequiresAdmin" | "RequiresSubscription" | "SystemManaged") | null;
            /** Is Default */
            is_default: boolean;
            /**
             * Library Id
             * Format: uuid
             */
            library_id: string;
            /** Name */
            name: string;
            /**
             * Relation
             * @enum {string}
             */
            relation: "Absent" | "Direct" | "Inherited";
        };
        /** LibraryPodcastEntryOut */
        LibraryPodcastEntryOut: {
            /**
             * Added At
             * Format: date-time
             */
            added_at: string;
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Entry Id */
            entry_id: string | null;
            /** Image Url */
            image_url: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "podcast";
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
            /** Published Date */
            published_date: string | null;
            sync_status: components["schemas"]["PodcastSyncStatus"] | null;
            /** Title */
            title: string;
            /** Unplayed Count */
            unplayed_count: number;
        };
        /** LinkAudienceIn */
        LinkAudienceIn: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Link";
        };
        /** LinkDailyPageSource */
        LinkDailyPageSource: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "daily_page";
            /**
             * Local Date
             * Format: date
             */
            local_date: string;
            /**
             * Page Id
             * Format: uuid
             */
            page_id: string;
        };
        /**
         * LinkFragmentSelectionSource
         * @description A reflowable selection, materialized as a highlight with the link.
         */
        LinkFragmentSelectionSource: {
            /**
             * Color
             * @enum {string}
             */
            color: "yellow" | "green" | "blue" | "pink" | "purple";
            /** End Offset */
            end_offset: number;
            /** Expected Reader Generation */
            expected_reader_generation?: number | null;
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /**
             * Highlight Id
             * Format: uuid
             */
            highlight_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "fragment_selection";
            /** Start Offset */
            start_offset: number;
        };
        /**
         * LinkPassageEndpoint
         * @description A transient passage candidate, materialized into a ``passage_anchor`` on confirm.
         */
        LinkPassageEndpoint: {
            /** Candidate Ref */
            candidate_ref: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "passage";
        };
        /**
         * LinkPdfSelectionSource
         * @description A PDF page-space selection, materialized as a highlight with the link.
         */
        LinkPdfSelectionSource: {
            /**
             * Color
             * @enum {string}
             */
            color: "yellow" | "green" | "blue" | "pink" | "purple";
            /**
             * Exact
             * @default
             */
            exact: string;
            /** Expected Reader Generation */
            expected_reader_generation: number | null;
            /**
             * Highlight Id
             * Format: uuid
             */
            highlight_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "pdf_selection";
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Page Number */
            page_number: number;
            /** Quads */
            quads: components["schemas"]["PdfQuadIn"][];
        };
        /** LinkResourceEndpoint */
        LinkResourceEndpoint: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource";
            /** Ref */
            ref: string;
        };
        /** LinkShareOut */
        LinkShareOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Link";
            /** Public Href */
            public_href: string;
        };
        /** LinkedConversationRef */
        LinkedConversationRef: {
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
            /** Title */
            title: string;
        };
        /** LinkedNoteBlockRef */
        LinkedNoteBlockRef: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Body Text */
            body_text: string;
            /** Body Version */
            body_version: number;
            embedded_item?: components["schemas"]["ResourceItemOut"] | null;
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            /**
             * Note Block Id
             * Format: uuid
             */
            note_block_id: string;
        };
        /** ListeningActivityBatchIn */
        ListeningActivityBatchIn: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modality: "Listening";
            /** Spans */
            spans: components["schemas"]["ListeningActivitySpanIn"][];
        };
        /** ListeningActivitySpanIn */
        ListeningActivitySpanIn: {
            /**
             * Capture Key
             * Format: uuid
             */
            capture_key: string;
            /** Duration Ms */
            duration_ms: number;
            /** Media Position End Ms */
            media_position_end_ms: number | null;
            /** Media Position Start Ms */
            media_position_start_ms: number | null;
            /**
             * Occurred At
             * Format: date-time
             */
            occurred_at: string;
            /** Progress End */
            progress_end: number | null;
            /** Progress Start */
            progress_start: number | null;
        };
        /**
         * ListeningIn
         * @description One sample under its epoch; a null duration or rate keeps the stored one.
         */
        ListeningIn: {
            /** Duration Ms */
            duration_ms: number | null;
            /** Episode Playback Rate */
            episode_playback_rate: number | null;
            /** Expected Reset Epoch */
            expected_reset_epoch: number;
            /** Position Ms */
            position_ms: number;
        };
        /** ListeningPositionOut */
        ListeningPositionOut: {
            /** Consumption Override Revision */
            consumption_override_revision: number | null;
            /** Position Ms */
            position_ms: number;
            /** Reset Epoch */
            reset_epoch: number;
        };
        /** ListeningStateOut */
        ListeningStateOut: {
            /** Duration Ms */
            duration_ms: number | null;
            /** Position Ms */
            position_ms: number;
        };
        /** LocalDayOut */
        LocalDayOut: {
            /** Active Ms */
            active_ms: number;
            /**
             * Date
             * Format: date
             */
            date: string;
        };
        /** LocalHourOut */
        LocalHourOut: {
            /** Active Ms */
            active_ms: number;
            /** Hour */
            hour: number;
        };
        /** LocatedSourceLocationOut */
        LocatedSourceLocationOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "located";
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["PdfPageLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /**
             * Precision
             * @enum {string}
             */
            precision: "exact" | "approximate" | "page" | "time";
            /** Source Identity */
            source_identity: string | null;
        };
        /**
         * MachineAuthorshipOut
         * @description One immutable target-to-generation provenance fact.
         */
        MachineAuthorshipOut: {
            /**
             * Effect Id
             * Format: uuid
             */
            effect_id: string;
            /**
             * Generation Id
             * Format: uuid
             */
            generation_id: string;
            /** Generation Seq */
            generation_seq: number;
            /**
             * Position Path
             * @example generation/2147483647/tool/2147483647
             */
            position_path: string;
            /**
             * Target Id
             * Format: uuid
             */
            target_id: string;
            /**
             * Target Kind
             * @enum {string}
             */
            target_kind: "library_entry" | "note_block" | "highlight" | "resource_edge" | "queue_item";
            /** Tool Position */
            tool_position: number;
        };
        /**
         * ManualAuthorRowIn
         * @description One ordered manual author row. Every row is role ``author``.
         */
        ManualAuthorRowIn: {
            /** Binding */
            binding: components["schemas"]["ExistingAuthorBinding"] | components["schemas"]["NewAuthorBinding"];
            /** Credited Name */
            credited_name: string;
        };
        /** ManualMediaAuthorsRequest */
        ManualMediaAuthorsRequest: {
            /** Authors */
            authors: components["schemas"]["ManualAuthorRowIn"][];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            mode: "manual";
        };
        /** MediaAbstractOut */
        MediaAbstractOut: {
            /**
             * Status
             * @enum {string}
             */
            status: "Building" | "Ready" | "Stale" | "Failed";
            /** Summary Md */
            summary_md: string | null;
        };
        /** MediaActivityBreakdownOut */
        MediaActivityBreakdownOut: {
            /** Other Active Ms */
            other_active_ms: number;
            /** Rows */
            rows: components["schemas"]["MediaActivityOut"][];
        };
        /** MediaActivityOut */
        MediaActivityOut: {
            /** Active Ms */
            active_ms: number;
            /** Forward Media Position Ms */
            forward_media_position_ms: number;
            /** Forward Word Position */
            forward_word_position: number;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Title */
            title: string;
        };
        /** MediaAuthorsOut */
        MediaAuthorsOut: {
            /**
             * Author Mode
             * @enum {string}
             */
            author_mode: "automatic" | "manual";
        };
        /** MediaCompletionOut */
        MediaCompletionOut: {
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Title */
            title: string;
            /** Total */
            total: number;
        };
        /** MediaContributorWorkItemOut */
        MediaContributorWorkItemOut: {
            /** Action Ref */
            action_ref: string;
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Media";
            media_summary: components["schemas"]["MediaSummaryOut"];
            /** Role Facts */
            role_facts: components["schemas"]["ContributorRoleFactOut"][];
        };
        /** MediaDurationOut */
        MediaDurationOut: {
            estimate: components["schemas"]["ReadingTimeEstimateOut"];
            /**
             * Modality
             * @enum {string}
             */
            modality: "Read" | "Listen";
        };
        /**
         * MediaFileOut
         * @description A short-lived signed url of the media's file; ``expires_at`` is ISO 8601.
         */
        MediaFileOut: {
            /** Expires At */
            expires_at: string;
            /** Url */
            url: string;
        };
        /**
         * MediaKind
         * @description Types of media that can be ingested.
         * @enum {string}
         */
        MediaKind: "web_article" | "epub" | "pdf" | "video" | "podcast_episode";
        /**
         * MediaOut
         * @description One media as this viewer sees it: bibliography, processing, readability and the
         *     viewer's own consumption; ``player_descriptor`` only for a playable episode.
         */
        MediaOut: {
            /**
             * Author Mode
             * @enum {string}
             */
            author_mode: "automatic" | "manual";
            /** Canonical Source Url */
            canonical_source_url: string | null;
            /** Canonical Url */
            canonical_url: string | null;
            capabilities: components["schemas"]["CapabilitiesOut"];
            /** Chapters */
            chapters: components["schemas"]["PodcastEpisodeChapterOut"][];
            consumption: components["schemas"]["ConsumptionOut"];
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Description */
            description: string | null;
            /** Description Html */
            description_html: string | null;
            /** Description Text */
            description_text: string | null;
            duration: components["schemas"]["MediaDurationOut"] | null;
            /** Edition Isbn */
            edition_isbn: string | null;
            /** Edition Published Date */
            edition_published_date: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            kind: components["schemas"]["MediaKind"];
            /** Language */
            language: string | null;
            /** Last Engaged At */
            last_engaged_at: string | null;
            /** Last Error Code */
            last_error_code: string | null;
            listening_state: components["schemas"]["ListeningStateOut"] | null;
            /** Metadata Enriched At */
            metadata_enriched_at: string | null;
            metadata_enrichment: components["schemas"]["MetadataEnrichmentView"];
            /** Original Published Date */
            original_published_date: string | null;
            playback_source: components["schemas"]["PlaybackSourceOut"] | null;
            player_descriptor: components["schemas"]["PlayerDescriptor"] | null;
            /**
             * Processing Status
             * @enum {string}
             */
            processing_status: "pending" | "extracting" | "ready_for_reading" | "failed" | "suspended";
            /** Provider */
            provider: string | null;
            /** Provider Id */
            provider_id: string | null;
            /** Publisher */
            publisher: string | null;
            /** Reader Generation */
            reader_generation: number | null;
            /** Requested Url */
            requested_url: string | null;
            /** Retrieval Status */
            retrieval_status: string | null;
            /** Retrieval Status Reason */
            retrieval_status_reason: string | null;
            /** Title */
            title: string;
            transcript_coverage: components["schemas"]["TranscriptCoverage"] | null;
            /** Transcript Origin */
            transcript_origin: ("Publisher" | "Imported" | "Generated") | null;
            transcript_state: components["schemas"]["TranscriptState"] | null;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            x_article_content: components["schemas"]["XArticleContent"] | null;
            x_source_context: components["schemas"]["XSourceContext"] | null;
        };
        /**
         * MediaProcessingSnapshotOut
         * @description One processing stream frame: the facts source work, transcripts and indexing change.
         */
        MediaProcessingSnapshotOut: {
            capabilities: components["schemas"]["CapabilitiesOut"];
            /** Last Error Code */
            last_error_code: string | null;
            /**
             * Processing Status
             * @enum {string}
             */
            processing_status: "pending" | "extracting" | "ready_for_reading" | "failed" | "suspended";
            /** Reader Generation */
            reader_generation: number | null;
            /** Retrieval Status */
            retrieval_status: string | null;
            /** Retrieval Status Reason */
            retrieval_status_reason: string | null;
            transcript_coverage: components["schemas"]["TranscriptCoverage"] | null;
            transcript_state: components["schemas"]["TranscriptState"] | null;
            /** Work In Flight */
            work_in_flight: boolean;
        };
        /**
         * MediaResourceBodyOut
         * @description A live stored identity; captured evidence retains its frozen named/passage body.
         */
        MediaResourceBodyOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "media";
            media_summary: components["schemas"]["MediaSummaryOut"];
        };
        /** MediaSuggestionTargetOut */
        MediaSuggestionTargetOut: {
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Media";
            media_summary: components["schemas"]["MediaSummaryOut"];
            /** Ref */
            ref: string;
        };
        /** MediaSummaryOut */
        MediaSummaryOut: {
            /** Can Play */
            can_play: boolean;
            consumption: components["schemas"]["ConsumptionOut"];
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            duration: components["schemas"]["MediaDurationOut"] | null;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            media_kind: components["schemas"]["MediaKind"];
            /** Original Published Date */
            original_published_date: string | null;
            /**
             * Processing Status
             * @enum {string}
             */
            processing_status: "pending" | "extracting" | "ready_for_reading" | "failed" | "suspended";
            /** Title */
            title: string;
            x_article_content: components["schemas"]["XArticleContent"] | null;
        };
        /** MediaSummaryResolutionOut */
        MediaSummaryResolutionOut: {
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            summary: components["schemas"]["MediaSummaryOut"] | null;
        };
        /** MessageDeleteOut */
        MessageDeleteOut: {
            /** Conversation Deleted */
            conversation_deleted: boolean;
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
        };
        /** MessageOffsetsLocator */
        MessageOffsetsLocator: {
            /** Conversation Id */
            conversation_id: string;
            /** End Offset */
            end_offset: number;
            /** Message Id */
            message_id: string;
            /** Message Seq */
            message_seq?: number | null;
            /** Start Offset */
            start_offset: number;
            text_quote_selector?: components["schemas"]["TextQuoteSelector"] | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "message_offsets";
        };
        /** MessageOut */
        MessageOut: {
            /** Branch Anchor */
            branch_anchor: components["schemas"]["NoBranchAnchor"] | components["schemas"]["AssistantMessageBranchAnchor"] | components["schemas"]["AssistantSelectionBranchAnchor"];
            /** Can Rerun */
            can_rerun: boolean;
            /** Citations */
            citations: components["schemas"]["CitationOut"][];
            /** Content */
            content: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Fork Title */
            fork_title: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Parent Message Id */
            parent_message_id: string | null;
            reader_selection: components["schemas"]["ReaderSelectionOut"] | null;
            /**
             * Role
             * @enum {string}
             */
            role: "user" | "assistant";
            /** Seq */
            seq: number;
            /**
             * Status
             * @enum {string}
             */
            status: "pending" | "complete" | "error" | "cancelled";
            trust_trail: components["schemas"]["AssistantTrustTrailOut"] | null;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** MetadataBibliographyCompletedOutcome */
        MetadataBibliographyCompletedOutcome: {
            /** Changed Fields */
            changed_fields: components["schemas"]["MetadataField"][];
            /**
             * Completed At
             * Format: date-time
             */
            completed_at: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            purpose: "bibliography";
            /** Retained Manual Authors */
            retained_manual_authors: boolean;
            /**
             * Status
             * @default completed
             * @constant
             */
            status: "completed";
            /** Unresolved Fields */
            unresolved_fields: components["schemas"]["MetadataField"][];
        };
        /** MetadataCompletedOperation */
        MetadataCompletedOperation: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Generation Id */
            generation_id: string | null;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            outcome: components["schemas"]["MetadataCompletedOutcome"];
            purpose: components["schemas"]["MetadataPurpose"];
            selection: components["schemas"]["MetadataSelection"] | null;
            /** Started At */
            started_at: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "completed";
        };
        MetadataCompletedOutcome: components["schemas"]["MetadataBibliographyCompletedOutcome"] | components["schemas"]["MetadataTitleCompletedOutcome"];
        /** MetadataEnrichmentAccepted */
        MetadataEnrichmentAccepted: {
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /** Last Enriched At */
            last_enriched_at: string | null;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
        };
        /**
         * MetadataEnrichmentRequest
         * @description The latest job the viewer saw; null when they saw none.
         */
        MetadataEnrichmentRequest: {
            /** Expected Job Id */
            expected_job_id: string | null;
        };
        /**
         * MetadataEnrichmentView
         * @description The latest operation, the oldest unfinished one, and whether the viewer may start one;
         *     the metadata stream ends once ``unfinished_count`` is 0 (only a new run changes it).
         */
        MetadataEnrichmentView: {
            /** Last Enriched At */
            last_enriched_at: string | null;
            operation: components["schemas"]["MetadataOperationOut"] | null;
            retry: components["schemas"]["MetadataRetry"];
            /** Unfinished Count */
            unfinished_count: number;
            unfinished_operation: components["schemas"]["MetadataUnfinishedOperation"] | null;
        };
        /** MetadataFailedOperation */
        MetadataFailedOperation: {
            code: components["schemas"]["MetadataFailureCode"];
            /**
             * Completed At
             * Format: date-time
             */
            completed_at: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Generation Id */
            generation_id: string | null;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            purpose: components["schemas"]["MetadataPurpose"];
            selection: components["schemas"]["MetadataSelection"] | null;
            /** Started At */
            started_at: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "failed";
        };
        /** @enum {string} */
        MetadataFailureCode: "model_unavailable" | "authentication_failed" | "quota_unavailable" | "research_timeout" | "invalid_output" | "input_too_large" | "output_limit" | "stale_input" | "source_context_missing" | "no_longer_eligible" | "access_revoked" | "cancelled" | "policy_violation" | "worker_interrupted" | "execution_failed";
        /** @enum {string} */
        MetadataField: "title" | "contributors" | "original_published_date" | "edition_published_date" | "edition_isbn" | "publisher" | "language" | "description";
        /** MetadataNoFindingsOperation */
        MetadataNoFindingsOperation: {
            /**
             * Completed At
             * Format: date-time
             */
            completed_at: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Generation Id */
            generation_id: string | null;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /**
             * Purpose
             * @constant
             */
            purpose: "bibliography";
            /** Reviewed At */
            reviewed_at: string | null;
            selection: components["schemas"]["MetadataSelection"] | null;
            /** Started At */
            started_at: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "no_findings";
        };
        /**
         * MetadataOperationFacts
         * @description A retained metadata operation projected into history; never stored.
         */
        MetadataOperationFacts: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "MetadataOperation";
            operation: components["schemas"]["MetadataOperationOut"];
        };
        MetadataOperationOut: components["schemas"]["MetadataQueuedOperation"] | components["schemas"]["MetadataRunningOperation"] | components["schemas"]["MetadataRecoveringOperation"] | components["schemas"]["MetadataWaitingOperation"] | components["schemas"]["MetadataCompletedOperation"] | components["schemas"]["MetadataNoFindingsOperation"] | components["schemas"]["MetadataFailedOperation"];
        /** @enum {string} */
        MetadataPurpose: "bibliography" | "title";
        /** MetadataQueuedOperation */
        MetadataQueuedOperation: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Generation Id */
            generation_id: string | null;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            purpose: components["schemas"]["MetadataPurpose"];
            selection: components["schemas"]["MetadataSelection"] | null;
            /** Started At */
            started_at: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "queued";
        };
        /** MetadataRecoveringOperation */
        MetadataRecoveringOperation: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Generation Id */
            generation_id: string | null;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            purpose: components["schemas"]["MetadataPurpose"];
            selection: components["schemas"]["MetadataSelection"] | null;
            /** Started At */
            started_at: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "recovering";
        };
        MetadataRetry: components["schemas"]["MetadataRetryAllowed"] | components["schemas"]["MetadataRetryBlocked"];
        /** MetadataRetryAllowed */
        MetadataRetryAllowed: {
            /** Expected Job Id */
            expected_job_id: string | null;
            purpose: components["schemas"]["MetadataPurpose"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "allowed";
        };
        /** MetadataRetryBlocked */
        MetadataRetryBlocked: {
            purpose: components["schemas"]["MetadataPurpose"];
            /**
             * Reason
             * @enum {string}
             */
            reason: "not_creator" | "not_eligible" | "active" | "source_context_missing";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "blocked";
        };
        /** MetadataRunningOperation */
        MetadataRunningOperation: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Generation Id */
            generation_id: string | null;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            purpose: components["schemas"]["MetadataPurpose"];
            selection: components["schemas"]["MetadataSelection"] | null;
            /** Started At */
            started_at: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "running";
        };
        /**
         * MetadataSelection
         * @description The generation's route, model (a provider route's ``model_ref``) and reasoning.
         */
        MetadataSelection: {
            /** Model */
            model: string;
            /** Reasoning */
            reasoning: string;
            /** Route */
            route: string;
        };
        /** MetadataTitleCompletedOutcome */
        MetadataTitleCompletedOutcome: {
            /** Changed Fields */
            changed_fields: "title"[];
            /**
             * Completed At
             * Format: date-time
             */
            completed_at: string;
            /**
             * Disposition
             * @enum {string}
             */
            disposition: "generated" | "source_label";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            purpose: "title";
            /**
             * Status
             * @default completed
             * @constant
             */
            status: "completed";
        };
        MetadataUnfinishedOperation: components["schemas"]["MetadataQueuedOperation"] | components["schemas"]["MetadataRunningOperation"] | components["schemas"]["MetadataRecoveringOperation"] | components["schemas"]["MetadataWaitingOperation"];
        /** MetadataWaitingOperation */
        MetadataWaitingOperation: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Generation Id */
            generation_id: string | null;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            purpose: components["schemas"]["MetadataPurpose"];
            /**
             * Reason
             * @constant
             */
            reason: "retry";
            selection: components["schemas"]["MetadataSelection"] | null;
            /** Started At */
            started_at: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "waiting";
            /** Until */
            until: string | null;
        };
        /** MeteredApiBilling */
        MeteredApiBilling: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "MeteredApi";
            /**
             * Label
             * @default Metered API
             * @constant
             */
            label: "Metered API";
        };
        /** MintHandoffCodeRequest */
        MintHandoffCodeRequest: {
            /** Access Token */
            access_token: string;
            /** Challenge */
            challenge: string;
            /** Refresh Token */
            refresh_token: string;
        };
        /** MissingImage */
        MissingImage: {
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "MissingImage";
            /** Marker Ordinal */
            marker_ordinal: number;
            /** Resource Path */
            resource_path: string;
        };
        /** Move */
        Move: {
            /** After */
            after: string | null;
            /**
             * Edge Id
             * Format: uuid
             */
            edge_id: string;
            /** Endpoint */
            endpoint: string;
            /** Expected Links Version */
            expected_links_version: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "move";
        };
        /**
         * MoveEntryRequest
         * @description Put the entry immediately before `before_entry_id`; null puts it last.
         */
        MoveEntryRequest: {
            /** Before Entry Id */
            before_entry_id: string | null;
            expected_order_revision: components["schemas"]["OrderRevision"];
        };
        /** MoveLecternItemRequest */
        MoveLecternItemRequest: {
            /** Before Media Id */
            before_media_id: string | null;
            expected_order_revision: components["schemas"]["OrderRevision"];
        };
        /** NamedResourceBodyOut */
        NamedResourceBodyOut: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][] | null;
            /** Image Url */
            image_url: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "named";
            /** Media Kind */
            media_kind: string | null;
            /** Title */
            title: string;
        };
        /** NaturalEndIn */
        NaturalEndIn: {
            /** Expected Override Revision */
            expected_override_revision: number | null;
            terminal_listening: components["schemas"]["ListeningIn"];
        };
        /**
         * NewAuthorBinding
         * @description A person the save creates under the client's ``id``; a resend binds that person.
         */
        NewAuthorBinding: {
            /** Display Name */
            display_name: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "new";
        };
        /**
         * NewChatDestination
         * @description A fresh conversation created atomically with this send.
         */
        NewChatDestination: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "New";
        };
        /** NexusHistoryOut */
        NexusHistoryOut: {
            /** Frecency By Href */
            frecency_by_href: {
                [key: string]: number;
            };
            /** Recent */
            recent: components["schemas"]["NexusHistoryRecentOut"][];
        };
        /** NexusHistoryRecentOut */
        NexusHistoryRecentOut: {
            /** Label Snapshot */
            label_snapshot: string;
            /**
             * Last Used At
             * Format: date-time
             */
            last_used_at: string;
            /**
             * Source
             * @enum {string}
             */
            source: "Static" | "Workspace" | "Recent" | "Oracle" | "Search" | "Ai";
            /** Target Href */
            target_href: string;
        };
        /** NexusSelectionRecordOut */
        NexusSelectionRecordOut: {
            /**
             * Last Used At
             * Format: date-time
             */
            last_used_at: string;
            /** Use Count */
            use_count: number;
        };
        /**
         * NexusSelectionRecordRequest
         * @description One accepted internal Nexus selection. The stored label is cut to 120 characters.
         */
        NexusSelectionRecordRequest: {
            /** Label Snapshot */
            label_snapshot: string;
            /** Query */
            query?: string | null;
            /**
             * Source
             * @enum {string}
             */
            source: "Static" | "Workspace" | "Recent" | "Oracle" | "Search" | "Ai";
            /** Target Href */
            target_href: string;
        };
        /** NoBranchAnchor */
        NoBranchAnchor: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "none";
        };
        /** NoteBlockOffsetsLocator */
        NoteBlockOffsetsLocator: {
            /** Block Id */
            block_id: string;
            /** Body Version */
            body_version?: number | null;
            /** End Offset */
            end_offset: number;
            /** Start Offset */
            start_offset: number;
            text_quote_selector?: components["schemas"]["TextQuoteSelector"] | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "note_block_offsets";
        };
        /** NoteBlockOut */
        NoteBlockOut: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Body Text */
            body_text: string;
            /** Body Version */
            body_version: number;
            embedded_item?: components["schemas"]["ResourceItemOut"] | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
        };
        /**
         * NoteContentOut
         * @description ``places`` counts cross-owner retaining graph facts and saved dossier heads.
         */
        NoteContentOut: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Body Text */
            body_text: string;
            /** Body Version */
            body_version: number;
            embedded_item?: components["schemas"]["ResourceItemOut"] | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "note";
            /** Places */
            places: number;
        };
        /** NotePageSummaryOut */
        NotePageSummaryOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Title */
            title: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** OpenPaneActivation */
        OpenPaneActivation: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "OpenPane";
        };
        /** OpenSourceAction */
        OpenSourceAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "OpenSource";
        };
        /** OperatorActionRequired */
        OperatorActionRequired: {
            /** Action */
            action: string;
            /**
             * Code
             * @enum {string}
             */
            code: "codex_host_unavailable" | "required_tool_unavailable";
            /** Explanation */
            explanation: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "OperatorActionRequired";
            /**
             * Last Checked
             * Format: date-time
             */
            last_checked: string;
        };
        /** OracleConcordanceOut */
        OracleConcordanceOut: {
            /** Folio Motto */
            folio_motto: string;
            /** Folio Number */
            folio_number: number;
            /** Folio Theme */
            folio_theme: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Shared Passage Count */
            shared_passage_count: number;
            /** Shared Plate */
            shared_plate: boolean;
            /** Shared Theme */
            shared_theme: boolean;
        };
        /** @enum {string} */
        OracleFailureCode: "auth" | "quota" | "timeout" | "output_limit" | "invalid_output" | "policy_violation" | "runtime_unavailable" | "context_too_large" | "cancelled" | "E_ORACLE_CORPUS_NOT_READY" | "E_APP_SEARCH_FAILED" | "E_GENERATION_SOURCE_CHANGED";
        /**
         * OraclePassageOut
         * @description One phase's passage; ``citation`` is its current navigation, null when the
         *     target is unavailable (typography).
         */
        OraclePassageOut: {
            /** Attribution */
            attribution: string;
            citation: components["schemas"]["CitationOut"] | null;
            /** Locator Label */
            locator_label: string | null;
            /** Marginalia */
            marginalia: string;
            phase: components["schemas"]["OraclePhase"];
            /** Quote */
            quote: string;
            source_kind: components["schemas"]["OracleSourceKind"];
        };
        /** @enum {string} */
        OraclePhase: "descent" | "ordeal" | "ascent";
        /**
         * OraclePlateOut
         * @description A plate; its image is the static asset ``/oracle-plates/{key}.jpg``. Also the
         *     shape of ``oracle_readings.plate``, the display publication (or history) captured.
         */
        OraclePlateOut: {
            /** Artist */
            artist: string;
            /** Attribution */
            attribution: string;
            /** Height */
            height: number;
            /** Key */
            key: string;
            /** Width */
            width: number;
            /** Work Title */
            work_title: string;
            /** Year */
            year: string | null;
        };
        /** OracleReadingCreateRequest */
        OracleReadingCreateRequest: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Question */
            question: string;
        };
        /** OracleReadingCreatedOut */
        OracleReadingCreatedOut: {
            /**
             * Reading Id
             * Format: uuid
             */
            reading_id: string;
        };
        /**
         * OracleReadingOut
         * @description The reading: every fact it has; a pending one has none, history may be partial.
         */
        OracleReadingOut: {
            /** Argument Text */
            argument_text: string | null;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            error_code: components["schemas"]["OracleFailureCode"] | null;
            /** Folio Motto */
            folio_motto: string | null;
            /** Folio Motto Gloss */
            folio_motto_gloss: string | null;
            /** Folio Number */
            folio_number: number;
            /** Folio Theme */
            folio_theme: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Interpretation Text */
            interpretation_text: string | null;
            /** Omens */
            omens: string[];
            /** Passages */
            passages: components["schemas"]["OraclePassageOut"][];
            plate: components["schemas"]["OraclePlateOut"] | null;
            /** Question Text */
            question_text: string;
            status: components["schemas"]["OracleReadingStatus"];
        };
        /** @enum {string} */
        OracleReadingStatus: "pending" | "streaming" | "complete" | "failed";
        /** OracleReadingSummaryOut */
        OracleReadingSummaryOut: {
            /** Folio Motto */
            folio_motto: string | null;
            /** Folio Number */
            folio_number: number;
            /** Folio Theme */
            folio_theme: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            plate: components["schemas"]["OraclePlateOut"] | null;
            status: components["schemas"]["OracleReadingStatus"];
        };
        /** @enum {string} */
        OracleSourceKind: "public_domain" | "user_media";
        OrderRevision: string;
        /** OutlineCommandsRequest */
        OutlineCommandsRequest: {
            /** Commands */
            commands: (components["schemas"]["SetBody"] | components["schemas"]["SetTitle"] | components["schemas"]["EnsureDaily"] | components["schemas"]["InsertNote"] | components["schemas"]["InsertLink"] | components["schemas"]["Move"] | components["schemas"]["Unlink"] | components["schemas"]["Relink"] | components["schemas"]["Remove"] | components["schemas"]["ConsumeNote"])[];
        };
        /** OutlineNodeOut */
        OutlineNodeOut: {
            /** Content */
            content: components["schemas"]["PageContentOut"] | components["schemas"]["NoteContentOut"] | components["schemas"]["ResourceContentOut"];
            item: components["schemas"]["ResourceItemOut"];
        };
        /** OutlineOccurrenceOut */
        OutlineOccurrenceOut: {
            connection: components["schemas"]["ConnectionOut"];
            /** Content */
            content: components["schemas"]["PageContentOut"] | components["schemas"]["NoteContentOut"] | components["schemas"]["ResourceContentOut"];
        };
        /**
         * OutlineOut
         * @description One visible endpoint's mixed adjacency in its own order, bounded by a cursor.
         */
        OutlineOut: {
            /** Insertion Source */
            insertion_source: (components["schemas"]["LinkResourceEndpoint"] | components["schemas"]["LinkPassageEndpoint"]) | null;
            /** Items */
            items: components["schemas"]["OutlineOccurrenceOut"][];
            /** Links Version */
            links_version: number;
            /** Next Cursor */
            next_cursor: string | null;
            source: components["schemas"]["OutlineNodeOut"];
        };
        /** OwnedMediaCandidate */
        OwnedMediaCandidate: {
            /** Description */
            description: string | null;
            /** Image */
            image: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "OwnedMedia";
            resolution: components["schemas"]["InNexusMediaResolution"];
            /**
             * Source
             * @default Nexus
             * @constant
             */
            source: "Nexus";
        };
        /** PageContentOut */
        PageContentOut: {
            /** Daily Date */
            daily_date: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "page";
            /** Title */
            title: string;
            /** Title Version */
            title_version: number;
        };
        /** PaneHistory */
        PaneHistory: {
            /** Back */
            back: components["schemas"]["PaneVisit"][];
            /** Forward */
            forward: components["schemas"]["PaneVisit"][];
        };
        /** PaneVisit */
        PaneVisit: {
            /** Href */
            href: string;
            /** Id */
            id: string;
            /** Title Hint */
            title_hint: string | null;
        };
        /** PassageResourceBodyOut */
        PassageResourceBodyOut: {
            /** Color */
            color: ("yellow" | "green" | "blue" | "pink" | "purple") | null;
            exact: components["schemas"]["ExcerptOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "passage";
            prefix: components["schemas"]["ExcerptOut"] | null;
            suffix: components["schemas"]["ExcerptOut"] | null;
        };
        /** PdfAnchorOut */
        PdfAnchorOut: {
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Page Number */
            page_number: number;
            /** Quads */
            quads: components["schemas"]["PdfQuadOut"][];
            /**
             * Type
             * @default pdf_page_geometry
             * @constant
             */
            type: "pdf_page_geometry";
        };
        /** PdfAnchorUpdateRequest */
        PdfAnchorUpdateRequest: {
            /** Page Number */
            page_number: number;
            /** Quads */
            quads: components["schemas"]["PdfQuadIn"][];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "pdf_page_geometry";
        };
        /** PdfGeometryQuad */
        PdfGeometryQuad: {
            /** X1 */
            x1: number;
            /** X2 */
            x2: number;
            /** X3 */
            x3: number;
            /** X4 */
            x4: number;
            /** Y1 */
            y1: number;
            /** Y2 */
            y2: number;
            /** Y3 */
            y3: number;
            /** Y4 */
            y4: number;
        };
        /** PdfHighlightAnchorIn */
        PdfHighlightAnchorIn: {
            /**
             * Exact
             * @default
             */
            exact: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "pdf";
            /** Page Number */
            page_number: number;
            /** Quads */
            quads: components["schemas"]["PdfQuadIn"][];
        };
        /** PdfPageGeometryLocator */
        PdfPageGeometryLocator: {
            /** Exact */
            exact: string;
            /** Media Id */
            media_id: string;
            /** Page Number */
            page_number: number;
            /** Prefix */
            prefix?: string | null;
            /** Projection */
            projection?: "proportional_text_offsets" | null;
            /** Quads */
            quads: components["schemas"]["PdfGeometryQuad"][];
            /** Suffix */
            suffix?: string | null;
            text_quote_selector?: components["schemas"]["TextQuoteSelector"] | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "pdf_page_geometry";
        };
        /** PdfPageLocator */
        PdfPageLocator: {
            /** Media Id */
            media_id: string;
            /** Page Number */
            page_number: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "pdf_page";
        };
        /** PdfQuadIn */
        PdfQuadIn: {
            /** X1 */
            x1: number;
            /** X2 */
            x2: number;
            /** X3 */
            x3: number;
            /** X4 */
            x4: number;
            /** Y1 */
            y1: number;
            /** Y2 */
            y2: number;
            /** Y3 */
            y3: number;
            /** Y4 */
            y4: number;
        };
        /** PdfQuadOut */
        PdfQuadOut: {
            /** X1 */
            x1: number;
            /** X2 */
            x2: number;
            /** X3 */
            x3: number;
            /** X4 */
            x4: number;
            /** Y1 */
            y1: number;
            /** Y2 */
            y2: number;
            /** Y3 */
            y3: number;
            /** Y4 */
            y4: number;
        };
        /** PdfReaderResumeState */
        PdfReaderResumeState: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "pdf";
            /** Page */
            page: number;
            /** Page Progression */
            page_progression: number | null;
            /** Position */
            position: number | null;
            /** Zoom */
            zoom: number | null;
        };
        /**
         * PlaceIn
         * @description A null placement only ensures membership: an absent media goes last, a present row stays.
         */
        PlaceIn: {
            expected_order_revision: components["schemas"]["OrderRevision"];
            /** Placement */
            placement: (components["schemas"]["FirstPlacement"] | components["schemas"]["AfterPlacement"]) | null;
        };
        /**
         * PlaceItemRequest
         * @description `replace_episodes` confirms that a show replaces its directly filed episodes.
         */
        PlaceItemRequest: {
            /** Replace Episodes */
            replace_episodes: boolean;
        };
        /** PlaybackAction */
        PlaybackAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Playback";
            player_descriptor: components["schemas"]["PlayerDescriptor"];
        };
        /** PlaybackSourceOut */
        PlaybackSourceOut: {
            /** Embed Url */
            embed_url: string | null;
            /**
             * Kind
             * @enum {string}
             */
            kind: "external_audio" | "external_video";
            /** Provider */
            provider: string | null;
            /** Provider Video Id */
            provider_video_id: string | null;
            /** Source Url */
            source_url: string;
            /** Stream Url */
            stream_url: string;
            /** Watch Url */
            watch_url: string | null;
        };
        /** PlaybackTimeRangeLocator */
        PlaybackTimeRangeLocator: {
            /** Media Id */
            media_id: string;
            /** T End Ms */
            t_end_ms: number;
            /** T Start Ms */
            t_start_ms: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "audio_time_range" | "video_time_range";
        };
        /**
         * PlayerDescriptor
         * @description What a device needs to play one episode; ``position_ms`` is the server's resume point and
         *     ``consumption_override_revision`` the version a natural end is fenced on.
         */
        PlayerDescriptor: {
            /** Artwork Url */
            artwork_url: string | null;
            /** Chapters */
            chapters: components["schemas"]["ChapterOut"][];
            /** Consumption Override Revision */
            consumption_override_revision: number | null;
            /** Duration Ms */
            duration_ms: number | null;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Pause Shortening Mode */
            pause_shortening_mode: ("Off" | "Natural") | null;
            /** Playback Rate */
            playback_rate: number;
            /** Podcast Id */
            podcast_id: string | null;
            /** Position Ms */
            position_ms: number;
            /** Reset Epoch */
            reset_epoch: number;
            /** Stream Url */
            stream_url: string;
            /** Subtitle */
            subtitle: string | null;
            /** Title */
            title: string;
        };
        /** PodcastBackfillOut */
        PodcastBackfillOut: {
            /** Error Code */
            error_code: string | null;
            /** Error Detail */
            error_detail: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            state: components["schemas"]["PodcastSyncStatus"];
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** PodcastBackfillRetryOut */
        PodcastBackfillRetryOut: {
            backfill: components["schemas"]["PodcastBackfillOut"];
            /**
             * Outcome
             * @enum {string}
             */
            outcome: "Retried" | "NotEligible";
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
        };
        /** PodcastBackfillRetryRequest */
        PodcastBackfillRetryRequest: {
            /**
             * Expected Backfill Id
             * Format: uuid
             */
            expected_backfill_id: string;
        };
        /** PodcastCandidate */
        PodcastCandidate: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Description */
            description: string | null;
            /** Image */
            image: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcast";
            kind_facts: components["schemas"]["PodcastFacts"];
            /** Published At */
            published_at: string | null;
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default PodcastIndex
             * @constant
             */
            source: "PodcastIndex";
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** PodcastCanonicalCommitTarget */
        PodcastCanonicalCommitTarget: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Canonical";
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
        };
        /** PodcastContributorWorkItemOut */
        PodcastContributorWorkItemOut: {
            /** Action Ref */
            action_ref: string;
            /** Content Kind */
            content_kind: string;
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcast";
            /** Resource Ref */
            resource_ref: string;
            /** Role Facts */
            role_facts: components["schemas"]["ContributorRoleFactOut"][];
            /** Title */
            title: string;
        };
        /** PodcastDestinationOutcomeOut */
        PodcastDestinationOutcomeOut: {
            /**
             * Library Id
             * Format: uuid
             */
            library_id: string;
            /**
             * Outcome
             * @enum {string}
             */
            outcome: "Added" | "AlreadyPresent" | "IncludedThroughPodcast";
        };
        /** PodcastDetailOut */
        PodcastDetailOut: {
            episode_counts: components["schemas"]["PodcastEpisodeCountsOut"];
            podcast: components["schemas"]["PodcastListItemOut"];
            subscription: components["schemas"]["PodcastSubscriptionStatusOut"] | null;
        };
        /** PodcastDiscoveryCommitTarget */
        PodcastDiscoveryCommitTarget: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Discovery";
            /** Target */
            target: string;
        };
        /** PodcastEpisodeChapterOut */
        PodcastEpisodeChapterOut: {
            /** Chapter Idx */
            chapter_idx: number;
            /** Image Url */
            image_url: string | null;
            /** T End Ms */
            t_end_ms: number | null;
            /** T Start Ms */
            t_start_ms: number;
            /** Title */
            title: string;
            /** Url */
            url: string | null;
        };
        /** PodcastEpisodeConsumptionItem */
        PodcastEpisodeConsumptionItem: {
            /** Expected Override Revision */
            expected_override_revision: number | null;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
        };
        /** PodcastEpisodeConsumptionOut */
        PodcastEpisodeConsumptionOut: {
            /** Changed Count */
            changed_count: number;
            /** Matched Count */
            matched_count: number;
        };
        /** PodcastEpisodeConsumptionPreparedOut */
        PodcastEpisodeConsumptionPreparedOut: {
            /** Items */
            items: components["schemas"]["PodcastEpisodeConsumptionItem"][];
        };
        /** PodcastEpisodeConsumptionRequest */
        PodcastEpisodeConsumptionRequest: {
            /**
             * Desired State
             * @enum {string}
             */
            desired_state: "played" | "unplayed";
            /** Items */
            items: components["schemas"]["PodcastEpisodeConsumptionItem"][];
        };
        /** PodcastEpisodeCountsOut */
        PodcastEpisodeCountsOut: {
            /** Available Count */
            available_count: number;
            /** Unfinished Count */
            unfinished_count: number;
        };
        /** PodcastEpisodeFromDiscoveryOut */
        PodcastEpisodeFromDiscoveryOut: {
            /** Destination Outcomes */
            destination_outcomes: components["schemas"]["PodcastDestinationOutcomeOut"][];
            /** Href */
            href: string;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
        };
        /** PodcastEpisodeFromDiscoveryRequest */
        PodcastEpisodeFromDiscoveryRequest: {
            /** Named Library Ids */
            named_library_ids?: string[];
            /** Target */
            target: string;
        };
        /** PodcastEpisodeListItemOut */
        PodcastEpisodeListItemOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            media_summary: components["schemas"]["MediaSummaryOut"];
            transcript_state: components["schemas"]["TranscriptState"];
        };
        /** PodcastEpisodeQueryTranscriptForecastOut */
        PodcastEpisodeQueryTranscriptForecastOut: {
            /** Eligible Count */
            eligible_count: number;
            /** Selection Fingerprint */
            selection_fingerprint: string;
        };
        /** PodcastEpisodeQueryTranscriptRequest */
        PodcastEpisodeQueryTranscriptRequest: {
            /** Selection Fingerprint */
            selection_fingerprint: string;
            target: components["schemas"]["PodcastEpisodeQueryTranscriptTarget"];
        };
        /** PodcastEpisodeQueryTranscriptRequestOut */
        PodcastEpisodeQueryTranscriptRequestOut: {
            /** Matched Count */
            matched_count: number;
            /** Queued Count */
            queued_count: number;
        };
        /** PodcastEpisodeQueryTranscriptTarget */
        PodcastEpisodeQueryTranscriptTarget: {
            /**
             * Kind
             * @constant
             */
            kind: "PodcastEpisodeQuery";
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
            /**
             * Reason
             * @enum {string}
             */
            reason: "search" | "highlight" | "quote";
            selection: components["schemas"]["PodcastEpisodeSelection"];
        };
        /** PodcastEpisodeSelection */
        PodcastEpisodeSelection: {
            /**
             * State
             * @enum {string}
             */
            state: "all" | "unplayed" | "in_progress" | "played";
        };
        /** PodcastFacts */
        PodcastFacts: {
            /** Podcast Ref */
            podcast_ref: string;
        };
        /** PodcastListItemOut */
        PodcastListItemOut: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Description */
            description: string | null;
            /** Feed Url */
            feed_url: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Image Url */
            image_url: string | null;
            /** Provider */
            provider: string;
            /** Provider Podcast Id */
            provider_podcast_id: string;
            /** Title */
            title: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /** Website Url */
            website_url: string | null;
        };
        /** PodcastPreview */
        PodcastPreview: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Description */
            description: string | null;
            episodes: components["schemas"]["PodcastPreviewEpisodes"];
            /** Image */
            image: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcast";
            kind_facts: components["schemas"]["PodcastPreviewFacts"];
            /** Published At */
            published_at: string | null;
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default PodcastIndex
             * @constant
             */
            source: "PodcastIndex";
            /** Source Href */
            source_href: string;
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** PodcastPreviewEpisode */
        PodcastPreviewEpisode: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Description */
            description: string | null;
            /** Image */
            image: string | null;
            kind_facts: components["schemas"]["EpisodePreviewFacts"];
            /** Published At */
            published_at: string | null;
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** PodcastPreviewEpisodes */
        PodcastPreviewEpisodes: {
            /** Items */
            items: components["schemas"]["PodcastPreviewEpisode"][];
            /**
             * Source Limit
             * @constant
             */
            source_limit: 1000;
        };
        /** PodcastPreviewFacts */
        PodcastPreviewFacts: {
            /** Feed Href */
            feed_href: string;
            /** Podcast Ref */
            podcast_ref: string;
            /** Website Href */
            website_href: string | null;
        };
        /** PodcastRefreshAcceptedOut */
        PodcastRefreshAcceptedOut: {
            /** Requested Count */
            requested_count: number;
        };
        /** PodcastRefreshLibraryScope */
        PodcastRefreshLibraryScope: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Library";
            /**
             * Library Id
             * Format: uuid
             */
            library_id: string;
        };
        /** PodcastRefreshPodcastScope */
        PodcastRefreshPodcastScope: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcast";
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
        };
        /** PodcastRefreshPodcastsScope */
        PodcastRefreshPodcastsScope: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcasts";
        };
        /** PodcastSubscribeOut */
        PodcastSubscribeOut: {
            backfill: components["schemas"]["PodcastBackfillOut"];
            /** Destinations */
            destinations: components["schemas"]["PodcastDestinationOutcomeOut"][];
            /** Href */
            href: string;
            /**
             * Outcome
             * @enum {string}
             */
            outcome: "Subscribed" | "AlreadySubscribed" | "DestinationsAdded";
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
        };
        /** PodcastSubscribeRequest */
        PodcastSubscribeRequest: {
            /** Named Library Ids */
            named_library_ids?: string[];
            /** Replace Episodes */
            replace_episodes: boolean;
            /** Target */
            target: components["schemas"]["PodcastDiscoveryCommitTarget"] | components["schemas"]["PodcastCanonicalCommitTarget"];
        };
        /** PodcastSubscriptionAction */
        PodcastSubscriptionAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "PodcastSubscription";
            /** Subscribed */
            subscribed: boolean;
        };
        /**
         * PodcastSubscriptionLifecycleSnapshotOut
         * @description One viewer-owned subscription's live sync and backfill state (an SSE frame).
         */
        PodcastSubscriptionLifecycleSnapshotOut: {
            backfill: components["schemas"]["PodcastBackfillOut"];
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
            /**
             * Subscription Id
             * Format: uuid
             */
            subscription_id: string;
            /** Sync Completed At */
            sync_completed_at: string | null;
            sync_status: components["schemas"]["PodcastSyncStatus"];
        };
        /** PodcastSubscriptionListItemOut */
        PodcastSubscriptionListItemOut: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Default Playback Speed */
            default_playback_speed: number | null;
            /** Image Url */
            image_url: string | null;
            /** Latest Episode Published At */
            latest_episode_published_at: string | null;
            /** Pause Shortening Mode */
            pause_shortening_mode: ("Off" | "Natural") | null;
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
            sync_status: components["schemas"]["PodcastSyncStatus"];
            /** Title */
            title: string;
            /** Unplayed Count */
            unplayed_count: number;
        };
        /** PodcastSubscriptionSettingsPatchRequest */
        PodcastSubscriptionSettingsPatchRequest: {
            /** Default Playback Speed */
            default_playback_speed: number | null;
            /** Expected Settings Version */
            expected_settings_version: number;
            /**
             * Expected Subscription Id
             * Format: uuid
             */
            expected_subscription_id: string;
            /** Pause Shortening Mode */
            pause_shortening_mode: ("Off" | "Natural") | null;
        };
        /** PodcastSubscriptionStatusOut */
        PodcastSubscriptionStatusOut: {
            backfill: components["schemas"]["PodcastBackfillOut"];
            /** Default Playback Speed */
            default_playback_speed: number | null;
            /** Last Checked At */
            last_checked_at: string | null;
            /** Pause Shortening Mode */
            pause_shortening_mode: ("Off" | "Natural") | null;
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
            /** Settings Version */
            settings_version: number;
            /**
             * Subscription Id
             * Format: uuid
             */
            subscription_id: string;
            /** Sync Attempts */
            sync_attempts: number;
            /** Sync Completed At */
            sync_completed_at: string | null;
            /** Sync Error Code */
            sync_error_code: string | null;
            /** Sync Error Message */
            sync_error_message: string | null;
            /** Sync Had Rejected Items */
            sync_had_rejected_items: boolean | null;
            /** Sync Started At */
            sync_started_at: string | null;
            sync_status: components["schemas"]["PodcastSyncStatus"];
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /**
             * User Id
             * Format: uuid
             */
            user_id: string;
        };
        /** PodcastSuggestionTargetOut */
        PodcastSuggestionTargetOut: {
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcast";
            /** Ref */
            ref: string;
            /** Subtitle */
            subtitle: string | null;
            /** Title */
            title: string;
        };
        /** @enum {string} */
        PodcastSyncStatus: "Pending" | "Running" | "Complete" | "Failed";
        /** PodcastUnsubscribeOut */
        PodcastUnsubscribeOut: {
            /**
             * Outcome
             * @enum {string}
             */
            outcome: "Unsubscribed" | "AlreadyUnsubscribed";
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
            /**
             * Removed Placement Count
             * @default 0
             */
            removed_placement_count: number;
            /**
             * Retained Shared Count
             * @default 0
             */
            retained_shared_count: number;
        };
        /** Position */
        Position: {
            /** After */
            after: string | null;
            /** Expected Links Version */
            expected_links_version: number;
        };
        /** PreviewPositionIn */
        PreviewPositionIn: {
            /** Duration Ms */
            duration_ms: number | null;
            /** Position Ms */
            position_ms: number;
        };
        /** PreviewResolution */
        PreviewResolution: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Preview";
        };
        /** PrivacyDisclosure */
        PrivacyDisclosure: {
            /** Retention */
            retention: string;
            /** Summary */
            summary: string;
            /** Training */
            training: string;
        };
        /**
         * ProcessingStatus
         * @description Media processing lifecycle states.
         *
         *     States:
         *         pending: Created, waiting for job pickup
         *         extracting: Extraction requested and in-flight or queued
         *         ready_for_reading: Minimum readable artifacts exist
         *         failed: Terminal failure recorded
         * @enum {string}
         */
        ProcessingStatus: "pending" | "extracting" | "ready_for_reading" | "failed";
        /** ProcessorChain */
        ProcessorChain: {
            /** Processors */
            processors: string[];
        };
        /** ProseResourceBodyOut */
        ProseResourceBodyOut: {
            excerpt: components["schemas"]["ExcerptOut"];
            /**
             * Format
             * @enum {string}
             */
            format: "plain" | "code";
            /** Image Count */
            image_count: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "prose";
            /** Role */
            role: string | null;
        };
        /** ProviderApiRoute */
        ProviderApiRoute: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "ProviderApi";
            provider: components["schemas"]["GenerationApiProvider"];
        };
        /** ProviderApiSelection */
        ProviderApiSelection: {
            /** Model Ref */
            model_ref: string;
            /** Reasoning */
            reasoning: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            route: "ProviderApi";
        };
        /** PublicHighlightOut */
        PublicHighlightOut: {
            /** Anchor */
            anchor: components["schemas"]["PublicTextAnchorOut"] | components["schemas"]["PublicPdfAnchorOut"];
            /**
             * Color
             * @enum {string}
             */
            color: "yellow" | "green" | "blue" | "pink" | "purple";
            /** Quote */
            quote: string | null;
        };
        /** PublicPdfAnchorOut */
        PublicPdfAnchorOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Pdf";
            /** Page Number */
            page_number: number;
            /** Quads */
            quads: components["schemas"]["HighlightTargetPdfQuadOut"][];
        };
        /** PublicShareOut */
        PublicShareOut: {
            /** Bylines */
            bylines: string[];
            highlight: components["schemas"]["PublicHighlightOut"] | null;
            /** Source Url */
            source_url: string | null;
            /** Title */
            title: string;
        };
        /** PublicTextAnchorOut */
        PublicTextAnchorOut: {
            /** End Offset */
            end_offset: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Text";
            /** Ordinal */
            ordinal: number;
            /** Start Offset */
            start_offset: number;
        };
        /** Published */
        Published: {
            /** Created */
            created: boolean;
            /** Import Ref */
            import_ref: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Published";
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /**
             * Session Id
             * Format: uuid
             */
            session_id: string;
        };
        /** QuickReadsOut */
        QuickReadsOut: {
            /** Items */
            items: components["schemas"]["SuggestionItemOut"][];
        };
        /** ReadableActivation */
        ReadableActivation: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Readable";
        };
        /**
         * ReaderApparatusDetailOut
         * @description Complete ordered targets for one owner in the named reader publication.
         */
        ReaderApparatusDetailOut: {
            /** Identity */
            identity: string;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Reference Ref */
            reference_ref: string;
            /** Targets */
            targets: components["schemas"]["ReaderEvidenceSourceTargetOut"][];
        };
        /** ReaderAuthoredPlacementOut */
        ReaderAuthoredPlacementOut: {
            /** Endpoint */
            endpoint: string;
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            position: components["schemas"]["Position"];
        };
        /** ReaderChildContinuationOut */
        ReaderChildContinuationOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "child";
            /** Position */
            position: null;
            /** Source */
            source: components["schemas"]["LinkResourceEndpoint"] | components["schemas"]["LinkPassageEndpoint"];
        };
        /**
         * ReaderCursorEmpty
         * @description No positioned cursor: an absent row is revision 0, a tombstone is >= 1.
         */
        ReaderCursorEmpty: {
            /**
             * Revision
             * @default 0
             */
            revision: number;
            /**
             * State
             * @default Empty
             * @constant
             */
            state: "Empty";
        };
        /** ReaderCursorPositioned */
        ReaderCursorPositioned: {
            /** Locator */
            locator: components["schemas"]["PdfReaderResumeState"] | components["schemas"]["WebReaderResumeState"] | components["schemas"]["TranscriptReaderResumeState"] | components["schemas"]["EpubReaderResumeState"] | components["schemas"]["XReaderResumeState"];
            /** Revision */
            revision: number;
            /**
             * State
             * @default Positioned
             * @constant
             */
            state: "Positioned";
        };
        /** ReaderCursorUnresolved */
        ReaderCursorUnresolved: {
            /** Excerpt */
            excerpt: string;
            /** From Generation */
            from_generation: number;
            /** Offset In Excerpt */
            offset_in_excerpt: number;
            /** Post Media Id */
            post_media_id: string | null;
            /** Previous Locator */
            previous_locator: components["schemas"]["PdfReaderResumeState"] | components["schemas"]["WebReaderResumeState"] | components["schemas"]["TranscriptReaderResumeState"] | components["schemas"]["EpubReaderResumeState"] | components["schemas"]["XReaderResumeState"];
            /** Revision */
            revision: number;
            /** Source Revision Id */
            source_revision_id: string | null;
            /**
             * State
             * @default Unresolved
             * @constant
             */
            state: "Unresolved";
        };
        /**
         * ReaderDirectFactOut
         * @description Membership and facet metadata, never relationship command authority.
         */
        ReaderDirectFactOut: {
            /**
             * Edge Id
             * Format: uuid
             */
            edge_id: string;
            /** Ordinal */
            ordinal: number | null;
            /**
             * Origin
             * @enum {string}
             */
            origin: "user" | "citation" | "system" | "note_body" | "highlight_note" | "discovery" | "document_embed" | "assistant";
        };
        /** ReaderDocumentMapDiagnosticsOut */
        ReaderDocumentMapDiagnosticsOut: {
            /** Omitted Item Counts */
            omitted_item_counts: {
                [key: string]: number;
            };
        };
        /** ReaderDocumentMapMarkerOut */
        ReaderDocumentMapMarkerOut: {
            /** End Position */
            end_position: number | null;
            /** Id */
            id: string;
            /** Item Id */
            item_id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "Embed" | "Highlight" | "SourceReference" | "GeneratedCitation" | "Link" | "MachineLink";
            /** Label */
            label: string;
            /** Position */
            position: number;
            /** Preview */
            preview: string | null;
            /**
             * Tone
             * @enum {string}
             */
            tone: "Neutral" | "Highlight" | "Citation" | "Link" | "MachineLink" | "Warning";
        };
        /**
         * ReaderDocumentMapOut
         * @description Annotations over one publication: ``identity`` is the reader document's identity.
         */
        ReaderDocumentMapOut: {
            /** Annotations Version */
            annotations_version: number;
            diagnostics: components["schemas"]["ReaderDocumentMapDiagnosticsOut"];
            /** Embeds */
            embeds: components["schemas"]["DocumentEmbedOut"][];
            evidence: components["schemas"]["ReaderEvidenceOut"];
            /** Identity */
            identity: string;
            /** Markers */
            markers: components["schemas"]["ReaderDocumentMapMarkerOut"][];
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /**
             * Status
             * @enum {string}
             */
            status: "ready" | "empty" | "partial";
        };
        /** ReaderEpubTarget */
        ReaderEpubTarget: {
            /** Anchor Id */
            anchor_id: string | null;
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /** Href Path */
            href_path: string;
        };
        /** ReaderEvidenceAnchorOut */
        ReaderEvidenceAnchorOut: {
            /** Locator */
            locator: (components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["PdfPageLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"]) | components["schemas"]["ReaderPdfPageLocatorOut"];
            /** Passage Anchor Id */
            passage_anchor_id: string | null;
        };
        /** ReaderEvidenceCountsOut */
        ReaderEvidenceCountsOut: {
            /** Citations */
            citations: number;
            /** Highlights */
            highlights: number;
            /** Links */
            links: number;
            /** Machine Links */
            machine_links: number;
        };
        /** ReaderEvidenceHighlightOut */
        ReaderEvidenceHighlightOut: {
            /**
             * Author User Id
             * Format: uuid
             */
            author_user_id: string;
            /**
             * Color
             * @enum {string}
             */
            color: "yellow" | "green" | "blue" | "pink" | "purple";
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Highlight Id
             * Format: uuid
             */
            highlight_id: string;
            /** Is Owner */
            is_owner: boolean;
            item: components["schemas"]["ResourceItemOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Highlight";
            /** Prefix */
            prefix: string;
            /** Quote */
            quote: string;
            /** Suffix */
            suffix: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /** Version */
            version: string;
        };
        /** ReaderEvidenceOut */
        ReaderEvidenceOut: {
            apparatus_source: components["schemas"]["SourceAttributionOut"] | null;
            counts: components["schemas"]["ReaderEvidenceCountsOut"];
            /** Roots */
            roots: components["schemas"]["ReaderEvidenceRootOut"][];
        };
        /** ReaderEvidenceResolvedOut */
        ReaderEvidenceResolvedOut: {
            anchor: components["schemas"]["ReaderEvidenceAnchorOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Resolved";
            /** Order Key */
            order_key: string;
        };
        /** ReaderEvidenceResourceOut */
        ReaderEvidenceResourceOut: {
            item: components["schemas"]["ResourceItemOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Resource";
        };
        /**
         * ReaderEvidenceRootOut
         * @description One exact resource; native content owns its placement when present.
         */
        ReaderEvidenceRootOut: {
            authored_placement: components["schemas"]["ReaderAuthoredPlacementOut"] | null;
            /** Content */
            content: components["schemas"]["ReaderEvidenceHighlightOut"] | components["schemas"]["ReaderEvidenceSourceReferenceOut"] | components["schemas"]["ReaderEvidenceResourceOut"];
            /** Continuation */
            continuation: (components["schemas"]["ReaderChildContinuationOut"] | components["schemas"]["ReaderSiblingContinuationOut"]) | null;
            /** Direct Facts */
            direct_facts: components["schemas"]["ReaderDirectFactOut"][];
            /** Ref */
            ref: string;
            /** Resolution */
            resolution: (components["schemas"]["ReaderEvidenceResolvedOut"] | components["schemas"]["ReaderEvidenceUnavailableOut"]) | null;
        };
        /**
         * ReaderEvidenceSourceReferenceOut
         * @description A visible owner preview; its publication attribution is shared by Evidence.
         */
        ReaderEvidenceSourceReferenceOut: {
            /** Action Ref */
            action_ref: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /**
             * Apparatus Kind
             * @enum {string}
             */
            apparatus_kind: "footnote_ref" | "endnote_ref" | "bibliography_ref" | "sidenote_ref" | "margin_note_ref" | "footnote" | "endnote" | "bibliography_entry" | "sidenote" | "margin_note" | "reference_section";
            /**
             * Confidence
             * @enum {string}
             */
            confidence: "exact" | "strong" | "probable";
            excerpt: components["schemas"]["ExcerptOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceReference";
            /** Label */
            label: string;
            /** Location Label */
            location_label: string | null;
            /** Marker Anchor Id */
            marker_anchor_id: string | null;
            /** Resource Ref */
            resource_ref: string;
            /** Stable Key */
            stable_key: string;
        };
        /** ReaderEvidenceSourceTargetOut */
        ReaderEvidenceSourceTargetOut: {
            /**
             * Apparatus Kind
             * @enum {string}
             */
            apparatus_kind: "footnote_ref" | "endnote_ref" | "bibliography_ref" | "sidenote_ref" | "margin_note_ref" | "footnote" | "endnote" | "bibliography_entry" | "sidenote" | "margin_note" | "reference_section";
            /** Content */
            content: components["schemas"]["ReaderSourceHtmlOut"] | components["schemas"]["ReaderSourceTextOut"] | components["schemas"]["ReaderSourceUnavailableOut"];
            item: components["schemas"]["ResourceItemOut"];
            /** Resolution */
            resolution: components["schemas"]["ReaderEvidenceResolvedOut"] | components["schemas"]["ReaderEvidenceUnavailableOut"];
            /** Stable Key */
            stable_key: string;
        };
        /** ReaderEvidenceUnavailableOut */
        ReaderEvidenceUnavailableOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Unavailable";
            /**
             * Reason
             * @enum {string}
             */
            reason: "Missing" | "Unanchorable" | "Stale";
        };
        /** ReaderFragmentTarget */
        ReaderFragmentTarget: {
            /** Fragment Id */
            fragment_id: string;
        };
        /** ReaderPdfDocumentOut */
        ReaderPdfDocumentOut: {
            file: components["schemas"]["ReaderPdfFileOut"];
            /** Identity */
            identity: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "pdf";
            /** Page Count */
            page_count: number | null;
            /** Title */
            title: string;
        };
        /** ReaderPdfFileOut */
        ReaderPdfFileOut: {
            /** Expires At */
            expires_at: string | null;
            /** Url */
            url: string;
        };
        /** ReaderPdfPageLocatorOut */
        ReaderPdfPageLocatorOut: {
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Page Number */
            page_number: number;
            /**
             * Type
             * @default pdf_page
             * @constant
             */
            type: "pdf_page";
        };
        /** ReaderPointOut */
        ReaderPointOut: {
            /** Offset */
            offset: number;
            /** Unit Id */
            unit_id: string;
        };
        /**
         * ReaderProfileOut
         * @description Exactly the seven preference fields; ``created_at`` never appears here.
         */
        ReaderProfileOut: {
            /** Column Width Ch */
            column_width_ch: number;
            /**
             * Focus Mode
             * @enum {string}
             */
            focus_mode: "off" | "distraction_free" | "paragraph" | "sentence";
            /**
             * Font Family
             * @enum {string}
             */
            font_family: "serif" | "sans";
            /** Font Size Px */
            font_size_px: number;
            /**
             * Hyphenation
             * @enum {string}
             */
            hyphenation: "auto" | "off";
            /** Line Height */
            line_height: number;
            /**
             * Theme
             * @enum {string}
             */
            theme: "light" | "dark";
        };
        /**
         * ReaderProfilePatch
         * @description Partial update; numeric strings must fail rather than silently coerce.
         */
        ReaderProfilePatch: {
            /** Column Width Ch */
            column_width_ch?: number | null;
            /** Focus Mode */
            focus_mode?: ("off" | "distraction_free" | "paragraph" | "sentence") | null;
            /** Font Family */
            font_family?: ("serif" | "sans") | null;
            /** Font Size Px */
            font_size_px?: number | null;
            /** Hyphenation */
            hyphenation?: ("auto" | "off") | null;
            /** Line Height */
            line_height?: number | null;
            /** Theme */
            theme?: ("light" | "dark") | null;
        };
        /** ReaderQuoteContext */
        ReaderQuoteContext: {
            /** Quote */
            quote: string | null;
            /** Quote Prefix */
            quote_prefix: string | null;
            /** Quote Suffix */
            quote_suffix: string | null;
        };
        /** ReaderQuoteSourceTargetKey */
        ReaderQuoteSourceTargetKey: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "reader_quote";
            /**
             * Message Id
             * Format: uuid
             */
            message_id: string;
        };
        /** ReaderSectionOut */
        ReaderSectionOut: {
            /** Anchor Id */
            anchor_id: string | null;
            at: components["schemas"]["ReaderPointOut"];
            /** Depth */
            depth: number;
            /** Id */
            id: string;
            /** Label */
            label: string;
        };
        /**
         * ReaderSelectionInput
         * @description A send's quote: the durable key plus the compare-on-send revision, never text.
         */
        ReaderSelectionInput: {
            key: components["schemas"]["ReaderSelectionKey"];
            /** Revision */
            revision: string;
        };
        /** ReaderSelectionKey */
        ReaderSelectionKey: {
            /**
             * Highlight Id
             * Format: uuid
             */
            highlight_id: string;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
        };
        /** ReaderSelectionOut */
        ReaderSelectionOut: {
            item: components["schemas"]["ResourceItemOut"];
            key: components["schemas"]["ReaderSelectionKey"];
        };
        /** ReaderSelectionPreview */
        ReaderSelectionPreview: {
            item: components["schemas"]["ResourceItemOut"];
            key: components["schemas"]["ReaderSelectionKey"];
            /** Revision */
            revision: string;
        };
        /** ReaderSiblingContinuationOut */
        ReaderSiblingContinuationOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "sibling";
            position: components["schemas"]["Position"];
            source: components["schemas"]["LinkResourceEndpoint"];
        };
        /** ReaderSourceHtmlOut */
        ReaderSourceHtmlOut: {
            /** Html Sanitized */
            html_sanitized: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Html";
            /** Text */
            text: string;
        };
        /** ReaderSourceTextOut */
        ReaderSourceTextOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Text";
            /** Text */
            text: string;
        };
        /** ReaderSourceUnavailableOut */
        ReaderSourceUnavailableOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Unavailable";
        };
        /** ReaderTextDocumentOut */
        ReaderTextDocumentOut: {
            /** Embeds */
            embeds: components["schemas"]["DocumentEmbedOut"][];
            /** Identity */
            identity: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "epub" | "transcript" | "web_article";
            /** Sections */
            sections: components["schemas"]["ReaderSectionOut"][];
            /** Source Issues */
            source_issues: (components["schemas"]["MissingImage"] | components["schemas"]["UnresolvedNavigationTarget"] | components["schemas"]["TooManyNotes"])[];
            /** Title */
            title: string;
            /** Toc Nodes */
            toc_nodes: components["schemas"]["ReaderTocNodeOut"][];
            /** Units */
            units: components["schemas"]["ReaderUnitOut"][];
            x_article_content: components["schemas"]["XArticleContent"] | null;
            x_capture: components["schemas"]["ReaderXCaptureOut"] | null;
        };
        /** ReaderTextLocations */
        ReaderTextLocations: {
            /** Position */
            position: number | null;
            /** Progression */
            progression: number | null;
            /** Text Offset */
            text_offset: number | null;
            /** Total Progression */
            total_progression: number | null;
        };
        /** ReaderTocNodeOut */
        ReaderTocNodeOut: {
            at: components["schemas"]["ReaderPointOut"] | null;
            /** Children */
            children: components["schemas"]["ReaderTocNodeOut"][];
            /** Id */
            id: string;
            /** Label */
            label: string;
            /** Section Id */
            section_id: string | null;
        };
        /** ReaderUnitOut */
        ReaderUnitOut: {
            /** Canonical Text */
            canonical_text: string;
            /** Char Count */
            char_count: number;
            /** Href Path */
            href_path: string | null;
            /** Html Sanitized */
            html_sanitized: string;
            /** Id */
            id: string;
            /** Idx */
            idx: number;
            /** Speaker Label */
            speaker_label: string | null;
            /** T End Ms */
            t_end_ms: number | null;
            /** T Start Ms */
            t_start_ms: number | null;
            x_post: components["schemas"]["ReaderXPostOut"] | null;
        };
        /** ReaderXCaptureOut */
        ReaderXCaptureOut: {
            /** Limits */
            limits: ("post_limit" | "operation_limit")[];
            /** Primary Post Count */
            primary_post_count: number;
            /** Root Revision Id */
            root_revision_id: string | null;
            /**
             * Saved At
             * Format: date-time
             */
            saved_at: string;
            /**
             * Scope
             * @enum {string}
             */
            scope: "author_thread" | "post";
            /** Search Exhausted */
            search_exhausted: boolean | null;
            /** Unavailable Context Count */
            unavailable_context_count: number;
            /** Uncaptured Context Count */
            uncaptured_context_count: number;
            /** Unchecked Post Count */
            unchecked_post_count: number;
            /** Unresolved Parent Count */
            unresolved_parent_count: number;
        };
        /** ReaderXPostOut */
        ReaderXPostOut: {
            author: components["schemas"]["XSourceAuthor"];
            /**
             * Availability
             * @enum {string}
             */
            availability: "available" | "unavailable";
            /** Body Captured At */
            body_captured_at: string | null;
            /** Checked At */
            checked_at: string | null;
            /** Checked In Capture */
            checked_in_capture: boolean | null;
            /** Created At */
            created_at: string | null;
            /** Embed Occurrence Key */
            embed_occurrence_key: string | null;
            /** Insertion Offset */
            insertion_offset: number | null;
            /** Is Edited */
            is_edited: boolean;
            /** Logical Post Id */
            logical_post_id: string | null;
            owner: components["schemas"]["ReaderXPostOwnerOut"] | null;
            /** Parent Unit Id */
            parent_unit_id: string | null;
            /** Referenced Revision Id */
            referenced_revision_id: string | null;
            /** References */
            references: components["schemas"]["ReaderXReferenceOut"][];
            /**
             * Relation
             * @enum {string}
             */
            relation: "primary" | "quoted" | "replied_to" | "retweeted" | "embedded";
            /** Source Revision Id */
            source_revision_id: string;
            /** Source Url */
            source_url: string;
        };
        /** ReaderXPostOwnerOut */
        ReaderXPostOwnerOut: {
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /** Generation */
            generation: number;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
        };
        /** ReaderXReferenceOut */
        ReaderXReferenceOut: {
            /**
             * Availability
             * @enum {string}
             */
            availability: "available" | "unavailable" | "not_captured";
            /** Referenced Revision Id */
            referenced_revision_id: string;
            /**
             * Relation
             * @enum {string}
             */
            relation: "quoted" | "replied_to" | "retweeted";
            /** Source Url */
            source_url: string;
            /** Target Unit Id */
            target_unit_id: string | null;
        };
        /** ReadingActivityBatchIn */
        ReadingActivityBatchIn: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modality: "Reading";
            /** Spans */
            spans: components["schemas"]["ReadingActivitySpanIn"][];
        };
        /** ReadingActivitySpanIn */
        ReadingActivitySpanIn: {
            /**
             * Capture Key
             * Format: uuid
             */
            capture_key: string;
            /** Duration Ms */
            duration_ms: number;
            /**
             * Occurred At
             * Format: date-time
             */
            occurred_at: string;
            /** Progress End */
            progress_end: number | null;
            /** Progress Start */
            progress_start: number | null;
            /** Word End */
            word_end: number | null;
            /** Word Start */
            word_start: number | null;
        };
        /**
         * ReadingCopyOut
         * @description An offline reading copy (a zip) in object storage: a signed url to fetch it without
         *     credentials until ``expires_at``, and the publication generation it was built from.
         */
        ReadingCopyOut: {
            /**
             * Expires At
             * Format: date-time
             */
            expires_at: string;
            /** Generation */
            generation: number;
            /** Url */
            url: string;
        };
        /** ReadingTimeEstimateOut */
        ReadingTimeEstimateOut: {
            /** Remaining Minutes */
            remaining_minutes: number | null;
            /** Total Minutes */
            total_minutes: number;
        };
        /** Ready */
        Ready: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Ready";
            /**
             * Last Checked
             * Format: date-time
             */
            last_checked: string;
        };
        /** ReceivedUserShareOut */
        ReceivedUserShareOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Kind
             * @default ReceivedUser
             * @constant
             */
            kind: "ReceivedUser";
            shared_by: components["schemas"]["ShareUserOut"];
            /** Subject */
            subject: string;
        };
        /**
         * RecoveryAction
         * @description One import obligation's offer (source, then search; at most one each), carrying
         *     the attempt/job/revision the viewer saw.
         */
        RecoveryAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Recovery";
            /** Offer */
            offer: components["schemas"]["RetrySourceOffer"] | components["schemas"]["RepairSourceOffer"] | components["schemas"]["RepairSearchOffer"];
        };
        /** ReferenceResourceBodyOut */
        ReferenceResourceBodyOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "reference";
            label: components["schemas"]["ExcerptOut"] | null;
            /** Target Ref */
            target_ref: string;
        };
        /**
         * RefreshSourceAction
         * @description Refresh from the attempt the viewer saw; a refresh admission replays by it.
         */
        RefreshSourceAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /** Expected Attempt Id */
            expected_attempt_id: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "RefreshSource";
        };
        /** RefreshSourceRequest */
        RefreshSourceRequest: {
            /**
             * Expected Attempt Id
             * Format: uuid
             */
            expected_attempt_id: string;
        };
        /**
         * Rejected
         * @description Verification refused the bytes; only removal remains.
         */
        Rejected: {
            /**
             * Code
             * @enum {string}
             */
            code: "E_SOURCE_INTEGRITY" | "E_INVALID_FILE_TYPE" | "E_FILE_TOO_LARGE" | "E_CAPTURE_TOO_LARGE";
            /** Import Ref */
            import_ref: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Rejected";
            /**
             * Session Id
             * Format: uuid
             */
            session_id: string;
        };
        /** RejectedChatAdmission */
        RejectedChatAdmission: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Rejected";
            reason: components["schemas"]["ChatAdmissionRejection"];
        };
        /** RelatedImport */
        RelatedImport: {
            item: components["schemas"]["ImportItem"];
            /**
             * Relation
             * @enum {string}
             */
            relation: "article" | "thread";
        };
        /** Relink */
        Relink: {
            /** Destination */
            destination: string;
            /** Endpoint */
            endpoint: string;
            /** Expected Source Links Version */
            expected_source_links_version: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "relink";
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            /**
             * New Link Id
             * Format: uuid
             */
            new_link_id: string;
            position: components["schemas"]["Position"] | null;
        };
        /** Remove */
        Remove: {
            /** Endpoint */
            endpoint: string;
            /** Expected Body Version */
            expected_body_version: number | null;
            /** Expected Links Version */
            expected_links_version: number | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "remove";
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
        };
        /**
         * RemovedItem
         * @description A Lectern row a finish removed: put back with its id and added time.
         */
        RemovedItem: {
            /**
             * Added At
             * Format: date-time
             */
            added_at: string;
            /** After Item Id */
            after_item_id: string | null;
            /**
             * Item Id
             * Format: uuid
             */
            item_id: string;
        };
        /**
         * RenameLibraryRequest
         * @description `expected_name` is the name the client last read (the expected version).
         */
        RenameLibraryRequest: {
            /** Expected Name */
            expected_name: string;
            /** Name */
            name: string;
        };
        /** RepairSearchOffer */
        RepairSearchOffer: {
            /**
             * Expected Job Id
             * Format: uuid
             */
            expected_job_id: string;
            /** Expected Revision */
            expected_revision: number;
            /**
             * Input
             * @default PublishedContent
             * @constant
             */
            input: "PublishedContent";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "RepairSearch";
        };
        /** RepairSourceOffer */
        RepairSourceOffer: {
            /**
             * Expected Attempt Id
             * Format: uuid
             */
            expected_attempt_id: string;
            /**
             * Expected Job Id
             * Format: uuid
             */
            expected_job_id: string;
            /**
             * Input
             * @enum {string}
             */
            input: "StoredSource" | "RefetchSource";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "RepairSource";
        };
        /** ReplyInsertion */
        ReplyInsertion: {
            /** Branch Anchor */
            branch_anchor: components["schemas"]["NoBranchAnchor"] | components["schemas"]["AssistantMessageBranchAnchor"] | components["schemas"]["AssistantSelectionBranchAnchor"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Reply";
            /**
             * Parent Message Id
             * Format: uuid
             */
            parent_message_id: string;
        };
        /** ResolveMediaSummariesIn */
        ResolveMediaSummariesIn: {
            /** Media Ids */
            media_ids: string[];
        };
        /** ResolveSourceTargetRequest */
        ResolveSourceTargetRequest: {
            /** Target */
            target: components["schemas"]["ResourceSourceTargetKey"] | components["schemas"]["ReaderQuoteSourceTargetKey"] | components["schemas"]["CitationSourceTargetKey"] | components["schemas"]["RetrievalSourceTargetKey"];
        };
        /** ResolvedMediaSummariesOut */
        ResolvedMediaSummariesOut: {
            /** Items */
            items: components["schemas"]["MediaSummaryResolutionOut"][];
        };
        /**
         * ResourceActionsOut
         * @description One ref's verbs now. Inapplicable verbs are omitted; forbidden ones carry ``blocked``.
         *     A missing ref has no verbs and a none activation. ``label`` is the name confirmations
         *     quote (a media's bare title).
         */
        ResourceActionsOut: {
            /** Actions */
            actions: (components["schemas"]["SimpleAction"] | components["schemas"]["RefreshSourceAction"] | components["schemas"]["RetryMetadataAction"] | components["schemas"]["ReviewMetadataResultAction"] | components["schemas"]["RecoveryAction"] | components["schemas"]["DownloadAction"] | components["schemas"]["OpenSourceAction"] | components["schemas"]["PlaybackAction"] | components["schemas"]["ConsumptionAction"] | components["schemas"]["RetryPodcastBackfillAction"] | components["schemas"]["PodcastSubscriptionAction"] | components["schemas"]["TranscriptAction"] | components["schemas"]["LecternMembershipAction"] | components["schemas"]["HighlightNoteAction"])[];
            activation: components["schemas"]["ResourceActivationOut"];
            /** Label */
            label: string;
            /** Missing */
            missing: boolean;
            /** Ref */
            ref: string;
        };
        /**
         * ResourceActivationOut
         * @description Where opening a ref goes; ``href`` is null exactly when ``kind`` is none.
         */
        ResourceActivationOut: {
            /** Href */
            href: string | null;
            /**
             * Kind
             * @enum {string}
             */
            kind: "route" | "external" | "none";
            /** Resource Ref */
            resource_ref: string;
            /** Unavailable Reason */
            unavailable_reason: ("source_unavailable" | "location_unavailable") | null;
        };
        /** ResourceActivityTargetOut */
        ResourceActivityTargetOut: {
            item: components["schemas"]["ResourceItemOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource";
        };
        /** ResourceAnnotationOut */
        ResourceAnnotationOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            /**
             * Attachment Edge Id
             * Format: uuid
             */
            attachment_edge_id: string;
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Body Text */
            body_text: string;
            /** Body Version */
            body_version: number;
            /** Note Ref */
            note_ref: string;
        };
        /** ResourceContentOut */
        ResourceContentOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource";
        };
        /** ResourceItemOut */
        ResourceItemOut: {
            /** Action Ref */
            action_ref: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Label */
            label: string;
            /** Missing */
            missing: boolean;
            preview: components["schemas"]["ResourcePreviewOut"];
            /** Ref */
            ref: string;
        };
        /** ResourcePreviewOut */
        ResourcePreviewOut: {
            annotation: components["schemas"]["ResourceAnnotationOut"] | null;
            /** Body */
            body: components["schemas"]["NamedResourceBodyOut"] | components["schemas"]["MediaResourceBodyOut"] | components["schemas"]["PassageResourceBodyOut"] | components["schemas"]["ProseResourceBodyOut"] | components["schemas"]["ImagesResourceBodyOut"] | components["schemas"]["ReferenceResourceBodyOut"];
            source: components["schemas"]["SourceAttributionOut"] | null;
        };
        /** @enum {string} */
        ResourceScheme: "media" | "library" | "evidence_span" | "content_chunk" | "highlight" | "page" | "note_block" | "fragment" | "conversation" | "message" | "oracle_reading" | "oracle_passage_anchor" | "artifact" | "artifact_revision" | "external_snapshot" | "contributor" | "podcast" | "reader_apparatus_item" | "passage_anchor";
        /** ResourceShareSnapshotOut */
        ResourceShareSnapshotOut: {
            /** Authenticated Href */
            authenticated_href: string;
            creation_availability: components["schemas"]["CreationAvailabilityOut"];
            members: components["schemas"]["ShareMembersOut"] | null;
            /** Received Access */
            received_access: components["schemas"]["ReceivedUserShareOut"][];
            /** Shares */
            shares: (components["schemas"]["UserShareOut"] | components["schemas"]["LinkShareOut"])[];
            /**
             * Sharing
             * @enum {string}
             */
            sharing: "None" | "CopyOnly" | "ResourceGrants" | "HighlightGrants" | "LibraryMembership";
        };
        /** ResourceSourceTargetKey */
        ResourceSourceTargetKey: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource";
            /** Resource Ref */
            resource_ref: string;
        };
        /** ResourceTargetPassageOut */
        ResourceTargetPassageOut: {
            /** Candidate Ref */
            candidate_ref: string;
            /** Existing Link Id */
            existing_link_id: string | null;
            item: components["schemas"]["ResourceItemOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "passage";
        };
        /** ResourceTargetResourceOut */
        ResourceTargetResourceOut: {
            /** Existing Link Id */
            existing_link_id: string | null;
            item: components["schemas"]["ResourceItemOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource";
        };
        /** ResourceTargetSearchRequest */
        ResourceTargetSearchRequest: {
            /** Cursor */
            cursor?: string | null;
            /** Exclude Refs */
            exclude_refs?: string[];
            /** Q */
            q: string;
            /** Source Ref */
            source_ref?: string | null;
        };
        /** ResourceTargetSearchResponse */
        ResourceTargetSearchResponse: {
            /** Next Cursor */
            next_cursor: string | null;
            /** Targets */
            targets: (components["schemas"]["ResourceTargetResourceOut"] | components["schemas"]["ResourceTargetPassageOut"])[];
        };
        /** ResourceVersionState */
        ResourceVersionState: {
            /** Annotations Version */
            annotations_version: number | null;
            /** Body Version */
            body_version: number | null;
            /** Highlight Version */
            highlight_version: string | null;
            /** Links Version */
            links_version: number | null;
            /** Ref */
            ref: string;
            /**
             * State
             * @enum {string}
             */
            state: "live" | "unavailable";
            /** Title Version */
            title_version: number | null;
        };
        /** ResourceVersionsOut */
        ResourceVersionsOut: {
            /** Items */
            items: components["schemas"]["ResourceVersionState"][];
        };
        /** ResourceVersionsRequest */
        ResourceVersionsRequest: {
            /** Refs */
            refs: string[];
        };
        /** RetainedArtifactsOut */
        RetainedArtifactsOut: {
            /** Applied Filters */
            applied_filters: string[];
            /** Highlights */
            highlights: number;
            /** Inapplicable Filters */
            inapplicable_filters: string[];
            /** Neutral Links */
            neutral_links: number;
            /** Note Blocks */
            note_blocks: number;
        };
        /** RetrievalSourceTargetKey */
        RetrievalSourceTargetKey: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "retrieval";
            /**
             * Retrieval Id
             * Format: uuid
             */
            retrieval_id: string;
        };
        /** RetryMetadataAction */
        RetryMetadataAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "RetryMetadata";
            retry: components["schemas"]["MetadataRetry"];
        };
        /** RetryPodcastBackfillAction */
        RetryPodcastBackfillAction: {
            /**
             * Backfill Id
             * Format: uuid
             */
            backfill_id: string;
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "RetryPodcastBackfill";
        };
        /** RetrySourceOffer */
        RetrySourceOffer: {
            /**
             * Expected Attempt Id
             * Format: uuid
             */
            expected_attempt_id: string;
            /**
             * Input
             * @enum {string}
             */
            input: "StoredSource" | "RefetchSource";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "RetrySource";
        };
        /** RetrySourceRequest */
        RetrySourceRequest: {
            /**
             * Expected Attempt Id
             * Format: uuid
             */
            expected_attempt_id: string;
        };
        /** RetryUploadOffer */
        RetryUploadOffer: {
            /**
             * Input
             * @default ChooseOriginalFile
             * @constant
             */
            input: "ChooseOriginalFile";
            /**
             * Kind
             * @default RetryUpload
             * @constant
             */
            kind: "RetryUpload";
        };
        /**
         * ReviewMetadataResultAction
         * @description Acknowledge the exact no-findings metadata job the viewer has not reviewed.
         */
        ReviewMetadataResultAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "ReviewMetadataResult";
        };
        /** RunSelectionOut */
        RunSelectionOut: {
            display_at_dispatch: components["schemas"]["SelectionPresentation"];
            /** Selection */
            selection: components["schemas"]["CodexPersonalSelection"] | components["schemas"]["ProviderApiSelection"];
        };
        /** SearchMatchOut */
        SearchMatchOut: {
            excerpt: components["schemas"]["ExcerptOut"];
            /** Ranges */
            ranges: components["schemas"]["SearchMatchRangeOut"][];
        };
        /** SearchMatchRangeOut */
        SearchMatchRangeOut: {
            /** End */
            end: number;
            /** Start */
            start: number;
        };
        /** SearchOccurrenceOut */
        SearchOccurrenceOut: {
            item: components["schemas"]["ResourceItemOut"];
            match: components["schemas"]["SearchMatchOut"] | null;
            /**
             * Match Method
             * @enum {string}
             */
            match_method: "lexical" | "semantic";
        };
        /** SearchPageInfo */
        SearchPageInfo: {
            /**
             * Has More
             * @default false
             */
            has_more: boolean;
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** SearchPassagesResponse */
        SearchPassagesResponse: {
            page: components["schemas"]["SearchPageInfo"];
            /** Results */
            results: components["schemas"]["SearchOccurrenceOut"][];
            /**
             * Semantic Status
             * @enum {string}
             */
            semantic_status: "not_requested" | "used" | "unavailable";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            view: "passages";
        };
        /** SearchPreviewResponse */
        SearchPreviewResponse: {
            /** Passages */
            passages: components["schemas"]["SearchOccurrenceOut"][];
            /** Resources */
            resources: components["schemas"]["SearchResourceOut"][];
            /** Saved */
            saved: components["schemas"]["SearchResourceOut"][];
            /**
             * Semantic Status
             * @enum {string}
             */
            semantic_status: "not_requested" | "used" | "unavailable";
        };
        /** SearchRepairAdmission */
        SearchRepairAdmission: {
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SearchRepair";
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Revision */
            revision: number;
        };
        /**
         * SearchRepairRequest
         * @description Requeue the exact dead reindex job of one content-index revision.
         */
        SearchRepairRequest: {
            /**
             * Expected Job Id
             * Format: uuid
             */
            expected_job_id: string;
            /** Expected Revision */
            expected_revision: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Search";
        };
        /** SearchResourceOut */
        SearchResourceOut: {
            item: components["schemas"]["ResourceItemOut"];
            match: components["schemas"]["SearchMatchOut"] | null;
            /** Match Method */
            match_method: ("lexical" | "semantic") | null;
            matching_passage: components["schemas"]["SearchOccurrenceOut"] | null;
            /** Name Match */
            name_match: ("exact" | "prefix" | "substring") | null;
            /**
             * Section
             * @enum {string}
             */
            section: "primary" | "saved" | "inside";
        };
        /** SearchResourcesResponse */
        SearchResourcesResponse: {
            page: components["schemas"]["SearchPageInfo"];
            /** Results */
            results: components["schemas"]["SearchResourceOut"][];
            /**
             * Semantic Status
             * @enum {string}
             */
            semantic_status: "not_requested" | "used" | "unavailable";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            view: "resources";
        };
        /** Selectable */
        Selectable: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Selectable";
        };
        /** SelectionPresentation */
        SelectionPresentation: {
            /** Billing */
            billing: components["schemas"]["SubscriptionBilling"] | components["schemas"]["MeteredApiBilling"];
            /** Model Label */
            model_label: string;
            privacy: components["schemas"]["PrivacyDisclosure"];
            processor_chain: components["schemas"]["ProcessorChain"];
            /** Reasoning Label */
            reasoning_label: string;
            /** Route Label */
            route_label: string;
        };
        /** SetBody */
        SetBody: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Expected Version */
            expected_version: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "set_body";
            /**
             * Note Id
             * Format: uuid
             */
            note_id: string;
        };
        /**
         * SetHighlightNoteRequest
         * @description Create in the loaded empty slot or edit its exact attached note.
         */
        SetHighlightNoteRequest: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Expected */
            expected: components["schemas"]["AbsentHighlightNoteExpected"] | components["schemas"]["ExistingHighlightNoteExpected"];
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            /**
             * Note Id
             * Format: uuid
             */
            note_id: string;
        };
        /**
         * SetMemberRoleRequest
         * @description `expected_role` is the role the client last read (the expected version).
         */
        SetMemberRoleRequest: {
            /**
             * Expected Role
             * @enum {string}
             */
            expected_role: "admin" | "member";
            /**
             * Role
             * @enum {string}
             */
            role: "admin" | "member";
        };
        /** SetTitle */
        SetTitle: {
            /** Expected Version */
            expected_version: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "set_title";
            /**
             * Page Id
             * Format: uuid
             */
            page_id: string;
            /** Title */
            title: string;
        };
        /** ShareMembersOut */
        ShareMembersOut: {
            /** Can Manage */
            can_manage: boolean;
        };
        /** ShareUserOut */
        ShareUserOut: {
            /** Display Name */
            display_name: string | null;
            /** Email */
            email: string | null;
            /**
             * User Id
             * Format: uuid
             */
            user_id: string;
        };
        /** SimpleAction */
        SimpleAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Chat" | "DeleteConversation" | "DeleteHighlight" | "DeleteLibrary" | "DeleteMessage" | "DeletePage" | "DownloadOriginal" | "EditAuthors" | "EditHighlight" | "EditHighlightBounds" | "EditNoteBody" | "EditPageTitle" | "ForkMessage" | "LearnHighlight" | "LibraryPlacement" | "LibrarySettings" | "MediaMetadata" | "Open" | "OpenInNewPane" | "PlayNext" | "PodcastSettings" | "RefreshPodcast" | "RegenerateArtifact" | "RegenerateMessage" | "RemoveMedia" | "RerunMessage" | "ResetProgress" | "Share";
        };
        /** SourceAccepted */
        SourceAccepted: {
            /** Attempt No */
            attempt_no: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceAccepted";
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /**
         * SourceAdmission
         * @description A retry's or refresh's attempt and its job (none for a successor born settled).
         */
        SourceAdmission: {
            /** Job Id */
            job_id: string | null;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /**
         * SourceAttemptOut
         * @description The current destination of an acceptance and whether that identity is settled.
         *
         *     Processing outcomes belong to Imports. Settlement follows the current
         *     destination's latest source attempt, including after supersession.
         */
        SourceAttemptOut: {
            /** Import Ref */
            import_ref: string;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Settled */
            settled: boolean;
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /** SourceAttributionOut */
        SourceAttributionOut: {
            activation: components["schemas"]["ResourceActivationOut"] | null;
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][] | null;
            /** Location Label */
            location_label: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Ref */
            ref: string | null;
            /** Title */
            title: string | null;
        };
        /** SourceCountedProgress */
        SourceCountedProgress: {
            /** Completed */
            completed: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Counted";
            /**
             * Stage
             * @default Extract
             * @constant
             */
            stage: "Extract";
            /** Total */
            total: number;
            /**
             * Unit
             * @enum {string}
             */
            unit: "Page" | "Chapter";
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** SourceExecutionStarted */
        SourceExecutionStarted: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceExecutionStarted";
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /** SourceFailed */
        SourceFailed: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceFailed";
            /**
             * Origin
             * @enum {string}
             */
            origin: "Execution" | "Domain";
            progress: components["schemas"]["SourceFailureProgress"] | null;
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
            /** Terminal */
            terminal: boolean;
        };
        /** SourceFailureProgress */
        SourceFailureProgress: {
            /** Completed */
            completed: number;
            /** Total */
            total: number | null;
            /** Unit */
            unit: string | null;
        };
        /**
         * SourceHistoryBaseline
         * @description Written once by the 2026-09-08 cut (0225): the outcome an earlier attempt had then.
         */
        SourceHistoryBaseline: {
            /** Attempt No */
            attempt_no: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceHistoryBaseline";
            /**
             * Outcome
             * @enum {string}
             */
            outcome: "Succeeded" | "Failed" | "InFlight";
            /** Outcome Code */
            outcome_code: ("E_SOURCE_INTEGRITY" | "E_INVALID_FILE_TYPE" | "E_FILE_TOO_LARGE" | "E_CAPTURE_TOO_LARGE") | ("E_ARCHIVE_UNSAFE" | "E_CAPTURE_TOO_LARGE" | "E_EMBEDDING_PROVIDER_UNAVAILABLE" | "E_FORBIDDEN" | "E_INGEST_FAILED" | "E_INGEST_TIMEOUT" | "E_INTERNAL" | "E_INVALID_CONTENT_TYPE" | "E_INVALID_KIND" | "E_INVALID_REQUEST" | "E_MEDIA_NOT_FOUND" | "E_MEDIA_NOT_READY" | "E_OWNER_REQUIRED" | "E_PDF_PASSWORD_REQUIRED" | "E_PDF_TEXT_UNAVAILABLE" | "E_PODCAST_PROVIDER_UNAVAILABLE" | "E_REPAIR_NOT_ALLOWED" | "E_RESOURCE_CONFLICT" | "E_RESOURCE_LIMIT" | "E_RETRY_INVALID_STATE" | "E_RETRY_NOT_ALLOWED" | "E_SANITIZATION_FAILED" | "E_SELECTION_CHANGED" | "E_SIGN_UPLOAD_FAILED" | "E_SOURCE_ACCESS_DENIED" | "E_SOURCE_FETCH_FAILED" | "E_SOURCE_GONE" | "E_SOURCE_NOT_READABLE" | "E_SOURCE_POSITION_UNMAPPABLE" | "E_SOURCE_TOO_LARGE" | "E_SSRF_BLOCKED" | "E_STORAGE_ERROR" | "E_STORAGE_MISSING" | "E_TRANSCRIPTION_FAILED" | "E_TRANSCRIPTION_TIMEOUT" | "E_TRANSCRIPT_UNAVAILABLE" | "E_UPLOAD_CAPABILITY_EXPIRED" | "E_WORKER_HANDLER_FAILED" | "E_WORKER_INTERRUPTED" | "E_X_POST_UNAVAILABLE" | "E_X_ARTICLE_BODY_UNAVAILABLE" | "E_X_ARTICLE_IDENTITY_CHANGED" | "E_X_IDENTITY_CONFLICT" | "E_X_SOURCE_CONFLICT" | "E_X_PROVIDER_AUTH_REJECTED" | "E_X_PROVIDER_CREDITS_DEPLETED" | "E_X_PROVIDER_RATE_LIMITED" | "E_X_PROVIDER_TIMEOUT" | "E_X_PROVIDER_UNAVAILABLE") | null;
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /**
         * SourceRecoveryAccepted
         * @description A recovery admitted for this attempt; its successor is the next attempt in the chain.
         *     Repairs written by operators (reprocess, corrected source type) keep their own kind.
         */
        SourceRecoveryAccepted: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceRecoveryAccepted";
            /**
             * Recovery
             * @enum {string}
             */
            recovery: "RetrySource" | "RepairSource" | "ReprocessSource" | "CorrectSourceType";
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /** SourceRepairAdmission */
        SourceRepairAdmission: {
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceRepair";
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /**
         * SourceRepairRequest
         * @description Requeue the exact dead job of one nonterminal source attempt.
         */
        SourceRepairRequest: {
            /**
             * Expected Attempt Id
             * Format: uuid
             */
            expected_attempt_id: string;
            /**
             * Expected Job Id
             * Format: uuid
             */
            expected_job_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Source";
        };
        /** SourceRetryScheduled */
        SourceRetryScheduled: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceRetryScheduled";
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /** SourceStageChanged */
        SourceStageChanged: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceStageChanged";
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /** SourceStageProgress */
        SourceStageProgress: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Stage";
            /**
             * Stage
             * @enum {string}
             */
            stage: "Validate" | "Extract" | "Finalize";
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** SourceSucceeded */
        SourceSucceeded: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceSucceeded";
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /** SourceTargetOut */
        SourceTargetOut: {
            /** Location */
            location: components["schemas"]["WholeSourceLocationOut"] | components["schemas"]["LocatedSourceLocationOut"] | components["schemas"]["UnavailableSourceLocationOut"];
            source_activation: components["schemas"]["ResourceActivationOut"] | null;
        };
        /** StarOut */
        StarOut: {
            /** Kind */
            kind: string;
            /** Magnitude */
            magnitude: number;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Title */
            title: string;
            /** X */
            x: number | null;
            /** Y */
            y: number | null;
        };
        /** SubscriptionBilling */
        SubscriptionBilling: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Subscription";
            /**
             * Label
             * @default Codex subscription
             * @constant
             */
            label: "Codex subscription";
        };
        /** SuggestionCurrentOut */
        SuggestionCurrentOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Current";
            state: components["schemas"]["SuggestionStateOut"];
        };
        /** SuggestionEnsureFreshIn */
        SuggestionEnsureFreshIn: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "EnsureFresh";
        };
        /** SuggestionExplicitRefreshIn */
        SuggestionExplicitRefreshIn: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Explicit";
            /** Observed Publication Id */
            observed_publication_id: string | null;
        };
        /** SuggestionItemOut */
        SuggestionItemOut: {
            /** Target */
            target: components["schemas"]["MediaSuggestionTargetOut"] | components["schemas"]["PodcastSuggestionTargetOut"];
        };
        /** SuggestionObservationOut */
        SuggestionObservationOut: components["schemas"]["SuggestionCurrentOut"] | components["schemas"]["SuggestionWithdrawnOut"];
        /** SuggestionPublicationMetaOut */
        SuggestionPublicationMetaOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
        };
        /** SuggestionPublicationOut */
        SuggestionPublicationOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Items */
            items: components["schemas"]["SuggestionItemOut"][];
        };
        /** SuggestionRefreshAtOut */
        SuggestionRefreshAtOut: {
            /**
             * At
             * Format: date-time
             */
            at: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "At";
        };
        /** SuggestionRefreshNowOut */
        SuggestionRefreshNowOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Now";
        };
        /** SuggestionRefreshStoppedOut */
        SuggestionRefreshStoppedOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Stopped";
        };
        /** SuggestionStateOut */
        SuggestionStateOut: {
            /** Automatic Refresh */
            automatic_refresh: components["schemas"]["SuggestionRefreshNowOut"] | components["schemas"]["SuggestionRefreshAtOut"] | components["schemas"]["SuggestionRefreshStoppedOut"];
            /**
             * Capability
             * @enum {string}
             */
            capability: "Available" | "LecternFull" | "NotApplicable";
            /** Input Revision */
            input_revision: number;
            latest: components["schemas"]["SuggestionPublicationMetaOut"] | null;
            work: components["schemas"]["DurableExecutionPhase"] | null;
        };
        /** SuggestionViewIn */
        SuggestionViewIn: {
            /** Refs */
            refs: string[];
        };
        /** SuggestionViewOut */
        SuggestionViewOut: {
            /** Items */
            items: components["schemas"]["SuggestionItemOut"][];
            /**
             * Observed At
             * Format: date-time
             */
            observed_at: string;
            state: components["schemas"]["SuggestionStateOut"];
        };
        /** SuggestionWithdrawnOut */
        SuggestionWithdrawnOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Withdrawn";
        };
        /** SuggestionsOut */
        SuggestionsOut: {
            /**
             * Observed At
             * Format: date-time
             */
            observed_at: string;
            publication: components["schemas"]["SuggestionPublicationOut"] | null;
            state: components["schemas"]["SuggestionStateOut"];
        };
        /** TemporarilyUnavailable */
        TemporarilyUnavailable: {
            /** Action */
            action: string;
            /**
             * Code
             * @enum {string}
             */
            code: "codex_host_unavailable" | "required_tool_unavailable";
            /** Explanation */
            explanation: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "TemporarilyUnavailable";
            /**
             * Last Checked
             * Format: date-time
             */
            last_checked: string;
        };
        /**
         * TextHighlightAnchorIn
         * @description A span of one reader unit (fragment) of the media.
         */
        TextHighlightAnchorIn: {
            /** End Offset */
            end_offset: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "text";
            /** Start Offset */
            start_offset: number;
            /**
             * Unit Id
             * Format: uuid
             */
            unit_id: string;
        };
        /** _TextQuoteGrammar */
        TextQuoteSelector: {
            /** Exact */
            exact: string;
            /** Prefix */
            prefix?: string;
            /** Suffix */
            suffix?: string;
        } & {
            [key: string]: unknown;
        };
        /**
         * TooManyNotes
         * @description A web article whose notes exceed the apparatus budget: they stay inline body text.
         */
        TooManyNotes: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "TooManyNotes";
        };
        /** ToolActivityOut */
        ToolActivityOut: {
            /** Detail */
            detail: string | null;
            /** Outcome */
            outcome: string | null;
            /** Subject */
            subject: string | null;
            /** Target */
            target: (components["schemas"]["ResourceActivityTargetOut"] | components["schemas"]["ExternalActivityTargetOut"]) | null;
            /** Verb */
            verb: string;
        };
        /**
         * ToolEffect
         * @enum {string}
         */
        ToolEffect: "Pure" | "Read" | "Write";
        /** TranscriptAction */
        TranscriptAction: {
            /** Blocked */
            blocked: ("PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable") | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Transcript";
            /**
             * State
             * @enum {string}
             */
            state: "not_requested" | "queued" | "running" | "ready" | "partial" | "unavailable" | "failed_provider";
        };
        /**
         * TranscriptCoverage
         * @description Coverage quality for transcript artifacts.
         * @enum {string}
         */
        TranscriptCoverage: "none" | "partial" | "full";
        /** TranscriptReaderResumeState */
        TranscriptReaderResumeState: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "transcript";
            locations: components["schemas"]["ReaderTextLocations"];
            target: components["schemas"]["ReaderFragmentTarget"];
            text: components["schemas"]["ReaderQuoteContext"];
        };
        /** TranscriptRequestOut */
        TranscriptRequestOut: {
            /** Media Id */
            media_id: string;
            /**
             * Processing Status
             * @enum {string}
             */
            processing_status: "pending" | "extracting" | "ready_for_reading" | "failed" | "suspended";
            /** Request Enqueued */
            request_enqueued: boolean;
            /**
             * Request Reason
             * @enum {string}
             */
            request_reason: "episode_open" | "search" | "highlight" | "quote" | "background_warming" | "operator_requeue";
            /**
             * Transcript Coverage
             * @enum {string}
             */
            transcript_coverage: "none" | "partial" | "full";
            /**
             * Transcript State
             * @enum {string}
             */
            transcript_state: "not_requested" | "queued" | "running" | "ready" | "partial" | "unavailable" | "failed_provider";
        };
        /** TranscriptRequestRequest */
        TranscriptRequestRequest: {
            /**
             * Reason
             * @default episode_open
             * @enum {string}
             */
            reason: "episode_open" | "search" | "highlight" | "quote" | "background_warming" | "operator_requeue";
        };
        /**
         * TranscriptState
         * @description Lifecycle state for transcript availability.
         * @enum {string}
         */
        TranscriptState: "not_requested" | "queued" | "running" | "ready" | "partial" | "unavailable" | "failed_provider";
        /** TranscriptTimeRangeLocator */
        TranscriptTimeRangeLocator: {
            /** Media Id */
            media_id: string;
            /** T End Ms */
            t_end_ms: number;
            /** T Start Ms */
            t_start_ms: number;
            text_quote_selector?: components["schemas"]["TextQuoteSelector"] | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "transcript_time_range";
        };
        /** TransferOwnershipRequest */
        TransferOwnershipRequest: {
            /**
             * User Id
             * Format: uuid
             */
            user_id: string;
        };
        /** TrustRetrievalOut */
        TrustRetrievalOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            item: components["schemas"]["ResourceItemOut"];
        };
        /** TrustRunOut */
        TrustRunOut: {
            execution: components["schemas"]["ChatRunExecutionOut"] | null;
            failure: components["schemas"]["ChatFailureOut"] | null;
            publication_warning: components["schemas"]["ChatPublicationWarning"] | null;
            /**
             * Run Id
             * Format: uuid
             */
            run_id: string;
            run_selection: components["schemas"]["RunSelectionOut"];
            /**
             * Status
             * @enum {string}
             */
            status: "pending" | "running" | "complete" | "error" | "cancelled";
            /** Support Id */
            support_id: string | null;
        };
        /** TrustToolCallOut */
        TrustToolCallOut: {
            activity: components["schemas"]["ToolActivityOut"];
            /** Canonical Tool Id */
            canonical_tool_id: string;
            /** Created Refs */
            created_refs: components["schemas"]["CreatedRefOut"][];
            effect: components["schemas"]["ToolEffect"];
            /**
             * Error Type
             * @enum {unknown}
             */
            error_type: "BudgetExceeded" | "Conflict" | "DeadlineExceeded" | "InvalidCursor" | "InvalidInput" | "InvalidUpstreamResponse" | "InvalidUrl" | "MemoryFailure" | "QuoteAmbiguous" | "QuoteNotFound" | "RateLimited" | "ResourceUnavailable" | "StaleCursor" | "TargetAmbiguous" | "TooLarge" | "ToolUnavailable" | "Uninspectable" | "Unreadable" | "UnsafeDestination" | "UnsupportedContent" | "UpstreamUnavailable" | "WriteCapReached" | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Machine Authorships */
            machine_authorships: components["schemas"]["MachineAuthorshipOut"][];
            /**
             * Result Kind
             * @enum {string}
             */
            result_kind: "mutation" | "navigation" | "retrieval";
            /** Retrievals */
            retrievals: components["schemas"]["TrustRetrievalOut"][];
            /** Reverted At */
            reverted_at: string | null;
            /**
             * Status
             * @enum {string}
             */
            status: "running" | "complete" | "error" | "cancelled";
            /** Tool Call Index */
            tool_call_index: number;
        };
        /** TypedHighlightOut */
        TypedHighlightOut: {
            /** Anchor */
            anchor: components["schemas"]["FragmentAnchorOut"] | components["schemas"]["PdfAnchorOut"];
            /**
             * Author User Id
             * Format: uuid
             */
            author_user_id: string;
            /**
             * Color
             * @enum {string}
             */
            color: "yellow" | "green" | "blue" | "pink" | "purple";
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Exact */
            exact: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Is Owner */
            is_owner: boolean;
            /** Linked Conversations */
            linked_conversations: components["schemas"]["LinkedConversationRef"][];
            /** Linked Note Blocks */
            linked_note_blocks: components["schemas"]["LinkedNoteBlockRef"][];
            /** Links Version */
            links_version: number;
            /** Prefix */
            prefix: string;
            /** Suffix */
            suffix: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /** Version */
            version: string;
        };
        /** UnavailableSourceLocationOut */
        UnavailableSourceLocationOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "unavailable";
            /**
             * Reason
             * @enum {string}
             */
            reason: "source_unavailable" | "location_unavailable";
        };
        /** Unlink */
        Unlink: {
            expected: components["schemas"]["UnlinkExpected"] | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "unlink";
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
        };
        /** UnlinkExpected */
        UnlinkExpected: {
            /** Endpoint */
            endpoint: string;
            /** Links Version */
            links_version: number;
        };
        /** UnlinkMutation */
        UnlinkMutation: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "unlink";
        };
        /** UnresolvedNavigationTarget */
        UnresolvedNavigationTarget: {
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "UnresolvedNavigationTarget";
            /** Node Id */
            node_id: string;
        };
        /** UpdateHighlightRequest */
        UpdateHighlightRequest: {
            /** Anchor */
            anchor?: (components["schemas"]["FragmentAnchorUpdateRequest"] | components["schemas"]["PdfAnchorUpdateRequest"]) | null;
            /** Color */
            color?: ("yellow" | "green" | "blue" | "pink" | "purple") | null;
            /** Exact */
            exact?: string | null;
            /** Expected Reader Generation */
            expected_reader_generation?: number | null;
            /** Expected Version */
            expected_version: string;
        };
        /**
         * UpdateProfileRequest
         * @description Request body for PATCH /me.
         */
        UpdateProfileRequest: {
            /**
             * Calendar Time Zone
             * @description IANA timezone used to resolve account-local calendar dates
             */
            calendar_time_zone?: string | null;
            /**
             * Display Name
             * @description Display name (1-100 chars, or null to clear)
             */
            display_name?: string | null;
        };
        /** UploadAccepted */
        UploadAccepted: {
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "UploadAccepted";
        };
        /**
         * UploadFailed
         * @description A verification rejection; the envelope's code says which.
         */
        UploadFailed: {
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "UploadFailed";
        };
        /**
         * UploadHistoryBaseline
         * @description Written once by the 2026-09-08 cut (0225) for every session that existed then.
         */
        UploadHistoryBaseline: {
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "UploadHistoryBaseline";
        };
        /** UploadPublished */
        UploadPublished: {
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "UploadPublished";
        };
        /** UploadRecoveryAccepted */
        UploadRecoveryAccepted: {
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "UploadRecoveryAccepted";
        };
        /**
         * UploadRequired
         * @description PUT the exact bytes to ``upload_url`` with ``Content-Type: content_type`` before
         *     ``expires_at``, then confirm ``generation``.
         */
        UploadRequired: {
            /** Content Type */
            content_type: string;
            /**
             * Expires At
             * Format: date-time
             */
            expires_at: string;
            /** Generation */
            generation: number;
            /** Import Ref */
            import_ref: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "UploadRequired";
            /**
             * Session Id
             * Format: uuid
             */
            session_id: string;
            /** Upload Url */
            upload_url: string;
        };
        /**
         * UserAudienceIn
         * @description `email` is the email the sharer typed to find the user (theirs, in any case), or
         *     null when found by name.
         */
        UserAudienceIn: {
            /** Email */
            email: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "User";
            /**
             * User Id
             * Format: uuid
             */
            user_id: string;
        };
        /**
         * UserProfileOut
         * @description Authenticated account profile returned by GET and PATCH /me.
         */
        UserProfileOut: {
            /** Calendar Time Zone */
            calendar_time_zone: string;
            /**
             * Default Library Id
             * Format: uuid
             */
            default_library_id: string;
            /** Display Name */
            display_name: string | null;
            /** Email */
            email: string | null;
            /** Email Ingest Address */
            email_ingest_address: string | null;
            /**
             * User Id
             * Format: uuid
             */
            user_id: string;
        };
        /**
         * UserSearchOut
         * @description One person found by people search; `email` only when the query was it exactly.
         */
        UserSearchOut: {
            /** Display Name */
            display_name: string | null;
            /** Email */
            email: string | null;
            /**
             * User Id
             * Format: uuid
             */
            user_id: string;
        };
        /** UserShareOut */
        UserShareOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "User";
            user: components["schemas"]["ShareUserOut"];
        };
        /** ValidationError */
        ValidationError: {
            /** Context */
            ctx?: Record<string, never>;
            /** Input */
            input?: unknown;
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
        };
        /** VideoCandidate */
        VideoCandidate: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Description */
            description: string | null;
            /** Image */
            image: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Video";
            kind_facts: components["schemas"]["VideoFacts"];
            /** Published At */
            published_at: string | null;
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default YouTube
             * @constant
             */
            source: "YouTube";
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** VideoFacts */
        VideoFacts: {
            /** Channel Title */
            channel_title: string | null;
            /** Video Ref */
            video_ref: string | null;
        };
        /** VideoPreview */
        VideoPreview: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Description */
            description: string | null;
            /** Image */
            image: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Video";
            kind_facts: components["schemas"]["VideoPreviewFacts"];
            /** Published At */
            published_at: string | null;
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default YouTube
             * @constant
             */
            source: "YouTube";
            /** Source Href */
            source_href: string;
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** VideoPreviewFacts */
        VideoPreviewFacts: {
            /** Channel Title */
            channel_title: string | null;
            /** Embed Href */
            embed_href: string;
            /** Video Ref */
            video_ref: string;
        };
        /**
         * ViewerInvitationOut
         * @description A pending invitation addressed to the viewer, with who sent it.
         */
        ViewerInvitationOut: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Inviter Display Name */
            inviter_display_name: string | null;
            /** Inviter Email */
            inviter_email: string | null;
            /**
             * Library Id
             * Format: uuid
             */
            library_id: string;
            /** Library Name */
            library_name: string;
            /**
             * Role
             * @enum {string}
             */
            role: "admin" | "member";
        };
        /** ViewingActivityBatchIn */
        ViewingActivityBatchIn: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            modality: "Viewing";
            /** Spans */
            spans: components["schemas"]["ViewingActivitySpanIn"][];
        };
        /** ViewingActivitySpanIn */
        ViewingActivitySpanIn: {
            /**
             * Capture Key
             * Format: uuid
             */
            capture_key: string;
            /** Duration Ms */
            duration_ms: number;
            /**
             * Occurred At
             * Format: date-time
             */
            occurred_at: string;
        };
        /** WebArticleCandidate */
        WebArticleCandidate: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Description */
            description: string | null;
            /** Image */
            image: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "WebArticle";
            kind_facts: components["schemas"]["WebArticleFacts"];
            /** Published At */
            published_at: string | null;
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default Brave
             * @constant
             */
            source: "Brave";
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** WebArticleFacts */
        WebArticleFacts: {
            /** Site Name */
            site_name: string | null;
        };
        /** WebArticlePreview */
        WebArticlePreview: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /** Description */
            description: string | null;
            /** Image */
            image: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "WebArticle";
            kind_facts: components["schemas"]["WebArticlePreviewFacts"];
            /** Published At */
            published_at: string | null;
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default Brave
             * @constant
             */
            source: "Brave";
            /** Source Href */
            source_href: string;
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** WebArticlePreviewFacts */
        WebArticlePreviewFacts: {
            /** Canonical Url */
            canonical_url: string;
            /** Site Name */
            site_name: string | null;
        };
        /** WebReaderResumeState */
        WebReaderResumeState: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "web";
            locations: components["schemas"]["ReaderTextLocations"];
            target: components["schemas"]["ReaderFragmentTarget"];
            text: components["schemas"]["ReaderQuoteContext"];
        };
        /** WebTextOffsetsLocator */
        WebTextOffsetsLocator: {
            /** End Offset */
            end_offset: number;
            /** Fragment Id */
            fragment_id: string;
            /** Media Id */
            media_id: string;
            /** Media Kind */
            media_kind?: string | null;
            /** Start Offset */
            start_offset: number;
            text_quote_selector?: components["schemas"]["TextQuoteSelector"] | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "web_text_offsets";
        };
        /** WholeSourceLocationOut */
        WholeSourceLocationOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource";
        };
        /** WorkspaceContributorLocator */
        WorkspaceContributorLocator: {
            /** Handle */
            handle: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "contributor_handle";
        };
        /** WorkspaceDailyLocator */
        WorkspaceDailyLocator: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "daily_date";
            /**
             * Local Date
             * Format: date
             */
            local_date: string;
        };
        /** WorkspacePane */
        "WorkspacePane-Input": {
            current_visit: components["schemas"]["PaneVisit"];
            history: components["schemas"]["PaneHistory"];
            /** Id */
            id: string;
            /** Primary Width Px */
            primary_width_px: number | null;
            secondary: components["schemas"]["WorkspaceSecondaryPane"] | null;
            /**
             * Visibility
             * @enum {string}
             */
            visibility: "visible" | "minimized";
        };
        /** WorkspacePane */
        "WorkspacePane-Output": {
            current_visit: components["schemas"]["PaneVisit"];
            history: components["schemas"]["PaneHistory"];
            /** Id */
            id: string;
            /** Primary Width Px */
            primary_width_px: number | null;
            secondary: components["schemas"]["WorkspaceSecondaryPane"] | null;
            /**
             * Visibility
             * @enum {string}
             */
            visibility: "visible" | "minimized";
        };
        /** WorkspacePresentationItemOut */
        WorkspacePresentationItemOut: {
            /** Locator */
            locator: components["schemas"]["WorkspaceResourceLocator"] | components["schemas"]["WorkspaceContributorLocator"] | components["schemas"]["WorkspaceDailyLocator"];
            presentation: components["schemas"]["WorkspacePresentationOut"] | null;
        };
        /** WorkspacePresentationOut */
        WorkspacePresentationOut: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            media_kind: components["schemas"]["MediaKind"] | null;
            /** Resource Ref */
            resource_ref: string | null;
            /** Source Label */
            source_label: string | null;
            /** Text Version */
            text_version: number | null;
            /** Title */
            title: string;
        };
        /** WorkspacePresentationsOut */
        WorkspacePresentationsOut: {
            /** Items */
            items: components["schemas"]["WorkspacePresentationItemOut"][];
        };
        /** WorkspacePresentationsRequest */
        WorkspacePresentationsRequest: {
            /** Locators */
            locators: (components["schemas"]["WorkspaceResourceLocator"] | components["schemas"]["WorkspaceContributorLocator"] | components["schemas"]["WorkspaceDailyLocator"])[];
        };
        /** WorkspaceResourceLocator */
        WorkspaceResourceLocator: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource_ref";
            /** Ref */
            ref: string;
        };
        /** WorkspaceSecondaryPane */
        WorkspaceSecondaryPane: {
            /**
             * Active Surface Id
             * @enum {string}
             */
            active_surface_id: "resource-contents" | "resource-members" | "resource-connections" | "resource-forks" | "resource-dossier" | "import-detail";
            /**
             * Group Id
             * @enum {string}
             */
            group_id: "resource-inspector" | "imports-inspector";
            /** Id */
            id: string;
            /**
             * Visibility
             * @enum {string}
             */
            visibility: "visible" | "collapsed";
            /** Width Px */
            width_px: number;
        };
        /**
         * WorkspaceSessionsOut
         * @description This device's session and the newest one saved by another device.
         */
        WorkspaceSessionsOut: {
            most_recent_elsewhere: components["schemas"]["WorkspaceState-Output"] | null;
            own: components["schemas"]["WorkspaceState-Output"] | null;
        };
        /**
         * WorkspaceState
         * @description One device's panes, in strip order, and the active one.
         */
        "WorkspaceState-Input": {
            /** Active Primary Pane Id */
            active_primary_pane_id: string;
            /** Panes */
            panes: components["schemas"]["WorkspacePane-Input"][];
        };
        /**
         * WorkspaceState
         * @description One device's panes, in strip order, and the active one.
         */
        "WorkspaceState-Output": {
            /** Active Primary Pane Id */
            active_primary_pane_id: string;
            /** Panes */
            panes: components["schemas"]["WorkspacePane-Output"][];
        };
        /** WritingAck */
        WritingAck: {
            /** Deleted Refs */
            deleted_refs: string[];
            /** Highlights */
            highlights: components["schemas"]["WritingHighlight"][];
            /** Identities */
            identities: components["schemas"]["WritingIdentity"][];
            /** Insertions */
            insertions: components["schemas"]["WritingInsertion"][];
            /** Lanes */
            lanes: components["schemas"]["WritingLaneVersion"][];
            /** Links */
            links: components["schemas"]["WritingLink"][];
            /** Notes */
            notes: components["schemas"]["WritingNote"][];
            /** Pages */
            pages: components["schemas"]["WritingPage"][];
            /** Placements */
            placements: components["schemas"]["WritingPlacement"][];
            /** Removed Link Ids */
            removed_link_ids: string[];
        };
        /** WritingHighlight */
        WritingHighlight: {
            /** Anchor */
            anchor: components["schemas"]["FragmentAnchorOut"] | components["schemas"]["PdfAnchorOut"];
            /**
             * Author User Id
             * Format: uuid
             */
            author_user_id: string;
            /**
             * Color
             * @enum {string}
             */
            color: "yellow" | "green" | "blue" | "pink" | "purple";
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Exact */
            exact: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Prefix */
            prefix: string;
            /** Suffix */
            suffix: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /** Version */
            version: string;
        };
        /** WritingIdentity */
        WritingIdentity: {
            /**
             * Canonical Id
             * Format: uuid
             */
            canonical_id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "page" | "note_block" | "highlight" | "link";
            /**
             * Requested Id
             * Format: uuid
             */
            requested_id: string;
            /**
             * State
             * @enum {string}
             */
            state: "live" | "deleted";
        };
        /** WritingInsertion */
        WritingInsertion: {
            /**
             * Canonical Link Id
             * Format: uuid
             */
            canonical_link_id: string;
            /** Created */
            created: boolean;
            /**
             * Requested Link Id
             * Format: uuid
             */
            requested_link_id: string;
            /** Source Ref */
            source_ref: string;
        };
        /** WritingLaneVersion */
        WritingLaneVersion: {
            /** Before Version */
            before_version: number | null;
            /** Checked From Version */
            checked_from_version: number | null;
            /**
             * Lane
             * @enum {string}
             */
            lane: "body" | "title" | "links" | "annotations" | "context";
            /** Ref */
            ref: string;
            /** Version */
            version: number;
        };
        /** WritingLink */
        WritingLink: {
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            /** Origin */
            origin: string;
            /** Source Ref */
            source_ref: string;
            /** Target Ref */
            target_ref: string;
        };
        /** WritingNote */
        WritingNote: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Body Text */
            body_text: string;
            /** Body Version */
            body_version: number;
            /**
             * Id
             * Format: uuid
             */
            id: string;
        };
        /** WritingPage */
        WritingPage: {
            /** Daily Date */
            daily_date: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Title */
            title: string;
            /** Title Version */
            title_version: number;
        };
        /** WritingPlacement */
        WritingPlacement: {
            /** After Link Id */
            after_link_id: string | null;
            /** Endpoint */
            endpoint: string;
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
        };
        /** WritingState */
        WritingState: {
            /** Revision */
            revision: number;
        };
        /** XArticleBinding */
        XArticleBinding: {
            /** Article Id */
            article_id: string;
            native_target: components["schemas"]["XArticleNativeTarget"] | null;
        };
        /** @enum {string} */
        XArticleCompleteness: "unknown" | "incomplete";
        /**
         * XArticleContent
         * @description Facts attached to the saved body; pending or failed attempts do not replace them.
         */
        XArticleContent: {
            completeness: components["schemas"]["XArticleCompleteness"];
            /**
             * Representation
             * @enum {string}
             */
            representation: "api_text" | "browser_capture";
        };
        /** XArticleNativeTarget */
        XArticleNativeTarget: {
            /** Expected Reader Generation */
            expected_reader_generation: number | null;
            /**
             * Expected Source Attempt Id
             * Format: uuid
             */
            expected_source_attempt_id: string;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
        };
        /**
         * XReaderResumeState
         * @description A displayed occurrence of one canonical X post, inside its reading publication.
         */
        XReaderResumeState: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "x";
            locations: components["schemas"]["ReaderTextLocations"];
            /** Occurrence Id */
            occurrence_id: string;
            /**
             * Post Media Id
             * Format: uuid
             */
            post_media_id: string;
            /** Source Revision Id */
            source_revision_id: string;
            text: components["schemas"]["ReaderQuoteContext"];
        };
        /** XSourceAuthor */
        XSourceAuthor: {
            /** Id */
            id: string;
            /** Name */
            name: string;
            /** Username */
            username: string;
        };
        /** XSourceContext */
        XSourceContext: {
            /** Limits */
            limits: ("post_limit" | "operation_limit")[];
            /** Primary Post Count */
            primary_post_count: number;
            /**
             * Published At
             * Format: date-time
             */
            published_at: string;
            /** Root Revision Id */
            root_revision_id: string | null;
            /**
             * Scope
             * @enum {string}
             */
            scope: "author_thread" | "post";
            /** Search Exhausted */
            search_exhausted: boolean | null;
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
            /** Unavailable Context Count */
            unavailable_context_count: number;
            /** Uncaptured Context Count */
            uncaptured_context_count: number;
            /** Unchecked Post Count */
            unchecked_post_count: number;
            /** Unresolved Parent Count */
            unresolved_parent_count: number;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    cancel_dossier_build_artifact_builds__artifact_build_id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                artifact_build_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    learn_dossier_artifacts_dossiers_learn_post: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LearnDossierRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_Annotated_Union_LearnDossierOpenedOut__LearnDossierBuildAcceptedOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_dossier_artifacts_dossiers__subject_scheme___subject_handle__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                subject_scheme: string;
                subject_handle: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_DossierHeadOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_dossier_build_artifacts_dossiers__subject_scheme___subject_handle__builds_post: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                subject_scheme: string;
                subject_handle: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DossierGenerateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_DossierBuildCreatedOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_dossier_by_ref_artifacts__artifact_ref__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                artifact_ref: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_DossierHeadOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    regenerate_dossier_artifacts__artifact_ref__builds_post: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path: {
                artifact_ref: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DossierGenerateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_DossierBuildCreatedOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_assistant_writes_assistant_writes_get: {
        parameters: {
            query?: {
                generation_id?: string | null;
                before?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_AssistantWritePage_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    undo_assistant_write_assistant_writes__tool_call_id__undo_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                tool_call_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_atlas_atlas_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_AtlasOut_"];
                };
            };
        };
    };
    create_session_auth_extension_sessions_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ExtensionTokenOut_"];
                };
            };
        };
    };
    read_session_auth_extension_sessions_current_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ExtensionSessionOut_"];
                };
            };
        };
    };
    revoke_session_auth_extension_sessions_current_delete: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    create_auth_handoff_code_route_auth_handoff_codes_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MintHandoffCodeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    consume_auth_handoff_code_route_auth_handoff_codes_consume_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConsumeHandoffCodeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    browse_content_browse_get: {
        parameters: {
            query: {
                q: string;
                kind: components["schemas"]["BrowseKind"];
                source: components["schemas"]["BrowseSource"];
                limit: number;
                sort?: components["schemas"]["BrowseSort"] | null;
                cursor?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_BrowsePage_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    browse_preview_browse_preview_get: {
        parameters: {
            query: {
                target: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_BrowsePreview_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_reader_selection_preview_chat_reader_selections_highlights__highlight_id__get: {
        parameters: {
            query: {
                /** @description The key's parent media id */
                media_id: string;
            };
            header?: never;
            path: {
                highlight_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ReaderSelectionPreview_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_chat_run_chat_runs_post: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string | null;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChatRunCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ChatAdmissionReceipt_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_chat_run_chat_runs__run_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ChatRunResponse_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    cancel_chat_run_chat_runs__run_id__cancel_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ChatRunResponse_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_scan_connection_discovery_scans_get: {
        parameters: {
            query: {
                ref: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ConnectionDiscoveryScanOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    request_scan_connection_discovery_scans_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionDiscoveryScanRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ConnectionDiscoveryScanOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_activity_consumption_activity_post: {
        parameters: {
            query?: never;
            header: {
                "X-Nexus-Device": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ActivityRecordIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    exclude_session_consumption_exclusions__exclusion_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                exclusion_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExcludeSessionIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    restore_session_consumption_exclusions__exclusion_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                exclusion_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_sessions_consumption_sessions_get: {
        parameters: {
            query: {
                cursor?: string | null;
                limit?: number;
                end: string;
                time_zone: string;
                start?: string | null;
                modality?: ("Reading" | "Listening" | "Viewing") | null;
                media_id?: string | null;
                contributor_handle?: string | null;
                device_id?: string | null;
            };
            header: {
                "X-Nexus-Device": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ActivitySessionPageOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_stats_consumption_stats_get: {
        parameters: {
            query: {
                bucket: "Hour" | "Day" | "Month" | "Year";
                end: string;
                time_zone: string;
                start?: string | null;
                modality?: ("Reading" | "Listening" | "Viewing") | null;
                media_id?: string | null;
                contributor_handle?: string | null;
                device_id?: string | null;
            };
            header: {
                "X-Nexus-Device": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ConsumptionStatsOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_contributors_contributors_get: {
        parameters: {
            query: {
                q: string;
                cursor?: string | null;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ContributorSearchPageOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_contributor_contributors__contributor_handle__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                contributor_handle: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ContributorDetailOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_contributor_works_contributors__contributor_handle__works_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                contributor_handle: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CollectionPage_Annotated_Union_MediaContributorWorkItemOut__PodcastContributorWorkItemOut__ExternalContributorWorkItemOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind_____"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_conversations_conversations_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CollectionPage_ConversationListItemOut__"];
                };
            };
        };
    };
    create_conversation_conversations_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateConversationRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ConversationOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_conversation_conversations__conversation_id__delete: {
        parameters: {
            query: {
                expected_revision: number;
            };
            header?: never;
            path: {
                conversation_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_context_conversations__conversation_id__context_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ContextOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    detach_context_conversations__conversation_id__context__target_ref__delete: {
        parameters: {
            query: {
                expected_context_version: number;
            };
            header?: never;
            path: {
                conversation_id: string;
                target_ref: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_conversation_tree_conversations__conversation_id__tree_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ConversationTreeOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    capture_target_extension_capture_target_get: {
        parameters: {
            query: {
                source_url: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CaptureTargetOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_capture_extension_captures_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateCaptureRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_Annotated_Union_UploadRequired__Published__Rejected___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_capture_extension_captures__session_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    confirm_capture_extension_captures__session_id__confirm_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfirmUploadRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_Published_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_library_destinations_extension_library_destinations_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_list_LibraryDestinationOut__"];
                };
            };
        };
    };
    get_highlight_highlights__highlight_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                highlight_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_TypedHighlightOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_highlight_highlights__highlight_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                highlight_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WritingAck_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    update_highlight_highlights__highlight_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                highlight_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateHighlightRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WritingAck_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    put_highlight_note_highlights__highlight_id__note_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                highlight_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetHighlightNoteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WritingAck_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_highlight_note_highlights__highlight_id__note_delete_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                highlight_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeleteHighlightNoteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WritingAck_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    detach_highlight_note_highlights__highlight_id__note__note_id__delete: {
        parameters: {
            query: {
                link_id: string;
            };
            header?: never;
            path: {
                highlight_id: string;
                note_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WritingAck_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_imports_imports_get: {
        parameters: {
            query: {
                view: "NeedsAttention" | "InProgress" | "History";
                q?: string | null;
                media_kind?: components["schemas"]["MediaKind"] | null;
                stage?: ("Upload" | "Validate" | "Extract" | "Finalize" | "SourceProcessing" | "Index" | "Metadata") | null;
                failure_code?: components["schemas"]["ImportFailureCode"] | null;
                state?: ("Active" | "NeedsAttention" | "Complete") | null;
                had_failures?: boolean | null;
                from?: string | null;
                before?: string | null;
                cursor?: string | null;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ImportPage_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_import_summary_imports_summary_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ImportSummary_"];
                };
            };
        };
    };
    get_import_imports__ref__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ref: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ImportDetail_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_import_history_imports__ref__history_get: {
        parameters: {
            query?: {
                cursor?: string | null;
                limit?: number;
            };
            header?: never;
            path: {
                ref: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_HistoryPage_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_email_ingest_ingest_email_post: {
        parameters: {
            query?: never;
            header?: {
                "x-nexus-email-signature"?: string | null;
                "x-nexus-email-recipient"?: string | null;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_lectern_lectern_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LecternOut_"];
                };
            };
        };
    };
    place_on_lectern_lectern_items__media_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlaceIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LecternWriteOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_from_lectern_lectern_items__media_id__delete: {
        parameters: {
            query: {
                expected_order_revision: components["schemas"]["OrderRevision"];
            };
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LecternWriteOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    move_on_lectern_lectern_items__media_id__position_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MoveLecternItemRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LecternOrderOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_quick_reads_lectern_quick_reads_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_QuickReadsOut_"];
                };
            };
        };
    };
    get_lectern_suggestions_lectern_suggestions_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_SuggestionsOut_"];
                };
            };
        };
    };
    refresh_lectern_suggestions_lectern_suggestions_refresh_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SuggestionEnsureFreshIn"] | components["schemas"]["SuggestionExplicitRefreshIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_SuggestionStateOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reconcile_lectern_suggestions_lectern_suggestions_view_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SuggestionViewIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_SuggestionViewOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_libraries_libraries_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CollectionPage_LibraryOut__"];
                };
            };
        };
    };
    create_library_libraries_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateLibraryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LibraryOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_destinations_libraries_destinations_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_list_LibraryDestinationOut__"];
                };
            };
        };
    };
    list_viewer_invitations_libraries_invites_get: {
        parameters: {
            query?: {
                cursor?: string | null;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CollectionPage_ViewerInvitationOut__"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    revoke_invitation_libraries_invites__invitation_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitation_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    accept_invitation_libraries_invites__invitation_id__accept_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitation_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    decline_invitation_libraries_invites__invitation_id__decline_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitation_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_placements_libraries_placements__ref__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                ref: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_list_LibraryPlacementOut__"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_library_libraries__library_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LibraryOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_library_libraries__library_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    rename_library_libraries__library_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RenameLibraryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LibraryOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_entries_libraries__library_id__entries_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LibraryEntriesPageOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    move_entry_libraries__library_id__entries__entry_id__position_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
                entry_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MoveEntryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LibraryOrderOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_invitations_libraries__library_id__invites_get: {
        parameters: {
            query?: {
                cursor?: string | null;
                limit?: number;
            };
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CollectionPage_LibraryInvitationOut__"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_invitation_libraries__library_id__invites_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateInvitationRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LibraryInvitationOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    place_item_libraries__library_id__items__ref__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
                ref: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlaceItemRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    unplace_item_libraries__library_id__items__ref__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
                ref: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_members_libraries__library_id__members_get: {
        parameters: {
            query?: {
                cursor?: string | null;
                limit?: number;
            };
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CollectionPage_LibraryMemberOut__"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_member_libraries__library_id__members__user_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_member_role_libraries__library_id__members__user_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetMemberRoleRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    leave_library_libraries__library_id__membership_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_library_order_libraries__library_id__order_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LibraryOrderOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_suggestions_libraries__library_id__suggestions_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_SuggestionsOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    refresh_library_suggestions_libraries__library_id__suggestions_refresh_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SuggestionEnsureFreshIn"] | components["schemas"]["SuggestionExplicitRefreshIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_SuggestionStateOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reconcile_library_suggestions_libraries__library_id__suggestions_view_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SuggestionViewIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_SuggestionViewOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    transfer_ownership_libraries__library_id__transfer_ownership_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TransferOwnershipRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_liveness_livez_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    get_llm_catalog_llm_catalog_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_GenerationCatalog_"];
                };
            };
        };
    };
    get_me_me_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_UserProfileOut_"];
                };
            };
        };
    };
    patch_me_me_patch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateProfileRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_UserProfileOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_nexus_history_me_nexus_history_get: {
        parameters: {
            query?: {
                query?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_NexusHistoryOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_nexus_selection_me_nexus_selections_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["NexusSelectionRecordRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_NexusSelectionRecordOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_reader_profile_me_reader_profile_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ReaderProfileOut_"];
                };
            };
        };
    };
    patch_reader_profile_me_reader_profile_patch: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReaderProfilePatch"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ReaderProfileOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    post_workspace_presentations_me_workspace_presentations_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspacePresentationsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WorkspacePresentationsOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_workspace_session_me_workspace_session_get: {
        parameters: {
            query?: never;
            header: {
                "X-Nexus-Device": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WorkspaceSessionsOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    put_workspace_session_me_workspace_session_put: {
        parameters: {
            query?: never;
            header: {
                "X-Nexus-Device": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceState-Input"];
            };
        };
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_from_url_media_from_url_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FromUrlRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_FromUrlOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_proxied_image_media_image_get: {
        parameters: {
            query: {
                url: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_source_attempt_media_source_attempts__source_attempt_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                source_attempt_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_SourceAttemptOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    resolve_media_summaries_media_summaries_resolve_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResolveMediaSummariesIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ResolvedMediaSummariesOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    forecast_podcast_transcripts_media_transcript_forecasts_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PodcastEpisodeQueryTranscriptTarget"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastEpisodeQueryTranscriptForecastOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    request_podcast_transcript_batch_media_transcript_request_batch_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PodcastEpisodeQueryTranscriptRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastEpisodeQueryTranscriptRequestOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_upload_media_uploads_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateUploadRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_Annotated_Union_UploadRequired__Published__Rejected___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_upload_media_uploads__session_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    confirm_upload_media_uploads__session_id__confirm_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfirmUploadRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_Published_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_media_media__media_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_MediaOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    remove_media_media__media_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_epub_asset_media__media_id__assets__asset_key__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
                asset_key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    put_media_authors_media__media_id__authors_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ManualMediaAuthorsRequest"] | components["schemas"]["AutomaticMediaAuthorsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_MediaAuthorsOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_reader_document_map_media__media_id__document_map_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ReaderDocumentMapOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_media_file_media__media_id__file_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_MediaFileOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    finish_media__media_id__finish_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FinishIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_Finish_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    undo_finish_media__media_id__finish_undo_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Finish"];
            };
        };
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    ensure_highlight_media__media_id__highlights_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EnsureMediaHighlightRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WritingAck_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    put_listening_state_media__media_id__listening_state_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ListeningIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ListeningPositionOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    enrich_media_metadata_media__media_id__metadata_enrichment_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MetadataEnrichmentRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_MetadataEnrichmentAccepted_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    review_media_metadata_result_media__media_id__metadata_enrichment__job_id__review_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
                job_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    settle_natural_end_media__media_id__natural_end_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["NaturalEndIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_player_media__media_id__player_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PlayerDescriptor_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    install_preview_position_media__media_id__preview_position_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PreviewPositionIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    reset_progress_media__media_id__progress_reset_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_reader_document_media__media_id__reader_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_Annotated_Union_ReaderTextDocumentOut__ReaderPdfDocumentOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_reader_apparatus_detail_media__media_id__reader_apparatus__item_id__get: {
        parameters: {
            query: {
                expected_identity: string;
            };
            header?: never;
            path: {
                media_id: string;
                item_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ReaderApparatusDetailOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_reader_state_media__media_id__reader_state_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_Union_ReaderCursorEmpty__ReaderCursorPositioned__ReaderCursorUnresolved__"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    put_reader_state_media__media_id__reader_state_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CursorWrite"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_Union_ReaderCursorEmpty__ReaderCursorPositioned__ReaderCursorUnresolved__"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_reading_copy_media__media_id__reading_copy_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ReadingCopyOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    refresh_source_media__media_id__refresh_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RefreshSourceRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_SourceAdmission_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    repair_media_media__media_id__repair_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SourceRepairRequest"] | components["schemas"]["SearchRepairRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_Annotated_Union_SourceRepairAdmission__SearchRepairAdmission___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    retry_source_media__media_id__retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RetrySourceRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_SourceAdmission_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    request_media_transcript_media__media_id__transcript_request_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["TranscriptRequestRequest"] | null;
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_TranscriptRequestOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    mark_unread_media__media_id__unread_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    regenerate_assistant_message_messages__assistant_message_id__regenerate_post: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string | null;
            };
            path: {
                assistant_message_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChatRunRepeatRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ChatAdmissionReceipt_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    rerun_assistant_message_messages__assistant_message_id__rerun_post: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string | null;
            };
            path: {
                assistant_message_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChatRunRepeatRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ChatAdmissionReceipt_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_message_messages__message_id__delete: {
        parameters: {
            query: {
                conversation_id: string;
                expected_revision: number;
            };
            header?: never;
            path: {
                message_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_MessageDeleteOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    rename_fork_messages__message_id__fork_title_patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                message_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ForkTitleRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ForkTitleOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_note_notes_blocks__note_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                note_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_NoteBlockOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_daily_page_notes_daily__local_date__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                local_date: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_DailyPageOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    capture_notes_daily__local_date__captures_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                local_date: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DailyCaptureRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WritingAck_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_pages_notes_pages_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CollectionPage_NotePageSummaryOut__"];
                };
            };
        };
    };
    create_page_notes_pages_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreatePageRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WritingAck_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_page_notes_pages__page_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                page_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WritingAck_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_oracle_readings_oracle_readings_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_list_OracleReadingSummaryOut__"];
                };
            };
        };
    };
    create_oracle_reading_oracle_readings_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OracleReadingCreateRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_OracleReadingCreatedOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_oracle_reading_oracle_readings__reading_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                reading_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_OracleReadingOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_oracle_concordance_oracle_readings__reading_id__concordance_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                reading_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_list_OracleConcordanceOut__"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    acquire_podcast_episode_podcast_episodes_from_discovery_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PodcastEpisodeFromDiscoveryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastEpisodeFromDiscoveryOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    refresh_podcasts_podcasts_refresh_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PodcastRefreshPodcastScope"] | components["schemas"]["PodcastRefreshPodcastsScope"] | components["schemas"]["PodcastRefreshLibraryScope"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastRefreshAcceptedOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_subscriptions_podcasts_subscriptions_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CollectionPage_PodcastSubscriptionListItemOut__"];
                };
            };
        };
    };
    subscribe_to_podcast_podcasts_subscriptions_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PodcastSubscribeRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastSubscribeOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_subscription_status_podcasts_subscriptions__podcast_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                podcast_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastSubscriptionStatusOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    unsubscribe_from_podcast_podcasts_subscriptions__podcast_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                podcast_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastUnsubscribeOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    retry_subscription_backfill_podcasts_subscriptions__podcast_id__backfill_retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                podcast_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PodcastBackfillRetryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastBackfillRetryOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    patch_subscription_settings_podcasts_subscriptions__podcast_id__settings_patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                podcast_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PodcastSubscriptionSettingsPatchRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastSubscriptionStatusOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_podcast_detail_podcasts__podcast_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                podcast_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastDetailOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    list_podcast_episodes_podcasts__podcast_id__episodes_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                podcast_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CollectionPage_PodcastEpisodeListItemOut__"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    set_podcast_episode_consumption_podcasts__podcast_id__episodes_consumption_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                podcast_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PodcastEpisodeConsumptionRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastEpisodeConsumptionOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    prepare_podcast_episode_consumption_podcasts__podcast_id__episodes_consumption_prepare_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                podcast_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PodcastEpisodeSelection"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PodcastEpisodeConsumptionPreparedOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_public_resource_share_public_resource_share_get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Share-Token"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_PublicShareOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_public_resource_share_asset_public_resource_share_assets__ordinal__get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Share-Token"?: string;
            };
            path: {
                ordinal: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_public_resource_share_document_public_resource_share_document_get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Share-Token"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_Annotated_Union_ReaderTextDocumentOut__ReaderPdfDocumentOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_public_resource_share_file_public_resource_share_file_get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Share-Token"?: string;
                Range?: string | null;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_readiness_readyz_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    commands_resource_graph_commands_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OutlineCommandsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_WritingAck_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    query_connections_resource_graph_connections_query_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConnectionQueryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ConnectionPageOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    read_outline_resource_graph_outline__ref__get: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string | null;
            };
            header?: never;
            path: {
                ref: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_OutlineOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    query_versions_resource_graph_versions_query_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResourceVersionsRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ResourceVersionsOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    resolve_source_target_resource_items_source_targets_resolve_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResolveSourceTargetRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_SourceTargetOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_resource_targets_resource_items_targets_search_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResourceTargetSearchRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ResourceTargetSearchResponse_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_resource_item_resource_items__resource_ref__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                resource_ref: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ResourceItemOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_resource_actions_resource_items__resource_ref__actions_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                resource_ref: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ResourceActionsOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_resource_shares_resource_items__resource_ref__shares_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                resource_ref: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ResourceShareSnapshotOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_resource_share_resource_items__resource_ref__shares_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                resource_ref: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateResourceShareRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CreateResourceShareOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    delete_resource_share_resource_shares__grant_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                grant_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_search_get: {
        parameters: {
            query?: {
                view?: "resources" | "passages";
                cursor?: string | null;
                limit?: number;
                /** @description Search query string */
                q?: string;
                /** @description all, media:<id>, library:<id> or conversation:<id> */
                scope?: string;
                /** @description Comma-separated kinds; omitted means all, empty means none */
                kinds?: string | null;
                /** @description Comma-separated document formats */
                formats?: string | null;
                /** @description Comma-separated contributor handles */
                authors?: string | null;
                /** @description Comma-separated contributor credit roles */
                roles?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SearchResourcesResponse"] | components["schemas"]["SearchPassagesResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_preview_search_preview_get: {
        parameters: {
            query: {
                phase: "direct" | "content";
                /** @description Search query string */
                q?: string;
                /** @description all, media:<id>, library:<id> or conversation:<id> */
                scope?: string;
                /** @description Comma-separated kinds; omitted means all, empty means none */
                kinds?: string | null;
                /** @description Comma-separated document formats */
                formats?: string | null;
                /** @description Comma-separated contributor handles */
                authors?: string | null;
                /** @description Comma-separated contributor credit roles */
                roles?: string | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SearchPreviewResponse"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stream_artifact_build_events_stream_artifact_builds__artifact_build_id__events_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                artifact_build_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stream_chat_run_events_stream_chat_runs__run_id__events_get: {
        parameters: {
            query?: {
                after?: number;
            };
            header?: never;
            path: {
                run_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stream_lectern_suggestions_stream_lectern_suggestions_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    stream_library_suggestions_stream_libraries__library_id__suggestions_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stream_media_events_stream_media__media_id__events_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stream_metadata_events_stream_media__media_id__metadata_events_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stream_oracle_reading_events_stream_oracle_readings__reading_id__events_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                reading_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stream_podcast_subscription_events_stream_podcast_subscriptions__podcast_id__events_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                podcast_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    stream_writing_stream_writing_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": unknown;
                };
            };
        };
    };
    post_client_defect_telemetry_client_defects_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ClientDefectRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search_users_users_search_get: {
        parameters: {
            query: {
                q: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_list_UserSearchOut__"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    get_version_version_get: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
}
