"""Canonical PostgreSQL proof for the generation-backends reset migration."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, Engine, create_engine, inspect, text
from sqlalchemy.dialects import postgresql

_RESET_TABLES = (
    "conversations",
    "messages",
    "conversation_shares",
    "conversation_active_paths",
    "conversation_branches",
    "message_tool_calls",
    "message_retrievals",
    "chat_runs",
    "chat_run_turn_contexts",
    "chat_prompt_assemblies",
    "chat_run_events",
)
_DROPPED_GENERATION_TABLES = (
    "agent_turns",
    "token_budget_charges",
    "token_budget_reservations",
    "token_budget_daily_usage",
)
_GENERATION_JOB_KINDS = (
    "enrich_metadata",
    "chat_run",
    "dossier_build",
    "oracle_reading_generate",
    "media_unit_build",
    "synapse_scan",
    "dawn_write_job",
)
_FINAL_LEDGER_COLUMNS = {
    "llm_calls": {
        "id",
        "owner_kind",
        "owner_id",
        "generation_seq",
        "generation_spec",
        "generation_fingerprint",
        "outcome",
        "failure_code",
        "terminal",
        "created_at",
        "completed_at",
    },
    "llm_model_turns": {
        "id",
        "generation_id",
        "turn_seq",
        "request_fingerprint",
        "route_request_identity",
        "terminal",
        "usage",
        "billability",
        "created_at",
        "dispatch_started_at",
        "accepted_at",
        "completed_at",
    },
    "llm_model_turn_continuations": {
        "id",
        "generation_id",
        "source_model_turn_id",
        "successor_turn_seq",
        "target_fingerprint",
        "codec_id",
        "policy_revision",
        "envelope_version",
        "nonce",
        "ciphertext",
        "created_at",
    },
    "llm_tool_positions": {
        "id",
        "generation_id",
        "position",
        "transport_kind",
        "model_turn_seq",
        "transport_call_id",
        "canonical_tool_id",
        "canonical_input_digest",
        "tool_contract_revision",
        "plan_revision",
        "binding_revision",
        "scope_digest",
        "budget_digest",
        "reservation",
        "dispatch_claim",
        "abandoned_attempts",
        "result_evidence",
        "effect_identity",
        "settlement",
        "replay_status",
        "created_at",
        "completed_at",
    },
    "assistant_write_authorships": {
        "id",
        "tool_position_id",
        "target_kind",
        "target_id",
        "created_at",
    },
}
_FINAL_CHAT_RUN_COLUMNS = {
    "id",
    "owner_user_id",
    "conversation_id",
    "user_message_id",
    "assistant_message_id",
    "idempotency_key",
    "payload_hash",
    "generation_spec",
    "status",
    "cancel_requested_at",
    "started_at",
    "completed_at",
    "error_code",
    "error_detail",
    "support_id",
    "publication_warning_code",
    "created_at",
    "updated_at",
}
_FINAL_CHAT_PROMPT_COLUMNS = {
    "id",
    "chat_run_id",
    "conversation_id",
    "assistant_message_id",
    "prompt_block_manifest",
    "generation_intent",
    "generation_intent_digest",
    "max_context_tokens",
    "reserved_output_tokens",
    "input_budget_tokens",
    "estimated_input_tokens",
    "included_message_ids",
    "included_retrieval_ids",
    "included_context_refs",
    "dropped_items",
    "budget_breakdown",
    "created_at",
}
_BYTE_PRESERVED_TABLES = (
    "media_upload_sessions",
    "media_upload_session_destinations",
    "contributors",
    "contributor_aliases",
    "contributor_external_ids",
    "contributor_credits",
    "media_file",
    "reader_publications",
    "fragments",
    "podcasts",
    "podcast_subscriptions",
    "podcast_episodes",
    "podcast_listening_states",
    "podcast_transcript_segments",
    "media_transcript_states",
    "content_blocks",
    "evidence_spans",
    "content_chunks",
    "content_chunk_parts",
    "content_embeddings",
    "content_index_states",
    "reader_profiles",
    "reader_media_state",
    "reader_engagement_states",
    "consumption_overrides",
    "workspace_sessions",
    "artifact_idea_subjects",
    "artifact_idea_resolutions",
    "artifact_learn_failures",
    "oracle_corpus_sources",
    "oracle_passage_anchors",
    "oracle_plates",
    "oracle_corpus_publications",
)


def _migration_config() -> Config:
    migration_root = Path(__file__).parents[3] / "migrations"
    config = Config(migration_root / "alembic.ini")
    config.set_main_option("script_location", str(migration_root / "alembic"))
    return config


def _ids() -> dict[str, UUID]:
    return {
        name: uuid4()
        for name in (
            "user",
            "invitee",
            "library",
            "invitation",
            "billing_account",
            "entitlement",
            "media",
            "podcast_media",
            "entry",
            "upload_session",
            "upload_candidate",
            "contributor",
            "contributor_alias",
            "contributor_external",
            "contributor_credit",
            "reader_publication",
            "fragment",
            "podcast",
            "podcast_subscription",
            "podcast_segment",
            "content_block",
            "evidence_span",
            "content_chunk",
            "content_chunk_part",
            "content_embedding",
            "content_index",
            "reader_media_state",
            "reader_engagement",
            "workspace_session",
            "page",
            "note",
            "highlight",
            "queue_item",
            "summary",
            "source_attempt",
            "oracle",
            "oracle_event",
            "oracle_corpus_source",
            "oracle_passage_anchor",
            "oracle_plate",
            "dawn",
            "preserved_artifact",
            "preserved_build",
            "preserved_failure",
            "preserved_event",
            "preserved_idea_subject",
            "preserved_idea_seed",
            "preserved_learn_request",
            "preserved_edge",
            "preserved_version",
            "preserved_view",
            "preserved_grant",
            "preserved_external",
            "unrelated_job",
            "conversation",
            "user_message",
            "assistant_message",
            "active_path",
            "branch",
            "chat_run",
            "tool_call",
            "retrieval",
            "prompt",
            "chat_event",
            "chat_edge",
            "chat_version",
            "chat_view",
            "chat_grant",
            "chat_anchor",
            "chat_mutation",
            "chat_external",
            "shared_external",
            "typed_external",
            "surface_external",
            "target_external",
            "grant_external",
            "anchor_external",
            "suppression_source_external",
            "suppression_target_external",
            "artifact_subject_external",
            "artifact_audience_external",
            "shared_target_external",
            "doomed_edge_external",
            "typed_external_version",
            "typed_external_surface_view",
            "typed_external_target_view",
            "typed_external_grant",
            "typed_external_anchor",
            "typed_external_subject_artifact",
            "typed_external_audience_artifact",
            "shared_external_edge",
            "shared_target_external_edge",
            "doomed_external_edge",
            "shared_retrieval",
            "typed_external_retrieval",
            "surface_external_retrieval",
            "target_external_retrieval",
            "grant_external_retrieval",
            "anchor_external_retrieval",
            "suppression_source_external_retrieval",
            "suppression_target_external_retrieval",
            "artifact_subject_external_retrieval",
            "artifact_audience_external_retrieval",
            "shared_target_external_retrieval",
            "doomed_edge_external_retrieval",
            "conversation_artifact",
            "conversation_build",
            "conversation_revision",
            "conversation_event",
            "transitive_artifact",
            "transitive_build",
            "transitive_revision",
            "transitive_event",
            "revision_dependent_artifact",
            "revision_dependent_build",
            "revision_dependent_revision",
            "revision_dependent_event",
            "message_subject_artifact",
            "conversation_audience_artifact",
            "message_audience_artifact",
            "idea_seed",
            "learn_request",
            "old_call",
            "old_turn",
            "charge",
            "reservation",
            "generation_job",
            "oracle_folio_edge",
            "future_view_consumer",
        )
    }


def _execute_fixture(
    connection: Connection,
    script: object,
    parameters: Mapping[str, object],
) -> None:
    """Execute the controlled fixture script one prepared statement at a time."""

    for statement in str(script).split(";"):
        if statement.strip():
            connection.execute(text(statement), parameters)


def _seed_preserved_families(connection: Connection, ids: dict[str, UUID]) -> None:
    _execute_fixture(
        connection,
        text(
            "INSERT INTO users (id, email) VALUES "
            "(:user, 'generation-owner@example.invalid'), "
            "(:invitee, 'generation-invitee@example.invalid')"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO libraries (id, owner_user_id, name) "
            "VALUES (:library, :user, 'Preserved Library'); "
            "INSERT INTO memberships (library_id, user_id, role) "
            "VALUES (:library, :user, 'admin'); "
            "INSERT INTO library_invitations "
            "(id, library_id, inviter_user_id, invitee_user_id, role) "
            "VALUES (:invitation, :library, :user, :invitee, 'member'); "
            "INSERT INTO billing_accounts (id, user_id) "
            "VALUES (:billing_account, :user); "
            "INSERT INTO billing_entitlement_overrides "
            "(id, user_id, plan_tier, reason) "
            "VALUES (:entitlement, :user, 'ai_plus', 'preserve entitlement')"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO media (id, kind, title, created_by_user_id) "
            "VALUES (:media, 'web_article', 'Preserved Media', :user); "
            "INSERT INTO library_entries (id, library_id, media_id, position) "
            "VALUES (:entry, :library, :media, 1); "
            "INSERT INTO pages (id, user_id, title) "
            "VALUES (:page, :user, 'Preserved Page'); "
            "INSERT INTO note_blocks (id, user_id, body_pm_json, body_text) "
            "VALUES (:note, :user, '{}'::jsonb, 'Preserved note'); "
            "INSERT INTO highlights (id, user_id, color, exact, prefix, suffix) "
            "VALUES (:highlight, :user, 'yellow', 'Preserved highlight', '', ''); "
            "INSERT INTO consumption_queue_items (id, user_id, media_id, position) "
            "VALUES (:queue_item, :user, :media, 0); "
            "INSERT INTO media_summaries "
            "(id, media_id, content_fingerprint, summary_md, model_name, status) "
            "VALUES (:summary, :media, 'content-v1', 'Preserved summary', 'legacy', 'ready'); "
            "INSERT INTO media_source_attempts "
            "(id, media_id, created_by_user_id, source_type, attempt_no, status, "
            "intent_key, source_payload) VALUES "
            "(:source_attempt, :media, :user, 'generic_web_url', 1, 'succeeded', "
            "'preserved-source-attempt', '{}'::jsonb)"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO oracle_readings "
            "(id, user_id, folio_number, question_text, status, error_code, failed_at) "
            "VALUES (:oracle, :user, 1, 'Preserved oracle?', 'failed', "
            "'provider_unavailable', clock_timestamp()); "
            "INSERT INTO oracle_reading_events "
            "(id, reading_id, seq, event_type, payload) VALUES "
            "(:oracle_event, :oracle, 1, 'done', "
            '\'{"status":"failed","error_code":"provider_unavailable"}\'::jsonb); '
            "INSERT INTO dawn_writes (id, user_id, local_date, body_md) "
            "VALUES (:dawn, :user, DATE '2026-08-31', 'Preserved dawn')"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO artifacts "
            "(id, subject_scheme, subject_id, audience_scheme, audience_id) "
            "VALUES (:preserved_artifact, 'media', :media, 'user', CAST(:user AS text)); "
            "INSERT INTO artifact_builds "
            "(id, artifact_id, requester_user_id, idempotency_key) "
            "VALUES (:preserved_build, :preserved_artifact, :user, 'preserved-build'); "
            "INSERT INTO artifact_build_failures (id, build_id, failure_code) "
            "VALUES (:preserved_failure, :preserved_build, 'ProviderRefused'); "
            "INSERT INTO artifact_build_events (id, build_id, seq, event_type, payload) "
            "VALUES (:preserved_event, :preserved_build, 1, 'Failed', "
            '\'{"failure_code":"ProviderRefused"}\'::jsonb)'
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO resource_edges "
            "(id, user_id, kind, origin, source_scheme, source_id, target_scheme, target_id) "
            "VALUES (:preserved_edge, :user, 'context', 'user', "
            "'page', :page, 'note_block', :note); "
            "INSERT INTO resource_versions "
            "(id, user_id, resource_scheme, resource_id, lane, content_hash) "
            "VALUES (:preserved_version, :user, 'page', :page, 'title', :content_hash); "
            "INSERT INTO resource_view_states "
            "(id, user_id, surface_scheme, surface_id, edge_id, "
            "target_scheme, target_id, state) VALUES "
            "(:preserved_view, :user, 'page', :page, :preserved_edge, "
            "'note_block', :note, jsonb_build_object('open', true)); "
            "INSERT INTO resource_grants "
            "(id, subject_scheme, subject_id, created_by_user_id, grantee_user_id) "
            "VALUES (:preserved_grant, 'page', :page, :user, :invitee); "
            "INSERT INTO resource_external_snapshots "
            "(id, user_id, provider, url, title, snippet, source_snapshot) "
            "VALUES (:preserved_external, :user, 'web', 'https://example.invalid/preserved', "
            "'Preserved external', 'Preserved', '{}'::jsonb); "
            "INSERT INTO background_jobs (id, kind, payload, status, attempts) "
            "VALUES (:unrelated_job, 'sync_podcast', "
            "jsonb_build_object('keep', true), 'succeeded', 1)"
        ),
        {**ids, "content_hash": "a" * 64},
    )


def _seed_extended_preserved_families(
    connection: Connection,
    ids: dict[str, UUID],
) -> None:
    """Seed preservation families named by the cutover, not just convenient roots."""

    _execute_fixture(
        connection,
        text(
            "INSERT INTO media_upload_sessions "
            "(id, created_by_user_id, candidate_media_id, kind, filename, content_type, "
            "expected_size_bytes, idempotency_key, request_id, upload_generation, "
            "upload_url_expires_at) VALUES "
            "(:upload_session, :user, :upload_candidate, 'pdf', 'preserved.pdf', "
            "'application/pdf', 17, 'preserved-upload', 'preserved-request', 1, "
            "clock_timestamp() + INTERVAL '1 hour'); "
            "INSERT INTO media_upload_session_destinations (upload_session_id, library_id) "
            "VALUES (:upload_session, :library); "
            "INSERT INTO media_file "
            "(media_id, storage_path, content_type, size_bytes, source_sha256) VALUES "
            "(:media, 'media/preserved.pdf', 'application/pdf', 17, :source_sha256); "
            "INSERT INTO reader_publications (id, media_id, generation) "
            "VALUES (:reader_publication, :media, 4); "
            "INSERT INTO fragments "
            "(id, media_id, idx, canonical_text, html_sanitized) "
            "VALUES (:fragment, :media, 0, 'Preserved fragment', '<p>Preserved fragment</p>')"
        ),
        {**ids, "source_sha256": "1" * 64},
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO contributors (id, handle, display_name) "
            "VALUES (:contributor, 'preserved-contributor', 'Preserved Contributor'); "
            "INSERT INTO contributor_aliases "
            "(id, contributor_id, alias, normalized_alias, resolves_identity) VALUES "
            "(:contributor_alias, :contributor, 'P. Contributor', "
            "'p contributor', true); "
            "INSERT INTO contributor_external_ids "
            "(id, contributor_id, authority, external_key) VALUES "
            "(:contributor_external, :contributor, 'wikidata', 'Q-preserved'); "
            "INSERT INTO contributor_credits "
            "(id, contributor_id, media_id, credited_name, normalized_credited_name, "
            "role, ordinal, source) VALUES "
            "(:contributor_credit, :contributor, :media, 'Preserved Contributor', "
            "'preserved contributor', 'author', 0, 'user')"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO media (id, kind, title, created_by_user_id) "
            "VALUES (:podcast_media, 'podcast_episode', 'Preserved Episode', :user); "
            "INSERT INTO podcasts "
            "(id, provider, provider_podcast_id, title, feed_url) VALUES "
            "(:podcast, 'rss', 'preserved-podcast', 'Preserved Podcast', "
            "'https://example.invalid/preserved-podcast.xml'); "
            "INSERT INTO podcast_subscriptions "
            "(id, user_id, podcast_id, next_sync_at) VALUES "
            "(:podcast_subscription, :user, :podcast, clock_timestamp()); "
            "INSERT INTO podcast_episodes (media_id, podcast_id, duration_seconds) "
            "VALUES (:podcast_media, :podcast, 60); "
            "INSERT INTO podcast_listening_states "
            "(user_id, media_id, position_ms, duration_ms, playback_speed, is_completed) "
            "VALUES (:user, :podcast_media, 1000, 60000, 1.25, false); "
            "INSERT INTO podcast_transcript_segments "
            "(id, media_id, segment_idx, canonical_text, t_start_ms, t_end_ms) VALUES "
            "(:podcast_segment, :podcast_media, 0, 'Preserved transcript', 0, 1000); "
            "INSERT INTO media_transcript_states "
            "(media_id, transcript_state, transcript_coverage, semantic_status, "
            "last_request_reason, transcript_origin) VALUES "
            "(:podcast_media, 'ready', 'full', 'ready', 'episode_open', 'rss')"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO content_blocks "
            "(id, owner_kind, owner_id, block_idx, block_kind, canonical_text, "
            "source_start_offset, source_end_offset, heading_path, locator, selector, metadata) "
            "VALUES (:content_block, 'media', :media, 0, 'paragraph', "
            "'Preserved indexed text', 0, 22, '[]'::jsonb, '{}'::jsonb, "
            "'{}'::jsonb, '{}'::jsonb); "
            "INSERT INTO evidence_spans "
            "(id, owner_kind, owner_id, start_block_id, end_block_id, start_block_offset, "
            "end_block_offset, span_text, selector, citation_label, resolver_kind) VALUES "
            "(:evidence_span, 'media', :media, :content_block, :content_block, 0, 9, "
            "'Preserved', '{}'::jsonb, 'Preserved citation', 'web'); "
            "INSERT INTO content_chunks "
            "(id, owner_kind, owner_id, primary_evidence_span_id, chunk_idx, source_kind, "
            "chunk_text, token_count, heading_path, summary_locator) VALUES "
            "(:content_chunk, 'media', :media, :evidence_span, 0, 'web_article', "
            "'Preserved indexed text', 4, '[]'::jsonb, '{}'::jsonb); "
            "INSERT INTO content_chunk_parts "
            "(id, chunk_id, part_idx, block_id, block_start_offset, block_end_offset, "
            "chunk_start_offset, chunk_end_offset, separator_before) VALUES "
            "(:content_chunk_part, :content_chunk, 0, :content_block, 0, 22, 0, 22, ''); "
            "INSERT INTO content_embeddings "
            "(id, chunk_id, embedding_provider, embedding_model, embedding_dimensions) VALUES "
            "(:content_embedding, :content_chunk, 'openai', 'text-embedding-3-small', 256); "
            "INSERT INTO content_index_states "
            "(id, owner_kind, owner_id, revision, status, active_embedding_provider, "
            "active_embedding_model) VALUES "
            "(:content_index, 'media', :media, 3, 'ready', 'openai', "
            "'text-embedding-3-small')"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO reader_profiles "
            "(user_id, theme, font_size_px, line_height, font_family, column_width_ch, "
            "focus_mode, hyphenation) VALUES "
            "(:user, 'dark', 18, 1.60, 'serif', 72, 'off', 'auto'); "
            "INSERT INTO reader_media_state "
            "(id, user_id, media_id, locator, revision) VALUES "
            "(:reader_media_state, :user, :media, jsonb_build_object('page', 2), 7); "
            "INSERT INTO reader_engagement_states "
            "(id, user_id, media_id, last_engaged_at, max_total_progression) VALUES "
            "(:reader_engagement, :user, :media, clock_timestamp(), 0.5); "
            "INSERT INTO consumption_overrides (user_id, media_id, status, revision) "
            "VALUES (:user, :media, 'finished', 2); "
            "INSERT INTO workspace_sessions (id, user_id, device_id, state) VALUES "
            "(:workspace_session, :user, 'preserved-device', "
            "jsonb_build_object('activePane', 'reader'))"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO artifact_idea_subjects (id, user_id, idea_key, display_title) "
            "VALUES (:preserved_idea_subject, :user, "
            "jsonb_build_object('kind', 'preserved'), 'Preserved Idea'); "
            "INSERT INTO artifact_idea_resolutions "
            "(highlight_id, user_id, idea_subject_id) VALUES "
            "(:highlight, :user, :preserved_idea_subject); "
            "INSERT INTO artifact_idea_seeds (id, artifact_id, highlight_id) "
            "VALUES (:preserved_idea_seed, :preserved_artifact, :highlight); "
            "INSERT INTO artifact_learn_requests "
            "(id, user_id, idempotency_key, request_hash, highlight_id, coordination) VALUES "
            "(:preserved_learn_request, :user, 'preserved-learn', :request_hash, "
            ":highlight, jsonb_build_object('dispatch_phase', 'Completed')); "
            "INSERT INTO artifact_learn_failures (request_id, error_code) "
            "VALUES (:preserved_learn_request, 'NoCandidate')"
        ),
        {**ids, "request_hash": "2" * 64},
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO oracle_corpus_sources "
            "(id, corpus_key, work_key, library_id, media_id, title, author_text, "
            "source_repository, source_url, source_download_url, source_media_kind, "
            "display_order) VALUES "
            "(:oracle_corpus_source, 'oracle', 'preserved-work', :library, :media, "
            "'Preserved Oracle Work', 'Preserved Author', 'example', "
            "'https://example.invalid/oracle', 'https://example.invalid/oracle.txt', "
            "'web_article', 1); "
            "INSERT INTO oracle_passage_anchors "
            "(id, corpus_source_id, passage_key, display_label, selector, tags, phase_hints, "
            "resolution_status) VALUES "
            "(:oracle_passage_anchor, :oracle_corpus_source, 'preserved-passage', "
            "'Preserved passage', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'pending'); "
            "INSERT INTO oracle_plates "
            "(id, source_repository, source_page_url, source_url, artist, work_title, "
            "attribution_text, width, height, storage_key, content_type, byte_size, tags) "
            "VALUES (:oracle_plate, 'example', 'https://example.invalid/plate-page', "
            "'https://example.invalid/plate.webp', 'Preserved Artist', 'Preserved Plate', "
            "'Public domain', 16, 16, 'oracle/plates/preserved.webp', 'image/webp', 32, "
            "'[]'::jsonb); "
            "INSERT INTO oracle_corpus_publications "
            "(corpus_key, manifest_digest, embedding_provider, embedding_model) VALUES "
            "('oracle', :manifest_digest, 'openai', 'text-embedding-3-small')"
        ),
        {**ids, "manifest_digest": "3" * 64},
    )


def _seed_reset_aggregate(connection: Connection, ids: dict[str, UUID]) -> None:
    _execute_fixture(
        connection,
        text(
            "INSERT INTO conversations (id, owner_user_id, next_seq) "
            "VALUES (:conversation, :user, 3); "
            "INSERT INTO conversation_shares (conversation_id, library_id) "
            "VALUES (:conversation, :library); "
            "INSERT INTO messages "
            "(id, conversation_id, seq, role, content, status, parent_message_id) VALUES "
            "(:user_message, :conversation, 1, 'user', 'Reset question', 'complete', NULL), "
            "(:assistant_message, :conversation, 2, 'assistant', "
            "'Reset answer', 'complete', :user_message); "
            "INSERT INTO conversation_active_paths "
            "(id, conversation_id, viewer_user_id, active_leaf_message_id) "
            "VALUES (:active_path, :conversation, :user, :assistant_message); "
            "INSERT INTO conversation_branches "
            "(id, conversation_id, branch_user_message_id, title) "
            "VALUES (:branch, :conversation, :user_message, 'Reset branch')"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO chat_runs "
            "(id, owner_user_id, conversation_id, user_message_id, assistant_message_id, "
            "idempotency_key, payload_hash, status, profile_id, reasoning_option_id, provider, "
            "model_name, reasoning_effort, tool_profile_id, tool_profile_revision, "
            "tool_profile_snapshot) VALUES "
            "(:chat_run, :user, :conversation, :user_message, :assistant_message, "
            "'reset-chat', 'reset-payload', 'complete', 'balanced', 'medium', 'openai', "
            "'gpt-5.6-terra', 'medium', 'legacy-tools', 'legacy.1', '{}'::jsonb); "
            "INSERT INTO chat_run_turn_contexts "
            "(chat_run_id, requested_subject_scheme, requested_subject_id, "
            "subject_scheme, subject_id) VALUES "
            "(:chat_run, 'conversation', :conversation, 'conversation', :conversation); "
            "INSERT INTO chat_prompt_assemblies "
            "(id, chat_run_id, conversation_id, assistant_message_id, max_context_tokens, "
            "reserved_output_tokens, input_budget_tokens, estimated_input_tokens) "
            "VALUES (:prompt, :chat_run, :conversation, :assistant_message, 1000, 100, 900, 10); "
            "INSERT INTO chat_run_events (id, run_id, seq, event_type, payload) "
            "VALUES (:chat_event, :chat_run, 1, 'done', '{}'::jsonb)"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO resource_external_snapshots "
            "(id, user_id, provider, url, title, snippet, source_snapshot) "
            "VALUES (:chat_external, :user, 'web', 'https://example.invalid/chat', "
            "'Reset external', 'Reset', '{}'::jsonb), "
            "(:shared_external, :user, 'web', 'https://example.invalid/shared', "
            "'Shared external', 'Shared', '{}'::jsonb); "
            "INSERT INTO message_tool_calls "
            "(id, conversation_id, user_message_id, assistant_message_id, canonical_tool_id, "
            "tool_call_index, status, record_kind) VALUES "
            "(:tool_call, :conversation, :user_message, :assistant_message, "
            "'nexus.search', 0, 'complete', 'tool'); "
            "INSERT INTO message_retrievals "
            "(id, tool_call_id, ordinal, result_type, source_id, context_ref, result_ref, "
            "retrieval_status) VALUES "
            "(:retrieval, :tool_call, 0, 'web_result', CAST(:chat_external AS text), "
            "'{}'::jsonb, '{}'::jsonb, 'web_result'), "
            "(:shared_retrieval, :tool_call, 1, 'web_result', "
            "CAST(:shared_external AS text), '{}'::jsonb, '{}'::jsonb, 'web_result')"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO resource_edges "
            "(id, user_id, kind, origin, source_scheme, source_id, target_scheme, target_id) "
            "VALUES (:chat_edge, :user, 'context', 'user', "
            "'conversation', :conversation, 'page', :page), "
            "(:shared_external_edge, :user, 'context', 'user', "
            "'external_snapshot', :shared_external, 'page', :page); "
            "INSERT INTO resource_versions "
            "(id, user_id, resource_scheme, resource_id, lane) "
            "VALUES (:chat_version, :user, 'conversation', :conversation, 'title'); "
            "INSERT INTO resource_view_states "
            "(id, user_id, surface_scheme, surface_id, edge_id, "
            "target_scheme, target_id, state) VALUES "
            "(:chat_view, :user, 'conversation', :conversation, :chat_edge, "
            "'page', :page, '{}'::jsonb); "
            "INSERT INTO resource_grants "
            "(id, subject_scheme, subject_id, created_by_user_id, grantee_user_id) "
            "VALUES (:chat_grant, 'conversation', :conversation, :user, :invitee); "
            "INSERT INTO passage_anchors "
            "(id, user_id, owner_scheme, owner_id, selector_version, anchor_key, selector) "
            "VALUES (:chat_anchor, :user, 'conversation', :conversation, 1, "
            "'reset-anchor', '{}'::jsonb); "
            "INSERT INTO synapse_suppressions "
            "(user_id, source_scheme, source_id, target_scheme, target_id) "
            "VALUES (:user, 'conversation', :conversation, 'media', :media); "
            "INSERT INTO resource_mutations "
            "(id, user_id, mutation_scope, client_mutation_id, request_hash, "
            "changed_lanes, response_json) VALUES "
            "(:chat_mutation, :user, :mutation_scope, 'reset-mutation', :request_hash, "
            "'{}'::jsonb, '{}'::jsonb)"
        ),
        {
            **ids,
            "mutation_scope": f"resource:conversation:{ids['conversation']}",
            "request_hash": "b" * 64,
        },
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO artifacts "
            "(id, subject_scheme, subject_id, audience_scheme, audience_id) "
            "VALUES (:conversation_artifact, 'conversation', :conversation, "
            "'user', CAST(:user AS text)); "
            "INSERT INTO artifact_builds "
            "(id, artifact_id, requester_user_id, idempotency_key) "
            "VALUES (:conversation_build, :conversation_artifact, :user, 'reset-build'); "
            "INSERT INTO artifact_revisions "
            "(id, build_id, citation_owner_user_id, creator_user_id, input_manifest, "
            "content_html, content_text) VALUES "
            "(:conversation_revision, :conversation_build, :user, :user, '{}'::jsonb, "
            "'<p>Reset</p>', 'Reset'); "
            "UPDATE artifacts SET current_revision_id = :conversation_revision "
            "WHERE id = :conversation_artifact; "
            "INSERT INTO artifact_build_events (id, build_id, seq, event_type, payload) "
            "VALUES (:conversation_event, :conversation_build, 1, 'Succeeded', '{}'::jsonb); "
            "INSERT INTO artifact_idea_seeds (id, artifact_id, highlight_id) "
            "VALUES (:idea_seed, :conversation_artifact, :highlight); "
            "INSERT INTO artifact_learn_requests "
            "(id, user_id, idempotency_key, request_hash, highlight_id, coordination) "
            "VALUES (:learn_request, :user, 'reset-learn', :request_hash, :highlight, '{}'::jsonb); "
            "INSERT INTO artifact_learn_successes "
            "(request_id, outcome_kind, artifact_id, build_id) "
            "VALUES (:learn_request, 'created', :conversation_artifact, :conversation_build)"
        ),
        {**ids, "request_hash": "c" * 64},
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO llm_calls "
            "(id, owner_kind, owner_id, call_seq, provider, model_name, llm_operation, "
            "streaming, cost_status, outcome) VALUES "
            "(:old_call, 'chat_run', :chat_run, 1, 'openai', 'gpt-5.6-terra', "
            "'chat', false, 'missing_usage', 'succeeded'); "
            "INSERT INTO agent_turns "
            "(id, owner_kind, owner_id, turn_seq, operation, operation_revision, backend, "
            "transport, auth_profile, model_name, requested_reasoning, request_fingerprint, "
            "policy_fingerprint, output_schema_fingerprint, outcome, completed_at) VALUES "
            "(:old_turn, 'chat_run', :chat_run, 1, 'chat', 'legacy.1', 'codex', 'sdk', "
            "'codex-personal', 'gpt-5.6-terra', 'medium', :request_fingerprint, "
            ":policy_fingerprint, :output_fingerprint, 'succeeded', clock_timestamp()); "
            "INSERT INTO token_budget_daily_usage "
            "(user_id, usage_date, spent_tokens, reserved_tokens) "
            "VALUES (:user, DATE '2026-08-31', 1, 1); "
            "INSERT INTO token_budget_charges "
            "(reservation_id, user_id, usage_date, charged_tokens) "
            "VALUES (:charge, :user, DATE '2026-08-31', 1); "
            "INSERT INTO token_budget_reservations "
            "(reservation_id, user_id, usage_date, reserved_tokens, expires_at) "
            "VALUES (:reservation, :user, DATE '2026-08-31', 1, "
            "TIMESTAMPTZ '2026-09-01T00:00:00Z'); "
            "INSERT INTO background_jobs (id, kind, payload, status, attempts) "
            "VALUES (:generation_job, 'chat_run', '{}'::jsonb, 'pending', 0); "
            "UPDATE media_source_attempts SET job_id = :generation_job "
            "WHERE id = :source_attempt; "
            "UPDATE background_job_capacity_leases "
            "SET job_id = :generation_job, worker_id = 'stale-generation-worker', "
            "attempt_no = 1, lease_expires_at = clock_timestamp() - INTERVAL '1 hour'"
        ),
        {
            **ids,
            "request_fingerprint": "d" * 64,
            "policy_fingerprint": "e" * 64,
            "output_fingerprint": "f" * 64,
        },
    )


def _seed_reset_typed_closure(connection: Connection, ids: dict[str, UUID]) -> None:
    """Seed every non-FK typed boundary whose target is deleted or retained."""

    _execute_fixture(
        connection,
        text(
            "INSERT INTO artifacts "
            "(id, subject_scheme, subject_id, audience_scheme, audience_id) VALUES "
            "(:message_subject_artifact, 'message', :assistant_message, "
            "'user', CAST(:user AS text)), "
            "(:conversation_audience_artifact, 'media', :media, "
            "'conversation', CAST(:conversation AS text)), "
            "(:message_audience_artifact, 'page', :page, "
            "'message', CAST(:assistant_message AS text)), "
            "(:transitive_artifact, 'artifact', :conversation_artifact, "
            "'user', CAST(:user AS text)); "
            "INSERT INTO artifact_builds "
            "(id, artifact_id, requester_user_id, idempotency_key) VALUES "
            "(:transitive_build, :transitive_artifact, :user, 'transitive-build'); "
            "INSERT INTO artifact_revisions "
            "(id, build_id, citation_owner_user_id, creator_user_id, input_manifest, "
            "content_html, content_text) VALUES "
            "(:transitive_revision, :transitive_build, :user, :user, '{}'::jsonb, "
            "'<p>Transitive</p>', 'Transitive'); "
            "UPDATE artifacts SET current_revision_id = :transitive_revision "
            "WHERE id = :transitive_artifact; "
            "INSERT INTO artifact_build_events (id, build_id, seq, event_type, payload) "
            "VALUES (:transitive_event, :transitive_build, 1, 'Succeeded', '{}'::jsonb); "
            "INSERT INTO artifacts "
            "(id, subject_scheme, subject_id, audience_scheme, audience_id) VALUES "
            "(:revision_dependent_artifact, 'artifact_revision', :transitive_revision, "
            "'user', CAST(:user AS text)); "
            "INSERT INTO artifact_builds "
            "(id, artifact_id, requester_user_id, idempotency_key) VALUES "
            "(:revision_dependent_build, :revision_dependent_artifact, :user, "
            "'revision-dependent-build'); "
            "INSERT INTO artifact_revisions "
            "(id, build_id, citation_owner_user_id, creator_user_id, input_manifest, "
            "content_html, content_text) VALUES "
            "(:revision_dependent_revision, :revision_dependent_build, :user, :user, "
            "'{}'::jsonb, '<p>Revision dependent</p>', 'Revision dependent'); "
            "UPDATE artifacts SET current_revision_id = :revision_dependent_revision "
            "WHERE id = :revision_dependent_artifact; "
            "INSERT INTO artifact_build_events (id, build_id, seq, event_type, payload) "
            "VALUES (:revision_dependent_event, :revision_dependent_build, 1, "
            "'Succeeded', '{}'::jsonb)"
        ),
        ids,
    )
    _execute_fixture(
        connection,
        text(
            "INSERT INTO resource_external_snapshots "
            "(id, user_id, provider, url, title, snippet, source_snapshot) VALUES "
            "(:typed_external, :user, 'web', 'https://example.invalid/typed', "
            "'Version external', 'Version preservation target', '{}'::jsonb), "
            "(:surface_external, :user, 'web', 'https://example.invalid/surface', "
            "'Surface external', 'Surface preservation target', '{}'::jsonb), "
            "(:target_external, :user, 'web', 'https://example.invalid/target', "
            "'Target external', 'Target preservation target', '{}'::jsonb), "
            "(:grant_external, :user, 'web', 'https://example.invalid/grant', "
            "'Grant external', 'Grant preservation target', '{}'::jsonb), "
            "(:anchor_external, :user, 'web', 'https://example.invalid/anchor', "
            "'Anchor external', 'Anchor preservation target', '{}'::jsonb), "
            "(:suppression_source_external, :user, 'web', "
            "'https://example.invalid/suppression-source', 'Suppression source external', "
            "'Suppression source preservation target', '{}'::jsonb), "
            "(:suppression_target_external, :user, 'web', "
            "'https://example.invalid/suppression-target', 'Suppression target external', "
            "'Suppression target preservation target', '{}'::jsonb), "
            "(:artifact_subject_external, :user, 'web', "
            "'https://example.invalid/artifact-subject', 'Artifact subject external', "
            "'Artifact subject preservation target', '{}'::jsonb), "
            "(:artifact_audience_external, :user, 'web', "
            "'https://example.invalid/artifact-audience', 'Artifact audience external', "
            "'Artifact audience preservation target', '{}'::jsonb), "
            "(:shared_target_external, :user, 'web', "
            "'https://example.invalid/shared-target', 'Shared target external', "
            "'Shared target preservation target', '{}'::jsonb), "
            "(:doomed_edge_external, :user, 'web', "
            "'https://example.invalid/doomed-edge', 'Doomed edge external', "
            "'Doomed edge-only target', '{}'::jsonb); "
            "INSERT INTO message_retrievals "
            "(id, tool_call_id, ordinal, result_type, source_id, context_ref, result_ref, "
            "retrieval_status) VALUES "
            "(:typed_external_retrieval, :tool_call, 2, 'web_result', "
            "CAST(:typed_external AS text), '{}'::jsonb, '{}'::jsonb, 'web_result'), "
            "(:surface_external_retrieval, :tool_call, 3, 'web_result', "
            "CAST(:surface_external AS text), '{}'::jsonb, '{}'::jsonb, 'web_result'), "
            "(:target_external_retrieval, :tool_call, 4, 'web_result', "
            "CAST(:target_external AS text), '{}'::jsonb, '{}'::jsonb, 'web_result'), "
            "(:grant_external_retrieval, :tool_call, 5, 'web_result', "
            "CAST(:grant_external AS text), '{}'::jsonb, '{}'::jsonb, 'web_result'), "
            "(:anchor_external_retrieval, :tool_call, 6, 'web_result', "
            "CAST(:anchor_external AS text), '{}'::jsonb, '{}'::jsonb, 'web_result'), "
            "(:suppression_source_external_retrieval, :tool_call, 7, 'web_result', "
            "CAST(:suppression_source_external AS text), '{}'::jsonb, '{}'::jsonb, "
            "'web_result'), "
            "(:suppression_target_external_retrieval, :tool_call, 8, 'web_result', "
            "CAST(:suppression_target_external AS text), '{}'::jsonb, '{}'::jsonb, "
            "'web_result'), "
            "(:artifact_subject_external_retrieval, :tool_call, 9, 'web_result', "
            "CAST(:artifact_subject_external AS text), '{}'::jsonb, '{}'::jsonb, "
            "'web_result'), "
            "(:artifact_audience_external_retrieval, :tool_call, 10, 'web_result', "
            "CAST(:artifact_audience_external AS text), '{}'::jsonb, '{}'::jsonb, "
            "'web_result'), "
            "(:shared_target_external_retrieval, :tool_call, 11, 'web_result', "
            "CAST(:shared_target_external AS text), '{}'::jsonb, '{}'::jsonb, 'web_result'), "
            "(:doomed_edge_external_retrieval, :tool_call, 12, 'web_result', "
            "CAST(:doomed_edge_external AS text), '{}'::jsonb, '{}'::jsonb, 'web_result'); "
            "INSERT INTO resource_versions "
            "(id, user_id, resource_scheme, resource_id, lane, content_hash) VALUES "
            "(:typed_external_version, :user, 'external_snapshot', :typed_external, "
            "'title', :content_hash); "
            "INSERT INTO resource_view_states "
            "(id, user_id, surface_scheme, surface_id, target_scheme, target_id, state) VALUES "
            "(:typed_external_surface_view, :user, 'external_snapshot', :surface_external, "
            "'page', :page, jsonb_build_object('open', true)), "
            "(:typed_external_target_view, :user, 'page', :page, "
            "'external_snapshot', :target_external, jsonb_build_object('open', true)); "
            "INSERT INTO resource_grants "
            "(id, subject_scheme, subject_id, created_by_user_id, grantee_user_id) VALUES "
            "(:typed_external_grant, 'external_snapshot', :grant_external, :user, :invitee); "
            "INSERT INTO passage_anchors "
            "(id, user_id, owner_scheme, owner_id, selector_version, anchor_key, selector) "
            "VALUES (:typed_external_anchor, :user, 'external_snapshot', :anchor_external, 1, "
            ":anchor_key, '{}'::jsonb); "
            "INSERT INTO synapse_suppressions "
            "(user_id, source_scheme, source_id, target_scheme, target_id) VALUES "
            "(:user, 'external_snapshot', :suppression_source_external, 'page', :page), "
            "(:user, 'page', :page, 'external_snapshot', :suppression_target_external); "
            "INSERT INTO artifacts "
            "(id, subject_scheme, subject_id, audience_scheme, audience_id) VALUES "
            "(:typed_external_subject_artifact, 'external_snapshot', "
            ":artifact_subject_external, "
            "'user', CAST(:user AS text)), "
            "(:typed_external_audience_artifact, 'page', :page, "
            "'external_snapshot', CAST(:artifact_audience_external AS text)); "
            "INSERT INTO resource_edges "
            "(id, user_id, kind, origin, source_scheme, source_id, target_scheme, target_id) "
            "VALUES (:shared_target_external_edge, :user, 'context', 'user', "
            "'page', :page, 'external_snapshot', :shared_target_external), "
            "(:doomed_external_edge, :user, 'context', 'user', "
            "'conversation', :conversation, 'external_snapshot', :doomed_edge_external)"
        ),
        {**ids, "anchor_key": "4" * 64, "content_hash": "5" * 64},
    )


def _drain_seeded_generation_job(connection: Connection, ids: dict[str, UUID]) -> None:
    connection.execute(
        text("UPDATE media_source_attempts SET job_id = NULL WHERE id = :source_attempt"),
        ids,
    )
    connection.execute(
        text(
            "UPDATE background_jobs SET status = 'succeeded', attempts = 1 "
            "WHERE id = :generation_job"
        ),
        ids,
    )


def _preservation_fingerprint(connection: Connection, ids: dict[str, UUID]) -> tuple[object, ...]:
    """Independent oracle over every seeded preservation family."""

    return (
        tuple(
            (
                table_name,
                connection.execute(text(f'SELECT * FROM "{table_name}" ORDER BY 1')).all(),
            )
            for table_name in _BYTE_PRESERVED_TABLES
        ),
        connection.execute(
            text("SELECT id, email FROM users WHERE id IN (:user, :invitee) ORDER BY id"), ids
        ).all(),
        connection.execute(text("SELECT id, name FROM libraries WHERE id = :library"), ids).all(),
        connection.execute(text("SELECT id, title FROM media WHERE id = :media"), ids).all(),
        connection.execute(
            text("SELECT id, status, job_id FROM media_source_attempts WHERE id = :source_attempt"),
            ids,
        ).all(),
        connection.execute(text("SELECT id, title FROM pages WHERE id = :page"), ids).all(),
        connection.execute(
            text("SELECT id, body_text FROM note_blocks WHERE id = :note"), ids
        ).all(),
        connection.execute(
            text("SELECT id, exact FROM highlights WHERE id = :highlight"), ids
        ).all(),
        connection.execute(
            text(
                "SELECT id, source_scheme, target_scheme FROM resource_edges "
                "WHERE id = :preserved_edge"
            ),
            ids,
        ).all(),
        connection.execute(
            text("SELECT id, resource_scheme FROM resource_versions WHERE id = :preserved_version"),
            ids,
        ).all(),
        connection.execute(
            text("SELECT id, surface_scheme FROM resource_view_states WHERE id = :preserved_view"),
            ids,
        ).all(),
        connection.execute(
            text("SELECT id, subject_scheme FROM resource_grants WHERE id = :preserved_grant"),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, provider, url FROM resource_external_snapshots "
                "WHERE id = :preserved_external"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, provider, url FROM resource_external_snapshots "
                "WHERE id = :shared_external"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, source_scheme, target_scheme FROM resource_edges "
                "WHERE id = :shared_external_edge"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, provider, url FROM resource_external_snapshots "
                "WHERE id IN ("
                ":typed_external, :surface_external, :target_external, "
                ":grant_external, :anchor_external, "
                ":suppression_source_external, :suppression_target_external, "
                ":artifact_subject_external, :artifact_audience_external, "
                ":shared_target_external) ORDER BY id"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, source_scheme, source_id, target_scheme, target_id "
                "FROM resource_edges WHERE id = :shared_target_external_edge"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, resource_scheme, resource_id FROM resource_versions "
                "WHERE id = :typed_external_version"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, surface_scheme, surface_id, target_scheme, target_id "
                "FROM resource_view_states WHERE id IN "
                "(:typed_external_surface_view, :typed_external_target_view) ORDER BY id"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, subject_scheme, subject_id FROM resource_grants "
                "WHERE id = :typed_external_grant"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, owner_scheme, owner_id FROM passage_anchors "
                "WHERE id = :typed_external_anchor"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT source_scheme, source_id, target_scheme, target_id "
                "FROM synapse_suppressions WHERE user_id = :user "
                "AND (source_id = :suppression_source_external "
                "OR target_id = :suppression_target_external) "
                "ORDER BY source_scheme, source_id, target_scheme, target_id"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, subject_scheme, subject_id, audience_scheme, audience_id "
                "FROM artifacts WHERE id IN "
                "(:typed_external_subject_artifact, :typed_external_audience_artifact) "
                "ORDER BY id"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, artifact_id, highlight_id FROM artifact_idea_seeds "
                "WHERE id = :preserved_idea_seed"
            ),
            ids,
        ).all(),
        connection.execute(
            text(
                "SELECT id, user_id, idempotency_key, request_hash, highlight_id, coordination "
                "FROM artifact_learn_requests WHERE id = :preserved_learn_request"
            ),
            ids,
        ).all(),
        connection.execute(text("SELECT id, body_md FROM dawn_writes WHERE id = :dawn"), ids).all(),
        connection.execute(
            text("SELECT id, error_code FROM oracle_readings WHERE id = :oracle"), ids
        ).all(),
        connection.execute(
            text(
                "SELECT id, failure_code FROM artifact_build_failures WHERE id = :preserved_failure"
            ),
            ids,
        ).all(),
        connection.execute(
            text("SELECT id, kind, payload FROM background_jobs WHERE id = :unrelated_job"), ids
        ).all(),
    )


def _assert_final_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    assert set(_FINAL_LEDGER_COLUMNS) <= tables
    assert set(_DROPPED_GENERATION_TABLES).isdisjoint(tables)
    for table, expected_columns in _FINAL_LEDGER_COLUMNS.items():
        columns = {column["name"]: column for column in inspector.get_columns(table)}
        assert set(columns) == expected_columns
        assert inspector.get_pk_constraint(table)["constrained_columns"] == ["id"]
        checks = {constraint["name"] for constraint in inspector.get_check_constraints(table)}
        assert checks == set()
    expected_unique_constraints = {
        "llm_calls": {"uq_llm_calls_owner_generation_seq"},
        "llm_model_turns": {"uq_llm_model_turns_generation_turn_seq"},
        "llm_model_turn_continuations": {
            "uq_llm_model_turn_continuations_source_turn",
            "uq_llm_model_turn_continuations_successor_turn",
        },
        "llm_tool_positions": {
            "uq_llm_tool_positions_generation_position",
            "uq_llm_tool_positions_transport_call",
        },
        "assistant_write_authorships": {"uq_assistant_write_authorships_target"},
    }
    for table, expected_names in expected_unique_constraints.items():
        assert {
            constraint["name"] for constraint in inspector.get_unique_constraints(table)
        } == expected_names
    assert inspector.get_foreign_keys("llm_calls") == []
    expected_foreign_keys = {
        "llm_model_turns": {(("generation_id",), "llm_calls", ("id",))},
        "llm_model_turn_continuations": {
            (("generation_id",), "llm_calls", ("id",)),
            (("source_model_turn_id",), "llm_model_turns", ("id",)),
        },
        "llm_tool_positions": {(("generation_id",), "llm_calls", ("id",))},
        "assistant_write_authorships": {(("tool_position_id",), "llm_tool_positions", ("id",))},
    }
    for table, expected in expected_foreign_keys.items():
        assert {
            (
                tuple(foreign_key["constrained_columns"]),
                foreign_key["referred_table"],
                tuple(foreign_key["referred_columns"]),
            )
            for foreign_key in inspector.get_foreign_keys(table)
        } == expected
    assert isinstance(
        next(
            column["type"]
            for column in inspector.get_columns("llm_calls")
            if column["name"] == "generation_spec"
        ),
        postgresql.JSONB,
    )
    chat_columns = {column["name"]: column for column in inspector.get_columns("chat_runs")}
    assert set(chat_columns) == _FINAL_CHAT_RUN_COLUMNS
    assert {
        "profile_id",
        "reasoning_option_id",
        "provider",
        "model_name",
        "reasoning_effort",
        "error_origin",
        "tool_profile_id",
        "tool_profile_revision",
        "tool_profile_snapshot",
    }.isdisjoint(chat_columns)
    assert isinstance(chat_columns["generation_spec"]["type"], postgresql.JSONB)
    assert chat_columns["generation_spec"]["nullable"] is False
    assert "ck_chat_runs_generation_spec_object" not in {
        constraint["name"] for constraint in inspector.get_check_constraints("chat_runs")
    }

    tool_call_columns = {
        column["name"]: column for column in inspector.get_columns("message_tool_calls")
    }
    assert isinstance(tool_call_columns["tool_position_id"]["type"], postgresql.UUID)
    assert tool_call_columns["tool_position_id"]["nullable"] is True
    assert "uq_message_tool_calls_tool_position" in {
        constraint["name"] for constraint in inspector.get_unique_constraints("message_tool_calls")
    }
    assert (
        ("tool_position_id",),
        "llm_tool_positions",
        ("id",),
    ) in {
        (
            tuple(foreign_key["constrained_columns"]),
            foreign_key["referred_table"],
            tuple(foreign_key["referred_columns"]),
        )
        for foreign_key in inspector.get_foreign_keys("message_tool_calls")
    }

    prompt_columns = {
        column["name"]: column for column in inspector.get_columns("chat_prompt_assemblies")
    }
    assert set(prompt_columns) == _FINAL_CHAT_PROMPT_COLUMNS
    assert isinstance(prompt_columns["generation_intent"]["type"], postgresql.JSONB)
    assert prompt_columns["generation_intent"]["nullable"] is False
    assert prompt_columns["generation_intent_digest"]["nullable"] is False
    assert {
        "ck_chat_prompt_assemblies_generation_intent_object",
        "ck_chat_prompt_assemblies_generation_intent_digest",
    }.isdisjoint(
        {
            constraint["name"]
            for constraint in inspector.get_check_constraints("chat_prompt_assemblies")
        }
    )
    entitlement_columns = {
        column["name"] for column in inspector.get_columns("billing_entitlement_overrides")
    }
    assert {
        "platform_token_limit_monthly",
        "platform_token_quota_mode",
    }.isdisjoint(entitlement_columns)
    assert "nx_0224_preservation_manifest" not in tables

    with engine.connect() as connection:
        for table in (*_RESET_TABLES, *_FINAL_LEDGER_COLUMNS):
            assert connection.scalar(text(f'SELECT count(*) FROM "{table}"')) == 0
        assert (
            connection.scalar(
                text(
                    "SELECT count(*) FROM background_jobs WHERE kind = ANY(CAST(:kinds AS text[]))"
                ),
                {"kinds": list(_GENERATION_JOB_KINDS)},
            )
            == 0
        )
        assert (
            connection.scalar(
                text(
                    """
                    SELECT count(*)
                    FROM (
                        SELECT id FROM resource_edges
                         WHERE source_scheme IN ('conversation', 'message')
                            OR target_scheme IN ('conversation', 'message')
                        UNION ALL
                        SELECT id FROM resource_versions
                         WHERE resource_scheme IN ('conversation', 'message')
                        UNION ALL
                        SELECT id FROM resource_view_states
                         WHERE surface_scheme IN ('conversation', 'message')
                            OR target_scheme IN ('conversation', 'message')
                        UNION ALL
                        SELECT id FROM passage_anchors
                         WHERE owner_scheme IN ('conversation', 'message')
                        UNION ALL
                        SELECT id FROM artifacts
                         WHERE subject_scheme IN ('conversation', 'message')
                            OR audience_scheme IN ('conversation', 'message')
                        UNION ALL
                        SELECT id FROM resource_grants
                         WHERE subject_scheme IN ('conversation', 'message')
                        UNION ALL
                        SELECT user_id FROM synapse_suppressions
                         WHERE source_scheme IN ('conversation', 'message')
                            OR target_scheme IN ('conversation', 'message')
                        UNION ALL
                        SELECT id FROM resource_mutations
                         WHERE split_part(mutation_scope, ':', 1) = 'resource'
                           AND split_part(mutation_scope, ':', 2)
                               IN ('conversation', 'message')
                    ) AS dangling_chat_reference
                    """
                )
            )
            == 0
        )
        assert (
            connection.scalar(
                text(
                    """
                    SELECT count(*)
                    FROM (
                        SELECT versions.id
                        FROM resource_versions AS versions
                        WHERE versions.resource_scheme = 'external_snapshot'
                          AND NOT EXISTS (
                            SELECT 1 FROM resource_external_snapshots AS snapshots
                            WHERE snapshots.id = versions.resource_id
                          )
                        UNION ALL
                        SELECT views.id
                        FROM resource_view_states AS views
                        WHERE (
                            views.surface_scheme = 'external_snapshot'
                            AND NOT EXISTS (
                              SELECT 1 FROM resource_external_snapshots AS snapshots
                              WHERE snapshots.id = views.surface_id
                            )
                        ) OR (
                            views.target_scheme = 'external_snapshot'
                            AND NOT EXISTS (
                              SELECT 1 FROM resource_external_snapshots AS snapshots
                              WHERE snapshots.id = views.target_id
                            )
                        )
                        UNION ALL
                        SELECT edges.id
                        FROM resource_edges AS edges
                        WHERE (
                            edges.source_scheme = 'external_snapshot'
                            AND NOT EXISTS (
                              SELECT 1 FROM resource_external_snapshots AS snapshots
                              WHERE snapshots.id = edges.source_id
                            )
                        ) OR (
                            edges.target_scheme = 'external_snapshot'
                            AND NOT EXISTS (
                              SELECT 1 FROM resource_external_snapshots AS snapshots
                              WHERE snapshots.id = edges.target_id
                            )
                        )
                        UNION ALL
                        SELECT anchors.id
                        FROM passage_anchors AS anchors
                        WHERE anchors.owner_scheme = 'external_snapshot'
                          AND NOT EXISTS (
                            SELECT 1 FROM resource_external_snapshots AS snapshots
                            WHERE snapshots.id = anchors.owner_id
                          )
                        UNION ALL
                        SELECT artifacts.id
                        FROM artifacts
                        WHERE (
                            artifacts.subject_scheme = 'external_snapshot'
                            AND NOT EXISTS (
                              SELECT 1 FROM resource_external_snapshots AS snapshots
                              WHERE snapshots.id = artifacts.subject_id
                            )
                        ) OR (
                            artifacts.audience_scheme = 'external_snapshot'
                            AND NOT EXISTS (
                              SELECT 1 FROM resource_external_snapshots AS snapshots
                              WHERE snapshots.id::text = artifacts.audience_id
                            )
                        )
                        UNION ALL
                        SELECT grants.id
                        FROM resource_grants AS grants
                        WHERE grants.subject_scheme = 'external_snapshot'
                          AND NOT EXISTS (
                            SELECT 1 FROM resource_external_snapshots AS snapshots
                            WHERE snapshots.id = grants.subject_id
                          )
                        UNION ALL
                        SELECT suppressions.user_id
                        FROM synapse_suppressions AS suppressions
                        WHERE (
                            suppressions.source_scheme = 'external_snapshot'
                            AND NOT EXISTS (
                              SELECT 1 FROM resource_external_snapshots AS snapshots
                              WHERE snapshots.id = suppressions.source_id
                            )
                        ) OR (
                            suppressions.target_scheme = 'external_snapshot'
                            AND NOT EXISTS (
                              SELECT 1 FROM resource_external_snapshots AS snapshots
                              WHERE snapshots.id = suppressions.target_id
                            )
                        )
                    ) AS dangling_external_snapshot_reference
                    """
                )
            )
            == 0
        )


def _seed_drained_preflight_fixture(
    connection: Connection,
    ids: dict[str, UUID],
) -> None:
    _seed_preserved_families(connection, ids)
    _seed_reset_aggregate(connection, ids)
    _drain_seeded_generation_job(connection, ids)


@pytest.mark.parametrize("status", ("pending", "running"))
def test_0224_refuses_unsettled_chat_tool_calls(
    empty_migration_database_url: str,
    status: str,
) -> None:
    """Risk: the reset erases a tool dispatch whose outcome is not yet settled."""

    config = _migration_config()
    command.upgrade(config, "0223")
    engine = create_engine(empty_migration_database_url)
    ids = _ids()
    try:
        with engine.begin() as connection:
            _seed_drained_preflight_fixture(connection, ids)
            connection.execute(
                text("UPDATE message_tool_calls SET status = :status WHERE id = :tool_call"),
                {**ids, "status": status},
            )

        with pytest.raises(
            RuntimeError,
            match=rf"Chat tool calls must be settled.*{ids['tool_call']}",
        ):
            command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0223"
            assert (
                connection.scalar(
                    text("SELECT status FROM message_tool_calls WHERE id = :tool_call"),
                    ids,
                )
                == status
            )
            assert connection.scalar(text("SELECT count(*) FROM conversations")) == 1
    finally:
        engine.dispose()


def test_0224_refuses_uncertain_learn_coordination(
    empty_migration_database_url: str,
) -> None:
    """Risk: a terminal Learn memo masks a still-uncertain dispatch journal."""

    config = _migration_config()
    command.upgrade(config, "0223")
    engine = create_engine(empty_migration_database_url)
    ids = _ids()
    try:
        with engine.begin() as connection:
            _seed_drained_preflight_fixture(connection, ids)
            connection.execute(
                text(
                    "UPDATE artifact_learn_requests SET coordination = "
                    "jsonb_build_object('resolver', "
                    "jsonb_build_object('dispatch_phase', 'Uncertain')) "
                    "WHERE id = :learn_request"
                ),
                ids,
            )

        with pytest.raises(
            RuntimeError,
            match=rf"Learn coordination journals contain Uncertain dispatches.*"
            rf"{ids['learn_request']}",
        ):
            command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0223"
            assert (
                connection.scalar(
                    text(
                        "SELECT coordination #>> '{resolver,dispatch_phase}' "
                        "FROM artifact_learn_requests WHERE id = :learn_request"
                    ),
                    ids,
                )
                == "Uncertain"
            )
            assert connection.scalar(text("SELECT count(*) FROM conversations")) == 1
    finally:
        engine.dispose()


def test_0224_refuses_future_fk_child_of_partial_delete_owner(
    empty_migration_database_url: str,
) -> None:
    """Risk: a new FK child turns the aggregate reset into a partial mutation."""

    config = _migration_config()
    command.upgrade(config, "0223")
    engine = create_engine(empty_migration_database_url)
    ids = _ids()
    try:
        with engine.begin() as connection:
            _seed_drained_preflight_fixture(connection, ids)
            connection.execute(
                text(
                    "CREATE TABLE nx_future_view_consumers ("
                    "id uuid PRIMARY KEY, "
                    "view_id uuid NOT NULL REFERENCES resource_view_states(id))"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO nx_future_view_consumers (id, view_id) "
                    "VALUES (:future_view_consumer, :chat_view)"
                ),
                ids,
            )

        with pytest.raises(
            RuntimeError,
            match=r"reset foreign-key closure changed.*nx_future_view_consumers",
        ):
            command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0223"
            assert (
                connection.scalar(
                    text(
                        "SELECT view_id FROM nx_future_view_consumers "
                        "WHERE id = :future_view_consumer"
                    ),
                    ids,
                )
                == ids["chat_view"]
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM resource_view_states WHERE id = :chat_view"),
                    ids,
                )
                == 1
            )
    finally:
        engine.dispose()


def test_0224_refuses_preserved_oracle_folio_on_reset_edge(
    empty_migration_database_url: str,
) -> None:
    """Risk: deleting a Chat edge either orphans or destroys a preserved Oracle folio."""

    config = _migration_config()
    command.upgrade(config, "0223")
    engine = create_engine(empty_migration_database_url)
    ids = _ids()
    try:
        with engine.begin() as connection:
            _seed_drained_preflight_fixture(connection, ids)
            connection.execute(
                text(
                    "INSERT INTO oracle_reading_folios "
                    "(reading_id, phase, edge_id, source_kind, locator_label, "
                    "attribution_text, marginalia_text) VALUES "
                    "(:oracle, 'descent', :chat_edge, 'user_media', "
                    "'Preserved citation', 'Preserved attribution', 'Preserved marginalia')"
                ),
                ids,
            )

        with pytest.raises(
            RuntimeError,
            match=rf"Oracle reading folios reference reset resource edges.*{ids['chat_edge']}",
        ):
            command.upgrade(config, "0224")

        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0223"
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM oracle_reading_folios "
                        "WHERE reading_id = :oracle AND edge_id = :chat_edge"
                    ),
                    ids,
                )
                == 1
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM resource_edges WHERE id = :chat_edge"),
                    ids,
                )
                == 1
            )
            assert (
                connection.scalar(
                    text("SELECT event_type FROM oracle_reading_events WHERE id = :oracle_event"),
                    ids,
                )
                == "done"
            )
    finally:
        engine.dispose()


@pytest.mark.parametrize("state", ("empty", "synthetic-0223"))
def test_0223_aggregate_reset_preserves_domain_data(
    empty_migration_database_url: str,
    state: str,
) -> None:
    """Risk: the irreversible reset deletes durable content or retains legacy authority."""

    config = _migration_config()
    reset_revision = next(
        (
            revision
            for revision in ScriptDirectory.from_config(config).walk_revisions()
            if revision.revision == "0224"
        ),
        None,
    )
    assert reset_revision is not None, (
        "expected the generation-backends reset to be registered as Alembic revision 0224"
    )
    assert reset_revision.down_revision == "0223", (
        "expected generation-backends revision 0224 to descend directly from 0223; "
        f"actual down_revision={reset_revision.down_revision!r}"
    )
    command.upgrade(config, "0223")
    engine = create_engine(empty_migration_database_url)
    try:
        if state == "empty":
            command.upgrade(config, "0224")
            _assert_final_schema(engine)
            return

        ids = _ids()
        with engine.begin() as connection:
            _seed_preserved_families(connection, ids)
            _seed_extended_preserved_families(connection, ids)
            _seed_reset_aggregate(connection, ids)
            _seed_reset_typed_closure(connection, ids)
            connection.execute(
                text(
                    "UPDATE background_jobs SET status = 'succeeded', attempts = 1 "
                    "WHERE id = :generation_job"
                ),
                ids,
            )
            before_refusal = (
                connection.scalar(text("SELECT version_num FROM alembic_version")),
                connection.scalar(text("SELECT count(*) FROM conversations")),
                connection.scalar(text("SELECT count(*) FROM llm_calls")),
                _preservation_fingerprint(connection, ids),
            )

        with pytest.raises(
            RuntimeError,
            match=rf"media source attempts reference reset generation jobs.*{ids['source_attempt']}",
        ):
            command.upgrade(config, "0224")
        with engine.begin() as connection:
            after_refusal = (
                connection.scalar(text("SELECT version_num FROM alembic_version")),
                connection.scalar(text("SELECT count(*) FROM conversations")),
                connection.scalar(text("SELECT count(*) FROM llm_calls")),
                _preservation_fingerprint(connection, ids),
            )
            assert after_refusal == before_refusal
            assert (
                connection.scalar(
                    text("SELECT job_id FROM media_source_attempts WHERE id = :source_attempt"),
                    ids,
                )
                == ids["generation_job"]
            )
            connection.execute(
                text("UPDATE media_source_attempts SET job_id = NULL WHERE id = :source_attempt"),
                ids,
            )
            preserved = _preservation_fingerprint(connection, ids)

        command.upgrade(config, "0224")
        _assert_final_schema(engine)
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0224"
            for table in _RESET_TABLES:
                assert connection.scalar(text(f"SELECT count(*) FROM {table}")) == 0
            assert connection.scalar(text("SELECT count(*) FROM llm_calls")) == 0
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM background_jobs WHERE id = :generation_job"), ids
                )
                == 0
            )
            assert connection.execute(
                text(
                    "SELECT job_id, worker_id, attempt_no, lease_expires_at "
                    "FROM background_job_capacity_leases WHERE resource_class = 'Heavy'"
                )
            ).one() == (None, None, None, None)
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM resource_external_snapshots WHERE id = :chat_external"
                    ),
                    ids,
                )
                == 0
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM resource_external_snapshots "
                        "WHERE id = :shared_external"
                    ),
                    ids,
                )
                == 1
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM resource_edges WHERE id = :shared_external_edge"),
                    ids,
                )
                == 1
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM artifacts WHERE id = :conversation_artifact"), ids
                )
                == 0
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM artifacts WHERE id IN "
                        "(:message_subject_artifact, :conversation_audience_artifact, "
                        ":message_audience_artifact, :transitive_artifact, "
                        ":revision_dependent_artifact)"
                    ),
                    ids,
                )
                == 0
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM artifact_builds WHERE id IN "
                        "(:conversation_build, :transitive_build, :revision_dependent_build)"
                    ),
                    ids,
                )
                == 0
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM artifact_revisions WHERE id IN "
                        "(:conversation_revision, :transitive_revision, "
                        ":revision_dependent_revision)"
                    ),
                    ids,
                )
                == 0
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM artifact_build_events WHERE id IN "
                        "(:conversation_event, :transitive_event, :revision_dependent_event)"
                    ),
                    ids,
                )
                == 0
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM resource_external_snapshots WHERE id IN ("
                        ":typed_external, :surface_external, :target_external, "
                        ":grant_external, :anchor_external, "
                        ":suppression_source_external, :suppression_target_external, "
                        ":artifact_subject_external, :artifact_audience_external, "
                        ":shared_target_external)"
                    ),
                    ids,
                )
                == 10
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT count(*) FROM resource_external_snapshots "
                        "WHERE id = :doomed_edge_external"
                    ),
                    ids,
                )
                == 0
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM resource_edges WHERE id = :doomed_external_edge"),
                    ids,
                )
                == 0
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM resource_edges WHERE id = :chat_edge"), ids
                )
                == 0
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM passage_anchors WHERE id = :chat_anchor"), ids
                )
                == 0
            )
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM resource_mutations WHERE id = :chat_mutation"), ids
                )
                == 0
            )
            assert _preservation_fingerprint(connection, ids) == preserved
            assert (
                connection.scalar(
                    text(
                        "SELECT event_type FROM artifact_build_events WHERE id = :preserved_event"
                    ),
                    ids,
                )
                == "HistoricalFailed"
            )
            assert (
                connection.scalar(
                    text("SELECT event_type FROM oracle_reading_events WHERE id = :oracle_event"),
                    ids,
                )
                == "historical_done"
            )
    finally:
        engine.dispose()
