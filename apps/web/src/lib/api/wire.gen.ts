// GENERATED from the FastAPI wire schema by scripts/gen-wire.mjs; do not edit.
// Regenerate: cd apps/web && bun run gen:wire

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
    "/atlas": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read Atlas
         * @description return the scoped atlas; its tag identifies the exact rendered representation.
         */
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
        /** Create Extension Session Route */
        post: operations["create_extension_session_route_auth_extension_sessions_post"];
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
         * Read Current Extension Session Route
         * @description The account behind the bearer and the byte limits its captures must respect.
         */
        get: operations["read_current_extension_session_route_auth_extension_sessions_current_get"];
        put?: never;
        post?: never;
        /** Revoke Current Extension Session Route */
        delete: operations["revoke_current_extension_session_route_auth_extension_sessions_current_delete"];
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
        /** List Chat Runs */
        get: operations["list_chat_runs_chat_runs_get"];
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
    "/consumption/activity-exclusions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Post Activity Exclusion */
        post: operations["post_activity_exclusion_consumption_activity_exclusions_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/consumption/commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Post Consumption Command */
        post: operations["post_consumption_command_consumption_commands_post"];
        delete?: never;
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
         * @description List conversations.
         *
         *     An explicit ``has_context_ref`` selects the retained resource-graph mode
         *     with its manual ``{data, page}`` envelope. Every other request is the finite
         *     index, with optional literal ``title_search``.
         *
         *     Errors:
         *         E_INVALID_REQUEST (400): a view state outside the advertised inventory,
         *             a malformed has_context_ref URI, or title search over its length bound.
         *         E_INVALID_CURSOR (400): the cursor is malformed or unparseable.
         */
        get: operations["list_conversations_conversations_get"];
        put?: never;
        /**
         * Create Conversation
         * @description Create an empty private conversation, with its initial context refs.
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
        /** Get Conversation */
        get: operations["get_conversation_conversations__conversation_id__get"];
        put?: never;
        post?: never;
        /**
         * Delete Conversation
         * @description Delete a conversation and every row it owns; return the index revision.
         */
        delete: operations["delete_conversation_conversations__conversation_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversation_id}/active-path": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Set Conversation Active Path */
        post: operations["set_conversation_active_path_conversations__conversation_id__active_path_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversation_id}/context-refs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Context Refs
         * @description List a conversation's context refs, hydrated, in first-attached order.
         */
        get: operations["list_context_refs_conversations__conversation_id__context_refs_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversation_id}/context-refs/{edge_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove Context Ref */
        delete: operations["remove_context_ref_conversations__conversation_id__context_refs__edge_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversation_id}/forks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Conversation Forks */
        get: operations["list_conversation_forks_conversations__conversation_id__forks_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{conversation_id}/forks/{branch_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Conversation Fork */
        delete: operations["delete_conversation_fork_conversations__conversation_id__forks__branch_id__delete"];
        options?: never;
        head?: never;
        /** Rename Conversation Fork */
        patch: operations["rename_conversation_fork_conversations__conversation_id__forks__branch_id__patch"];
        trace?: never;
    };
    "/conversations/{conversation_id}/tool-calls/{tool_call_id}/undo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Undo Tool Call
         * @description Revert one assistant write tool call's created refs. Idempotent.
         */
        post: operations["undo_tool_call_conversations__conversation_id__tool_calls__tool_call_id__undo_post"];
        delete?: never;
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
    "/extension/captures/{session_handle}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read Capture */
        get: operations["read_capture_extension_captures__session_handle__get"];
        put?: never;
        post?: never;
        /** Delete Capture */
        delete: operations["delete_capture_extension_captures__session_handle__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/extension/captures/{session_handle}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm Capture */
        post: operations["confirm_capture_extension_captures__session_handle__confirm_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/extension/captures/{session_handle}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry Capture */
        post: operations["retry_capture_extension_captures__session_handle__retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/extension/captures/{session_handle}/transport-failure": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record Capture Transport Failure */
        post: operations["record_capture_transport_failure_extension_captures__session_handle__transport_failure_post"];
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
    "/fragments/{fragment_id}/highlights": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Highlights */
        get: operations["list_highlights_fragments__fragment_id__highlights_get"];
        put?: never;
        /** Create Highlight */
        post: operations["create_highlight_fragments__fragment_id__highlights_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/generation-effects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Recent Generation Effects */
        get: operations["recent_generation_effects_generation_effects_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/generation-effects/{position_id}/undo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Undo Assistant Write */
        post: operations["undo_assistant_write_generation_effects__position_id__undo_post"];
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
        /** Set Highlight Note */
        put: operations["set_highlight_note_highlights__highlight_id__note_put"];
        post?: never;
        /** Delete Highlight Note */
        delete: operations["delete_highlight_note_highlights__highlight_id__note_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/highlights/{highlight_id}/reader-target": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Highlight Reader Target */
        get: operations["get_highlight_reader_target_highlights__highlight_id__reader_target_get"];
        put?: never;
        post?: never;
        delete?: never;
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
         * @description Size, then signature, then recipient, then owner — all before any MIME parse.
         */
        post: operations["post_email_ingest_ingest_email_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/media/{media_id}/offline-reading-token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create Offline Reading Token
         * @description Authorize current visibility/generation before minting one narrow token.
         */
        post: operations["create_offline_reading_token_internal_media__media_id__offline_reading_token_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/offline-reading/account-binding": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Offline Reading Account Binding
         * @description Attest the authenticated viewer; renderer input never supplies identity.
         */
        get: operations["get_offline_reading_account_binding_internal_offline_reading_account_binding_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/stream-tokens": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create Stream Token
         * @description Mint a short-lived stream token for direct browser-to-FastAPI SSE.
         *
         *     The BFF proxies to this endpoint with Supabase bearer + X-Nexus-Internal.
         *     Returns a JWT the browser can use for direct SSE endpoints.
         *
         *     Response:
         *         {
         *             "token": "<jwt>",
         *             "stream_base_url": "https://api.nexus.example.com",
         *             "expires_at": "2026-02-08T21:01:00+00:00"
         *         }
         */
        post: operations["create_stream_token_internal_stream_tokens_post"];
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
    "/lectern/commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Post Lectern Command */
        post: operations["post_lectern_command_lectern_commands_post"];
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
    "/lectern/slate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Lectern Slate */
        get: operations["get_lectern_slate_lectern_slate_get"];
        put?: never;
        post?: never;
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
         * @description List the viewer's libraries in the requested view.
         */
        get: operations["list_libraries_libraries_get"];
        put?: never;
        /**
         * Create Library
         * @description Create a non-default library owned and admin'd by the caller.
         */
        post: operations["create_library_libraries_post"];
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
        /**
         * List Viewer Invites
         * @description List invitations addressed to the current viewer.
         */
        get: operations["list_viewer_invites_libraries_invites_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/invites/{invitation_handle}": {
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
         * Revoke Library Invite
         * @description Revoke a pending invitation. Admin-only; idempotent when already revoked.
         */
        delete: operations["revoke_library_invite_libraries_invites__invitation_handle__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/invites/{invitation_handle}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Accept Library Invite
         * @description Accept a library invitation. Invitee-only; idempotent when already accepted.
         */
        post: operations["accept_library_invite_libraries_invites__invitation_handle__accept_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/invites/{invitation_handle}/decline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Decline Library Invite
         * @description Decline a library invitation. Invitee-only; idempotent when already declined.
         */
        post: operations["decline_library_invite_libraries_invites__invitation_handle__decline_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/writable-destinations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List Writable Library Destinations
         * @description Rank the named libraries the viewer may file into.
         */
        get: operations["list_writable_library_destinations_libraries_writable_destinations_get"];
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
         * @description Read one library. Non-members get a masked 404.
         */
        get: operations["get_library_libraries__library_id__get"];
        put?: never;
        post?: never;
        /**
         * Delete Library
         * @description Delete a library. Owner-only; a non-owner admin gets E_OWNER_REQUIRED.
         */
        delete: operations["delete_library_libraries__library_id__delete"];
        options?: never;
        head?: never;
        /**
         * Rename Library
         * @description Rename a library. Admin-only; not the default or a system library.
         */
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
         * List Library Entries
         * @description List a library's entries under a view lens (see `parse_entries_query`).
         */
        get: operations["list_library_entries_libraries__library_id__entries_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/entries/reorder": {
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
        /**
         * Patch Library Entry Order
         * @description Replace the full entry ordering for a library.
         */
        patch: operations["patch_library_entry_order_libraries__library_id__entries_reorder_patch"];
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
         * List Library Invites
         * @description List a library's invitations, newest first. Admin-only.
         */
        get: operations["list_library_invites_libraries__library_id__invites_get"];
        put?: never;
        /**
         * Create Library Invite
         * @description Invite an existing user to a library. Admin-only.
         */
        post: operations["create_library_invite_libraries__library_id__invites_post"];
        delete?: never;
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
        /**
         * List Library Members
         * @description List a library's members by immutable member identity. Admin-only.
         */
        get: operations["list_library_members_libraries__library_id__members_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/members/{user_handle}": {
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
         * Remove Library Member
         * @description Remove a member. Admin-only; idempotent for an absent target.
         */
        delete: operations["remove_library_member_libraries__library_id__members__user_handle__delete"];
        options?: never;
        head?: never;
        /**
         * Update Library Member Role
         * @description Set a member's role. Admin-only; the owner's role is fixed.
         */
        patch: operations["update_library_member_role_libraries__library_id__members__user_handle__patch"];
        trace?: never;
    };
    "/libraries/{library_id}/podcasts/{podcast_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Add Subscribed Podcast To Library
         * @description Place an existing active podcast subscription in one named library.
         */
        put: operations["add_subscribed_podcast_to_library_libraries__library_id__podcasts__podcast_id__put"];
        post?: never;
        /**
         * Remove Podcast From Library
         * @description Remove a podcast reference from one non-default library.
         */
        delete: operations["remove_podcast_from_library_libraries__library_id__podcasts__podcast_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/libraries/{library_id}/slate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Library Slate
         * @description Read the library's Reading Slate.
         */
        get: operations["get_library_slate_libraries__library_id__slate_get"];
        put?: never;
        post?: never;
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
        /**
         * Transfer Library Ownership
         * @description Transfer ownership to another member. Owner-only.
         */
        post: operations["transfer_library_ownership_libraries__library_id__transfer_ownership_post"];
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
         *     when configured.
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
    "/me/workspace-session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Workspace Session
         * @description Get this device's own workspace session and the most recent one elsewhere.
         */
        get: operations["get_workspace_session_me_workspace_session_get"];
        /**
         * Put Workspace Session
         * @description Upsert this device's workspace session (last-write-wins).
         */
        put: operations["put_workspace_session_me_workspace_session_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Media */
        get: operations["list_media_media_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/from_url": {
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
         * @description Accept a URL source; the service classifies the kind. Clients then poll GET /media/{id}.
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
    "/media/transcript/forecasts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Forecast Podcast Transcripts
         * @description Forecast one server-resolved Podcast episode-query transcript request.
         */
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
        /**
         * Request Podcast Transcript Batch
         * @description Admit one fingerprinted Podcast episode-query transcript request.
         */
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
        /** Create Upload Session */
        post: operations["create_upload_session_media_uploads_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/uploads/{session_handle}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Upload Session */
        delete: operations["delete_upload_session_media_uploads__session_handle__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/uploads/{session_handle}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm Upload Session */
        post: operations["confirm_upload_session_media_uploads__session_handle__confirm_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/uploads/{session_handle}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry Upload Session */
        post: operations["retry_upload_session_media_uploads__session_handle__retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/uploads/{session_handle}/transport-failure": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record Upload Transport Failure */
        post: operations["record_upload_transport_failure_media_uploads__session_handle__transport_failure_post"];
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
         * @description 404 if the media does not exist or the viewer cannot read it.
         */
        get: operations["get_media_media__media_id__get"];
        put?: never;
        post?: never;
        /** Remove Media */
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
         * @description The contributors facade owns its own session, re-check, replay and mutation.
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
    "/media/{media_id}/evidence/{evidence_span_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolve Media Evidence */
        get: operations["resolve_media_evidence_media__media_id__evidence__evidence_span_id__get"];
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
    "/media/{media_id}/fragments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Media Fragments */
        get: operations["get_media_fragments_media__media_id__fragments_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/fragments/{fragment_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Epub Fragment */
        get: operations["get_epub_fragment_media__media_id__fragments__fragment_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/libraries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Media Libraries */
        get: operations["get_media_libraries_media__media_id__libraries_get"];
        put?: never;
        /** Add Media Libraries */
        post: operations["add_media_libraries_media__media_id__libraries_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/libraries/{library_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove Media Library */
        delete: operations["remove_media_library_media__media_id__libraries__library_id__delete"];
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
        /**
         * Get Listening State
         * @description Get per-media listening state for the authenticated viewer.
         */
        get: operations["get_listening_state_media__media_id__listening_state_get"];
        /**
         * Put Listening State
         * @description Record one revision-fenced listening heartbeat (position).
         */
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
        /** Enrich Media Metadata */
        post: operations["enrich_media_metadata_media__media_id__metadata_enrichment_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/navigation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Media Navigation */
        get: operations["get_media_navigation_media__media_id__navigation_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/offline-download-spec": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Offline Download Spec */
        get: operations["get_offline_download_spec_media__media_id__offline_download_spec_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/offline-reader-state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Offline Reader State
         * @description The cursor and the publication generation it belongs to, from one snapshot.
         */
        get: operations["get_offline_reader_state_media__media_id__offline_reader_state_get"];
        /** Put Offline Reader State */
        put: operations["put_offline_reader_state_media__media_id__offline_reader_state_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/pdf-highlights": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Pdf Highlights */
        get: operations["list_pdf_highlights_media__media_id__pdf_highlights_get"];
        put?: never;
        /** Create Pdf Highlight */
        post: operations["create_pdf_highlight_media__media_id__pdf_highlights_post"];
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
        /**
         * Install Preview Position
         * @description Transfer one ephemeral Preview position after Media acquisition.
         */
        post: operations["install_preview_position_media__media_id__preview_position_post"];
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
    "/media/{media_id}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Refresh Media Source */
        post: operations["refresh_media_source_media__media_id__refresh_post"];
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
        /**
         * Retry Ingest
         * @description Admit one source retry; metadata has its own operation contract.
         */
        post: operations["retry_ingest_media__media_id__retry_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/media/{media_id}/saved-in-nexus": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Add Media Saved In Nexus */
        put: operations["add_media_saved_in_nexus_media__media_id__saved_in_nexus_put"];
        post?: never;
        /** Remove Media Saved In Nexus */
        delete: operations["remove_media_saved_in_nexus_media__media_id__saved_in_nexus_delete"];
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
         * @description Admit an explicit transcript request for supported Media; 202 iff it enqueued work.
         */
        post: operations["request_media_transcript_media__media_id__transcript_request_post"];
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
         * @description Delete a message; the conversation too when it was the last one.
         */
        delete: operations["delete_message_messages__message_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notes/blocks/{block_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Note Block */
        get: operations["get_note_block_notes_blocks__block_id__get"];
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
        /** Read Daily Page */
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
        /** Capture Daily Page Note */
        post: operations["capture_daily_page_note_notes_daily__local_date__captures_post"];
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
        /** List Pages */
        get: operations["list_pages_notes_pages_get"];
        put?: never;
        /** Create Page */
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
        /** Get Page */
        get: operations["get_page_notes_pages__page_id__get"];
        put?: never;
        post?: never;
        /** Delete Page */
        delete: operations["delete_page_notes_pages__page_id__delete"];
        options?: never;
        head?: never;
        /** Update Page */
        patch: operations["update_page_notes_pages__page_id__patch"];
        trace?: never;
    };
    "/offline-reading/packages/{media_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Offline Reading Package
         * @description Verify one package token and transfer one verified immutable ZIP.
         *
         *     The handler is async so the request can observe its own client disconnect
         *     while assembly runs; every blocking database call stays on a worker thread.
         */
        get: operations["get_offline_reading_package_offline_reading_packages__media_id__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/oracle/plates/{image_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Oracle Plate */
        get: operations["get_oracle_plate_oracle_plates__image_id__get"];
        put?: never;
        post?: never;
        delete?: never;
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
        /** Get Oracle Reading Concordance */
        get: operations["get_oracle_reading_concordance_oracle_readings__reading_id__concordance_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/passage-anchors/{anchor_id}/resolution": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolve Passage Anchor */
        get: operations["resolve_passage_anchor_passage_anchors__anchor_id__resolution_get"];
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
        /**
         * Acquire Podcast Episode
         * @description Acquire one discovered episode without subscribing to its show.
         */
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
        /**
         * Refresh Podcasts
         * @description Enqueue one sync per in-scope subscription; the panes observe the rows.
         */
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
        /**
         * List Subscriptions
         * @description List the viewer's followed shows.
         */
        get: operations["list_subscriptions_podcasts_subscriptions_get"];
        put?: never;
        /**
         * Subscribe To Podcast
         * @description Subscribe the viewer and enqueue the first sync and history backfill.
         */
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
        /**
         * Get Subscription Status
         * @description Read viewer-visible sync status for one podcast subscription.
         */
        get: operations["get_subscription_status_podcasts_subscriptions__podcast_id__get"];
        put?: never;
        post?: never;
        /**
         * Unsubscribe From Podcast
         * @description Unsubscribe the viewer and remove the placements they own.
         */
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
        /**
         * Retry Subscription Backfill
         * @description Restart only a persistently failed historical backfill.
         */
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
        /**
         * Patch Subscription Settings
         * @description Patch per-subscription playback settings for the authenticated viewer.
         */
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
        /**
         * Get Podcast Detail
         * @description Get podcast detail, even if the viewer is not actively subscribed.
         */
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
        /**
         * List Podcast Episodes
         * @description List viewer-visible episodes for one podcast.
         */
        get: operations["list_podcast_episodes_podcasts__podcast_id__episodes_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/podcasts/{podcast_id}/episodes/mark-played": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark Podcast Episode Selection Played
         * @description Mark every episode in the named state finished.
         */
        post: operations["mark_podcast_episode_selection_played_podcasts__podcast_id__episodes_mark_played_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/podcasts/{podcast_id}/libraries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Podcast Libraries
         * @description Read the canonical library placement inventory for one podcast.
         */
        get: operations["get_podcast_libraries_podcasts__podcast_id__libraries_get"];
        put?: never;
        post?: never;
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
    "/public/resource-share/assets/{asset_handle}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Public Resource Share Asset */
        get: operations["get_public_resource_share_asset_public_resource_share_assets__asset_handle__get"];
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
    "/public/resource-share/sections/{section_handle}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Public Resource Share Section */
        get: operations["get_public_resource_share_section_public_resource_share_sections__section_handle__get"];
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
    "/resource-graph/links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Link */
        post: operations["create_link_resource_graph_links_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-graph/links/{link_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Link */
        delete: operations["delete_link_resource_graph_links__link_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-graph/links/{link_id}/note": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Put Link Note */
        put: operations["put_link_note_resource_graph_links__link_id__note_put"];
        post?: never;
        /** Delete Link Note */
        delete: operations["delete_link_note_resource_graph_links__link_id__note_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-graph/stances": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Put Stance */
        put: operations["put_stance_resource_graph_stances_put"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-graph/stances/{stance_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Stance */
        delete: operations["delete_stance_resource_graph_stances__stance_id__delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-items/action-snapshots/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve Action Snapshots */
        post: operations["resolve_action_snapshots_resource_items_action_snapshots_resolve_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-items/locators/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve Resource Locators */
        post: operations["resolve_resource_locators_resource_items_locators_resolve_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-items/openables/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Search Openable Resources */
        post: operations["search_openable_resources_resource_items_openables_search_post"];
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
    "/resource-items/{resource_ref}/body": {
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
        /** Update Resource Body */
        patch: operations["update_resource_body_resource_items__resource_ref__body_patch"];
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
    "/resource-items/{resource_ref}/surface": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Resource Surface */
        get: operations["get_resource_surface_resource_items__resource_ref__surface_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-items/{resource_ref}/surface/commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Execute Resource Surface Command */
        post: operations["execute_resource_surface_command_resource_items__resource_ref__surface_commands_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/resource-items/{resource_ref}/title": {
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
        /** Update Resource Title */
        patch: operations["update_resource_title_resource_items__resource_ref__title_patch"];
        trace?: never;
    };
    "/resource-shares/{resource_grant_handle}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Resource Share */
        delete: operations["delete_resource_share_resource_shares__resource_grant_handle__delete"];
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
        /**
         * Search
         * @description Hybrid search (full text ∪ vector ANN) across everything the viewer may see.
         *
         *     Returns 404 for a scope the viewer cannot read — never 403, so existence
         *     does not leak — and 200 with no results when there is neither a usable
         *     full-text query nor a structured filter.
         */
        get: operations["search_search_get"];
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
         * @description The build's ``DossierBuildOut`` on each change; ``done`` once it is not Active.
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
        /** Stream Chat Run Events */
        get: operations["stream_chat_run_events_stream_chat_runs__run_id__events_get"];
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
        /** Stream Media Events */
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
        /** Stream Metadata Events */
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
        /** Stream Oracle Reading Events */
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
         * @description Push one viewer-owned subscription until sync and historical backfill settle.
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
    "/synapse/edges/{edge_id}/dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Dismiss Edge
         * @description Suppress the edge's pair forever, then delete the edge. 409 off-origin.
         */
        post: operations["dismiss_edge_synapse_edges__edge_id__dismiss_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/synapse/scans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read Scan Status
         * @description Scan state for ``ref``: idle, pending, or running.
         */
        get: operations["read_scan_status_synapse_scans_get"];
        put?: never;
        /**
         * Request Scan
         * @description Queue a manual scan. 404 when the object is not visible.
         */
        post: operations["request_scan_synapse_scans_post"];
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
         * @description Log the first client failure with its originating command/read identity.
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
         * @description Search users by email prefix or display name.
         *
         *     Authenticated endpoint. Returns matching users excluding the searcher.
         *     Minimum query length: 3 characters.
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
        /**
         * Absent
         * @description The `Presence<T>` absent variant. Carries no value.
         */
        "Absent-Input": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Absent";
        };
        /**
         * Absent
         * @description The `Presence<T>` absent variant. Carries no value.
         */
        "Absent-Output": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Absent";
        };
        /** AbsentExpectedBody */
        AbsentExpectedBody: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "absent";
        };
        /** AbsentLibraryPlacementRelationOut */
        AbsentLibraryPlacementRelationOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Absent";
        };
        /** AcceptLibraryInviteResponse */
        AcceptLibraryInviteResponse: {
            /** Idempotent */
            idempotent: boolean;
            invite: components["schemas"]["LibraryInvitationOut"];
            membership: components["schemas"]["InviteAcceptMembershipOut"];
        };
        /** ActiveExclusionOut */
        ActiveExclusionOut: {
            device: components["schemas"]["DeviceSummaryOut"];
            /** Excludedactivems */
            excludedActiveMs: number;
            /** Exclusionhandle */
            exclusionHandle: string;
            /**
             * Modality
             * @enum {string}
             */
            modality: "Reading" | "Listening" | "Viewing";
            /**
             * Startedat
             * Format: date-time
             */
            startedAt: string;
            /** Title */
            title: string;
        };
        /** ActivityExclusionResultOut */
        ActivityExclusionResultOut: {
            /** Exclusionhandle */
            exclusionHandle: string;
            /**
             * Outcome
             * @enum {string}
             */
            outcome: "Excluded" | "Restored";
        };
        /**
         * ActivityRecordIn
         * @description ``clientMutationId`` is accepted and ignored: the shipped Android app still sends it.
         */
        ActivityRecordIn: {
            /** Batch */
            batch: components["schemas"]["ReadingActivityBatchIn"] | components["schemas"]["ListeningActivityBatchIn"] | components["schemas"]["ViewingActivityBatchIn"];
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /**
             * Deviceclass
             * @enum {string}
             */
            deviceClass: "Desktop" | "Mobile";
            /** Deviceid */
            deviceId: string;
            /** Mediaref */
            mediaRef: string;
        };
        /** ActivitySessionOut */
        ActivitySessionOut: {
            /** Activems */
            activeMs: number;
            /** Continuesafterrange */
            continuesAfterRange: boolean;
            /** Continuesbeforerange */
            continuesBeforeRange: boolean;
            device: components["schemas"]["DeviceSummaryOut"];
            /**
             * Endedat
             * Format: date-time
             */
            endedAt: string;
            /** Forwardmediapositionms */
            forwardMediaPositionMs: number;
            /** Forwardwordposition */
            forwardWordPosition: number;
            /** Mediaref */
            mediaRef: string;
            /**
             * Modality
             * @enum {string}
             */
            modality: "Reading" | "Listening" | "Viewing";
            /**
             * Startedat
             * Format: date-time
             */
            startedAt: string;
            /** Title */
            title: string;
        };
        /** ActivitySessionPageOut */
        ActivitySessionPageOut: {
            /** Items */
            items: components["schemas"]["ActivitySessionOut"][];
            nextCursor: components["schemas"]["Presence_str_-Output"];
        };
        /** ActivityStatsSectionOut */
        ActivityStatsSectionOut: {
            /** Activeexclusions */
            activeExclusions: components["schemas"]["ActiveExclusionOut"][];
            /** Appliedfilters */
            appliedFilters: string[];
            contributors: components["schemas"]["ContributorActivityBreakdownOut"];
            /** Devices */
            devices: components["schemas"]["DeviceActivityOut"][];
            /** Inapplicablefilters */
            inapplicableFilters: string[];
            /** Localdays */
            localDays: components["schemas"]["LocalDayOut"][];
            /** Localhours */
            localHours: components["schemas"]["LocalHourOut"][];
            longestSession: components["schemas"]["Presence_ActivitySessionOut_"];
            media: components["schemas"]["MediaActivityBreakdownOut"];
            sessions: components["schemas"]["ActivitySessionPageOut"];
            /** Timeline */
            timeline: components["schemas"]["ActivityTimelineRowOut"][];
            totals: components["schemas"]["ActivityTotalsOut"];
        };
        /** ActivityTimelineRowOut */
        ActivityTimelineRowOut: {
            /** Activems */
            activeMs: number;
            /**
             * End
             * Format: date-time
             */
            end: string;
            /** Listeningactivems */
            listeningActiveMs: number;
            /** Locallabel */
            localLabel: string;
            /** Readingactivems */
            readingActiveMs: number;
            /**
             * Start
             * Format: date-time
             */
            start: string;
            /** Utcoffsetminutes */
            utcOffsetMinutes: number;
            /** Viewingactivems */
            viewingActiveMs: number;
        };
        /** ActivityTotalsOut */
        ActivityTotalsOut: {
            /** Activedays */
            activeDays: number;
            /** Activems */
            activeMs: number;
            /** Forwardmediapositionms */
            forwardMediaPositionMs: number;
            /** Forwardwordposition */
            forwardWordPosition: number;
            /** Longeststreak */
            longestStreak: number;
            /** Recordedactivems */
            recordedActiveMs: number;
            /** Sessioncount */
            sessionCount: number;
            /** Streak */
            streak: number;
        };
        /** AfterPlacement */
        AfterPlacement: {
            /**
             * Itemid
             * Format: uuid
             */
            itemId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "After";
        };
        /** ArtifactRetrievalResultRef */
        ArtifactRetrievalResultRef: {
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Id */
            id: string;
            /** Locator */
            locator?: null;
            /** Media Id */
            media_id?: null;
            /** Media Kind */
            media_kind?: null;
            /**
             * Result Type
             * @constant
             */
            result_type: "artifact";
            /** Revision Id */
            revision_id: string;
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Subject Ref */
            subject_ref: string;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "artifact";
        };
        /** AssistantMessageBranchAnchorRequest */
        AssistantMessageBranchAnchorRequest: {
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
        /** AssistantSelectionBranchAnchorRequest */
        AssistantSelectionBranchAnchorRequest: {
            /** Client Selection Id */
            client_selection_id: string;
            /** End Offset */
            end_offset?: number | null;
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
             * @enum {string}
             */
            offset_status: "mapped" | "unmapped";
            /** Prefix */
            prefix?: string | null;
            /** Start Offset */
            start_offset?: number | null;
            /** Suffix */
            suffix?: string | null;
        };
        /** AssistantTrustTrailOut */
        AssistantTrustTrailOut: {
            /**
             * Assistant Message Id
             * Format: uuid
             */
            assistant_message_id: string;
            /** Chat Run Id */
            chat_run_id: string | null;
            /** Citations */
            citations: components["schemas"]["TrustCitationOut"][];
            /** Context Refs Added */
            context_refs_added: components["schemas"]["TrustContextRefAddedOut"][];
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Integrity Notices */
            integrity_notices: components["schemas"]["TrustIntegrityNoticeOut"][];
            prompt: components["schemas"]["TrustPromptAssemblyOut"] | null;
            run: components["schemas"]["TrustRunOut"] | null;
            /**
             * Schema Version
             * @default assistant_trust_trail.v1
             * @constant
             */
            schema_version: "assistant_trust_trail.v1";
            /**
             * Status
             * @enum {string}
             */
            status: "pending" | "running" | "complete" | "error" | "cancelled";
            /** Tool Calls */
            tool_calls: components["schemas"]["TrustToolCallOut"][];
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** AssistantUnavailableChatFailure */
        AssistantUnavailableChatFailure: {
            /** Can Rerun */
            can_rerun: boolean;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            code: "assistant_unavailable";
        };
        /** AtlasEdgeOut */
        AtlasEdgeOut: {
            /**
             * Kind
             * @enum {string}
             */
            kind: "context" | "contradicts";
            /** Origin */
            origin: string;
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
            /** Clientmutationid */
            clientMutationId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            mode: "automatic";
        };
        /** AvailableLibraryPlacementAvailabilityOut */
        AvailableLibraryPlacementAvailabilityOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Available";
        };
        /** BlockedLibraryPlacementAvailabilityOut */
        BlockedLibraryPlacementAvailabilityOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Blocked";
            /**
             * Reason
             * @enum {string}
             */
            reason: "RequiresAdmin" | "RequiresSubscription" | "SystemManaged" | "Inherited";
        };
        /** BranchGraphEdgeOut */
        BranchGraphEdgeOut: {
            /**
             * From
             * Format: uuid
             */
            from: string;
            /**
             * To
             * Format: uuid
             */
            to: string;
        };
        /** BranchGraphNodeOut */
        BranchGraphNodeOut: {
            /** Active Path */
            active_path: boolean;
            /** Branch Anchor Preview */
            branch_anchor_preview: string | null;
            /** Child Count */
            child_count: number;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Depth */
            depth: number;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Leaf */
            leaf: boolean;
            /**
             * Leaf Message Id
             * Format: uuid
             */
            leaf_message_id: string;
            /** Message Count */
            message_count: number;
            /**
             * Message Id
             * Format: uuid
             */
            message_id: string;
            /** Parent Message Id */
            parent_message_id: string | null;
            /** Preview */
            preview: string;
            /**
             * Role
             * @enum {string}
             */
            role: "user" | "assistant";
            /** Row */
            row: number;
            /**
             * Status
             * @enum {string}
             */
            status: "complete" | "pending" | "error" | "cancelled";
            /** Title */
            title: string | null;
        };
        /** BranchGraphOut */
        BranchGraphOut: {
            /** Edges */
            edges: components["schemas"]["BranchGraphEdgeOut"][];
            /** Nodes */
            nodes: components["schemas"]["BranchGraphNodeOut"][];
            /** Root Message Id */
            root_message_id: string | null;
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
            nextCursor: components["schemas"]["Presence_str_-Output"];
            /** Query */
            query: string;
            sort: components["schemas"]["Presence_BrowseSort_"];
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
        /** BrowserCaptureIntent */
        BrowserCaptureIntent: {
            /**
             * Content Type
             * @enum {string}
             */
            content_type: "application/pdf" | "application/epub+zip" | "application/json";
            /** Filename */
            filename: string;
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
        };
        /** CancelledChatFailure */
        CancelledChatFailure: {
            /** Can Rerun */
            can_rerun: boolean;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            code: "cancelled";
        };
        /** Capabilities */
        Capabilities: {
            /** Can Open */
            can_open: boolean;
            /** Can Remove */
            can_remove: boolean;
            recovery: components["schemas"]["Presence_Annotated_Union_RetryUploadOffer__RetrySourceOffer__RepairSourceOffer__RepairSearchOffer___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
            unavailable_reason: components["schemas"]["Presence_Literal__NotOwner____SameSourceTerminal____SourceNotReacquirable____UploadRejected___"];
        };
        /** CapabilitiesOut */
        CapabilitiesOut: {
            /**
             * Can Delete
             * @default false
             */
            can_delete: boolean;
            /** Can Download File */
            can_download_file: boolean;
            /**
             * Can Edit Authors
             * @default false
             */
            can_edit_authors: boolean;
            /** Can Highlight */
            can_highlight: boolean;
            /** Can Play */
            can_play: boolean;
            /** Can Quote */
            can_quote: boolean;
            /** Can Read */
            can_read: boolean;
            /**
             * Can Read Embeds
             * @default false
             */
            can_read_embeds: boolean;
            /**
             * Can Refresh Source
             * @default false
             */
            can_refresh_source: boolean;
            /**
             * Can Repair Search
             * @default false
             */
            can_repair_search: boolean;
            /**
             * Can Repair Source
             * @default false
             */
            can_repair_source: boolean;
            /**
             * Can Retry
             * @default false
             */
            can_retry: boolean;
            /**
             * Can Retry Metadata
             * @default false
             */
            can_retry_metadata: boolean;
            /** Can Search */
            can_search: boolean;
        };
        /** ChapterOut */
        ChapterOut: {
            endMs: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Output"];
            /** Startms */
            startMs: number;
            /** Title */
            title: string;
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
        /** ChatRunAssistantActivityEventPayload */
        ChatRunAssistantActivityEventPayload: {
            /**
             * Assistant Message Id
             * Format: uuid
             */
            assistant_message_id: string;
            /** Label */
            label?: string | null;
            /**
             * Phase
             * @enum {string}
             */
            phase: "queued" | "thinking" | "writing" | "tool_calling" | "waiting" | "retrying" | "cancelling";
            /** Provider Event Seq End */
            provider_event_seq_end?: number | null;
            /** Provider Event Seq Start */
            provider_event_seq_start?: number | null;
        };
        /** ChatRunAssistantTextDeltaEventPayload */
        ChatRunAssistantTextDeltaEventPayload: {
            /**
             * Assistant Message Id
             * Format: uuid
             */
            assistant_message_id: string;
            /** Provider Event Seq End */
            provider_event_seq_end: number;
            /** Provider Event Seq Start */
            provider_event_seq_start: number;
            /** Text */
            text: string;
        };
        /** ChatRunCitationIndexEventPayload */
        ChatRunCitationIndexEventPayload: {
            /**
             * Assistant Message Id
             * Format: uuid
             */
            assistant_message_id: string;
            /** Citations */
            citations: components["schemas"]["ChatRunCitationIndexItem"][];
        };
        /** ChatRunCitationIndexItem */
        ChatRunCitationIndexItem: {
            citation: components["schemas"]["CitationOut"];
            /**
             * Citation Edge Id
             * Format: uuid
             */
            citation_edge_id: string;
        };
        /**
         * ChatRunContextRefAddedEventPayload
         * @description Strict SSE payload for a citation-materialized context edge (ContextRefOut shape).
         */
        ChatRunContextRefAddedEventPayload: {
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Edge Id */
            citation_edge_id: string | null;
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
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
            /** Label */
            label: string;
            /** Missing */
            missing: boolean;
            /** Resource Ref */
            resource_ref: string;
            /** Summary */
            summary: string;
        };
        /**
         * ChatRunCreateRequest
         * @description Request schema for creating a durable chat run.
         *
         *     The reader quote is a durable ``ReaderSelectionKey`` plus a compare-on-send
         *     ``revision`` only — the server derives subject/companion/exact/locator from
         *     the locked Highlight and never accepts client quote text.
         */
        ChatRunCreateRequest: {
            /** Catalog Definition Revision */
            catalog_definition_revision: string;
            /** Content */
            content: string;
            /** Destination */
            destination: components["schemas"]["NewChatDestination"] | components["schemas"]["ExistingChatDestination"];
            reader_selection: components["schemas"]["Presence_ReaderSelectionInput_"];
            /** Selection */
            selection: components["schemas"]["CodexPersonalSelection"] | components["schemas"]["ProviderApiSelection"];
        };
        /** ChatRunDoneEventPayload */
        ChatRunDoneEventPayload: {
            /** Cancelled */
            cancelled: boolean;
            error_code: components["schemas"]["Presence_str_-Output"];
            /** Final Chars */
            final_chars: number | null;
            /** Last Provider Event Seq */
            last_provider_event_seq: number | null;
            publication_warning: components["schemas"]["Presence_ChatPublicationWarning_"];
            /**
             * Status
             * @enum {string}
             */
            status: "complete" | "error" | "cancelled";
            support_id: components["schemas"]["Presence_str_-Output"];
            /** Usage */
            usage: {
                [key: string]: unknown;
            } | null;
        };
        /**
         * ChatRunExecutionOut
         * @description The queue phase and the run's durable stop intent in one observation.
         */
        ChatRunExecutionOut: {
            /** Cancel Requested */
            cancel_requested: boolean;
            phase: components["schemas"]["DurableExecutionPhase"];
        };
        /** ChatRunMetaEventPayload */
        ChatRunMetaEventPayload: {
            /**
             * Assistant Message Id
             * Format: uuid
             */
            assistant_message_id: string;
            chat_subject: components["schemas"]["ChatRunMetaSubjectPayload"] | null;
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
            /**
             * Run Id
             * Format: uuid
             */
            run_id: string;
            run_selection: components["schemas"]["RunSelectionOut"];
            /**
             * User Message Id
             * Format: uuid
             */
            user_message_id: string;
        };
        /** ChatRunMetaSubjectPayload */
        ChatRunMetaSubjectPayload: {
            /** Companions */
            companions?: string[];
            /** Context Edge Id */
            context_edge_id?: string | null;
            /** Requested Resource Ref */
            requested_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
        };
        /** ChatRunOut */
        ChatRunOut: {
            /**
             * Assistant Message Id
             * Format: uuid
             */
            assistant_message_id: string;
            /** Completed At */
            completed_at: string | null;
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Error Code */
            error_code: string | null;
            execution: components["schemas"]["Presence_ChatRunExecutionOut_"];
            /** Failure */
            failure: (components["schemas"]["CancelledChatFailure"] | components["schemas"]["ContextTooLargeChatFailure"] | components["schemas"]["InvalidOutputChatFailure"] | components["schemas"]["IncompleteChatFailure"] | components["schemas"]["AssistantUnavailableChatFailure"] | components["schemas"]["OperatorDefectChatFailure"]) | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            publication_warning: components["schemas"]["Presence_ChatPublicationWarning_"];
            run_selection: components["schemas"]["RunSelectionOut"];
            /** Started At */
            started_at: string | null;
            /**
             * Status
             * @enum {string}
             */
            status: "queued" | "running" | "complete" | "error" | "cancelled";
            support_id: components["schemas"]["Presence_str_-Output"];
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /**
             * User Message Id
             * Format: uuid
             */
            user_message_id: string;
        };
        /**
         * ChatRunRepeatRequest
         * @description Exact selection for rerun/regenerate.
         */
        ChatRunRepeatRequest: {
            /** Catalog Definition Revision */
            catalog_definition_revision: string;
            /** Selection */
            selection: components["schemas"]["CodexPersonalSelection"] | components["schemas"]["ProviderApiSelection"];
        };
        /** ChatRunResponse */
        ChatRunResponse: {
            assistant_message: components["schemas"]["MessageOut"];
            conversation: components["schemas"]["ConversationOut"];
            run: components["schemas"]["ChatRunOut"];
            stream_state: components["schemas"]["ChatRunStreamStateOut"];
            user_message: components["schemas"]["MessageOut"];
        };
        /** ChatRunStreamActivityOut */
        ChatRunStreamActivityOut: {
            /** Label */
            label: string | null;
            /**
             * Phase
             * @enum {string}
             */
            phase: "queued" | "thinking" | "writing" | "tool_calling" | "waiting" | "retrying" | "cancelling";
        };
        /**
         * ChatRunStreamStateOut
         * @description Materialized cursor state for reconnecting a chat stream.
         */
        ChatRunStreamStateOut: {
            activity: components["schemas"]["ChatRunStreamActivityOut"] | null;
            /** Assistant Current Text */
            assistant_current_text: string;
            /** Folded Event Seq */
            folded_event_seq: number;
            /** Last Event Seq */
            last_event_seq: number;
            /** Reconnectable */
            reconnectable: boolean;
            /**
             * Status
             * @enum {string}
             */
            status: "queued" | "running" | "complete" | "error" | "cancelled";
            /** Terminal */
            terminal: boolean;
            /** Tool Calls */
            tool_calls: components["schemas"]["ChatRunStreamToolCallOut"][];
        };
        /** ChatRunStreamToolCallOut */
        ChatRunStreamToolCallOut: {
            /** Activity Label */
            activity_label: string;
            /**
             * Assistant Message Id
             * Format: uuid
             */
            assistant_message_id: string;
            /** Canonical Tool Id */
            canonical_tool_id: string | null;
            effect: components["schemas"]["ToolEffect"] | null;
            /**
             * Error Type
             * @enum {unknown}
             */
            error_type: "BudgetExceeded" | "Conflict" | "DeadlineExceeded" | "InvalidInput" | "InvalidUpstreamResponse" | "InvalidUrl" | "QuoteAmbiguous" | "QuoteNotFound" | "RateLimited" | "ResourceUnavailable" | "TargetAmbiguous" | "TooLarge" | "ToolUnavailable" | "Uninspectable" | "Unreadable" | "UnsafeDestination" | "UnsupportedContent" | "UpstreamUnavailable" | "WriteCapReached" | null;
            /** Id */
            id: string | null;
            /** Input Preview */
            input_preview: string | null;
            /** Provider Request Ids */
            provider_request_ids: string[];
            /** Provider Wire Name */
            provider_wire_name: string | null;
            /**
             * Record Kind
             * @enum {string}
             */
            record_kind: "attached_context" | "current_execution" | "historical_execution";
            /** Requested Types */
            requested_types: string[];
            /**
             * Result Count
             * @default 0
             */
            result_count: number;
            /**
             * Result Kind
             * @enum {string}
             */
            result_kind: "attached_context" | "mutation" | "navigation" | "retrieval";
            /** Result Refs */
            result_refs: {
                [key: string]: unknown;
            }[];
            /** Retrievals */
            retrievals: components["schemas"]["TrustRetrievalOut"][];
            /**
             * Scope
             * @default provider_tool
             */
            scope: string;
            /** Selected Context Refs */
            selected_context_refs: {
                [key: string]: unknown;
            }[];
            /**
             * Selected Count
             * @default 0
             */
            selected_count: number;
            /**
             * Status
             * @default running
             * @enum {string}
             */
            status: "pending" | "running" | "complete" | "error" | "cancelled";
            /** Tool Call Index */
            tool_call_index: number;
        };
        /** ChatRunToolCallDoneEventOut */
        ChatRunToolCallDoneEventOut: {
            /** Activity Label */
            activity_label: string;
            /**
             * Assistant Message Id
             * Format: uuid
             */
            assistant_message_id: string;
            /** Canonical Tool Id */
            canonical_tool_id: string | null;
            effect: components["schemas"]["ToolEffect"] | null;
            /**
             * Error Type
             * @enum {unknown}
             */
            error_type: "BudgetExceeded" | "Conflict" | "DeadlineExceeded" | "InvalidInput" | "InvalidUpstreamResponse" | "InvalidUrl" | "QuoteAmbiguous" | "QuoteNotFound" | "RateLimited" | "ResourceUnavailable" | "TargetAmbiguous" | "TooLarge" | "ToolUnavailable" | "Uninspectable" | "Unreadable" | "UnsafeDestination" | "UnsupportedContent" | "UpstreamUnavailable" | "WriteCapReached" | null;
            /** Input */
            input: {
                [key: string]: unknown;
            };
            /** Provider Event Seq End */
            provider_event_seq_end: number;
            /** Provider Event Seq Start */
            provider_event_seq_start: number;
            /** Provider Tool Call Id */
            provider_tool_call_id?: string | null;
            /** Provider Wire Name */
            provider_wire_name: string | null;
            /**
             * Record Kind
             * @enum {string}
             */
            record_kind: "attached_context" | "current_execution" | "historical_execution";
            /**
             * Result Kind
             * @enum {string}
             */
            result_kind: "attached_context" | "mutation" | "navigation" | "retrieval";
            /** Tool Call Id */
            tool_call_id?: string | null;
            /** Tool Call Index */
            tool_call_index: number;
        };
        /** ChatRunToolCallStartEventOut */
        ChatRunToolCallStartEventOut: {
            /** Activity Label */
            activity_label: string;
            /**
             * Assistant Message Id
             * Format: uuid
             */
            assistant_message_id: string;
            /** Canonical Tool Id */
            canonical_tool_id: string | null;
            effect: components["schemas"]["ToolEffect"] | null;
            /**
             * Error Type
             * @enum {unknown}
             */
            error_type: "BudgetExceeded" | "Conflict" | "DeadlineExceeded" | "InvalidInput" | "InvalidUpstreamResponse" | "InvalidUrl" | "QuoteAmbiguous" | "QuoteNotFound" | "RateLimited" | "ResourceUnavailable" | "TargetAmbiguous" | "TooLarge" | "ToolUnavailable" | "Uninspectable" | "Unreadable" | "UnsafeDestination" | "UnsupportedContent" | "UpstreamUnavailable" | "WriteCapReached" | null;
            /** Provider Event Seq End */
            provider_event_seq_end: number;
            /** Provider Event Seq Start */
            provider_event_seq_start: number;
            /** Provider Tool Call Id */
            provider_tool_call_id?: string | null;
            /** Provider Wire Name */
            provider_wire_name: string | null;
            /**
             * Record Kind
             * @enum {string}
             */
            record_kind: "attached_context" | "current_execution" | "historical_execution";
            /**
             * Result Kind
             * @enum {string}
             */
            result_kind: "attached_context" | "mutation" | "navigation" | "retrieval";
            /** Tool Call Id */
            tool_call_id?: string | null;
            /** Tool Call Index */
            tool_call_index: number;
        };
        /** ChatRunToolResultEventOut */
        ChatRunToolResultEventOut: {
            /** Activity Label */
            activity_label: string;
            /**
             * Assistant Message Id
             * Format: uuid
             */
            assistant_message_id: string;
            /** Canonical Tool Id */
            canonical_tool_id: string | null;
            effect: components["schemas"]["ToolEffect"] | null;
            /**
             * Error Type
             * @enum {unknown}
             */
            error_type: "BudgetExceeded" | "Conflict" | "DeadlineExceeded" | "InvalidInput" | "InvalidUpstreamResponse" | "InvalidUrl" | "QuoteAmbiguous" | "QuoteNotFound" | "RateLimited" | "ResourceUnavailable" | "TargetAmbiguous" | "TooLarge" | "ToolUnavailable" | "Uninspectable" | "Unreadable" | "UnsafeDestination" | "UnsupportedContent" | "UpstreamUnavailable" | "WriteCapReached" | null;
            /** Filters */
            filters: {
                [key: string]: unknown;
            };
            /** Latency Ms */
            latency_ms?: number | null;
            /** Provider Request Ids */
            provider_request_ids?: string[];
            /** Provider Wire Name */
            provider_wire_name: string | null;
            /**
             * Record Kind
             * @enum {string}
             */
            record_kind: "attached_context" | "current_execution" | "historical_execution";
            /** Result Count */
            result_count?: number | null;
            /**
             * Result Kind
             * @enum {string}
             */
            result_kind: "attached_context" | "mutation" | "navigation" | "retrieval";
            /** Results */
            results: (components["schemas"]["MediaRetrievalResultRef"] | components["schemas"]["PodcastRetrievalResultRef"] | components["schemas"]["EpisodeRetrievalResultRef"] | components["schemas"]["VideoRetrievalResultRef"] | components["schemas"]["ContentChunkRetrievalResultRef"] | components["schemas"]["FragmentRetrievalResultRef"] | components["schemas"]["ContributorRetrievalResultRef"] | components["schemas"]["PageRetrievalResultRef"] | components["schemas"]["NoteBlockRetrievalResultRef"] | components["schemas"]["HighlightRetrievalResultRef"] | components["schemas"]["MessageRetrievalResultRef"] | components["schemas"]["WebRetrievalResultRef"] | components["schemas"]["EvidenceSpanRetrievalResultRef"] | components["schemas"]["ReaderApparatusItemRetrievalResultRef"] | components["schemas"]["ConversationRetrievalResultRef"] | components["schemas"]["ArtifactRetrievalResultRef"])[];
            /** Scope */
            scope: string;
            /** Selected Count */
            selected_count?: number | null;
            /**
             * Status
             * @enum {string}
             */
            status: "pending" | "running" | "complete" | "error" | "cancelled";
            /** Tool Call Id */
            tool_call_id?: string | null;
            /** Tool Call Index */
            tool_call_index: number;
            /** Types */
            types: string[];
        };
        /** ChatSeed */
        ChatSeed: {
            /** Policy Revision */
            policy_revision: string;
            presentation: components["schemas"]["SelectionPresentation"];
            /** Selection */
            selection: components["schemas"]["CodexPersonalSelection"] | components["schemas"]["ProviderApiSelection"];
            /** State */
            state: components["schemas"]["Selectable"] | components["schemas"]["Ineligible"] | components["schemas"]["OperatorActionRequired"] | components["schemas"]["TemporarilyUnavailable"];
        };
        /** CitationOut */
        CitationOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            /** Deep Link */
            deep_link: string | null;
            /** Locator */
            locator: (components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"]) | null;
            /** Media Id */
            media_id: string | null;
            /** Ordinal */
            ordinal: number;
            /**
             * Role
             * @enum {string}
             */
            role: "context" | "supports" | "contradicts";
            snapshot: components["schemas"]["CitationSnapshot"] | null;
            target_ref: components["schemas"]["CitationTargetRef"];
        };
        /** CitationSnapshot */
        CitationSnapshot: {
            /** Excerpt */
            excerpt: string | null;
            /** Result Type */
            result_type: string | null;
            /** Section Label */
            section_label: string | null;
            /** Summary Md */
            summary_md: string | null;
            /** Title */
            title: string | null;
        };
        /** CitationTargetRef */
        CitationTargetRef: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Type
             * @enum {string}
             */
            type: "evidence_span" | "content_chunk" | "media" | "highlight" | "fragment" | "page" | "note_block" | "message" | "external_snapshot" | "oracle_passage_anchor" | "reader_apparatus_item";
        };
        /**
         * ClientDefectRequest
         * @description One bounded structural failure report; no exception or request payload.
         */
        ClientDefectRequest: {
            command_id: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_128_____"];
            /** Component Stack */
            component_stack: string;
            /** Error Code */
            error_code: string;
            /** Pane Id */
            pane_id: string;
            /**
             * Phase
             * @enum {string}
             */
            phase: "Admission" | "Read" | "Render";
            /** Release */
            release: string;
            request_id: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_200_____"];
            run_id: components["schemas"]["Presence_UUID_-Input"];
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
        /** CollectionPage[Annotated[Union[LibraryMediaListItemOut, LibraryPodcastListItemOut], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        CollectionPage_Annotated_Union_LibraryMediaListItemOut__LibraryPodcastListItemOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /** Collectionrevision */
            collectionRevision: number;
            /** Items */
            items: (components["schemas"]["LibraryMediaListItemOut"] | components["schemas"]["LibraryPodcastListItemOut"])[];
            nextCursor: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___MinLen_min_length_1_____"];
        };
        /** CollectionPage[Annotated[Union[MediaContributorWorkItemOut, PodcastContributorWorkItemOut, ExternalContributorWorkItemOut], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        CollectionPage_Annotated_Union_MediaContributorWorkItemOut__PodcastContributorWorkItemOut__ExternalContributorWorkItemOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /** Collectionrevision */
            collectionRevision: number;
            /** Items */
            items: (components["schemas"]["MediaContributorWorkItemOut"] | components["schemas"]["PodcastContributorWorkItemOut"] | components["schemas"]["ExternalContributorWorkItemOut"])[];
            nextCursor: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___MinLen_min_length_1_____"];
        };
        /** CollectionPage[ConversationListItemOut] */
        CollectionPage_ConversationListItemOut_: {
            /** Collectionrevision */
            collectionRevision: number;
            /** Items */
            items: components["schemas"]["ConversationListItemOut"][];
            nextCursor: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___MinLen_min_length_1_____"];
        };
        /** CollectionPage[LibraryOut] */
        CollectionPage_LibraryOut_: {
            /** Collectionrevision */
            collectionRevision: number;
            /** Items */
            items: components["schemas"]["LibraryOut"][];
            nextCursor: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___MinLen_min_length_1_____"];
        };
        /** CollectionPage[PodcastSubscriptionListItemOut] */
        CollectionPage_PodcastSubscriptionListItemOut_: {
            /** Collectionrevision */
            collectionRevision: number;
            /** Items */
            items: components["schemas"]["PodcastSubscriptionListItemOut"][];
            nextCursor: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___MinLen_min_length_1_____"];
        };
        /** CompletionStatsSectionOut */
        CompletionStatsSectionOut: {
            /** Appliedfilters */
            appliedFilters: string[];
            /** Contributors */
            contributors: components["schemas"]["ContributorCompletionOut"][];
            /** Inapplicablefilters */
            inapplicableFilters: string[];
            /** Media */
            media: components["schemas"]["MediaCompletionOut"][];
            /** Total */
            total: number;
        };
        /** ConfirmUploadSessionRequest */
        ConfirmUploadSessionRequest: {
            /** Generation */
            generation: number;
        };
        /** ConnectionCitationOut */
        ConnectionCitationOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            /** Ordinal */
            ordinal: number;
            /**
             * Role
             * @enum {string}
             */
            role: "context" | "supports" | "contradicts";
            /** Snapshot */
            snapshot: {
                [key: string]: unknown;
            };
            target_reader: components["schemas"]["ConnectionReaderTargetOut"] | null;
            /**
             * Target Status
             * @enum {string}
             */
            target_status: "current" | "missing" | "forbidden" | "unanchorable";
        };
        /** ConnectionEndpointOut */
        ConnectionEndpointOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            /** Description */
            description: string | null;
            /** Href */
            href: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Label */
            label: string | null;
            /** Missing */
            missing: boolean;
            /** Ref */
            ref: string;
            /**
             * Scheme
             * @enum {string}
             */
            scheme: "media" | "library" | "evidence_span" | "content_chunk" | "highlight" | "page" | "note_block" | "fragment" | "conversation" | "message" | "oracle_reading" | "oracle_passage_anchor" | "artifact" | "artifact_revision" | "external_snapshot" | "contributor" | "podcast" | "reader_apparatus_item" | "passage_anchor";
        };
        /** ConnectionFiltersRequest */
        ConnectionFiltersRequest: {
            /** Kinds */
            kinds?: ("context" | "supports" | "contradicts")[] | null;
            /** Origins */
            origins?: ("user" | "citation" | "system" | "note_body" | "highlight_note" | "synapse" | "document_embed" | "assistant" | "link_note")[] | null;
            /** Source Schemes */
            source_schemes?: ("media" | "library" | "evidence_span" | "content_chunk" | "highlight" | "page" | "note_block" | "fragment" | "conversation" | "message" | "oracle_reading" | "oracle_passage_anchor" | "artifact" | "artifact_revision" | "external_snapshot" | "contributor" | "podcast" | "reader_apparatus_item" | "passage_anchor")[] | null;
            /** Target Schemes */
            target_schemes?: ("media" | "library" | "evidence_span" | "content_chunk" | "highlight" | "page" | "note_block" | "fragment" | "conversation" | "message" | "oracle_reading" | "oracle_passage_anchor" | "artifact" | "artifact_revision" | "external_snapshot" | "contributor" | "podcast" | "reader_apparatus_item" | "passage_anchor")[] | null;
        };
        /** ConnectionLinkNoteOut */
        ConnectionLinkNoteOut: {
            /**
             * Note Block Id
             * Format: uuid
             */
            note_block_id: string;
            /** Preview */
            preview: string | null;
            /** Ref */
            ref: string;
        };
        /** ConnectionOut */
        ConnectionOut: {
            citation: components["schemas"]["ConnectionCitationOut"] | null;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
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
            link_note: components["schemas"]["ConnectionLinkNoteOut"] | null;
            /** Ordinal */
            ordinal: number | null;
            /**
             * Origin
             * @enum {string}
             */
            origin: "user" | "citation" | "system" | "note_body" | "highlight_note" | "synapse" | "document_embed" | "assistant" | "link_note";
            other: components["schemas"]["ConnectionEndpointOut"];
            /** Snapshot */
            snapshot: {
                [key: string]: unknown;
            } | null;
            source: components["schemas"]["ConnectionEndpointOut"];
            /** Source Order Key */
            source_order_key: string | null;
            /** Source Ref */
            source_ref: string;
            target: components["schemas"]["ConnectionEndpointOut"];
            /** Target Ref */
            target_ref: string;
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
        /** ConnectionReaderTargetOut */
        ConnectionReaderTargetOut: {
            /** Locator */
            locator: {
                [key: string]: unknown;
            } | null;
            /** Media Id */
            media_id: string | null;
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
        /** ConsumptionOut */
        ConsumptionOut: {
            progress: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____-Output"];
            /** Progressresettable */
            progressResettable: boolean;
            /**
             * State
             * @enum {string}
             */
            state: "Unread" | "InProgress" | "Finished";
        };
        /** ConsumptionRemovedOutcome */
        ConsumptionRemovedOutcome: {
            /**
             * Itemid
             * Format: uuid
             */
            itemId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Removed";
            nextItemId: components["schemas"]["Presence_UUID_-Output"];
        };
        /** ConsumptionResourceActionCapabilityOut */
        ConsumptionResourceActionCapabilityOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Consumption";
            /**
             * State
             * @enum {string}
             */
            state: "Unread" | "InProgress" | "Finished";
        };
        /** ConsumptionResult */
        ConsumptionResult: {
            completionHandle: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata___PydanticGeneralMetadata_pattern___ncc1_____A-Za-z0-9_-__22______A-Za-z0-9_-__22________"];
            lectern: components["schemas"]["LecternSnapshot"];
            /** Libraryentriescollectionrevision */
            libraryEntriesCollectionRevision: number;
            nextItem: components["schemas"]["Presence_LecternItemOut_"];
            /** Outcome */
            outcome: components["schemas"]["ConsumptionStateOutcome"] | components["schemas"]["ConsumptionRemovedOutcome"];
            progressState: components["schemas"]["Presence_MediaProgressState_"];
        };
        /** ConsumptionStateOutcome */
        ConsumptionStateOutcome: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Completed" | "CompletedWithoutAdvance" | "StateOnly" | "Superseded" | "TargetGone";
        };
        /** ConsumptionStatsOut */
        ConsumptionStatsOut: {
            activity: components["schemas"]["ActivityStatsSectionOut"];
            completion: components["schemas"]["CompletionStatsSectionOut"];
            retainedArtifacts: components["schemas"]["RetainedArtifactsOut"];
        };
        /** ContentChunkRetrievalResultRef */
        ContentChunkRetrievalResultRef: {
            /** Citation Label */
            citation_label: string;
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Evidence Span Id */
            evidence_span_id?: string | null;
            /** Evidence Span Ids */
            evidence_span_ids?: (string)[];
            /** Id */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
            /**
             * Result Type
             * @constant
             */
            result_type: "content_chunk";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Kind */
            source_kind: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "content_chunk";
        };
        /** ContextTooLargeChatFailure */
        ContextTooLargeChatFailure: {
            /**
             * Can Rerun
             * @default false
             * @constant
             */
            can_rerun: false;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            code: "context_too_large";
        };
        /** ContributorActivityBreakdownOut */
        ContributorActivityBreakdownOut: {
            /** Rows */
            rows: components["schemas"]["ContributorActivityOut"][];
        };
        /** ContributorActivityOut */
        ContributorActivityOut: {
            /** Activems */
            activeMs: number;
            /** Contributorhandle */
            contributorHandle: string;
            /** Displayname */
            displayName: string;
            /** Roles */
            roles: string[];
        };
        /** ContributorCompletionOut */
        ContributorCompletionOut: {
            /** Contributorhandle */
            contributorHandle: string;
            /** Displayname */
            displayName: string;
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
            actionSubject: components["schemas"]["ResourceActionSubjectOut"];
            /** Displayname */
            displayName: string;
            /** Handle */
            handle: string;
            /** Href */
            href: string;
            /** Othernames */
            otherNames: string[];
        };
        /** ContributorHandleLocatorIn */
        ContributorHandleLocatorIn: {
            /** Handle */
            handle: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "contributor_handle";
        };
        /** ContributorRetrievalResultRef */
        ContributorRetrievalResultRef: {
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Contributor Handle */
            contributor_handle: string;
            /** Deep Link */
            deep_link: string;
            /** Id */
            id: string;
            /** Locator */
            locator?: null;
            /** Media Id */
            media_id?: null;
            /** Media Kind */
            media_kind?: null;
            /**
             * Result Type
             * @constant
             */
            result_type: "contributor";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "contributor";
        };
        /** ContributorRoleFactOut */
        ContributorRoleFactOut: {
            /** Creditedname */
            creditedName: string;
            /** Rawrole */
            rawRole: string | null;
            /**
             * Role
             * @enum {string}
             */
            role: "author" | "editor" | "translator" | "host" | "guest" | "narrator" | "creator" | "producer" | "publisher" | "channel" | "organization" | "unknown";
        };
        /** ContributorSearchItemOut */
        ContributorSearchItemOut: {
            /** Displayname */
            displayName: string;
            /** Handle */
            handle: string;
            /** Href */
            href: string;
            /** Matchedalias */
            matchedAlias: string | null;
            /** Workcount */
            workCount: number;
            /** Workexamples */
            workExamples: components["schemas"]["ContributorWorkExampleOut"][];
        };
        /** ContributorSearchPageOut */
        ContributorSearchPageOut: {
            /** Contributors */
            contributors: components["schemas"]["ContributorSearchItemOut"][];
            /** Nextcursor */
            nextCursor: string | null;
        };
        /** ContributorWorkExampleOut */
        ContributorWorkExampleOut: {
            /** Href */
            href: string;
            /** Title */
            title: string;
        };
        /**
         * ConversationArtifactSearchOut
         * @description A current Conversation Dossier claim; the exact revision ref preserves
         *     historical selection while activation opens the conversation subject.
         */
        ConversationArtifactSearchOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /**
             * Revision Id
             * Format: uuid
             */
            revision_id: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            /** Source Label */
            source_label: string | null;
            /** Subject Ref */
            subject_ref: string;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "artifact";
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
            /** Is Owner */
            is_owner: boolean;
            /** Message Count */
            message_count: number;
            /**
             * Owner User Id
             * Format: uuid
             */
            owner_user_id: string;
            /** Title */
            title: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** ConversationRetrievalResultRef */
        ConversationRetrievalResultRef: {
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Id */
            id: string;
            /** Locator */
            locator?: null;
            /** Media Id */
            media_id?: null;
            /** Media Kind */
            media_kind?: null;
            /**
             * Result Type
             * @constant
             */
            result_type: "conversation";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "conversation";
        };
        /** ConversationTreeOut */
        ConversationTreeOut: {
            /** Active Leaf Message Id */
            active_leaf_message_id: string | null;
            branch_graph: components["schemas"]["BranchGraphOut"];
            conversation: components["schemas"]["ConversationOut"];
            /** Fork Options By Parent Id */
            fork_options_by_parent_id: {
                [key: string]: components["schemas"]["ForkOptionOut"][];
            };
            /** Path Cache By Leaf Id */
            path_cache_by_leaf_id: {
                [key: string]: components["schemas"]["MessageOut"][];
            };
            /** Selected Path */
            selected_path: components["schemas"]["MessageOut"][];
        };
        /** CorrectSourceTypeRecovery */
        CorrectSourceTypeRecovery: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "CorrectSourceType";
            /**
             * New Source Attempt Id
             * Format: uuid
             */
            new_source_attempt_id: string;
            /**
             * Source Type
             * @constant
             */
            source_type: "remote_epub_url";
        };
        /** CreateConversationRequest */
        CreateConversationRequest: {
            /** Initial Context Refs */
            initial_context_refs?: string[] | null;
        };
        /** CreateHighlightRequest */
        CreateHighlightRequest: {
            /**
             * Color
             * @enum {string}
             */
            color: "yellow" | "green" | "blue" | "pink" | "purple";
            /** End Offset */
            end_offset: number;
            /** Start Offset */
            start_offset: number;
        };
        /** CreateLibraryInviteRequest */
        CreateLibraryInviteRequest: {
            invitee: components["schemas"]["UserLibraryInvitee"];
            /**
             * Role
             * @description Role to assign to the invitee ('admin' or 'member')
             * @enum {string}
             */
            role: "admin" | "member";
        };
        /** CreateLibraryRequest */
        CreateLibraryRequest: {
            /**
             * Library Id
             * Format: uuid
             */
            library_id: string;
            /**
             * Name
             * @description Library name (1-100 chars)
             */
            name: string;
        };
        /** CreateLinkOut */
        CreateLinkOut: {
            connection: components["schemas"]["ConnectionOut"];
            /** Created */
            created: boolean;
            /** Created Source Ref */
            created_source_ref: string | null;
        };
        /** CreateLinkRequest */
        CreateLinkRequest: {
            /** Client Mutation Id */
            client_mutation_id: string;
            /** Source */
            source: components["schemas"]["LinkResourceSource"] | components["schemas"]["LinkFragmentSelectionSource"] | components["schemas"]["LinkPdfSelectionSource"];
            /** Target */
            target: components["schemas"]["LinkResourceTarget"] | components["schemas"]["LinkPassageTarget"];
        };
        /** CreatePageRequest */
        CreatePageRequest: {
            /**
             * Page Id
             * Format: uuid
             */
            page_id: string;
            /** Title */
            title: string;
        };
        /** CreatePdfHighlightRequest */
        CreatePdfHighlightRequest: {
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
            /** Page Number */
            page_number: number;
            /** Quads */
            quads: components["schemas"]["PdfQuadIn"][];
        };
        /** CreateResourceShareOut */
        CreateResourceShareOut: {
            /** Created */
            created: boolean;
            /** Share */
            share: components["schemas"]["UserShareOut"] | components["schemas"]["LinkShareOut"];
        };
        /** CreateResourceShareRequest */
        CreateResourceShareRequest: {
            /** Audience */
            audience: components["schemas"]["UserAudienceIn"] | components["schemas"]["LinkAudienceIn"];
        };
        /** CreateUploadSessionRequest */
        CreateUploadSessionRequest: {
            /** Content Type */
            content_type: string;
            /** Filename */
            filename: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "Pdf" | "Epub";
            /** Library Ids */
            library_ids?: string[];
            /** Size Bytes */
            size_bytes: number;
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
            /** Base Revision */
            base_revision: number;
            /** Locator */
            locator: components["schemas"]["PdfReaderResumeState"] | components["schemas"]["WebReaderResumeState"] | components["schemas"]["TranscriptReaderResumeState"] | components["schemas"]["EpubReaderResumeState-Input"];
        };
        /** DailyCaptureRequest */
        DailyCaptureRequest: {
            /** Bodypmjson */
            bodyPmJson: {
                [key: string]: unknown;
            };
            /** Clientmutationid */
            clientMutationId: string;
            /**
             * Noteid
             * Format: uuid
             */
            noteId: string;
        };
        /** DailyCaptureResult */
        DailyCaptureResult: {
            /** Clientmutationid */
            clientMutationId: string;
            /**
             * Localdate
             * Format: date
             */
            localDate: string;
            /**
             * Pageid
             * Format: uuid
             */
            pageId: string;
            surface: components["schemas"]["ResourceSurfaceOut"];
        };
        /** DailyPageSummaryOut */
        DailyPageSummaryOut: {
            /**
             * Localdate
             * Format: date
             */
            localDate: string;
        };
        /** DataPage[ConversationOut, PageInfo] */
        DataPage_ConversationOut_PageInfo_: {
            /** Data */
            data: components["schemas"]["ConversationOut"][];
            page: components["schemas"]["PageInfo"];
        };
        /** DataPage[LibraryDestinationOut, LibraryPageInfo] */
        DataPage_LibraryDestinationOut_LibraryPageInfo_: {
            /** Data */
            data: components["schemas"]["LibraryDestinationOut"][];
            page: components["schemas"]["LibraryPageInfo"];
        };
        /** DataPage[LibraryInvitationOut, LibraryGovernancePageInfo] */
        DataPage_LibraryInvitationOut_LibraryGovernancePageInfo_: {
            /** Data */
            data: components["schemas"]["LibraryInvitationOut"][];
            page: components["schemas"]["LibraryGovernancePageInfo"];
        };
        /** DataPage[LibraryMemberOut, LibraryGovernancePageInfo] */
        DataPage_LibraryMemberOut_LibraryGovernancePageInfo_: {
            /** Data */
            data: components["schemas"]["LibraryMemberOut"][];
            page: components["schemas"]["LibraryGovernancePageInfo"];
        };
        /** Data[AcceptLibraryInviteResponse] */
        Data_AcceptLibraryInviteResponse_: {
            data: components["schemas"]["AcceptLibraryInviteResponse"];
        };
        /** Data[ActivityExclusionResultOut] */
        Data_ActivityExclusionResultOut_: {
            data: components["schemas"]["ActivityExclusionResultOut"];
        };
        /** Data[ActivitySessionPageOut] */
        Data_ActivitySessionPageOut_: {
            data: components["schemas"]["ActivitySessionPageOut"];
        };
        /** Data[Annotated[Union[LatentDailyPageDescriptor, MaterializedDailyPageDescriptor], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        Data_Annotated_Union_LatentDailyPageDescriptor__MaterializedDailyPageDescriptor___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /** Data */
            data: components["schemas"]["LatentDailyPageDescriptor"] | components["schemas"]["MaterializedDailyPageDescriptor"];
        };
        /** Data[Annotated[Union[LearnDossierOpenedOut, LearnDossierBuildAcceptedOut], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        Data_Annotated_Union_LearnDossierOpenedOut__LearnDossierBuildAcceptedOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /** Data */
            data: components["schemas"]["LearnDossierOpenedOut"] | components["schemas"]["LearnDossierBuildAcceptedOut"];
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
        /** Data[ChatRunResponse] */
        Data_ChatRunResponse_: {
            data: components["schemas"]["ChatRunResponse"];
        };
        /** Data[CollectionPage[Annotated[Union[LibraryMediaListItemOut, LibraryPodcastListItemOut], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]]] */
        Data_CollectionPage_Annotated_Union_LibraryMediaListItemOut__LibraryPodcastListItemOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind_____: {
            data: components["schemas"]["CollectionPage_Annotated_Union_LibraryMediaListItemOut__LibraryPodcastListItemOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
        };
        /** Data[CollectionPage[Annotated[Union[MediaContributorWorkItemOut, PodcastContributorWorkItemOut, ExternalContributorWorkItemOut], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]]] */
        Data_CollectionPage_Annotated_Union_MediaContributorWorkItemOut__PodcastContributorWorkItemOut__ExternalContributorWorkItemOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind_____: {
            data: components["schemas"]["CollectionPage_Annotated_Union_MediaContributorWorkItemOut__PodcastContributorWorkItemOut__ExternalContributorWorkItemOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
        };
        /** Data[CollectionPage[ConversationListItemOut]] */
        Data_CollectionPage_ConversationListItemOut__: {
            data: components["schemas"]["CollectionPage_ConversationListItemOut_"];
        };
        /** Data[CollectionPage[LibraryOut]] */
        Data_CollectionPage_LibraryOut__: {
            data: components["schemas"]["CollectionPage_LibraryOut_"];
        };
        /** Data[CollectionPage[PodcastSubscriptionListItemOut]] */
        Data_CollectionPage_PodcastSubscriptionListItemOut__: {
            data: components["schemas"]["CollectionPage_PodcastSubscriptionListItemOut_"];
        };
        /** Data[ConnectionPageOut] */
        Data_ConnectionPageOut_: {
            data: components["schemas"]["ConnectionPageOut"];
        };
        /** Data[ConsumptionResult] */
        Data_ConsumptionResult_: {
            data: components["schemas"]["ConsumptionResult"];
        };
        /** Data[ConsumptionStatsOut] */
        Data_ConsumptionStatsOut_: {
            data: components["schemas"]["ConsumptionStatsOut"];
        };
        /** Data[ContributorDetailOut] */
        Data_ContributorDetailOut_: {
            data: components["schemas"]["ContributorDetailOut"];
        };
        /** Data[ContributorSearchPageOut] */
        Data_ContributorSearchPageOut_: {
            data: components["schemas"]["ContributorSearchPageOut"];
        };
        /** Data[ConversationTreeOut] */
        Data_ConversationTreeOut_: {
            data: components["schemas"]["ConversationTreeOut"];
        };
        /** Data[CreateLinkOut] */
        Data_CreateLinkOut_: {
            data: components["schemas"]["CreateLinkOut"];
        };
        /** Data[CreateResourceShareOut] */
        Data_CreateResourceShareOut_: {
            data: components["schemas"]["CreateResourceShareOut"];
        };
        /** Data[DailyCaptureResult] */
        Data_DailyCaptureResult_: {
            data: components["schemas"]["DailyCaptureResult"];
        };
        /** Data[DeclineLibraryInviteResponse] */
        Data_DeclineLibraryInviteResponse_: {
            data: components["schemas"]["DeclineLibraryInviteResponse"];
        };
        /** Data[DossierBuildCreatedOut] */
        Data_DossierBuildCreatedOut_: {
            data: components["schemas"]["DossierBuildCreatedOut"];
        };
        /** Data[DossierHeadOut] */
        Data_DossierHeadOut_: {
            data: components["schemas"]["DossierHeadOut"];
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
        /** Data[LecternResult] */
        Data_LecternResult_: {
            data: components["schemas"]["LecternResult"];
        };
        /** Data[LecternSnapshot] */
        Data_LecternSnapshot_: {
            data: components["schemas"]["LecternSnapshot"];
        };
        /** Data[LibraryDeleteOut] */
        Data_LibraryDeleteOut_: {
            data: components["schemas"]["LibraryDeleteOut"];
        };
        /** Data[LibraryEntryRemovalOut] */
        Data_LibraryEntryRemovalOut_: {
            data: components["schemas"]["LibraryEntryRemovalOut"];
        };
        /** Data[LibraryInvitationOut] */
        Data_LibraryInvitationOut_: {
            data: components["schemas"]["LibraryInvitationOut"];
        };
        /** Data[LibraryMemberOut] */
        Data_LibraryMemberOut_: {
            data: components["schemas"]["LibraryMemberOut"];
        };
        /** Data[LibraryOut] */
        Data_LibraryOut_: {
            data: components["schemas"]["LibraryOut"];
        };
        /** Data[LibraryRenameOut] */
        Data_LibraryRenameOut_: {
            data: components["schemas"]["LibraryRenameOut"];
        };
        /** Data[LinkNoteOut] */
        Data_LinkNoteOut_: {
            data: components["schemas"]["LinkNoteOut"];
        };
        /** Data[LinkedNoteBlockRef] */
        Data_LinkedNoteBlockRef_: {
            data: components["schemas"]["LinkedNoteBlockRef"];
        };
        /** Data[ListeningHeartbeatResult] */
        Data_ListeningHeartbeatResult_: {
            data: components["schemas"]["ListeningHeartbeatResult"];
        };
        /** Data[ListeningStateOut] */
        Data_ListeningStateOut_: {
            data: components["schemas"]["nexus__schemas__consumption__ListeningStateOut"];
        };
        /** Data[MediaNavigationOut] */
        Data_MediaNavigationOut_: {
            data: components["schemas"]["MediaNavigationOut"];
        };
        /** Data[MediaOut] */
        Data_MediaOut_: {
            data: components["schemas"]["MediaOut"];
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
        /** Data[NotePageOut] */
        Data_NotePageOut_: {
            data: components["schemas"]["NotePageOut"];
        };
        /** Data[NotePagesOut] */
        Data_NotePagesOut_: {
            data: components["schemas"]["NotePagesOut"];
        };
        /** Data[PodcastBackfillRetryOut] */
        Data_PodcastBackfillRetryOut_: {
            data: components["schemas"]["PodcastBackfillRetryOut"];
        };
        /** Data[PodcastDetailOut] */
        Data_PodcastDetailOut_: {
            data: components["schemas"]["PodcastDetailOut"];
        };
        /** Data[PodcastEpisodeQueryTranscriptForecastOut] */
        Data_PodcastEpisodeQueryTranscriptForecastOut_: {
            data: components["schemas"]["PodcastEpisodeQueryTranscriptForecastOut"];
        };
        /** Data[PodcastEpisodeQueryTranscriptRequestOut] */
        Data_PodcastEpisodeQueryTranscriptRequestOut_: {
            data: components["schemas"]["PodcastEpisodeQueryTranscriptRequestOut"];
        };
        /** Data[PodcastPlacementAdditionOut] */
        Data_PodcastPlacementAdditionOut_: {
            data: components["schemas"]["PodcastPlacementAdditionOut"];
        };
        /** Data[PodcastPlacementRemovalOut] */
        Data_PodcastPlacementRemovalOut_: {
            data: components["schemas"]["PodcastPlacementRemovalOut"];
        };
        /** Data[PodcastRefreshAcceptedOut] */
        Data_PodcastRefreshAcceptedOut_: {
            data: components["schemas"]["PodcastRefreshAcceptedOut"];
        };
        /** Data[PodcastSubscribeOut] */
        Data_PodcastSubscribeOut_: {
            data: components["schemas"]["PodcastSubscribeOut"];
        };
        /** Data[PodcastSubscriptionSettingsOut] */
        Data_PodcastSubscriptionSettingsOut_: {
            data: components["schemas"]["PodcastSubscriptionSettingsOut"];
        };
        /** Data[PodcastSubscriptionStatusOut] */
        Data_PodcastSubscriptionStatusOut_: {
            data: components["schemas"]["PodcastSubscriptionStatusOut"];
        };
        /** Data[PublicSectionOut] */
        Data_PublicSectionOut_: {
            data: components["schemas"]["PublicSectionOut"];
        };
        /** Data[PublicShareOut] */
        Data_PublicShareOut_: {
            data: components["schemas"]["PublicShareOut"];
        };
        /** Data[QuickReadsOut] */
        Data_QuickReadsOut_: {
            data: components["schemas"]["QuickReadsOut"];
        };
        /** Data[ReaderDocumentMapOut] */
        Data_ReaderDocumentMapOut_: {
            data: components["schemas"]["ReaderDocumentMapOut"];
        };
        /** Data[ResourceActionSnapshotResolveResponse] */
        Data_ResourceActionSnapshotResolveResponse_: {
            data: components["schemas"]["ResourceActionSnapshotResolveResponse"];
        };
        /** Data[ResourceLocatorResolveResponse] */
        Data_ResourceLocatorResolveResponse_: {
            data: components["schemas"]["ResourceLocatorResolveResponse"];
        };
        /** Data[ResourceOpenableSearchResponse] */
        Data_ResourceOpenableSearchResponse_: {
            data: components["schemas"]["ResourceOpenableSearchResponse"];
        };
        /** Data[ResourceShareSnapshotOut] */
        Data_ResourceShareSnapshotOut_: {
            data: components["schemas"]["ResourceShareSnapshotOut"];
        };
        /** Data[ResourceSurfaceCommandOut] */
        Data_ResourceSurfaceCommandOut_: {
            data: components["schemas"]["ResourceSurfaceCommandOut"];
        };
        /** Data[ResourceSurfaceOut] */
        Data_ResourceSurfaceOut_: {
            data: components["schemas"]["ResourceSurfaceOut"];
        };
        /** Data[ResourceTargetSearchResponse] */
        Data_ResourceTargetSearchResponse_: {
            data: components["schemas"]["ResourceTargetSearchResponse"];
        };
        /** Data[ResourceTitleMutationOut] */
        Data_ResourceTitleMutationOut_: {
            data: components["schemas"]["ResourceTitleMutationOut"];
        };
        /** Data[SlateOut] */
        Data_SlateOut_: {
            data: components["schemas"]["SlateOut"];
        };
        /** Data[SourceRetryAdmission] */
        Data_SourceRetryAdmission_: {
            data: components["schemas"]["SourceRetryAdmission"];
        };
        /** Data[StanceOut] */
        Data_StanceOut_: {
            data: components["schemas"]["StanceOut"];
        };
        /** Data[TranscriptRequestOut] */
        Data_TranscriptRequestOut_: {
            data: components["schemas"]["TranscriptRequestOut"];
        };
        /** Data[list[ChatRunResponse]] */
        Data_list_ChatRunResponse__: {
            /** Data */
            data: components["schemas"]["ChatRunResponse"][];
        };
        /** Data[list[FragmentOut]] */
        Data_list_FragmentOut__: {
            /** Data */
            data: components["schemas"]["FragmentOut"][];
        };
        /** Data[list[LibraryPlacementOptionOut]] */
        Data_list_LibraryPlacementOptionOut__: {
            /** Data */
            data: components["schemas"]["LibraryPlacementOptionOut"][];
        };
        /** Data[list[ViewerLibraryInvitationOut]] */
        Data_list_ViewerLibraryInvitationOut__: {
            /** Data */
            data: components["schemas"]["ViewerLibraryInvitationOut"][];
        };
        /** DeclineLibraryInviteResponse */
        DeclineLibraryInviteResponse: {
            /** Idempotent */
            idempotent: boolean;
            invite: components["schemas"]["LibraryInvitationOut"];
        };
        /** DeviceActivityOut */
        DeviceActivityOut: {
            /** Activems */
            activeMs: number;
            /** Devicehandle */
            deviceHandle: string;
            /** Iscurrent */
            isCurrent: boolean;
            /** Label */
            label: string;
        };
        /** DeviceSummaryOut */
        DeviceSummaryOut: {
            /** Devicehandle */
            deviceHandle: string;
            /** Label */
            label: string;
        };
        /** DirectLibraryPlacementRelationOut */
        DirectLibraryPlacementRelationOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Direct";
        };
        /** DirectNaturalEndOrigin */
        DirectNaturalEndOrigin: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Direct";
        };
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
            kind: "open_child_media" | "open_original" | "retry_child" | "refresh_parent";
            /** Label */
            label: string;
        };
        /** DocumentEmbedDisplayOut */
        DocumentEmbedDisplayOut: {
            /** Actions */
            actions: components["schemas"]["DocumentEmbedDisplayActionOut"][];
            /** Description */
            description: string;
            /** Label */
            label: string;
            /**
             * Mode
             * @enum {string}
             */
            mode: "resolved" | "pending" | "unsupported" | "failed";
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
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
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
            /**
             * Resolution Status
             * @enum {string}
             */
            resolution_status: "resolving" | "resolved" | "unsupported" | "failed";
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
        /** DocumentEmbedSummaryOut */
        DocumentEmbedSummaryOut: {
            /** Failed Count */
            failed_count: number;
            /** Resolved Count */
            resolved_count: number;
            /**
             * Status
             * @enum {string}
             */
            status: "unsupported" | "empty" | "resolving" | "ready" | "partial" | "failed";
            /** Total Count */
            total_count: number;
            /** Unsupported Count */
            unsupported_count: number;
        };
        /** DocumentEmbedTargetOut */
        DocumentEmbedTargetOut: {
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
         * @description One build; also the SSE snapshot. ``phase`` is Present only while Active.
         */
        DossierBuildOut: {
            failure_code: components["schemas"]["Presence_DossierFailureCode_"];
            /** Handle */
            handle: string;
            instruction: components["schemas"]["Presence_str_-Output"];
            phase: components["schemas"]["Presence_DurableExecutionPhase_"];
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
        DossierFailureCode: "NoSourceMaterial" | "InputsChanged" | "DependencyProjectionFailed" | "ContextTooLarge" | "Auth" | "Quota" | "Timeout" | "OutputLimit" | "InvalidOutput" | "PolicyViolation" | "RuntimeUnavailable" | "CapacityUnavailable" | "DocumentValidationFailed" | "CitationValidationFailed";
        /** DossierGenerateRequest */
        DossierGenerateRequest: {
            instruction: components["schemas"]["Presence_str_-Input"];
        };
        /**
         * DossierHeadOut
         * @description ``artifact_ref`` Absent: never generated (a head read never inserts a head).
         */
        DossierHeadOut: {
            active_build: components["schemas"]["Presence_DossierBuildOut_"];
            artifact_ref: components["schemas"]["Presence_str_-Output"];
            last_failure: components["schemas"]["Presence_DossierBuildOut_"];
            media_abstract: components["schemas"]["Presence_MediaAbstractOut_"];
            revision: components["schemas"]["Presence_DossierRevisionOut_"];
            subject_activation: components["schemas"]["Presence_ResourceActivationOut_"];
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
            instruction: components["schemas"]["Presence_str_-Output"];
            model: components["schemas"]["Presence_str_-Output"];
            /** Revision Ref */
            revision_ref: string;
            /** Stale */
            stale: boolean;
            total_tokens: components["schemas"]["Presence_int_"];
        };
        /**
         * DurableExecutionPhase
         * @description Advisory liveness projected from one live durable queue job.
         * @enum {string}
         */
        DurableExecutionPhase: "Queued" | "Running" | "Recovering" | "Suspended";
        /**
         * EmptyInsertion
         * @description Insert the first root message into a still-empty conversation.
         *
         *     Exists only because the retained generic resource-context picker creates a
         *     context-bearing conversation before its first message; the server locks and
         *     linearizes it against concurrent message creation.
         */
        EmptyInsertion: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Empty";
        };
        /** EnsureMediaFinishedCommand */
        EnsureMediaFinishedCommand: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "EnsureMediaFinished";
            /**
             * Mediaid
             * Format: uuid
             */
            mediaId: string;
        };
        /** EpisodeConsumptionResourceActionCapabilityOut */
        EpisodeConsumptionResourceActionCapabilityOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "EpisodeConsumption";
            /**
             * State
             * @enum {string}
             */
            state: "Unplayed" | "Played";
        };
        /** EpisodePreview */
        EpisodePreview: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            description: components["schemas"]["Presence_str_-Output"];
            image: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Episode";
            kindFacts: components["schemas"]["EpisodePreviewFacts"];
            publishedAt: components["schemas"]["Presence_datetime_"];
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default PodcastIndex
             * @constant
             */
            source: "PodcastIndex";
            /** Sourcehref */
            sourceHref: string;
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** EpisodePreviewFacts */
        EpisodePreviewFacts: {
            /** Audiohref */
            audioHref: string;
            durationSeconds: components["schemas"]["Presence_int_"];
            /** Episoderef */
            episodeRef: string;
            /** Podcastref */
            podcastRef: string;
            /** Podcasttitle */
            podcastTitle: string;
        };
        /** EpisodeRetrievalResultRef */
        EpisodeRetrievalResultRef: {
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Id */
            id: string;
            /** Locator */
            locator?: null;
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
            /**
             * Result Type
             * @constant
             */
            result_type: "episode";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "episode";
        };
        /** EpubCandidate */
        EpubCandidate: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            description: components["schemas"]["Presence_str_-Output"];
            image: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Epub";
            kindFacts: components["schemas"]["EpubFacts"];
            publishedAt: components["schemas"]["Presence_datetime_"];
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default ProjectGutenberg
             * @constant
             */
            source: "ProjectGutenberg";
            /** Title */
            title: string;
        };
        /** EpubFacts */
        EpubFacts: {
            ebookRef: components["schemas"]["Presence_str_-Output"];
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
            description: components["schemas"]["Presence_str_-Output"];
            image: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Epub";
            kindFacts: components["schemas"]["EpubPreviewFacts"];
            publishedAt: components["schemas"]["Presence_datetime_"];
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default ProjectGutenberg
             * @constant
             */
            source: "ProjectGutenberg";
            /** Sourcehref */
            sourceHref: string;
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** EpubPreviewFacts */
        EpubPreviewFacts: {
            /** Ebookref */
            ebookRef: string;
            /** Importhref */
            importHref: string;
        };
        /** EpubReaderResumeState */
        "EpubReaderResumeState-Input": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "epub";
            locations: components["schemas"]["ReaderTextLocations"];
            target: components["schemas"]["ReaderEpubTarget-Input"];
            text: components["schemas"]["ReaderQuoteContext"];
        };
        /** EpubReaderResumeState */
        "EpubReaderResumeState-Output": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "epub";
            locations: components["schemas"]["ReaderTextLocations"];
            target: components["schemas"]["ReaderEpubTarget-Output"];
            text: components["schemas"]["ReaderQuoteContext"];
        };
        /** EpubTextOffsetsTargetOut */
        EpubTextOffsetsTargetOut: {
            /** End Offset */
            end_offset: number;
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "EpubTextOffsets";
            /** Start Offset */
            start_offset: number;
        };
        /** EvidenceSpanRetrievalResultRef */
        EvidenceSpanRetrievalResultRef: {
            /** Citation Label */
            citation_label: string;
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Evidence Span Id */
            evidence_span_id: string;
            /** Id */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id: string;
            /** Media Kind */
            media_kind?: string | null;
            /**
             * Result Type
             * @constant
             */
            result_type: "evidence_span";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "evidence_span";
        };
        /** ExcludeActivityIn */
        ExcludeActivityIn: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /** Devicehandle */
            deviceHandle: string;
            /**
             * Endedat
             * Format: date-time
             */
            endedAt: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Exclude";
            /** Mediaref */
            mediaRef: string;
            /**
             * Modality
             * @enum {string}
             */
            modality: "Reading" | "Listening" | "Viewing";
            /**
             * Startedat
             * Format: date-time
             */
            startedAt: string;
        };
        /** ExistingAuthorBinding */
        ExistingAuthorBinding: {
            /** Contributorhandle */
            contributorHandle: string;
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
            /** Insertion */
            insertion: components["schemas"]["EmptyInsertion"] | components["schemas"]["ReplyInsertion"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Existing";
        };
        /** ExternalContributorWorkItemOut */
        ExternalContributorWorkItemOut: {
            /** Actionsubject */
            actionSubject: null;
            /** Contentkind */
            contentKind: string;
            /** Date */
            date: string | null;
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "ExternalWork";
            /** Rolefacts */
            roleFacts: components["schemas"]["ContributorRoleFactOut"][];
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
        /** FailedSourceBaselineOutcome */
        FailedSourceBaselineOutcome: {
            /** Failure Code */
            failure_code: ("E_SOURCE_INTEGRITY" | "E_INVALID_FILE_TYPE" | "E_FILE_TOO_LARGE" | "E_CAPTURE_TOO_LARGE") | ("E_ARCHIVE_UNSAFE" | "E_BILLING_REQUIRED" | "E_CAPTURE_TOO_LARGE" | "E_FORBIDDEN" | "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH" | "E_INGEST_FAILED" | "E_INGEST_TIMEOUT" | "E_INTERNAL" | "E_INVALID_CONTENT_TYPE" | "E_INVALID_KIND" | "E_INVALID_REQUEST" | "E_LLM_BAD_REQUEST" | "E_MEDIA_NOT_FOUND" | "E_MEDIA_NOT_READY" | "E_OWNER_REQUIRED" | "E_PDF_PASSWORD_REQUIRED" | "E_PDF_TEXT_UNAVAILABLE" | "E_PODCAST_PROVIDER_UNAVAILABLE" | "E_PODCAST_QUOTA_EXCEEDED" | "E_REPAIR_NOT_ALLOWED" | "E_RESOURCE_CONFLICT" | "E_RESOURCE_LIMIT" | "E_RETRY_INVALID_STATE" | "E_RETRY_NOT_ALLOWED" | "E_SANITIZATION_FAILED" | "E_SELECTION_CHANGED" | "E_SIGN_UPLOAD_FAILED" | "E_SOURCE_ACCESS_DENIED" | "E_SOURCE_FETCH_FAILED" | "E_SOURCE_NOT_READABLE" | "E_SOURCE_TOO_LARGE" | "E_SSRF_BLOCKED" | "E_STORAGE_ERROR" | "E_STORAGE_MISSING" | "E_TRANSCRIPTION_FAILED" | "E_TRANSCRIPTION_TIMEOUT" | "E_TRANSCRIPT_UNAVAILABLE" | "E_UPLOAD_CAPABILITY_EXPIRED" | "E_UPLOAD_TRANSPORT_FAILED" | "E_WORKER_HANDLER_FAILED" | "E_WORKER_INTERRUPTED" | "E_X_POST_UNAVAILABLE" | "E_X_PROVIDER_AUTH_REJECTED" | "E_X_PROVIDER_CREDITS_DEPLETED" | "E_X_PROVIDER_RATE_LIMITED" | "E_X_PROVIDER_TIMEOUT" | "E_X_PROVIDER_UNAVAILABLE");
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Failed";
        };
        /** FinishLecternItemCommand */
        FinishLecternItemCommand: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /**
             * Itemid
             * Format: uuid
             */
            itemId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "FinishLecternItem";
            /**
             * Mediaid
             * Format: uuid
             */
            mediaId: string;
            /**
             * Nextcapability
             * @enum {string}
             */
            nextCapability: "Stop" | "FooterAudio" | "Readable";
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
            artworkUrl: components["schemas"]["Presence_str_-Output"];
            /** Chapters */
            chapters: components["schemas"]["ChapterOut"][];
            consumptionOverrideRevision: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Output"];
            durationMs: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "FooterAudio";
            pauseShorteningMode: components["schemas"]["Presence_Literal__Off____Natural___-Output"];
            playbackRate: components["schemas"]["PlaybackRateResolution"];
            /** Positionms */
            positionMs: number;
            /** Resetepoch */
            resetEpoch: number;
            /** Sourceurl */
            sourceUrl: string;
            /** Streamurl */
            streamUrl: string;
            /** Writerevision */
            writeRevision: number;
        };
        /** ForkOptionOut */
        ForkOptionOut: {
            /** Active */
            active: boolean;
            /** Assistant Message Id */
            assistant_message_id: string | null;
            /**
             * Branch Anchor Kind
             * @enum {string}
             */
            branch_anchor_kind: "none" | "assistant_message" | "assistant_selection";
            /** Branch Anchor Preview */
            branch_anchor_preview: string | null;
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
            /**
             * Leaf Message Id
             * Format: uuid
             */
            leaf_message_id: string;
            /** Message Count */
            message_count: number;
            /**
             * Parent Message Id
             * Format: uuid
             */
            parent_message_id: string;
            /** Preview */
            preview: string;
            /**
             * Status
             * @enum {string}
             */
            status: "complete" | "pending" | "error" | "cancelled";
            /** Title */
            title: string | null;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /**
             * User Message Id
             * Format: uuid
             */
            user_message_id: string;
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
        };
        /** FragmentOut */
        FragmentOut: {
            /** Canonical Text */
            canonical_text: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Document Embeds */
            document_embeds: components["schemas"]["DocumentEmbedOut"][];
            /** Document Word Start */
            document_word_start: number;
            /** Html Sanitized */
            html_sanitized: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Idx */
            idx: number;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Speaker Label */
            speaker_label: string | null;
            /** T End Ms */
            t_end_ms: number | null;
            /** T Start Ms */
            t_start_ms: number | null;
            /** Word Count */
            word_count: number;
        };
        /** FragmentRetrievalResultRef */
        FragmentRetrievalResultRef: {
            /** Citation Label */
            citation_label?: string | null;
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Id */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
            /**
             * Result Type
             * @constant
             */
            result_type: "fragment";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "fragment";
        };
        /** FromUrlRequest */
        FromUrlRequest: {
            /** Library Ids */
            library_ids?: string[];
            /**
             * Url
             * @description The URL to ingest. Must be an absolute http/https URL, including PDF, EPUB, article, or video URLs.
             */
            url: string;
        };
        /** FullHistoryCoverage */
        FullHistoryCoverage: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Full";
        };
        /** @enum {string} */
        GenerationApiProvider: "openai" | "anthropic" | "gemini" | "deepseek" | "xai";
        /** GenerationCatalog */
        GenerationCatalog: {
            chat_seed: components["schemas"]["ChatSeed"];
            /** Definition Revision */
            definition_revision: string;
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
            source_context_window: components["schemas"]["Presence_int_"];
            source_default_reasoning: components["schemas"]["Presence_str_-Output"];
            source_max_output_tokens: components["schemas"]["Presence_int_"];
        };
        /** GenerationReasoningRow */
        GenerationReasoningRow: {
            /** Chat State */
            chat_state: components["schemas"]["Selectable"] | components["schemas"]["Ineligible"] | components["schemas"]["OperatorActionRequired"] | components["schemas"]["TemporarilyUnavailable"];
            /** Key */
            key: string;
            /** Label */
            label: string;
            /** Readiness */
            readiness: components["schemas"]["Ready"] | components["schemas"]["OperatorActionRequired"] | components["schemas"]["TemporarilyUnavailable"];
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /** HighlightNoteAbsentOut */
        HighlightNoteAbsentOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * Kind
             * @default HighlightNote
             * @constant
             */
            kind: "HighlightNote";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            state: "Absent";
        };
        /** HighlightNotePresentOut */
        HighlightNotePresentOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * Kind
             * @default HighlightNote
             * @constant
             */
            kind: "HighlightNote";
            /**
             * Noteblockid
             * Format: uuid
             */
            noteBlockId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            state: "Present";
        };
        HighlightNoteResourceActionCapabilityOut: components["schemas"]["HighlightNoteAbsentOut"] | components["schemas"]["HighlightNotePresentOut"];
        /** HighlightRetrievalResultRef */
        HighlightRetrievalResultRef: {
            /** Citation Label */
            citation_label?: string | null;
            /** Citation Target */
            citation_target?: string | null;
            /** Color */
            color: string;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Exact */
            exact: string;
            /** Id */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
            /**
             * Result Type
             * @constant
             */
            result_type: "highlight";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "highlight";
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
         * @description One recorded event as every reader sees it.
         */
        HistoryEntry: {
            /** Facts */
            facts: components["schemas"]["UploadAccepted"] | components["schemas"]["UploadExecutionStarted"] | components["schemas"]["UploadFailed"] | components["schemas"]["UploadRecoveryAccepted"] | components["schemas"]["UploadPublished"] | components["schemas"]["UploadHistoryBaseline"] | components["schemas"]["SourceAccepted"] | components["schemas"]["SourceExecutionStarted"] | components["schemas"]["SourceStageChanged"] | components["schemas"]["SourceRetryScheduled"] | components["schemas"]["SourceFailed"] | components["schemas"]["SourceRecoveryAccepted"] | components["schemas"]["SourceSucceeded"] | components["schemas"]["SourceSuperseded"] | components["schemas"]["SourceHistoryBaseline"] | components["schemas"]["IndexAccepted"] | components["schemas"]["IndexExecutionStarted"] | components["schemas"]["IndexRetryScheduled"] | components["schemas"]["IndexFailed"] | components["schemas"]["IndexRecoveryAccepted"] | components["schemas"]["IndexSucceeded"] | components["schemas"]["IndexSuperseded"];
            failure_code: components["schemas"]["Presence_Union_Literal__E_SOURCE_INTEGRITY____E_INVALID_FILE_TYPE____E_FILE_TOO_LARGE____E_CAPTURE_TOO_LARGE____Literal__E_ARCHIVE_UNSAFE____E_BILLING_REQUIRED____E_CAPTURE_TOO_LARGE____E_FORBIDDEN____E_IDEMPOTENCY_KEY_REPLAY_MISMATCH____E_INGEST_FAILED____E_INGEST_TIMEOUT____E_INTERNAL____E_INVALID_CONTENT_TYPE____E_INVALID_KIND____E_INVALID_REQUEST____E_LLM_BAD_REQUEST____E_MEDIA_NOT_FOUND____E_MEDIA_NOT_READY____E_OWNER_REQUIRED____E_PDF_PASSWORD_REQUIRED____E_PDF_TEXT_UNAVAILABLE____E_PODCAST_PROVIDER_UNAVAILABLE____E_PODCAST_QUOTA_EXCEEDED____E_REPAIR_NOT_ALLOWED____E_RESOURCE_CONFLICT____E_RESOURCE_LIMIT____E_RETRY_INVALID_STATE____E_RETRY_NOT_ALLOWED____E_SANITIZATION_FAILED____E_SELECTION_CHANGED____E_SIGN_UPLOAD_FAILED____E_SOURCE_ACCESS_DENIED____E_SOURCE_FETCH_FAILED____E_SOURCE_NOT_READABLE____E_SOURCE_TOO_LARGE____E_SSRF_BLOCKED____E_STORAGE_ERROR____E_STORAGE_MISSING____E_TRANSCRIPTION_FAILED____E_TRANSCRIPTION_TIMEOUT____E_TRANSCRIPT_UNAVAILABLE____E_UPLOAD_CAPABILITY_EXPIRED____E_UPLOAD_TRANSPORT_FAILED____E_WORKER_HANDLER_FAILED____E_WORKER_INTERRUPTED____E_X_POST_UNAVAILABLE____E_X_PROVIDER_AUTH_REJECTED____E_X_PROVIDER_CREDITS_DEPLETED____E_X_PROVIDER_RATE_LIMITED____E_X_PROVIDER_TIMEOUT____E_X_PROVIDER_UNAVAILABLE____"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Occurred At
             * Format: date-time
             */
            occurred_at: string;
            stage: components["schemas"]["Presence_Literal__Upload____Validate____Extract____Finalize____Index____SourceProcessing___"];
        };
        /** HistoryPage */
        HistoryPage: {
            /** Entries */
            entries: components["schemas"]["HistoryEntry"][];
            next_cursor: components["schemas"]["Presence_str_-Output"];
        };
        /** ImportDetail */
        ImportDetail: {
            /** History Coverage */
            history_coverage: components["schemas"]["FullHistoryCoverage"] | components["schemas"]["PartialHistoryCoverage"];
            item: components["schemas"]["ImportItem"];
            readiness: components["schemas"]["ImportReadiness"];
            source_issues: components["schemas"]["Presence_ImportSourceIssues_"];
        };
        /** ImportItem */
        ImportItem: {
            /**
             * Accepted At
             * Format: date-time
             */
            accepted_at: string;
            capabilities: components["schemas"]["Capabilities"];
            matched_event: components["schemas"]["Presence_HistoryEntry_"];
            media_kind: components["schemas"]["MediaKind"];
            media_ref: components["schemas"]["Presence_Annotated_str__AfterValidator__"];
            /** Ref */
            ref: string;
            /** Source Issue Count */
            source_issue_count: number;
            source_label: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____"];
            /** State */
            state: components["schemas"]["ImportStateActive"] | components["schemas"]["ImportStateNeedsAttention"] | components["schemas"]["ImportStateComplete"];
            /** Title */
            title: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** ImportPage */
        ImportPage: {
            /** Groups */
            groups: components["schemas"]["ImportStageGroup"][];
            /** Items */
            items: components["schemas"]["ImportItem"][];
            /** Matched Count */
            matched_count: number;
            next_cursor: components["schemas"]["Presence_str_-Output"];
            /**
             * Observed At
             * Format: date-time
             */
            observed_at: string;
        };
        /** ImportReadiness */
        ImportReadiness: {
            /** Can Play */
            can_play: boolean;
            /** Can Read */
            can_read: boolean;
            /** Can Search */
            can_search: boolean;
        };
        /** ImportSourceIssues */
        ImportSourceIssues: {
            /** Generation */
            generation: number;
            /** Issues */
            issues: (components["schemas"]["MissingImage"] | components["schemas"]["UnresolvedNavigationTarget"])[];
        };
        /** ImportStageGroup */
        ImportStageGroup: {
            /** Count */
            count: number;
            /**
             * Stage
             * @enum {string}
             */
            stage: "Upload" | "Validate" | "Extract" | "Finalize" | "Index" | "SourceProcessing";
        };
        /** ImportStateActive */
        ImportStateActive: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Active";
            next_retry_at: components["schemas"]["Presence_datetime_"];
            progress: components["schemas"]["Presence_Annotated_Union_SourceStageProgress__SourceCountedProgress___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
            /**
             * Stage
             * @enum {string}
             */
            stage: "Upload" | "Validate" | "Extract" | "Finalize" | "Index" | "SourceProcessing";
            /**
             * Status
             * @enum {string}
             */
            status: "Queued" | "Processing";
            waiting_reason: components["schemas"]["Presence_Literal__Queue____Capacity____RetryBackoff___"];
        };
        /** ImportStateComplete */
        ImportStateComplete: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Complete";
        };
        /** ImportStateNeedsAttention */
        ImportStateNeedsAttention: {
            failure_code: components["schemas"]["Presence_Union_Literal__E_SOURCE_INTEGRITY____E_INVALID_FILE_TYPE____E_FILE_TOO_LARGE____E_CAPTURE_TOO_LARGE____Literal__E_ARCHIVE_UNSAFE____E_BILLING_REQUIRED____E_CAPTURE_TOO_LARGE____E_FORBIDDEN____E_IDEMPOTENCY_KEY_REPLAY_MISMATCH____E_INGEST_FAILED____E_INGEST_TIMEOUT____E_INTERNAL____E_INVALID_CONTENT_TYPE____E_INVALID_KIND____E_INVALID_REQUEST____E_LLM_BAD_REQUEST____E_MEDIA_NOT_FOUND____E_MEDIA_NOT_READY____E_OWNER_REQUIRED____E_PDF_PASSWORD_REQUIRED____E_PDF_TEXT_UNAVAILABLE____E_PODCAST_PROVIDER_UNAVAILABLE____E_PODCAST_QUOTA_EXCEEDED____E_REPAIR_NOT_ALLOWED____E_RESOURCE_CONFLICT____E_RESOURCE_LIMIT____E_RETRY_INVALID_STATE____E_RETRY_NOT_ALLOWED____E_SANITIZATION_FAILED____E_SELECTION_CHANGED____E_SIGN_UPLOAD_FAILED____E_SOURCE_ACCESS_DENIED____E_SOURCE_FETCH_FAILED____E_SOURCE_NOT_READABLE____E_SOURCE_TOO_LARGE____E_SSRF_BLOCKED____E_STORAGE_ERROR____E_STORAGE_MISSING____E_TRANSCRIPTION_FAILED____E_TRANSCRIPTION_TIMEOUT____E_TRANSCRIPT_UNAVAILABLE____E_UPLOAD_CAPABILITY_EXPIRED____E_UPLOAD_TRANSPORT_FAILED____E_WORKER_HANDLER_FAILED____E_WORKER_INTERRUPTED____E_X_POST_UNAVAILABLE____E_X_PROVIDER_AUTH_REJECTED____E_X_PROVIDER_CREDITS_DEPLETED____E_X_PROVIDER_RATE_LIMITED____E_X_PROVIDER_TIMEOUT____E_X_PROVIDER_UNAVAILABLE____"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "NeedsAttention";
            /**
             * Stage
             * @enum {string}
             */
            stage: "Upload" | "Validate" | "Extract" | "Finalize" | "Index" | "SourceProcessing";
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
        };
        /** InFlightSourceBaselineOutcome */
        InFlightSourceBaselineOutcome: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "InFlight";
        };
        /** InNexusMediaResolution */
        InNexusMediaResolution: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "InNexusMedia";
            mediaSummary: components["schemas"]["MediaSummaryOut"];
        };
        /** InNexusPodcastResolution */
        InNexusPodcastResolution: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "InNexusPodcast";
        };
        /** IncompleteChatFailure */
        IncompleteChatFailure: {
            /** Can Rerun */
            can_rerun: boolean;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            code: "incomplete";
        };
        /** IndexAccepted */
        IndexAccepted: {
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
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
             * Execution Id
             * Format: uuid
             */
            execution_id: string;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
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
            execution_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "IndexFailed";
            /**
             * Origin
             * @constant
             */
            origin: "Execution";
            /** Revision */
            revision: number;
            /** Terminal */
            terminal: boolean;
        };
        /** IndexRecoveryAccepted */
        IndexRecoveryAccepted: {
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
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
            execution_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "IndexRetryScheduled";
            /**
             * Next Attempt At
             * Format: date-time
             */
            next_attempt_at: string;
            /** Revision */
            revision: number;
        };
        /** IndexSucceeded */
        IndexSucceeded: {
            /**
             * Execution Id
             * Format: uuid
             */
            execution_id: string;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
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
             * Execution Id
             * Format: uuid
             */
            execution_id: string;
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
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
        /** InheritedLibraryPlacementRelationOut */
        InheritedLibraryPlacementRelationOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Inherited";
            /** Provenance */
            provenance: components["schemas"]["LibraryIdentityOut"][];
        };
        /** InsertNoteSurfaceCommand */
        InsertNoteSurfaceCommand: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /**
             * Note Id
             * Format: uuid
             */
            note_id: string;
            /** Position */
            position: components["schemas"]["SurfaceStartPosition"] | components["schemas"]["SurfaceAfterPosition"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "insert_note";
        };
        /** InsertResourceSurfaceCommand */
        InsertResourceSurfaceCommand: {
            /** Position */
            position: components["schemas"]["SurfaceStartPosition"] | components["schemas"]["SurfaceAfterPosition"];
            /** Target Ref */
            target_ref: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "insert_resource";
        };
        /** InvalidOutputChatFailure */
        InvalidOutputChatFailure: {
            /**
             * Can Rerun
             * @default false
             * @constant
             */
            can_rerun: false;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            code: "invalid_output";
        };
        /** InviteAcceptMembershipOut */
        InviteAcceptMembershipOut: {
            /**
             * Libraryid
             * Format: uuid
             */
            libraryId: string;
            /**
             * Role
             * @enum {string}
             */
            role: "admin" | "member";
            /** Userhandle */
            userHandle: string;
        };
        /** JoinNotesSurfaceCommand */
        JoinNotesSurfaceCommand: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /**
             * Earlier Link Id
             * Format: uuid
             */
            earlier_link_id: string;
            /**
             * Later Link Id
             * Format: uuid
             */
            later_link_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "join_notes";
        };
        /** LastPlacement */
        LastPlacement: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Last";
        };
        /** LatentDailyPageDescriptor */
        LatentDailyPageDescriptor: {
            /** Defaulttitle */
            defaultTitle: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Latent";
            /**
             * Localdate
             * Format: date
             */
            localDate: string;
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
             * Addedat
             * Format: date-time
             */
            addedAt: string;
            consumption: components["schemas"]["ConsumptionOut"];
            /** Href */
            href: string;
            /**
             * Itemid
             * Format: uuid
             */
            itemId: string;
            mediaSummary: components["schemas"]["MediaSummaryOut"];
            playerDisplay: components["schemas"]["Presence_PlayerDisplay_"];
        };
        /** LecternMembershipAbsentOut */
        LecternMembershipAbsentOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * Kind
             * @default LecternMembership
             * @constant
             */
            kind: "LecternMembership";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            state: "Absent";
        };
        /** LecternMembershipPresentOut */
        LecternMembershipPresentOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * Kind
             * @default LecternMembership
             * @constant
             */
            kind: "LecternMembership";
            /**
             * Lecternitemid
             * Format: uuid
             */
            lecternItemId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            state: "Present";
        };
        LecternMembershipResourceActionCapabilityOut: components["schemas"]["LecternMembershipAbsentOut"] | components["schemas"]["LecternMembershipPresentOut"];
        /** LecternNaturalEndOrigin */
        LecternNaturalEndOrigin: {
            /**
             * Itemid
             * Format: uuid
             */
            itemId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Lectern";
        };
        /** LecternResult */
        LecternResult: {
            lectern: components["schemas"]["LecternSnapshot"];
            /** Outcome */
            outcome: components["schemas"]["PlacedOutcome"] | components["schemas"]["RemovedOutcome"] | components["schemas"]["OrderedOutcome"];
        };
        /** LecternSnapshot */
        LecternSnapshot: {
            /** Items */
            items: components["schemas"]["LecternItemOut"][];
        };
        /** LibraryDeleteOut */
        LibraryDeleteOut: {
            /** Collectionrevision */
            collectionRevision: number;
            /**
             * Libraryid
             * Format: uuid
             */
            libraryId: string;
        };
        /** LibraryDestinationOut */
        LibraryDestinationOut: {
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
            /** Name */
            name: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** LibraryEntryMediaCapabilitiesOut */
        LibraryEntryMediaCapabilitiesOut: {
            /** Can Delete */
            can_delete: boolean;
            /** Can Edit Authors */
            can_edit_authors: boolean;
            /** Can Quote */
            can_quote: boolean;
            /** Can Refresh Source */
            can_refresh_source: boolean;
            /** Can Retry */
            can_retry: boolean;
            /** Can Retry Metadata */
            can_retry_metadata: boolean;
        };
        /** LibraryEntryMediaOut */
        LibraryEntryMediaOut: {
            /**
             * Author Mode
             * @enum {string}
             */
            author_mode: "automatic" | "manual";
            /** Canonical Source Url */
            canonical_source_url: string | null;
            capabilities: components["schemas"]["LibraryEntryMediaCapabilitiesOut"];
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
            /** Last Engaged At */
            last_engaged_at: string | null;
            /** Progress Fraction */
            progress_fraction: number | null;
            /** Progress Resettable */
            progress_resettable: boolean;
            /**
             * Read State
             * @enum {string}
             */
            read_state: "unread" | "in_progress" | "finished";
        };
        /** LibraryEntryOrderRequest */
        LibraryEntryOrderRequest: {
            /** Entry Ids */
            entry_ids: string[];
        };
        /** LibraryEntryPlacementOut */
        LibraryEntryPlacementOut: {
            /**
             * Libraryentryid
             * Format: uuid
             */
            libraryEntryId: string;
            /** Position */
            position: number;
        };
        /** LibraryEntryPodcastOut */
        LibraryEntryPodcastOut: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            publishedDate: components["schemas"]["Presence_datetime_"];
            /** Title */
            title: string;
            /**
             * Unplayedcount
             * @default 0
             */
            unplayedCount: number;
        };
        /** LibraryEntryPodcastSubscriptionOut */
        LibraryEntryPodcastSubscriptionOut: {
            /**
             * Autoqueue
             * @default false
             */
            autoQueue: boolean;
            defaultPlaybackSpeed: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Output"];
            pauseShorteningMode: components["schemas"]["Presence_Literal__Off____Natural___-Output"];
            syncStatus: components["schemas"]["PodcastSyncStatus"];
        };
        /** LibraryEntryRemovalOut */
        LibraryEntryRemovalOut: {
            /** Libraryentriescollectionrevision */
            libraryEntriesCollectionRevision: number;
        };
        /** LibraryGovernancePageInfo */
        LibraryGovernancePageInfo: {
            nextCursor: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____"];
        };
        /** LibraryIdentityOut */
        LibraryIdentityOut: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Name */
            name: string;
        };
        /** LibraryInvitationOut */
        LibraryInvitationOut: {
            /**
             * Createdat
             * Format: date-time
             */
            createdAt: string;
            /** Invitationhandle */
            invitationHandle: string;
            inviteeDisplayName: components["schemas"]["Presence_str_-Output"];
            inviteeEmail: components["schemas"]["Presence_str_-Output"];
            /** Inviteeuserhandle */
            inviteeUserHandle: string;
            /** Inviteruserhandle */
            inviterUserHandle: string;
            /**
             * Libraryid
             * Format: uuid
             */
            libraryId: string;
            respondedAt: components["schemas"]["Presence_datetime_"];
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
        /** LibraryLibraryPlacementDestinationOut */
        LibraryLibraryPlacementDestinationOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Library";
            library: components["schemas"]["LibraryIdentityOut"];
        };
        /** LibraryMediaListItemOut */
        LibraryMediaListItemOut: {
            /**
             * Addedat
             * Format: date-time
             */
            addedAt: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "media";
            media: components["schemas"]["LibraryEntryMediaOut"];
            mediaSummary: components["schemas"]["MediaSummaryOut"];
            placement: components["schemas"]["Presence_LibraryEntryPlacementOut_"];
        };
        /** LibraryMemberOut */
        LibraryMemberOut: {
            /**
             * Createdat
             * Format: date-time
             */
            createdAt: string;
            displayName: components["schemas"]["Presence_str_-Output"];
            email: components["schemas"]["Presence_str_-Output"];
            /** Isowner */
            isOwner: boolean;
            /**
             * Role
             * @enum {string}
             */
            role: "admin" | "member";
            /** Userhandle */
            userHandle: string;
        };
        /** LibraryOut */
        LibraryOut: {
            /** Candelete */
            canDelete: boolean;
            /** Caneditentries */
            canEditEntries: boolean;
            /** Canmanagemembers */
            canManageMembers: boolean;
            /** Canrename */
            canRename: boolean;
            /** Cantransferownership */
            canTransferOwnership: boolean;
            /**
             * Createdat
             * Format: date-time
             */
            createdAt: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Isdefault */
            isDefault: boolean;
            /** Name */
            name: string;
            /** Owneruserhandle */
            ownerUserHandle: string;
            /**
             * Role
             * @enum {string}
             */
            role: "admin" | "member";
            /** Systemkey */
            systemKey: string | null;
            /**
             * Updatedat
             * Format: date-time
             */
            updatedAt: string;
        };
        /** LibraryPageInfo */
        LibraryPageInfo: {
            /**
             * Has More
             * @default false
             */
            has_more: boolean;
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** LibraryPlacementOptionOut */
        LibraryPlacementOptionOut: {
            /** Availability */
            availability: components["schemas"]["AvailableLibraryPlacementAvailabilityOut"] | components["schemas"]["BlockedLibraryPlacementAvailabilityOut"];
            /** Destination */
            destination: components["schemas"]["SavedInNexusLibraryPlacementDestinationOut"] | components["schemas"]["LibraryLibraryPlacementDestinationOut"];
            /** Relation */
            relation: components["schemas"]["AbsentLibraryPlacementRelationOut"] | components["schemas"]["DirectLibraryPlacementRelationOut"] | components["schemas"]["InheritedLibraryPlacementRelationOut"];
        };
        /** LibraryPodcastListItemOut */
        LibraryPodcastListItemOut: {
            /**
             * Addedat
             * Format: date-time
             */
            addedAt: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "podcast";
            placement: components["schemas"]["Presence_LibraryEntryPlacementOut_"];
            podcast: components["schemas"]["LibraryEntryPodcastOut"];
            readingTimeEstimate: components["schemas"]["Presence_ReadingTimeEstimateOut_"];
            subscription: components["schemas"]["Presence_LibraryEntryPodcastSubscriptionOut_"];
        };
        /** LibraryRenameOut */
        LibraryRenameOut: {
            /** Collectionrevision */
            collectionRevision: number;
            library: components["schemas"]["LibraryOut"];
        };
        /** LinkAudienceIn */
        LinkAudienceIn: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Link";
        };
        /**
         * LinkFragmentSelectionSource
         * @description A reflowable selection materialized as a Highlight on confirmation.
         */
        LinkFragmentSelectionSource: {
            /**
             * Color
             * @enum {string}
             */
            color: "yellow" | "green" | "blue" | "pink" | "purple";
            /** End Offset */
            end_offset: number;
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
        /** LinkNoteOut */
        LinkNoteOut: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Body Text */
            body_text: string;
            connection: components["schemas"]["ConnectionOut"];
            /**
             * Note Block Id
             * Format: uuid
             */
            note_block_id: string;
            version_by_lane: components["schemas"]["NoteBodyVersionsOut"];
        };
        /**
         * LinkPassageTarget
         * @description A transient passage candidate, materialized into a ``passage_anchor`` on confirm.
         */
        LinkPassageTarget: {
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
         * @description A PDF page-space selection materialized as a Highlight on confirmation.
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
        /** LinkResourceSource */
        LinkResourceSource: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource";
            /** Ref */
            ref: string;
        };
        /** LinkResourceTarget */
        LinkResourceTarget: {
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
            /** Handle */
            handle: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Link";
            /** Publichref */
            publicHref: string;
        };
        /** LinkedNoteBlockRef */
        LinkedNoteBlockRef: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Body Text */
            body_text: string;
            /**
             * Note Block Id
             * Format: uuid
             */
            note_block_id: string;
            version_by_lane: components["schemas"]["NoteBodyVersionsOut"];
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
             * Capturekey
             * Format: uuid
             */
            captureKey: string;
            /** Durationms */
            durationMs: number;
            mediaPositionEndMs: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_9223372036854775807_____"];
            mediaPositionStartMs: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_9223372036854775807_____"];
            /**
             * Occurredat
             * Format: date-time
             */
            occurredAt: string;
            progressEnd: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____-Input"];
            progressStart: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____-Input"];
        };
        /** ListeningHeartbeatIn */
        ListeningHeartbeatIn: {
            durationMs: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Input"];
            episodePlaybackRate: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Input"];
            /** Expectedresetepoch */
            expectedResetEpoch: number;
            /** Expectedwriterevision */
            expectedWriteRevision: number;
            /**
             * Heartbeatgeneration
             * Format: uuid
             */
            heartbeatGeneration: string;
            /** Heartbeatsequence */
            heartbeatSequence: number;
            /** Positionms */
            positionMs: number;
        };
        /** ListeningHeartbeatResult */
        ListeningHeartbeatResult: {
            /**
             * Heartbeatgeneration
             * Format: uuid
             */
            heartbeatGeneration: string;
            /** Heartbeatsequence */
            heartbeatSequence: number;
            listeningState: components["schemas"]["nexus__schemas__consumption__ListeningStateOut"];
        };
        /** LocalDayOut */
        LocalDayOut: {
            /** Activems */
            activeMs: number;
            /**
             * Date
             * Format: date
             */
            date: string;
        };
        /** LocalHourOut */
        LocalHourOut: {
            /** Activems */
            activeMs: number;
            /** Hour */
            hour: number;
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
            /** Creditedname */
            creditedName: string;
        };
        /** ManualMediaAuthorsRequest */
        ManualMediaAuthorsRequest: {
            /** Authors */
            authors: components["schemas"]["ManualAuthorRowIn"][];
            /** Clientmutationid */
            clientMutationId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            mode: "manual";
        };
        /** MaterializedDailyPageDescriptor */
        MaterializedDailyPageDescriptor: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Materialized";
            /**
             * Localdate
             * Format: date
             */
            localDate: string;
            page: components["schemas"]["NotePageOut"];
            surface: components["schemas"]["ResourceSurfaceOut"];
        };
        /** MediaAbstractOut */
        MediaAbstractOut: {
            /**
             * Status
             * @enum {string}
             */
            status: "Building" | "Ready" | "Stale" | "Failed";
            summary_md: components["schemas"]["Presence_str_-Output"];
        };
        /** MediaActivityBreakdownOut */
        MediaActivityBreakdownOut: {
            /** Otheractivems */
            otherActiveMs: number;
            /** Rows */
            rows: components["schemas"]["MediaActivityOut"][];
        };
        /** MediaActivityOut */
        MediaActivityOut: {
            /** Activems */
            activeMs: number;
            /** Forwardmediapositionms */
            forwardMediaPositionMs: number;
            /** Forwardwordposition */
            forwardWordPosition: number;
            /** Mediaref */
            mediaRef: string;
            /** Title */
            title: string;
        };
        /** MediaCompletionOut */
        MediaCompletionOut: {
            /** Mediaref */
            mediaRef: string;
            /** Title */
            title: string;
            /** Total */
            total: number;
        };
        /** MediaContributorWorkItemOut */
        MediaContributorWorkItemOut: {
            actionSubject: components["schemas"]["ResourceActionSubjectOut"];
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Media";
            mediaSummary: components["schemas"]["MediaSummaryOut"];
            /** Rolefacts */
            roleFacts: components["schemas"]["ContributorRoleFactOut"][];
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
        /** MediaEvidenceEpubHighlightOut */
        MediaEvidenceEpubHighlightOut: {
            /** End Offset */
            end_offset: number;
            /**
             * Evidence Span Id
             * Format: uuid
             */
            evidence_span_id: string;
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "epub_text";
            /** Start Offset */
            start_offset: number;
            text_quote: components["schemas"]["MediaEvidenceTextQuoteOut"];
        };
        /** MediaEvidenceOut */
        MediaEvidenceOut: {
            /**
             * Evidence Span Id
             * Format: uuid
             */
            evidence_span_id: string;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            resolver: components["schemas"]["MediaEvidenceResolverOut"];
            /** Span Text */
            span_text: string;
        };
        /** MediaEvidencePdfGeometryOut */
        MediaEvidencePdfGeometryOut: {
            /**
             * Coordinate Space
             * @constant
             */
            coordinate_space: "pdf_points";
            /** Page Box */
            page_box?: string | null;
            /** Page Height */
            page_height: number;
            /** Page Rotation Degrees */
            page_rotation_degrees: number;
            /** Page Width */
            page_width: number;
            /** Projection */
            projection?: string | null;
            /** Quads */
            quads: components["schemas"]["MediaEvidencePdfQuadOut"][];
        };
        /** MediaEvidencePdfHighlightOut */
        MediaEvidencePdfHighlightOut: {
            /**
             * Evidence Span Id
             * Format: uuid
             */
            evidence_span_id: string;
            geometry?: components["schemas"]["MediaEvidencePdfGeometryOut"] | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "pdf_text";
            /** Page Label */
            page_label?: string | null;
            /** Page Number */
            page_number: number;
            text_quote: components["schemas"]["MediaEvidenceTextQuoteOut"];
        };
        /** MediaEvidencePdfQuadOut */
        MediaEvidencePdfQuadOut: {
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
        /** MediaEvidenceResolverOut */
        MediaEvidenceResolverOut: {
            /** Highlight */
            highlight: (components["schemas"]["MediaEvidenceWebHighlightOut"] | components["schemas"]["MediaEvidenceEpubHighlightOut"] | components["schemas"]["MediaEvidencePdfHighlightOut"] | components["schemas"]["MediaEvidenceTranscriptHighlightOut"]) | null;
            /**
             * Kind
             * @enum {string}
             */
            kind: "web" | "epub" | "pdf" | "transcript";
            /** Params */
            params: {
                [key: string]: string;
            };
            /**
             * Status
             * @enum {string}
             */
            status: "resolved" | "unresolved" | "no_geometry";
        };
        /** MediaEvidenceResponse */
        MediaEvidenceResponse: {
            data: components["schemas"]["MediaEvidenceOut"];
        };
        /** MediaEvidenceTextQuoteOut */
        MediaEvidenceTextQuoteOut: {
            /** Exact */
            exact: string;
            /** Prefix */
            prefix: string;
            /** Suffix */
            suffix: string;
        };
        /** MediaEvidenceTranscriptHighlightOut */
        MediaEvidenceTranscriptHighlightOut: {
            /**
             * Evidence Span Id
             * Format: uuid
             */
            evidence_span_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "transcript_time_text";
            /** T End Ms */
            t_end_ms?: number | null;
            /** T Start Ms */
            t_start_ms?: number | null;
            text_quote: components["schemas"]["MediaEvidenceTextQuoteOut"];
        };
        /** MediaEvidenceWebHighlightOut */
        MediaEvidenceWebHighlightOut: {
            /** End Offset */
            end_offset: number;
            /**
             * Evidence Span Id
             * Format: uuid
             */
            evidence_span_id: string;
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "web_text";
            /** Start Offset */
            start_offset: number;
            text_quote: components["schemas"]["MediaEvidenceTextQuoteOut"];
        };
        /**
         * MediaKind
         * @description Types of media that can be ingested.
         * @enum {string}
         */
        MediaKind: "web_article" | "epub" | "pdf" | "video" | "podcast_episode";
        /** MediaLibrariesRequest */
        MediaLibrariesRequest: {
            /** Library Ids */
            library_ids?: string[];
        };
        /** MediaNavigationOut */
        MediaNavigationOut: {
            /** Fragments */
            fragments: components["schemas"]["ReaderNavigationFragmentOut"][];
            /** Generation */
            generation: number;
            /**
             * Kind
             * @enum {string}
             */
            kind: "epub" | "web_article";
            /** Landmarks */
            landmarks: components["schemas"]["ReaderNavigationLocationOut"][];
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Page List */
            page_list: components["schemas"]["ReaderNavigationLocationOut"][];
            /** Sections */
            sections: components["schemas"]["ReaderNavigationSectionOut"][];
            /** Source Issues */
            source_issues: (components["schemas"]["MissingImage"] | components["schemas"]["UnresolvedNavigationTarget"])[];
            /** Toc Nodes */
            toc_nodes: components["schemas"]["ReaderNavigationTocNodeOut"][];
        };
        /**
         * MediaOut
         * @description The media detail wire: snake_case throughout except ``playerDescriptor``.
         *
         *     ``read_state`` / ``progress_fraction`` / ``progress_resettable`` and
         *     ``last_engaged_at`` are the viewer's derived consumption facts;
         *     ``player_descriptor`` is Present only for a podcast episode with playable
         *     audio. Routes serializing this model must dump ``by_alias=True``.
         */
        MediaOut: {
            /**
             * Author Mode
             * @default automatic
             * @enum {string}
             */
            author_mode: "automatic" | "manual";
            /** Canonical Source Url */
            canonical_source_url: string | null;
            canonical_url: components["schemas"]["Presence_str_-Output"];
            capabilities: components["schemas"]["CapabilitiesOut"];
            /** Chapters */
            chapters: components["schemas"]["PodcastEpisodeChapterOut"][];
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
            document_embed_summary: components["schemas"]["DocumentEmbedSummaryOut"] | null;
            duration: components["schemas"]["Presence_MediaDurationOut_"];
            edition_isbn: components["schemas"]["Presence_str_-Output"];
            edition_published_date: components["schemas"]["Presence_Annotated_str__StringConstraints__AfterValidator__"];
            /** Failure Stage */
            failure_stage: string | null;
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
            listening_state: components["schemas"]["nexus__schemas__media__ListeningStateOut"] | null;
            /** Metadata Enriched At */
            metadata_enriched_at: string | null;
            metadata_enrichment: components["schemas"]["MetadataEnrichmentView"];
            original_published_date: components["schemas"]["Presence_Annotated_str__StringConstraints__AfterValidator__"];
            playback_source: components["schemas"]["PlaybackSourceOut"] | null;
            playerDescriptor: components["schemas"]["Presence_PlayerDescriptor_"];
            /**
             * Processing Status
             * @enum {string}
             */
            processing_status: "pending" | "extracting" | "ready_for_reading" | "failed" | "suspended";
            /** Progress Fraction */
            progress_fraction: number | null;
            /** Progress Resettable */
            progress_resettable: boolean;
            provider: components["schemas"]["Presence_str_-Output"];
            provider_id: components["schemas"]["Presence_str_-Output"];
            /** Publisher */
            publisher: string | null;
            /** Read State */
            read_state: ("unread" | "in_progress" | "finished") | null;
            requested_url: components["schemas"]["Presence_str_-Output"];
            /** Retrieval Status */
            retrieval_status: string | null;
            /** Retrieval Status Reason */
            retrieval_status_reason: string | null;
            source_progress: components["schemas"]["Presence_Annotated_Union_SourceStageProgress__SourceCountedProgress___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
            /** Title */
            title: string;
            transcript_coverage: components["schemas"]["TranscriptCoverage"] | null;
            transcript_origin: components["schemas"]["Presence_Literal__Publisher____Imported____Generated___"];
            transcript_state: components["schemas"]["TranscriptState"] | null;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /**
         * MediaProcessingSnapshotOut
         * @description The complete data frame for media processing state and done events.
         */
        MediaProcessingSnapshotOut: {
            capabilities: components["schemas"]["CapabilitiesOut"];
            /** Failure Stage */
            failure_stage: string | null;
            /** Last Error Code */
            last_error_code: string | null;
            /**
             * Processing Status
             * @enum {string}
             */
            processing_status: "pending" | "extracting" | "ready_for_reading" | "failed" | "suspended";
            /** Retrieval Status */
            retrieval_status: string | null;
            /** Retrieval Status Reason */
            retrieval_status_reason: string | null;
            source_progress: components["schemas"]["Presence_Annotated_Union_SourceStageProgress__SourceCountedProgress___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
            transcript_coverage: components["schemas"]["TranscriptCoverage"] | null;
            transcript_state: components["schemas"]["TranscriptState"] | null;
            /** Updated At */
            updated_at: string;
        };
        /** MediaProgressState */
        MediaProgressState: {
            listeningState: components["schemas"]["Presence_ListeningStateOut_"];
            /**
             * Mediaid
             * Format: uuid
             */
            mediaId: string;
            /** Readercursor */
            readerCursor: components["schemas"]["ReaderCursorEmpty"] | components["schemas"]["ReaderCursorPositioned"];
        };
        /** MediaRetrievalResultRef */
        MediaRetrievalResultRef: {
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Id */
            id: string;
            /** Locator */
            locator?: null;
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
            /**
             * Result Type
             * @constant
             */
            result_type: "media";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "media";
        };
        /** MediaSlateTargetOut */
        MediaSlateTargetOut: {
            /** Href */
            href: string;
            imageUrl: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Media";
            mediaSummary: components["schemas"]["MediaSummaryOut"];
            /** Ref */
            ref: string;
        };
        /** MediaSummaryOut */
        MediaSummaryOut: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            duration: components["schemas"]["Presence_MediaDurationOut_"];
            /**
             * Mediaid
             * Format: uuid
             */
            mediaId: string;
            mediaKind: components["schemas"]["MediaKind"];
            originalPublishedDate: components["schemas"]["Presence_Annotated_str__StringConstraints__AfterValidator__"];
            /**
             * Processingstatus
             * @enum {string}
             */
            processingStatus: "pending" | "extracting" | "ready_for_reading" | "failed" | "suspended";
            /** Title */
            title: string;
        };
        /** MessageDocument */
        MessageDocument: {
            /** Blocks */
            blocks: components["schemas"]["MessageDocumentTextBlock"][];
            /**
             * Type
             * @default message_document
             * @constant
             */
            type: "message_document";
        };
        /** MessageDocumentTextBlock */
        MessageDocumentTextBlock: {
            /**
             * Format
             * @enum {string}
             */
            format: "plain" | "markdown";
            /** Text */
            text: string;
            /**
             * Type
             * @constant
             */
            type: "text";
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
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "message_offsets";
        };
        /** MessageOut */
        MessageOut: {
            /** Branch Anchor */
            branch_anchor: {
                [key: string]: unknown;
            };
            /**
             * Branch Anchor Kind
             * @default none
             * @enum {string}
             */
            branch_anchor_kind: "none" | "assistant_message" | "assistant_selection";
            /** Branch Root Message Id */
            branch_root_message_id: string | null;
            /**
             * Can Rerun
             * @default false
             */
            can_rerun: boolean;
            /** Citations */
            citations: components["schemas"]["CitationOut"][];
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
            message_document: components["schemas"]["MessageDocument"];
            /** Parent Message Id */
            parent_message_id: string | null;
            reader_selection: components["schemas"]["Presence_ReaderSelectionOut_"];
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
        /** MessageRetrievalResultRef */
        MessageRetrievalResultRef: {
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Conversation Id */
            conversation_id: string;
            /** Deep Link */
            deep_link: string;
            /** Id */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id?: null;
            /** Media Kind */
            media_kind?: null;
            /**
             * Result Type
             * @constant
             */
            result_type: "message";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Seq */
            seq: number;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "message";
        };
        /** MetadataCompletedOperation */
        MetadataCompletedOperation: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            generation_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            outcome: components["schemas"]["MetadataCompletedOutcome"];
            selection: components["schemas"]["Presence_MetadataSelection_"];
            started_at: components["schemas"]["Presence_AwareDatetime_"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "completed";
        };
        /** MetadataCompletedOutcome */
        MetadataCompletedOutcome: {
            /** Changed Fields */
            changed_fields: components["schemas"]["MetadataField"][];
            /**
             * Completed At
             * Format: date-time
             */
            completed_at: string;
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
        /** MetadataEnrichmentAccepted */
        MetadataEnrichmentAccepted: {
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
        };
        /** MetadataEnrichmentRequest */
        MetadataEnrichmentRequest: {
            /** Client Mutation Id */
            client_mutation_id: string;
            expected_job_id: components["schemas"]["Presence_UUID_-Input"];
        };
        /** MetadataEnrichmentView */
        MetadataEnrichmentView: {
            last_enriched_at: components["schemas"]["Presence_AwareDatetime_"];
            operation: components["schemas"]["Presence_MetadataOperationOut_"];
            retry: components["schemas"]["MetadataRetry"];
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
            generation_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            selection: components["schemas"]["Presence_MetadataSelection_"];
            started_at: components["schemas"]["Presence_AwareDatetime_"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "failed";
        };
        /** @enum {string} */
        MetadataFailureCode: "catalog_unavailable" | "configuration_error" | "model_unavailable" | "authentication_failed" | "quota_unavailable" | "research_timeout" | "invalid_output" | "input_too_large" | "output_limit" | "stale_input" | "no_longer_eligible" | "access_revoked" | "cancelled" | "policy_violation" | "worker_interrupted" | "execution_failed";
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
            generation_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            selection: components["schemas"]["Presence_MetadataSelection_"];
            started_at: components["schemas"]["Presence_AwareDatetime_"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "no_findings";
        };
        MetadataOperationOut: components["schemas"]["MetadataQueuedOperation"] | components["schemas"]["MetadataRunningOperation"] | components["schemas"]["MetadataRecoveringOperation"] | components["schemas"]["MetadataUncertainOperation"] | components["schemas"]["MetadataWaitingOperation"] | components["schemas"]["MetadataCompletedOperation"] | components["schemas"]["MetadataNoFindingsOperation"] | components["schemas"]["MetadataFailedOperation"];
        /** MetadataQueuedOperation */
        MetadataQueuedOperation: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            generation_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            selection: components["schemas"]["Presence_MetadataSelection_"];
            started_at: components["schemas"]["Presence_AwareDatetime_"];
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
            generation_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            selection: components["schemas"]["Presence_MetadataSelection_"];
            started_at: components["schemas"]["Presence_AwareDatetime_"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "recovering";
        };
        MetadataRetry: components["schemas"]["MetadataRetryAllowed"] | components["schemas"]["MetadataRetryBlocked"];
        /** MetadataRetryAllowed */
        MetadataRetryAllowed: {
            expected_job_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "allowed";
        };
        /** MetadataRetryBlocked */
        MetadataRetryBlocked: {
            /**
             * Reason
             * @enum {string}
             */
            reason: "not_creator" | "not_eligible" | "active" | "uncertain";
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
            generation_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            selection: components["schemas"]["Presence_MetadataSelection_"];
            started_at: components["schemas"]["Presence_AwareDatetime_"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "running";
        };
        /** MetadataSelection */
        MetadataSelection: {
            /** Model */
            model: string;
            /** Provider */
            provider: string;
            /** Reasoning */
            reasoning: string;
        };
        /** MetadataUncertainOperation */
        MetadataUncertainOperation: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            generation_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            selection: components["schemas"]["Presence_MetadataSelection_"];
            started_at: components["schemas"]["Presence_AwareDatetime_"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "uncertain";
        };
        /** MetadataWaitingOperation */
        MetadataWaitingOperation: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            generation_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /**
             * Reason
             * @constant
             */
            reason: "retry";
            selection: components["schemas"]["Presence_MetadataSelection_"];
            started_at: components["schemas"]["Presence_AwareDatetime_"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            status: "waiting";
            until: components["schemas"]["Presence_AwareDatetime_"];
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
        /** MoveOccurrenceSurfaceCommand */
        MoveOccurrenceSurfaceCommand: {
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            /** Position */
            position: components["schemas"]["SurfaceStartPosition"] | components["schemas"]["SurfaceAfterPosition"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "move_occurrence";
        };
        /**
         * NavigationTextPointOut
         * @description An exact canonical codepoint boundary within one source fragment.
         */
        NavigationTextPointOut: {
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /** Offset */
            offset: number;
        };
        /**
         * NavigationTextRangeOut
         * @description A semantic extent, potentially spanning several canonical fragments.
         */
        NavigationTextRangeOut: {
            end: components["schemas"]["NavigationTextPointOut"];
            start: components["schemas"]["NavigationTextPointOut"];
        };
        /** NewAuthorBinding */
        NewAuthorBinding: {
            /** Displayname */
            displayName: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "new";
        };
        /**
         * NewChatDestination
         * @description Create a fresh conversation atomically with this send — no pre-create.
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
            /** Client Mutation Id */
            client_mutation_id: string;
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
        /** NoBranchAnchorRequest */
        NoBranchAnchorRequest: {
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
            /** End Offset */
            end_offset: number;
            /** Start Offset */
            start_offset: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "note_block_offsets";
        };
        /** NoteBlockOut */
        NoteBlockOut: {
            /** Bodypmjson */
            bodyPmJson: {
                [key: string]: unknown;
            };
            /** Bodytext */
            bodyText: string;
            /**
             * Createdat
             * Format: date-time
             */
            createdAt: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Updatedat
             * Format: date-time
             */
            updatedAt: string;
            /** Versionbylane */
            versionByLane: {
                [key: string]: number;
            };
        };
        /** NoteBlockRetrievalResultRef */
        NoteBlockRetrievalResultRef: {
            /** Body Text */
            body_text: string;
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Highlight Excerpt */
            highlight_excerpt?: string | null;
            /** Id */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id?: null;
            /** Media Kind */
            media_kind?: null;
            /**
             * Result Type
             * @constant
             */
            result_type: "note_block";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "note_block";
        };
        /** NoteBodySurfaceContent */
        NoteBodySurfaceContent: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Body Text */
            body_text: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "note_body";
        };
        /** NoteBodyVersionsOut */
        NoteBodyVersionsOut: {
            /** Body */
            body: number;
            /** Links */
            links: number;
        };
        /** NotePageOut */
        NotePageOut: {
            dailyPage: components["schemas"]["Presence_DailyPageSummaryOut_"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Title */
            title: string;
            /**
             * Updatedat
             * Format: date-time
             */
            updatedAt: string;
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
             * Updatedat
             * Format: date-time
             */
            updatedAt: string;
        };
        /** NotePagesOut */
        NotePagesOut: {
            /** Pages */
            pages: components["schemas"]["NotePageSummaryOut"][];
        };
        /** OfflineReaderWrite */
        OfflineReaderWrite: {
            /** Baserevision */
            baseRevision: number;
            /** Expectedreadergeneration */
            expectedReaderGeneration: number;
            /** Locator */
            locator: components["schemas"]["PdfReaderResumeState"] | components["schemas"]["WebReaderResumeState"] | components["schemas"]["TranscriptReaderResumeState"] | components["schemas"]["EpubReaderResumeState-Input"];
        };
        /** OfflineReadingResourceActionCapabilityOut */
        OfflineReadingResourceActionCapabilityOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "OfflineReading";
            /**
             * Mediakind
             * @enum {string}
             */
            mediaKind: "web_article" | "epub" | "pdf";
            /** Requestedtitle */
            requestedTitle: string;
        };
        /** OpenPaneActivation */
        OpenPaneActivation: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "OpenPane";
        };
        /** OpenSourceResourceActionCapabilityOut */
        OpenSourceResourceActionCapabilityOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
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
            code: "catalog_refresh_failed" | "codex_host_unavailable" | "credential_unavailable" | "required_tool_unavailable";
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
        /** OperatorDefectChatFailure */
        OperatorDefectChatFailure: {
            /**
             * Can Rerun
             * @default false
             * @constant
             */
            can_rerun: false;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            code: "operator_defect";
        };
        /** OracleBindEventPayload */
        OracleBindEventPayload: {
            /** Folio Motto */
            folio_motto: string;
            /** Folio Motto Gloss */
            folio_motto_gloss: string | null;
            folio_theme: components["schemas"]["OracleFolioTheme"];
        };
        /**
         * OracleCompleteDoneEventPayload
         * @description Successful terminal payload; success never carries an error code.
         */
        OracleCompleteDoneEventPayload: {
            /** Error Code */
            error_code: null;
            /**
             * Status
             * @constant
             */
            status: "complete";
        };
        /**
         * OracleFailedDoneEventPayload
         * @description Expected product terminal payload; defects have no variant.
         */
        OracleFailedDoneEventPayload: {
            error_code: components["schemas"]["OracleReadingFailureCode"];
            /**
             * Status
             * @constant
             */
            status: "failed";
        };
        /** @enum {string} */
        OracleFolioTheme: "Of Time" | "Of Death" | "Of the Threshold" | "Of Vanity" | "Of Solitude" | "Of Love" | "Of Fortune" | "Of Memory" | "Of the Self" | "Of the Other" | "Of Fear" | "Of Courage" | "Of Faith" | "Of Doubt" | "Of Power" | "Of Wisdom" | "Of the Body" | "Of the Soul" | "Of Origins" | "Of Endings" | "Of Silence" | "Of the Word" | "Of Justice" | "Of Mercy";
        /** OracleMetaEventPayload */
        OracleMetaEventPayload: {
            /** Folio Number */
            folio_number: number;
            /** Question */
            question: string;
        };
        /** OracleOmensEventPayload */
        OracleOmensEventPayload: {
            /** Lines */
            lines: [
                string,
                string,
                string
            ];
        };
        /**
         * OracleReadingCreateRequest
         * @description User-submitted divination question.
         */
        OracleReadingCreateRequest: {
            /** Question */
            question: string;
        };
        /** @enum {string} */
        OracleReadingFailureCode: "auth" | "quota" | "timeout" | "output_limit" | "invalid_output" | "policy_violation" | "runtime_unavailable" | "capacity_unavailable" | "context_too_large" | "cancelled" | "E_ORACLE_CORPUS_NOT_READY" | "E_APP_SEARCH_FAILED" | "E_GENERATION_SOURCE_CHANGED" | "E_RATE_LIMITED";
        /**
         * OracleReadingImageOut
         * @description Plate displayed atop a reading.
         */
        OracleReadingImageOut: {
            /** Artist */
            artist: string;
            /** Attribution Text */
            attribution_text: string;
            /** Height */
            height: number;
            /** Url */
            url: string;
            /** Width */
            width: number;
            /** Work Title */
            work_title: string;
            /** Year */
            year: string | null;
        };
        /**
         * OracleReadingPassageOut
         * @description One persisted citation in a reading.
         *
         *     ``citation`` is the read-model CitationOut when the persisted citation edge
         *     resolves to a live shared reader/note locator. Resolved public-domain anchors
         *     render the same chip path as user content; unresolved or span-less targets
         *     carry ``None`` and remain typographic only.
         */
        OracleReadingPassageOut: {
            /** Attribution Text */
            attribution_text: string;
            citation: components["schemas"]["CitationOut"] | null;
            /** Deep Link */
            deep_link: string | null;
            /** Exact Snippet */
            exact_snippet: string;
            /** Locator Label */
            locator_label: string;
            /** Marginalia Text */
            marginalia_text: string;
            phase: components["schemas"]["OracleReadingPhase"];
            source_kind: components["schemas"]["OracleReadingSourceKind"];
        };
        /** @enum {string} */
        OracleReadingPhase: "descent" | "ordeal" | "ascent";
        /** @enum {string} */
        OracleReadingSourceKind: "user_media" | "public_domain";
        /** OracleTextEventPayload */
        OracleTextEventPayload: {
            /** Text */
            text: string;
        };
        /** OrderedOutcome */
        OrderedOutcome: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Ordered";
        };
        /** OutlineNote */
        OutlineNote: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /**
             * Note Id
             * Format: uuid
             */
            note_id: string;
            /** Parent Index */
            parent_index?: number | null;
        };
        /** OwnedMediaCandidate */
        OwnedMediaCandidate: {
            description: components["schemas"]["Presence_str_-Output"];
            image: components["schemas"]["Presence_str_-Output"];
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
        /**
         * PageInfo
         * @description Manual-paging cursor envelope for retained conversation context queries.
         */
        PageInfo: {
            /** Next Cursor */
            next_cursor: string | null;
        };
        /** PageRetrievalResultRef */
        PageRetrievalResultRef: {
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Id */
            id: string;
            /** Locator */
            locator?: null;
            /** Media Id */
            media_id?: null;
            /** Media Kind */
            media_kind?: null;
            /**
             * Result Type
             * @constant
             */
            result_type: "page";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "page";
        };
        /** PageTitleSurfaceContent */
        PageTitleSurfaceContent: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "page_title";
            /** Title */
            title: string;
        };
        /**
         * PartialHistoryCoverage
         * @description Detailed execution history was not recorded before `recorded_since`.
         */
        PartialHistoryCoverage: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Partial";
            /**
             * Recorded Since
             * Format: date-time
             */
            recorded_since: string;
        };
        /** PasteOutlineSurfaceCommand */
        PasteOutlineSurfaceCommand: {
            /** Items */
            items: components["schemas"]["OutlineNote"][];
            /** Position */
            position: components["schemas"]["SurfaceStartPosition"] | components["schemas"]["SurfaceAfterPosition"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "paste_outline";
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
        /** PdfPageGeometryTargetOut */
        PdfPageGeometryTargetOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "PdfPageGeometry";
            /** Page Number */
            page_number: number;
            /** Quads */
            quads: components["schemas"]["HighlightTargetPdfQuadOut"][];
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
        /** PlaceItemsCommand */
        PlaceItemsCommand: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "PlaceItems";
            /** Mediaids */
            mediaIds: string[];
            /** Placement */
            placement: components["schemas"]["FirstPlacement"] | components["schemas"]["AfterPlacement"] | components["schemas"]["LastPlacement"];
        };
        /** PlacedOutcome */
        PlacedOutcome: {
            /** Itemids */
            itemIds: string[];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Placed";
        };
        /** PlaybackRateResolution */
        PlaybackRateResolution: {
            podcastPreference: components["schemas"]["Presence_PodcastPlaybackPreference_"];
            /**
             * Source
             * @enum {string}
             */
            source: "Episode" | "Podcast" | "Product";
            /** Value */
            value: number;
        };
        /** PlaybackResourceActionCapabilityOut */
        PlaybackResourceActionCapabilityOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Playback";
            playerDescriptor: components["schemas"]["PlayerDescriptor"];
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
        /** PlayerDescriptor */
        PlayerDescriptor: {
            activation: components["schemas"]["FooterAudioActivation"];
            /**
             * Mediaid
             * Format: uuid
             */
            mediaId: string;
            subtitle: components["schemas"]["Presence_str_-Output"];
            /** Title */
            title: string;
        };
        /** PlayerDisplay */
        PlayerDisplay: {
            subtitle: components["schemas"]["Presence_str_-Output"];
            /** Title */
            title: string;
        };
        /** PodcastBackfillOut */
        PodcastBackfillOut: {
            /** Addedcount */
            addedCount: number;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Processedcount */
            processedCount: number;
            /**
             * State
             * @enum {string}
             */
            state: "Pending" | "Running" | "Complete" | "SourceLimited" | "Failed";
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
             * Podcastid
             * Format: uuid
             */
            podcastId: string;
        };
        /** PodcastCandidate */
        PodcastCandidate: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            description: components["schemas"]["Presence_str_-Output"];
            image: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcast";
            kindFacts: components["schemas"]["PodcastFacts"];
            publishedAt: components["schemas"]["Presence_datetime_"];
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default PodcastIndex
             * @constant
             */
            source: "PodcastIndex";
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
             * Podcastid
             * Format: uuid
             */
            podcastId: string;
        };
        /** PodcastContributorWorkItemOut */
        PodcastContributorWorkItemOut: {
            actionSubject: components["schemas"]["ResourceActionSubjectOut"];
            /** Contentkind */
            contentKind: string;
            /** Date */
            date: string | null;
            /** Href */
            href: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcast";
            /** Rolefacts */
            roleFacts: components["schemas"]["ContributorRoleFactOut"][];
            /** Title */
            title: string;
        };
        /** PodcastDetailOut */
        PodcastDetailOut: {
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
        /** PodcastEpisodeFromDiscoveryRequest */
        PodcastEpisodeFromDiscoveryRequest: {
            /** Namedlibraryids */
            namedLibraryIds?: string[];
            /** Target */
            target: string;
        };
        /** PodcastEpisodeQueryTranscriptForecastOut */
        PodcastEpisodeQueryTranscriptForecastOut: {
            /** Eligiblecount */
            eligibleCount: number;
            /** Selectionfingerprint */
            selectionFingerprint: string;
        };
        /** PodcastEpisodeQueryTranscriptRequest */
        PodcastEpisodeQueryTranscriptRequest: {
            /** Selectionfingerprint */
            selectionFingerprint: string;
            target: components["schemas"]["PodcastEpisodeQueryTranscriptTarget"];
        };
        /** PodcastEpisodeQueryTranscriptRequestOut */
        PodcastEpisodeQueryTranscriptRequestOut: {
            /** Collectionrevision */
            collectionRevision: number;
            /** Matchedcount */
            matchedCount: number;
            /** Queuedcount */
            queuedCount: number;
        };
        /** PodcastEpisodeQueryTranscriptTarget */
        PodcastEpisodeQueryTranscriptTarget: {
            /**
             * Kind
             * @constant
             */
            kind: "PodcastEpisodeQuery";
            /**
             * Podcastid
             * Format: uuid
             */
            podcastId: string;
            /**
             * Reason
             * @enum {string}
             */
            reason: "search" | "highlight" | "quote";
            selection: components["schemas"]["PodcastEpisodeSelection"];
        };
        /**
         * PodcastEpisodeSelection
         * @description Membership-defining episode state shared by list-wide commands.
         */
        PodcastEpisodeSelection: {
            /**
             * State
             * @enum {string}
             */
            state: "all" | "unplayed" | "in_progress" | "played";
        };
        /** PodcastFacts */
        PodcastFacts: {
            /** Podcastref */
            podcastRef: string;
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
        /** PodcastPlacementAdditionOut */
        PodcastPlacementAdditionOut: {
            /** Libraryentriescollectionrevision */
            libraryEntriesCollectionRevision: number;
            /**
             * Outcome
             * @enum {string}
             */
            outcome: "Added" | "AlreadyPresent";
        };
        /** PodcastPlacementRemovalOut */
        PodcastPlacementRemovalOut: {
            /** Libraryentriescollectionrevision */
            libraryEntriesCollectionRevision: number;
            /**
             * Outcome
             * @enum {string}
             */
            outcome: "Removed" | "AlreadyAbsent";
        };
        /** PodcastPlaybackPreference */
        PodcastPlaybackPreference: {
            /**
             * Podcastid
             * Format: uuid
             */
            podcastId: string;
            value: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Output"];
        };
        /** PodcastPreview */
        PodcastPreview: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            description: components["schemas"]["Presence_str_-Output"];
            episodes: components["schemas"]["PodcastPreviewEpisodePage"];
            image: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcast";
            kindFacts: components["schemas"]["PodcastPreviewFacts"];
            publishedAt: components["schemas"]["Presence_datetime_"];
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default PodcastIndex
             * @constant
             */
            source: "PodcastIndex";
            /** Sourcehref */
            sourceHref: string;
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** PodcastPreviewEpisode */
        PodcastPreviewEpisode: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            description: components["schemas"]["Presence_str_-Output"];
            image: components["schemas"]["Presence_str_-Output"];
            kindFacts: components["schemas"]["EpisodePreviewFacts"];
            publishedAt: components["schemas"]["Presence_datetime_"];
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** PodcastPreviewEpisodePage */
        PodcastPreviewEpisodePage: {
            /** Items */
            items: components["schemas"]["PodcastPreviewEpisode"][];
            nextCursor: components["schemas"]["Presence_str_-Output"];
        };
        /** PodcastPreviewFacts */
        PodcastPreviewFacts: {
            /** Feedhref */
            feedHref: string;
            /** Podcastref */
            podcastRef: string;
            websiteHref: components["schemas"]["Presence_str_-Output"];
        };
        /** PodcastRefreshAcceptedOut */
        PodcastRefreshAcceptedOut: {
            /** Requestedcount */
            requestedCount: number;
        };
        /** PodcastRefreshLibraryScope */
        PodcastRefreshLibraryScope: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Library";
            /**
             * Libraryid
             * Format: uuid
             */
            libraryId: string;
        };
        /** PodcastRefreshPodcastScope */
        PodcastRefreshPodcastScope: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcast";
            /**
             * Podcastid
             * Format: uuid
             */
            podcastId: string;
        };
        /** PodcastRefreshPodcastsScope */
        PodcastRefreshPodcastsScope: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcasts";
        };
        /** PodcastReplacementConfirmation */
        PodcastReplacementConfirmation: {
            /** Conflictfingerprint */
            conflictFingerprint: string;
        };
        /** PodcastRetrievalResultRef */
        PodcastRetrievalResultRef: {
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Contributors */
            contributors?: {
                [key: string]: unknown;
            }[];
            /** Deep Link */
            deep_link: string;
            /** Id */
            id: string;
            /** Locator */
            locator?: null;
            /** Media Id */
            media_id?: null;
            /** Media Kind */
            media_kind?: null;
            /**
             * Result Type
             * @constant
             */
            result_type: "podcast";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "podcast";
        };
        /** PodcastSlateTargetOut */
        PodcastSlateTargetOut: {
            /** Href */
            href: string;
            imageUrl: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Podcast";
            /** Ref */
            ref: string;
            subtitle: components["schemas"]["Presence_str_-Output"];
            /** Title */
            title: string;
        };
        /** PodcastSubscribeDestinationOutcomeOut */
        PodcastSubscribeDestinationOutcomeOut: {
            /**
             * Libraryid
             * Format: uuid
             */
            libraryId: string;
            /**
             * Outcome
             * @enum {string}
             */
            outcome: "Added" | "AlreadyPresent";
        };
        /** PodcastSubscribeOut */
        PodcastSubscribeOut: {
            backfill: components["schemas"]["PodcastBackfillOut"];
            /** Collectionrevision */
            collectionRevision: number;
            /** Destinations */
            destinations: components["schemas"]["PodcastSubscribeDestinationOutcomeOut"][];
            /** Href */
            href: string;
            /** Libraryentriescollectionrevision */
            libraryEntriesCollectionRevision: number;
            /**
             * Outcome
             * @enum {string}
             */
            outcome: "Subscribed" | "AlreadySubscribed" | "DestinationsAdded";
            /**
             * Podcastid
             * Format: uuid
             */
            podcastId: string;
        };
        /** PodcastSubscribeRequest */
        PodcastSubscribeRequest: {
            /** Namedlibraryids */
            namedLibraryIds?: string[];
            replacementConfirmation: components["schemas"]["Presence_PodcastReplacementConfirmation_"];
            /** Target */
            target: components["schemas"]["PodcastDiscoveryCommitTarget"] | components["schemas"]["PodcastCanonicalCommitTarget"];
        };
        /**
         * PodcastSubscriptionLifecycleSnapshotOut
         * @description One viewer-owned subscription's live sync and initial-backfill state.
         */
        PodcastSubscriptionLifecycleSnapshotOut: {
            backfill: components["schemas"]["PodcastBackfillOut"];
            /**
             * Podcastid
             * Format: uuid
             */
            podcastId: string;
            syncStatus: components["schemas"]["PodcastSyncStatus"];
        };
        /**
         * PodcastSubscriptionListItemOut
         * @description Compact row projection for the followed-Podcasts collection.
         */
        PodcastSubscriptionListItemOut: {
            /** Auto Queue */
            auto_queue: boolean;
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            default_playback_speed: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Output"];
            latest_episode_published_at: components["schemas"]["Presence_datetime_"];
            pause_shortening_mode: components["schemas"]["Presence_Literal__Off____Natural___-Output"];
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
        /** PodcastSubscriptionResourceActionCapabilityOut */
        PodcastSubscriptionResourceActionCapabilityOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "PodcastSubscription";
            /**
             * State
             * @enum {string}
             */
            state: "Subscribed" | "Unsubscribed";
        };
        /** PodcastSubscriptionSettingsOut */
        PodcastSubscriptionSettingsOut: {
            /**
             * Auto Queue
             * @default false
             */
            auto_queue: boolean;
            backfill: components["schemas"]["PodcastBackfillOut"];
            /** Collectionrevision */
            collectionRevision: number;
            default_playback_speed: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Output"];
            /** Last Checked At */
            last_checked_at: string | null;
            /** Libraryentriescollectionrevision */
            libraryEntriesCollectionRevision: number;
            pause_shortening_mode: components["schemas"]["Presence_Literal__Off____Natural___-Output"];
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
            /** Sync Attempts */
            sync_attempts: number;
            /** Sync Completed At */
            sync_completed_at: string | null;
            /** Sync Error Code */
            sync_error_code: string | null;
            /** Sync Error Message */
            sync_error_message: string | null;
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
        /** PodcastSubscriptionSettingsPatchRequest */
        PodcastSubscriptionSettingsPatchRequest: {
            /** Auto Queue */
            auto_queue?: boolean | null;
            default_playback_speed?: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Input"];
            pause_shortening_mode?: components["schemas"]["Presence_Literal__Off____Natural___-Input"];
        };
        /** PodcastSubscriptionStatusOut */
        PodcastSubscriptionStatusOut: {
            /**
             * Auto Queue
             * @default false
             */
            auto_queue: boolean;
            backfill: components["schemas"]["PodcastBackfillOut"];
            default_playback_speed: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Output"];
            /** Last Checked At */
            last_checked_at: string | null;
            pause_shortening_mode: components["schemas"]["Presence_Literal__Off____Natural___-Output"];
            /**
             * Podcast Id
             * Format: uuid
             */
            podcast_id: string;
            /** Sync Attempts */
            sync_attempts: number;
            /** Sync Completed At */
            sync_completed_at: string | null;
            /** Sync Error Code */
            sync_error_code: string | null;
            /** Sync Error Message */
            sync_error_message: string | null;
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
        /** @enum {string} */
        PodcastSyncStatus: "Pending" | "Running" | "Complete" | "SourceLimited" | "Failed";
        Presence_ActivitySessionOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_ActivitySessionOut_"];
        Presence_Annotated_Union_RetryUploadOffer__RetrySourceOffer__RepairSourceOffer__RepairSearchOffer___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_Union_RetryUploadOffer__RetrySourceOffer__RepairSourceOffer__RepairSearchOffer___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
        Presence_Annotated_Union_SourceStageProgress__SourceCountedProgress___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_Union_SourceStageProgress__SourceCountedProgress___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
        Presence_Annotated_Union_UploadTransportNetworkFailure__UploadTransportTimeoutFailure__UploadTransportHttpRejectedFailure__UploadTransportAbortedFailure___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_Union_UploadTransportNetworkFailure__UploadTransportTimeoutFailure__UploadTransportHttpRejectedFailure__UploadTransportAbortedFailure___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
        Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__0__0_____: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__0__0_____"];
        "Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____-Input": components["schemas"]["Absent-Input"] | components["schemas"]["Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____-Input"];
        "Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____-Output": components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____-Output"];
        "Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Input": components["schemas"]["Absent-Input"] | components["schemas"]["Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Input"];
        "Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Output": components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Output"];
        "Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Input": components["schemas"]["Absent-Input"] | components["schemas"]["Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Input"];
        "Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Output": components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Output"];
        Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_9223372036854775807_____: components["schemas"]["Absent-Input"] | components["schemas"]["Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_9223372036854775807_____"];
        Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___Ge_ge_0___Le_le_2147483647_____: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___Ge_ge_0___Le_le_2147483647_____"];
        Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___Ge_ge_1_____: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___Ge_ge_1_____"];
        Presence_Annotated_list_Literal__media____library____evidence_span____content_chunk____highlight____page____note_block____fragment____conversation____message____oracle_reading____oracle_passage_anchor____artifact____artifact_revision____external_snapshot____contributor____podcast____reader_apparatus_item____passage_anchor_____FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____: components["schemas"]["Absent-Input"] | components["schemas"]["Present_Annotated_list_Literal__media____library____evidence_span____content_chunk____highlight____page____note_block____fragment____conversation____message____oracle_reading____oracle_passage_anchor____artifact____artifact_revision____external_snapshot____contributor____podcast____reader_apparatus_item____passage_anchor_____FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____"];
        Presence_Annotated_str__AfterValidator__: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_str__AfterValidator__"];
        Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_128_____: components["schemas"]["Absent-Input"] | components["schemas"]["Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_128_____"];
        Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_200_____: components["schemas"]["Absent-Input"] | components["schemas"]["Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_200_____"];
        Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____"];
        "Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__-Input": components["schemas"]["Absent-Input"] | components["schemas"]["Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__-Input"];
        "Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__-Output": components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__-Output"];
        Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___MinLen_min_length_1_____: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___MinLen_min_length_1_____"];
        "Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata___PydanticGeneralMetadata_pattern___ncc1_____A-Za-z0-9_-__22______A-Za-z0-9_-__22________": components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata___PydanticGeneralMetadata_pattern___ncc1_____A-Za-z0-9_-__22______A-Za-z0-9_-__22________"];
        Presence_Annotated_str__StringConstraints__AfterValidator__: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Annotated_str__StringConstraints__AfterValidator__"];
        Presence_AwareDatetime_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_AwareDatetime_"];
        Presence_BrowseSort_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_BrowseSort_"];
        Presence_ChatPublicationWarning_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_ChatPublicationWarning_"];
        Presence_ChatRunExecutionOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_ChatRunExecutionOut_"];
        Presence_ConsumptionOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_ConsumptionOut_"];
        Presence_DailyPageSummaryOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_DailyPageSummaryOut_"];
        Presence_DossierBuildOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_DossierBuildOut_"];
        Presence_DossierFailureCode_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_DossierFailureCode_"];
        Presence_DossierRevisionOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_DossierRevisionOut_"];
        Presence_DurableExecutionPhase_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_DurableExecutionPhase_"];
        Presence_HistoryEntry_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_HistoryEntry_"];
        Presence_ImportSourceIssues_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_ImportSourceIssues_"];
        Presence_LecternItemOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_LecternItemOut_"];
        Presence_LibraryEntryPlacementOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_LibraryEntryPlacementOut_"];
        Presence_LibraryEntryPodcastSubscriptionOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_LibraryEntryPodcastSubscriptionOut_"];
        Presence_ListeningStateOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_ListeningStateOut_"];
        Presence_Literal__NotOwner____SameSourceTerminal____SourceNotReacquirable____UploadRejected___: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Literal__NotOwner____SameSourceTerminal____SourceNotReacquirable____UploadRejected___"];
        "Presence_Literal__Off____Natural___-Input": components["schemas"]["Absent-Input"] | components["schemas"]["Present_Literal__Off____Natural___-Input"];
        "Presence_Literal__Off____Natural___-Output": components["schemas"]["Absent-Output"] | components["schemas"]["Present_Literal__Off____Natural___-Output"];
        Presence_Literal__Publisher____Imported____Generated___: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Literal__Publisher____Imported____Generated___"];
        Presence_Literal__Queue____Capacity____RetryBackoff___: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Literal__Queue____Capacity____RetryBackoff___"];
        Presence_Literal__Upload____Validate____Extract____Finalize____Index____SourceProcessing___: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Literal__Upload____Validate____Extract____Finalize____Index____SourceProcessing___"];
        Presence_MediaAbstractOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_MediaAbstractOut_"];
        Presence_MediaDurationOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_MediaDurationOut_"];
        Presence_MediaNavigationOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_MediaNavigationOut_"];
        Presence_MediaProgressState_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_MediaProgressState_"];
        Presence_MetadataOperationOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_MetadataOperationOut_"];
        Presence_MetadataSelection_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_MetadataSelection_"];
        Presence_NavigationTextPointOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_NavigationTextPointOut_"];
        Presence_NavigationTextRangeOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_NavigationTextRangeOut_"];
        Presence_PlayerDescriptor_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_PlayerDescriptor_"];
        Presence_PlayerDisplay_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_PlayerDisplay_"];
        Presence_PodcastPlaybackPreference_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_PodcastPlaybackPreference_"];
        Presence_PodcastReplacementConfirmation_: components["schemas"]["Absent-Input"] | components["schemas"]["Present_PodcastReplacementConfirmation_"];
        Presence_PublicHighlightOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_PublicHighlightOut_"];
        Presence_ReaderSelectionInput_: components["schemas"]["Absent-Input"] | components["schemas"]["Present_ReaderSelectionInput_"];
        Presence_ReaderSelectionOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_ReaderSelectionOut_"];
        Presence_ReaderTimeRange_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_ReaderTimeRange_"];
        Presence_ReadingTimeEstimateOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_ReadingTimeEstimateOut_"];
        Presence_ResourceActivationOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_ResourceActivationOut_"];
        Presence_ShareMembersOut_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_ShareMembersOut_"];
        Presence_SourceFailureProgress_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_SourceFailureProgress_"];
        "Presence_UUID_-Input": components["schemas"]["Absent-Input"] | components["schemas"]["Present_UUID_-Input"];
        "Presence_UUID_-Output": components["schemas"]["Absent-Output"] | components["schemas"]["Present_UUID_-Output"];
        Presence_Union_Literal__E_SOURCE_INTEGRITY____E_INVALID_FILE_TYPE____E_FILE_TOO_LARGE____E_CAPTURE_TOO_LARGE____Literal__E_ARCHIVE_UNSAFE____E_BILLING_REQUIRED____E_CAPTURE_TOO_LARGE____E_FORBIDDEN____E_IDEMPOTENCY_KEY_REPLAY_MISMATCH____E_INGEST_FAILED____E_INGEST_TIMEOUT____E_INTERNAL____E_INVALID_CONTENT_TYPE____E_INVALID_KIND____E_INVALID_REQUEST____E_LLM_BAD_REQUEST____E_MEDIA_NOT_FOUND____E_MEDIA_NOT_READY____E_OWNER_REQUIRED____E_PDF_PASSWORD_REQUIRED____E_PDF_TEXT_UNAVAILABLE____E_PODCAST_PROVIDER_UNAVAILABLE____E_PODCAST_QUOTA_EXCEEDED____E_REPAIR_NOT_ALLOWED____E_RESOURCE_CONFLICT____E_RESOURCE_LIMIT____E_RETRY_INVALID_STATE____E_RETRY_NOT_ALLOWED____E_SANITIZATION_FAILED____E_SELECTION_CHANGED____E_SIGN_UPLOAD_FAILED____E_SOURCE_ACCESS_DENIED____E_SOURCE_FETCH_FAILED____E_SOURCE_NOT_READABLE____E_SOURCE_TOO_LARGE____E_SSRF_BLOCKED____E_STORAGE_ERROR____E_STORAGE_MISSING____E_TRANSCRIPTION_FAILED____E_TRANSCRIPTION_TIMEOUT____E_TRANSCRIPT_UNAVAILABLE____E_UPLOAD_CAPABILITY_EXPIRED____E_UPLOAD_TRANSPORT_FAILED____E_WORKER_HANDLER_FAILED____E_WORKER_INTERRUPTED____E_X_POST_UNAVAILABLE____E_X_PROVIDER_AUTH_REJECTED____E_X_PROVIDER_CREDITS_DEPLETED____E_X_PROVIDER_RATE_LIMITED____E_X_PROVIDER_TIMEOUT____E_X_PROVIDER_UNAVAILABLE____: components["schemas"]["Absent-Output"] | components["schemas"]["Present_Union_Literal__E_SOURCE_INTEGRITY____E_INVALID_FILE_TYPE____E_FILE_TOO_LARGE____E_CAPTURE_TOO_LARGE____Literal__E_ARCHIVE_UNSAFE____E_BILLING_REQUIRED____E_CAPTURE_TOO_LARGE____E_FORBIDDEN____E_IDEMPOTENCY_KEY_REPLAY_MISMATCH____E_INGEST_FAILED____E_INGEST_TIMEOUT____E_INTERNAL____E_INVALID_CONTENT_TYPE____E_INVALID_KIND____E_INVALID_REQUEST____E_LLM_BAD_REQUEST____E_MEDIA_NOT_FOUND____E_MEDIA_NOT_READY____E_OWNER_REQUIRED____E_PDF_PASSWORD_REQUIRED____E_PDF_TEXT_UNAVAILABLE____E_PODCAST_PROVIDER_UNAVAILABLE____E_PODCAST_QUOTA_EXCEEDED____E_REPAIR_NOT_ALLOWED____E_RESOURCE_CONFLICT____E_RESOURCE_LIMIT____E_RETRY_INVALID_STATE____E_RETRY_NOT_ALLOWED____E_SANITIZATION_FAILED____E_SELECTION_CHANGED____E_SIGN_UPLOAD_FAILED____E_SOURCE_ACCESS_DENIED____E_SOURCE_FETCH_FAILED____E_SOURCE_NOT_READABLE____E_SOURCE_TOO_LARGE____E_SSRF_BLOCKED____E_STORAGE_ERROR____E_STORAGE_MISSING____E_TRANSCRIPTION_FAILED____E_TRANSCRIPTION_TIMEOUT____E_TRANSCRIPT_UNAVAILABLE____E_UPLOAD_CAPABILITY_EXPIRED____E_UPLOAD_TRANSPORT_FAILED____E_WORKER_HANDLER_FAILED____E_WORKER_INTERRUPTED____E_X_POST_UNAVAILABLE____E_X_PROVIDER_AUTH_REJECTED____E_X_PROVIDER_CREDITS_DEPLETED____E_X_PROVIDER_RATE_LIMITED____E_X_PROVIDER_TIMEOUT____E_X_PROVIDER_UNAVAILABLE____"];
        Presence_datetime_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_datetime_"];
        Presence_int_: components["schemas"]["Absent-Output"] | components["schemas"]["Present_int_"];
        "Presence_str_-Input": components["schemas"]["Absent-Input"] | components["schemas"]["Present_str_-Input"];
        "Presence_str_-Output": components["schemas"]["Absent-Output"] | components["schemas"]["Present_str_-Output"];
        /** Present[ActivitySessionOut] */
        Present_ActivitySessionOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ActivitySessionOut"];
        };
        /** Present[Annotated[Union[RetryUploadOffer, RetrySourceOffer, RepairSourceOffer, RepairSearchOffer], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        Present_Annotated_Union_RetryUploadOffer__RetrySourceOffer__RepairSourceOffer__RepairSearchOffer___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: components["schemas"]["RetryUploadOffer"] | components["schemas"]["RetrySourceOffer"] | components["schemas"]["RepairSourceOffer"] | components["schemas"]["RepairSearchOffer"];
        };
        /** Present[Annotated[Union[SourceStageProgress, SourceCountedProgress], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        Present_Annotated_Union_SourceStageProgress__SourceCountedProgress___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: components["schemas"]["SourceStageProgress"] | components["schemas"]["SourceCountedProgress"];
        };
        /** Present[Annotated[Union[UploadTransportNetworkFailure, UploadTransportTimeoutFailure, UploadTransportHttpRejectedFailure, UploadTransportAbortedFailure], FieldInfo(annotation=NoneType, required=True, discriminator='kind')]] */
        Present_Annotated_Union_UploadTransportNetworkFailure__UploadTransportTimeoutFailure__UploadTransportHttpRejectedFailure__UploadTransportAbortedFailure___FieldInfo_annotation_NoneType__required_True__discriminator__kind____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: components["schemas"]["UploadTransportNetworkFailure"] | components["schemas"]["UploadTransportTimeoutFailure"] | components["schemas"]["UploadTransportHttpRejectedFailure"] | components["schemas"]["UploadTransportAbortedFailure"];
        };
        /** Present[Annotated[float, FieldInfo(annotation=NoneType, required=True, metadata=[Ge(ge=0.0), Le(le=1.0)])]] */
        Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__0__0_____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[float, FieldInfo(annotation=NoneType, required=True, metadata=[Ge(ge=0), Le(le=1)])]] */
        "Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____-Input": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[float, FieldInfo(annotation=NoneType, required=True, metadata=[Ge(ge=0), Le(le=1)])]] */
        "Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____-Output": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[float, FieldInfo(annotation=NoneType, required=True, metadata=[Strict(strict=True), Ge(ge=0.5), Le(le=3)])]] */
        "Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Input": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[float, FieldInfo(annotation=NoneType, required=True, metadata=[Strict(strict=True), Ge(ge=0.5), Le(le=3)])]] */
        "Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Output": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[int, FieldInfo(annotation=NoneType, required=True, metadata=[Ge(ge=0), Le(le=2147483647)])]] */
        "Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Input": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[int, FieldInfo(annotation=NoneType, required=True, metadata=[Ge(ge=0), Le(le=2147483647)])]] */
        "Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Output": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[int, FieldInfo(annotation=NoneType, required=True, metadata=[Ge(ge=0), Le(le=9223372036854775807)])]] */
        Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_9223372036854775807_____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[int, FieldInfo(annotation=NoneType, required=True, metadata=[Strict(strict=True), Ge(ge=0), Le(le=2147483647)])]] */
        Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___Ge_ge_0___Le_le_2147483647_____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[int, FieldInfo(annotation=NoneType, required=True, metadata=[Strict(strict=True), Ge(ge=1)])]] */
        Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___Ge_ge_1_____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[list[Literal['media', 'library', 'evidence_span', 'content_chunk', 'highlight', 'page', 'note_block', 'fragment', 'conversation', 'message', 'oracle_reading', 'oracle_passage_anchor', 'artifact', 'artifact_revision', 'external_snapshot', 'contributor', 'podcast', 'reader_apparatus_item', 'passage_anchor']], FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1)])]] */
        Present_Annotated_list_Literal__media____library____evidence_span____content_chunk____highlight____page____note_block____fragment____conversation____message____oracle_reading____oracle_passage_anchor____artifact____artifact_revision____external_snapshot____contributor____podcast____reader_apparatus_item____passage_anchor_____FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: ("media" | "library" | "evidence_span" | "content_chunk" | "highlight" | "page" | "note_block" | "fragment" | "conversation" | "message" | "oracle_reading" | "oracle_passage_anchor" | "artifact" | "artifact_revision" | "external_snapshot" | "contributor" | "podcast" | "reader_apparatus_item" | "passage_anchor")[];
        };
        /** Present[Annotated[str, AfterValidator]] */
        Present_Annotated_str__AfterValidator__: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /** Present[Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=128)])]] */
        Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_128_____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /** Present[Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=200)])]] */
        Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_200_____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /** Present[Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1)])]] */
        Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /** Present[Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1)]), AfterValidator]] */
        "Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__-Input": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /** Present[Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1)]), AfterValidator]] */
        "Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__-Output": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /** Present[Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[Strict(strict=True), MinLen(min_length=1)])]] */
        Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___MinLen_min_length_1_____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /** Present[Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[_PydanticGeneralMetadata(pattern='^ncc1\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{22}$')])]] */
        "Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata___PydanticGeneralMetadata_pattern___ncc1_____A-Za-z0-9_-__22______A-Za-z0-9_-__22________": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /** Present[Annotated[str, StringConstraints, AfterValidator]] */
        Present_Annotated_str__StringConstraints__AfterValidator__: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /** Present[AwareDatetime] */
        Present_AwareDatetime_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /**
             * Value
             * Format: date-time
             */
            value: string;
        };
        /** Present[BrowseSort] */
        Present_BrowseSort_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["BrowseSort"];
        };
        /** Present[ChatPublicationWarning] */
        Present_ChatPublicationWarning_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ChatPublicationWarning"];
        };
        /** Present[ChatRunExecutionOut] */
        Present_ChatRunExecutionOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ChatRunExecutionOut"];
        };
        /** Present[ConsumptionOut] */
        Present_ConsumptionOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ConsumptionOut"];
        };
        /** Present[DailyPageSummaryOut] */
        Present_DailyPageSummaryOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["DailyPageSummaryOut"];
        };
        /** Present[DossierBuildOut] */
        Present_DossierBuildOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["DossierBuildOut"];
        };
        /** Present[DossierFailureCode] */
        Present_DossierFailureCode_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["DossierFailureCode"];
        };
        /** Present[DossierRevisionOut] */
        Present_DossierRevisionOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["DossierRevisionOut"];
        };
        /** Present[DurableExecutionPhase] */
        Present_DurableExecutionPhase_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["DurableExecutionPhase"];
        };
        /** Present[HistoryEntry] */
        Present_HistoryEntry_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["HistoryEntry"];
        };
        /** Present[ImportSourceIssues] */
        Present_ImportSourceIssues_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ImportSourceIssues"];
        };
        /** Present[LecternItemOut] */
        Present_LecternItemOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["LecternItemOut"];
        };
        /** Present[LibraryEntryPlacementOut] */
        Present_LibraryEntryPlacementOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["LibraryEntryPlacementOut"];
        };
        /** Present[LibraryEntryPodcastSubscriptionOut] */
        Present_LibraryEntryPodcastSubscriptionOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["LibraryEntryPodcastSubscriptionOut"];
        };
        /** Present[ListeningStateOut] */
        Present_ListeningStateOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["nexus__schemas__consumption__ListeningStateOut"];
        };
        /** Present[Literal['NotOwner', 'SameSourceTerminal', 'SourceNotReacquirable', 'UploadRejected']] */
        Present_Literal__NotOwner____SameSourceTerminal____SourceNotReacquirable____UploadRejected___: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /**
             * Value
             * @enum {string}
             */
            value: "NotOwner" | "SameSourceTerminal" | "SourceNotReacquirable" | "UploadRejected";
        };
        /** Present[Literal['Off', 'Natural']] */
        "Present_Literal__Off____Natural___-Input": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /**
             * Value
             * @enum {string}
             */
            value: "Off" | "Natural";
        };
        /** Present[Literal['Off', 'Natural']] */
        "Present_Literal__Off____Natural___-Output": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /**
             * Value
             * @enum {string}
             */
            value: "Off" | "Natural";
        };
        /** Present[Literal['Publisher', 'Imported', 'Generated']] */
        Present_Literal__Publisher____Imported____Generated___: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /**
             * Value
             * @enum {string}
             */
            value: "Publisher" | "Imported" | "Generated";
        };
        /** Present[Literal['Queue', 'Capacity', 'RetryBackoff']] */
        Present_Literal__Queue____Capacity____RetryBackoff___: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /**
             * Value
             * @enum {string}
             */
            value: "Queue" | "Capacity" | "RetryBackoff";
        };
        /** Present[Literal['Upload', 'Validate', 'Extract', 'Finalize', 'Index', 'SourceProcessing']] */
        Present_Literal__Upload____Validate____Extract____Finalize____Index____SourceProcessing___: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /**
             * Value
             * @enum {string}
             */
            value: "Upload" | "Validate" | "Extract" | "Finalize" | "Index" | "SourceProcessing";
        };
        /** Present[MediaAbstractOut] */
        Present_MediaAbstractOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["MediaAbstractOut"];
        };
        /** Present[MediaDurationOut] */
        Present_MediaDurationOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["MediaDurationOut"];
        };
        /** Present[MediaNavigationOut] */
        Present_MediaNavigationOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["MediaNavigationOut"];
        };
        /** Present[MediaProgressState] */
        Present_MediaProgressState_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["MediaProgressState"];
        };
        /** Present[MetadataOperationOut] */
        Present_MetadataOperationOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["MetadataOperationOut"];
        };
        /** Present[MetadataSelection] */
        Present_MetadataSelection_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["MetadataSelection"];
        };
        /** Present[NavigationTextPointOut] */
        Present_NavigationTextPointOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["NavigationTextPointOut"];
        };
        /** Present[NavigationTextRangeOut] */
        Present_NavigationTextRangeOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["NavigationTextRangeOut"];
        };
        /** Present[PlayerDescriptor] */
        Present_PlayerDescriptor_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["PlayerDescriptor"];
        };
        /** Present[PlayerDisplay] */
        Present_PlayerDisplay_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["PlayerDisplay"];
        };
        /** Present[PodcastPlaybackPreference] */
        Present_PodcastPlaybackPreference_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["PodcastPlaybackPreference"];
        };
        /** Present[PodcastReplacementConfirmation] */
        Present_PodcastReplacementConfirmation_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["PodcastReplacementConfirmation"];
        };
        /** Present[PublicHighlightOut] */
        Present_PublicHighlightOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["PublicHighlightOut"];
        };
        /** Present[ReaderSelectionInput] */
        Present_ReaderSelectionInput_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ReaderSelectionInput"];
        };
        /** Present[ReaderSelectionOut] */
        Present_ReaderSelectionOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ReaderSelectionOut"];
        };
        /** Present[ReaderTimeRange] */
        Present_ReaderTimeRange_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ReaderTimeRange"];
        };
        /** Present[ReadingTimeEstimateOut] */
        Present_ReadingTimeEstimateOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ReadingTimeEstimateOut"];
        };
        /** Present[ResourceActivationOut] */
        Present_ResourceActivationOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ResourceActivationOut"];
        };
        /** Present[ShareMembersOut] */
        Present_ShareMembersOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ShareMembersOut"];
        };
        /** Present[SourceFailureProgress] */
        Present_SourceFailureProgress_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["SourceFailureProgress"];
        };
        /** Present[UUID] */
        "Present_UUID_-Input": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /**
             * Value
             * Format: uuid
             */
            value: string;
        };
        /** Present[UUID] */
        "Present_UUID_-Output": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /**
             * Value
             * Format: uuid
             */
            value: string;
        };
        /** Present[Union[Literal['E_SOURCE_INTEGRITY', 'E_INVALID_FILE_TYPE', 'E_FILE_TOO_LARGE', 'E_CAPTURE_TOO_LARGE'], Literal['E_ARCHIVE_UNSAFE', 'E_BILLING_REQUIRED', 'E_CAPTURE_TOO_LARGE', 'E_FORBIDDEN', 'E_IDEMPOTENCY_KEY_REPLAY_MISMATCH', 'E_INGEST_FAILED', 'E_INGEST_TIMEOUT', 'E_INTERNAL', 'E_INVALID_CONTENT_TYPE', 'E_INVALID_KIND', 'E_INVALID_REQUEST', 'E_LLM_BAD_REQUEST', 'E_MEDIA_NOT_FOUND', 'E_MEDIA_NOT_READY', 'E_OWNER_REQUIRED', 'E_PDF_PASSWORD_REQUIRED', 'E_PDF_TEXT_UNAVAILABLE', 'E_PODCAST_PROVIDER_UNAVAILABLE', 'E_PODCAST_QUOTA_EXCEEDED', 'E_REPAIR_NOT_ALLOWED', 'E_RESOURCE_CONFLICT', 'E_RESOURCE_LIMIT', 'E_RETRY_INVALID_STATE', 'E_RETRY_NOT_ALLOWED', 'E_SANITIZATION_FAILED', 'E_SELECTION_CHANGED', 'E_SIGN_UPLOAD_FAILED', 'E_SOURCE_ACCESS_DENIED', 'E_SOURCE_FETCH_FAILED', 'E_SOURCE_NOT_READABLE', 'E_SOURCE_TOO_LARGE', 'E_SSRF_BLOCKED', 'E_STORAGE_ERROR', 'E_STORAGE_MISSING', 'E_TRANSCRIPTION_FAILED', 'E_TRANSCRIPTION_TIMEOUT', 'E_TRANSCRIPT_UNAVAILABLE', 'E_UPLOAD_CAPABILITY_EXPIRED', 'E_UPLOAD_TRANSPORT_FAILED', 'E_WORKER_HANDLER_FAILED', 'E_WORKER_INTERRUPTED', 'E_X_POST_UNAVAILABLE', 'E_X_PROVIDER_AUTH_REJECTED', 'E_X_PROVIDER_CREDITS_DEPLETED', 'E_X_PROVIDER_RATE_LIMITED', 'E_X_PROVIDER_TIMEOUT', 'E_X_PROVIDER_UNAVAILABLE']]] */
        Present_Union_Literal__E_SOURCE_INTEGRITY____E_INVALID_FILE_TYPE____E_FILE_TOO_LARGE____E_CAPTURE_TOO_LARGE____Literal__E_ARCHIVE_UNSAFE____E_BILLING_REQUIRED____E_CAPTURE_TOO_LARGE____E_FORBIDDEN____E_IDEMPOTENCY_KEY_REPLAY_MISMATCH____E_INGEST_FAILED____E_INGEST_TIMEOUT____E_INTERNAL____E_INVALID_CONTENT_TYPE____E_INVALID_KIND____E_INVALID_REQUEST____E_LLM_BAD_REQUEST____E_MEDIA_NOT_FOUND____E_MEDIA_NOT_READY____E_OWNER_REQUIRED____E_PDF_PASSWORD_REQUIRED____E_PDF_TEXT_UNAVAILABLE____E_PODCAST_PROVIDER_UNAVAILABLE____E_PODCAST_QUOTA_EXCEEDED____E_REPAIR_NOT_ALLOWED____E_RESOURCE_CONFLICT____E_RESOURCE_LIMIT____E_RETRY_INVALID_STATE____E_RETRY_NOT_ALLOWED____E_SANITIZATION_FAILED____E_SELECTION_CHANGED____E_SIGN_UPLOAD_FAILED____E_SOURCE_ACCESS_DENIED____E_SOURCE_FETCH_FAILED____E_SOURCE_NOT_READABLE____E_SOURCE_TOO_LARGE____E_SSRF_BLOCKED____E_STORAGE_ERROR____E_STORAGE_MISSING____E_TRANSCRIPTION_FAILED____E_TRANSCRIPTION_TIMEOUT____E_TRANSCRIPT_UNAVAILABLE____E_UPLOAD_CAPABILITY_EXPIRED____E_UPLOAD_TRANSPORT_FAILED____E_WORKER_HANDLER_FAILED____E_WORKER_INTERRUPTED____E_X_POST_UNAVAILABLE____E_X_PROVIDER_AUTH_REJECTED____E_X_PROVIDER_CREDITS_DEPLETED____E_X_PROVIDER_RATE_LIMITED____E_X_PROVIDER_TIMEOUT____E_X_PROVIDER_UNAVAILABLE____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: ("E_SOURCE_INTEGRITY" | "E_INVALID_FILE_TYPE" | "E_FILE_TOO_LARGE" | "E_CAPTURE_TOO_LARGE") | ("E_ARCHIVE_UNSAFE" | "E_BILLING_REQUIRED" | "E_CAPTURE_TOO_LARGE" | "E_FORBIDDEN" | "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH" | "E_INGEST_FAILED" | "E_INGEST_TIMEOUT" | "E_INTERNAL" | "E_INVALID_CONTENT_TYPE" | "E_INVALID_KIND" | "E_INVALID_REQUEST" | "E_LLM_BAD_REQUEST" | "E_MEDIA_NOT_FOUND" | "E_MEDIA_NOT_READY" | "E_OWNER_REQUIRED" | "E_PDF_PASSWORD_REQUIRED" | "E_PDF_TEXT_UNAVAILABLE" | "E_PODCAST_PROVIDER_UNAVAILABLE" | "E_PODCAST_QUOTA_EXCEEDED" | "E_REPAIR_NOT_ALLOWED" | "E_RESOURCE_CONFLICT" | "E_RESOURCE_LIMIT" | "E_RETRY_INVALID_STATE" | "E_RETRY_NOT_ALLOWED" | "E_SANITIZATION_FAILED" | "E_SELECTION_CHANGED" | "E_SIGN_UPLOAD_FAILED" | "E_SOURCE_ACCESS_DENIED" | "E_SOURCE_FETCH_FAILED" | "E_SOURCE_NOT_READABLE" | "E_SOURCE_TOO_LARGE" | "E_SSRF_BLOCKED" | "E_STORAGE_ERROR" | "E_STORAGE_MISSING" | "E_TRANSCRIPTION_FAILED" | "E_TRANSCRIPTION_TIMEOUT" | "E_TRANSCRIPT_UNAVAILABLE" | "E_UPLOAD_CAPABILITY_EXPIRED" | "E_UPLOAD_TRANSPORT_FAILED" | "E_WORKER_HANDLER_FAILED" | "E_WORKER_INTERRUPTED" | "E_X_POST_UNAVAILABLE" | "E_X_PROVIDER_AUTH_REJECTED" | "E_X_PROVIDER_CREDITS_DEPLETED" | "E_X_PROVIDER_RATE_LIMITED" | "E_X_PROVIDER_TIMEOUT" | "E_X_PROVIDER_UNAVAILABLE");
        };
        /** Present[datetime] */
        Present_datetime_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /**
             * Value
             * Format: date-time
             */
            value: string;
        };
        /** Present[int] */
        Present_int_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[str] */
        "Present_str_-Input": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /** Present[str] */
        "Present_str_-Output": {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /** PreviewPositionIn */
        PreviewPositionIn: {
            durationMs: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Input"];
            /** Positionms */
            positionMs: number;
        };
        /** PreviewResolution */
        PreviewResolution: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Preview";
            /** Target */
            target: string;
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
        /** ProcessorChain */
        ProcessorChain: {
            /** Processors */
            processors: string[];
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
        /** PublicArticleReaderOut */
        PublicArticleReaderOut: {
            /** Fragments */
            fragments: components["schemas"]["PublicFragmentOut"][];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Article";
        };
        /** PublicEpubReaderOut */
        PublicEpubReaderOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Epub";
            /** Sections */
            sections: components["schemas"]["PublicSectionEntryOut"][];
        };
        /** PublicFragmentOut */
        PublicFragmentOut: {
            /** Canonical Text */
            canonical_text: string;
            /** Html Sanitized */
            html_sanitized: string;
            /** Ordinal */
            ordinal: number;
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
            quote: components["schemas"]["Presence_str_-Output"];
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
        /** PublicPdfReaderOut */
        PublicPdfReaderOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Pdf";
        };
        /** PublicSectionEntryOut */
        PublicSectionEntryOut: {
            /** Depth */
            depth: number;
            /** Label */
            label: string;
            /** Ordinal */
            ordinal: number;
            /** Section Handle */
            section_handle: string;
        };
        /** PublicSectionOut */
        PublicSectionOut: {
            /** Canonical Text */
            canonical_text: string;
            /** Html Sanitized */
            html_sanitized: string;
        };
        /** PublicSegmentOut */
        PublicSegmentOut: {
            /** Canonical Text */
            canonical_text: string;
            /** Ordinal */
            ordinal: number;
            speaker: components["schemas"]["Presence_str_-Output"];
            start_ms: components["schemas"]["Presence_int_"];
        };
        /** PublicShareOut */
        PublicShareOut: {
            /** Bylines */
            bylines: string[];
            highlight: components["schemas"]["Presence_PublicHighlightOut_"];
            /** Reader */
            reader: components["schemas"]["PublicArticleReaderOut"] | components["schemas"]["PublicTranscriptReaderOut"] | components["schemas"]["PublicEpubReaderOut"] | components["schemas"]["PublicPdfReaderOut"];
            source_url: components["schemas"]["Presence_str_-Output"];
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
        /** PublicTranscriptReaderOut */
        PublicTranscriptReaderOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Transcript";
            /** Segments */
            segments: components["schemas"]["PublicSegmentOut"][];
        };
        /** PutLinkNoteRequest */
        PutLinkNoteRequest: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Client Mutation Id */
            client_mutation_id: string;
            /** Expected Body */
            expected_body: components["schemas"]["AbsentExpectedBody"] | components["schemas"]["VersionExpectedBody"];
            /**
             * Note Block Id
             * Format: uuid
             */
            note_block_id: string;
        };
        /** PutStanceRequest */
        PutStanceRequest: {
            /**
             * Kind
             * @enum {string}
             */
            kind: "supports" | "contradicts";
            /** Source Ref */
            source_ref: string;
            /** Target Ref */
            target_ref: string;
        };
        /** QuickReadsOut */
        QuickReadsOut: {
            /** Items */
            items: components["schemas"]["SlateItemOut"][];
        };
        /** ReadableActivation */
        ReadableActivation: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Readable";
        };
        /** ReaderApparatusItemRetrievalResultRef */
        ReaderApparatusItemRetrievalResultRef: {
            /** Apparatus Kind */
            apparatus_kind: string;
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Id */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id: string;
            /** Media Kind */
            media_kind?: string | null;
            /**
             * Result Type
             * @constant
             */
            result_type: "reader_apparatus_item";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "reader_apparatus_item";
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
            locator: components["schemas"]["PdfReaderResumeState"] | components["schemas"]["WebReaderResumeState"] | components["schemas"]["TranscriptReaderResumeState"] | components["schemas"]["EpubReaderResumeState-Output"];
            /** Revision */
            revision: number;
            /**
             * State
             * @default Positioned
             * @constant
             */
            state: "Positioned";
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
            end_position: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__0__0_____"];
            /** Id */
            id: string;
            /** Item Id */
            item_id: string;
            /**
             * Kind
             * @enum {string}
             */
            kind: "Contents" | "Embed" | "Highlight" | "SourceReference" | "GeneratedCitation" | "Link" | "Synapse";
            /** Label */
            label: string;
            /** Position */
            position: number;
            preview: components["schemas"]["Presence_str_-Output"];
            /**
             * Tone
             * @enum {string}
             */
            tone: "Neutral" | "Highlight" | "Citation" | "Link" | "Synapse" | "Warning";
        };
        /** ReaderDocumentMapOut */
        ReaderDocumentMapOut: {
            diagnostics: components["schemas"]["ReaderDocumentMapDiagnosticsOut"];
            /** Embeds */
            embeds: components["schemas"]["DocumentEmbedOut"][];
            evidence: components["schemas"]["ReaderEvidenceOut"];
            generation: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___Ge_ge_1_____"];
            /** Markers */
            markers: components["schemas"]["ReaderDocumentMapMarkerOut"][];
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Media Kind */
            media_kind: string;
            navigation: components["schemas"]["Presence_MediaNavigationOut_"];
            /**
             * Status
             * @enum {string}
             */
            status: "ready" | "empty" | "partial";
            /** Title */
            title: string;
        };
        /** ReaderEpubTarget */
        "ReaderEpubTarget-Input": {
            anchor_id: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__-Input"];
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /** Href Path */
            href_path: string;
        };
        /** ReaderEpubTarget */
        "ReaderEpubTarget-Output": {
            anchor_id: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__-Output"];
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /** Href Path */
            href_path: string;
        };
        /** ReaderEvidenceAlsoReferenceOut */
        ReaderEvidenceAlsoReferenceOut: {
            /** Object */
            object: components["schemas"]["ReaderEvidenceChatObjectOut"] | components["schemas"]["ReaderEvidenceNoteObjectOut"] | components["schemas"]["ReaderEvidencePlainObjectOut"];
            /**
             * Relationship
             * @default AlsoReferences
             * @constant
             */
            relationship: "AlsoReferences";
        };
        /** ReaderEvidenceAnchorOut */
        ReaderEvidenceAnchorOut: {
            /** Locator */
            locator: (components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"]) | components["schemas"]["ReaderPdfPageLocatorOut"];
            /** Passage Anchor Id */
            passage_anchor_id: string | null;
        };
        /** ReaderEvidenceAuthoredInOut */
        ReaderEvidenceAuthoredInOut: {
            /** Object */
            object: components["schemas"]["ReaderEvidenceChatObjectOut"] | components["schemas"]["ReaderEvidenceNoteObjectOut"] | components["schemas"]["ReaderEvidencePlainObjectOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            relationship: "AuthoredIn";
        };
        /** ReaderEvidenceChatObjectOut */
        ReaderEvidenceChatObjectOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
            excerpt: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Chat";
            /** Label */
            label: string;
            message_ref: components["schemas"]["Presence_str_-Output"];
            /** Ref */
            ref: string;
        };
        /** ReaderEvidenceCountsOut */
        ReaderEvidenceCountsOut: {
            /** Citations */
            citations: number;
            /** Document */
            document: number;
            /** Highlights */
            highlights: number;
            /** Links */
            links: number;
            /** Passages */
            passages: number;
            /** Synapses */
            synapses: number;
        };
        /** ReaderEvidenceDirectlyAttachedOut */
        ReaderEvidenceDirectlyAttachedOut: {
            /**
             * Direction
             * @enum {string}
             */
            direction: "Outgoing" | "Incoming";
            /**
             * Edge Id
             * Format: uuid
             */
            edge_id: string;
            /** Object */
            object: components["schemas"]["ReaderEvidenceChatObjectOut"] | components["schemas"]["ReaderEvidenceNoteObjectOut"] | components["schemas"]["ReaderEvidencePlainObjectOut"];
            /**
             * Origin
             * @enum {string}
             */
            origin: "user" | "citation" | "system" | "note_body" | "highlight_note" | "synapse" | "document_embed" | "assistant" | "link_note";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            relationship: "DirectlyAttached";
            /**
             * Role
             * @enum {string}
             */
            role: "context" | "supports" | "contradicts";
        };
        /** ReaderEvidenceGeneratedCitationOut */
        ReaderEvidenceGeneratedCitationOut: {
            /** Associations */
            associations: (components["schemas"]["ReaderEvidenceAuthoredInOut"] | components["schemas"]["ReaderEvidenceDirectlyAttachedOut"])[];
            /**
             * Edge Id
             * Format: uuid
             */
            edge_id: string;
            excerpt: components["schemas"]["Presence_str_-Output"];
            /** Id */
            id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "GeneratedCitation";
            /** Label */
            label: string;
            /**
             * Role
             * @enum {string}
             */
            role: "context" | "supports" | "contradicts";
        };
        /** ReaderEvidenceHighlightOut */
        ReaderEvidenceHighlightOut: {
            /** Associations */
            associations: (components["schemas"]["ReaderEvidenceAuthoredInOut"] | components["schemas"]["ReaderEvidenceDirectlyAttachedOut"])[];
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
            excerpt: components["schemas"]["Presence_str_-Output"];
            /**
             * Highlight Id
             * Format: uuid
             */
            highlight_id: string;
            /** Id */
            id: string;
            /** Is Owner */
            is_owner: boolean;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Highlight";
            /** Label */
            label: string;
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
        };
        /** ReaderEvidenceLinkOut */
        ReaderEvidenceLinkOut: {
            /** Associations */
            associations: (components["schemas"]["ReaderEvidenceAuthoredInOut"] | components["schemas"]["ReaderEvidenceDirectlyAttachedOut"])[];
            /**
             * Edge Id
             * Format: uuid
             */
            edge_id: string;
            excerpt: components["schemas"]["Presence_str_-Output"];
            /** Id */
            id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Link";
            /** Label */
            label: string;
            link_note: components["schemas"]["ConnectionLinkNoteOut"] | null;
            /** Object */
            object: components["schemas"]["ReaderEvidenceChatObjectOut"] | components["schemas"]["ReaderEvidenceNoteObjectOut"] | components["schemas"]["ReaderEvidencePlainObjectOut"];
            /**
             * Origin
             * @enum {string}
             */
            origin: "user" | "citation" | "system" | "note_body" | "highlight_note" | "synapse" | "document_embed" | "assistant" | "link_note";
            /**
             * Role
             * @enum {string}
             */
            role: "context" | "supports" | "contradicts";
        };
        /** ReaderEvidenceNoteObjectOut */
        ReaderEvidenceNoteObjectOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            excerpt: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Note";
            /** Label */
            label: string;
            /**
             * Note Block Id
             * Format: uuid
             */
            note_block_id: string;
            /** Ref */
            ref: string;
        };
        /** ReaderEvidenceOut */
        ReaderEvidenceOut: {
            counts: components["schemas"]["ReaderEvidenceCountsOut"];
            /** Document Items */
            document_items: (components["schemas"]["ReaderEvidenceHighlightOut"] | components["schemas"]["ReaderEvidenceSourceReferenceOut"] | components["schemas"]["ReaderEvidenceGeneratedCitationOut"] | components["schemas"]["ReaderEvidenceLinkOut"] | components["schemas"]["ReaderEvidenceSynapseOut"])[];
            /** Passage Groups */
            passage_groups: components["schemas"]["ReaderEvidencePassageGroupOut"][];
            /** Source Targets */
            source_targets: components["schemas"]["ReaderEvidenceSourceTargetOut"][];
        };
        /** ReaderEvidencePassageGroupOut */
        ReaderEvidencePassageGroupOut: {
            /** Also References */
            also_references: components["schemas"]["ReaderEvidenceAlsoReferenceOut"][];
            /** Items */
            items: (components["schemas"]["ReaderEvidenceHighlightOut"] | components["schemas"]["ReaderEvidenceSourceReferenceOut"] | components["schemas"]["ReaderEvidenceGeneratedCitationOut"] | components["schemas"]["ReaderEvidenceLinkOut"] | components["schemas"]["ReaderEvidenceSynapseOut"])[];
            /** Locus Ref */
            locus_ref: string;
            /** Resolution */
            resolution: components["schemas"]["ReaderEvidenceResolvedOut"] | components["schemas"]["ReaderEvidenceUnavailableOut"];
            target_excerpt: components["schemas"]["Presence_str_-Output"];
        };
        /**
         * ReaderEvidencePlainObjectOut
         * @description An object carrying no payload beyond the common four keys.
         */
        ReaderEvidencePlainObjectOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            excerpt: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Dossier" | "Media" | "Oracle" | "Other";
            /** Label */
            label: string;
            /** Ref */
            ref: string;
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
        /** ReaderEvidenceSourceReferenceOut */
        ReaderEvidenceSourceReferenceOut: {
            /**
             * Apparatus Kind
             * @enum {string}
             */
            apparatus_kind: "footnote_ref" | "endnote_ref" | "bibliography_ref" | "sidenote_ref" | "margin_note_ref" | "footnote" | "endnote" | "bibliography_entry" | "sidenote" | "margin_note" | "reference_section";
            /** Associations */
            associations: (components["schemas"]["ReaderEvidenceAuthoredInOut"] | components["schemas"]["ReaderEvidenceDirectlyAttachedOut"])[];
            /**
             * Confidence
             * @enum {string}
             */
            confidence: "exact" | "strong" | "probable";
            excerpt: components["schemas"]["Presence_str_-Output"];
            /** Id */
            id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceReference";
            /** Label */
            label: string;
            marker_anchor_id: components["schemas"]["Presence_str_-Output"];
            /** Stable Key */
            stable_key: string;
            /** Target Refs */
            target_refs: string[];
        };
        /** ReaderEvidenceSourceTargetOut */
        ReaderEvidenceSourceTargetOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            /**
             * Apparatus Kind
             * @enum {string}
             */
            apparatus_kind: "footnote_ref" | "endnote_ref" | "bibliography_ref" | "sidenote_ref" | "margin_note_ref" | "footnote" | "endnote" | "bibliography_entry" | "sidenote" | "margin_note" | "reference_section";
            /** Content */
            content: components["schemas"]["ReaderSourceHtmlOut"] | components["schemas"]["ReaderSourceTextOut"] | components["schemas"]["ReaderSourceUnavailableOut"];
            label: components["schemas"]["Presence_str_-Output"];
            /** Ref */
            ref: string;
            /** Resolution */
            resolution: components["schemas"]["ReaderEvidenceResolvedOut"] | components["schemas"]["ReaderEvidenceUnavailableOut"];
            /** Stable Key */
            stable_key: string;
        };
        /** ReaderEvidenceSynapseOut */
        ReaderEvidenceSynapseOut: {
            /** Associations */
            associations: (components["schemas"]["ReaderEvidenceAuthoredInOut"] | components["schemas"]["ReaderEvidenceDirectlyAttachedOut"])[];
            /**
             * Edge Id
             * Format: uuid
             */
            edge_id: string;
            excerpt: components["schemas"]["Presence_str_-Output"];
            /** Id */
            id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Synapse";
            /** Label */
            label: string;
            /** Object */
            object: components["schemas"]["ReaderEvidenceChatObjectOut"] | components["schemas"]["ReaderEvidenceNoteObjectOut"] | components["schemas"]["ReaderEvidencePlainObjectOut"];
            /** Rationale */
            rationale: string;
            /**
             * Role
             * @enum {string}
             */
            role: "context" | "supports" | "contradicts";
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
        /**
         * ReaderNavigationFragmentOut
         * @description One unique canonical text unit in document order.
         */
        ReaderNavigationFragmentOut: {
            /** Char Count */
            char_count: number;
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /** Fragment Idx */
            fragment_idx: number;
        };
        /**
         * ReaderNavigationLocationOut
         * @description A non-TOC reader navigation target.
         */
        ReaderNavigationLocationOut: {
            /** Id */
            id: string;
            /** Label */
            label: string;
            target: components["schemas"]["Presence_NavigationTextPointOut_"];
        };
        /** ReaderNavigationSectionOut */
        ReaderNavigationSectionOut: {
            anchor_id: components["schemas"]["Presence_str_-Output"];
            extent: components["schemas"]["Presence_NavigationTextRangeOut_"];
            /** Label */
            label: string;
            parent_section_id: components["schemas"]["Presence_str_-Output"];
            /** Section Id */
            section_id: string;
            /**
             * Source
             * @enum {string}
             */
            source: "Publisher" | "Heading" | "Both" | "InferredNumberedEntry";
            target: components["schemas"]["NavigationTextPointOut"];
        };
        /**
         * ReaderNavigationTocNodeOut
         * @description A published destination, independently linked to a reading section.
         */
        ReaderNavigationTocNodeOut: {
            /** Children */
            children: components["schemas"]["ReaderNavigationTocNodeOut"][];
            /** Id */
            id: string;
            /** Label */
            label: string;
            section_id: components["schemas"]["Presence_str_-Output"];
            target: components["schemas"]["Presence_NavigationTextPointOut_"];
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
        /**
         * ReaderSelectionInput
         * @description The reader-selection piece of a chat-run request: key plus precondition.
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
            activation: components["schemas"]["ResourceActivationOut"];
            /** Exact */
            exact: string;
            key: components["schemas"]["ReaderSelectionKey"];
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"];
            /**
             * Prefix
             * @default
             */
            prefix: string;
            /** Source Label */
            source_label: string;
            /**
             * Suffix
             * @default
             */
            suffix: string;
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
        /** ReaderTimeRange */
        ReaderTimeRange: {
            /** End Ms */
            end_ms: number;
            /** Start Ms */
            start_ms: number;
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
             * Capturekey
             * Format: uuid
             */
            captureKey: string;
            /** Durationms */
            durationMs: number;
            /**
             * Occurredat
             * Format: date-time
             */
            occurredAt: string;
            progressEnd: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____-Input"];
            progressStart: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____-Input"];
            wordEnd: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_9223372036854775807_____"];
            wordStart: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_9223372036854775807_____"];
        };
        /** ReadingTimeEstimateOut */
        ReadingTimeEstimateOut: {
            remainingMinutes: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___Ge_ge_0___Le_le_2147483647_____"];
            /** Totalminutes */
            totalMinutes: number;
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
            /** Handle */
            handle: string;
            /**
             * Kind
             * @default ReceivedUser
             * @constant
             */
            kind: "ReceivedUser";
            sharedBy: components["schemas"]["ShareUserOut"];
            /** Subject */
            subject: string;
        };
        /**
         * RecoveryResourceActionCapabilityOut
         * @description The one recovery a media menu may plan, carrying the identity the viewer
         *     inspected so a stale offer conflicts instead of acting on newer work.
         */
        RecoveryResourceActionCapabilityOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Recovery";
            /** Offer */
            offer: components["schemas"]["RetrySourceOfferOut"] | components["schemas"]["RepairSourceOfferOut"] | components["schemas"]["RepairSearchOfferOut"];
        };
        /** RelinkSurfaceCommand */
        RelinkSurfaceCommand: {
            /** Destination Ref */
            destination_ref: string;
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            /** Position */
            position: components["schemas"]["SurfaceStartPosition"] | components["schemas"]["SurfaceAfterPosition"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "relink";
        };
        /** RemoveItemCommand */
        RemoveItemCommand: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /**
             * Itemid
             * Format: uuid
             */
            itemId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "RemoveItem";
        };
        /** RemoveOccurrenceSurfaceCommand */
        RemoveOccurrenceSurfaceCommand: {
            /** Entries */
            entries: components["schemas"]["SurfaceRemoval"][];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "remove_occurrence";
        };
        /** RemovedOutcome */
        RemovedOutcome: {
            /**
             * Itemid
             * Format: uuid
             */
            itemId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Removed";
        };
        /** RenameBranchRequest */
        RenameBranchRequest: {
            /** Title */
            title?: string | null;
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
        /** RepairSearchOfferOut */
        RepairSearchOfferOut: {
            /**
             * Expectedjobid
             * Format: uuid
             */
            expectedJobId: string;
            /** Expectedrevision */
            expectedRevision: number;
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
        /** RepairSourceOfferOut */
        RepairSourceOfferOut: {
            /**
             * Expectedattemptid
             * Format: uuid
             */
            expectedAttemptId: string;
            /**
             * Expectedjobid
             * Format: uuid
             */
            expectedJobId: string;
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
        /** RepairSourceRecovery */
        RepairSourceRecovery: {
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "RepairSource";
        };
        /** ReplyInsertion */
        ReplyInsertion: {
            /** Branch Anchor */
            branch_anchor?: components["schemas"]["NoBranchAnchorRequest"] | components["schemas"]["AssistantMessageBranchAnchorRequest"] | components["schemas"]["AssistantSelectionBranchAnchorRequest"];
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
        /** ReprocessSourceRecovery */
        ReprocessSourceRecovery: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "ReprocessSource";
            /**
             * New Source Attempt Id
             * Format: uuid
             */
            new_source_attempt_id: string;
        };
        /** ResetProgressCommand */
        ResetProgressCommand: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "ResetProgress";
            /**
             * Mediaid
             * Format: uuid
             */
            mediaId: string;
        };
        /** ResolvedHighlightReaderTargetResponse */
        ResolvedHighlightReaderTargetResponse: {
            /** Data */
            data: components["schemas"]["WebTextOffsetsTargetOut"] | components["schemas"]["EpubTextOffsetsTargetOut"] | components["schemas"]["TranscriptTextOffsetsTargetOut"] | components["schemas"]["PdfPageGeometryTargetOut"];
        };
        /** ResourceActionSnapshotOut */
        ResourceActionSnapshotOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            /** Capabilities */
            capabilities: (components["schemas"]["SimpleResourceActionCapabilityOut"] | components["schemas"]["RetryMetadataResourceActionCapabilityOut"] | components["schemas"]["RecoveryResourceActionCapabilityOut"] | components["schemas"]["OfflineReadingResourceActionCapabilityOut"] | components["schemas"]["OpenSourceResourceActionCapabilityOut"] | components["schemas"]["PlaybackResourceActionCapabilityOut"] | components["schemas"]["ConsumptionResourceActionCapabilityOut"] | components["schemas"]["EpisodeConsumptionResourceActionCapabilityOut"] | components["schemas"]["PodcastSubscriptionResourceActionCapabilityOut"] | components["schemas"]["TranscriptResourceActionCapabilityOut"] | components["schemas"]["LecternMembershipResourceActionCapabilityOut"] | components["schemas"]["HighlightNoteResourceActionCapabilityOut"])[];
            /** Missing */
            missing: boolean;
            /** Ref */
            ref: string;
        };
        /**
         * ResourceActionSnapshotResolveRequest
         * @description A batch of 1..100 unique resource refs to resolve.
         *
         *     ``Field`` bounds the count (1..100) and a single ``model_validator`` adds the
         *     uniqueness rule pydantic cannot express; both surface as ``E_INVALID_REQUEST``
         *     via the app's request-validation remap. Ref grammar is parsed exactly once, at
         *     the route boundary (``api/routes/resource_items.py`` ``_parse_ref``), so an
         *     unparseable ref is rejected there — this model never re-parses.
         */
        ResourceActionSnapshotResolveRequest: {
            /** Refs */
            refs: string[];
        };
        /** ResourceActionSnapshotResolveResponse */
        ResourceActionSnapshotResolveResponse: {
            /** Snapshots */
            snapshots: components["schemas"]["ResourceActionSnapshotOut"][];
        };
        /** ResourceActionSubjectOut */
        ResourceActionSubjectOut: {
            /** Ref */
            ref: string;
        };
        /** ResourceActivationOut */
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
            /** Unresolved Reason */
            unresolved_reason: string | null;
        };
        /** ResourceBodyMutationRequest */
        ResourceBodyMutationRequest: {
            /** Base Versions */
            base_versions?: components["schemas"]["ResourceLaneVersionIn"][];
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Client Mutation Id */
            client_mutation_id: string;
        };
        /** ResourceItemCapabilitiesOut */
        ResourceItemCapabilitiesOut: {
            /** Adjacencysource */
            adjacencySource: boolean;
            /** Adjacencytarget */
            adjacencyTarget: boolean;
            /** Appsearchscope */
            appSearchScope: boolean;
            /** Attachable */
            attachable: boolean;
            /**
             * Chatsubject
             * @enum {string}
             */
            chatSubject: "none" | "label" | "scope" | "readable" | "quote" | "generated_output";
            /** Citableresulttype */
            citableResultType: string | null;
            /** Citationoutputsource */
            citationOutputSource: boolean;
            /** Conversationsearchscope */
            conversationSearchScope: boolean;
            /** Expandable */
            expandable: boolean;
            /**
             * Expansionpolicy
             * @enum {string}
             */
            expansionPolicy: "none" | "media_owned_reader_children" | "page_note_blocks" | "note_block_owned_evidence" | "artifact_revisions";
            /**
             * Inspectable
             * @enum {string}
             */
            inspectable: "none" | "media_document_map";
            /**
             * Libraryplacement
             * @enum {string}
             */
            libraryPlacement: "None" | "ManageEntries";
            /**
             * Promptrender
             * @enum {string}
             */
            promptRender: "none" | "label" | "inline_body" | "quote";
            /**
             * Readable
             * @enum {string}
             */
            readable: "none" | "scope" | "body" | "media";
            /**
             * Sharing
             * @enum {string}
             */
            sharing: "None" | "CopyOnly" | "ResourceGrants" | "HighlightGrants" | "LibraryMembership";
            userRelation: components["schemas"]["ResourceUserRelationPolicyOut"];
        };
        /** ResourceItemOut */
        ResourceItemOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            capabilities: components["schemas"]["ResourceItemCapabilitiesOut"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Label */
            label: string;
            /**
             * Missing
             * @default false
             */
            missing: boolean;
            /** Ref */
            ref: string;
            /** Route */
            route: string | null;
            /**
             * Scheme
             * @enum {string}
             */
            scheme: "media" | "library" | "evidence_span" | "content_chunk" | "highlight" | "page" | "note_block" | "fragment" | "conversation" | "message" | "oracle_reading" | "oracle_passage_anchor" | "artifact" | "artifact_revision" | "external_snapshot" | "contributor" | "podcast" | "reader_apparatus_item" | "passage_anchor";
            /** Summary */
            summary: string;
            /** Versionbylane */
            versionByLane: {
                [key: string]: number;
            };
        };
        /** ResourceLaneVersionIn */
        ResourceLaneVersionIn: {
            /**
             * Lane
             * @enum {string}
             */
            lane: "title" | "body" | "links";
            /** Ref */
            ref: string;
            /** Version */
            version: number;
        };
        /** ResourceLocatorResolutionOut */
        ResourceLocatorResolutionOut: {
            /** Canonicalhref */
            canonicalHref: string | null;
            /** Locator */
            locator: components["schemas"]["ResourceRefLocatorIn"] | components["schemas"]["ContributorHandleLocatorIn"];
            resourceItem: components["schemas"]["ResourceItemOut"];
        };
        /** ResourceLocatorResolveRequest */
        ResourceLocatorResolveRequest: {
            /** Locators */
            locators: (components["schemas"]["ResourceRefLocatorIn"] | components["schemas"]["ContributorHandleLocatorIn"])[];
        };
        /** ResourceLocatorResolveResponse */
        ResourceLocatorResolveResponse: {
            /** Resolutions */
            resolutions: components["schemas"]["ResourceLocatorResolutionOut"][];
        };
        /** ResourceOpenableSearchRequest */
        ResourceOpenableSearchRequest: {
            /** Q */
            q: string;
            schemes: components["schemas"]["Presence_Annotated_list_Literal__media____library____evidence_span____content_chunk____highlight____page____note_block____fragment____conversation____message____oracle_reading____oracle_passage_anchor____artifact____artifact_revision____external_snapshot____contributor____podcast____reader_apparatus_item____passage_anchor_____FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____"];
        };
        /** ResourceOpenableSearchResponse */
        ResourceOpenableSearchResponse: {
            /** Items */
            items: components["schemas"]["ResourceItemOut"][];
        };
        /** ResourceRefLocatorIn */
        ResourceRefLocatorIn: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource_ref";
            /** Ref */
            ref: string;
        };
        /** ResourceShareSnapshotOut */
        ResourceShareSnapshotOut: {
            /** Authenticatedhref */
            authenticatedHref: string;
            creationAvailability: components["schemas"]["CreationAvailabilityOut"];
            members: components["schemas"]["Presence_ShareMembersOut_"];
            /** Receivedaccess */
            receivedAccess: components["schemas"]["ReceivedUserShareOut"][];
            /** Shares */
            shares: (components["schemas"]["UserShareOut"] | components["schemas"]["LinkShareOut"])[];
            /**
             * Sharing
             * @enum {string}
             */
            sharing: "None" | "CopyOnly" | "ResourceGrants" | "HighlightGrants" | "LibraryMembership";
        };
        /** ResourceSummarySurfaceContent */
        ResourceSummarySurfaceContent: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "resource_summary";
        };
        /** ResourceSurfaceCommandOut */
        ResourceSurfaceCommandOut: {
            /** Client Mutation Id */
            client_mutation_id: string;
            /** Nodes */
            nodes: components["schemas"]["ResourceSurfaceNode"][];
            /**
             * Receipt Id
             * Format: uuid
             */
            receipt_id: string;
            /** Reverse Versions */
            reverse_versions: components["schemas"]["ResourceLaneVersionIn"][];
            /** Surfaces */
            surfaces: components["schemas"]["ResourceSurfaceOut"][];
        };
        /** ResourceSurfaceCommandRequest */
        ResourceSurfaceCommandRequest: {
            /** Base Versions */
            base_versions: components["schemas"]["ResourceLaneVersionIn"][];
            /** Body Edits */
            body_edits: components["schemas"]["SurfaceBodyEdit"][];
            /** Client Mutation Id */
            client_mutation_id: string;
            /** Command */
            command: components["schemas"]["InsertNoteSurfaceCommand"] | components["schemas"]["SplitNoteSurfaceCommand"] | components["schemas"]["InsertResourceSurfaceCommand"] | components["schemas"]["MoveOccurrenceSurfaceCommand"] | components["schemas"]["RemoveOccurrenceSurfaceCommand"] | components["schemas"]["RelinkSurfaceCommand"] | components["schemas"]["JoinNotesSurfaceCommand"] | components["schemas"]["PasteOutlineSurfaceCommand"] | components["schemas"]["ReverseEditSurfaceCommand"];
            context: components["schemas"]["SurfaceContext"];
        };
        /** ResourceSurfaceNode */
        ResourceSurfaceNode: {
            /** Content */
            content: components["schemas"]["PageTitleSurfaceContent"] | components["schemas"]["NoteBodySurfaceContent"] | components["schemas"]["ResourceSummarySurfaceContent"];
            item: components["schemas"]["ResourceItemOut"];
        };
        /** ResourceSurfaceOccurrence */
        ResourceSurfaceOccurrence: {
            /** Collapsed */
            collapsed: boolean;
            /** Has Link Note */
            has_link_note: boolean;
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
            target: components["schemas"]["ResourceSurfaceNode"];
        };
        /** ResourceSurfaceOut */
        ResourceSurfaceOut: {
            /** Ordered Items */
            ordered_items: components["schemas"]["ResourceSurfaceOccurrence"][];
            source: components["schemas"]["ResourceSurfaceNode"];
        };
        /** ResourceTargetPassageOut */
        ResourceTargetPassageOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            /** Candidateref */
            candidateRef: string;
            /** Excerpt */
            excerpt: string;
            /** Existinglinkid */
            existingLinkId: string | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "passage";
            /** Label */
            label: string;
            source: components["schemas"]["ResourceItemOut"];
        };
        /** ResourceTargetResourceOut */
        ResourceTargetResourceOut: {
            /** Existinglinkid */
            existingLinkId: string | null;
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
            /**
             * Limit
             * @default 10
             */
            limit: number;
            /**
             * Purpose
             * @enum {string}
             */
            purpose: "link" | "reference";
            /** Q */
            q: string;
            /** Schemes */
            schemes?: ("media" | "library" | "evidence_span" | "content_chunk" | "highlight" | "page" | "note_block" | "fragment" | "conversation" | "message" | "oracle_reading" | "oracle_passage_anchor" | "artifact" | "artifact_revision" | "external_snapshot" | "contributor" | "podcast" | "reader_apparatus_item" | "passage_anchor")[] | null;
            /** Source Ref */
            source_ref?: string | null;
        };
        /** ResourceTargetSearchResponse */
        ResourceTargetSearchResponse: {
            /** Nextcursor */
            nextCursor: string | null;
            /** Targets */
            targets: (components["schemas"]["ResourceTargetResourceOut"] | components["schemas"]["ResourceTargetPassageOut"])[];
        };
        /** ResourceTitleMutationOut */
        ResourceTitleMutationOut: {
            /** Clientmutationid */
            clientMutationId: string;
            item: components["schemas"]["ResourceItemOut"];
            /**
             * Updatedat
             * Format: date-time
             */
            updatedAt: string;
            /** Versions */
            versions: {
                [key: string]: {
                    [key: string]: number;
                };
            };
        };
        /** ResourceTitleMutationRequest */
        ResourceTitleMutationRequest: {
            /** Base Versions */
            base_versions?: components["schemas"]["ResourceLaneVersionIn"][];
            /** Client Mutation Id */
            client_mutation_id: string;
            /** Title */
            title: string;
        };
        /** ResourceUserRelationPolicyOut */
        ResourceUserRelationPolicyOut: {
            /** Notereferencetarget */
            noteReferenceTarget: boolean;
            /** Userlinksource */
            userLinkSource: boolean;
            /**
             * Userlinktarget
             * @enum {string}
             */
            userLinkTarget: "none" | "direct" | "materialize_passage";
        };
        /** RestoreActivityExclusionIn */
        RestoreActivityExclusionIn: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /** Exclusionhandle */
            exclusionHandle: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Restore";
        };
        /** RetainedArtifactsOut */
        RetainedArtifactsOut: {
            /** Appliedfilters */
            appliedFilters: string[];
            /** Highlights */
            highlights: number;
            /** Inapplicablefilters */
            inapplicableFilters: string[];
            /** Neutrallinks */
            neutralLinks: number;
            /** Noteblocks */
            noteBlocks: number;
        };
        /** RetrievalContextRef */
        RetrievalContextRef: {
            /** Evidence Span Ids */
            evidence_span_ids?: (string)[];
            /** Id */
            id: string;
            /**
             * Type
             * @enum {string}
             */
            type: "media" | "podcast" | "episode" | "video" | "content_chunk" | "fragment" | "contributor" | "page" | "note_block" | "highlight" | "message" | "evidence_span" | "conversation" | "artifact" | "web_result" | "reader_apparatus_item";
        };
        /** RetryMetadataResourceActionCapabilityOut */
        RetryMetadataResourceActionCapabilityOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "RetryMetadata";
            retry: components["schemas"]["MetadataRetry"];
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
        /** RetrySourceOfferOut */
        RetrySourceOfferOut: {
            /**
             * Expectedattemptid
             * Format: uuid
             */
            expectedAttemptId: string;
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
        /** RetrySourceRecovery */
        RetrySourceRecovery: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "RetrySource";
            /**
             * New Source Attempt Id
             * Format: uuid
             */
            new_source_attempt_id: string;
        };
        /** RetrySourceRequest */
        RetrySourceRequest: {
            /** Client Mutation Id */
            client_mutation_id: string;
            /**
             * Expected Attempt Id
             * Format: uuid
             */
            expected_attempt_id: string;
            /**
             * From Stage
             * @constant
             */
            from_stage: "source";
        };
        /** RetryUploadOffer */
        RetryUploadOffer: {
            /** Expected Generation */
            expected_generation: number;
            /**
             * Input
             * @default ChooseOriginalFile
             * @constant
             */
            input: "ChooseOriginalFile";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "RetryUpload";
        };
        /** RetryUploadSessionRequest */
        RetryUploadSessionRequest: {
            /** Client Mutation Id */
            client_mutation_id: string;
            /** Content Type */
            content_type: string;
            /** Expected Generation */
            expected_generation: number;
            /** Filename */
            filename: string;
            /** Size Bytes */
            size_bytes: number;
        };
        /** ReverseEditSurfaceCommand */
        ReverseEditSurfaceCommand: {
            /**
             * Receipt Id
             * Format: uuid
             */
            receipt_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "reverse_edit";
        };
        /** RunSelectionOut */
        RunSelectionOut: {
            /** Catalog Definition Revision */
            catalog_definition_revision: string;
            display_at_dispatch: components["schemas"]["SelectionPresentation"];
            /** Selection */
            selection: components["schemas"]["CodexPersonalSelection"] | components["schemas"]["ProviderApiSelection"];
            /** Source Catalog Definition Revision */
            source_catalog_definition_revision: string;
            /**
             * Tool Authority
             * @enum {string}
             */
            tool_authority: "ReadOnly" | "AdditiveWrites";
        };
        /** SavedInNexusLibraryPlacementDestinationOut */
        SavedInNexusLibraryPlacementDestinationOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SavedInNexus";
        };
        /**
         * SearchPageInfo
         * @description Offset pagination, encoded as a base64url JSON cursor.
         */
        SearchPageInfo: {
            /**
             * Has More
             * @default false
             */
            has_more: boolean;
            /** Next Cursor */
            next_cursor: string | null;
        };
        /**
         * SearchRepairRequest
         * @description Requeue the exact dead reindex job of one content-index revision.
         */
        SearchRepairRequest: {
            /** Client Mutation Id */
            client_mutation_id: string;
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
        /**
         * SearchResponse
         * @description A mixed, ordered page of typed search results.
         */
        SearchResponse: {
            page: components["schemas"]["SearchPageInfo"];
            /** Results */
            results: (components["schemas"]["SearchResultMediaOut"] | components["schemas"]["SearchResultPodcastOut"] | components["schemas"]["SearchResultContentChunkOut"] | components["schemas"]["SearchResultFragmentOut"] | components["schemas"]["SearchResultContributorOut"] | components["schemas"]["SearchResultPageOut"] | components["schemas"]["SearchResultNoteBlockOut"] | components["schemas"]["SearchResultHighlightOut"] | components["schemas"]["SearchResultMessageOut"] | components["schemas"]["SearchResultEvidenceSpanOut"] | components["schemas"]["SearchResultReaderApparatusItemOut"] | components["schemas"]["SearchResultConversationOut"] | components["schemas"]["ConversationArtifactSearchOut"] | components["schemas"]["SearchResultWebOut"])[];
        };
        /**
         * SearchResultContentChunkOut
         * @description An indexed document passage.
         */
        SearchResultContentChunkOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Label */
            citation_label: string;
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /** Evidence Span Ids */
            evidence_span_ids: string[];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            source: components["schemas"]["SearchResultSourceOut"];
            /** Source Kind */
            source_kind: string;
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "content_chunk";
        };
        /**
         * SearchResultContextRefOut
         * @description Backend-owned context reference for model retrieval and citations.
         */
        SearchResultContextRefOut: {
            /** Evidence Span Ids */
            evidence_span_ids?: string[];
            /** Id */
            id: string;
            /** Locator */
            locator?: (components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"]) | null;
            /**
             * Type
             * @enum {string}
             */
            type: "media" | "podcast" | "episode" | "video" | "content_chunk" | "fragment" | "contributor" | "page" | "note_block" | "highlight" | "message" | "evidence_span" | "conversation" | "artifact" | "web_result" | "reader_apparatus_item";
        };
        /**
         * SearchResultContributorIdentityOut
         * @description Handle + display name only: no status, aliases, or external ids.
         */
        SearchResultContributorIdentityOut: {
            /** Display Name */
            display_name: string;
            /** Handle */
            handle: string;
        };
        /**
         * SearchResultContributorOut
         * @description A contributor identity hit.
         */
        SearchResultContributorOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            contributor: components["schemas"]["SearchResultContributorIdentityOut"];
            /** Contributor Handle */
            contributor_handle: string;
            /** Id */
            id: string;
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "contributor";
        };
        /**
         * SearchResultConversationOut
         * @description A visible conversation.
         */
        SearchResultConversationOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "conversation";
        };
        /**
         * SearchResultEvidenceSpanOut
         * @description One durable evidence span, produced only by citation reopen.
         */
        SearchResultEvidenceSpanOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Label */
            citation_label: string;
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /**
             * Evidence Span Id
             * Format: uuid
             */
            evidence_span_id: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            source: components["schemas"]["SearchResultSourceOut"];
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "evidence_span";
        };
        /**
         * SearchResultFragmentOut
         * @description A readable source fragment.
         */
        SearchResultFragmentOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Label */
            citation_label: string | null;
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            source: components["schemas"]["SearchResultSourceOut"];
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "fragment";
        };
        /**
         * SearchResultHighlightOut
         * @description A saved source highlight.
         */
        SearchResultHighlightOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Label */
            citation_label: string | null;
            /** Citation Target */
            citation_target: string | null;
            /** Color */
            color: string;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /** Exact */
            exact: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            source: components["schemas"]["SearchResultSourceOut"];
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "highlight";
        };
        /**
         * SearchResultMediaOut
         * @description A media hit; the discriminant names the document's format family.
         */
        SearchResultMediaOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            mediaSummary: components["schemas"]["MediaSummaryOut"];
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "episode" | "media" | "video";
        };
        /**
         * SearchResultMessageOut
         * @description A conversation message hit.
         */
        SearchResultMessageOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Seq */
            seq: number;
            /** Snippet */
            snippet: string;
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "message";
        };
        /**
         * SearchResultNoteBlockOut
         * @description A note-block body hit.
         */
        SearchResultNoteBlockOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Body Text */
            body_text: string;
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /** Highlight Excerpt */
            highlight_excerpt: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /**
             * Note Origin
             * @enum {string}
             */
            note_origin: "note" | "highlight_note";
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "note_block";
        };
        /**
         * SearchResultPageOut
         * @description A note page.
         */
        SearchResultPageOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "page";
        };
        /**
         * SearchResultPodcastOut
         * @description A visible podcast hit.
         */
        SearchResultPodcastOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "podcast";
        };
        /**
         * SearchResultReaderApparatusItemOut
         * @description A source-authored reader apparatus row.
         */
        SearchResultReaderApparatusItemOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Apparatus Kind */
            apparatus_kind: string;
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
            source: components["schemas"]["SearchResultSourceOut"];
            /** Source Label */
            source_label: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "reader_apparatus_item";
        };
        /**
         * SearchResultSourceOut
         * @description Source metadata shared by media-anchored rows.
         */
        SearchResultSourceOut: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Media Kind */
            media_kind: string;
            original_published_date: components["schemas"]["Presence_Annotated_str__StringConstraints__AfterValidator__"];
            /** Summary Md */
            summary_md: string | null;
            /** Title */
            title: string;
        };
        /**
         * SearchResultWebOut
         * @description A persisted public-web result, shaped as chat web search returns it.
         */
        SearchResultWebOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["ResourceActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /** Display Url */
            display_url: string | null;
            /** Extra Snippets */
            extra_snippets: string[];
            /** Id */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id: string | null;
            /** Media Kind */
            media_kind: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Provider */
            provider: string | null;
            /** Provider Request Id */
            provider_request_id: string | null;
            /** Published At */
            published_at: string | null;
            /** Rank */
            rank: number | null;
            /** Resource Ref */
            resource_ref: string;
            /** Result Ref */
            result_ref: string;
            /**
             * Result Type
             * @constant
             */
            result_type: "web_result";
            /** Score */
            score: number;
            /** Selected */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label: string | null;
            /** Source Name */
            source_name: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "web_result";
            /** Url */
            url: string;
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
        /** ServerActionAvailabilityAvailableOut */
        ServerActionAvailabilityAvailableOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Available";
        };
        /** ServerActionAvailabilityBlockedOut */
        ServerActionAvailabilityBlockedOut: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Blocked";
            /**
             * Reason
             * @enum {string}
             */
            reason: "PermissionDenied" | "Locked" | "Processing" | "TemporarilyUnavailable";
        };
        /** SetActivePathRequest */
        SetActivePathRequest: {
            /**
             * Active Leaf Message Id
             * Format: uuid
             */
            active_leaf_message_id: string;
        };
        /** SetBatchStateCommand */
        SetBatchStateCommand: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SetBatchState";
            /** Mediaids */
            mediaIds: string[];
            /**
             * State
             * @enum {string}
             */
            state: "Finished" | "Unread";
        };
        /** SetHighlightNoteRequest */
        SetHighlightNoteRequest: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Client Mutation Id */
            client_mutation_id: string;
            /** Expected Body */
            expected_body: components["schemas"]["AbsentExpectedBody"] | components["schemas"]["VersionExpectedBody"];
            /**
             * Note Block Id
             * Format: uuid
             */
            note_block_id: string;
        };
        /** SetOrderCommand */
        SetOrderCommand: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /** Itemids */
            itemIds: string[];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SetOrder";
        };
        /** SetUnreadCommand */
        SetUnreadCommand: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SetUnread";
            /**
             * Mediaid
             * Format: uuid
             */
            mediaId: string;
        };
        /** SettleNaturalEndCommand */
        SettleNaturalEndCommand: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            expectedConsumptionOverrideRevision: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Input"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SettleNaturalEnd";
            /**
             * Mediaid
             * Format: uuid
             */
            mediaId: string;
            /**
             * Nextcapability
             * @constant
             */
            nextCapability: "FooterAudio";
            /** Origin */
            origin: components["schemas"]["DirectNaturalEndOrigin"] | components["schemas"]["LecternNaturalEndOrigin"];
            terminalListening: components["schemas"]["TerminalListeningIn"];
        };
        /** ShareMembersOut */
        ShareMembersOut: {
            /** Canmanage */
            canManage: boolean;
        };
        /** ShareUserOut */
        ShareUserOut: {
            displayName: components["schemas"]["Presence_str_-Output"];
            email: components["schemas"]["Presence_str_-Output"];
            /** Userhandle */
            userHandle: string;
        };
        /** SimpleResourceActionCapabilityOut */
        SimpleResourceActionCapabilityOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Chat" | "DeleteConversation" | "DeleteHighlight" | "DeleteLibrary" | "DeleteMessage" | "DeletePage" | "DownloadOriginal" | "EditAuthors" | "EditHighlight" | "EditHighlightBounds" | "EditNoteBody" | "EditPageTitle" | "ForkMessage" | "LearnHighlight" | "LibraryPlacement" | "LibrarySettings" | "LinkHighlight" | "MediaMetadata" | "OfflineAudio" | "Open" | "OpenInNewPane" | "PlayNext" | "PodcastSettings" | "RefreshPodcast" | "RefreshSource" | "RegenerateArtifact" | "RegenerateMessage" | "RemoveMedia" | "RerunMessage" | "ResetProgress" | "RetryPodcastBackfill" | "Share" | "WalkMessageSources";
        };
        /** SlateItemOut */
        SlateItemOut: {
            consumption: components["schemas"]["Presence_ConsumptionOut_"];
            /** Target */
            target: components["schemas"]["MediaSlateTargetOut"] | components["schemas"]["PodcastSlateTargetOut"];
        };
        /** SlateOut */
        SlateOut: {
            /** Items */
            items: components["schemas"]["SlateItemOut"][];
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
             * Execution Id
             * Format: uuid
             */
            execution_id: string;
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
            execution_id: components["schemas"]["Presence_UUID_-Output"];
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
            progress: components["schemas"]["Presence_SourceFailureProgress_"];
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
            total: components["schemas"]["Presence_int_"];
            unit: components["schemas"]["Presence_str_-Output"];
        };
        /** SourceHistoryBaseline */
        SourceHistoryBaseline: {
            /** Attempt No */
            attempt_no: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceHistoryBaseline";
            /** Outcome */
            outcome: components["schemas"]["SucceededSourceBaselineOutcome"] | components["schemas"]["FailedSourceBaselineOutcome"] | components["schemas"]["InFlightSourceBaselineOutcome"];
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /** SourceRecoveryAccepted */
        SourceRecoveryAccepted: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceRecoveryAccepted";
            /** Recovery */
            recovery: components["schemas"]["RetrySourceRecovery"] | components["schemas"]["RepairSourceRecovery"] | components["schemas"]["ReprocessSourceRecovery"] | components["schemas"]["CorrectSourceTypeRecovery"];
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
            /** Client Mutation Id */
            client_mutation_id: string;
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
        /** SourceRetryAdmission */
        SourceRetryAdmission: {
            /**
             * Job Id
             * Format: uuid
             */
            job_id: string;
            /**
             * Kind
             * @default SourceRetry
             * @constant
             */
            kind: "SourceRetry";
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
        /** SourceRetryScheduled */
        SourceRetryScheduled: {
            execution_id: components["schemas"]["Presence_UUID_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceRetryScheduled";
            /**
             * Next Attempt At
             * Format: date-time
             */
            next_attempt_at: string;
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
        };
        /** SourceStageChanged */
        SourceStageChanged: {
            /**
             * Execution Id
             * Format: uuid
             */
            execution_id: string;
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
        /**
         * SourceSucceeded
         * @description `execution_id` is Absent for an attempt born succeeded and for an
         *     execution that predates the execution-identity cut.
         */
        SourceSucceeded: {
            execution_id: components["schemas"]["Presence_UUID_-Output"];
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
        /** SourceSuperseded */
        SourceSuperseded: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SourceSuperseded";
            /**
             * Source Attempt Id
             * Format: uuid
             */
            source_attempt_id: string;
            /**
             * Winner Media Id
             * Format: uuid
             */
            winner_media_id: string;
        };
        /** SplitNoteSurfaceCommand */
        SplitNoteSurfaceCommand: {
            /** Left Body Pm Json */
            left_body_pm_json: {
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
            /** Right Body Pm Json */
            right_body_pm_json: {
                [key: string]: unknown;
            };
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "split_note";
        };
        /** StanceOut */
        StanceOut: {
            connection: components["schemas"]["ConnectionOut"];
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
        /** SucceededSourceBaselineOutcome */
        SucceededSourceBaselineOutcome: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Succeeded";
        };
        /** SurfaceAfterPosition */
        SurfaceAfterPosition: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "after";
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
        };
        /** SurfaceBodyEdit */
        SurfaceBodyEdit: {
            /** Body Pm Json */
            body_pm_json: {
                [key: string]: unknown;
            };
            /** Ref */
            ref: string;
        };
        /** SurfaceContext */
        SurfaceContext: {
            /** Link Path */
            link_path: string[];
            /** Root Ref */
            root_ref: string;
        };
        /** SurfaceRemoval */
        SurfaceRemoval: {
            context: components["schemas"]["SurfaceContext"];
            /** Endpoint Ref */
            endpoint_ref: string;
            /**
             * Link Id
             * Format: uuid
             */
            link_id: string;
        };
        /** SurfaceStartPosition */
        SurfaceStartPosition: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "start";
        };
        /** SynapseScanRequest */
        SynapseScanRequest: {
            /** Ref */
            ref: string;
        };
        /** TemporarilyUnavailable */
        TemporarilyUnavailable: {
            /** Action */
            action: string;
            /**
             * Code
             * @enum {string}
             */
            code: "catalog_refresh_failed" | "codex_host_unavailable" | "credential_unavailable" | "required_tool_unavailable";
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
        /** TerminalListeningIn */
        TerminalListeningIn: {
            durationMs: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Input"];
            episodePlaybackRate: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Input"];
            /** Expectedresetepoch */
            expectedResetEpoch: number;
            /** Expectedwriterevision */
            expectedWriteRevision: number;
            /** Positionms */
            positionMs: number;
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
         * ToolEffect
         * @enum {string}
         */
        ToolEffect: "Pure" | "Read" | "Write";
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
        /** TranscriptResourceActionCapabilityOut */
        TranscriptResourceActionCapabilityOut: {
            /** Availability */
            availability: components["schemas"]["ServerActionAvailabilityAvailableOut"] | components["schemas"]["ServerActionAvailabilityBlockedOut"];
            /**
             * Coverage
             * @enum {string}
             */
            coverage: "None" | "Partial" | "Full";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Transcript";
            /**
             * State
             * @enum {string}
             */
            state: "NotRequested" | "Queued" | "Running" | "Ready" | "Partial" | "Unavailable" | "FailedProvider";
        };
        /**
         * TranscriptState
         * @description Lifecycle state for transcript availability.
         * @enum {string}
         */
        TranscriptState: "not_requested" | "queued" | "running" | "ready" | "partial" | "unavailable" | "failed_provider";
        /** TranscriptTextOffsetsTargetOut */
        TranscriptTextOffsetsTargetOut: {
            /** End Offset */
            end_offset: number;
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "TranscriptTextOffsets";
            /** Start Offset */
            start_offset: number;
            time_range: components["schemas"]["Presence_ReaderTimeRange_"];
        };
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
        /** TransferLibraryOwnershipRequest */
        TransferLibraryOwnershipRequest: {
            /** Newowneruserhandle */
            newOwnerUserHandle: string;
        };
        /** TrustCitationOut */
        TrustCitationOut: {
            citation: components["schemas"]["CitationOut"];
            /**
             * Citation Edge Id
             * Format: uuid
             */
            citation_edge_id: string;
            /** Ordinal */
            ordinal: number;
            /** Retrieval Id */
            retrieval_id: string | null;
            /**
             * Role
             * @enum {string}
             */
            role: "context" | "supports" | "contradicts";
            target_ref: components["schemas"]["CitationTargetRef"];
            /** Tool Call Id */
            tool_call_id: string | null;
        };
        /** TrustContextRefAddedOut */
        TrustContextRefAddedOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            /** Chat Run Event Seq */
            chat_run_event_seq: number;
            /** Citation Edge Id */
            citation_edge_id: string | null;
            /**
             * Conversation Id
             * Format: uuid
             */
            conversation_id: string;
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
            /** Label */
            label: string;
            /** Missing */
            missing: boolean;
            /** Resource Ref */
            resource_ref: string;
            /** Summary */
            summary: string;
        };
        /** TrustIntegrityNoticeOut */
        TrustIntegrityNoticeOut: {
            /** Code */
            code: string;
            /** Message */
            message: string;
        };
        /** TrustPromptAssemblyOut */
        TrustPromptAssemblyOut: {
            /** Dropped Items */
            dropped_items: {
                [key: string]: unknown;
            }[];
            /** Estimated Input Tokens */
            estimated_input_tokens: number;
            /** Included Context Refs */
            included_context_refs: {
                [key: string]: unknown;
            }[];
            /** Included Message Ids */
            included_message_ids: string[];
            /** Input Budget Tokens */
            input_budget_tokens: number;
            /** Reserved Output Tokens */
            reserved_output_tokens: number;
        };
        /** TrustRetrievalOut */
        TrustRetrievalOut: {
            citation_candidate_ordinal: components["schemas"]["Presence_int_"];
            /** Citation Number */
            citation_number: number | null;
            /** Citation Role */
            citation_role: ("context" | "supports" | "contradicts") | null;
            /** Cited Edge Id */
            cited_edge_id: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Deep Link */
            deep_link: string | null;
            /** Evidence Span Id */
            evidence_span_id: string | null;
            /** Exact Snippet */
            exact_snippet: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /**
             * Included In Prompt
             * @default false
             */
            included_in_prompt: boolean;
            /**
             * Included In Prompt Source
             * @default retrieval
             * @enum {string}
             */
            included_in_prompt_source: "retrieval" | "prompt_assembly" | "none";
            /** Locator */
            locator: (components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"]) | null;
            /** Media Id */
            media_id: string | null;
            /** Ordinal */
            ordinal: number;
            /** Result Ref */
            result_ref: components["schemas"]["MediaRetrievalResultRef"] | components["schemas"]["PodcastRetrievalResultRef"] | components["schemas"]["EpisodeRetrievalResultRef"] | components["schemas"]["VideoRetrievalResultRef"] | components["schemas"]["ContentChunkRetrievalResultRef"] | components["schemas"]["FragmentRetrievalResultRef"] | components["schemas"]["ContributorRetrievalResultRef"] | components["schemas"]["PageRetrievalResultRef"] | components["schemas"]["NoteBlockRetrievalResultRef"] | components["schemas"]["HighlightRetrievalResultRef"] | components["schemas"]["MessageRetrievalResultRef"] | components["schemas"]["WebRetrievalResultRef"] | components["schemas"]["EvidenceSpanRetrievalResultRef"] | components["schemas"]["ReaderApparatusItemRetrievalResultRef"] | components["schemas"]["ConversationRetrievalResultRef"] | components["schemas"]["ArtifactRetrievalResultRef"];
            /**
             * Result Type
             * @enum {string}
             */
            result_type: "media" | "podcast" | "episode" | "video" | "content_chunk" | "fragment" | "contributor" | "page" | "note_block" | "highlight" | "message" | "evidence_span" | "conversation" | "artifact" | "web_result" | "reader_apparatus_item";
            /**
             * Retrieval Status
             * @default retrieved
             * @enum {string}
             */
            retrieval_status: "attached_context" | "retrieved" | "selected" | "included_in_prompt" | "excluded_by_budget" | "excluded_by_scope" | "web_result";
            /** Scope */
            scope: string;
            /** Score */
            score: number | null;
            /** Section Label */
            section_label: string | null;
            /** Selected */
            selected: boolean;
            /** Snippet Prefix */
            snippet_prefix: string | null;
            /** Snippet Suffix */
            snippet_suffix: string | null;
            /** Source Id */
            source_id: string;
            /** Source Title */
            source_title: string | null;
            /**
             * Tool Call Id
             * Format: uuid
             */
            tool_call_id: string;
        };
        /** TrustRunOut */
        TrustRunOut: {
            /** Completed At */
            completed_at: string | null;
            /** Error Code */
            error_code: string | null;
            execution: components["schemas"]["Presence_ChatRunExecutionOut_"];
            /** Failure */
            failure: (components["schemas"]["CancelledChatFailure"] | components["schemas"]["ContextTooLargeChatFailure"] | components["schemas"]["InvalidOutputChatFailure"] | components["schemas"]["IncompleteChatFailure"] | components["schemas"]["AssistantUnavailableChatFailure"] | components["schemas"]["OperatorDefectChatFailure"]) | null;
            /** Final Chars */
            final_chars: number | null;
            publication_warning: components["schemas"]["Presence_ChatPublicationWarning_"];
            /**
             * Run Id
             * Format: uuid
             */
            run_id: string;
            run_selection: components["schemas"]["RunSelectionOut"];
            /** Started At */
            started_at: string | null;
            /**
             * Status
             * @enum {string}
             */
            status: "pending" | "running" | "complete" | "error" | "cancelled";
            support_id: components["schemas"]["Presence_str_-Output"];
            /** Usage */
            usage: {
                [key: string]: unknown;
            } | null;
        };
        /** TrustToolCallOut */
        TrustToolCallOut: {
            /** Activity Label */
            activity_label: string;
            /** Canonical Tool Id */
            canonical_tool_id: string | null;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            effect: components["schemas"]["ToolEffect"] | null;
            /**
             * Error Type
             * @enum {unknown}
             */
            error_type: "BudgetExceeded" | "Conflict" | "DeadlineExceeded" | "InvalidInput" | "InvalidUpstreamResponse" | "InvalidUrl" | "QuoteAmbiguous" | "QuoteNotFound" | "RateLimited" | "ResourceUnavailable" | "TargetAmbiguous" | "TooLarge" | "ToolUnavailable" | "Uninspectable" | "Unreadable" | "UnsafeDestination" | "UnsupportedContent" | "UpstreamUnavailable" | "WriteCapReached" | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Latency Ms */
            latency_ms: number | null;
            /** Machine Authorships */
            machine_authorships: components["schemas"]["MachineAuthorshipOut"][];
            /** Provider Request Ids */
            provider_request_ids: string[];
            /** Provider Wire Name */
            provider_wire_name: string | null;
            /**
             * Record Kind
             * @enum {string}
             */
            record_kind: "attached_context" | "current_execution" | "historical_execution";
            /** Requested Types */
            requested_types: string[];
            /** Result Count */
            result_count: number;
            /**
             * Result Kind
             * @enum {string}
             */
            result_kind: "attached_context" | "mutation" | "navigation" | "retrieval";
            /** Result Refs */
            result_refs: {
                [key: string]: unknown;
            }[];
            /** Retrievals */
            retrievals: components["schemas"]["TrustRetrievalOut"][];
            /** Reverted At */
            reverted_at: string | null;
            /** Scope */
            scope: string;
            /** Selected Context Refs */
            selected_context_refs: {
                [key: string]: unknown;
            }[];
            /** Selected Count */
            selected_count: number;
            /**
             * Status
             * @enum {string}
             */
            status: "pending" | "running" | "complete" | "error" | "cancelled";
            /** Tool Call Index */
            tool_call_index: number;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** UndoCompletionCommand */
        UndoCompletionCommand: {
            /**
             * Clientmutationid
             * Format: uuid
             */
            clientMutationId: string;
            /** Completionhandle */
            completionHandle: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "UndoCompletion";
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
        };
        /** UpdateLibraryMemberRequest */
        UpdateLibraryMemberRequest: {
            /**
             * Role
             * @description New role for the member ('admin' or 'member')
             * @enum {string}
             */
            role: "admin" | "member";
        };
        /** UpdateLibraryRequest */
        UpdateLibraryRequest: {
            /**
             * Name
             * @description New library name (1-100 chars)
             */
            name: string;
        };
        /** UpdatePageRequest */
        UpdatePageRequest: {
            /** Title */
            title: string;
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
        /** UploadAbortedFailureRequest */
        UploadAbortedFailureRequest: {
            /** Duration Ms */
            duration_ms: number;
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Aborted";
            /** Request Id */
            request_id: string;
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
        /** UploadExecutionStarted */
        UploadExecutionStarted: {
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "UploadExecutionStarted";
        };
        /**
         * UploadFailed
         * @description Transport Present is a client-reported upload failure; Absent is a
         *     server-side verification rejection whose code is on the envelope.
         */
        UploadFailed: {
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "UploadFailed";
            transport: components["schemas"]["Presence_Annotated_Union_UploadTransportNetworkFailure__UploadTransportTimeoutFailure__UploadTransportHttpRejectedFailure__UploadTransportAbortedFailure___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
        };
        /** UploadHistoryBaseline */
        UploadHistoryBaseline: {
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "UploadHistoryBaseline";
        };
        /** UploadHttpRejectedFailureRequest */
        UploadHttpRejectedFailureRequest: {
            /** Duration Ms */
            duration_ms: number;
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "HttpRejected";
            /** Request Id */
            request_id: string;
            /** Status */
            status: number;
        };
        /** UploadNetworkFailureRequest */
        UploadNetworkFailureRequest: {
            /** Duration Ms */
            duration_ms: number;
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Network";
            /** Request Id */
            request_id: string;
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
        /** UploadTimeoutFailureRequest */
        UploadTimeoutFailureRequest: {
            /** Duration Ms */
            duration_ms: number;
            /** Generation */
            generation: number;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Timeout";
            /** Request Id */
            request_id: string;
        };
        /** UploadTransportAbortedFailure */
        UploadTransportAbortedFailure: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Aborted";
        };
        /** UploadTransportHttpRejectedFailure */
        UploadTransportHttpRejectedFailure: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "HttpRejected";
            /** Status */
            status: number;
        };
        /** UploadTransportNetworkFailure */
        UploadTransportNetworkFailure: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Network";
        };
        /** UploadTransportTimeoutFailure */
        UploadTransportTimeoutFailure: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Timeout";
        };
        /** UserAudienceIn */
        UserAudienceIn: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "User";
            /** Userhandle */
            userHandle: string;
        };
        /** UserLibraryInvitee */
        UserLibraryInvitee: {
            /**
             * Kind
             * @constant
             */
            kind: "User";
            /** Userhandle */
            userHandle: string;
        };
        /** UserShareOut */
        UserShareOut: {
            /** Handle */
            handle: string;
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
        /** VersionExpectedBody */
        VersionExpectedBody: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "version";
            /** Version */
            version: number;
        };
        /** VideoCandidate */
        VideoCandidate: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            description: components["schemas"]["Presence_str_-Output"];
            image: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Video";
            kindFacts: components["schemas"]["VideoFacts"];
            publishedAt: components["schemas"]["Presence_datetime_"];
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default YouTube
             * @constant
             */
            source: "YouTube";
            /** Title */
            title: string;
        };
        /** VideoFacts */
        VideoFacts: {
            channelTitle: components["schemas"]["Presence_str_-Output"];
            videoRef: components["schemas"]["Presence_str_-Output"];
        };
        /** VideoPreview */
        VideoPreview: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            description: components["schemas"]["Presence_str_-Output"];
            image: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Video";
            kindFacts: components["schemas"]["VideoPreviewFacts"];
            publishedAt: components["schemas"]["Presence_datetime_"];
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default YouTube
             * @constant
             */
            source: "YouTube";
            /** Sourcehref */
            sourceHref: string;
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** VideoPreviewFacts */
        VideoPreviewFacts: {
            channelTitle: components["schemas"]["Presence_str_-Output"];
            /** Embedhref */
            embedHref: string;
            /** Videoref */
            videoRef: string;
        };
        /** VideoRetrievalResultRef */
        VideoRetrievalResultRef: {
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Id */
            id: string;
            /** Locator */
            locator?: null;
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
            /**
             * Result Type
             * @constant
             */
            result_type: "video";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /** Source Id */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "video";
        };
        /** ViewerLibraryInvitationOut */
        ViewerLibraryInvitationOut: {
            /**
             * Createdat
             * Format: date-time
             */
            createdAt: string;
            /** Invitationhandle */
            invitationHandle: string;
            inviteeDisplayName: components["schemas"]["Presence_str_-Output"];
            inviteeEmail: components["schemas"]["Presence_str_-Output"];
            /** Inviteeuserhandle */
            inviteeUserHandle: string;
            /** Inviteruserhandle */
            inviterUserHandle: string;
            /**
             * Libraryid
             * Format: uuid
             */
            libraryId: string;
            /** Libraryname */
            libraryName: string;
            respondedAt: components["schemas"]["Presence_datetime_"];
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
             * Capturekey
             * Format: uuid
             */
            captureKey: string;
            /** Durationms */
            durationMs: number;
            /**
             * Occurredat
             * Format: date-time
             */
            occurredAt: string;
        };
        /** WebArticleCandidate */
        WebArticleCandidate: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            description: components["schemas"]["Presence_str_-Output"];
            image: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "WebArticle";
            kindFacts: components["schemas"]["WebArticleFacts"];
            publishedAt: components["schemas"]["Presence_datetime_"];
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default Brave
             * @constant
             */
            source: "Brave";
            /** Title */
            title: string;
        };
        /** WebArticleFacts */
        WebArticleFacts: {
            siteName: components["schemas"]["Presence_str_-Output"];
        };
        /** WebArticlePreview */
        WebArticlePreview: {
            /** Contributors */
            contributors: components["schemas"]["ContributorCreditOut"][];
            description: components["schemas"]["Presence_str_-Output"];
            image: components["schemas"]["Presence_str_-Output"];
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "WebArticle";
            kindFacts: components["schemas"]["WebArticlePreviewFacts"];
            publishedAt: components["schemas"]["Presence_datetime_"];
            resolution: components["schemas"]["BrowseResolution"];
            /**
             * Source
             * @default Brave
             * @constant
             */
            source: "Brave";
            /** Sourcehref */
            sourceHref: string;
            /** Target */
            target: string;
            /** Title */
            title: string;
        };
        /** WebArticlePreviewFacts */
        WebArticlePreviewFacts: {
            /** Canonicalurl */
            canonicalUrl: string;
            siteName: components["schemas"]["Presence_str_-Output"];
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
        /** WebRetrievalResultRef */
        WebRetrievalResultRef: {
            /** Citation Target */
            citation_target?: string | null;
            context_ref: components["schemas"]["RetrievalContextRef"];
            /** Deep Link */
            deep_link: string;
            /** Display Url */
            display_url?: string | null;
            /** Extra Snippets */
            extra_snippets?: string[];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id?: null;
            /** Media Kind */
            media_kind?: null;
            /** Provider */
            provider?: string | null;
            /** Provider Request Id */
            provider_request_id?: string | null;
            /** Published At */
            published_at?: string | null;
            /** Rank */
            rank?: number | null;
            /** Result Ref */
            result_ref: string;
            /**
             * Result Type
             * @constant
             */
            result_type: "web_result";
            /** Score */
            score?: number | null;
            /**
             * Selected
             * @default false
             */
            selected: boolean;
            /** Snippet */
            snippet: string;
            /**
             * Source Id
             * Format: uuid
             */
            source_id: string;
            /** Source Label */
            source_label?: string | null;
            /** Source Name */
            source_name?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "web_result";
            /** Url */
            url: string;
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
        /** WebTextOffsetsTargetOut */
        WebTextOffsetsTargetOut: {
            /** End Offset */
            end_offset: number;
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "WebTextOffsets";
            /** Start Offset */
            start_offset: number;
        };
        /**
         * WorkspaceSessionPutRequest
         * @description PUT body for a per-device workspace session.
         */
        WorkspaceSessionPutRequest: {
            /** Device Id */
            device_id: string;
            /** State */
            state: {
                [key: string]: unknown;
            };
        };
        /** ListeningStateOut */
        nexus__schemas__consumption__ListeningStateOut: {
            durationMs: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____-Output"];
            episodePlaybackRate: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____-Output"];
            /** Positionms */
            positionMs: number;
            /** Resetepoch */
            resetEpoch: number;
            /** Writerevision */
            writeRevision: number;
        };
        /** ListeningStateOut */
        nexus__schemas__media__ListeningStateOut: {
            /** Duration Ms */
            duration_ms: number | null;
            /**
             * Is Completed
             * @default false
             */
            is_completed: boolean;
            /** Position Ms */
            position_ms: number;
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
    read_atlas_atlas_get: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string | null;
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
                    "application/json": components["schemas"]["Data_AtlasOut_"];
                };
            };
            /** @description not modified */
            304: {
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
    create_extension_session_route_auth_extension_sessions_post: {
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
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    read_current_extension_session_route_auth_extension_sessions_current_get: {
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
    revoke_current_extension_session_route_auth_extension_sessions_current_delete: {
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
                    "application/json": components["schemas"]["Data_BrowsePage_"];
                };
            };
        };
    };
    browse_preview_browse_preview_get: {
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
                    "application/json": components["schemas"]["Data_BrowsePreview_"];
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
    list_chat_runs_chat_runs_get: {
        parameters: {
            query: {
                conversation_id: string;
                status?: "active" | "queued" | "running" | "complete" | "error" | "cancelled";
            };
            header?: {
                "X-Nexus-Chat-Contract"?: string | null;
                "X-Nexus-Tool-Projection"?: string | null;
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
                    "application/json": components["schemas"]["Data_list_ChatRunResponse__"];
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
                "X-Nexus-Chat-Contract"?: string | null;
                "X-Nexus-Tool-Projection"?: string | null;
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
    get_chat_run_chat_runs__run_id__get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Chat-Contract"?: string | null;
                "X-Nexus-Tool-Projection"?: string | null;
            };
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
            header?: {
                "X-Nexus-Chat-Contract"?: string | null;
                "X-Nexus-Tool-Projection"?: string | null;
            };
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
    post_activity_consumption_activity_post: {
        parameters: {
            query?: never;
            header?: never;
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
    post_activity_exclusion_consumption_activity_exclusions_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExcludeActivityIn"] | components["schemas"]["RestoreActivityExclusionIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ActivityExclusionResultOut_"];
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
    post_consumption_command_consumption_commands_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EnsureMediaFinishedCommand"] | components["schemas"]["FinishLecternItemCommand"] | components["schemas"]["SetUnreadCommand"] | components["schemas"]["ResetProgressCommand"] | components["schemas"]["UndoCompletionCommand"] | components["schemas"]["SetBatchStateCommand"] | components["schemas"]["SettleNaturalEndCommand"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ConsumptionResult_"];
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
    get_sessions_consumption_sessions_get: {
        parameters: {
            query: {
                cursor?: string | null;
                limit?: number;
                end: string;
                timeZone: string;
                currentDeviceId: string;
                start?: string | null;
                modality?: ("Reading" | "Listening" | "Viewing") | null;
                mediaRef?: string | null;
                contributorHandle?: string | null;
                deviceHandle?: string | null;
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
                bucket: "Hour" | "Day" | "Week" | "Month" | "Year";
                end: string;
                timeZone: string;
                currentDeviceId: string;
                start?: string | null;
                modality?: ("Reading" | "Listening" | "Viewing") | null;
                mediaRef?: string | null;
                contributorHandle?: string | null;
                deviceHandle?: string | null;
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
                    "application/json": components["schemas"]["Data_CollectionPage_ConversationListItemOut__"] | components["schemas"]["DataPage_ConversationOut_PageInfo_"];
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
        requestBody?: {
            content: {
                "application/json": components["schemas"]["CreateConversationRequest"] | null;
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
    get_conversation_conversations__conversation_id__get: {
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
    delete_conversation_conversations__conversation_id__delete: {
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
    set_conversation_active_path_conversations__conversation_id__active_path_post: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Chat-Contract"?: string | null;
                "X-Nexus-Tool-Projection"?: string | null;
            };
            path: {
                conversation_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetActivePathRequest"];
            };
        };
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
    list_context_refs_conversations__conversation_id__context_refs_get: {
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
    remove_context_ref_conversations__conversation_id__context_refs__edge_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: string;
                edge_id: string;
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
    list_conversation_forks_conversations__conversation_id__forks_get: {
        parameters: {
            query?: {
                /** @description Fork search query */
                search?: string | null;
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
    delete_conversation_fork_conversations__conversation_id__forks__branch_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: string;
                branch_id: string;
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
    rename_conversation_fork_conversations__conversation_id__forks__branch_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: string;
                branch_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RenameBranchRequest"];
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
    undo_tool_call_conversations__conversation_id__tool_calls__tool_call_id__undo_post: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Chat-Contract"?: string | null;
                "X-Nexus-Tool-Projection"?: string | null;
            };
            path: {
                conversation_id: string;
                tool_call_id: string;
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
    get_conversation_tree_conversations__conversation_id__tree_get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Chat-Contract"?: string | null;
                "X-Nexus-Tool-Projection"?: string | null;
            };
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
    create_capture_extension_captures_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BrowserCaptureIntent"];
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
    read_capture_extension_captures__session_handle__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_handle: string;
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
    delete_capture_extension_captures__session_handle__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_handle: string;
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
    confirm_capture_extension_captures__session_handle__confirm_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_handle: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfirmUploadSessionRequest"];
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
    retry_capture_extension_captures__session_handle__retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_handle: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RetryUploadSessionRequest"];
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
    record_capture_transport_failure_extension_captures__session_handle__transport_failure_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_handle: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UploadNetworkFailureRequest"] | components["schemas"]["UploadTimeoutFailureRequest"] | components["schemas"]["UploadHttpRejectedFailureRequest"] | components["schemas"]["UploadAbortedFailureRequest"];
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
    list_library_destinations_extension_library_destinations_get: {
        parameters: {
            query?: {
                q?: string | null;
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
    list_highlights_fragments__fragment_id__highlights_get: {
        parameters: {
            query?: {
                mine_only?: boolean;
            };
            header?: never;
            path: {
                fragment_id: string;
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
    create_highlight_fragments__fragment_id__highlights_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                fragment_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateHighlightRequest"];
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
    recent_generation_effects_generation_effects_get: {
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
    undo_assistant_write_generation_effects__position_id__undo_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                position_id: string;
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
    set_highlight_note_highlights__highlight_id__note_put: {
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
                    "application/json": components["schemas"]["Data_LinkedNoteBlockRef_"];
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
    delete_highlight_note_highlights__highlight_id__note_delete: {
        parameters: {
            query: {
                client_mutation_id: string;
                note_block_id: string;
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
    get_highlight_reader_target_highlights__highlight_id__reader_target_get: {
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
                    "application/json": components["schemas"]["ResolvedHighlightReaderTargetResponse"];
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
                stage?: ("Upload" | "Validate" | "Extract" | "Finalize" | "Index" | "SourceProcessing") | null;
                failure_code?: ("E_SOURCE_INTEGRITY" | "E_INVALID_FILE_TYPE" | "E_FILE_TOO_LARGE" | "E_CAPTURE_TOO_LARGE") | ("E_ARCHIVE_UNSAFE" | "E_BILLING_REQUIRED" | "E_CAPTURE_TOO_LARGE" | "E_FORBIDDEN" | "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH" | "E_INGEST_FAILED" | "E_INGEST_TIMEOUT" | "E_INTERNAL" | "E_INVALID_CONTENT_TYPE" | "E_INVALID_KIND" | "E_INVALID_REQUEST" | "E_LLM_BAD_REQUEST" | "E_MEDIA_NOT_FOUND" | "E_MEDIA_NOT_READY" | "E_OWNER_REQUIRED" | "E_PDF_PASSWORD_REQUIRED" | "E_PDF_TEXT_UNAVAILABLE" | "E_PODCAST_PROVIDER_UNAVAILABLE" | "E_PODCAST_QUOTA_EXCEEDED" | "E_REPAIR_NOT_ALLOWED" | "E_RESOURCE_CONFLICT" | "E_RESOURCE_LIMIT" | "E_RETRY_INVALID_STATE" | "E_RETRY_NOT_ALLOWED" | "E_SANITIZATION_FAILED" | "E_SELECTION_CHANGED" | "E_SIGN_UPLOAD_FAILED" | "E_SOURCE_ACCESS_DENIED" | "E_SOURCE_FETCH_FAILED" | "E_SOURCE_NOT_READABLE" | "E_SOURCE_TOO_LARGE" | "E_SSRF_BLOCKED" | "E_STORAGE_ERROR" | "E_STORAGE_MISSING" | "E_TRANSCRIPTION_FAILED" | "E_TRANSCRIPTION_TIMEOUT" | "E_TRANSCRIPT_UNAVAILABLE" | "E_UPLOAD_CAPABILITY_EXPIRED" | "E_UPLOAD_TRANSPORT_FAILED" | "E_WORKER_HANDLER_FAILED" | "E_WORKER_INTERRUPTED" | "E_X_POST_UNAVAILABLE" | "E_X_PROVIDER_AUTH_REJECTED" | "E_X_PROVIDER_CREDITS_DEPLETED" | "E_X_PROVIDER_RATE_LIMITED" | "E_X_PROVIDER_TIMEOUT" | "E_X_PROVIDER_UNAVAILABLE") | null;
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
    create_offline_reading_token_internal_media__media_id__offline_reading_token_post: {
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
    get_offline_reading_account_binding_internal_offline_reading_account_binding_get: {
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
    create_stream_token_internal_stream_tokens_post: {
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
                    "application/json": components["schemas"]["Data_LecternSnapshot_"];
                };
            };
        };
    };
    post_lectern_command_lectern_commands_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlaceItemsCommand"] | components["schemas"]["RemoveItemCommand"] | components["schemas"]["SetOrderCommand"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LecternResult_"];
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
    get_lectern_slate_lectern_slate_get: {
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
                    "application/json": components["schemas"]["Data_SlateOut_"];
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
    list_viewer_invites_libraries_invites_get: {
        parameters: {
            query?: {
                /** @description Filter by invite status */
                status?: "pending" | "accepted" | "declined" | "revoked";
                /** @description Maximum results (clamped to 200) */
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
                    "application/json": components["schemas"]["Data_list_ViewerLibraryInvitationOut__"];
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
    revoke_library_invite_libraries_invites__invitation_handle__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitation_handle: string;
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
    accept_library_invite_libraries_invites__invitation_handle__accept_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitation_handle: string;
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
                    "application/json": components["schemas"]["Data_AcceptLibraryInviteResponse_"];
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
    decline_library_invite_libraries_invites__invitation_handle__decline_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                invitation_handle: string;
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
                    "application/json": components["schemas"]["Data_DeclineLibraryInviteResponse_"];
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
    list_writable_library_destinations_libraries_writable_destinations_get: {
        parameters: {
            query?: {
                /** @description Name search query */
                q?: string | null;
                /** @description Pagination cursor */
                cursor?: string | null;
                /** @description Maximum results */
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
                    "application/json": components["schemas"]["DataPage_LibraryDestinationOut_LibraryPageInfo_"];
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
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LibraryDeleteOut_"];
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
                "application/json": components["schemas"]["UpdateLibraryRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LibraryRenameOut_"];
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
    list_library_entries_libraries__library_id__entries_get: {
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
                    "application/json": components["schemas"]["Data_CollectionPage_Annotated_Union_LibraryMediaListItemOut__LibraryPodcastListItemOut___FieldInfo_annotation_NoneType__required_True__discriminator__kind_____"];
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
    patch_library_entry_order_libraries__library_id__entries_reorder_patch: {
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
                "application/json": components["schemas"]["LibraryEntryOrderRequest"];
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
    list_library_invites_libraries__library_id__invites_get: {
        parameters: {
            query?: {
                /** @description Filter by invite status */
                status?: "pending" | "accepted" | "declined" | "revoked";
                /** @description Pagination cursor */
                cursor?: string | null;
                /** @description Maximum results (clamped to 200) */
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
                    "application/json": components["schemas"]["DataPage_LibraryInvitationOut_LibraryGovernancePageInfo_"];
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
    create_library_invite_libraries__library_id__invites_post: {
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
                "application/json": components["schemas"]["CreateLibraryInviteRequest"];
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
    list_library_members_libraries__library_id__members_get: {
        parameters: {
            query?: {
                /** @description Pagination cursor */
                cursor?: string | null;
                /** @description Maximum results (clamped to 200) */
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
                    "application/json": components["schemas"]["DataPage_LibraryMemberOut_LibraryGovernancePageInfo_"];
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
    remove_library_member_libraries__library_id__members__user_handle__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
                user_handle: string;
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
    update_library_member_role_libraries__library_id__members__user_handle__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
                user_handle: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateLibraryMemberRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LibraryMemberOut_"];
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
    add_subscribed_podcast_to_library_libraries__library_id__podcasts__podcast_id__put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
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
                    "application/json": components["schemas"]["Data_PodcastPlacementAdditionOut_"];
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
    remove_podcast_from_library_libraries__library_id__podcasts__podcast_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                library_id: string;
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
                    "application/json": components["schemas"]["Data_PodcastPlacementRemovalOut_"];
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
    get_library_slate_libraries__library_id__slate_get: {
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
                    "application/json": components["schemas"]["Data_SlateOut_"];
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
    transfer_library_ownership_libraries__library_id__transfer_ownership_post: {
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
                "application/json": components["schemas"]["TransferLibraryOwnershipRequest"];
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
    get_workspace_session_me_workspace_session_get: {
        parameters: {
            query: {
                device_id: string;
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
    put_workspace_session_me_workspace_session_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceSessionPutRequest"];
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
    list_media_media_get: {
        parameters: {
            query?: {
                /** @description Comma-separated media kind filter (web_article, epub, pdf, video, podcast_episode) */
                kind?: string | null;
                /** @description Optional title substring filter */
                search?: string | null;
                /** @description Pagination cursor */
                cursor?: string | null;
                /** @description Maximum results per page */
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
    create_upload_session_media_uploads_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateUploadSessionRequest"];
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
    delete_upload_session_media_uploads__session_handle__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_handle: string;
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
    confirm_upload_session_media_uploads__session_handle__confirm_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_handle: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfirmUploadSessionRequest"];
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
    retry_upload_session_media_uploads__session_handle__retry_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_handle: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RetryUploadSessionRequest"];
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
    record_upload_transport_failure_media_uploads__session_handle__transport_failure_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_handle: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UploadNetworkFailureRequest"] | components["schemas"]["UploadTimeoutFailureRequest"] | components["schemas"]["UploadHttpRejectedFailureRequest"] | components["schemas"]["UploadAbortedFailureRequest"];
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
    resolve_media_evidence_media__media_id__evidence__evidence_span_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
                evidence_span_id: string;
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
                    "application/json": components["schemas"]["MediaEvidenceResponse"];
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
    get_media_fragments_media__media_id__fragments_get: {
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
                    "application/json": components["schemas"]["Data_list_FragmentOut__"];
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
    get_epub_fragment_media__media_id__fragments__fragment_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
                fragment_id: string;
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
    get_media_libraries_media__media_id__libraries_get: {
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
                    "application/json": components["schemas"]["Data_list_LibraryPlacementOptionOut__"];
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
    add_media_libraries_media__media_id__libraries_post: {
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
                "application/json": components["schemas"]["MediaLibrariesRequest"];
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
    remove_media_library_media__media_id__libraries__library_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
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
                    "application/json": components["schemas"]["Data_LibraryEntryRemovalOut_"];
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
    get_listening_state_media__media_id__listening_state_get: {
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
                    "application/json": components["schemas"]["Data_ListeningStateOut_"];
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
                "application/json": components["schemas"]["ListeningHeartbeatIn"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ListeningHeartbeatResult_"];
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
    get_media_navigation_media__media_id__navigation_get: {
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
                    "application/json": components["schemas"]["Data_MediaNavigationOut_"];
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
    get_offline_download_spec_media__media_id__offline_download_spec_get: {
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
    get_offline_reader_state_media__media_id__offline_reader_state_get: {
        parameters: {
            query?: never;
            header: {
                "X-Nexus-Expected-Account-Id": string;
            };
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
    put_offline_reader_state_media__media_id__offline_reader_state_put: {
        parameters: {
            query?: never;
            header: {
                "X-Nexus-Expected-Account-Id": string;
            };
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OfflineReaderWrite"];
            };
        };
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
    list_pdf_highlights_media__media_id__pdf_highlights_get: {
        parameters: {
            query: {
                /** @description 1-based PDF page number */
                page_number: number;
                mine_only?: boolean;
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
    create_pdf_highlight_media__media_id__pdf_highlights_post: {
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
                "application/json": components["schemas"]["CreatePdfHighlightRequest"];
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
    refresh_media_source_media__media_id__refresh_post: {
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
            202: {
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
    retry_ingest_media__media_id__retry_post: {
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
                    "application/json": components["schemas"]["Data_SourceRetryAdmission_"];
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
    add_media_saved_in_nexus_media__media_id__saved_in_nexus_put: {
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
    remove_media_saved_in_nexus_media__media_id__saved_in_nexus_delete: {
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
                    "application/json": components["schemas"]["Data_LibraryEntryRemovalOut_"];
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
    regenerate_assistant_message_messages__assistant_message_id__regenerate_post: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string | null;
                "X-Nexus-Chat-Contract"?: string | null;
                "X-Nexus-Tool-Projection"?: string | null;
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
    rerun_assistant_message_messages__assistant_message_id__rerun_post: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string | null;
                "X-Nexus-Chat-Contract"?: string | null;
                "X-Nexus-Tool-Projection"?: string | null;
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
    delete_message_messages__message_id__delete: {
        parameters: {
            query?: never;
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
    get_note_block_notes_blocks__block_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                block_id: string;
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
                    "application/json": components["schemas"]["Data_Annotated_Union_LatentDailyPageDescriptor__MaterializedDailyPageDescriptor___FieldInfo_annotation_NoneType__required_True__discriminator__kind____"];
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
    capture_daily_page_note_notes_daily__local_date__captures_post: {
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
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_DailyCaptureResult_"];
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
                    "application/json": components["schemas"]["Data_NotePagesOut_"];
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
                    "application/json": components["schemas"]["Data_NotePageOut_"];
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
    get_page_notes_pages__page_id__get: {
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
                    "application/json": components["schemas"]["Data_NotePageOut_"];
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
    update_page_notes_pages__page_id__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                page_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdatePageRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_NotePageOut_"];
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
    get_offline_reading_package_offline_reading_packages__media_id__get: {
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
    get_oracle_plate_oracle_plates__image_id__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                image_id: string;
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
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    create_oracle_reading_oracle_readings_post: {
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
    get_oracle_reading_concordance_oracle_readings__reading_id__concordance_get: {
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
    resolve_passage_anchor_passage_anchors__anchor_id__resolution_get: {
        parameters: {
            query: {
                owner_ref: string;
            };
            header?: never;
            path: {
                anchor_id: string;
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
    acquire_podcast_episode_podcast_episodes_from_discovery_post: {
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
            header: {
                "Idempotency-Key": string;
            };
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
            header: {
                "Idempotency-Key": string;
            };
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
    retry_subscription_backfill_podcasts_subscriptions__podcast_id__backfill_retry_post: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
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
                    "application/json": components["schemas"]["Data_PodcastSubscriptionSettingsOut_"];
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
    mark_podcast_episode_selection_played_podcasts__podcast_id__episodes_mark_played_post: {
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
    get_podcast_libraries_podcasts__podcast_id__libraries_get: {
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
                    "application/json": components["schemas"]["Data_list_LibraryPlacementOptionOut__"];
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
    get_public_resource_share_asset_public_resource_share_assets__asset_handle__get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Share-Token"?: string;
            };
            path: {
                asset_handle: string;
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
    get_public_resource_share_section_public_resource_share_sections__section_handle__get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Share-Token"?: string;
            };
            path: {
                section_handle: string;
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
                    "application/json": components["schemas"]["Data_PublicSectionOut_"];
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
    create_link_resource_graph_links_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateLinkRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_CreateLinkOut_"];
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
    delete_link_resource_graph_links__link_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                link_id: string;
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
    put_link_note_resource_graph_links__link_id__note_put: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                link_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PutLinkNoteRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_LinkNoteOut_"];
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
    delete_link_note_resource_graph_links__link_id__note_delete: {
        parameters: {
            query: {
                note_block_id: string;
                client_mutation_id: string;
            };
            header?: never;
            path: {
                link_id: string;
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
    put_stance_resource_graph_stances_put: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PutStanceRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_StanceOut_"];
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
    delete_stance_resource_graph_stances__stance_id__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                stance_id: string;
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
    resolve_action_snapshots_resource_items_action_snapshots_resolve_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResourceActionSnapshotResolveRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ResourceActionSnapshotResolveResponse_"];
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
    resolve_resource_locators_resource_items_locators_resolve_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResourceLocatorResolveRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ResourceLocatorResolveResponse_"];
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
    search_openable_resources_resource_items_openables_search_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResourceOpenableSearchRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ResourceOpenableSearchResponse_"];
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
    update_resource_body_resource_items__resource_ref__body_patch: {
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
                "application/json": components["schemas"]["ResourceBodyMutationRequest"];
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
    get_resource_surface_resource_items__resource_ref__surface_get: {
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
                    "application/json": components["schemas"]["Data_ResourceSurfaceOut_"];
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
    execute_resource_surface_command_resource_items__resource_ref__surface_commands_post: {
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
                "application/json": components["schemas"]["ResourceSurfaceCommandRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ResourceSurfaceCommandOut_"];
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
    update_resource_title_resource_items__resource_ref__title_patch: {
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
                "application/json": components["schemas"]["ResourceTitleMutationRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_ResourceTitleMutationOut_"];
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
    delete_resource_share_resource_shares__resource_grant_handle__delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                resource_grant_handle: string;
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
                /** @description Search query string */
                q?: string;
                /** @description Search scope (all, media:<id>, library:<id>, conversation:<id>) */
                scope?: string;
                /** @description Comma-separated user kinds (documents, notes, highlights, conversations, people, web). Omitted ⇒ all kinds; explicitly empty ⇒ no results. */
                kinds?: string | null;
                /** @description Comma-separated document formats (article, pdf, epub, video, episode, podcast). */
                formats?: string | null;
                /** @description Comma-separated contributor handles to filter credited content. */
                authors?: string | null;
                /** @description Comma-separated contributor credit roles to filter content. */
                roles?: string | null;
                /** @description Pagination cursor */
                cursor?: string | null;
                /** @description Maximum results per page (default 20, max 50) */
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
                    "application/json": components["schemas"]["SearchResponse"];
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
                after?: number | null;
            };
            header?: {
                "X-Nexus-Chat-Contract"?: string | null;
                "X-Nexus-Tool-Projection"?: string | null;
                "Last-Event-ID"?: string | null;
                "X-Nexus-SSE-Attempt"?: string | null;
            };
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
            query?: {
                after?: number | null;
            };
            header?: {
                "Last-Event-ID"?: string | null;
            };
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
    dismiss_edge_synapse_edges__edge_id__dismiss_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                edge_id: string;
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
    read_scan_status_synapse_scans_get: {
        parameters: {
            query: {
                /** @description Source object ref, e.g. 'highlight:<uuid>' */
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
    request_scan_synapse_scans_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SynapseScanRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            202: {
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
                /** @description Search query (min 3 chars) */
                q: string;
                /** @description Max results */
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
