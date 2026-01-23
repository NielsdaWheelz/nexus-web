# S3 PR Roadmap

Compressed: 7 core PRs + 2 optional follow-ups.

**Principles:**
1. One migration per slice (no reason to split)
2. Schema + service layer that makes it meaningful in same PR
3. Boundaries: LLM adapters separate from send endpoint, backend separate from frontend

---

## PR-A: Slice 3 Schema Mega-Migration + Core Utilities

**Backend only — big but it's only schema + helpers, no routes**

### Migration

Alembic `0004_slice3_schema.py` adds all S3 tables:

**Chat core:**
- `conversation` (id, owner_user_id, sharing, next_seq, timestamps)
- `models` (id, provider, model_name, max_context_tokens, cost fields, is_available)
- `message` (id, conversation_id, seq, role, content, status, model_id FK nullable, timestamps)
  - `UNIQUE (conversation_id, seq)`
  - `CHECK`: `status=pending` only when `role=assistant`

**LLM metadata + keys:**
- `message_llm` (id, message_id, provider, model_name, tokens, latency, cost, error_class)
- `user_api_key` (id, user_id, provider, encrypted_key, nonce, key_fingerprint, status, timestamps)
- `idempotency_keys` (id, user_id, key, payload_hash, response_json, timestamps)

**Context + sharing:**
- `message_context` (id, message_id, ordinal, target_type, media_id, highlight_id, annotation_id, message_id)
  - `CHECK`: exactly one FK column non-null
- `conversation_media` (conversation_id, media_id) with `UNIQUE (conversation_id, media_id)`
- `conversation_share` (conversation_id, library_id) composite PK

**Content blocks:**
- `fragment_block` (id, fragment_id FK, block_idx, start_offset, end_offset, block_type nullable)
  - `UNIQUE (fragment_id, block_idx)`

**Search indexes:**
- Generated stored tsvector columns + GIN indexes:
  - `media.title_tsv`
  - `fragment.canonical_text_tsv`
  - `annotation.body_tsv`
  - `message.content_tsv`
- Migration note in comments: "use CREATE INDEX CONCURRENTLY manually if needed in prod"

### Core Utilities

**Seq assignment helper:**
- `get_next_seq(conversation_id)` — `FOR UPDATE` on conversation row, increment `next_seq`

**Crypto module** (`services/crypto.py`):
- `encrypt_api_key(plaintext: bytes, nonce: bytes) -> bytes`
- `decrypt_api_key(ciphertext: bytes, nonce: bytes) -> bytes`
- PyNaCl XChaCha20-Poly1305 (libsodium bindings)
- Load master key from `NEXUS_KEY_ENCRYPTION_KEY` env, validate 32-byte length on startup

**Context window helper:**
- `get_context_window(fragment_id, start_offset, end_offset) -> ContextWindow`
  - If `fragment_block` rows exist: find containing block + adjacent blocks, cap at 2500 chars
  - Else: fallback to ±600 chars from highlight boundaries
- `ContextWindow` dataclass: `text: str`, `source: "blocks" | "fallback"`

**Ingestion hook (required):**
- Update web article ingestion to write `fragment_block` rows for new fragments
- Compute blocks from canonicalization output (block elements already identified)

**Services scaffolds** (impl details in later PRs):
- `services/shares.py` — share invariants (impl in PR-B)
- `services/contexts.py` — context insertion + `conversation_media` management

### Tests

- **Deterministic seq lock test:**
  1. Session A: lock conversation row `FOR UPDATE`, read `next_seq`, hold transaction open
  2. Session B: attempt to lock same row → must block until A commits
  3. Session A: insert message with seq, commit
  4. Session B: unblocks, gets incremented seq, inserts, commits
  5. Assert both messages exist with consecutive seqs, no duplicates
- Crypto round-trip (ciphertext differs each call)
- Context window uses blocks when present, fallback when missing
- Migration applies cleanly, tsvector columns are GENERATED STORED, GIN indexes exist
- **New ingests create fragment_block rows**

---

## PR-B: Conversations + Messages CRUD Endpoints

**Backend**

### Routes

- `GET /conversations` — list user's conversations (paginated)
- `POST /conversations` — create empty conversation
- `GET /conversations/:id` — get conversation details
- `DELETE /conversations/:id` — delete conversation (cascades)
- `GET /conversations/:id/messages` — list messages (paginated, oldest first)
- `DELETE /messages/:id` — delete single message

### Service Layer

**Conversation/message CRUD:**
- Owner-only visibility (plus public admin-only flag accepted but not settable)
- Delete last message deletes conversation
- `conversation.updated_at` management

**Shares service** (`services/shares.py`):
- `set_shares(conversation_id, library_ids: list[UUID])` — bulk set shares
- `delete_share(conversation_id, library_id)` — with auto-flip to private if last share
- Enforce invariants:
  - `sharing=private` forbids any shares
  - `sharing=library` requires ≥1 share
  - Owner must be member of library to add share

**Context service** (`services/contexts.py`):
- Insert contexts (ordinal unique)
- Validate `target_type` matches non-null FK in service before insert
- Compute `media_id` for context (media: direct, highlight/annotation: via fragment.media_id)
- Transactionally upsert `conversation_media` on context insert
- `recompute_conversation_media(conversation_id)` helper

### Tests

- Integration tests for CRUD + invariants
- Share invariant tests:
  - Delete last share flips `sharing` to `private`
  - Cannot add share when `sharing=private`
  - Cannot set `sharing=library` with empty shares
- Context cascade: highlight/annotation delete updates `conversation_media` via recompute
- Service rejects mismatched `target_type`

**Non-goals:**
- **No `POST /conversations/:id/messages`** — message creation reserved for PR-E (prevents dual codepaths for seq/idempotency/contexts)

---

## PR-C: Models + API Keys Endpoints

**Backend**

### Routes

- `GET /models` — filters by provider availability (platform key exists or valid BYOK)
- `GET /keys` — fingerprints only, never decrypted key
- `POST /keys` — upsert by provider (encrypt at rest)
- `DELETE /keys/:id` — revoke (sets `revoked_at`)
- `POST /keys/:id/test` — minimal provider call to validate key, updates status

### Service Layer

- Key upsert-by-provider logic
- Key status updates (valid/invalid/unknown)
- Integration with crypto module from PR-A

### Tests

- Never returns decrypted key
- Key fingerprint visible
- Revoke sets `revoked_at`
- Test endpoint updates status on success/failure

**Note:** Test endpoint requires at least one provider adapter stub. Either mock HTTP at router level, or add this route in PR-D instead.

---

## PR-D: LLM Adapter Layer (All 3 Providers)

**Backend — one "heavy" PR but self-contained**

### Structure

Create `services/llm/`:

```python
# adapter.py
class LLMAdapter(ABC):
    @abstractmethod
    def generate(self, messages, model, max_tokens) -> LLMResponse:
        """Synchronous generation, returns complete response."""

    @abstractmethod
    def generate_stream(self, messages, model, max_tokens) -> Iterator[LLMChunk]:
        """Streaming generation, yields chunks."""
```

- `openai_adapter.py` — OpenAI implementation
- `anthropic_adapter.py` — Anthropic implementation
- `gemini_adapter.py` — Gemini implementation
- `router.py` — chooses adapter based on model/provider, decides sync vs stream

### HTTP Client

**Decision: raw httpx (no official SDKs)**
- Consistent approach across all 3 providers
- Easier test mocking with respx
- Pin exact API endpoints and request/response formats per provider in code comments

**Timeouts:**
- Connect: 10s
- Read: 45s (matches LLM call limit)
- Write: 10s

### Error Normalization

**In router (one place, not per adapter):**
- Provider 401/403 → `E_LLM_INVALID_KEY`
- Provider 429 → `E_LLM_RATE_LIMIT`
- Timeout → `E_LLM_TIMEOUT`
- Other → `E_LLM_PROVIDER_DOWN`

### Prompt Renderer

- System prompt v1
- Context blocks using `get_context_window()` from PR-A

### Feature Flags

- `ENABLE_OPENAI`, `ENABLE_ANTHROPIC`, `ENABLE_GEMINI`
- All 3 adapters implemented and tested; flags control availability to users

### Tests

- Unit tests for prompt rendering (no network)
- Adapter error mapping using mocked HTTP responses (respx)
- Per-provider happy path + error normalization (401/403/429/timeouts)
- Streaming chunk parsing tests (mock yields chunks)

---

## PR-E: Send-Message Endpoint + Idempotency + Rate Limits + Token Budget

**Backend — depends on PR-A + PR-D**

### Route

`POST /conversations/{id?}/messages`

### Pre-Phase Validation

Return 4xx, **no pending assistant created, no `message_llm` row:**
- No key available → `E_LLM_NO_KEY`
- Model not available → `E_MODEL_NOT_AVAILABLE`
- Message too long → `E_MESSAGE_TOO_LONG`
- Context too large → `E_CONTEXT_TOO_LARGE`
- Rate limit exceeded → `E_LLM_RATE_LIMIT` (429)
- Token budget exceeded → `E_TOKEN_BUDGET_EXCEEDED` (429)

### Three-Phase Flow

1. **Phase 1:** Create user msg + contexts + `conversation_media` + assistant pending + idempotency row
2. **Phase 2:** Call LLM with 45s timeout — **`message_llm` row created here** (provider + model resolved)
3. **Phase 3:** Finalize assistant content + complete `message_llm` row

### `message_llm` Storage Rules

- Only create row when Phase 2 **starts**
- On LLM success: full row with tokens, latency, cost
- On LLM failure: row with `error_class`, partial fields (provider, model_name, latency)
- Pre-phase validation failures: **no row**

### Idempotency Behavior

- Replay with same payload hash → return cached result
- Replay with different payload hash → `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH` (409)

### Limits

- Message length ≤ 20k chars
- Contexts ≤ 10
- Rendered context ≤ 25k chars

### Gating

- Quote-to-chat only when `can_quote=true` (processing_status rules + PDF `has_plain_text`)

### Rate Limiting (Redis)

- N requests/minute per user (configurable, e.g., 20/min)
- N concurrent in-flight sends per user (e.g., 3)

### Platform Key Token Budget

- Per-user daily token limit when using `key_mode=platform` (configurable, e.g., 100k tokens/day)
- Tracked in Redis with daily expiry
- `E_TOKEN_BUDGET_EXCEEDED` when limit hit
- BYOK users: no budget limit

### Service Enforcement

- Pending assistant must be last message (check that last seq is the one just created)
- Not enforced via DB constraint (too complex)

### Tests

- Idempotency replay returns same result
- Mismatch returns 409
- LLM failure creates assistant error + `message_llm` row + returns non-2xx
- Pre-validation failure: no pending assistant created, no `message_llm` row
- Pending assistant must be last
- Rate limit returns 429
- Token budget enforced for platform key

---

## PR-F: Keyword Search Endpoint

**Backend — GIN indexes already exist from PR-A**

### Visibility CTE

Add `services/visibility.py`:
- `visible_media_ids_cte(viewer_user_id) -> CTE`
  - Reusable SQL CTE: `SELECT media_id FROM library_media JOIN membership...`
  - Use everywhere: fragments, annotations, media searches

### Route

`GET /search`:
- Types filtering (`media`, `fragment`, `annotation`, `message`)
- Scope filtering (`all`, `media:<id>`, `library:<id>`, `conversation:<id>`)
- **Visibility filtering via SQL CTE (not post-filter):**
  1. Use `visible_media_ids_cte(viewer)` for media-anchored content
  2. Search `fragments`/`annotations`/`media` restricted to visible_media_ids
  3. Search `messages` restricted to `conversation.owner_user_id = viewer` (S3) or `sharing=public`
- Snippets generated via `ts_headline` on filtered results

### Tests

- Search hits across types
- Search never leaks invisible results
- Library scope excludes conversations in S3
- Snippet length cap
- Performance: EXPLAIN shows GIN index usage

---

## PR-G: Frontend — Chat UI + Quote-to-Chat + BFF Routes

**Frontend — combines BFF + basic UI + quote wiring**

### BFF Routes (Thin Proxies)

- `GET /api/conversations` → FastAPI
- `POST /api/conversations` → FastAPI
- `GET /api/conversations/:id` → FastAPI
- `DELETE /api/conversations/:id` → FastAPI
- `GET /api/conversations/:id/messages` → FastAPI
- `POST /api/conversations/:id/messages` → FastAPI (non-streaming)
- `GET /api/models` → FastAPI
- `GET /api/keys` → FastAPI
- `POST /api/keys` → FastAPI
- `DELETE /api/keys/:id` → FastAPI
- `GET /api/search` → FastAPI

### Chat UI (Non-Streaming)

- Conversation list component
- Message thread component
- Input with send button
- Loading states
- Model selection dropdown
- "Chat without quote" entry point (nav button or empty state)

### Quote-to-Chat Wiring

- In media pane: "quote to chat" action from highlight selection
  - Opens chat pane with highlight as context
- Linked-items pane: show conversations list from `conversation_media`
- Wire up context attachment in send flow

### Tests

- Vitest for components (happy-dom)
- Proxy allowlist checks
- Quote-to-chat interaction tests

---

## PR-H (Optional): Streaming End-to-End

**Backend + BFF + UI — ship non-streaming first, add this as follow-up**

### Protocol

Server-Sent Events (SSE) — `text/event-stream`
- Event format: `data: {"content": "...", "done": false}\n\n`
- Final event: `data: {"content": "", "done": true, "message_id": "..."}\n\n`

### Backend

- `POST /.../messages?stream=1` returns SSE response
- Router calls `adapter.generate_stream()` (defined in PR-D)
- Wraps chunks in SSE format

### BFF

- `POST /api/conversations/:id/messages?stream=1` — streaming proxy
- Header allowlist: include `text/event-stream`
- Must NOT buffer whole response

### UI

- Streaming display (append chunks as they arrive)
- Handle SSE events

### Storage

- Finalize assistant content once at stream end
- No partial DB writes in v1

### Tests

- Backend unit test for streaming generator
- Node-level BFF integration test (verify chunks arrive incrementally)
- Streaming display test (mock SSE events)

---

## PR-I (Optional): Pending Assistant Cleanup Task

**Backend + Tasks — can fold into PR-E if fewer PRs desired**

### Celery Beat Task

- Query `message WHERE status='pending' AND created_at < now() - interval '5 min'`
- Update to `status='error'`, `content='Request timed out'`
- Log cleanup count

### Observability

- Logging fields: `provider`, `model_name`, `key_mode`, `latency_ms`, `tokens_total`
- Metrics hooks (optional, for future Prometheus/DataDog):
  - `llm_request_total` counter
  - `llm_request_duration_seconds` histogram
  - `llm_tokens_total` counter

### Tests

- Cleanup task marks stale pending as error
- Cleanup task ignores recent pending

---

## Summary

| # | PR | Scope | Key Content |
|---|-----|-------|-------------|
| 1 | PR-A | Backend | Schema mega-migration + seq/crypto/context helpers + ingestion hook |
| 2 | PR-B | Backend | Conversations/messages CRUD + shares service + context service |
| 3 | PR-C | Backend | Models + API keys endpoints |
| 4 | PR-D | Backend | LLM adapter layer (all 3 providers) + error normalization |
| 5 | PR-E | Backend | Send-message endpoint + idempotency + rate limits + token budget |
| 6 | PR-F | Backend | Keyword search endpoint + visibility CTE |
| 7 | PR-G | Frontend | BFF routes + chat UI + quote-to-chat |
| 8 | PR-H | Full stack | (Optional) Streaming end-to-end |
| 9 | PR-I | Backend | (Optional) Pending cleanup task + metrics |

**Key Decisions:**
- One migration (0004) for all S3 schema
- Raw httpx for all LLM providers (no SDKs)
- XChaCha20-Poly1305 via PyNaCl for key encryption
- SSE for streaming protocol
- SQL CTE for visibility filtering
- Two-phase transaction model (no DB txn during LLM call)
- Pre-validation failures create no DB artifacts
- Platform key safety via rate limits + daily token budget
- GIN indexes in migration (use CONCURRENTLY manually in prod if needed)
