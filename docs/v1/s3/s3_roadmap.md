# S3 PR Roadmap

Stacked, reviewable, minimal blast radius.

---

## PR-01: Schema Migration — Conversations + Messages Core

**Backend only**

- Alembic revision `0004_slice3_chat_core.py`
- Add tables:
  - `conversation` (id, owner_user_id, sharing, next_seq, timestamps)
  - `message` (id, conversation_id, seq, role, content, status, model_id nullable, timestamps)
- Constraints:
  - `UNIQUE (conversation_id, seq)`
  - `CHECK`: `status=pending` only when `role=assistant`
- Add service helper for seq assignment using `FOR UPDATE` on conversation row (no LLM yet)
- Tests:
  - seq monotonic under concurrency (spawn N threads/processes calling assign)
  - pending assistant must be last (enforced in service)

**Non-goals:**
- No endpoints yet
- No LLM

---

## PR-02: Schema Migration — Models Registry + LLM Metadata + API Keys + Idempotency

**Backend only**

- Alembic `0005_slice3_llm_schema.py`
- Add tables:
  - `models`
  - `message_llm`
  - `user_api_key`
  - `idempotency_keys`
- Add config plumbing:
  - Env vars for platform keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or similar)
  - Encryption key env var
- Tests:
  - `user_api_key` encryption round-trip unit test (libsodium)
  - Idempotency uniqueness + replay mismatch behavior (db + service)

---

## PR-03: Schema Migration — message_context + conversation_media

**Backend only**

- Alembic `0006_slice3_context_schema.py`
- Add tables:
  - `message_context` with "exactly one FK non-null" check
  - `conversation_media` with `UNIQUE (conversation_id, media_id)`
- Service layer:
  - Insert contexts (ordinal unique)
  - Compute `media_id` for context:
    - `media`: direct
    - `highlight`/`annotation`: via `fragment.media_id`
    - `message`/`conversation` refs: ignored for `conversation_media` (direct-only rule)
  - Transactionally upsert `conversation_media` on context insert
  - Recompute helper `recompute_conversation_media(conversation_id)`
- Tests:
  - `conversation_media` updated on insert/delete
  - Context CASCADE delete on highlight/annotation delete updates `conversation_media` (via recompute)

---

## PR-04: Keyword Search Schema — Generated tsvectors + GIN Indexes

**Backend only**

- Alembic `0007_slice3_search_tsv.py`
- Add generated stored tsvector columns + GIN indexes:
  - `media.title_tsv`
  - `fragment.canonical_text_tsv`
  - `annotation.body_tsv`
  - `message.content_tsv`
- Tests:
  - Migration applies cleanly on fresh db
  - Simple search query returns hits across types (no visibility filtering yet)

---

## PR-05: FastAPI Endpoints — Conversations + Messages (No LLM)

**Backend**

- Routes:
  - `GET /conversations`
  - `POST /conversations` (optional; can be used by UI)
  - `GET /conversations/:id`
  - `DELETE /conversations/:id`
  - `GET /conversations/:id/messages`
- Core rules:
  - Owner-only visibility for now (plus public admin-only flag accepted but not settable)
  - Delete last message deletes conversation
- Tests:
  - Integration tests for CRUD + invariants

---

## PR-06: FastAPI Endpoints — API Keys + Models Listing

**Backend**

- Routes:
  - `GET /models` — filters by provider availability (platform key or valid BYOK)
  - `GET /keys` — fingerprints only
  - `POST /keys` — upsert by provider (encrypt at rest)
  - `DELETE /keys/:id` — revoke
  - `POST /keys/:id/test` — optional; can stub minimal call
- Tests:
  - Never returns decrypted key
  - Status transitions on test

---

## PR-07: LLM Adapter Layer (Providers + Feature Flags) + Prompt Rendering

**Backend**

- Create `services/llm/`:
  - `adapter.py` interface
  - `openai_adapter.py`, `anthropic_adapter.py`, `gemini_adapter.py`
  - `llm_router.py` — chooses adapter based on model/provider + flags
- Implement:
  - Key resolution (`auto` | `byok_only` | `platform_only`)
  - Error normalization to your error codes
- Prompt renderer with:
  - System prompt v1
  - Context blocks
  - Fallback ±600 chars if `fragment_block` missing (no backfill)
- Add feature flags in config:
  - `ENABLE_OPENAI`, `ENABLE_ANTHROPIC`, `ENABLE_GEMINI`
- Tests:
  - Unit tests for prompt rendering (no network)
  - Adapter error mapping using mocked HTTP responses

---

## PR-08: Send-Message Endpoint — Two-Phase + Idempotency + LLM Writeback (Non-Streaming)

**Backend**

- Implement `POST /conversations/{id?}/messages` as spec:
  - Phase 1: create user msg + contexts + `conversation_media` + assistant pending + idempotency row
  - Phase 2: call LLM
  - Phase 3: finalize assistant + `message_llm` row
- Enforce limits:
  - Message length
  - Contexts ≤ 10
  - Rendered context ≤ 25k chars
- Gating:
  - Quote-to-chat only when `can_quote=true` (processing_status rules + PDF `has_plain_text`)
- Tests:
  - Idempotency replay returns same result
  - Mismatch returns 409
  - LLM failure creates assistant error + returns non-2xx
  - Pending assistant must be last

---

## PR-09: Streaming Support (Flagged) — Server-Sent Events Through BFF

**Backend + BFF**

- Backend: `POST /.../messages?stream=1` returns SSE or chunked response
- BFF: proxy streaming response to browser (careful header allowlist)
- Storage:
  - You still finalize assistant content once at end
  - No partial DB writes (or optional periodic flush behind flag)
- Tests:
  - Backend unit test for streaming generator
  - Minimal BFF integration test that pipes a stream (can be node-level test)

---

## PR-10: Search Endpoint — Visibility Filtered + Scoped

**Backend**

- `GET /search` implementing:
  - Types filtering
  - Scope filtering
  - Visibility filtering via `can_read_media_bulk` and ownership rules
  - Snippets generated post-filter (`ts_headline`)
- Tests:
  - Search never leaks invisible results
  - Library scope excludes conversations in S3
  - Snippet length cap

---

## PR-11: Frontend UI — Chat Pane + Model Dropdown + Send + Quote-to-Chat Wiring

**Frontend**

- Add chat pane UI
- Add model selection + key mode selection (optional advanced)
- Add "chat without quote" entry point
- In media pane: add "quote to chat" action from highlight selection
- Linked-items pane: show conversations list from `conversation_media`
- Tests:
  - Vitest for components (happy-dom)

---

## PR-12: Hardening — Cleanup Pending Assistants + Metrics Hooks

**Backend + Tasks**

- Celery beat task to mark pending >5 min as error
- Basic per-user rate limits (even with BYOK)
- Add logging fields (`provider`, `model`, `key_mode`, `latency_ms`)
- Tests:
  - Cleanup task behavior
