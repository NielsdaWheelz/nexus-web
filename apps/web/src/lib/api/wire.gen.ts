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
    "/artifact-revisions/{artifact_revision_ref}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Dossier Revision */
        get: operations["get_dossier_revision_artifact_revisions__artifact_revision_ref__get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/artifact-revisions/{artifact_revision_ref}/make-current": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Make Dossier Revision Current */
        post: operations["make_dossier_revision_current_artifact_revisions__artifact_revision_ref__make_current_post"];
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
    "/artifacts/{artifact_ref}/revisions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Dossier Revisions */
        get: operations["list_dossier_revisions_artifacts__artifact_ref__revisions_get"];
        put?: never;
        post?: never;
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
         * @description Return the grand atlas read model, ETag-cacheable by max(computed_at).
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
    "/billing/account": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Billing Account */
        get: operations["get_billing_account_billing_account_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/billing/checkout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Checkout Session */
        post: operations["create_checkout_session_billing_checkout_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/billing/portal": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create Customer Portal Session */
        post: operations["create_customer_portal_session_billing_portal_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/billing/stripe/webhook": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Process Stripe Webhook */
        post: operations["process_stripe_webhook_billing_stripe_webhook_post"];
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
        /**
         * Post Activity
         * @description Persist one BFF-injected device-scoped activity batch.
         */
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
        /**
         * Post Activity Exclusion
         * @description Exclude one exact observed session or restore its exclusion.
         */
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
        /** Rename Contributor */
        patch: operations["rename_contributor_contributors__contributor_handle__patch"];
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
         *     An explicit ``q`` selects the retained destination picker and an explicit
         *     ``has_context_ref`` the retained resource-graph mode; both keep the manual
         *     ``{data, page}`` envelope. Every other request is the finite primary index.
         *
         *     Errors:
         *         E_INVALID_REQUEST (400): a view state outside the advertised inventory,
         *             a malformed has_context_ref URI, or ``q`` over its length bound.
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
         * @description Proxy an external image with SSRF validation, ETag caching and 304s.
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
    "/media/{media_handle}/intelligence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Media Intelligence */
        get: operations["get_media_intelligence_media__media_handle__intelligence_get"];
        put?: never;
        post?: never;
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
    "/media/{media_id}/epub-find": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Find In Epub */
        post: operations["find_in_epub_media__media_id__epub_find_post"];
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
         * @description Admit a new source attempt, or re-enrich metadata, for a viewer's media.
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
         * @description Admit or forecast an explicit transcript request for supported Media.
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
         * @description Consume one package token and transfer one verified immutable ZIP.
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
    "/oracle/corpus": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Oracle Corpus Status */
        get: operations["get_oracle_corpus_status_oracle_corpus_get"];
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
    "/public/resource-share/fragments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Public Resource Share Fragments */
        get: operations["get_public_resource_share_fragments_public_resource_share_fragments_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/public/resource-share/navigation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Public Resource Share Navigation */
        get: operations["get_public_resource_share_navigation_public_resource_share_navigation_get"];
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
        /** Stream Artifact Build Events */
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
    "/telemetry/web-vitals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Post Web Vital
         * @description Record one Core Web Vital sample as a ``rum.web_vital`` structlog line.
         */
        post: operations["post_web_vital_telemetry_web_vitals_post"];
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
    "/vault": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Export Vault */
        get: operations["export_vault_vault_get"];
        put?: never;
        /** Sync Vault */
        post: operations["sync_vault_vault_post"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vault/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Download Vault */
        get: operations["download_vault_vault_download_get"];
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
    "/walknotes/transcribe-audio": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Transcribe Walknote Audio
         * @description Entitlement-gated, 10 MB-bounded Deepgram transcription.
         */
        post: operations["transcribe_walknote_audio_walknotes_transcribe_audio_post"];
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
        Absent: {
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
        /**
         * ActivityRecordIn
         * @description Trusted backend activity record; the BFF alone injects ``deviceId``.
         *
         *     ``clientMutationId`` is a wire no-op the shipped Android app still sends
         *     (ticket oi-170); ``extra="forbid"`` means it must stay declared.
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
        /** BillingAccountOut */
        BillingAccountOut: {
            /** Billing Enabled */
            billing_enabled: boolean;
            /**
             * Billing Plan Tier
             * @enum {string}
             */
            billing_plan_tier: "free" | "plus" | "ai_plus" | "ai_pro";
            /** Billing Status */
            billing_status: string;
            /** Can Manage Billing */
            can_manage_billing: boolean;
            /** Can Share */
            can_share: boolean;
            /** Can Transcribe */
            can_transcribe: boolean;
            /** Cancel At Period End */
            cancel_at_period_end: boolean;
            /** Entitlement Expires At */
            entitlement_expires_at: string | null;
            /**
             * Entitlement Plan Tier
             * @enum {string}
             */
            entitlement_plan_tier: "free" | "plus" | "ai_plus" | "ai_pro";
            /**
             * Entitlement Source
             * @enum {string}
             */
            entitlement_source: "free" | "subscription" | "internal_grant";
            /** Subscription Current Period End */
            subscription_current_period_end: string | null;
            /** Subscription Current Period Start */
            subscription_current_period_start: string | null;
            transcription_usage: components["schemas"]["BillingUsageBucketOut"];
        };
        /** BillingCheckoutRequest */
        BillingCheckoutRequest: {
            /**
             * Plan Tier
             * @enum {string}
             */
            plan_tier: "plus" | "ai_plus" | "ai_pro";
        };
        /** BillingSessionOut */
        BillingSessionOut: {
            /** Url */
            url: string;
        };
        /** BillingUsageBucketOut */
        BillingUsageBucketOut: {
            /** Limit */
            limit: number | null;
            /**
             * Period End
             * Format: date-time
             */
            period_end: string;
            /**
             * Period Start
             * Format: date-time
             */
            period_start: string;
            /** Remaining */
            remaining: number | null;
            /** Reserved */
            reserved: number;
            /** Used */
            used: number;
        };
        /** BillingWebhookOut */
        BillingWebhookOut: {
            /** Processed */
            processed: boolean;
        };
        /** Body_transcribe_walknote_audio_walknotes_transcribe_audio_post */
        Body_transcribe_walknote_audio_walknotes_transcribe_audio_post: {
            /** Audio */
            audio: string;
            /** Content Type */
            content_type: string;
        };
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
        /** CancelledEventPayload */
        CancelledEventPayload: {
            actor: components["schemas"]["Presence_UUID_"];
            /**
             * At
             * Format: date-time
             */
            at: string;
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
            error_code: components["schemas"]["Presence_str_"];
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
            support_id: components["schemas"]["Presence_str_"];
            /** Usage */
            usage: {
                [key: string]: unknown;
            } | null;
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
        /** CitationOut */
        CitationOut: {
            activation: components["schemas"]["ResourceActivationOut"];
            /** Deep Link */
            deep_link?: string | null;
            /** Locator */
            locator?: (components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"]) | null;
            /** Media Id */
            media_id?: string | null;
            /** Ordinal */
            ordinal: number;
            /**
             * Role
             * @enum {string}
             */
            role: "context" | "supports" | "contradicts";
            snapshot?: components["schemas"]["CitationSnapshot"] | null;
            target_ref: components["schemas"]["CitationTargetRef"];
        };
        /** CitationSnapshot */
        CitationSnapshot: {
            /** Excerpt */
            excerpt?: string | null;
            /** Result Type */
            result_type?: string | null;
            /** Section Label */
            section_label?: string | null;
            /** Summary Md */
            summary_md?: string | null;
            /** Title */
            title?: string | null;
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
            run_id: components["schemas"]["Presence_UUID_"];
            /** Visit Id */
            visit_id: string;
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
        /** ConfirmUploadSessionRequest */
        ConfirmUploadSessionRequest: {
            /** Generation */
            generation: number;
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
        /** ConsumeHandoffCodeRequest */
        ConsumeHandoffCodeRequest: {
            /** Code */
            code: string;
            /** Verifier */
            verifier: string;
        };
        /**
         * ContributorCreditOut
         * @description One ordered credit fact; discovery text facts have no handle or href.
         */
        ContributorCreditOut: {
            /** Contributor Display Name */
            contributor_display_name?: string | null;
            /** Contributor Handle */
            contributor_handle?: string | null;
            /** Credited Name */
            credited_name: string;
            /** Href */
            href?: string | null;
            /** Ordinal */
            ordinal?: number | null;
            /** Raw Role */
            raw_role?: string | null;
            /**
             * Role
             * @enum {string}
             */
            role: "author" | "editor" | "translator" | "host" | "guest" | "narrator" | "creator" | "producer" | "publisher" | "channel" | "organization" | "unknown";
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
        /** ContributorRenameRequest */
        ContributorRenameRequest: {
            /** Clientmutationid */
            clientMutationId: string;
            /** Displayname */
            displayName: string;
        };
        /**
         * ConversationArtifactSearchOut
         * @description A current Conversation Dossier claim; the exact revision ref preserves
         *     historical selection while activation opens the conversation subject.
         */
        ConversationArtifactSearchOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["SearchResultActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
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
        /**
         * CursorWrite
         * @description Conditional cursor replacement against an acknowledged base revision.
         */
        CursorWrite: {
            /** Base Revision */
            base_revision: number;
            /** Locator */
            locator: components["schemas"]["PdfReaderResumeState"] | components["schemas"]["WebReaderResumeState"] | components["schemas"]["TranscriptReaderResumeState"] | components["schemas"]["EpubReaderResumeState"];
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
        /** Data[BillingAccountOut] */
        Data_BillingAccountOut_: {
            data: components["schemas"]["BillingAccountOut"];
        };
        /** Data[BillingSessionOut] */
        Data_BillingSessionOut_: {
            data: components["schemas"]["BillingSessionOut"];
        };
        /** Data[BillingWebhookOut] */
        Data_BillingWebhookOut_: {
            data: components["schemas"]["BillingWebhookOut"];
        };
        /** DirectNaturalEndOrigin */
        DirectNaturalEndOrigin: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Direct";
        };
        /**
         * DossierBuildFailureCode
         * @description The only codes that become an ``artifact_build_failures`` row.
         * @enum {string}
         */
        DossierBuildFailureCode: "NoSourceMaterial" | "InputsChanged" | "DependencyProjectionFailed" | "ContextTooLarge" | "Auth" | "Quota" | "Timeout" | "OutputLimit" | "InvalidOutput" | "PolicyViolation" | "RuntimeUnavailable" | "CapacityUnavailable" | "DocumentValidationFailed" | "CitationValidationFailed";
        /** DossierGenerateRequest */
        DossierGenerateRequest: {
            instruction: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MaxLen_max_length_4000_____"];
        };
        /**
         * DurableExecutionOut
         * @description Advisory queue/coordination state; never a persisted run status.
         */
        DurableExecutionOut: {
            phase: components["schemas"]["DurableExecutionPhase"];
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
        /** EpubFindEntireResourceScopeIn */
        EpubFindEntireResourceScopeIn: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "EntireResource";
        };
        /** EpubFindRequest */
        EpubFindRequest: {
            /** Match Case */
            match_case: boolean;
            /** Query */
            query: string;
            /** Scope */
            scope: components["schemas"]["EpubFindEntireResourceScopeIn"] | components["schemas"]["EpubFindSectionScopeIn"];
            /** Source Generation */
            source_generation: number;
            /**
             * Source Witness Fragment Id
             * Format: uuid
             */
            source_witness_fragment_id: string;
            /** Whole Word */
            whole_word: boolean;
        };
        /** EpubFindSectionScopeIn */
        EpubFindSectionScopeIn: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Section";
            /** Section Id */
            section_id: string;
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
            /** Text Quote Selector */
            text_quote_selector?: {
                [key: string]: unknown;
            } | null;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "epub_fragment_offsets";
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
        /** FailedEventPayload */
        FailedEventPayload: {
            detail: components["schemas"]["Presence_str_"];
            failure_code: components["schemas"]["DossierBuildFailureCode"];
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
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
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
        /** LearnDossierRequest */
        LearnDossierRequest: {
            /** Highlight Ref */
            highlight_ref: string;
        };
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
        /** LibraryEntryOrderRequest */
        LibraryEntryOrderRequest: {
            /** Entry Ids */
            entry_ids: string[];
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
            progressEnd: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____"];
            progressStart: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____"];
        };
        /**
         * ListeningHeartbeatIn
         * @description PUT body for ``/media/{id}/listening-state``: every field required.
         */
        ListeningHeartbeatIn: {
            durationMs: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____"];
            episodePlaybackRate: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____"];
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
        /**
         * NexusSelectionRecordRequest
         * @description POST body for one accepted internal Nexus selection.
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
        /** OfflineReaderWrite */
        OfflineReaderWrite: {
            /** Baserevision */
            baseRevision: number;
            /** Expectedreadergeneration */
            expectedReaderGeneration: number;
            /** Locator */
            locator: components["schemas"]["PdfReaderResumeState"] | components["schemas"]["WebReaderResumeState"] | components["schemas"]["TranscriptReaderResumeState"] | components["schemas"]["EpubReaderResumeState"];
        };
        /** OperatorActionRequired */
        OperatorActionRequired: {
            /** Action */
            action: string;
            /**
             * Code
             * @enum {string}
             */
            code: "catalog_refresh_failed" | "codex_host_unavailable" | "credential_unavailable";
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
        /** OracleBindEventPayload */
        OracleBindEventPayload: {
            /** Folio Motto */
            folio_motto: string;
            /** Folio Motto Gloss */
            folio_motto_gloss?: string | null;
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
            year?: string | null;
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
            citation?: components["schemas"]["CitationOut"] | null;
            /** Deep Link */
            deep_link?: string | null;
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
            /** Text Quote Selector */
            text_quote_selector?: {
                [key: string]: unknown;
            } | null;
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
        /** PodcastEpisodeFromDiscoveryRequest */
        PodcastEpisodeFromDiscoveryRequest: {
            /** Namedlibraryids */
            namedLibraryIds?: string[];
            /** Target */
            target: string;
        };
        /** PodcastEpisodeQueryTranscriptRequest */
        PodcastEpisodeQueryTranscriptRequest: {
            /** Selectionfingerprint */
            selectionFingerprint: string;
            target: components["schemas"]["PodcastEpisodeQueryTranscriptTarget"];
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
        /** PodcastSubscribeRequest */
        PodcastSubscribeRequest: {
            /** Namedlibraryids */
            namedLibraryIds?: string[];
            replacementConfirmation: components["schemas"]["Presence_PodcastReplacementConfirmation_"];
            /** Target */
            target: components["schemas"]["PodcastDiscoveryCommitTarget"] | components["schemas"]["PodcastCanonicalCommitTarget"];
        };
        /**
         * PodcastSubscriptionLifecycleBackfillOut
         * @description The lifecycle stream's stable, browser-shaped backfill projection.
         */
        PodcastSubscriptionLifecycleBackfillOut: {
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
        /**
         * PodcastSubscriptionLifecycleSnapshotOut
         * @description One viewer-owned subscription's live sync and initial-backfill state.
         */
        PodcastSubscriptionLifecycleSnapshotOut: {
            backfill: components["schemas"]["PodcastSubscriptionLifecycleBackfillOut"];
            /**
             * Podcastid
             * Format: uuid
             */
            podcastId: string;
            syncStatus: components["schemas"]["PodcastSyncStatus"];
        };
        /** PodcastSubscriptionSettingsPatchRequest */
        PodcastSubscriptionSettingsPatchRequest: {
            /** Auto Queue */
            auto_queue?: boolean | null;
            default_playback_speed?: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____"];
            pause_shortening_mode?: components["schemas"]["Presence_Literal__Off____Natural___"];
        };
        /** @enum {string} */
        PodcastSyncStatus: "Pending" | "Running" | "Complete" | "SourceLimited" | "Failed";
        Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____: components["schemas"]["Absent"] | components["schemas"]["Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____"];
        Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____: components["schemas"]["Absent"] | components["schemas"]["Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____"];
        Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____: components["schemas"]["Absent"] | components["schemas"]["Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____"];
        Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_9223372036854775807_____: components["schemas"]["Absent"] | components["schemas"]["Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_9223372036854775807_____"];
        Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___Ge_ge_0___Le_le_2147483647_____: components["schemas"]["Absent"] | components["schemas"]["Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___Ge_ge_0___Le_le_2147483647_____"];
        Presence_Annotated_list_Literal__media____library____evidence_span____content_chunk____highlight____page____note_block____fragment____conversation____message____oracle_reading____oracle_passage_anchor____artifact____artifact_revision____external_snapshot____contributor____podcast____reader_apparatus_item____passage_anchor_____FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____: components["schemas"]["Absent"] | components["schemas"]["Present_Annotated_list_Literal__media____library____evidence_span____content_chunk____highlight____page____note_block____fragment____conversation____message____oracle_reading____oracle_passage_anchor____artifact____artifact_revision____external_snapshot____contributor____podcast____reader_apparatus_item____passage_anchor_____FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____"];
        Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MaxLen_max_length_4000_____: components["schemas"]["Absent"] | components["schemas"]["Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MaxLen_max_length_4000_____"];
        Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_128_____: components["schemas"]["Absent"] | components["schemas"]["Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_128_____"];
        Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_200_____: components["schemas"]["Absent"] | components["schemas"]["Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1___MaxLen_max_length_200_____"];
        Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__: components["schemas"]["Absent"] | components["schemas"]["Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__"];
        Presence_Annotated_str__StringConstraints__AfterValidator__: components["schemas"]["Absent"] | components["schemas"]["Present_Annotated_str__StringConstraints__AfterValidator__"];
        Presence_ChatPublicationWarning_: components["schemas"]["Absent"] | components["schemas"]["Present_ChatPublicationWarning_"];
        Presence_Literal__Off____Natural___: components["schemas"]["Absent"] | components["schemas"]["Present_Literal__Off____Natural___"];
        Presence_MediaDurationOut_: components["schemas"]["Absent"] | components["schemas"]["Present_MediaDurationOut_"];
        Presence_PodcastReplacementConfirmation_: components["schemas"]["Absent"] | components["schemas"]["Present_PodcastReplacementConfirmation_"];
        Presence_ReaderSelectionInput_: components["schemas"]["Absent"] | components["schemas"]["Present_ReaderSelectionInput_"];
        Presence_ReaderTimeRange_: components["schemas"]["Absent"] | components["schemas"]["Present_ReaderTimeRange_"];
        Presence_UUID_: components["schemas"]["Absent"] | components["schemas"]["Present_UUID_"];
        Presence_str_: components["schemas"]["Absent"] | components["schemas"]["Present_str_"];
        /** Present[Annotated[float, FieldInfo(annotation=NoneType, required=True, metadata=[Ge(ge=0), Le(le=1)])]] */
        Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[float, FieldInfo(annotation=NoneType, required=True, metadata=[Strict(strict=True), Ge(ge=0.5), Le(le=3)])]] */
        Present_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: number;
        };
        /** Present[Annotated[int, FieldInfo(annotation=NoneType, required=True, metadata=[Ge(ge=0), Le(le=2147483647)])]] */
        Present_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____: {
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
        /** Present[Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MaxLen(max_length=4000)])]] */
        Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MaxLen_max_length_4000_____: {
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
        /** Present[Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1)]), AfterValidator]] */
        Present_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__: {
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
        /** Present[ChatPublicationWarning] */
        Present_ChatPublicationWarning_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ChatPublicationWarning"];
        };
        /** Present[Literal['Off', 'Natural']] */
        Present_Literal__Off____Natural___: {
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
        /** Present[MediaDurationOut] */
        Present_MediaDurationOut_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["MediaDurationOut"];
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
        /** Present[ReaderSelectionInput] */
        Present_ReaderSelectionInput_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            value: components["schemas"]["ReaderSelectionInput"];
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
        /** Present[UUID] */
        Present_UUID_: {
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
        /** Present[str] */
        Present_str_: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "Present";
            /** Value */
            value: string;
        };
        /**
         * PreviewPositionIn
         * @description One post-acquisition transfer from an ephemeral Preview audio session.
         */
        PreviewPositionIn: {
            durationMs: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____"];
            /** Positionms */
            positionMs: number;
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
        /** ProgressEventPayload */
        ProgressEventPayload: {
            /** Message */
            message: string;
            /** Phase */
            phase: string;
        };
        /** ProviderApiSelection */
        ProviderApiSelection: {
            /** Model Ref */
            model_ref: string;
            /**
             * Reasoning
             * @enum {string}
             */
            reasoning: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            route: "ProviderApi";
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
        /** ReaderEpubTarget */
        ReaderEpubTarget: {
            anchor_id: components["schemas"]["Presence_Annotated_str__FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____AfterValidator__"];
            /**
             * Fragment Id
             * Format: uuid
             */
            fragment_id: string;
            /** Href Path */
            href_path: string;
        };
        /** ReaderFragmentTarget */
        ReaderFragmentTarget: {
            /** Fragment Id */
            fragment_id: string;
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
            progressEnd: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____"];
            progressStart: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_1_____"];
            wordEnd: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_9223372036854775807_____"];
            wordStart: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_9223372036854775807_____"];
        };
        /** ReadingTimeEstimateOut */
        ReadingTimeEstimateOut: {
            remainingMinutes: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True___Ge_ge_0___Le_le_2147483647_____"];
            /** Totalminutes */
            totalMinutes: number;
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
        /** RenameBranchRequest */
        RenameBranchRequest: {
            /** Title */
            title?: string | null;
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
        /** ResourceActivationOut */
        ResourceActivationOut: {
            /** Href */
            href?: string | null;
            /**
             * Kind
             * @enum {string}
             */
            kind: "route" | "external" | "none";
            /** Resource Ref */
            resource_ref: string;
            /** Unresolved Reason */
            unresolved_reason?: string | null;
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
        /** ResourceLocatorResolveRequest */
        ResourceLocatorResolveRequest: {
            /** Locators */
            locators: (components["schemas"]["ResourceRefLocatorIn"] | components["schemas"]["ContributorHandleLocatorIn"])[];
        };
        /** ResourceOpenableSearchRequest */
        ResourceOpenableSearchRequest: {
            /** Q */
            q: string;
            schemes: components["schemas"]["Presence_Annotated_list_Literal__media____library____evidence_span____content_chunk____highlight____page____note_block____fragment____conversation____message____oracle_reading____oracle_passage_anchor____artifact____artifact_revision____external_snapshot____contributor____podcast____reader_apparatus_item____passage_anchor_____FieldInfo_annotation_NoneType__required_True__metadata__MinLen_min_length_1_____"];
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
        /** ResourceTitleMutationRequest */
        ResourceTitleMutationRequest: {
            /** Base Versions */
            base_versions?: components["schemas"]["ResourceLaneVersionIn"][];
            /** Client Mutation Id */
            client_mutation_id: string;
            /** Title */
            title: string;
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
        /**
         * RetryMetadataRequest
         * @description Re-enrich metadata; no idempotency ledger.
         */
        RetryMetadataRequest: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            from_stage: "metadata";
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
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            from_stage: "source";
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
            /** Current State */
            current_state: components["schemas"]["Selectable"] | components["schemas"]["Ineligible"] | components["schemas"]["OperatorActionRequired"] | components["schemas"]["TemporarilyUnavailable"];
            /**
             * Current State Observed At
             * Format: date-time
             */
            current_state_observed_at: string;
            display_at_dispatch: components["schemas"]["SelectionPresentation"];
            /** Rerun Eligibility */
            rerun_eligibility: boolean;
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
            next_cursor?: string | null;
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
            page?: components["schemas"]["SearchPageInfo"];
            /** Results */
            results?: (components["schemas"]["SearchResultMediaOut"] | components["schemas"]["SearchResultPodcastOut"] | components["schemas"]["SearchResultContentChunkOut"] | components["schemas"]["SearchResultFragmentOut"] | components["schemas"]["SearchResultContributorOut"] | components["schemas"]["SearchResultPageOut"] | components["schemas"]["SearchResultNoteBlockOut"] | components["schemas"]["SearchResultHighlightOut"] | components["schemas"]["SearchResultMessageOut"] | components["schemas"]["SearchResultEvidenceSpanOut"] | components["schemas"]["SearchResultReaderApparatusItemOut"] | components["schemas"]["SearchResultConversationOut"] | components["schemas"]["ConversationArtifactSearchOut"] | components["schemas"]["SearchResultWebOut"])[];
        };
        /**
         * SearchResultActivationOut
         * @description Search-owned snake-case occurrence activation.
         *
         *     A local DTO so the response's ``by_alias=True`` dump cannot leak the
         *     resource-items activation aliases onto this boundary.
         */
        SearchResultActivationOut: {
            /** Href */
            href?: string | null;
            /**
             * Kind
             * @enum {string}
             */
            kind: "route" | "external" | "none";
            /** Resource Ref */
            resource_ref: string;
            /** Unresolved Reason */
            unresolved_reason?: string | null;
        };
        /**
         * SearchResultContentChunkOut
         * @description An indexed document passage.
         */
        SearchResultContentChunkOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["SearchResultActivationOut"];
            /** Citation Label */
            citation_label: string;
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /** Evidence Span Ids */
            evidence_span_ids?: string[];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
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
            source_label?: string | null;
            /** Title */
            title: string;
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "content_chunk";
        };
        SearchResultContextRefOut: {
            [key: string]: unknown;
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
            activation: components["schemas"]["SearchResultActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            contributor: components["schemas"]["SearchResultContributorIdentityOut"];
            /** Contributor Handle */
            contributor_handle: string;
            /** Id */
            id: string;
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
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
        /**
         * SearchResultConversationOut
         * @description A visible conversation.
         */
        SearchResultConversationOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["SearchResultActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
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
        /**
         * SearchResultEvidenceSpanOut
         * @description One durable evidence span, produced only by citation reopen.
         */
        SearchResultEvidenceSpanOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["SearchResultActivationOut"];
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
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
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
            source_label?: string | null;
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
            activation: components["schemas"]["SearchResultActivationOut"];
            /** Citation Label */
            citation_label?: string | null;
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
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
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
            source_label?: string | null;
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
            activation: components["schemas"]["SearchResultActivationOut"];
            /** Citation Label */
            citation_label?: string | null;
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
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
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
            source_label?: string | null;
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
            activation: components["schemas"]["SearchResultActivationOut"];
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
            activation: components["schemas"]["SearchResultActivationOut"];
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
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
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
            source_label?: string | null;
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
            activation: components["schemas"]["SearchResultActivationOut"];
            /** Body Text */
            body_text: string;
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /** Highlight Excerpt */
            highlight_excerpt?: string | null;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
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
            source_label?: string | null;
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
            activation: components["schemas"]["SearchResultActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
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
        /**
         * SearchResultPodcastOut
         * @description A visible podcast hit.
         */
        SearchResultPodcastOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["SearchResultActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /** Contributors */
            contributors?: components["schemas"]["ContributorCreditOut"][];
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Resource Ref */
            resource_ref: string;
            /** Score */
            score: number;
            /** Snippet */
            snippet: string;
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
        /**
         * SearchResultReaderApparatusItemOut
         * @description A source-authored reader apparatus row.
         */
        SearchResultReaderApparatusItemOut: {
            /** Actionsubjectref */
            actionSubjectRef: string;
            activation: components["schemas"]["SearchResultActivationOut"];
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
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
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
         * SearchResultSourceOut
         * @description Source metadata shared by media-anchored rows.
         */
        SearchResultSourceOut: {
            /** Contributors */
            contributors?: components["schemas"]["ContributorCreditOut"][];
            /**
             * Media Id
             * Format: uuid
             */
            media_id: string;
            /** Media Kind */
            media_kind: string;
            original_published_date: components["schemas"]["Presence_Annotated_str__StringConstraints__AfterValidator__"];
            /** Summary Md */
            summary_md?: string | null;
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
            activation: components["schemas"]["SearchResultActivationOut"];
            /** Citation Target */
            citation_target: string | null;
            context_ref: components["schemas"]["SearchResultContextRefOut"];
            /** Display Url */
            display_url?: string | null;
            /** Extra Snippets */
            extra_snippets?: string[];
            /** Id */
            id: string;
            /** Locator */
            locator: components["schemas"]["WebTextOffsetsLocator"] | components["schemas"]["EpubFragmentOffsetsLocator"] | components["schemas"]["NoteBlockOffsetsLocator"] | components["schemas"]["PdfPageGeometryLocator"] | components["schemas"]["TranscriptTimeRangeLocator"] | components["schemas"]["PlaybackTimeRangeLocator"] | components["schemas"]["MessageOffsetsLocator"] | components["schemas"]["ExternalUrlLocator"];
            /** Media Id */
            media_id?: string | null;
            /** Media Kind */
            media_kind?: string | null;
            /** Owner Resource Ref */
            owner_resource_ref: string;
            /** Provider */
            provider?: string | null;
            /** Provider Request Id */
            provider_request_id?: string | null;
            /** Published At */
            published_at?: string | null;
            /** Rank */
            rank?: number | null;
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
            expectedConsumptionOverrideRevision: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____"];
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
        /** StartedEventPayload */
        StartedEventPayload: {
            /** Artifact Ref */
            artifact_ref: string;
            /** Build Handle */
            build_handle: string;
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
        /** SucceededEventPayload */
        SucceededEventPayload: {
            /** Artifact Revision Ref */
            artifact_revision_ref: string;
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
            code: "catalog_refresh_failed" | "codex_host_unavailable" | "credential_unavailable";
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
            durationMs: components["schemas"]["Presence_Annotated_int__FieldInfo_annotation_NoneType__required_True__metadata__Ge_ge_0___Le_le_2147483647_____"];
            episodePlaybackRate: components["schemas"]["Presence_Annotated_float__FieldInfo_annotation_NoneType__required_True__metadata__Strict_strict_True__5___Le_le_3_____"];
            /** Expectedresetepoch */
            expectedResetEpoch: number;
            /** Expectedwriterevision */
            expectedWriteRevision: number;
            /** Positionms */
            positionMs: number;
        };
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
        /** TranscriptRequestRequest */
        TranscriptRequestRequest: {
            /**
             * Dry Run
             * @default false
             */
            dry_run: boolean;
            /**
             * Reason
             * @default episode_open
             * @enum {string}
             */
            reason: "episode_open" | "search" | "highlight" | "quote" | "background_warming" | "operator_requeue";
        };
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
            /** Text Quote Selector */
            text_quote_selector?: {
                [key: string]: unknown;
            } | null;
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
        /** VaultEditableFileIn */
        VaultEditableFileIn: {
            /** Content */
            content: string;
            /** Path */
            path: string;
        };
        /** VaultSyncRequest */
        VaultSyncRequest: {
            /** Files */
            files: components["schemas"]["VaultEditableFileIn"][];
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
            /** Text Quote Selector */
            text_quote_selector?: {
                [key: string]: unknown;
            } | null;
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
         * WebVitalRequest
         * @description One Core Web Vital sample reported by the browser.
         */
        WebVitalRequest: {
            /** Href */
            href: string;
            /** Id */
            id: string;
            /**
             * Name
             * @enum {string}
             */
            name: "LCP" | "INP" | "CLS" | "TTFB";
            /** Nav Id */
            nav_id: string;
            /**
             * Rating
             * @enum {string}
             */
            rating: "good" | "needs-improvement" | "poor";
            /** Value */
            value: number;
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
    get_dossier_revision_artifact_revisions__artifact_revision_ref__get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                artifact_revision_ref: string;
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
    make_dossier_revision_current_artifact_revisions__artifact_revision_ref__make_current_post: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                artifact_revision_ref: string;
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
    list_dossier_revisions_artifacts__artifact_ref__revisions_get: {
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
    get_billing_account_billing_account_get: {
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
                    "application/json": components["schemas"]["Data_BillingAccountOut_"];
                };
            };
        };
    };
    create_checkout_session_billing_checkout_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BillingCheckoutRequest"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Data_BillingSessionOut_"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    create_customer_portal_session_billing_portal_post: {
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
                    "application/json": components["schemas"]["Data_BillingSessionOut_"];
                };
            };
        };
    };
    process_stripe_webhook_billing_stripe_webhook_post: {
        parameters: {
            query?: never;
            header?: {
                "stripe-signature"?: string | null;
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
                    "application/json": components["schemas"]["Data_BillingWebhookOut_"];
                };
            };
            /** @description Validation Error */
            422: {
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
    create_chat_run_chat_runs_post: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string | null;
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
    cancel_chat_run_chat_runs__run_id__cancel_post: {
        parameters: {
            query?: never;
            header?: {
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
    rename_contributor_contributors__contributor_handle__patch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                contributor_handle: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ContributorRenameRequest"];
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
                media_kind?: ("web_article" | "epub" | "pdf" | "podcast_episode" | "video") | null;
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
    get_media_intelligence_media__media_handle__intelligence_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_handle: string;
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
    find_in_epub_media__media_id__epub_find_post: {
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
                "application/json": components["schemas"]["EpubFindRequest"];
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
                "application/json": components["schemas"]["RetrySourceRequest"] | components["schemas"]["RetryMetadataRequest"];
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
    regenerate_assistant_message_messages__assistant_message_id__regenerate_post: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string | null;
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
    rerun_assistant_message_messages__assistant_message_id__rerun_post: {
        parameters: {
            query?: never;
            header?: {
                "Idempotency-Key"?: string | null;
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
    get_oracle_corpus_status_oracle_corpus_get: {
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
                    "application/json": {
                        [key: string]: unknown;
                    };
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
    get_public_resource_share_public_resource_share_get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Share-Token"?: string | null;
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
    get_public_resource_share_asset_public_resource_share_assets__asset_handle__get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Share-Token"?: string | null;
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
                "X-Nexus-Share-Token"?: string | null;
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
    get_public_resource_share_fragments_public_resource_share_fragments_get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Share-Token"?: string | null;
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
    get_public_resource_share_navigation_public_resource_share_navigation_get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Share-Token"?: string | null;
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
    get_public_resource_share_section_public_resource_share_sections__section_handle__get: {
        parameters: {
            query?: never;
            header?: {
                "X-Nexus-Share-Token"?: string | null;
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
            query?: {
                after?: number | null;
            };
            header?: {
                "Last-Event-ID"?: string | null;
            };
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
                "Last-Event-ID"?: string | null;
                "X-Nexus-SSE-Attempt"?: string | null;
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
    post_web_vital_telemetry_web_vitals_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WebVitalRequest"];
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
    export_vault_vault_get: {
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
    sync_vault_vault_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VaultSyncRequest"];
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
    download_vault_vault_download_get: {
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
    transcribe_walknote_audio_walknotes_transcribe_audio_post: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": components["schemas"]["Body_transcribe_walknote_audio_walknotes_transcribe_audio_post"];
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
}
