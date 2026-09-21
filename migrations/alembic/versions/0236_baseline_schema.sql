--
-- PostgreSQL database dump
--


-- Dumped from database version 15.18 (Debian 15.18-1.pgdg12+1)
-- Dumped by pg_dump version 15.18 (Debian 15.18-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: failure_stage_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.failure_stage_enum AS ENUM (
    'upload',
    'extract',
    'transcribe',
    'embed',
    'metadata',
    'other'
);


--
-- Name: processing_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.processing_status_enum AS ENUM (
    'pending',
    'extracting',
    'ready_for_reading',
    'failed'
);


--
-- Name: notify_artifact_build_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_artifact_build_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            PERFORM pg_notify('artifact_build_events', NEW.build_id::text);
            RETURN NEW;
        END;
        $$;


--
-- Name: notify_chat_run_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_chat_run_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            PERFORM pg_notify('chat_run_events', NEW.run_id::text);
            RETURN NULL;
        END;
        $$;


--
-- Name: notify_media_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_media_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            PERFORM pg_notify('media_events', NEW.id::text);
            RETURN NULL;
        END;
        $$;


--
-- Name: notify_oracle_reading_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_oracle_reading_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            PERFORM pg_notify('oracle_reading_events', NEW.reading_id::text);
            RETURN NULL;
        END;
        $$;


--
-- Name: notify_podcast_refresh_run(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_podcast_refresh_run() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            PERFORM pg_notify('podcast_refresh_events', NEW.id::text);
            RETURN NEW;
        END;
        $$;


--
-- Name: notify_podcast_subscription_backfill_lifecycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_podcast_subscription_backfill_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        DECLARE
            subscription_identity uuid;
        BEGIN
            subscription_identity := CASE
                WHEN TG_OP = 'DELETE' THEN OLD.subscription_id
                ELSE NEW.subscription_id
            END;
            PERFORM pg_notify('podcast_subscription_events', subscription_identity::text);
            RETURN NULL;
        END;
        $$;


--
-- Name: notify_podcast_subscription_lifecycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_podcast_subscription_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        DECLARE
            subscription_identity uuid;
        BEGIN
            subscription_identity := CASE
                WHEN TG_OP = 'DELETE' THEN OLD.id
                ELSE NEW.id
            END;
            PERFORM pg_notify('podcast_subscription_events', subscription_identity::text);
            RETURN NULL;
        END;
        $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: artifact_build_cancellations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_build_cancellations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    build_id uuid NOT NULL,
    actor_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artifact_build_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_build_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    build_id uuid NOT NULL,
    seq integer NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_artifact_build_events_payload_object CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT ck_artifact_build_events_seq_positive CHECK ((seq >= 1)),
    CONSTRAINT ck_artifact_build_events_type CHECK ((event_type = ANY (ARRAY['Started'::text, 'Progress'::text, 'Succeeded'::text, 'Failed'::text, 'Cancelled'::text])))
);


--
-- Name: artifact_build_failures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_build_failures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    build_id uuid NOT NULL,
    failure_code text NOT NULL,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artifact_builds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_builds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    artifact_id uuid NOT NULL,
    requester_user_id uuid,
    instruction text,
    idempotency_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artifact_idea_resolutions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_idea_resolutions (
    highlight_id uuid NOT NULL,
    user_id uuid NOT NULL,
    idea_subject_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artifact_idea_seeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_idea_seeds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    artifact_id uuid NOT NULL,
    highlight_id uuid NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artifact_idea_subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_idea_subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    idea_key jsonb NOT NULL,
    display_title text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artifact_learn_failures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_learn_failures (
    request_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artifact_learn_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_learn_requests (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    highlight_id uuid NOT NULL,
    coordination jsonb NOT NULL,
    resolver_lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artifact_learn_successes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_learn_successes (
    request_id uuid NOT NULL,
    outcome_kind text NOT NULL,
    artifact_id uuid NOT NULL,
    build_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artifact_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    promoted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    build_id uuid NOT NULL,
    citation_owner_user_id uuid NOT NULL,
    creator_user_id uuid,
    input_manifest jsonb NOT NULL,
    content_html text NOT NULL,
    content_text text NOT NULL,
    CONSTRAINT ck_artifact_revisions_input_manifest_object CHECK ((jsonb_typeof(input_manifest) = 'object'::text))
);


--
-- Name: artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    current_revision_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    subject_scheme text NOT NULL,
    subject_id uuid NOT NULL,
    audience_scheme text NOT NULL,
    audience_id text NOT NULL
);


--
-- Name: assistant_write_authorships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assistant_write_authorships (
    id uuid NOT NULL,
    tool_position_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_handoff_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_handoff_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    challenge text NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT ck_auth_handoff_codes_challenge_len CHECK ((char_length(challenge) = 64)),
    CONSTRAINT ck_auth_handoff_codes_code_hash_len CHECK ((char_length(code_hash) = 64)),
    CONSTRAINT ck_auth_handoff_codes_expires_after_created CHECK ((expires_at > created_at))
);


--
-- Name: background_job_capacity_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.background_job_capacity_leases (
    resource_class text NOT NULL,
    job_id uuid,
    worker_id text,
    attempt_no integer,
    lease_expires_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: background_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.background_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_expires_at timestamp with time zone,
    claimed_by text,
    dedupe_key text,
    error_code text,
    last_error text,
    result jsonb,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    execution_id uuid,
    CONSTRAINT ck_background_jobs_attempts_non_negative CHECK ((attempts >= 0)),
    CONSTRAINT ck_background_jobs_max_attempts_positive CHECK ((max_attempts >= 1)),
    CONSTRAINT ck_background_jobs_status CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'dead'::text])))
);


--
-- Name: billing_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    stripe_price_id text,
    plan_tier text DEFAULT 'free'::text NOT NULL,
    subscription_status text,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_billing_accounts_plan_tier CHECK ((plan_tier = ANY (ARRAY['free'::text, 'plus'::text, 'ai_plus'::text, 'ai_pro'::text]))),
    CONSTRAINT ck_billing_accounts_subscription_status CHECK (((subscription_status IS NULL) OR (subscription_status = ANY (ARRAY['incomplete'::text, 'incomplete_expired'::text, 'trialing'::text, 'active'::text, 'past_due'::text, 'canceled'::text, 'unpaid'::text, 'paused'::text]))))
);


--
-- Name: billing_entitlement_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_entitlement_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plan_tier text NOT NULL,
    transcription_quota_mode text DEFAULT 'plan'::text NOT NULL,
    transcription_minutes_limit_monthly integer,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    reason text NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    created_by_label text,
    updated_by_label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_billing_entitlement_overrides_plan_tier CHECK ((plan_tier = ANY (ARRAY['plus'::text, 'ai_plus'::text, 'ai_pro'::text]))),
    CONSTRAINT ck_billing_entitlement_overrides_reason_present CHECK ((char_length(btrim(reason)) > 0)),
    CONSTRAINT ck_billing_entitlement_overrides_transcription_limit CHECK ((((transcription_quota_mode = 'custom'::text) AND (transcription_minutes_limit_monthly IS NOT NULL) AND (transcription_minutes_limit_monthly >= 0)) OR ((transcription_quota_mode <> 'custom'::text) AND (transcription_minutes_limit_monthly IS NULL)))),
    CONSTRAINT ck_billing_entitlement_overrides_transcription_quota_mode CHECK ((transcription_quota_mode = ANY (ARRAY['plan'::text, 'custom'::text, 'unlimited'::text])))
);


--
-- Name: chat_prompt_assemblies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_prompt_assemblies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_run_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    assistant_message_id uuid NOT NULL,
    max_context_tokens integer NOT NULL,
    reserved_output_tokens integer NOT NULL,
    input_budget_tokens integer NOT NULL,
    estimated_input_tokens integer NOT NULL,
    included_message_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    included_retrieval_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    included_context_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    dropped_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    budget_breakdown jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    prompt_block_manifest jsonb DEFAULT '{}'::jsonb NOT NULL,
    generation_intent jsonb NOT NULL,
    generation_intent_digest text NOT NULL,
    CONSTRAINT ck_chat_prompt_assemblies_budget_breakdown_object CHECK ((jsonb_typeof(budget_breakdown) = 'object'::text)),
    CONSTRAINT ck_chat_prompt_assemblies_context_refs_array CHECK ((jsonb_typeof(included_context_refs) = 'array'::text)),
    CONSTRAINT ck_chat_prompt_assemblies_dropped_items_array CHECK ((jsonb_typeof(dropped_items) = 'array'::text)),
    CONSTRAINT ck_chat_prompt_assemblies_message_ids_array CHECK ((jsonb_typeof(included_message_ids) = 'array'::text)),
    CONSTRAINT ck_chat_prompt_assemblies_prompt_block_manifest_object CHECK ((jsonb_typeof(prompt_block_manifest) = 'object'::text)),
    CONSTRAINT ck_chat_prompt_assemblies_retrieval_ids_array CHECK ((jsonb_typeof(included_retrieval_ids) = 'array'::text))
);


--
-- Name: chat_run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_run_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    seq integer NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_chat_run_events_event_type CHECK ((event_type = ANY (ARRAY['meta'::text, 'assistant_activity'::text, 'assistant_text_delta'::text, 'tool_call_start'::text, 'tool_call_delta'::text, 'tool_call_done'::text, 'tool_result'::text, 'citation_index'::text, 'context_ref_added'::text, 'done'::text]))),
    CONSTRAINT ck_chat_run_events_seq_positive CHECK ((seq >= 1))
);


--
-- Name: chat_run_turn_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_run_turn_contexts (
    chat_run_id uuid NOT NULL,
    requested_subject_scheme text,
    requested_subject_id uuid,
    subject_scheme text,
    subject_id uuid,
    subject_context_edge_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_chat_run_turn_contexts_has_anchor CHECK ((subject_id IS NOT NULL)),
    CONSTRAINT ck_chat_run_turn_contexts_requested_subject_pair CHECK (((requested_subject_scheme IS NULL) = (requested_subject_id IS NULL))),
    CONSTRAINT ck_chat_run_turn_contexts_requested_subject_scheme CHECK (((requested_subject_scheme IS NULL) OR (requested_subject_scheme = ANY (ARRAY['media'::text, 'library'::text, 'evidence_span'::text, 'content_chunk'::text, 'highlight'::text, 'page'::text, 'note_block'::text, 'fragment'::text, 'conversation'::text, 'message'::text, 'oracle_reading'::text, 'oracle_passage_anchor'::text, 'artifact'::text, 'artifact_revision'::text, 'external_snapshot'::text, 'contributor'::text, 'podcast'::text, 'reader_apparatus_item'::text, 'passage_anchor'::text])))),
    CONSTRAINT ck_chat_run_turn_contexts_subject_pair CHECK (((subject_scheme IS NULL) = (subject_id IS NULL))),
    CONSTRAINT ck_chat_run_turn_contexts_subject_scheme CHECK (((subject_scheme IS NULL) OR (subject_scheme = ANY (ARRAY['media'::text, 'library'::text, 'evidence_span'::text, 'content_chunk'::text, 'highlight'::text, 'page'::text, 'note_block'::text, 'fragment'::text, 'conversation'::text, 'message'::text, 'oracle_reading'::text, 'oracle_passage_anchor'::text, 'artifact'::text, 'artifact_revision'::text, 'external_snapshot'::text, 'contributor'::text, 'podcast'::text, 'reader_apparatus_item'::text, 'passage_anchor'::text]))))
);


--
-- Name: chat_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    user_message_id uuid NOT NULL,
    assistant_message_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    cancel_requested_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    support_id text,
    publication_warning_code text,
    generation_spec jsonb NOT NULL,
    CONSTRAINT ck_chat_runs_status CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'complete'::text, 'error'::text, 'cancelled'::text])))
);


--
-- Name: consumption_activity_exclusions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consumption_activity_exclusions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    media_id uuid NOT NULL,
    modality text NOT NULL,
    device_id text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    restored_at timestamp with time zone,
    ended_at timestamp with time zone NOT NULL
);


--
-- Name: consumption_activity_spans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consumption_activity_spans (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    media_id uuid NOT NULL,
    modality text NOT NULL,
    device_id text NOT NULL,
    device_class text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    duration_ms bigint NOT NULL,
    progress_start double precision,
    progress_end double precision,
    word_start bigint,
    word_end bigint,
    media_position_start_ms bigint,
    media_position_end_ms bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    capture_key uuid NOT NULL
);


--
-- Name: consumption_completion_facts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consumption_completion_facts (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    media_id uuid NOT NULL,
    modality text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: consumption_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consumption_overrides (
    user_id uuid NOT NULL,
    media_id uuid NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revision integer DEFAULT 0 NOT NULL
);


--
-- Name: consumption_queue_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consumption_queue_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    media_id uuid NOT NULL,
    "position" integer NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    CONSTRAINT ck_consumption_queue_items_position_non_negative CHECK (("position" >= 0))
);


--
-- Name: content_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    block_idx integer NOT NULL,
    block_kind text NOT NULL,
    canonical_text text NOT NULL,
    heading_path jsonb NOT NULL,
    locator jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_kind text NOT NULL,
    owner_id uuid NOT NULL,
    CONSTRAINT ck_content_blocks_block_idx CHECK ((block_idx >= 0)),
    CONSTRAINT ck_content_blocks_heading CHECK ((jsonb_typeof(heading_path) = 'array'::text)),
    CONSTRAINT ck_content_blocks_locator CHECK ((jsonb_typeof(locator) = 'object'::text)),
    CONSTRAINT ck_content_blocks_owner_kind CHECK ((owner_kind = ANY (ARRAY['media'::text, 'note_block'::text])))
);


--
-- Name: content_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    primary_evidence_span_id uuid,
    chunk_idx integer NOT NULL,
    source_kind text NOT NULL,
    chunk_text text NOT NULL,
    heading_path jsonb NOT NULL,
    summary_locator jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    chunk_text_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, chunk_text)) STORED,
    owner_kind text NOT NULL,
    owner_id uuid NOT NULL,
    CONSTRAINT ck_content_chunks_chunk_idx_non_negative CHECK ((chunk_idx >= 0)),
    CONSTRAINT ck_content_chunks_heading CHECK ((jsonb_typeof(heading_path) = 'array'::text)),
    CONSTRAINT ck_content_chunks_locator CHECK ((jsonb_typeof(summary_locator) = 'object'::text)),
    CONSTRAINT ck_content_chunks_owner_kind CHECK ((owner_kind = ANY (ARRAY['media'::text, 'note_block'::text]))),
    CONSTRAINT ck_content_chunks_source_kind CHECK ((source_kind = ANY (ARRAY['web_article'::text, 'epub'::text, 'pdf'::text, 'transcript'::text, 'note'::text])))
);


--
-- Name: content_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_embeddings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chunk_id uuid NOT NULL,
    embedding_provider text NOT NULL,
    embedding_model text NOT NULL,
    embedding_dimensions integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding_vector public.vector(256),
    CONSTRAINT ck_content_embeddings_dimensions CHECK ((embedding_dimensions > 0))
);


--
-- Name: content_index_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_index_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text NOT NULL,
    status_reason text,
    active_embedding_provider text,
    active_embedding_model text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_kind text NOT NULL,
    owner_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT ck_content_index_states_owner_kind CHECK ((owner_kind = ANY (ARRAY['media'::text, 'note_block'::text]))),
    CONSTRAINT ck_content_index_states_status CHECK ((status = ANY (ARRAY['pending'::text, 'indexing'::text, 'ready'::text, 'no_text'::text, 'ocr_required'::text, 'failed'::text])))
);


--
-- Name: contributor_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contributor_aliases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contributor_id uuid NOT NULL,
    alias text NOT NULL,
    normalized_alias text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolves_identity boolean NOT NULL
);


--
-- Name: contributor_credits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contributor_credits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contributor_id uuid NOT NULL,
    media_id uuid,
    podcast_id uuid,
    project_gutenberg_catalog_ebook_id bigint,
    credited_name text NOT NULL,
    normalized_credited_name text NOT NULL,
    role text NOT NULL,
    raw_role text,
    ordinal integer NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contributor_external_ids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contributor_external_ids (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contributor_id uuid NOT NULL,
    authority text NOT NULL,
    external_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contributors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contributors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    handle text NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversation_active_paths; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_active_paths (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    viewer_user_id uuid NOT NULL,
    active_leaf_message_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversation_branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_branches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    branch_user_message_id uuid NOT NULL,
    title text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_conversation_branches_title_length CHECK (((title IS NULL) OR ((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 120))))
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    next_seq integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    title text DEFAULT 'Chat'::text NOT NULL,
    CONSTRAINT ck_conversations_next_seq_positive CHECK ((next_seq >= 1)),
    CONSTRAINT ck_conversations_title_max_length CHECK ((char_length(title) <= 120)),
    CONSTRAINT ck_conversations_title_not_blank CHECK ((length(btrim(title)) > 0))
);


--
-- Name: daily_page_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_page_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    local_date date NOT NULL,
    page_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dawn_writes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dawn_writes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    local_date date NOT NULL,
    body_md text NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    dismissed_at timestamp with time zone,
    CONSTRAINT ck_dawn_writes_body_nonempty CHECK ((char_length(body_md) >= 1))
);


--
-- Name: document_embed_artifact_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_embed_artifact_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    source_attempt_id uuid,
    status text NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    resolved_count integer DEFAULT 0 NOT NULL,
    unsupported_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    diagnostics jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_embeds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_embeds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    fragment_id uuid,
    source_attempt_id uuid,
    ordinal integer NOT NULL,
    occurrence_key text NOT NULL,
    provider text NOT NULL,
    embed_kind text NOT NULL,
    source_shape text NOT NULL,
    resolution_status text NOT NULL,
    source_url text,
    canonical_source_url text,
    provider_target_ref text,
    target_media_id uuid,
    title text,
    description text,
    thumbnail_url text,
    authored_text text,
    placeholder_text text NOT NULL,
    source_start_offset integer,
    source_end_offset integer,
    canonical_start_offset integer,
    canonical_end_offset integer,
    document_order_key text NOT NULL,
    error_code text,
    error_message text,
    diagnostics jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: epub_fragment_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.epub_fragment_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    fragment_id uuid NOT NULL,
    package_href text NOT NULL,
    manifest_item_id text NOT NULL,
    spine_itemref_id text,
    media_type text NOT NULL,
    linear boolean NOT NULL,
    reading_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_epub_fragment_sources_href_length CHECK (((char_length(package_href) >= 1) AND (char_length(package_href) <= 2048))),
    CONSTRAINT ck_epub_fragment_sources_itemref_id_length CHECK (((spine_itemref_id IS NULL) OR ((char_length(spine_itemref_id) >= 1) AND (char_length(spine_itemref_id) <= 255)))),
    CONSTRAINT ck_epub_fragment_sources_manifest_id_length CHECK (((char_length(manifest_item_id) >= 1) AND (char_length(manifest_item_id) <= 255))),
    CONSTRAINT ck_epub_fragment_sources_reading_order CHECK ((reading_order >= 0))
);


--
-- Name: epub_nav_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.epub_nav_locations (
    media_id uuid NOT NULL,
    location_id text NOT NULL,
    ordinal integer NOT NULL,
    source_node_id text,
    label text NOT NULL,
    fragment_idx integer NOT NULL,
    href_path text,
    href_fragment text,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer,
    parent_section_id text,
    end_fragment_idx integer,
    CONSTRAINT ck_epub_nav_locations_fragment_idx_nonneg CHECK ((fragment_idx >= 0)),
    CONSTRAINT ck_epub_nav_locations_label_nonempty CHECK (((char_length(TRIM(BOTH FROM label)) >= 1) AND (char_length(TRIM(BOTH FROM label)) <= 512))),
    CONSTRAINT ck_epub_nav_locations_location_id_nonempty CHECK (((char_length(location_id) >= 1) AND (char_length(location_id) <= 255))),
    CONSTRAINT ck_epub_nav_locations_ordinal_nonneg CHECK ((ordinal >= 0))
);


--
-- Name: epub_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.epub_resources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    package_href text NOT NULL,
    asset_key text NOT NULL,
    storage_path text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_epub_resources_asset_key_length CHECK (((char_length(asset_key) >= 1) AND (char_length(asset_key) <= 2048))),
    CONSTRAINT ck_epub_resources_href_length CHECK (((char_length(package_href) >= 1) AND (char_length(package_href) <= 2048))),
    CONSTRAINT ck_epub_resources_size_non_negative CHECK ((size_bytes >= 0))
);


--
-- Name: epub_toc_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.epub_toc_nodes (
    media_id uuid NOT NULL,
    node_id text NOT NULL,
    parent_node_id text,
    label text NOT NULL,
    href text,
    fragment_idx integer,
    depth integer NOT NULL,
    order_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    nav_type text DEFAULT 'toc'::text NOT NULL,
    target_offset integer,
    CONSTRAINT ck_epub_toc_nodes_depth_range CHECK (((depth >= 0) AND (depth <= 16))),
    CONSTRAINT ck_epub_toc_nodes_fragment_idx_nonneg CHECK (((fragment_idx IS NULL) OR (fragment_idx >= 0))),
    CONSTRAINT ck_epub_toc_nodes_label_nonempty CHECK (((char_length(TRIM(BOTH FROM label)) >= 1) AND (char_length(TRIM(BOTH FROM label)) <= 512))),
    CONSTRAINT ck_epub_toc_nodes_nav_type CHECK ((nav_type = ANY (ARRAY['toc'::text, 'landmarks'::text, 'page_list'::text]))),
    CONSTRAINT ck_epub_toc_nodes_node_id_nonempty CHECK (((char_length(node_id) >= 1) AND (char_length(node_id) <= 255))),
    CONSTRAINT ck_epub_toc_nodes_order_key_format CHECK ((order_key ~ '^[0-9]{4}([.][0-9]{4})*$'::text)),
    CONSTRAINT ck_epub_toc_nodes_parent_nonself CHECK (((parent_node_id IS NULL) OR (parent_node_id <> node_id)))
);


--
-- Name: evidence_spans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evidence_spans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    start_block_id uuid NOT NULL,
    end_block_id uuid NOT NULL,
    start_block_offset integer NOT NULL,
    end_block_offset integer NOT NULL,
    span_text text NOT NULL,
    selector jsonb NOT NULL,
    citation_label text NOT NULL,
    resolver_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_kind text NOT NULL,
    owner_id uuid NOT NULL,
    CONSTRAINT ck_evidence_spans_offsets CHECK (((start_block_id <> end_block_id) OR (end_block_offset >= start_block_offset))),
    CONSTRAINT ck_evidence_spans_owner_kind CHECK ((owner_kind = ANY (ARRAY['media'::text, 'note_block'::text]))),
    CONSTRAINT ck_evidence_spans_resolver CHECK ((resolver_kind = ANY (ARRAY['web'::text, 'epub'::text, 'pdf'::text, 'transcript'::text, 'note'::text]))),
    CONSTRAINT ck_evidence_spans_selector CHECK ((jsonb_typeof(selector) = 'object'::text)),
    CONSTRAINT ck_evidence_spans_start CHECK ((start_block_offset >= 0))
);


--
-- Name: extension_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.extension_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT ck_extension_sessions_token_hash_len CHECK ((char_length(token_hash) = 64))
);


--
-- Name: fragment_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fragment_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fragment_id uuid NOT NULL,
    block_idx integer NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    CONSTRAINT ck_fragment_blocks_block_idx CHECK ((block_idx >= 0)),
    CONSTRAINT ck_fragment_blocks_offsets CHECK ((end_offset >= start_offset)),
    CONSTRAINT ck_fragment_blocks_start_offset CHECK ((start_offset >= 0))
);


--
-- Name: fragments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fragments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    idx integer NOT NULL,
    canonical_text text NOT NULL,
    html_sanitized text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    canonical_text_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(canonical_text, ''::text))) STORED,
    t_start_ms bigint,
    t_end_ms bigint,
    speaker_label text,
    canonical_text_word_count integer GENERATED ALWAYS AS (regexp_count(canonical_text, '[^[:space:]]+'::text)) STORED NOT NULL,
    CONSTRAINT ck_fragments_time_offsets_paired_null CHECK ((((t_start_ms IS NULL) AND (t_end_ms IS NULL)) OR ((t_start_ms IS NOT NULL) AND (t_end_ms IS NOT NULL)))),
    CONSTRAINT ck_fragments_time_offsets_valid CHECK ((((t_start_ms IS NULL) OR (t_start_ms >= 0)) AND ((t_end_ms IS NULL) OR (t_end_ms >= 0)) AND ((t_start_ms IS NULL) OR (t_end_ms > t_start_ms))))
);


--
-- Name: highlight_fragment_anchors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.highlight_fragment_anchors (
    highlight_id uuid NOT NULL,
    fragment_id uuid NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    CONSTRAINT ck_hfa_offsets_valid CHECK (((start_offset >= 0) AND (end_offset > start_offset)))
);


--
-- Name: highlight_pdf_anchors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.highlight_pdf_anchors (
    highlight_id uuid NOT NULL,
    media_id uuid NOT NULL,
    page_number integer NOT NULL,
    sort_top numeric NOT NULL,
    sort_left numeric NOT NULL,
    plain_text_match_status text DEFAULT 'pending'::text NOT NULL,
    plain_text_start_offset integer,
    plain_text_end_offset integer,
    rect_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_hpa_match_offsets_non_negative CHECK ((((plain_text_start_offset IS NULL) OR (plain_text_start_offset >= 0)) AND ((plain_text_end_offset IS NULL) OR (plain_text_end_offset >= 0)))),
    CONSTRAINT ck_hpa_match_offsets_paired_null CHECK ((((plain_text_start_offset IS NULL) AND (plain_text_end_offset IS NULL)) OR ((plain_text_start_offset IS NOT NULL) AND (plain_text_end_offset IS NOT NULL)))),
    CONSTRAINT ck_hpa_match_status CHECK ((plain_text_match_status = ANY (ARRAY['pending'::text, 'unique'::text, 'ambiguous'::text, 'no_match'::text, 'empty_exact'::text]))),
    CONSTRAINT ck_hpa_page_number CHECK ((page_number >= 1)),
    CONSTRAINT ck_hpa_rect_count CHECK ((rect_count >= 1))
);


--
-- Name: highlight_pdf_quads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.highlight_pdf_quads (
    highlight_id uuid NOT NULL,
    quad_idx integer NOT NULL,
    x1 numeric NOT NULL,
    y1 numeric NOT NULL,
    x2 numeric NOT NULL,
    y2 numeric NOT NULL,
    x3 numeric NOT NULL,
    y3 numeric NOT NULL,
    x4 numeric NOT NULL,
    y4 numeric NOT NULL,
    CONSTRAINT ck_hpq_quad_idx CHECK ((quad_idx >= 0))
);


--
-- Name: highlight_pdf_text_anchors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.highlight_pdf_text_anchors (
    highlight_id uuid NOT NULL,
    media_id uuid NOT NULL,
    page_number integer NOT NULL,
    plain_text_start_offset integer NOT NULL,
    plain_text_end_offset integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_hpta_offsets_valid CHECK (((plain_text_start_offset >= 0) AND (plain_text_end_offset > plain_text_start_offset))),
    CONSTRAINT ck_hpta_page_number CHECK ((page_number >= 1))
);


--
-- Name: highlights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.highlights (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    color text NOT NULL,
    exact text NOT NULL,
    prefix text NOT NULL,
    suffix text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    anchor_kind text,
    anchor_media_id uuid,
    CONSTRAINT ck_highlights_anchor_fields_paired_null CHECK ((((anchor_kind IS NULL) AND (anchor_media_id IS NULL)) OR ((anchor_kind IS NOT NULL) AND (anchor_media_id IS NOT NULL)))),
    CONSTRAINT ck_highlights_anchor_kind_valid CHECK (((anchor_kind IS NULL) OR (anchor_kind = ANY (ARRAY['fragment_offsets'::text, 'pdf_page_geometry'::text, 'pdf_text_quote'::text])))),
    CONSTRAINT ck_highlights_color CHECK ((color = ANY (ARRAY['yellow'::text, 'green'::text, 'blue'::text, 'pink'::text, 'purple'::text])))
);


--
-- Name: libraries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.libraries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    system_key text,
    CONSTRAINT ck_libraries_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 100))),
    CONSTRAINT ck_libraries_system_key CHECK (((system_key IS NULL) OR ((char_length(system_key) >= 1) AND (char_length(system_key) <= 80))))
);


--
-- Name: library_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.library_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    library_id uuid NOT NULL,
    media_id uuid,
    podcast_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    CONSTRAINT ck_library_entries_exactly_one_target CHECK ((((media_id IS NOT NULL) AND (podcast_id IS NULL)) OR ((media_id IS NULL) AND (podcast_id IS NOT NULL)))),
    CONSTRAINT ck_library_entries_position_non_negative CHECK (("position" >= 0))
);


--
-- Name: library_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.library_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    library_id uuid NOT NULL,
    inviter_user_id uuid NOT NULL,
    invitee_user_id uuid NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    CONSTRAINT ck_library_invitations_not_self CHECK ((inviter_user_id <> invitee_user_id)),
    CONSTRAINT ck_library_invitations_responded_at CHECK ((((status = 'pending'::text) AND (responded_at IS NULL)) OR ((status <> 'pending'::text) AND (responded_at IS NOT NULL)))),
    CONSTRAINT ck_library_invitations_role CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text]))),
    CONSTRAINT ck_library_invitations_status CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'revoked'::text])))
);


--
-- Name: llm_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_kind text NOT NULL,
    owner_id uuid NOT NULL,
    generation_seq integer NOT NULL,
    generation_spec jsonb NOT NULL,
    generation_fingerprint text NOT NULL,
    outcome text,
    failure_code text,
    terminal jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: llm_model_turn_continuations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_model_turn_continuations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    generation_id uuid NOT NULL,
    source_model_turn_id uuid NOT NULL,
    successor_turn_seq integer NOT NULL,
    target_fingerprint text NOT NULL,
    codec_id text NOT NULL,
    policy_revision text NOT NULL,
    envelope_version text NOT NULL,
    nonce bytea NOT NULL,
    ciphertext bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: llm_model_turns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_model_turns (
    id uuid NOT NULL,
    generation_id uuid NOT NULL,
    turn_seq integer NOT NULL,
    request_fingerprint text NOT NULL,
    route_request_identity jsonb NOT NULL,
    terminal jsonb,
    usage jsonb,
    billability jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatch_started_at timestamp with time zone,
    accepted_at timestamp with time zone,
    completed_at timestamp with time zone
);


--
-- Name: llm_tool_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_tool_positions (
    id uuid NOT NULL,
    generation_id uuid NOT NULL,
    "position" integer NOT NULL,
    transport_kind text NOT NULL,
    model_turn_seq integer NOT NULL,
    transport_call_id text NOT NULL,
    canonical_tool_id text NOT NULL,
    canonical_input_digest text NOT NULL,
    tool_contract_revision text NOT NULL,
    plan_revision text NOT NULL,
    binding_revision text NOT NULL,
    scope_digest text NOT NULL,
    budget_digest text NOT NULL,
    reservation jsonb,
    dispatch_claim jsonb,
    abandoned_attempts integer NOT NULL,
    result_evidence jsonb,
    effect_identity jsonb,
    settlement jsonb,
    replay_status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    canonical_source_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    processing_status public.processing_status_enum DEFAULT 'pending'::public.processing_status_enum NOT NULL,
    failure_stage public.failure_stage_enum,
    last_error_code text,
    last_error_message text,
    processing_attempts integer DEFAULT 0 NOT NULL,
    processing_started_at timestamp with time zone,
    processing_completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    requested_url text,
    canonical_url text,
    external_playback_url text,
    provider text,
    provider_id text,
    created_by_user_id uuid,
    title_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(title, ''::text))) STORED,
    plain_text text,
    page_count integer,
    publisher text,
    language text,
    description text,
    metadata_enriched_at timestamp with time zone,
    authors_manually_managed boolean DEFAULT false NOT NULL,
    plain_text_word_count integer GENERATED ALWAYS AS (regexp_count(plain_text, '[^[:space:]]+'::text)) STORED,
    original_published_date text,
    edition_published_date text,
    edition_isbn text,
    CONSTRAINT ck_media_canonical_url_length CHECK (((canonical_url IS NULL) OR (char_length(canonical_url) <= 2048))),
    CONSTRAINT ck_media_kind CHECK ((kind = ANY (ARRAY['web_article'::text, 'epub'::text, 'pdf'::text, 'video'::text, 'podcast_episode'::text]))),
    CONSTRAINT ck_media_page_count_positive CHECK (((page_count IS NULL) OR (page_count >= 1))),
    CONSTRAINT ck_media_requested_url_length CHECK (((requested_url IS NULL) OR (char_length(requested_url) <= 2048)))
);


--
-- Name: media_atlas_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_atlas_positions (
    media_id uuid NOT NULL,
    x real NOT NULL,
    y real NOT NULL,
    projection_version integer DEFAULT 1 NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_media_atlas_positions_version_positive CHECK ((projection_version >= 1)),
    CONSTRAINT ck_media_atlas_positions_x_range CHECK (((x >= (0.0)::double precision) AND (x <= (1.0)::double precision))),
    CONSTRAINT ck_media_atlas_positions_y_range CHECK (((y >= (0.0)::double precision) AND (y <= (1.0)::double precision)))
);


--
-- Name: TABLE media_atlas_positions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.media_atlas_positions IS 'Persistent 2D position for each work in the grand atlas, produced by the atlas_project_job PCA projection. x/y in [0,1]; maps to celestial coords at render time (see grand-atlas-hard-cutover.md 4.2). Sole writer: services/atlas_projection.py.';


--
-- Name: media_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    summary_id uuid NOT NULL,
    claim_text text NOT NULL,
    evidence_span_id uuid NOT NULL,
    ordinal integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_media_claims_ordinal_non_negative CHECK ((ordinal >= 0))
);


--
-- Name: media_file; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_file (
    media_id uuid NOT NULL,
    storage_path text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    source_sha256 text NOT NULL
);


--
-- Name: media_processing_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_processing_events (
    id uuid NOT NULL,
    media_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    event_type text NOT NULL,
    stage text,
    failure_code text,
    payload jsonb NOT NULL
);


--
-- Name: media_source_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_source_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    created_by_user_id uuid,
    source_type text NOT NULL,
    attempt_no integer NOT NULL,
    run_count integer DEFAULT 0 NOT NULL,
    status text NOT NULL,
    intent_key text NOT NULL,
    idempotency_key text,
    requested_url text,
    canonical_source_url text,
    provider text,
    provider_target_ref text,
    source_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    request_id text,
    job_id uuid,
    error_code text,
    error_message text,
    retry_after_seconds integer,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    processing_stage text,
    progress_completed integer DEFAULT 0 NOT NULL,
    progress_total integer,
    progress_unit text,
    progress_updated_at timestamp with time zone,
    CONSTRAINT ck_media_source_attempts_attempt_no CHECK ((attempt_no >= 1)),
    CONSTRAINT ck_media_source_attempts_canonical_source_url_length CHECK (((canonical_source_url IS NULL) OR (char_length(canonical_source_url) <= 2048))),
    CONSTRAINT ck_media_source_attempts_idempotency_user CHECK (((idempotency_key IS NULL) OR (created_by_user_id IS NOT NULL))),
    CONSTRAINT ck_media_source_attempts_requested_url_length CHECK (((requested_url IS NULL) OR (char_length(requested_url) <= 2048))),
    CONSTRAINT ck_media_source_attempts_retry_after CHECK (((retry_after_seconds IS NULL) OR (retry_after_seconds >= 0))),
    CONSTRAINT ck_media_source_attempts_run_count CHECK ((run_count >= 0)),
    CONSTRAINT ck_media_source_attempts_source_payload CHECK ((jsonb_typeof(source_payload) = 'object'::text)),
    CONSTRAINT ck_media_source_attempts_source_type CHECK ((source_type = ANY (ARRAY['generic_web_url'::text, 'x_author_thread'::text, 'x_post'::text, 'youtube_video'::text, 'remote_pdf_url'::text, 'remote_epub_url'::text, 'uploaded_pdf_file'::text, 'uploaded_epub_file'::text, 'browser_article_capture'::text, 'browser_pdf_capture'::text, 'browser_epub_capture'::text, 'podcast_episode_transcript'::text, 'video_transcript'::text, 'email_message'::text]))),
    CONSTRAINT ck_media_source_attempts_status CHECK ((status = ANY (ARRAY['accepted'::text, 'queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: media_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_summaries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    content_fingerprint text NOT NULL,
    summary_md text NOT NULL,
    model_name text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    error_code text,
    error_detail text,
    CONSTRAINT ck_media_summaries_status CHECK ((status = ANY (ARRAY['building'::text, 'ready'::text, 'failed'::text])))
);


--
-- Name: media_teardown_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_teardown_intents (
    id uuid NOT NULL,
    media_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_transcript_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_transcript_states (
    media_id uuid NOT NULL,
    transcript_state text DEFAULT 'not_requested'::text NOT NULL,
    transcript_coverage text DEFAULT 'none'::text NOT NULL,
    semantic_status text DEFAULT 'none'::text NOT NULL,
    last_request_reason text,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    transcript_origin text,
    CONSTRAINT ck_media_transcript_states_coverage CHECK ((transcript_coverage = ANY (ARRAY['none'::text, 'partial'::text, 'full'::text]))),
    CONSTRAINT ck_media_transcript_states_last_request_reason CHECK (((last_request_reason IS NULL) OR (last_request_reason = ANY (ARRAY['episode_open'::text, 'search'::text, 'highlight'::text, 'quote'::text, 'background_warming'::text, 'operator_requeue'::text, 'rss_feed'::text])))),
    CONSTRAINT ck_media_transcript_states_semantic_status CHECK ((semantic_status = ANY (ARRAY['none'::text, 'pending'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT ck_media_transcript_states_state CHECK ((transcript_state = ANY (ARRAY['not_requested'::text, 'queued'::text, 'running'::text, 'ready'::text, 'partial'::text, 'unavailable'::text, 'failed_quota'::text, 'failed_provider'::text])))
);


--
-- Name: media_upload_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_upload_events (
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    event_type text NOT NULL,
    stage text,
    failure_code text,
    payload jsonb NOT NULL
);


--
-- Name: media_upload_session_destinations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_upload_session_destinations (
    upload_session_id uuid NOT NULL,
    library_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_upload_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_upload_sessions (
    id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    candidate_media_id uuid NOT NULL,
    kind text NOT NULL,
    filename text NOT NULL,
    content_type text NOT NULL,
    expected_size_bytes bigint NOT NULL,
    idempotency_key text NOT NULL,
    request_id text NOT NULL,
    upload_generation bigint NOT NULL,
    upload_url_expires_at timestamp with time zone NOT NULL,
    verification_token uuid,
    verification_generation bigint,
    verification_expires_at timestamp with time zone,
    transport_failure_kind text,
    transport_http_status integer,
    transport_failed_at timestamp with time zone,
    verification_error_code text,
    verification_failed_at timestamp with time zone,
    published_media_id uuid,
    published_source_attempt_id uuid,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    library_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_memberships_role CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);


--
-- Name: message_retrievals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_retrievals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tool_call_id uuid NOT NULL,
    ordinal integer NOT NULL,
    result_type text NOT NULL,
    source_id text NOT NULL,
    media_id uuid,
    context_ref jsonb NOT NULL,
    result_ref jsonb NOT NULL,
    deep_link text,
    score double precision,
    selected boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    scope text DEFAULT 'all'::text NOT NULL,
    source_title text,
    section_label text,
    exact_snippet text,
    snippet_prefix text,
    snippet_suffix text,
    locator jsonb,
    retrieval_status text DEFAULT 'retrieved'::text NOT NULL,
    included_in_prompt boolean DEFAULT false NOT NULL,
    evidence_span_id uuid,
    cited_edge_id uuid,
    citation_candidate_ordinal integer,
    CONSTRAINT ck_message_retrievals_context_ref_object CHECK ((jsonb_typeof(context_ref) = 'object'::text)),
    CONSTRAINT ck_message_retrievals_locator_object CHECK (((locator IS NULL) OR (locator = 'null'::jsonb) OR (jsonb_typeof(locator) = 'object'::text))),
    CONSTRAINT ck_message_retrievals_ordinal_non_negative CHECK ((ordinal >= 0)),
    CONSTRAINT ck_message_retrievals_result_ref_object CHECK ((jsonb_typeof(result_ref) = 'object'::text)),
    CONSTRAINT ck_message_retrievals_result_type CHECK ((result_type = ANY (ARRAY['page'::text, 'note_block'::text, 'highlight'::text, 'media'::text, 'podcast'::text, 'episode'::text, 'video'::text, 'content_chunk'::text, 'fragment'::text, 'message'::text, 'contributor'::text, 'evidence_span'::text, 'conversation'::text, 'web_result'::text, 'reader_apparatus_item'::text]))),
    CONSTRAINT ck_message_retrievals_scope_length CHECK (((char_length(scope) >= 1) AND (char_length(scope) <= 256))),
    CONSTRAINT ck_message_retrievals_score_non_negative CHECK (((score IS NULL) OR (score >= (0)::double precision))),
    CONSTRAINT ck_message_retrievals_source_id_length CHECK (((char_length(source_id) >= 1) AND (char_length(source_id) <= 128))),
    CONSTRAINT ck_message_retrievals_status CHECK ((retrieval_status = ANY (ARRAY['attached_context'::text, 'retrieved'::text, 'selected'::text, 'included_in_prompt'::text, 'excluded_by_budget'::text, 'excluded_by_scope'::text, 'web_result'::text]))),
    CONSTRAINT ck_message_retrievals_web_source_snapshot_uuid CHECK (((result_type <> 'web_result'::text) OR (source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)))
);


--
-- Name: message_tool_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_tool_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    user_message_id uuid NOT NULL,
    assistant_message_id uuid NOT NULL,
    canonical_tool_id text,
    tool_call_index integer NOT NULL,
    search_query_fingerprint text,
    scope text DEFAULT 'all'::text NOT NULL,
    requested_types jsonb DEFAULT '[]'::jsonb NOT NULL,
    result_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    selected_context_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    provider_request_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    latency_ms integer,
    status text DEFAULT 'pending'::text NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reverted_at timestamp with time zone,
    record_kind text NOT NULL,
    provider_wire_name text,
    canonical_input_sha256 text,
    tool_contract_revision text,
    binding_policy_revision text,
    tool_position_id uuid,
    CONSTRAINT ck_message_tool_calls_canonical_tool_id_length CHECK (((char_length(canonical_tool_id) >= 1) AND (char_length(canonical_tool_id) <= 128))),
    CONSTRAINT ck_message_tool_calls_index_non_negative CHECK ((tool_call_index >= 0)),
    CONSTRAINT ck_message_tool_calls_latency_non_negative CHECK (((latency_ms IS NULL) OR (latency_ms >= 0))),
    CONSTRAINT ck_message_tool_calls_provider_request_ids_array CHECK ((jsonb_typeof(provider_request_ids) = 'array'::text)),
    CONSTRAINT ck_message_tool_calls_provider_wire_name_length CHECK (((provider_wire_name IS NULL) OR ((char_length(provider_wire_name) >= 1) AND (char_length(provider_wire_name) <= 128)))),
    CONSTRAINT ck_message_tool_calls_record_kind CHECK ((record_kind = ANY (ARRAY['attached_context'::text, 'current_execution'::text, 'historical_execution'::text]))),
    CONSTRAINT ck_message_tool_calls_requested_types_array CHECK ((jsonb_typeof(requested_types) = 'array'::text)),
    CONSTRAINT ck_message_tool_calls_result_refs_array CHECK ((jsonb_typeof(result_refs) = 'array'::text)),
    CONSTRAINT ck_message_tool_calls_scope_length CHECK (((char_length(scope) >= 1) AND (char_length(scope) <= 256))),
    CONSTRAINT ck_message_tool_calls_search_query_fingerprint_length CHECK (((search_query_fingerprint IS NULL) OR ((char_length(search_query_fingerprint) >= 1) AND (char_length(search_query_fingerprint) <= 128)))),
    CONSTRAINT ck_message_tool_calls_selected_context_refs_array CHECK ((jsonb_typeof(selected_context_refs) = 'array'::text)),
    CONSTRAINT ck_message_tool_calls_status CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'complete'::text, 'error'::text, 'cancelled'::text])))
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    seq integer NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    status text DEFAULT 'complete'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(content, ''::text))) STORED,
    context_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    parent_message_id uuid,
    branch_root_message_id uuid,
    branch_anchor_kind text DEFAULT 'none'::text NOT NULL,
    branch_anchor jsonb DEFAULT '{}'::jsonb NOT NULL,
    message_document jsonb DEFAULT '{"type": "message_document", "blocks": []}'::jsonb NOT NULL,
    reader_selection_snapshot jsonb,
    CONSTRAINT ck_messages_branch_anchor_kind CHECK ((branch_anchor_kind = ANY (ARRAY['none'::text, 'assistant_message'::text, 'assistant_selection'::text]))),
    CONSTRAINT ck_messages_branch_anchor_object CHECK ((jsonb_typeof(branch_anchor) = 'object'::text)),
    CONSTRAINT ck_messages_message_document_object CHECK ((jsonb_typeof(message_document) = 'object'::text)),
    CONSTRAINT ck_messages_parent_role_shape CHECK ((((role = 'user'::text) AND (parent_message_id IS NULL)) OR (parent_message_id IS NOT NULL))),
    CONSTRAINT ck_messages_pending_only_assistant CHECK (((status <> 'pending'::text) OR (role = 'assistant'::text))),
    CONSTRAINT ck_messages_reader_selection_snapshot_object CHECK (((reader_selection_snapshot IS NULL) OR (jsonb_typeof(reader_selection_snapshot) = 'object'::text))),
    CONSTRAINT ck_messages_role CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text]))),
    CONSTRAINT ck_messages_seq_positive CHECK ((seq >= 1)),
    CONSTRAINT ck_messages_status CHECK ((status = ANY (ARRAY['pending'::text, 'complete'::text, 'error'::text, 'cancelled'::text])))
);


--
-- Name: nexus_usages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nexus_usages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    query_normalized text NOT NULL,
    target_href text NOT NULL,
    label_snapshot text NOT NULL,
    source text NOT NULL,
    use_count integer DEFAULT 1 NOT NULL,
    visit_timestamps jsonb NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_nexus_usages_use_count CHECK ((use_count >= 1))
);


--
-- Name: note_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.note_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    body_pm_json jsonb NOT NULL,
    body_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_note_blocks_pm_json_object CHECK ((jsonb_typeof(body_pm_json) = 'object'::text))
);


--
-- Name: oracle_corpus_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oracle_corpus_publications (
    corpus_key text NOT NULL,
    manifest_digest text NOT NULL,
    embedding_provider text NOT NULL,
    embedding_model text NOT NULL
);


--
-- Name: oracle_corpus_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oracle_corpus_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    corpus_key text DEFAULT 'oracle'::text NOT NULL,
    work_key text NOT NULL,
    library_id uuid NOT NULL,
    media_id uuid NOT NULL,
    title text NOT NULL,
    author_text text NOT NULL,
    source_repository text NOT NULL,
    source_url text NOT NULL,
    source_download_url text NOT NULL,
    source_media_kind text NOT NULL,
    display_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_oracle_corpus_sources_key CHECK (((char_length(work_key) >= 1) AND (char_length(work_key) <= 160))),
    CONSTRAINT ck_oracle_corpus_sources_kind CHECK ((source_media_kind = ANY (ARRAY['epub'::text, 'web_article'::text, 'pdf'::text])))
);


--
-- Name: oracle_passage_anchors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oracle_passage_anchors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    corpus_source_id uuid NOT NULL,
    passage_key text NOT NULL,
    display_label text NOT NULL,
    selector jsonb NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    phase_hints jsonb DEFAULT '[]'::jsonb NOT NULL,
    current_evidence_span_id uuid,
    current_content_chunk_id uuid,
    resolution_status text DEFAULT 'pending'::text NOT NULL,
    resolution_error text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_oracle_passage_anchors_phase_hints CHECK ((jsonb_typeof(phase_hints) = 'array'::text)),
    CONSTRAINT ck_oracle_passage_anchors_resolution_state CHECK ((((resolution_status = 'pending'::text) AND (current_evidence_span_id IS NULL) AND (current_content_chunk_id IS NULL) AND (resolved_at IS NULL) AND (resolution_error IS NULL)) OR ((resolution_status = 'resolved'::text) AND (current_content_chunk_id IS NOT NULL) AND (resolved_at IS NOT NULL) AND (resolution_error IS NULL)) OR ((resolution_status = 'failed'::text) AND (current_evidence_span_id IS NULL) AND (current_content_chunk_id IS NULL) AND (resolved_at IS NULL) AND (resolution_error IS NOT NULL)))),
    CONSTRAINT ck_oracle_passage_anchors_selector CHECK ((jsonb_typeof(selector) = 'object'::text)),
    CONSTRAINT ck_oracle_passage_anchors_status CHECK ((resolution_status = ANY (ARRAY['pending'::text, 'resolved'::text, 'failed'::text]))),
    CONSTRAINT ck_oracle_passage_anchors_tags CHECK ((jsonb_typeof(tags) = 'array'::text))
);


--
-- Name: oracle_plates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oracle_plates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_repository text NOT NULL,
    source_page_url text,
    source_url text NOT NULL,
    license_text text,
    artist text NOT NULL,
    work_title text NOT NULL,
    year text,
    attribution_text text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    storage_key text NOT NULL,
    content_type text NOT NULL,
    byte_size bigint NOT NULL,
    CONSTRAINT ck_oracle_plates_byte_size_positive CHECK ((byte_size > 0)),
    CONSTRAINT ck_oracle_plates_byte_size_safe CHECK ((byte_size <= 10485760)),
    CONSTRAINT ck_oracle_plates_content_type CHECK ((content_type = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text]))),
    CONSTRAINT ck_oracle_plates_height_positive CHECK ((height > 0)),
    CONSTRAINT ck_oracle_plates_height_safe CHECK ((height <= 4096)),
    CONSTRAINT ck_oracle_plates_storage_key_content_type_match CHECK ((((content_type = 'image/jpeg'::text) AND (storage_key ~~ '%.jpg'::text)) OR ((content_type = 'image/png'::text) AND (storage_key ~~ '%.png'::text)) OR ((content_type = 'image/webp'::text) AND (storage_key ~~ '%.webp'::text)))),
    CONSTRAINT ck_oracle_plates_storage_key_shape CHECK ((storage_key ~ '^oracle/plates/[a-z0-9][a-z0-9._-]{0,191}\.(jpg|png|webp)$'::text)),
    CONSTRAINT ck_oracle_plates_tags_array CHECK ((jsonb_typeof(tags) = 'array'::text)),
    CONSTRAINT ck_oracle_plates_width_positive CHECK ((width > 0)),
    CONSTRAINT ck_oracle_plates_width_safe CHECK ((width <= 4096))
);


--
-- Name: oracle_reading_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oracle_reading_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reading_id uuid NOT NULL,
    seq integer NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_oracle_reading_events_seq_positive CHECK ((seq >= 1)),
    CONSTRAINT ck_oracle_reading_events_type CHECK ((event_type = ANY (ARRAY['meta'::text, 'bind'::text, 'argument'::text, 'plate'::text, 'passage'::text, 'delta'::text, 'omens'::text, 'done'::text])))
);


--
-- Name: oracle_reading_folios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oracle_reading_folios (
    reading_id uuid NOT NULL,
    phase text NOT NULL,
    edge_id uuid NOT NULL,
    source_kind text NOT NULL,
    locator_label text NOT NULL,
    attribution_text text NOT NULL,
    marginalia_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_oracle_reading_folios_phase CHECK ((phase = ANY (ARRAY['descent'::text, 'ordeal'::text, 'ascent'::text]))),
    CONSTRAINT ck_oracle_reading_folios_source_kind CHECK ((source_kind = ANY (ARRAY['user_media'::text, 'public_domain'::text])))
);


--
-- Name: oracle_readings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oracle_readings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    folio_number integer NOT NULL,
    argument_text text,
    question_text text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    image_id uuid,
    error_code text,
    error_detail text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    folio_motto text,
    folio_motto_gloss text,
    folio_theme text,
    interpretation_text text,
    idempotency_key text,
    CONSTRAINT ck_oracle_readings_complete_has_timestamp CHECK ((((status = 'complete'::text) AND (completed_at IS NOT NULL)) OR (status <> 'complete'::text))),
    CONSTRAINT ck_oracle_readings_failed_has_error CHECK ((((status = 'failed'::text) AND (failed_at IS NOT NULL) AND (error_code IS NOT NULL)) OR (status <> 'failed'::text))),
    CONSTRAINT ck_oracle_readings_folio_positive CHECK ((folio_number > 0)),
    CONSTRAINT ck_oracle_readings_motto_gloss_length CHECK (((folio_motto_gloss IS NULL) OR ((char_length(folio_motto_gloss) >= 1) AND (char_length(folio_motto_gloss) <= 120)))),
    CONSTRAINT ck_oracle_readings_motto_length CHECK (((folio_motto IS NULL) OR ((char_length(folio_motto) >= 1) AND (char_length(folio_motto) <= 80)))),
    CONSTRAINT ck_oracle_readings_question_length CHECK (((char_length(btrim(question_text)) >= 1) AND (char_length(btrim(question_text)) <= 280))),
    CONSTRAINT ck_oracle_readings_status CHECK ((status = ANY (ARRAY['pending'::text, 'streaming'::text, 'complete'::text, 'failed'::text]))),
    CONSTRAINT ck_oracle_readings_theme CHECK (((folio_theme IS NULL) OR (folio_theme = ANY (ARRAY['Of Time'::text, 'Of Death'::text, 'Of the Threshold'::text, 'Of Vanity'::text, 'Of Solitude'::text, 'Of Love'::text, 'Of Fortune'::text, 'Of Memory'::text, 'Of the Self'::text, 'Of the Other'::text, 'Of Fear'::text, 'Of Courage'::text, 'Of Faith'::text, 'Of Doubt'::text, 'Of Power'::text, 'Of Wisdom'::text, 'Of the Body'::text, 'Of the Soul'::text, 'Of Origins'::text, 'Of Endings'::text, 'Of Silence'::text, 'Of the Word'::text, 'Of Justice'::text, 'Of Mercy'::text]))))
);


--
-- Name: pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_pages_title_length CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200)))
);


--
-- Name: passage_anchors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.passage_anchors (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    owner_scheme text NOT NULL,
    owner_id uuid NOT NULL,
    anchor_key text NOT NULL,
    selector jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pdf_page_text_spans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdf_page_text_spans (
    media_id uuid NOT NULL,
    page_number integer NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    page_label text,
    page_width double precision,
    page_height double precision,
    page_rotation_degrees integer,
    CONSTRAINT ck_ppts_offsets_valid CHECK ((end_offset >= start_offset)),
    CONSTRAINT ck_ppts_page_height CHECK (((page_height IS NULL) OR (page_height > (0)::double precision))),
    CONSTRAINT ck_ppts_page_number CHECK ((page_number >= 1)),
    CONSTRAINT ck_ppts_page_rotation CHECK (((page_rotation_degrees IS NULL) OR (page_rotation_degrees >= 0))),
    CONSTRAINT ck_ppts_page_width CHECK (((page_width IS NULL) OR (page_width > (0)::double precision))),
    CONSTRAINT ck_ppts_start_offset CHECK ((start_offset >= 0))
);


--
-- Name: podcast_episode_chapters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcast_episode_chapters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    chapter_idx integer NOT NULL,
    title text NOT NULL,
    t_start_ms integer NOT NULL,
    t_end_ms integer,
    url text,
    image_url text,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_podcast_episode_chapters_end_not_before_start CHECK (((t_end_ms IS NULL) OR (t_end_ms >= t_start_ms))),
    CONSTRAINT ck_podcast_episode_chapters_idx_non_negative CHECK ((chapter_idx >= 0)),
    CONSTRAINT ck_podcast_episode_chapters_source CHECK ((source = ANY (ARRAY['rss_podcasting20'::text, 'rss_podlove'::text, 'embedded_mp4'::text, 'embedded_id3'::text]))),
    CONSTRAINT ck_podcast_episode_chapters_start_non_negative CHECK ((t_start_ms >= 0))
);


--
-- Name: podcast_episode_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcast_episode_identities (
    id uuid NOT NULL,
    podcast_id uuid NOT NULL,
    scheme text NOT NULL,
    value text NOT NULL,
    episode_media_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: podcast_episodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcast_episodes (
    media_id uuid NOT NULL,
    podcast_id uuid NOT NULL,
    published_at timestamp with time zone,
    duration_seconds integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    description_html text,
    description_text text,
    rss_transcript_url text,
    CONSTRAINT ck_podcast_episodes_duration_positive CHECK (((duration_seconds IS NULL) OR (duration_seconds > 0)))
);


--
-- Name: podcast_listening_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcast_listening_states (
    user_id uuid NOT NULL,
    media_id uuid NOT NULL,
    position_ms integer DEFAULT 0 NOT NULL,
    duration_ms integer,
    playback_speed double precision,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_completed boolean DEFAULT false NOT NULL,
    write_revision integer DEFAULT 0 NOT NULL,
    reset_epoch integer DEFAULT 0 NOT NULL,
    last_engaged_at timestamp with time zone,
    CONSTRAINT ck_podcast_listening_states_duration_ms_non_negative CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT ck_podcast_listening_states_position_ms_non_negative CHECK ((position_ms >= 0))
);


--
-- Name: podcast_refresh_run_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcast_refresh_run_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    podcast_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    sync_generation bigint NOT NULL,
    status text NOT NULL,
    new_episode_count integer NOT NULL,
    error_code text,
    error_message text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: podcast_refresh_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcast_refresh_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    idempotency_key text,
    request_hash text,
    scope jsonb NOT NULL,
    status text NOT NULL,
    requested_count integer NOT NULL,
    finished_count integer NOT NULL,
    succeeded_count integer NOT NULL,
    source_limited_count integer NOT NULL,
    failed_count integer NOT NULL,
    skipped_count integer NOT NULL,
    new_episode_count integer NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: podcast_subscription_backfills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcast_subscription_backfills (
    id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    cutoff_at timestamp with time zone NOT NULL,
    step_no bigint NOT NULL,
    cursor jsonb,
    processed_count bigint NOT NULL,
    added_count bigint NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    source_limited_at timestamp with time zone,
    failed_at timestamp with time zone,
    error_code text,
    error_detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: podcast_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcast_subscriptions (
    user_id uuid NOT NULL,
    podcast_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sync_status text DEFAULT 'Pending'::text NOT NULL,
    sync_error_code text,
    sync_error_message text,
    sync_attempts integer DEFAULT 0 NOT NULL,
    sync_started_at timestamp with time zone,
    sync_completed_at timestamp with time zone,
    last_checked_at timestamp with time zone,
    auto_queue boolean DEFAULT false NOT NULL,
    default_playback_speed double precision,
    auto_queue_watermark_at timestamp with time zone,
    id uuid NOT NULL,
    sync_generation bigint DEFAULT '0'::bigint NOT NULL,
    next_sync_at timestamp with time zone NOT NULL,
    consecutive_sync_failures integer DEFAULT 0 NOT NULL,
    sync_job_id uuid,
    sync_job_attempt_no integer,
    sync_checkpoint_status text,
    sync_checkpoint_cutoff_at timestamp with time zone,
    sync_checkpoint_new_episode_count integer,
    sync_checkpoint_completed_at timestamp with time zone,
    pause_shortening_mode text,
    CONSTRAINT ck_podcast_subscriptions_sync_attempts_non_negative CHECK ((sync_attempts >= 0))
);


--
-- Name: podcast_transcript_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcast_transcript_segments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    segment_idx integer NOT NULL,
    canonical_text text NOT NULL,
    t_start_ms bigint NOT NULL,
    t_end_ms bigint NOT NULL,
    speaker_label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_podcast_transcript_segments_segment_idx_non_negative CHECK ((segment_idx >= 0)),
    CONSTRAINT ck_podcast_transcript_segments_time_offsets_valid CHECK (((t_start_ms >= 0) AND (t_end_ms > t_start_ms)))
);


--
-- Name: podcast_transcription_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcast_transcription_jobs (
    media_id uuid NOT NULL,
    requested_by_user_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    request_reason text DEFAULT 'episode_open'::text NOT NULL,
    reserved_minutes integer DEFAULT 0 NOT NULL,
    reservation_usage_date date,
    CONSTRAINT ck_podcast_transcription_jobs_attempts_non_negative CHECK ((attempts >= 0)),
    CONSTRAINT ck_podcast_transcription_jobs_request_reason CHECK ((request_reason = ANY (ARRAY['episode_open'::text, 'search'::text, 'highlight'::text, 'quote'::text, 'background_warming'::text, 'operator_requeue'::text, 'rss_feed'::text]))),
    CONSTRAINT ck_podcast_transcription_jobs_reserved_minutes_non_negative CHECK ((reserved_minutes >= 0)),
    CONSTRAINT ck_podcast_transcription_jobs_status CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: podcast_transcription_usage_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcast_transcription_usage_daily (
    user_id uuid NOT NULL,
    usage_date date NOT NULL,
    minutes_used integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    minutes_reserved integer DEFAULT 0 NOT NULL,
    CONSTRAINT ck_podcast_transcription_usage_daily_non_negative CHECK (((minutes_used >= 0) AND (minutes_reserved >= 0)))
);


--
-- Name: podcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.podcasts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    provider_podcast_id text NOT NULL,
    title text NOT NULL,
    feed_url text NOT NULL,
    website_url text,
    image_url text,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_gutenberg_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_gutenberg_catalog (
    ebook_id bigint NOT NULL,
    title text NOT NULL,
    gutenberg_type text,
    issued date,
    language text,
    subjects text,
    locc text,
    bookshelves text,
    copyright_status text,
    download_count integer,
    raw_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_project_gutenberg_catalog_ebook_id_positive CHECK ((ebook_id > 0))
);


--
-- Name: project_gutenberg_catalog_ebook_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.project_gutenberg_catalog_ebook_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_gutenberg_catalog_ebook_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.project_gutenberg_catalog_ebook_id_seq OWNED BY public.project_gutenberg_catalog.ebook_id;


--
-- Name: rate_limit_request_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_request_log (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: rate_limit_request_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rate_limit_request_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rate_limit_request_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rate_limit_request_log_id_seq OWNED BY public.rate_limit_request_log.id;


--
-- Name: reader_apparatus_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reader_apparatus_edges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    state_id uuid NOT NULL,
    stable_key text NOT NULL,
    from_item_id uuid NOT NULL,
    to_item_id uuid NOT NULL,
    relation text NOT NULL,
    confidence text NOT NULL,
    extraction_method text NOT NULL,
    source_ref jsonb NOT NULL,
    sort_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_reader_apparatus_edges_confidence CHECK ((confidence = ANY (ARRAY['exact'::text, 'strong'::text, 'probable'::text]))),
    CONSTRAINT ck_reader_apparatus_edges_not_self CHECK ((from_item_id <> to_item_id)),
    CONSTRAINT ck_reader_apparatus_edges_relation CHECK ((relation = ANY (ARRAY['points_to_note'::text, 'points_to_endnote'::text, 'points_to_sidenote'::text, 'points_to_margin_note'::text, 'cites_bibliography_entry'::text, 'backlink_to_marker'::text, 'contains_reference'::text]))),
    CONSTRAINT ck_reader_apparatus_edges_source_ref CHECK ((jsonb_typeof(source_ref) = 'object'::text))
);


--
-- Name: reader_apparatus_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reader_apparatus_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    state_id uuid NOT NULL,
    stable_key text NOT NULL,
    kind text NOT NULL,
    label text,
    body_text text,
    locator jsonb,
    locator_status text NOT NULL,
    confidence text NOT NULL,
    extraction_method text NOT NULL,
    source_ref jsonb NOT NULL,
    sort_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_reader_apparatus_items_confidence CHECK ((confidence = ANY (ARRAY['exact'::text, 'strong'::text, 'probable'::text]))),
    CONSTRAINT ck_reader_apparatus_items_kind CHECK ((kind = ANY (ARRAY['footnote_ref'::text, 'endnote_ref'::text, 'bibliography_ref'::text, 'sidenote_ref'::text, 'margin_note_ref'::text, 'footnote'::text, 'endnote'::text, 'bibliography_entry'::text, 'sidenote'::text, 'margin_note'::text, 'reference_section'::text]))),
    CONSTRAINT ck_reader_apparatus_items_locator CHECK (((locator IS NULL) OR (jsonb_typeof(locator) = 'object'::text))),
    CONSTRAINT ck_reader_apparatus_items_locator_status CHECK ((locator_status = ANY (ARRAY['exact'::text, 'container'::text, 'missing'::text]))),
    CONSTRAINT ck_reader_apparatus_items_source_ref CHECK ((jsonb_typeof(source_ref) = 'object'::text))
);


--
-- Name: reader_apparatus_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reader_apparatus_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    media_kind text NOT NULL,
    source_fingerprint text NOT NULL,
    status text NOT NULL,
    item_count integer NOT NULL,
    edge_count integer NOT NULL,
    diagnostics jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_reader_apparatus_states_diagnostics CHECK ((jsonb_typeof(diagnostics) = 'object'::text)),
    CONSTRAINT ck_reader_apparatus_states_edge_count CHECK ((edge_count >= 0)),
    CONSTRAINT ck_reader_apparatus_states_item_count CHECK ((item_count >= 0)),
    CONSTRAINT ck_reader_apparatus_states_status CHECK ((status = ANY (ARRAY['ready'::text, 'empty'::text, 'partial'::text, 'unsupported'::text, 'failed'::text]))),
    CONSTRAINT ck_reader_apparatus_states_status_counts CHECK ((((status = ANY (ARRAY['ready'::text, 'partial'::text])) AND (item_count > 0)) OR ((status = ANY (ARRAY['empty'::text, 'unsupported'::text, 'failed'::text])) AND (item_count = 0) AND (edge_count = 0))))
);


--
-- Name: reader_engagement_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reader_engagement_states (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    media_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_engaged_at timestamp with time zone NOT NULL,
    max_total_progression real,
    CONSTRAINT ck_reader_engagement_states_max_total_progression CHECK (((max_total_progression IS NULL) OR ((max_total_progression >= (0.0)::double precision) AND (max_total_progression <= (1.0)::double precision))))
);


--
-- Name: reader_media_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reader_media_state (
    user_id uuid NOT NULL,
    media_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    locator jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL
);


--
-- Name: reader_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reader_profiles (
    user_id uuid NOT NULL,
    theme text NOT NULL,
    font_size_px integer NOT NULL,
    line_height numeric(3,2) NOT NULL,
    font_family text NOT NULL,
    column_width_ch integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    focus_mode text NOT NULL,
    hyphenation text NOT NULL,
    CONSTRAINT ck_reader_profiles_column_width_ch CHECK (((column_width_ch >= 40) AND (column_width_ch <= 120))),
    CONSTRAINT ck_reader_profiles_focus_mode CHECK ((focus_mode = ANY (ARRAY['off'::text, 'distraction_free'::text, 'paragraph'::text, 'sentence'::text]))),
    CONSTRAINT ck_reader_profiles_font_family CHECK ((font_family = ANY (ARRAY['serif'::text, 'sans'::text]))),
    CONSTRAINT ck_reader_profiles_font_size_px CHECK (((font_size_px >= 12) AND (font_size_px <= 28))),
    CONSTRAINT ck_reader_profiles_hyphenation CHECK ((hyphenation = ANY (ARRAY['auto'::text, 'off'::text]))),
    CONSTRAINT ck_reader_profiles_line_height CHECK (((line_height >= 1.2) AND (line_height <= 2.2))),
    CONSTRAINT ck_reader_profiles_theme CHECK ((theme = ANY (ARRAY['light'::text, 'dark'::text])))
);


--
-- Name: reader_publications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reader_publications (
    id uuid NOT NULL,
    media_id uuid NOT NULL,
    generation bigint NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: resource_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_edges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    origin text NOT NULL,
    source_scheme text NOT NULL,
    source_id uuid NOT NULL,
    target_scheme text NOT NULL,
    target_id uuid NOT NULL,
    ordinal integer,
    snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_order_key text,
    target_order_key text,
    CONSTRAINT ck_resource_edges_assistant_shape CHECK (((origin <> 'assistant'::text) OR ((source_scheme = ANY (ARRAY['media'::text, 'page'::text, 'note_block'::text, 'highlight'::text])) AND (target_scheme = ANY (ARRAY['media'::text, 'page'::text, 'note_block'::text, 'highlight'::text])) AND (source_order_key IS NULL) AND (target_order_key IS NULL) AND (ordinal IS NULL)))),
    CONSTRAINT ck_resource_edges_assistant_snapshot_excerpt CHECK (((origin <> 'assistant'::text) OR ((snapshot IS NOT NULL) AND (snapshot ? 'excerpt'::text) AND (jsonb_typeof((snapshot -> 'excerpt'::text)) = 'string'::text) AND (btrim((snapshot ->> 'excerpt'::text)) <> ''::text)))),
    CONSTRAINT ck_resource_edges_citation_has_snapshot CHECK (((ordinal IS NULL) OR (snapshot IS NOT NULL))),
    CONSTRAINT ck_resource_edges_citation_no_order CHECK (((ordinal IS NULL) OR ((source_order_key IS NULL) AND (target_order_key IS NULL)))),
    CONSTRAINT ck_resource_edges_citation_shape CHECK (((origin <> 'citation'::text) OR ((ordinal IS NULL) AND (kind = 'context'::text) AND (source_scheme = 'conversation'::text) AND (snapshot IS NULL)) OR ((ordinal IS NOT NULL) AND (source_scheme = ANY (ARRAY['message'::text, 'oracle_reading'::text, 'artifact_revision'::text]))))),
    CONSTRAINT ck_resource_edges_highlight_note_shape CHECK (((origin <> 'highlight_note'::text) OR ((kind = 'context'::text) AND (source_scheme = 'highlight'::text) AND (target_scheme = 'note_block'::text) AND (source_order_key IS NULL) AND (target_order_key IS NULL) AND (ordinal IS NULL) AND (snapshot IS NULL)))),
    CONSTRAINT ck_resource_edges_kind CHECK ((kind = ANY (ARRAY['context'::text, 'supports'::text, 'contradicts'::text]))),
    CONSTRAINT ck_resource_edges_no_self_edge CHECK ((NOT ((source_scheme = target_scheme) AND (source_id = target_id)))),
    CONSTRAINT ck_resource_edges_note_body_shape CHECK (((origin <> 'note_body'::text) OR ((kind = 'context'::text) AND (source_scheme = 'note_block'::text) AND (source_order_key IS NULL) AND (target_order_key IS NULL) AND (ordinal IS NULL) AND (snapshot IS NULL)))),
    CONSTRAINT ck_resource_edges_ordinal_origin CHECK (((ordinal IS NULL) OR (origin = 'citation'::text))),
    CONSTRAINT ck_resource_edges_ordinal_positive CHECK ((ordinal >= 1)),
    CONSTRAINT ck_resource_edges_origin CHECK ((origin = ANY (ARRAY['user'::text, 'citation'::text, 'system'::text, 'note_body'::text, 'highlight_note'::text, 'synapse'::text, 'document_embed'::text, 'assistant'::text, 'link_note'::text]))),
    CONSTRAINT ck_resource_edges_snapshot_has_ordinal CHECK (((snapshot IS NULL) OR (ordinal IS NOT NULL) OR (origin = ANY (ARRAY['synapse'::text, 'assistant'::text])))),
    CONSTRAINT ck_resource_edges_snapshot_object CHECK (((snapshot IS NULL) OR (jsonb_typeof(snapshot) = 'object'::text))),
    CONSTRAINT ck_resource_edges_snapshot_origin CHECK (((snapshot IS NULL) OR (origin = ANY (ARRAY['citation'::text, 'synapse'::text, 'assistant'::text])))),
    CONSTRAINT ck_resource_edges_source_order_key_length CHECK (((source_order_key IS NULL) OR ((char_length(source_order_key) >= 1) AND (char_length(source_order_key) <= 64)))),
    CONSTRAINT ck_resource_edges_source_order_key_shape CHECK (((source_order_key IS NULL) OR ((kind = 'context'::text) AND (origin = 'user'::text) AND (ordinal IS NULL) AND (snapshot IS NULL)) OR ((kind = 'context'::text) AND (origin = ANY (ARRAY['citation'::text, 'system'::text])) AND (source_scheme = 'conversation'::text) AND (ordinal IS NULL) AND (snapshot IS NULL)))),
    CONSTRAINT ck_resource_edges_source_scheme CHECK ((source_scheme = ANY (ARRAY['media'::text, 'library'::text, 'evidence_span'::text, 'content_chunk'::text, 'highlight'::text, 'page'::text, 'note_block'::text, 'fragment'::text, 'conversation'::text, 'message'::text, 'oracle_reading'::text, 'oracle_passage_anchor'::text, 'artifact'::text, 'artifact_revision'::text, 'external_snapshot'::text, 'contributor'::text, 'podcast'::text, 'reader_apparatus_item'::text, 'passage_anchor'::text]))),
    CONSTRAINT ck_resource_edges_synapse_shape CHECK (((origin <> 'synapse'::text) OR ((source_scheme = ANY (ARRAY['media'::text, 'page'::text, 'note_block'::text, 'highlight'::text])) AND (target_scheme = ANY (ARRAY['media'::text, 'note_block'::text, 'evidence_span'::text])) AND (source_order_key IS NULL) AND (target_order_key IS NULL) AND (ordinal IS NULL)))),
    CONSTRAINT ck_resource_edges_synapse_snapshot_excerpt CHECK (((origin <> 'synapse'::text) OR ((snapshot IS NOT NULL) AND (snapshot ? 'excerpt'::text) AND (jsonb_typeof((snapshot -> 'excerpt'::text)) = 'string'::text) AND (btrim((snapshot ->> 'excerpt'::text)) <> ''::text)))),
    CONSTRAINT ck_resource_edges_system_shape CHECK (((origin <> 'system'::text) OR ((kind = 'context'::text) AND (source_scheme = 'conversation'::text) AND (ordinal IS NULL) AND (snapshot IS NULL)))),
    CONSTRAINT ck_resource_edges_target_order_key_reserved CHECK ((target_order_key IS NULL)),
    CONSTRAINT ck_resource_edges_target_scheme CHECK ((target_scheme = ANY (ARRAY['media'::text, 'library'::text, 'evidence_span'::text, 'content_chunk'::text, 'highlight'::text, 'page'::text, 'note_block'::text, 'fragment'::text, 'conversation'::text, 'message'::text, 'oracle_reading'::text, 'oracle_passage_anchor'::text, 'artifact'::text, 'artifact_revision'::text, 'external_snapshot'::text, 'contributor'::text, 'podcast'::text, 'reader_apparatus_item'::text, 'passage_anchor'::text])))
);


--
-- Name: resource_external_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_external_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    url text NOT NULL,
    title text NOT NULL,
    snippet text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: resource_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_grants (
    id uuid NOT NULL,
    subject_scheme text NOT NULL,
    subject_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    grantee_user_id uuid,
    share_token text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: resource_mutations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_mutations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    mutation_scope text NOT NULL,
    client_mutation_id text NOT NULL,
    request_hash text NOT NULL,
    response_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_resource_mutations_client_mutation_id_length CHECK (((char_length(client_mutation_id) >= 1) AND (char_length(client_mutation_id) <= 120))),
    CONSTRAINT ck_resource_mutations_request_hash_length CHECK ((char_length(request_hash) = 64)),
    CONSTRAINT ck_resource_mutations_response_json_object CHECK ((jsonb_typeof(response_json) = 'object'::text)),
    CONSTRAINT ck_resource_mutations_scope_length CHECK (((char_length(mutation_scope) >= 1) AND (char_length(mutation_scope) <= 300)))
);


--
-- Name: resource_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    resource_scheme text NOT NULL,
    resource_id uuid NOT NULL,
    lane text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_resource_versions_lane CHECK ((lane = ANY (ARRAY['title'::text, 'body'::text, 'outgoing_edges'::text]))),
    CONSTRAINT ck_resource_versions_resource_scheme CHECK ((resource_scheme = ANY (ARRAY['media'::text, 'library'::text, 'evidence_span'::text, 'content_chunk'::text, 'highlight'::text, 'page'::text, 'note_block'::text, 'fragment'::text, 'conversation'::text, 'message'::text, 'oracle_reading'::text, 'oracle_passage_anchor'::text, 'artifact'::text, 'artifact_revision'::text, 'external_snapshot'::text, 'contributor'::text, 'podcast'::text, 'reader_apparatus_item'::text, 'passage_anchor'::text]))),
    CONSTRAINT ck_resource_versions_version_positive CHECK ((version >= 1))
);


--
-- Name: resource_view_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_view_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    surface_scheme text NOT NULL,
    surface_id uuid NOT NULL,
    edge_id uuid,
    target_scheme text,
    target_id uuid,
    state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_resource_view_states_state_object CHECK ((jsonb_typeof(state) = 'object'::text)),
    CONSTRAINT ck_resource_view_states_surface_scheme CHECK ((surface_scheme = ANY (ARRAY['media'::text, 'library'::text, 'evidence_span'::text, 'content_chunk'::text, 'highlight'::text, 'page'::text, 'note_block'::text, 'fragment'::text, 'conversation'::text, 'message'::text, 'oracle_reading'::text, 'oracle_passage_anchor'::text, 'artifact'::text, 'artifact_revision'::text, 'external_snapshot'::text, 'contributor'::text, 'podcast'::text, 'reader_apparatus_item'::text, 'passage_anchor'::text]))),
    CONSTRAINT ck_resource_view_states_target_pair CHECK (((target_scheme IS NULL) = (target_id IS NULL))),
    CONSTRAINT ck_resource_view_states_target_scheme CHECK (((target_scheme IS NULL) OR (target_scheme = ANY (ARRAY['media'::text, 'library'::text, 'evidence_span'::text, 'content_chunk'::text, 'highlight'::text, 'page'::text, 'note_block'::text, 'fragment'::text, 'conversation'::text, 'message'::text, 'oracle_reading'::text, 'oracle_passage_anchor'::text, 'artifact'::text, 'artifact_revision'::text, 'external_snapshot'::text, 'contributor'::text, 'podcast'::text, 'reader_apparatus_item'::text, 'passage_anchor'::text]))))
);


--
-- Name: stream_token_jti_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stream_token_jti_claims (
    jti text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stripe_event_id text NOT NULL,
    event_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: synapse_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.synapse_suppressions (
    user_id uuid NOT NULL,
    source_scheme text NOT NULL,
    source_id uuid NOT NULL,
    target_scheme text NOT NULL,
    target_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_synapse_suppressions_source_scheme CHECK ((source_scheme = ANY (ARRAY['media'::text, 'library'::text, 'evidence_span'::text, 'content_chunk'::text, 'highlight'::text, 'page'::text, 'note_block'::text, 'fragment'::text, 'conversation'::text, 'message'::text, 'oracle_reading'::text, 'oracle_passage_anchor'::text, 'artifact'::text, 'external_snapshot'::text, 'contributor'::text, 'podcast'::text]))),
    CONSTRAINT ck_synapse_suppressions_target_scheme CHECK ((target_scheme = ANY (ARRAY['media'::text, 'library'::text, 'evidence_span'::text, 'content_chunk'::text, 'highlight'::text, 'page'::text, 'note_block'::text, 'fragment'::text, 'conversation'::text, 'message'::text, 'oracle_reading'::text, 'oracle_passage_anchor'::text, 'artifact'::text, 'external_snapshot'::text, 'contributor'::text, 'podcast'::text])))
);


--
-- Name: user_media_deletions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_media_deletions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    media_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    email text,
    display_name text,
    calendar_time_zone text DEFAULT 'UTC'::text NOT NULL
);


--
-- Name: viewer_collection_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.viewer_collection_revisions (
    viewer_id uuid NOT NULL,
    family text NOT NULL,
    revision bigint NOT NULL
);


--
-- Name: workspace_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_id text NOT NULL,
    state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_workspace_sessions_state_object CHECK ((jsonb_typeof(state) = 'object'::text))
);


--
-- Name: project_gutenberg_catalog ebook_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_gutenberg_catalog ALTER COLUMN ebook_id SET DEFAULT nextval('public.project_gutenberg_catalog_ebook_id_seq'::regclass);


--
-- Name: rate_limit_request_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_request_log ALTER COLUMN id SET DEFAULT nextval('public.rate_limit_request_log_id_seq'::regclass);


--
-- Name: artifact_build_cancellations artifact_build_cancellations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_build_cancellations
    ADD CONSTRAINT artifact_build_cancellations_pkey PRIMARY KEY (id);


--
-- Name: artifact_build_events artifact_build_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_build_events
    ADD CONSTRAINT artifact_build_events_pkey PRIMARY KEY (id);


--
-- Name: artifact_build_failures artifact_build_failures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_build_failures
    ADD CONSTRAINT artifact_build_failures_pkey PRIMARY KEY (id);


--
-- Name: artifact_builds artifact_builds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_builds
    ADD CONSTRAINT artifact_builds_pkey PRIMARY KEY (id);


--
-- Name: artifact_idea_resolutions artifact_idea_resolutions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_idea_resolutions
    ADD CONSTRAINT artifact_idea_resolutions_pkey PRIMARY KEY (highlight_id);


--
-- Name: artifact_idea_seeds artifact_idea_seeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_idea_seeds
    ADD CONSTRAINT artifact_idea_seeds_pkey PRIMARY KEY (id);


--
-- Name: artifact_idea_subjects artifact_idea_subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_idea_subjects
    ADD CONSTRAINT artifact_idea_subjects_pkey PRIMARY KEY (id);


--
-- Name: artifact_learn_failures artifact_learn_failures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_learn_failures
    ADD CONSTRAINT artifact_learn_failures_pkey PRIMARY KEY (request_id);


--
-- Name: artifact_learn_requests artifact_learn_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_learn_requests
    ADD CONSTRAINT artifact_learn_requests_pkey PRIMARY KEY (id);


--
-- Name: artifact_learn_successes artifact_learn_successes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_learn_successes
    ADD CONSTRAINT artifact_learn_successes_pkey PRIMARY KEY (request_id);


--
-- Name: assistant_write_authorships assistant_write_authorships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_write_authorships
    ADD CONSTRAINT assistant_write_authorships_pkey PRIMARY KEY (id);


--
-- Name: auth_handoff_codes auth_handoff_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_handoff_codes
    ADD CONSTRAINT auth_handoff_codes_pkey PRIMARY KEY (id);


--
-- Name: background_job_capacity_leases background_job_capacity_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_job_capacity_leases
    ADD CONSTRAINT background_job_capacity_leases_pkey PRIMARY KEY (resource_class);


--
-- Name: background_jobs background_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_jobs
    ADD CONSTRAINT background_jobs_pkey PRIMARY KEY (id);


--
-- Name: billing_accounts billing_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_accounts
    ADD CONSTRAINT billing_accounts_pkey PRIMARY KEY (id);


--
-- Name: billing_entitlement_overrides billing_entitlement_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_entitlement_overrides
    ADD CONSTRAINT billing_entitlement_overrides_pkey PRIMARY KEY (id);


--
-- Name: chat_prompt_assemblies chat_prompt_assemblies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_prompt_assemblies
    ADD CONSTRAINT chat_prompt_assemblies_pkey PRIMARY KEY (id);


--
-- Name: chat_run_events chat_run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_run_events
    ADD CONSTRAINT chat_run_events_pkey PRIMARY KEY (id);


--
-- Name: chat_run_turn_contexts chat_run_turn_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_run_turn_contexts
    ADD CONSTRAINT chat_run_turn_contexts_pkey PRIMARY KEY (chat_run_id);


--
-- Name: chat_runs chat_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_runs
    ADD CONSTRAINT chat_runs_pkey PRIMARY KEY (id);


--
-- Name: consumption_activity_exclusions consumption_activity_exclusions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_activity_exclusions
    ADD CONSTRAINT consumption_activity_exclusions_pkey PRIMARY KEY (id);


--
-- Name: consumption_activity_spans consumption_activity_spans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_activity_spans
    ADD CONSTRAINT consumption_activity_spans_pkey PRIMARY KEY (id);


--
-- Name: consumption_completion_facts consumption_completion_facts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_completion_facts
    ADD CONSTRAINT consumption_completion_facts_pkey PRIMARY KEY (id);


--
-- Name: consumption_overrides consumption_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_overrides
    ADD CONSTRAINT consumption_overrides_pkey PRIMARY KEY (user_id, media_id);


--
-- Name: content_blocks content_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_blocks
    ADD CONSTRAINT content_blocks_pkey PRIMARY KEY (id);


--
-- Name: content_chunks content_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_chunks
    ADD CONSTRAINT content_chunks_pkey PRIMARY KEY (id);


--
-- Name: content_embeddings content_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_embeddings
    ADD CONSTRAINT content_embeddings_pkey PRIMARY KEY (id);


--
-- Name: contributor_aliases contributor_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributor_aliases
    ADD CONSTRAINT contributor_aliases_pkey PRIMARY KEY (id);


--
-- Name: contributor_credits contributor_credits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributor_credits
    ADD CONSTRAINT contributor_credits_pkey PRIMARY KEY (id);


--
-- Name: contributor_external_ids contributor_external_ids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributor_external_ids
    ADD CONSTRAINT contributor_external_ids_pkey PRIMARY KEY (id);


--
-- Name: contributors contributors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributors
    ADD CONSTRAINT contributors_pkey PRIMARY KEY (id);


--
-- Name: conversation_active_paths conversation_active_paths_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_active_paths
    ADD CONSTRAINT conversation_active_paths_pkey PRIMARY KEY (id);


--
-- Name: conversation_branches conversation_branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_branches
    ADD CONSTRAINT conversation_branches_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: daily_page_bindings daily_page_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_page_bindings
    ADD CONSTRAINT daily_page_bindings_pkey PRIMARY KEY (id);


--
-- Name: dawn_writes dawn_writes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dawn_writes
    ADD CONSTRAINT dawn_writes_pkey PRIMARY KEY (id);


--
-- Name: document_embed_artifact_states document_embed_artifact_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embed_artifact_states
    ADD CONSTRAINT document_embed_artifact_states_pkey PRIMARY KEY (id);


--
-- Name: document_embeds document_embeds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embeds
    ADD CONSTRAINT document_embeds_pkey PRIMARY KEY (id);


--
-- Name: epub_fragment_sources epub_fragment_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_fragment_sources
    ADD CONSTRAINT epub_fragment_sources_pkey PRIMARY KEY (id);


--
-- Name: epub_nav_locations epub_nav_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_nav_locations
    ADD CONSTRAINT epub_nav_locations_pkey PRIMARY KEY (media_id, location_id);


--
-- Name: epub_resources epub_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_resources
    ADD CONSTRAINT epub_resources_pkey PRIMARY KEY (id);


--
-- Name: epub_toc_nodes epub_toc_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_toc_nodes
    ADD CONSTRAINT epub_toc_nodes_pkey PRIMARY KEY (media_id, node_id);


--
-- Name: evidence_spans evidence_spans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evidence_spans
    ADD CONSTRAINT evidence_spans_pkey PRIMARY KEY (id);


--
-- Name: extension_sessions extension_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extension_sessions
    ADD CONSTRAINT extension_sessions_pkey PRIMARY KEY (id);


--
-- Name: fragment_blocks fragment_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fragment_blocks
    ADD CONSTRAINT fragment_blocks_pkey PRIMARY KEY (id);


--
-- Name: fragments fragments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fragments
    ADD CONSTRAINT fragments_pkey PRIMARY KEY (id);


--
-- Name: highlight_fragment_anchors highlight_fragment_anchors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlight_fragment_anchors
    ADD CONSTRAINT highlight_fragment_anchors_pkey PRIMARY KEY (highlight_id);


--
-- Name: highlight_pdf_anchors highlight_pdf_anchors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlight_pdf_anchors
    ADD CONSTRAINT highlight_pdf_anchors_pkey PRIMARY KEY (highlight_id);


--
-- Name: highlight_pdf_quads highlight_pdf_quads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlight_pdf_quads
    ADD CONSTRAINT highlight_pdf_quads_pkey PRIMARY KEY (highlight_id, quad_idx);


--
-- Name: highlight_pdf_text_anchors highlight_pdf_text_anchors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlight_pdf_text_anchors
    ADD CONSTRAINT highlight_pdf_text_anchors_pkey PRIMARY KEY (highlight_id);


--
-- Name: highlights highlights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlights
    ADD CONSTRAINT highlights_pkey PRIMARY KEY (id);


--
-- Name: libraries libraries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.libraries
    ADD CONSTRAINT libraries_pkey PRIMARY KEY (id);


--
-- Name: library_entries library_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_entries
    ADD CONSTRAINT library_entries_pkey PRIMARY KEY (id);


--
-- Name: artifact_revisions library_intelligence_artifact_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_revisions
    ADD CONSTRAINT library_intelligence_artifact_revisions_pkey PRIMARY KEY (id);


--
-- Name: artifacts library_intelligence_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT library_intelligence_artifacts_pkey PRIMARY KEY (id);


--
-- Name: library_invitations library_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_invitations
    ADD CONSTRAINT library_invitations_pkey PRIMARY KEY (id);


--
-- Name: llm_calls llm_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_calls
    ADD CONSTRAINT llm_calls_pkey PRIMARY KEY (id);


--
-- Name: llm_model_turn_continuations llm_model_turn_continuations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_model_turn_continuations
    ADD CONSTRAINT llm_model_turn_continuations_pkey PRIMARY KEY (id);


--
-- Name: llm_model_turns llm_model_turns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_model_turns
    ADD CONSTRAINT llm_model_turns_pkey PRIMARY KEY (id);


--
-- Name: llm_tool_positions llm_tool_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_tool_positions
    ADD CONSTRAINT llm_tool_positions_pkey PRIMARY KEY (id);


--
-- Name: media_atlas_positions media_atlas_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_atlas_positions
    ADD CONSTRAINT media_atlas_positions_pkey PRIMARY KEY (media_id);


--
-- Name: media_claims media_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_claims
    ADD CONSTRAINT media_claims_pkey PRIMARY KEY (id);


--
-- Name: content_index_states media_content_index_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_index_states
    ADD CONSTRAINT media_content_index_states_pkey PRIMARY KEY (id);


--
-- Name: media_file media_file_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_file
    ADD CONSTRAINT media_file_pkey PRIMARY KEY (media_id);


--
-- Name: media media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_pkey PRIMARY KEY (id);


--
-- Name: media_processing_events media_processing_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_processing_events
    ADD CONSTRAINT media_processing_events_pkey PRIMARY KEY (id);


--
-- Name: media_source_attempts media_source_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_source_attempts
    ADD CONSTRAINT media_source_attempts_pkey PRIMARY KEY (id);


--
-- Name: media_summaries media_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_summaries
    ADD CONSTRAINT media_summaries_pkey PRIMARY KEY (id);


--
-- Name: media_teardown_intents media_teardown_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_teardown_intents
    ADD CONSTRAINT media_teardown_intents_pkey PRIMARY KEY (id);


--
-- Name: media_transcript_states media_transcript_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_transcript_states
    ADD CONSTRAINT media_transcript_states_pkey PRIMARY KEY (media_id);


--
-- Name: media_upload_events media_upload_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_events
    ADD CONSTRAINT media_upload_events_pkey PRIMARY KEY (id);


--
-- Name: media_upload_session_destinations media_upload_session_destinations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_session_destinations
    ADD CONSTRAINT media_upload_session_destinations_pkey PRIMARY KEY (upload_session_id, library_id);


--
-- Name: media_upload_sessions media_upload_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_sessions
    ADD CONSTRAINT media_upload_sessions_pkey PRIMARY KEY (id);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (library_id, user_id);


--
-- Name: message_retrievals message_retrievals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_retrievals
    ADD CONSTRAINT message_retrievals_pkey PRIMARY KEY (id);


--
-- Name: message_tool_calls message_tool_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_tool_calls
    ADD CONSTRAINT message_tool_calls_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: nexus_usages nexus_usages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nexus_usages
    ADD CONSTRAINT nexus_usages_pkey PRIMARY KEY (id);


--
-- Name: note_blocks note_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_blocks
    ADD CONSTRAINT note_blocks_pkey PRIMARY KEY (id);


--
-- Name: oracle_corpus_publications oracle_corpus_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_corpus_publications
    ADD CONSTRAINT oracle_corpus_publications_pkey PRIMARY KEY (corpus_key);


--
-- Name: oracle_corpus_sources oracle_corpus_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_corpus_sources
    ADD CONSTRAINT oracle_corpus_sources_pkey PRIMARY KEY (id);


--
-- Name: oracle_passage_anchors oracle_passage_anchors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_passage_anchors
    ADD CONSTRAINT oracle_passage_anchors_pkey PRIMARY KEY (id);


--
-- Name: oracle_plates oracle_plates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_plates
    ADD CONSTRAINT oracle_plates_pkey PRIMARY KEY (id);


--
-- Name: oracle_reading_events oracle_reading_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_reading_events
    ADD CONSTRAINT oracle_reading_events_pkey PRIMARY KEY (id);


--
-- Name: oracle_reading_folios oracle_reading_folios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_reading_folios
    ADD CONSTRAINT oracle_reading_folios_pkey PRIMARY KEY (reading_id, phase);


--
-- Name: oracle_readings oracle_readings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_readings
    ADD CONSTRAINT oracle_readings_pkey PRIMARY KEY (id);


--
-- Name: pages pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pages
    ADD CONSTRAINT pages_pkey PRIMARY KEY (id);


--
-- Name: passage_anchors passage_anchors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passage_anchors
    ADD CONSTRAINT passage_anchors_pkey PRIMARY KEY (id);


--
-- Name: pdf_page_text_spans pdf_page_text_spans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_page_text_spans
    ADD CONSTRAINT pdf_page_text_spans_pkey PRIMARY KEY (media_id, page_number);


--
-- Name: podcast_episode_identities pk_podcast_episode_identities; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_episode_identities
    ADD CONSTRAINT pk_podcast_episode_identities PRIMARY KEY (id);


--
-- Name: podcast_refresh_run_items pk_podcast_refresh_run_items; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_refresh_run_items
    ADD CONSTRAINT pk_podcast_refresh_run_items PRIMARY KEY (id);


--
-- Name: podcast_refresh_runs pk_podcast_refresh_runs; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_refresh_runs
    ADD CONSTRAINT pk_podcast_refresh_runs PRIMARY KEY (id);


--
-- Name: podcast_subscription_backfills pk_podcast_subscription_backfills; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_subscription_backfills
    ADD CONSTRAINT pk_podcast_subscription_backfills PRIMARY KEY (id);


--
-- Name: resource_grants pk_resource_grants; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_grants
    ADD CONSTRAINT pk_resource_grants PRIMARY KEY (id);


--
-- Name: consumption_queue_items playback_queue_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_queue_items
    ADD CONSTRAINT playback_queue_items_pkey PRIMARY KEY (id);


--
-- Name: podcast_episode_chapters podcast_episode_chapters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_episode_chapters
    ADD CONSTRAINT podcast_episode_chapters_pkey PRIMARY KEY (id);


--
-- Name: podcast_episodes podcast_episodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_episodes
    ADD CONSTRAINT podcast_episodes_pkey PRIMARY KEY (media_id);


--
-- Name: podcast_listening_states podcast_listening_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_listening_states
    ADD CONSTRAINT podcast_listening_states_pkey PRIMARY KEY (user_id, media_id);


--
-- Name: podcast_subscriptions podcast_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_subscriptions
    ADD CONSTRAINT podcast_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: podcast_transcript_segments podcast_transcript_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_transcript_segments
    ADD CONSTRAINT podcast_transcript_segments_pkey PRIMARY KEY (id);


--
-- Name: podcast_transcription_jobs podcast_transcription_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_transcription_jobs
    ADD CONSTRAINT podcast_transcription_jobs_pkey PRIMARY KEY (media_id);


--
-- Name: podcast_transcription_usage_daily podcast_transcription_usage_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_transcription_usage_daily
    ADD CONSTRAINT podcast_transcription_usage_daily_pkey PRIMARY KEY (user_id, usage_date);


--
-- Name: podcasts podcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcasts
    ADD CONSTRAINT podcasts_pkey PRIMARY KEY (id);


--
-- Name: project_gutenberg_catalog project_gutenberg_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_gutenberg_catalog
    ADD CONSTRAINT project_gutenberg_catalog_pkey PRIMARY KEY (ebook_id);


--
-- Name: rate_limit_request_log rate_limit_request_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_request_log
    ADD CONSTRAINT rate_limit_request_log_pkey PRIMARY KEY (id);


--
-- Name: reader_apparatus_edges reader_apparatus_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_edges
    ADD CONSTRAINT reader_apparatus_edges_pkey PRIMARY KEY (id);


--
-- Name: reader_apparatus_items reader_apparatus_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_items
    ADD CONSTRAINT reader_apparatus_items_pkey PRIMARY KEY (id);


--
-- Name: reader_apparatus_states reader_apparatus_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_states
    ADD CONSTRAINT reader_apparatus_states_pkey PRIMARY KEY (id);


--
-- Name: reader_engagement_states reader_engagement_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_engagement_states
    ADD CONSTRAINT reader_engagement_states_pkey PRIMARY KEY (id);


--
-- Name: reader_media_state reader_media_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_media_state
    ADD CONSTRAINT reader_media_state_pkey PRIMARY KEY (id);


--
-- Name: reader_profiles reader_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_profiles
    ADD CONSTRAINT reader_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: reader_publications reader_publications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_publications
    ADD CONSTRAINT reader_publications_pkey PRIMARY KEY (id);


--
-- Name: resource_edges resource_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_edges
    ADD CONSTRAINT resource_edges_pkey PRIMARY KEY (id);


--
-- Name: resource_external_snapshots resource_external_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_external_snapshots
    ADD CONSTRAINT resource_external_snapshots_pkey PRIMARY KEY (id);


--
-- Name: resource_mutations resource_mutations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_mutations
    ADD CONSTRAINT resource_mutations_pkey PRIMARY KEY (id);


--
-- Name: resource_versions resource_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_versions
    ADD CONSTRAINT resource_versions_pkey PRIMARY KEY (id);


--
-- Name: resource_view_states resource_view_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_view_states
    ADD CONSTRAINT resource_view_states_pkey PRIMARY KEY (id);


--
-- Name: stream_token_jti_claims stream_token_jti_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_token_jti_claims
    ADD CONSTRAINT stream_token_jti_claims_pkey PRIMARY KEY (jti);


--
-- Name: stripe_webhook_events stripe_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_webhook_events
    ADD CONSTRAINT stripe_webhook_events_pkey PRIMARY KEY (id);


--
-- Name: synapse_suppressions synapse_suppressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.synapse_suppressions
    ADD CONSTRAINT synapse_suppressions_pkey PRIMARY KEY (user_id, source_scheme, source_id, target_scheme, target_id);


--
-- Name: auth_handoff_codes uix_auth_handoff_codes_code_hash; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_handoff_codes
    ADD CONSTRAINT uix_auth_handoff_codes_code_hash UNIQUE (code_hash);


--
-- Name: chat_prompt_assemblies uix_chat_prompt_assemblies_chat_run; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_prompt_assemblies
    ADD CONSTRAINT uix_chat_prompt_assemblies_chat_run UNIQUE (chat_run_id);


--
-- Name: chat_run_events uix_chat_run_events_run_seq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_run_events
    ADD CONSTRAINT uix_chat_run_events_run_seq UNIQUE (run_id, seq);


--
-- Name: conversation_active_paths uix_conversation_active_paths_conversation_viewer; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_active_paths
    ADD CONSTRAINT uix_conversation_active_paths_conversation_viewer UNIQUE (conversation_id, viewer_user_id);


--
-- Name: conversation_branches uix_conversation_branches_user_message; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_branches
    ADD CONSTRAINT uix_conversation_branches_user_message UNIQUE (branch_user_message_id);


--
-- Name: epub_nav_locations uix_epub_nav_locations_media_ordinal; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_nav_locations
    ADD CONSTRAINT uix_epub_nav_locations_media_ordinal UNIQUE (media_id, ordinal);


--
-- Name: epub_nav_locations uix_epub_nav_locations_media_source; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_nav_locations
    ADD CONSTRAINT uix_epub_nav_locations_media_source UNIQUE (media_id, source_node_id);


--
-- Name: extension_sessions uix_extension_sessions_token_hash; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extension_sessions
    ADD CONSTRAINT uix_extension_sessions_token_hash UNIQUE (token_hash);


--
-- Name: fragment_blocks uix_fragment_blocks_fragment_idx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fragment_blocks
    ADD CONSTRAINT uix_fragment_blocks_fragment_idx UNIQUE (fragment_id, block_idx);


--
-- Name: message_retrievals uix_message_retrievals_tool_call_ordinal; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_retrievals
    ADD CONSTRAINT uix_message_retrievals_tool_call_ordinal UNIQUE (tool_call_id, ordinal);


--
-- Name: message_tool_calls uix_message_tool_calls_assistant_index; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_tool_calls
    ADD CONSTRAINT uix_message_tool_calls_assistant_index UNIQUE (assistant_message_id, tool_call_index);


--
-- Name: messages uix_messages_conversation_seq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT uix_messages_conversation_seq UNIQUE (conversation_id, seq);


--
-- Name: oracle_corpus_sources uix_oracle_corpus_sources_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_corpus_sources
    ADD CONSTRAINT uix_oracle_corpus_sources_media UNIQUE (media_id);


--
-- Name: oracle_corpus_sources uix_oracle_corpus_sources_work; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_corpus_sources
    ADD CONSTRAINT uix_oracle_corpus_sources_work UNIQUE (corpus_key, work_key);


--
-- Name: oracle_passage_anchors uix_oracle_passage_anchors_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_passage_anchors
    ADD CONSTRAINT uix_oracle_passage_anchors_key UNIQUE (corpus_source_id, passage_key);


--
-- Name: oracle_plates uix_oracle_plates_source_url; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_plates
    ADD CONSTRAINT uix_oracle_plates_source_url UNIQUE (source_url);


--
-- Name: oracle_reading_events uix_oracle_reading_events_seq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_reading_events
    ADD CONSTRAINT uix_oracle_reading_events_seq UNIQUE (reading_id, seq);


--
-- Name: oracle_readings uix_oracle_readings_user_folio; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_readings
    ADD CONSTRAINT uix_oracle_readings_user_folio UNIQUE (user_id, folio_number);


--
-- Name: resource_mutations uix_resource_mutations_client_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_mutations
    ADD CONSTRAINT uix_resource_mutations_client_id UNIQUE (user_id, mutation_scope, client_mutation_id);


--
-- Name: resource_versions uix_resource_versions_lane; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_versions
    ADD CONSTRAINT uix_resource_versions_lane UNIQUE (user_id, resource_scheme, resource_id, lane);


--
-- Name: user_media_deletions uix_user_media_deletions_user_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_media_deletions
    ADD CONSTRAINT uix_user_media_deletions_user_media UNIQUE (user_id, media_id);


--
-- Name: artifact_build_cancellations uq_artifact_build_cancellations_build; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_build_cancellations
    ADD CONSTRAINT uq_artifact_build_cancellations_build UNIQUE (build_id);


--
-- Name: artifact_build_events uq_artifact_build_events_seq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_build_events
    ADD CONSTRAINT uq_artifact_build_events_seq UNIQUE (build_id, seq);


--
-- Name: artifact_build_failures uq_artifact_build_failures_build; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_build_failures
    ADD CONSTRAINT uq_artifact_build_failures_build UNIQUE (build_id);


--
-- Name: artifact_builds uq_artifact_builds_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_builds
    ADD CONSTRAINT uq_artifact_builds_idempotency UNIQUE (artifact_id, idempotency_key);


--
-- Name: artifact_idea_seeds uq_artifact_idea_seeds_pair; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_idea_seeds
    ADD CONSTRAINT uq_artifact_idea_seeds_pair UNIQUE (artifact_id, highlight_id);


--
-- Name: artifact_idea_subjects uq_artifact_idea_subjects_owner_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_idea_subjects
    ADD CONSTRAINT uq_artifact_idea_subjects_owner_key UNIQUE (user_id, idea_key);


--
-- Name: artifact_learn_requests uq_artifact_learn_requests_user_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_learn_requests
    ADD CONSTRAINT uq_artifact_learn_requests_user_key UNIQUE (user_id, idempotency_key);


--
-- Name: artifact_revisions uq_artifact_revisions_build; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_revisions
    ADD CONSTRAINT uq_artifact_revisions_build UNIQUE (build_id);


--
-- Name: artifacts uq_artifacts_subject_audience; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT uq_artifacts_subject_audience UNIQUE (subject_scheme, subject_id, audience_scheme, audience_id);


--
-- Name: assistant_write_authorships uq_assistant_write_authorships_target; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_write_authorships
    ADD CONSTRAINT uq_assistant_write_authorships_target UNIQUE (target_kind, target_id);


--
-- Name: billing_accounts uq_billing_accounts_stripe_customer_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_accounts
    ADD CONSTRAINT uq_billing_accounts_stripe_customer_id UNIQUE (stripe_customer_id);


--
-- Name: billing_accounts uq_billing_accounts_stripe_subscription_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_accounts
    ADD CONSTRAINT uq_billing_accounts_stripe_subscription_id UNIQUE (stripe_subscription_id);


--
-- Name: billing_accounts uq_billing_accounts_user_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_accounts
    ADD CONSTRAINT uq_billing_accounts_user_id UNIQUE (user_id);


--
-- Name: billing_entitlement_overrides uq_billing_entitlement_overrides_user_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_entitlement_overrides
    ADD CONSTRAINT uq_billing_entitlement_overrides_user_id UNIQUE (user_id);


--
-- Name: chat_runs uq_chat_runs_assistant_message; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_runs
    ADD CONSTRAINT uq_chat_runs_assistant_message UNIQUE (assistant_message_id);


--
-- Name: consumption_activity_spans uq_consumption_activity_spans_user_capture_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_activity_spans
    ADD CONSTRAINT uq_consumption_activity_spans_user_capture_key UNIQUE (user_id, capture_key);


--
-- Name: consumption_completion_facts uq_consumption_completion_facts_user_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_completion_facts
    ADD CONSTRAINT uq_consumption_completion_facts_user_media UNIQUE (user_id, media_id);


--
-- Name: consumption_queue_items uq_consumption_queue_items_user_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_queue_items
    ADD CONSTRAINT uq_consumption_queue_items_user_media UNIQUE (user_id, media_id);


--
-- Name: content_blocks uq_content_blocks_owner_idx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_blocks
    ADD CONSTRAINT uq_content_blocks_owner_idx UNIQUE (owner_kind, owner_id, block_idx);


--
-- Name: content_chunks uq_content_chunks_owner_idx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_chunks
    ADD CONSTRAINT uq_content_chunks_owner_idx UNIQUE (owner_kind, owner_id, chunk_idx);


--
-- Name: content_index_states uq_content_index_states_owner; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_index_states
    ADD CONSTRAINT uq_content_index_states_owner UNIQUE (owner_kind, owner_id);


--
-- Name: contributor_aliases uq_contributor_aliases_owner_normalized; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributor_aliases
    ADD CONSTRAINT uq_contributor_aliases_owner_normalized UNIQUE (contributor_id, normalized_alias);


--
-- Name: contributor_external_ids uq_contributor_external_ids_authority_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributor_external_ids
    ADD CONSTRAINT uq_contributor_external_ids_authority_key UNIQUE (authority, external_key);


--
-- Name: contributors uq_contributors_handle; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributors
    ADD CONSTRAINT uq_contributors_handle UNIQUE (handle);


--
-- Name: daily_page_bindings uq_daily_page_bindings_user_date; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_page_bindings
    ADD CONSTRAINT uq_daily_page_bindings_user_date UNIQUE (user_id, local_date);


--
-- Name: daily_page_bindings uq_daily_page_bindings_user_page; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_page_bindings
    ADD CONSTRAINT uq_daily_page_bindings_user_page UNIQUE (user_id, page_id);


--
-- Name: dawn_writes uq_dawn_writes_user_date; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dawn_writes
    ADD CONSTRAINT uq_dawn_writes_user_date UNIQUE (user_id, local_date);


--
-- Name: document_embed_artifact_states uq_document_embed_artifact_states_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embed_artifact_states
    ADD CONSTRAINT uq_document_embed_artifact_states_media UNIQUE (media_id);


--
-- Name: document_embeds uq_document_embeds_media_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embeds
    ADD CONSTRAINT uq_document_embeds_media_key UNIQUE (media_id, occurrence_key);


--
-- Name: document_embeds uq_document_embeds_media_ordinal; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embeds
    ADD CONSTRAINT uq_document_embeds_media_ordinal UNIQUE (media_id, ordinal);


--
-- Name: epub_fragment_sources uq_epub_fragment_sources_fragment; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_fragment_sources
    ADD CONSTRAINT uq_epub_fragment_sources_fragment UNIQUE (media_id, fragment_id);


--
-- Name: epub_fragment_sources uq_epub_fragment_sources_href; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_fragment_sources
    ADD CONSTRAINT uq_epub_fragment_sources_href UNIQUE (media_id, package_href);


--
-- Name: epub_resources uq_epub_resources_asset_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_resources
    ADD CONSTRAINT uq_epub_resources_asset_key UNIQUE (media_id, asset_key);


--
-- Name: epub_resources uq_epub_resources_href; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_resources
    ADD CONSTRAINT uq_epub_resources_href UNIQUE (media_id, package_href);


--
-- Name: fragments uq_fragments_media_idx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fragments
    ADD CONSTRAINT uq_fragments_media_idx UNIQUE (media_id, idx);


--
-- Name: library_entries uq_library_entries_library_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_entries
    ADD CONSTRAINT uq_library_entries_library_media UNIQUE (library_id, media_id);


--
-- Name: library_entries uq_library_entries_library_podcast; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_entries
    ADD CONSTRAINT uq_library_entries_library_podcast UNIQUE (library_id, podcast_id);


--
-- Name: library_entries uq_library_entries_library_position; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_entries
    ADD CONSTRAINT uq_library_entries_library_position UNIQUE (library_id, "position") DEFERRABLE INITIALLY DEFERRED;


--
-- Name: llm_calls uq_llm_calls_owner_generation_seq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_calls
    ADD CONSTRAINT uq_llm_calls_owner_generation_seq UNIQUE (owner_kind, owner_id, generation_seq);


--
-- Name: llm_model_turn_continuations uq_llm_model_turn_continuations_source_turn; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_model_turn_continuations
    ADD CONSTRAINT uq_llm_model_turn_continuations_source_turn UNIQUE (source_model_turn_id);


--
-- Name: llm_model_turn_continuations uq_llm_model_turn_continuations_successor_turn; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_model_turn_continuations
    ADD CONSTRAINT uq_llm_model_turn_continuations_successor_turn UNIQUE (generation_id, successor_turn_seq);


--
-- Name: llm_model_turns uq_llm_model_turns_generation_turn_seq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_model_turns
    ADD CONSTRAINT uq_llm_model_turns_generation_turn_seq UNIQUE (generation_id, turn_seq);


--
-- Name: llm_tool_positions uq_llm_tool_positions_generation_position; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_tool_positions
    ADD CONSTRAINT uq_llm_tool_positions_generation_position UNIQUE (generation_id, "position");


--
-- Name: llm_tool_positions uq_llm_tool_positions_transport_call; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_tool_positions
    ADD CONSTRAINT uq_llm_tool_positions_transport_call UNIQUE (generation_id, transport_kind, model_turn_seq, transport_call_id);


--
-- Name: media_claims uq_media_claims_summary_ordinal; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_claims
    ADD CONSTRAINT uq_media_claims_summary_ordinal UNIQUE (summary_id, ordinal);


--
-- Name: media_source_attempts uq_media_source_attempts_media_attempt; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_source_attempts
    ADD CONSTRAINT uq_media_source_attempts_media_attempt UNIQUE (media_id, attempt_no);


--
-- Name: media_summaries uq_media_summaries_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_summaries
    ADD CONSTRAINT uq_media_summaries_media UNIQUE (media_id);


--
-- Name: media_teardown_intents uq_media_teardown_intents_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_teardown_intents
    ADD CONSTRAINT uq_media_teardown_intents_media UNIQUE (media_id);


--
-- Name: media_upload_sessions uq_media_upload_sessions_candidate_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_sessions
    ADD CONSTRAINT uq_media_upload_sessions_candidate_media UNIQUE (candidate_media_id);


--
-- Name: media_upload_sessions uq_media_upload_sessions_published_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_sessions
    ADD CONSTRAINT uq_media_upload_sessions_published_media UNIQUE (published_media_id);


--
-- Name: media_upload_sessions uq_media_upload_sessions_published_source_attempt; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_sessions
    ADD CONSTRAINT uq_media_upload_sessions_published_source_attempt UNIQUE (published_source_attempt_id);


--
-- Name: media_upload_sessions uq_media_upload_sessions_viewer_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_sessions
    ADD CONSTRAINT uq_media_upload_sessions_viewer_idempotency UNIQUE (created_by_user_id, idempotency_key);


--
-- Name: message_tool_calls uq_message_tool_calls_tool_position; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_tool_calls
    ADD CONSTRAINT uq_message_tool_calls_tool_position UNIQUE (tool_position_id);


--
-- Name: nexus_usages uq_nexus_usages_user_query_href; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nexus_usages
    ADD CONSTRAINT uq_nexus_usages_user_query_href UNIQUE (user_id, query_normalized, target_href);


--
-- Name: passage_anchors uq_passage_anchors_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passage_anchors
    ADD CONSTRAINT uq_passage_anchors_identity UNIQUE (user_id, owner_scheme, owner_id, anchor_key);


--
-- Name: podcast_episode_chapters uq_podcast_episode_chapters_media_idx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_episode_chapters
    ADD CONSTRAINT uq_podcast_episode_chapters_media_idx UNIQUE (media_id, chapter_idx);


--
-- Name: podcast_episode_identities uq_podcast_episode_identities_alias; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_episode_identities
    ADD CONSTRAINT uq_podcast_episode_identities_alias UNIQUE (podcast_id, scheme, value);


--
-- Name: podcast_episodes uq_podcast_episodes_podcast_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_episodes
    ADD CONSTRAINT uq_podcast_episodes_podcast_media UNIQUE (podcast_id, media_id);


--
-- Name: podcast_refresh_run_items uq_podcast_refresh_run_items_run_subscription; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_refresh_run_items
    ADD CONSTRAINT uq_podcast_refresh_run_items_run_subscription UNIQUE (run_id, subscription_id);


--
-- Name: podcast_subscription_backfills uq_podcast_subscription_backfills_subscription; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_subscription_backfills
    ADD CONSTRAINT uq_podcast_subscription_backfills_subscription UNIQUE (subscription_id);


--
-- Name: podcast_subscriptions uq_podcast_subscriptions_user_podcast; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_subscriptions
    ADD CONSTRAINT uq_podcast_subscriptions_user_podcast UNIQUE (user_id, podcast_id);


--
-- Name: podcast_transcript_segments uq_podcast_transcript_segments_media_idx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_transcript_segments
    ADD CONSTRAINT uq_podcast_transcript_segments_media_idx UNIQUE (media_id, segment_idx);


--
-- Name: podcasts uq_podcasts_feed_url; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcasts
    ADD CONSTRAINT uq_podcasts_feed_url UNIQUE (feed_url);


--
-- Name: podcasts uq_podcasts_provider_provider_podcast_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcasts
    ADD CONSTRAINT uq_podcasts_provider_provider_podcast_id UNIQUE (provider, provider_podcast_id);


--
-- Name: reader_apparatus_edges uq_reader_apparatus_edges_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_edges
    ADD CONSTRAINT uq_reader_apparatus_edges_key UNIQUE (media_id, stable_key);


--
-- Name: reader_apparatus_items uq_reader_apparatus_items_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_items
    ADD CONSTRAINT uq_reader_apparatus_items_key UNIQUE (media_id, stable_key);


--
-- Name: reader_apparatus_items uq_reader_apparatus_items_media_state_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_items
    ADD CONSTRAINT uq_reader_apparatus_items_media_state_id UNIQUE (media_id, state_id, id);


--
-- Name: reader_apparatus_states uq_reader_apparatus_states_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_states
    ADD CONSTRAINT uq_reader_apparatus_states_media UNIQUE (media_id);


--
-- Name: reader_apparatus_states uq_reader_apparatus_states_media_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_states
    ADD CONSTRAINT uq_reader_apparatus_states_media_id UNIQUE (media_id, id);


--
-- Name: reader_engagement_states uq_reader_engagement_states_user_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_engagement_states
    ADD CONSTRAINT uq_reader_engagement_states_user_media UNIQUE (user_id, media_id);


--
-- Name: reader_media_state uq_reader_media_state_user_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_media_state
    ADD CONSTRAINT uq_reader_media_state_user_media UNIQUE (user_id, media_id);


--
-- Name: reader_publications uq_reader_publications_media; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_publications
    ADD CONSTRAINT uq_reader_publications_media UNIQUE (media_id);


--
-- Name: stripe_webhook_events uq_stripe_webhook_events_stripe_event_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_webhook_events
    ADD CONSTRAINT uq_stripe_webhook_events_stripe_event_id UNIQUE (stripe_event_id);


--
-- Name: users uq_users_email; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT uq_users_email UNIQUE (email);


--
-- Name: workspace_sessions uq_workspace_sessions_user_device; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_sessions
    ADD CONSTRAINT uq_workspace_sessions_user_device UNIQUE (user_id, device_id);


--
-- Name: user_media_deletions user_media_deletions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_media_deletions
    ADD CONSTRAINT user_media_deletions_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: viewer_collection_revisions viewer_collection_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewer_collection_revisions
    ADD CONSTRAINT viewer_collection_revisions_pkey PRIMARY KEY (viewer_id, family);


--
-- Name: workspace_sessions workspace_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_sessions
    ADD CONSTRAINT workspace_sessions_pkey PRIMARY KEY (id);


--
-- Name: idx_auth_handoff_codes_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_handoff_codes_expires_at ON public.auth_handoff_codes USING btree (expires_at);


--
-- Name: idx_background_jobs_dedupe_key_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_background_jobs_dedupe_key_unique ON public.background_jobs USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: idx_background_jobs_due_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_due_claim ON public.background_jobs USING btree (priority, available_at, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: idx_background_jobs_due_claim_by_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_due_claim_by_kind ON public.background_jobs USING btree (kind, priority, available_at, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: idx_background_jobs_kind_status_available; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_kind_status_available ON public.background_jobs USING btree (kind, status, available_at);


--
-- Name: idx_background_jobs_lease_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_lease_expires_at ON public.background_jobs USING btree (lease_expires_at);


--
-- Name: idx_background_jobs_running_expired_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_running_expired_claim ON public.background_jobs USING btree (priority, lease_expires_at, created_at, id) WHERE ((status = 'running'::text) AND (lease_expires_at IS NOT NULL));


--
-- Name: idx_background_jobs_running_expired_claim_by_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_running_expired_claim_by_kind ON public.background_jobs USING btree (kind, priority, lease_expires_at, created_at, id) WHERE ((status = 'running'::text) AND (lease_expires_at IS NOT NULL));


--
-- Name: idx_background_jobs_status_available_priority_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_status_available_priority_created ON public.background_jobs USING btree (status, available_at, priority, created_at);


--
-- Name: idx_background_jobs_terminal_prune; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_terminal_prune ON public.background_jobs USING btree (finished_at, id) WHERE ((status = ANY (ARRAY['succeeded'::text, 'dead'::text])) AND (finished_at IS NOT NULL));


--
-- Name: idx_background_jobs_wait_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_wait_due ON public.background_jobs USING btree (available_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: idx_background_jobs_wait_due_by_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_wait_due_by_kind ON public.background_jobs USING btree (kind, available_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: idx_background_jobs_wait_running; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_wait_running ON public.background_jobs USING btree (lease_expires_at, id) WHERE ((status = 'running'::text) AND (lease_expires_at IS NOT NULL));


--
-- Name: idx_background_jobs_wait_running_by_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_jobs_wait_running_by_kind ON public.background_jobs USING btree (kind, lease_expires_at, id) WHERE ((status = 'running'::text) AND (lease_expires_at IS NOT NULL));


--
-- Name: idx_chat_prompt_assemblies_assistant_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_prompt_assemblies_assistant_message ON public.chat_prompt_assemblies USING btree (assistant_message_id);


--
-- Name: idx_chat_run_events_run_event_type_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_run_events_run_event_type_seq ON public.chat_run_events USING btree (run_id, event_type, seq);


--
-- Name: idx_chat_run_events_run_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_run_events_run_seq ON public.chat_run_events USING btree (run_id, seq);


--
-- Name: idx_chat_run_turn_contexts_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_run_turn_contexts_subject ON public.chat_run_turn_contexts USING btree (subject_scheme, subject_id);


--
-- Name: idx_chat_runs_owner_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_runs_owner_created ON public.chat_runs USING btree (owner_user_id, created_at, id);


--
-- Name: idx_conversation_branches_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_branches_conversation ON public.conversation_branches USING btree (conversation_id);


--
-- Name: idx_conversations_owner_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_owner_updated_at ON public.conversations USING btree (owner_user_id, updated_at DESC);


--
-- Name: idx_document_embeds_fragment_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_embeds_fragment_order ON public.document_embeds USING btree (fragment_id, ordinal, id) WHERE (fragment_id IS NOT NULL);


--
-- Name: idx_document_embeds_media_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_embeds_media_order ON public.document_embeds USING btree (media_id, ordinal, id);


--
-- Name: idx_document_embeds_resolution; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_embeds_resolution ON public.document_embeds USING btree (resolution_status, updated_at, id) WHERE (resolution_status = ANY (ARRAY['pending'::text, 'resolving'::text, 'failed'::text]));


--
-- Name: idx_document_embeds_target_media; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_embeds_target_media ON public.document_embeds USING btree (target_media_id) WHERE (target_media_id IS NOT NULL);


--
-- Name: idx_epub_nav_locations_media_fragment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epub_nav_locations_media_fragment ON public.epub_nav_locations USING btree (media_id, fragment_idx);


--
-- Name: idx_epub_toc_nodes_media_fragment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_epub_toc_nodes_media_fragment ON public.epub_toc_nodes USING btree (media_id, fragment_idx);


--
-- Name: idx_extension_sessions_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_extension_sessions_user_active ON public.extension_sessions USING btree (user_id, created_at) WHERE (revoked_at IS NULL);


--
-- Name: idx_fragment_blocks_fragment_offsets; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fragment_blocks_fragment_offsets ON public.fragment_blocks USING btree (fragment_id, start_offset, end_offset);


--
-- Name: idx_fragments_canonical_text_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fragments_canonical_text_tsv ON public.fragments USING gin (canonical_text_tsv);


--
-- Name: idx_library_entries_media_library; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_library_entries_media_library ON public.library_entries USING btree (media_id, library_id);


--
-- Name: idx_library_entries_podcast_library; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_library_entries_podcast_library ON public.library_entries USING btree (podcast_id, library_id);


--
-- Name: idx_library_invitations_invitee_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_library_invitations_invitee_status_created ON public.library_invitations USING btree (invitee_user_id, status, created_at DESC, id DESC);


--
-- Name: idx_library_invitations_library_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_library_invitations_library_status_created ON public.library_invitations USING btree (library_id, status, created_at DESC, id DESC);


--
-- Name: idx_media_source_attempts_media_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_source_attempts_media_created ON public.media_source_attempts USING btree (media_id, created_at DESC, id DESC);


--
-- Name: idx_media_source_attempts_provider_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_source_attempts_provider_target ON public.media_source_attempts USING btree (provider, provider_target_ref, created_at, id) WHERE ((provider IS NOT NULL) AND (provider_target_ref IS NOT NULL));


--
-- Name: idx_media_source_attempts_request_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_source_attempts_request_id ON public.media_source_attempts USING btree (request_id) WHERE (request_id IS NOT NULL);


--
-- Name: idx_media_source_attempts_source_type_status_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_source_attempts_source_type_status_updated ON public.media_source_attempts USING btree (source_type, status, updated_at, id);


--
-- Name: idx_media_source_attempts_status_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_source_attempts_status_updated ON public.media_source_attempts USING btree (status, updated_at, id);


--
-- Name: idx_media_stale_extracting_recovery; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_stale_extracting_recovery ON public.media USING btree (processing_started_at, id) WHERE ((processing_status = 'extracting'::public.processing_status_enum) AND (kind = ANY (ARRAY['web_article'::text, 'pdf'::text, 'epub'::text, 'podcast_episode'::text])) AND (processing_started_at IS NOT NULL));


--
-- Name: idx_media_title_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_title_tsv ON public.media USING gin (title_tsv);


--
-- Name: idx_memberships_user_library_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_user_library_role ON public.memberships USING btree (user_id, library_id, role);


--
-- Name: idx_message_retrievals_evidence_span; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_retrievals_evidence_span ON public.message_retrievals USING btree (evidence_span_id);


--
-- Name: idx_message_retrievals_media; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_retrievals_media ON public.message_retrievals USING btree (media_id);


--
-- Name: idx_message_retrievals_result_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_retrievals_result_type ON public.message_retrievals USING btree (result_type);


--
-- Name: idx_message_retrievals_tool_call_selected; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_retrievals_tool_call_selected ON public.message_retrievals USING btree (tool_call_id, selected, ordinal);


--
-- Name: idx_message_tool_calls_assistant_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_tool_calls_assistant_message ON public.message_tool_calls USING btree (assistant_message_id, tool_call_index);


--
-- Name: idx_message_tool_calls_canonical_tool_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_tool_calls_canonical_tool_status ON public.message_tool_calls USING btree (canonical_tool_id, status);


--
-- Name: idx_message_tool_calls_conversation_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_tool_calls_conversation_created ON public.message_tool_calls USING btree (conversation_id, created_at);


--
-- Name: idx_message_tool_calls_user_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_tool_calls_user_message ON public.message_tool_calls USING btree (user_message_id, tool_call_index);


--
-- Name: idx_messages_content_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_content_tsv ON public.messages USING gin (content_tsv);


--
-- Name: idx_messages_conversation_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_conversation_seq ON public.messages USING btree (conversation_id, seq);


--
-- Name: idx_messages_parent_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_parent_message_id ON public.messages USING btree (parent_message_id);


--
-- Name: idx_oracle_reading_events_reading_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oracle_reading_events_reading_seq ON public.oracle_reading_events USING btree (reading_id, seq);


--
-- Name: idx_oracle_readings_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oracle_readings_user_created ON public.oracle_readings USING btree (user_id, created_at);


--
-- Name: idx_oracle_readings_user_image; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oracle_readings_user_image ON public.oracle_readings USING btree (user_id, image_id);


--
-- Name: idx_oracle_readings_user_theme; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oracle_readings_user_theme ON public.oracle_readings USING btree (user_id, folio_theme);


--
-- Name: idx_rate_limit_request_log_user_requested_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_limit_request_log_user_requested_at ON public.rate_limit_request_log USING btree (user_id, requested_at);


--
-- Name: idx_reader_media_state_media; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reader_media_state_media ON public.reader_media_state USING btree (media_id);


--
-- Name: idx_stream_token_jti_claims_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stream_token_jti_claims_expires_at ON public.stream_token_jti_claims USING btree (expires_at);


--
-- Name: ix_artifact_builds_artifact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_artifact_builds_artifact ON public.artifact_builds USING btree (artifact_id);


--
-- Name: ix_assistant_write_authorships_tool_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_assistant_write_authorships_tool_position ON public.assistant_write_authorships USING btree (tool_position_id, created_at, id);


--
-- Name: ix_cons_activity_exclusions_user_media_device_started_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_cons_activity_exclusions_user_media_device_started_id ON public.consumption_activity_exclusions USING btree (user_id, media_id, device_id, started_at, id);


--
-- Name: ix_consumption_activity_exclusions_media_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_consumption_activity_exclusions_media_id ON public.consumption_activity_exclusions USING btree (media_id, id);


--
-- Name: ix_consumption_activity_exclusions_user_started_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_consumption_activity_exclusions_user_started_id ON public.consumption_activity_exclusions USING btree (user_id, started_at, id);


--
-- Name: ix_consumption_activity_spans_media_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_consumption_activity_spans_media_id ON public.consumption_activity_spans USING btree (media_id, id);


--
-- Name: ix_consumption_activity_spans_user_device_occurred_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_consumption_activity_spans_user_device_occurred_id ON public.consumption_activity_spans USING btree (user_id, device_id, occurred_at, id);


--
-- Name: ix_consumption_activity_spans_user_media_occurred_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_consumption_activity_spans_user_media_occurred_id ON public.consumption_activity_spans USING btree (user_id, media_id, occurred_at, id);


--
-- Name: ix_consumption_activity_spans_user_occurred_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_consumption_activity_spans_user_occurred_id ON public.consumption_activity_spans USING btree (user_id, occurred_at, id);


--
-- Name: ix_consumption_completion_facts_media_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_consumption_completion_facts_media_id ON public.consumption_completion_facts USING btree (media_id, id);


--
-- Name: ix_consumption_completion_facts_user_created_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_consumption_completion_facts_user_created_id ON public.consumption_completion_facts USING btree (user_id, created_at, id);


--
-- Name: ix_consumption_queue_items_user_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_consumption_queue_items_user_position ON public.consumption_queue_items USING btree (user_id, "position");


--
-- Name: ix_content_blocks_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_content_blocks_owner_idx ON public.content_blocks USING btree (owner_kind, owner_id, block_idx);


--
-- Name: ix_content_chunks_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_content_chunks_owner_idx ON public.content_chunks USING btree (owner_kind, owner_id, chunk_idx);


--
-- Name: ix_content_chunks_primary_evidence_span_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_content_chunks_primary_evidence_span_id ON public.content_chunks USING btree (primary_evidence_span_id);


--
-- Name: ix_content_chunks_text_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_content_chunks_text_tsv ON public.content_chunks USING gin (chunk_text_tsv);


--
-- Name: ix_content_embeddings_chunk_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_content_embeddings_chunk_id ON public.content_embeddings USING btree (chunk_id);


--
-- Name: ix_content_embeddings_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_content_embeddings_model ON public.content_embeddings USING btree (embedding_provider, embedding_model);


--
-- Name: ix_content_embeddings_vector_ann; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_content_embeddings_vector_ann ON public.content_embeddings USING ivfflat (embedding_vector public.vector_cosine_ops) WITH (lists='100');


--
-- Name: ix_content_index_states_repair_indexing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_content_index_states_repair_indexing ON public.content_index_states USING btree (updated_at, owner_kind, owner_id) WHERE (status = 'indexing'::text);


--
-- Name: ix_content_index_states_repair_waiting; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_content_index_states_repair_waiting ON public.content_index_states USING btree (updated_at, owner_kind, owner_id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: ix_contributor_aliases_contributor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_contributor_aliases_contributor_id ON public.contributor_aliases USING btree (contributor_id);


--
-- Name: ix_contributor_aliases_resolution; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_contributor_aliases_resolution ON public.contributor_aliases USING btree (normalized_alias, resolves_identity, contributor_id);


--
-- Name: ix_contributor_credits_contributor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_contributor_credits_contributor_id ON public.contributor_credits USING btree (contributor_id);


--
-- Name: ix_contributor_external_ids_contributor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_contributor_external_ids_contributor_id ON public.contributor_external_ids USING btree (contributor_id);


--
-- Name: ix_dawn_writes_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_dawn_writes_user ON public.dawn_writes USING btree (user_id);


--
-- Name: ix_epub_fragment_sources_media_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_epub_fragment_sources_media_order ON public.epub_fragment_sources USING btree (media_id, reading_order);


--
-- Name: ix_epub_resources_media; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_epub_resources_media ON public.epub_resources USING btree (media_id);


--
-- Name: ix_evidence_spans_end_block_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_evidence_spans_end_block_id ON public.evidence_spans USING btree (end_block_id);


--
-- Name: ix_evidence_spans_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_evidence_spans_owner ON public.evidence_spans USING btree (owner_kind, owner_id);


--
-- Name: ix_evidence_spans_span_text_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_evidence_spans_span_text_tsv ON public.evidence_spans USING gin (to_tsvector('english'::regconfig, span_text));


--
-- Name: ix_evidence_spans_start_block_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_evidence_spans_start_block_id ON public.evidence_spans USING btree (start_block_id);


--
-- Name: ix_fragments_media_t_start_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_fragments_media_t_start_idx ON public.fragments USING btree (media_id, t_start_ms, idx);


--
-- Name: ix_hpa_media_page_sort; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_hpa_media_page_sort ON public.highlight_pdf_anchors USING btree (media_id, page_number, sort_top, sort_left);


--
-- Name: ix_library_entries_library_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_library_entries_library_order ON public.library_entries USING btree (library_id, "position", created_at DESC, id DESC);


--
-- Name: ix_media_atlas_positions_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_atlas_positions_version ON public.media_atlas_positions USING btree (projection_version);


--
-- Name: ix_media_claims_evidence_span_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_claims_evidence_span_id ON public.media_claims USING btree (evidence_span_id);


--
-- Name: ix_media_claims_media; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_claims_media ON public.media_claims USING btree (media_id);


--
-- Name: ix_media_processing_events_media_occurred_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_processing_events_media_occurred_id ON public.media_processing_events USING btree (media_id, occurred_at, id);


--
-- Name: ix_media_transcript_states_semantic_repair; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_transcript_states_semantic_repair ON public.media_transcript_states USING btree (updated_at, media_id) WHERE ((transcript_state = ANY (ARRAY['ready'::text, 'partial'::text])) AND (transcript_coverage = ANY (ARRAY['partial'::text, 'full'::text])) AND (semantic_status = ANY (ARRAY['pending'::text, 'failed'::text, 'ready'::text])));


--
-- Name: ix_media_transcript_states_semantic_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_transcript_states_semantic_status ON public.media_transcript_states USING btree (semantic_status);


--
-- Name: ix_media_upload_events_session_occurred_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_media_upload_events_session_occurred_id ON public.media_upload_events USING btree (session_id, occurred_at, id);


--
-- Name: ix_nexus_usages_user_last_used_at_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_nexus_usages_user_last_used_at_id ON public.nexus_usages USING btree (user_id, last_used_at DESC, id DESC);


--
-- Name: ix_nexus_usages_user_query_last_used_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_nexus_usages_user_query_last_used_at ON public.nexus_usages USING btree (user_id, query_normalized, last_used_at DESC);


--
-- Name: ix_note_blocks_body_text_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_note_blocks_body_text_trgm ON public.note_blocks USING gin (body_text public.gin_trgm_ops);


--
-- Name: ix_note_blocks_body_text_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_note_blocks_body_text_tsv ON public.note_blocks USING gin (to_tsvector('english'::regconfig, body_text));


--
-- Name: ix_podcast_episode_chapters_media_t_start_ms; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_podcast_episode_chapters_media_t_start_ms ON public.podcast_episode_chapters USING btree (media_id, t_start_ms);


--
-- Name: ix_podcast_episode_identities_episode_media_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_podcast_episode_identities_episode_media_id ON public.podcast_episode_identities USING btree (episode_media_id);


--
-- Name: ix_podcast_listening_states_media_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_podcast_listening_states_media_id ON public.podcast_listening_states USING btree (media_id);


--
-- Name: ix_podcast_listening_states_user_last_engaged; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_podcast_listening_states_user_last_engaged ON public.podcast_listening_states USING btree (user_id, last_engaged_at DESC, media_id DESC) WHERE (last_engaged_at IS NOT NULL);


--
-- Name: ix_podcast_refresh_runs_completed_at_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_podcast_refresh_runs_completed_at_id ON public.podcast_refresh_runs USING btree (completed_at, id);


--
-- Name: ix_podcast_subscriptions_next_sync_at_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_podcast_subscriptions_next_sync_at_id ON public.podcast_subscriptions USING btree (next_sync_at, id);


--
-- Name: ix_podcast_transcript_segments_media_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_podcast_transcript_segments_media_start ON public.podcast_transcript_segments USING btree (media_id, t_start_ms, segment_idx);


--
-- Name: ix_project_gutenberg_catalog_language; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_gutenberg_catalog_language ON public.project_gutenberg_catalog USING btree (language);


--
-- Name: ix_project_gutenberg_catalog_title; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_project_gutenberg_catalog_title ON public.project_gutenberg_catalog USING btree (title);


--
-- Name: ix_reader_engagement_states_user_last_engaged; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_reader_engagement_states_user_last_engaged ON public.reader_engagement_states USING btree (user_id, last_engaged_at DESC, media_id DESC);


--
-- Name: ix_resource_edges_user_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_resource_edges_user_source ON public.resource_edges USING btree (user_id, source_scheme, source_id, source_order_key, id);


--
-- Name: ix_resource_edges_user_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_resource_edges_user_target ON public.resource_edges USING btree (user_id, target_scheme, target_id, created_at, id);


--
-- Name: ix_resource_grants_creator_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_resource_grants_creator_subject ON public.resource_grants USING btree (created_by_user_id, subject_scheme, subject_id);


--
-- Name: ix_resource_grants_recipient_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_resource_grants_recipient_subject ON public.resource_grants USING btree (grantee_user_id, subject_scheme, subject_id);


--
-- Name: ix_resource_grants_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_resource_grants_subject ON public.resource_grants USING btree (subject_scheme, subject_id);


--
-- Name: ix_synapse_suppressions_user_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_synapse_suppressions_user_target ON public.synapse_suppressions USING btree (user_id, target_scheme, target_id);


--
-- Name: ix_users_email_pattern; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_users_email_pattern ON public.users USING btree (email text_pattern_ops);


--
-- Name: ix_workspace_sessions_user_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_workspace_sessions_user_updated ON public.workspace_sessions USING btree (user_id, updated_at DESC, id DESC);


--
-- Name: uix_epub_toc_nodes_media_nav_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uix_epub_toc_nodes_media_nav_order ON public.epub_toc_nodes USING btree (media_id, nav_type, order_key);


--
-- Name: uix_libraries_one_default_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uix_libraries_one_default_per_user ON public.libraries USING btree (owner_user_id) WHERE (is_default = true);


--
-- Name: uix_libraries_system_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uix_libraries_system_key ON public.libraries USING btree (system_key) WHERE (system_key IS NOT NULL);


--
-- Name: uix_library_invitations_pending_once; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uix_library_invitations_pending_once ON public.library_invitations USING btree (library_id, invitee_user_id) WHERE (status = 'pending'::text);


--
-- Name: uix_media_canonical_url; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uix_media_canonical_url ON public.media USING btree (kind, canonical_url) WHERE (canonical_url IS NOT NULL);


--
-- Name: uix_media_email_provider_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uix_media_email_provider_id ON public.media USING btree (provider, provider_id) WHERE ((provider = 'email'::text) AND (provider_id IS NOT NULL));


--
-- Name: uix_media_x_provider_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uix_media_x_provider_id ON public.media USING btree (provider, provider_id) WHERE ((provider = 'x'::text) AND (provider_id IS NOT NULL));


--
-- Name: uix_resource_view_states_edge_occurrence; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uix_resource_view_states_edge_occurrence ON public.resource_view_states USING btree (user_id, surface_scheme, surface_id, edge_id) WHERE (edge_id IS NOT NULL);


--
-- Name: uq_contributor_credits_gutenberg_contributor_role; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_contributor_credits_gutenberg_contributor_role ON public.contributor_credits USING btree (project_gutenberg_catalog_ebook_id, contributor_id, role) WHERE (project_gutenberg_catalog_ebook_id IS NOT NULL);


--
-- Name: uq_contributor_credits_gutenberg_ordinal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_contributor_credits_gutenberg_ordinal ON public.contributor_credits USING btree (project_gutenberg_catalog_ebook_id, ordinal) WHERE (project_gutenberg_catalog_ebook_id IS NOT NULL);


--
-- Name: uq_contributor_credits_media_contributor_role; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_contributor_credits_media_contributor_role ON public.contributor_credits USING btree (media_id, contributor_id, role) WHERE (media_id IS NOT NULL);


--
-- Name: uq_contributor_credits_media_ordinal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_contributor_credits_media_ordinal ON public.contributor_credits USING btree (media_id, ordinal) WHERE (media_id IS NOT NULL);


--
-- Name: uq_contributor_credits_podcast_contributor_role; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_contributor_credits_podcast_contributor_role ON public.contributor_credits USING btree (podcast_id, contributor_id, role) WHERE (podcast_id IS NOT NULL);


--
-- Name: uq_contributor_credits_podcast_ordinal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_contributor_credits_podcast_ordinal ON public.contributor_credits USING btree (podcast_id, ordinal) WHERE (podcast_id IS NOT NULL);


--
-- Name: uq_media_source_attempts_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_media_source_attempts_idempotency ON public.media_source_attempts USING btree (created_by_user_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_note_reindex_job_inflight; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_note_reindex_job_inflight ON public.background_jobs USING btree (((payload ->> 'note_block_id'::text))) WHERE ((kind = 'note_reindex_job'::text) AND (status <> ALL (ARRAY['succeeded'::text, 'dead'::text])));


--
-- Name: uq_oracle_readings_user_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_oracle_readings_user_idempotency_key ON public.oracle_readings USING btree (user_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_podcast_refresh_runs_user_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_podcast_refresh_runs_user_idempotency_key ON public.podcast_refresh_runs USING btree (user_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: uq_resource_edges_citation_ordinal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_resource_edges_citation_ordinal ON public.resource_edges USING btree (user_id, source_scheme, source_id, ordinal) WHERE (ordinal IS NOT NULL);


--
-- Name: uq_resource_edges_nonuser_orderless_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_resource_edges_nonuser_orderless_pair ON public.resource_edges USING btree (user_id, origin, source_scheme, source_id, target_scheme, target_id) WHERE ((origin <> 'user'::text) AND (ordinal IS NULL) AND (source_order_key IS NULL) AND (target_order_key IS NULL));


--
-- Name: uq_resource_edges_source_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_resource_edges_source_order ON public.resource_edges USING btree (user_id, source_scheme, source_id, source_order_key) WHERE (source_order_key IS NOT NULL);


--
-- Name: uq_resource_edges_user_context_link_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_resource_edges_user_context_link_pair ON public.resource_edges USING btree (user_id, source_scheme, source_id, target_scheme, target_id) WHERE ((origin = 'user'::text) AND (kind = 'context'::text) AND (ordinal IS NULL) AND (snapshot IS NULL) AND (source_order_key IS NULL) AND (target_order_key IS NULL));


--
-- Name: uq_resource_edges_user_stance_directed_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_resource_edges_user_stance_directed_pair ON public.resource_edges USING btree (user_id, source_scheme, source_id, target_scheme, target_id) WHERE ((origin = 'user'::text) AND (kind = ANY (ARRAY['supports'::text, 'contradicts'::text])) AND (ordinal IS NULL) AND (snapshot IS NULL) AND (source_order_key IS NULL) AND (target_order_key IS NULL));


--
-- Name: uq_resource_grants_share_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_resource_grants_share_token ON public.resource_grants USING btree (share_token) WHERE (share_token IS NOT NULL);


--
-- Name: artifact_build_events artifact_build_events_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER artifact_build_events_notify AFTER INSERT ON public.artifact_build_events FOR EACH ROW EXECUTE FUNCTION public.notify_artifact_build_event();


--
-- Name: chat_run_events chat_run_events_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER chat_run_events_notify AFTER INSERT ON public.chat_run_events FOR EACH ROW EXECUTE FUNCTION public.notify_chat_run_event();


--
-- Name: media media_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_notify AFTER UPDATE ON public.media FOR EACH ROW EXECUTE FUNCTION public.notify_media_change();


--
-- Name: oracle_reading_events oracle_reading_events_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER oracle_reading_events_notify AFTER INSERT ON public.oracle_reading_events FOR EACH ROW EXECUTE FUNCTION public.notify_oracle_reading_event();


--
-- Name: podcast_refresh_runs podcast_refresh_runs_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER podcast_refresh_runs_notify AFTER INSERT OR UPDATE ON public.podcast_refresh_runs FOR EACH ROW EXECUTE FUNCTION public.notify_podcast_refresh_run();


--
-- Name: podcast_subscription_backfills podcast_subscription_backfills_lifecycle_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER podcast_subscription_backfills_lifecycle_notify AFTER INSERT OR DELETE OR UPDATE ON public.podcast_subscription_backfills FOR EACH ROW EXECUTE FUNCTION public.notify_podcast_subscription_backfill_lifecycle();


--
-- Name: podcast_subscriptions podcast_subscriptions_lifecycle_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER podcast_subscriptions_lifecycle_notify AFTER INSERT OR DELETE OR UPDATE ON public.podcast_subscriptions FOR EACH ROW EXECUTE FUNCTION public.notify_podcast_subscription_lifecycle();


--
-- Name: artifact_build_cancellations artifact_build_cancellations_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_build_cancellations
    ADD CONSTRAINT artifact_build_cancellations_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: artifact_build_cancellations artifact_build_cancellations_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_build_cancellations
    ADD CONSTRAINT artifact_build_cancellations_build_id_fkey FOREIGN KEY (build_id) REFERENCES public.artifact_builds(id);


--
-- Name: artifact_build_events artifact_build_events_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_build_events
    ADD CONSTRAINT artifact_build_events_build_id_fkey FOREIGN KEY (build_id) REFERENCES public.artifact_builds(id);


--
-- Name: artifact_build_failures artifact_build_failures_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_build_failures
    ADD CONSTRAINT artifact_build_failures_build_id_fkey FOREIGN KEY (build_id) REFERENCES public.artifact_builds(id);


--
-- Name: artifact_builds artifact_builds_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_builds
    ADD CONSTRAINT artifact_builds_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id);


--
-- Name: artifact_builds artifact_builds_requester_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_builds
    ADD CONSTRAINT artifact_builds_requester_user_id_fkey FOREIGN KEY (requester_user_id) REFERENCES public.users(id);


--
-- Name: artifact_idea_resolutions artifact_idea_resolutions_highlight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_idea_resolutions
    ADD CONSTRAINT artifact_idea_resolutions_highlight_id_fkey FOREIGN KEY (highlight_id) REFERENCES public.highlights(id);


--
-- Name: artifact_idea_resolutions artifact_idea_resolutions_idea_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_idea_resolutions
    ADD CONSTRAINT artifact_idea_resolutions_idea_subject_id_fkey FOREIGN KEY (idea_subject_id) REFERENCES public.artifact_idea_subjects(id);


--
-- Name: artifact_idea_resolutions artifact_idea_resolutions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_idea_resolutions
    ADD CONSTRAINT artifact_idea_resolutions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: artifact_idea_seeds artifact_idea_seeds_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_idea_seeds
    ADD CONSTRAINT artifact_idea_seeds_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id);


--
-- Name: artifact_idea_seeds artifact_idea_seeds_highlight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_idea_seeds
    ADD CONSTRAINT artifact_idea_seeds_highlight_id_fkey FOREIGN KEY (highlight_id) REFERENCES public.highlights(id);


--
-- Name: artifact_idea_subjects artifact_idea_subjects_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_idea_subjects
    ADD CONSTRAINT artifact_idea_subjects_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: artifact_learn_failures artifact_learn_failures_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_learn_failures
    ADD CONSTRAINT artifact_learn_failures_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.artifact_learn_requests(id);


--
-- Name: artifact_learn_requests artifact_learn_requests_highlight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_learn_requests
    ADD CONSTRAINT artifact_learn_requests_highlight_id_fkey FOREIGN KEY (highlight_id) REFERENCES public.highlights(id);


--
-- Name: artifact_learn_requests artifact_learn_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_learn_requests
    ADD CONSTRAINT artifact_learn_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: artifact_learn_successes artifact_learn_successes_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_learn_successes
    ADD CONSTRAINT artifact_learn_successes_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id);


--
-- Name: artifact_learn_successes artifact_learn_successes_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_learn_successes
    ADD CONSTRAINT artifact_learn_successes_build_id_fkey FOREIGN KEY (build_id) REFERENCES public.artifact_builds(id);


--
-- Name: artifact_learn_successes artifact_learn_successes_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_learn_successes
    ADD CONSTRAINT artifact_learn_successes_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.artifact_learn_requests(id);


--
-- Name: artifact_revisions artifact_revisions_build_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_revisions
    ADD CONSTRAINT artifact_revisions_build_id_fkey FOREIGN KEY (build_id) REFERENCES public.artifact_builds(id);


--
-- Name: artifact_revisions artifact_revisions_citation_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_revisions
    ADD CONSTRAINT artifact_revisions_citation_owner_user_id_fkey FOREIGN KEY (citation_owner_user_id) REFERENCES public.users(id);


--
-- Name: artifact_revisions artifact_revisions_creator_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_revisions
    ADD CONSTRAINT artifact_revisions_creator_user_id_fkey FOREIGN KEY (creator_user_id) REFERENCES public.users(id);


--
-- Name: auth_handoff_codes auth_handoff_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_handoff_codes
    ADD CONSTRAINT auth_handoff_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: background_job_capacity_leases background_job_capacity_leases_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_job_capacity_leases
    ADD CONSTRAINT background_job_capacity_leases_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.background_jobs(id);


--
-- Name: billing_accounts billing_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_accounts
    ADD CONSTRAINT billing_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: billing_entitlement_overrides billing_entitlement_overrides_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_entitlement_overrides
    ADD CONSTRAINT billing_entitlement_overrides_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: billing_entitlement_overrides billing_entitlement_overrides_updated_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_entitlement_overrides
    ADD CONSTRAINT billing_entitlement_overrides_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id);


--
-- Name: billing_entitlement_overrides billing_entitlement_overrides_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_entitlement_overrides
    ADD CONSTRAINT billing_entitlement_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: chat_prompt_assemblies chat_prompt_assemblies_assistant_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_prompt_assemblies
    ADD CONSTRAINT chat_prompt_assemblies_assistant_message_id_fkey FOREIGN KEY (assistant_message_id) REFERENCES public.messages(id);


--
-- Name: chat_prompt_assemblies chat_prompt_assemblies_chat_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_prompt_assemblies
    ADD CONSTRAINT chat_prompt_assemblies_chat_run_id_fkey FOREIGN KEY (chat_run_id) REFERENCES public.chat_runs(id);


--
-- Name: chat_prompt_assemblies chat_prompt_assemblies_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_prompt_assemblies
    ADD CONSTRAINT chat_prompt_assemblies_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: chat_run_events chat_run_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_run_events
    ADD CONSTRAINT chat_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.chat_runs(id);


--
-- Name: chat_run_turn_contexts chat_run_turn_contexts_chat_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_run_turn_contexts
    ADD CONSTRAINT chat_run_turn_contexts_chat_run_id_fkey FOREIGN KEY (chat_run_id) REFERENCES public.chat_runs(id) ON DELETE CASCADE;


--
-- Name: chat_run_turn_contexts chat_run_turn_contexts_subject_context_edge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_run_turn_contexts
    ADD CONSTRAINT chat_run_turn_contexts_subject_context_edge_id_fkey FOREIGN KEY (subject_context_edge_id) REFERENCES public.resource_edges(id) ON DELETE SET NULL;


--
-- Name: chat_runs chat_runs_assistant_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_runs
    ADD CONSTRAINT chat_runs_assistant_message_id_fkey FOREIGN KEY (assistant_message_id) REFERENCES public.messages(id);


--
-- Name: chat_runs chat_runs_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_runs
    ADD CONSTRAINT chat_runs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: chat_runs chat_runs_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_runs
    ADD CONSTRAINT chat_runs_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);


--
-- Name: chat_runs chat_runs_user_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_runs
    ADD CONSTRAINT chat_runs_user_message_id_fkey FOREIGN KEY (user_message_id) REFERENCES public.messages(id);


--
-- Name: content_chunks content_chunks_primary_evidence_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_chunks
    ADD CONSTRAINT content_chunks_primary_evidence_span_id_fkey FOREIGN KEY (primary_evidence_span_id) REFERENCES public.evidence_spans(id);


--
-- Name: content_embeddings content_embeddings_chunk_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_embeddings
    ADD CONSTRAINT content_embeddings_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES public.content_chunks(id);


--
-- Name: contributor_aliases contributor_aliases_contributor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributor_aliases
    ADD CONSTRAINT contributor_aliases_contributor_id_fkey FOREIGN KEY (contributor_id) REFERENCES public.contributors(id);


--
-- Name: contributor_credits contributor_credits_contributor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributor_credits
    ADD CONSTRAINT contributor_credits_contributor_id_fkey FOREIGN KEY (contributor_id) REFERENCES public.contributors(id);


--
-- Name: contributor_credits contributor_credits_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributor_credits
    ADD CONSTRAINT contributor_credits_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: contributor_credits contributor_credits_podcast_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributor_credits
    ADD CONSTRAINT contributor_credits_podcast_id_fkey FOREIGN KEY (podcast_id) REFERENCES public.podcasts(id);


--
-- Name: contributor_credits contributor_credits_project_gutenberg_catalog_ebook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributor_credits
    ADD CONSTRAINT contributor_credits_project_gutenberg_catalog_ebook_id_fkey FOREIGN KEY (project_gutenberg_catalog_ebook_id) REFERENCES public.project_gutenberg_catalog(ebook_id);


--
-- Name: contributor_external_ids contributor_external_ids_contributor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contributor_external_ids
    ADD CONSTRAINT contributor_external_ids_contributor_id_fkey FOREIGN KEY (contributor_id) REFERENCES public.contributors(id);


--
-- Name: conversation_active_paths conversation_active_paths_active_leaf_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_active_paths
    ADD CONSTRAINT conversation_active_paths_active_leaf_message_id_fkey FOREIGN KEY (active_leaf_message_id) REFERENCES public.messages(id);


--
-- Name: conversation_active_paths conversation_active_paths_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_active_paths
    ADD CONSTRAINT conversation_active_paths_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: conversation_active_paths conversation_active_paths_viewer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_active_paths
    ADD CONSTRAINT conversation_active_paths_viewer_user_id_fkey FOREIGN KEY (viewer_user_id) REFERENCES public.users(id);


--
-- Name: conversation_branches conversation_branches_branch_user_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_branches
    ADD CONSTRAINT conversation_branches_branch_user_message_id_fkey FOREIGN KEY (branch_user_message_id) REFERENCES public.messages(id);


--
-- Name: conversation_branches conversation_branches_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_branches
    ADD CONSTRAINT conversation_branches_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: conversations conversations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: daily_page_bindings daily_page_bindings_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_page_bindings
    ADD CONSTRAINT daily_page_bindings_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.pages(id);


--
-- Name: daily_page_bindings daily_page_bindings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_page_bindings
    ADD CONSTRAINT daily_page_bindings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: dawn_writes dawn_writes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dawn_writes
    ADD CONSTRAINT dawn_writes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: document_embed_artifact_states document_embed_artifact_states_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embed_artifact_states
    ADD CONSTRAINT document_embed_artifact_states_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: document_embed_artifact_states document_embed_artifact_states_source_attempt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embed_artifact_states
    ADD CONSTRAINT document_embed_artifact_states_source_attempt_id_fkey FOREIGN KEY (source_attempt_id) REFERENCES public.media_source_attempts(id);


--
-- Name: document_embeds document_embeds_fragment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embeds
    ADD CONSTRAINT document_embeds_fragment_id_fkey FOREIGN KEY (fragment_id) REFERENCES public.fragments(id);


--
-- Name: document_embeds document_embeds_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embeds
    ADD CONSTRAINT document_embeds_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: document_embeds document_embeds_source_attempt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embeds
    ADD CONSTRAINT document_embeds_source_attempt_id_fkey FOREIGN KEY (source_attempt_id) REFERENCES public.media_source_attempts(id);


--
-- Name: document_embeds document_embeds_target_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_embeds
    ADD CONSTRAINT document_embeds_target_media_id_fkey FOREIGN KEY (target_media_id) REFERENCES public.media(id);


--
-- Name: epub_fragment_sources epub_fragment_sources_fragment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_fragment_sources
    ADD CONSTRAINT epub_fragment_sources_fragment_id_fkey FOREIGN KEY (fragment_id) REFERENCES public.fragments(id);


--
-- Name: epub_fragment_sources epub_fragment_sources_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_fragment_sources
    ADD CONSTRAINT epub_fragment_sources_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: epub_resources epub_resources_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_resources
    ADD CONSTRAINT epub_resources_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: epub_toc_nodes epub_toc_nodes_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_toc_nodes
    ADD CONSTRAINT epub_toc_nodes_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: evidence_spans evidence_spans_end_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evidence_spans
    ADD CONSTRAINT evidence_spans_end_block_id_fkey FOREIGN KEY (end_block_id) REFERENCES public.content_blocks(id);


--
-- Name: evidence_spans evidence_spans_start_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evidence_spans
    ADD CONSTRAINT evidence_spans_start_block_id_fkey FOREIGN KEY (start_block_id) REFERENCES public.content_blocks(id);


--
-- Name: extension_sessions extension_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.extension_sessions
    ADD CONSTRAINT extension_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: artifacts fk_artifacts_current_revision; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT fk_artifacts_current_revision FOREIGN KEY (current_revision_id) REFERENCES public.artifact_revisions(id);


--
-- Name: assistant_write_authorships fk_assistant_write_authorships_tool_position; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_write_authorships
    ADD CONSTRAINT fk_assistant_write_authorships_tool_position FOREIGN KEY (tool_position_id) REFERENCES public.llm_tool_positions(id);


--
-- Name: consumption_activity_exclusions fk_consumption_activity_exclusions_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_activity_exclusions
    ADD CONSTRAINT fk_consumption_activity_exclusions_media FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: consumption_activity_exclusions fk_consumption_activity_exclusions_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_activity_exclusions
    ADD CONSTRAINT fk_consumption_activity_exclusions_user FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: consumption_activity_spans fk_consumption_activity_spans_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_activity_spans
    ADD CONSTRAINT fk_consumption_activity_spans_media FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: consumption_activity_spans fk_consumption_activity_spans_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_activity_spans
    ADD CONSTRAINT fk_consumption_activity_spans_user FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: consumption_completion_facts fk_consumption_completion_facts_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_completion_facts
    ADD CONSTRAINT fk_consumption_completion_facts_media FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: consumption_completion_facts fk_consumption_completion_facts_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_completion_facts
    ADD CONSTRAINT fk_consumption_completion_facts_user FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: consumption_overrides fk_consumption_overrides_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_overrides
    ADD CONSTRAINT fk_consumption_overrides_media FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: consumption_overrides fk_consumption_overrides_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_overrides
    ADD CONSTRAINT fk_consumption_overrides_user FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: consumption_queue_items fk_consumption_queue_items_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_queue_items
    ADD CONSTRAINT fk_consumption_queue_items_media FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: consumption_queue_items fk_consumption_queue_items_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumption_queue_items
    ADD CONSTRAINT fk_consumption_queue_items_user FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: epub_nav_locations fk_epub_nav_locations_end_fragment; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_nav_locations
    ADD CONSTRAINT fk_epub_nav_locations_end_fragment FOREIGN KEY (media_id, end_fragment_idx) REFERENCES public.fragments(media_id, idx);


--
-- Name: epub_nav_locations fk_epub_nav_locations_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_nav_locations
    ADD CONSTRAINT fk_epub_nav_locations_media FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: epub_nav_locations fk_epub_nav_locations_parent; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_nav_locations
    ADD CONSTRAINT fk_epub_nav_locations_parent FOREIGN KEY (media_id, parent_section_id) REFERENCES public.epub_nav_locations(media_id, location_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: epub_nav_locations fk_epub_nav_locations_start_fragment; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_nav_locations
    ADD CONSTRAINT fk_epub_nav_locations_start_fragment FOREIGN KEY (media_id, fragment_idx) REFERENCES public.fragments(media_id, idx);


--
-- Name: epub_nav_locations fk_epub_nav_locations_toc_node; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_nav_locations
    ADD CONSTRAINT fk_epub_nav_locations_toc_node FOREIGN KEY (media_id, source_node_id) REFERENCES public.epub_toc_nodes(media_id, node_id) ON DELETE CASCADE;


--
-- Name: epub_toc_nodes fk_epub_toc_nodes_fragment; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_toc_nodes
    ADD CONSTRAINT fk_epub_toc_nodes_fragment FOREIGN KEY (media_id, fragment_idx) REFERENCES public.fragments(media_id, idx) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: epub_toc_nodes fk_epub_toc_nodes_parent; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.epub_toc_nodes
    ADD CONSTRAINT fk_epub_toc_nodes_parent FOREIGN KEY (media_id, parent_node_id) REFERENCES public.epub_toc_nodes(media_id, node_id) ON DELETE CASCADE;


--
-- Name: highlights fk_highlights_anchor_media_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlights
    ADD CONSTRAINT fk_highlights_anchor_media_id FOREIGN KEY (anchor_media_id) REFERENCES public.media(id);


--
-- Name: media fk_media_created_by_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT fk_media_created_by_user_id FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: media_processing_events fk_media_processing_events_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_processing_events
    ADD CONSTRAINT fk_media_processing_events_media FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: media_teardown_intents fk_media_teardown_intents_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_teardown_intents
    ADD CONSTRAINT fk_media_teardown_intents_media FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: media_upload_events fk_media_upload_events_session; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_events
    ADD CONSTRAINT fk_media_upload_events_session FOREIGN KEY (session_id) REFERENCES public.media_upload_sessions(id);


--
-- Name: media_upload_session_destinations fk_media_upload_session_destinations_library; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_session_destinations
    ADD CONSTRAINT fk_media_upload_session_destinations_library FOREIGN KEY (library_id) REFERENCES public.libraries(id);


--
-- Name: media_upload_session_destinations fk_media_upload_session_destinations_session; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_session_destinations
    ADD CONSTRAINT fk_media_upload_session_destinations_session FOREIGN KEY (upload_session_id) REFERENCES public.media_upload_sessions(id);


--
-- Name: media_upload_sessions fk_media_upload_sessions_created_by_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_sessions
    ADD CONSTRAINT fk_media_upload_sessions_created_by_user FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: media_upload_sessions fk_media_upload_sessions_published_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_sessions
    ADD CONSTRAINT fk_media_upload_sessions_published_media FOREIGN KEY (published_media_id) REFERENCES public.media(id);


--
-- Name: media_upload_sessions fk_media_upload_sessions_published_source_attempt; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_sessions
    ADD CONSTRAINT fk_media_upload_sessions_published_source_attempt FOREIGN KEY (published_source_attempt_id) REFERENCES public.media_source_attempts(id);


--
-- Name: message_retrievals fk_message_retrievals_evidence_span; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_retrievals
    ADD CONSTRAINT fk_message_retrievals_evidence_span FOREIGN KEY (evidence_span_id) REFERENCES public.evidence_spans(id);


--
-- Name: message_tool_calls fk_message_tool_calls_tool_position; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_tool_calls
    ADD CONSTRAINT fk_message_tool_calls_tool_position FOREIGN KEY (tool_position_id) REFERENCES public.llm_tool_positions(id);


--
-- Name: messages fk_messages_branch_root_message_id_messages; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT fk_messages_branch_root_message_id_messages FOREIGN KEY (branch_root_message_id) REFERENCES public.messages(id);


--
-- Name: messages fk_messages_parent_message_id_messages; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT fk_messages_parent_message_id_messages FOREIGN KEY (parent_message_id) REFERENCES public.messages(id);


--
-- Name: passage_anchors fk_passage_anchors_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passage_anchors
    ADD CONSTRAINT fk_passage_anchors_user FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: podcast_episode_identities fk_podcast_episode_identities_episode; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_episode_identities
    ADD CONSTRAINT fk_podcast_episode_identities_episode FOREIGN KEY (podcast_id, episode_media_id) REFERENCES public.podcast_episodes(podcast_id, media_id);


--
-- Name: podcast_episode_identities fk_podcast_episode_identities_podcast; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_episode_identities
    ADD CONSTRAINT fk_podcast_episode_identities_podcast FOREIGN KEY (podcast_id) REFERENCES public.podcasts(id);


--
-- Name: podcast_listening_states fk_podcast_listening_states_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_listening_states
    ADD CONSTRAINT fk_podcast_listening_states_media FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: podcast_listening_states fk_podcast_listening_states_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_listening_states
    ADD CONSTRAINT fk_podcast_listening_states_user FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: podcast_refresh_run_items fk_podcast_refresh_run_items_podcast; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_refresh_run_items
    ADD CONSTRAINT fk_podcast_refresh_run_items_podcast FOREIGN KEY (podcast_id) REFERENCES public.podcasts(id);


--
-- Name: podcast_refresh_run_items fk_podcast_refresh_run_items_run; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_refresh_run_items
    ADD CONSTRAINT fk_podcast_refresh_run_items_run FOREIGN KEY (run_id) REFERENCES public.podcast_refresh_runs(id);


--
-- Name: podcast_refresh_runs fk_podcast_refresh_runs_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_refresh_runs
    ADD CONSTRAINT fk_podcast_refresh_runs_user FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: podcast_subscription_backfills fk_podcast_subscription_backfills_subscription; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_subscription_backfills
    ADD CONSTRAINT fk_podcast_subscription_backfills_subscription FOREIGN KEY (subscription_id) REFERENCES public.podcast_subscriptions(id);


--
-- Name: reader_engagement_states fk_reader_engagement_states_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_engagement_states
    ADD CONSTRAINT fk_reader_engagement_states_media FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: reader_engagement_states fk_reader_engagement_states_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_engagement_states
    ADD CONSTRAINT fk_reader_engagement_states_user FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: reader_media_state fk_reader_media_state_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_media_state
    ADD CONSTRAINT fk_reader_media_state_media FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: reader_media_state fk_reader_media_state_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_media_state
    ADD CONSTRAINT fk_reader_media_state_user FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: reader_publications fk_reader_publications_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_publications
    ADD CONSTRAINT fk_reader_publications_media FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: resource_grants fk_resource_grants_created_by_user_id_users; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_grants
    ADD CONSTRAINT fk_resource_grants_created_by_user_id_users FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: resource_grants fk_resource_grants_grantee_user_id_users; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_grants
    ADD CONSTRAINT fk_resource_grants_grantee_user_id_users FOREIGN KEY (grantee_user_id) REFERENCES public.users(id);


--
-- Name: fragment_blocks fragment_blocks_fragment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fragment_blocks
    ADD CONSTRAINT fragment_blocks_fragment_id_fkey FOREIGN KEY (fragment_id) REFERENCES public.fragments(id) ON DELETE CASCADE;


--
-- Name: fragments fragments_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fragments
    ADD CONSTRAINT fragments_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: highlight_fragment_anchors highlight_fragment_anchors_highlight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlight_fragment_anchors
    ADD CONSTRAINT highlight_fragment_anchors_highlight_id_fkey FOREIGN KEY (highlight_id) REFERENCES public.highlights(id);


--
-- Name: highlight_pdf_anchors highlight_pdf_anchors_highlight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlight_pdf_anchors
    ADD CONSTRAINT highlight_pdf_anchors_highlight_id_fkey FOREIGN KEY (highlight_id) REFERENCES public.highlights(id);


--
-- Name: highlight_pdf_anchors highlight_pdf_anchors_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlight_pdf_anchors
    ADD CONSTRAINT highlight_pdf_anchors_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: highlight_pdf_quads highlight_pdf_quads_highlight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlight_pdf_quads
    ADD CONSTRAINT highlight_pdf_quads_highlight_id_fkey FOREIGN KEY (highlight_id) REFERENCES public.highlights(id);


--
-- Name: highlight_pdf_text_anchors highlight_pdf_text_anchors_highlight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlight_pdf_text_anchors
    ADD CONSTRAINT highlight_pdf_text_anchors_highlight_id_fkey FOREIGN KEY (highlight_id) REFERENCES public.highlights(id);


--
-- Name: highlight_pdf_text_anchors highlight_pdf_text_anchors_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlight_pdf_text_anchors
    ADD CONSTRAINT highlight_pdf_text_anchors_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: highlights highlights_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.highlights
    ADD CONSTRAINT highlights_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: libraries libraries_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.libraries
    ADD CONSTRAINT libraries_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: library_entries library_entries_library_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_entries
    ADD CONSTRAINT library_entries_library_id_fkey FOREIGN KEY (library_id) REFERENCES public.libraries(id);


--
-- Name: library_entries library_entries_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_entries
    ADD CONSTRAINT library_entries_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: library_entries library_entries_podcast_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_entries
    ADD CONSTRAINT library_entries_podcast_id_fkey FOREIGN KEY (podcast_id) REFERENCES public.podcasts(id);


--
-- Name: library_invitations library_invitations_invitee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_invitations
    ADD CONSTRAINT library_invitations_invitee_user_id_fkey FOREIGN KEY (invitee_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: library_invitations library_invitations_inviter_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_invitations
    ADD CONSTRAINT library_invitations_inviter_user_id_fkey FOREIGN KEY (inviter_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: library_invitations library_invitations_library_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_invitations
    ADD CONSTRAINT library_invitations_library_id_fkey FOREIGN KEY (library_id) REFERENCES public.libraries(id) ON DELETE CASCADE;


--
-- Name: llm_model_turn_continuations llm_model_turn_continuations_generation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_model_turn_continuations
    ADD CONSTRAINT llm_model_turn_continuations_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES public.llm_calls(id);


--
-- Name: llm_model_turn_continuations llm_model_turn_continuations_source_model_turn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_model_turn_continuations
    ADD CONSTRAINT llm_model_turn_continuations_source_model_turn_id_fkey FOREIGN KEY (source_model_turn_id) REFERENCES public.llm_model_turns(id);


--
-- Name: llm_model_turns llm_model_turns_generation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_model_turns
    ADD CONSTRAINT llm_model_turns_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES public.llm_calls(id);


--
-- Name: llm_tool_positions llm_tool_positions_generation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_tool_positions
    ADD CONSTRAINT llm_tool_positions_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES public.llm_calls(id);


--
-- Name: media_atlas_positions media_atlas_positions_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_atlas_positions
    ADD CONSTRAINT media_atlas_positions_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: media_claims media_claims_evidence_span_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_claims
    ADD CONSTRAINT media_claims_evidence_span_id_fkey FOREIGN KEY (evidence_span_id) REFERENCES public.evidence_spans(id);


--
-- Name: media_claims media_claims_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_claims
    ADD CONSTRAINT media_claims_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: media_claims media_claims_summary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_claims
    ADD CONSTRAINT media_claims_summary_id_fkey FOREIGN KEY (summary_id) REFERENCES public.media_summaries(id);


--
-- Name: media_file media_file_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_file
    ADD CONSTRAINT media_file_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: media_source_attempts media_source_attempts_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_source_attempts
    ADD CONSTRAINT media_source_attempts_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: media_source_attempts media_source_attempts_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_source_attempts
    ADD CONSTRAINT media_source_attempts_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.background_jobs(id) ON DELETE SET NULL;


--
-- Name: media_source_attempts media_source_attempts_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_source_attempts
    ADD CONSTRAINT media_source_attempts_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: media_summaries media_summaries_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_summaries
    ADD CONSTRAINT media_summaries_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: media_transcript_states media_transcript_states_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_transcript_states
    ADD CONSTRAINT media_transcript_states_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_library_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_library_id_fkey FOREIGN KEY (library_id) REFERENCES public.libraries(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: message_retrievals message_retrievals_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_retrievals
    ADD CONSTRAINT message_retrievals_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: message_retrievals message_retrievals_tool_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_retrievals
    ADD CONSTRAINT message_retrievals_tool_call_id_fkey FOREIGN KEY (tool_call_id) REFERENCES public.message_tool_calls(id);


--
-- Name: message_tool_calls message_tool_calls_assistant_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_tool_calls
    ADD CONSTRAINT message_tool_calls_assistant_message_id_fkey FOREIGN KEY (assistant_message_id) REFERENCES public.messages(id);


--
-- Name: message_tool_calls message_tool_calls_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_tool_calls
    ADD CONSTRAINT message_tool_calls_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: message_tool_calls message_tool_calls_user_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_tool_calls
    ADD CONSTRAINT message_tool_calls_user_message_id_fkey FOREIGN KEY (user_message_id) REFERENCES public.messages(id);


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: nexus_usages nexus_usages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nexus_usages
    ADD CONSTRAINT nexus_usages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: note_blocks note_blocks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.note_blocks
    ADD CONSTRAINT note_blocks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: oracle_corpus_sources oracle_corpus_sources_library_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_corpus_sources
    ADD CONSTRAINT oracle_corpus_sources_library_id_fkey FOREIGN KEY (library_id) REFERENCES public.libraries(id);


--
-- Name: oracle_corpus_sources oracle_corpus_sources_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_corpus_sources
    ADD CONSTRAINT oracle_corpus_sources_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: oracle_passage_anchors oracle_passage_anchors_corpus_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_passage_anchors
    ADD CONSTRAINT oracle_passage_anchors_corpus_source_id_fkey FOREIGN KEY (corpus_source_id) REFERENCES public.oracle_corpus_sources(id);


--
-- Name: oracle_reading_events oracle_reading_events_reading_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_reading_events
    ADD CONSTRAINT oracle_reading_events_reading_id_fkey FOREIGN KEY (reading_id) REFERENCES public.oracle_readings(id);


--
-- Name: oracle_reading_folios oracle_reading_folios_edge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_reading_folios
    ADD CONSTRAINT oracle_reading_folios_edge_id_fkey FOREIGN KEY (edge_id) REFERENCES public.resource_edges(id);


--
-- Name: oracle_reading_folios oracle_reading_folios_reading_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_reading_folios
    ADD CONSTRAINT oracle_reading_folios_reading_id_fkey FOREIGN KEY (reading_id) REFERENCES public.oracle_readings(id);


--
-- Name: oracle_readings oracle_readings_image_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_readings
    ADD CONSTRAINT oracle_readings_image_id_fkey FOREIGN KEY (image_id) REFERENCES public.oracle_plates(id);


--
-- Name: oracle_readings oracle_readings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oracle_readings
    ADD CONSTRAINT oracle_readings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: pages pages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pages
    ADD CONSTRAINT pages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: pdf_page_text_spans pdf_page_text_spans_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_page_text_spans
    ADD CONSTRAINT pdf_page_text_spans_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: podcast_episode_chapters podcast_episode_chapters_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_episode_chapters
    ADD CONSTRAINT podcast_episode_chapters_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: podcast_episodes podcast_episodes_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_episodes
    ADD CONSTRAINT podcast_episodes_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: podcast_episodes podcast_episodes_podcast_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_episodes
    ADD CONSTRAINT podcast_episodes_podcast_id_fkey FOREIGN KEY (podcast_id) REFERENCES public.podcasts(id) ON DELETE CASCADE;


--
-- Name: podcast_subscriptions podcast_subscriptions_podcast_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_subscriptions
    ADD CONSTRAINT podcast_subscriptions_podcast_id_fkey FOREIGN KEY (podcast_id) REFERENCES public.podcasts(id) ON DELETE CASCADE;


--
-- Name: podcast_subscriptions podcast_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_subscriptions
    ADD CONSTRAINT podcast_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: podcast_transcript_segments podcast_transcript_segments_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_transcript_segments
    ADD CONSTRAINT podcast_transcript_segments_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: podcast_transcription_jobs podcast_transcription_jobs_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_transcription_jobs
    ADD CONSTRAINT podcast_transcription_jobs_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: podcast_transcription_jobs podcast_transcription_jobs_requested_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_transcription_jobs
    ADD CONSTRAINT podcast_transcription_jobs_requested_by_user_id_fkey FOREIGN KEY (requested_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: podcast_transcription_usage_daily podcast_transcription_usage_daily_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.podcast_transcription_usage_daily
    ADD CONSTRAINT podcast_transcription_usage_daily_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: rate_limit_request_log rate_limit_request_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_request_log
    ADD CONSTRAINT rate_limit_request_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: reader_apparatus_edges reader_apparatus_edges_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_edges
    ADD CONSTRAINT reader_apparatus_edges_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: reader_apparatus_edges reader_apparatus_edges_media_id_state_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_edges
    ADD CONSTRAINT reader_apparatus_edges_media_id_state_id_fkey FOREIGN KEY (media_id, state_id) REFERENCES public.reader_apparatus_states(media_id, id);


--
-- Name: reader_apparatus_edges reader_apparatus_edges_media_id_state_id_from_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_edges
    ADD CONSTRAINT reader_apparatus_edges_media_id_state_id_from_item_id_fkey FOREIGN KEY (media_id, state_id, from_item_id) REFERENCES public.reader_apparatus_items(media_id, state_id, id);


--
-- Name: reader_apparatus_edges reader_apparatus_edges_media_id_state_id_to_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_edges
    ADD CONSTRAINT reader_apparatus_edges_media_id_state_id_to_item_id_fkey FOREIGN KEY (media_id, state_id, to_item_id) REFERENCES public.reader_apparatus_items(media_id, state_id, id);


--
-- Name: reader_apparatus_items reader_apparatus_items_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_items
    ADD CONSTRAINT reader_apparatus_items_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: reader_apparatus_items reader_apparatus_items_media_id_state_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_items
    ADD CONSTRAINT reader_apparatus_items_media_id_state_id_fkey FOREIGN KEY (media_id, state_id) REFERENCES public.reader_apparatus_states(media_id, id);


--
-- Name: reader_apparatus_states reader_apparatus_states_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_apparatus_states
    ADD CONSTRAINT reader_apparatus_states_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: reader_profiles reader_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reader_profiles
    ADD CONSTRAINT reader_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: resource_edges resource_edges_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_edges
    ADD CONSTRAINT resource_edges_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: resource_external_snapshots resource_external_snapshots_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_external_snapshots
    ADD CONSTRAINT resource_external_snapshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: resource_mutations resource_mutations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_mutations
    ADD CONSTRAINT resource_mutations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: resource_versions resource_versions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_versions
    ADD CONSTRAINT resource_versions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: resource_view_states resource_view_states_edge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_view_states
    ADD CONSTRAINT resource_view_states_edge_id_fkey FOREIGN KEY (edge_id) REFERENCES public.resource_edges(id);


--
-- Name: resource_view_states resource_view_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_view_states
    ADD CONSTRAINT resource_view_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: stream_token_jti_claims stream_token_jti_claims_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stream_token_jti_claims
    ADD CONSTRAINT stream_token_jti_claims_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: synapse_suppressions synapse_suppressions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.synapse_suppressions
    ADD CONSTRAINT synapse_suppressions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_media_deletions user_media_deletions_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_media_deletions
    ADD CONSTRAINT user_media_deletions_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id);


--
-- Name: user_media_deletions user_media_deletions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_media_deletions
    ADD CONSTRAINT user_media_deletions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: viewer_collection_revisions viewer_collection_revisions_viewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.viewer_collection_revisions
    ADD CONSTRAINT viewer_collection_revisions_viewer_id_fkey FOREIGN KEY (viewer_id) REFERENCES public.users(id);


--
-- Name: workspace_sessions workspace_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_sessions
    ADD CONSTRAINT workspace_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--


