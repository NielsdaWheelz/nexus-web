# Slice 3 Spec — Chat, Quote-to-Chat, Keyword Search (v1)

This slice connects reading to thinking. It introduces conversations, messages, LLM execution, quote-to-chat, and keyword search, while preserving all visibility, immutability, and deletion invariants defined in the Constitution and earlier slices.

This slice MUST NOT introduce library sharing UI (S4), semantic search (S9), summarization, message editing, or branching.

---

## 1) Goals

### Primary
- Allow users to:
  - Create conversations
  - Send messages with or without quoted context
  - Receive LLM responses using selected models
  - Find content via keyword search

### Secondary
- Enforce strict visibility guarantees
- Ensure all destructive operations are consistent and testable
- Normalize multi-provider LLM usage (OpenAI, Anthropic, Gemini)
- Support platform key + BYOK safely

---

## 2) Non-Goals (Explicit)

- No message editing or branching
- No multi-author conversations
- No summarization
- No semantic / vector search
- No library sharing UI
- No tools / function calling
- No public sharing UI (public state exists but is admin-only)
- No user-facing media deletion (media rows persist per Constitution)

---

## 3) New Data Models

### 3.1 `conversation`

```
conversation
- id (UUID, PK)
- owner_user_id (FK → users, CASCADE)
- sharing (private|library|public)  – default: private
- next_seq (INTEGER, NOT NULL, default: 1)  – pre-allocated sequence counter
- created_at
- updated_at
```

**Invariants:**
- A conversation belongs to exactly one user.
- No messages may exist without a conversation.
- `sharing=private` forbids any `conversation_share` rows.
- `sharing=library` requires ≥1 `conversation_share` rows (enforced at write time).
- `sharing=public` exists but cannot be set via public API in v1 (enforced via admin token claim check; feature flag `ALLOW_PUBLIC_CONVERSATIONS` must be enabled).

---

### 3.2 `conversation_share`

```
conversation_share
- conversation_id (FK → conversation, CASCADE, PK part)
- library_id (FK → libraries, CASCADE, PK part)
- created_at
- UNIQUE(conversation_id, library_id)
```

**Constraints:**
- At write time: owner must be a member of `library_id` (any role).
- Insertion forbidden when `conversation.sharing = private`.

**Last-share deletion behavior (definitive):**
- Deleting the last share when `sharing=library` auto-transitions `sharing` to `private`.
- Response returns 200 with updated conversation object showing `sharing=private`.
- Deleting a library cascades to `conversation_share` rows; if that empties shares for a `sharing=library` conversation, the conversation transitions to `private`.

**Notes:**
- S4 will add UI for managing shares. S3 needs the table for invariants + tests.

---

### 3.3 `message`

```
message
- id (UUID, PK)
- conversation_id (FK → conversation, CASCADE)
- seq (INTEGER, NOT NULL)            – strictly increasing per conversation
- role (user|assistant|system)
- content (TEXT, NOT NULL)           – empty string allowed for pending assistant
- status (pending|complete|error)    – default: complete
- model_id (FK → models, nullable)   – null for user/system messages
- created_at
- updated_at
```

**Invariants:**
- `(conversation_id, seq)` is unique (with retry on conflict).
- `seq` is assigned via `conversation.next_seq` under row lock (see §5.2).
- Messages are append-only.
- Messages may be deleted (see §9).

**Content immutability rules:**
- `role=user` and `role=system`: `content` is immutable immediately (set at insert).
- `role=assistant` with `status=pending`: `content` may be updated **exactly once** to transition to `complete` or `error`.
- After `status=complete` or `status=error`: `content` is immutable.
- `status=pending` is only valid for `role=assistant`.
- A pending assistant message must be the **last message** in the conversation at time of insert (prevents interleaving).

---

### 3.4 `message_llm`

LLM execution metadata for assistant messages.

```
message_llm
- message_id (FK → message, CASCADE, PK)
- provider (openai|anthropic|gemini)
- model_name (TEXT)
- prompt_tokens (INTEGER)
- completion_tokens (INTEGER)
- total_tokens (INTEGER)
- key_mode (platform|byok)
- cost_usd_micros (INTEGER, nullable)  – cost in millionths of USD
- latency_ms (INTEGER)
- error_class (TEXT, nullable)         – e.g. rate_limit, invalid_key, timeout
- prompt_version (TEXT)                – e.g. "s3_v1"
- created_at
```

**Purpose:**
- Billing and cost tracking
- Debugging and latency analysis
- Abuse detection (per-user token burn rate)
- BYOK vs platform key audit trail

---

### 3.5 `models` (Registry)

```
models
- id (UUID, PK)
- provider (openai|anthropic|gemini)
- model_name (TEXT)
- max_context_tokens (INTEGER)
- cost_per_1k_input_tokens_usd (INTEGER, nullable)   – micros
- cost_per_1k_output_tokens_usd (INTEGER, nullable)  – micros
- is_available (BOOLEAN)
```

**Notes:**
- Registry is global.
- Availability is filtered per user based on key availability (see §4.3).
- Model registry is seeded manually in v1.

---

### 3.6 `user_api_key`

```
user_api_key
- id (UUID, PK)
- user_id (FK → users, CASCADE)
- provider (openai|anthropic|gemini)
- encrypted_key (BYTEA)
- key_nonce (BYTEA, 24 bytes)         – unique per row
- master_key_version (INTEGER)        – for key rotation
- key_fingerprint (TEXT)              – last 4 chars for display
- status (untested|valid|invalid|revoked)  – default: untested
- created_at
- last_tested_at (nullable)
- revoked_at (nullable)
```

**Key validity states:**
| Status | Meaning |
|--------|---------|
| `untested` | Newly added, never used |
| `valid` | Last provider call succeeded |
| `invalid` | Last provider call returned auth error (401/403) |
| `revoked` | User explicitly revoked (soft delete) |

**Status transitions:**
- On successful LLM call → `valid`, update `last_tested_at`
- On provider 401/403 → `invalid`, update `last_tested_at`
- On user revoke → `revoked`, set `revoked_at`
- Other errors (rate limit, timeout) → status unchanged

**Security (see §4.6 for full spec):**
- Keys are encrypted at rest using envelope encryption.
- Decryption occurs only in FastAPI memory.
- Keys are never returned to clients or logged.

---

### 3.7 `message_context`

Typed context links with referential integrity.

```
message_context
- id (UUID, PK)
- message_id (FK → message, CASCADE)
- target_type (media|highlight|annotation|message|conversation)
- ordinal (INTEGER, NOT NULL)          – display order within message
- media_id (FK → media, CASCADE, nullable)
- highlight_id (FK → highlights, CASCADE, nullable)
- annotation_id (FK → annotations, CASCADE, nullable)
- message_ref_id (FK → message, CASCADE, nullable)
- conversation_ref_id (FK → conversation, CASCADE, nullable)
- created_at
```

**Constraints:**
- CHECK: exactly one of the nullable FK columns is non-null.
- `target_type` must match the non-null FK (enforced by CHECK or trigger).
- UNIQUE `(message_id, ordinal)`.

**Deletion behavior (hard delete):**
- When a context target is deleted, `message_context` rows referencing it are **deleted** (CASCADE).
- Audit trail lives in application logs, not in dangling DB rows.
- This keeps the DB clean and simplifies `conversation_media` recomputation.

**Rules:**
- Only direct context targets are stored.
- Context does NOT expand visibility.
- Context targets invisible to a viewer are omitted from API responses.

---

### 3.8 `conversation_media` (Derived)

```
conversation_media
- conversation_id (FK → conversation, CASCADE)
- media_id (FK → media, CASCADE)
- last_message_at
- UNIQUE(conversation_id, media_id)
```

**Rules:**
- Updated transactionally when `message_context` is inserted or deleted.
- Derived only from direct contexts (where `media_id` is set, or computed from highlight/annotation).
- Recomputable via internal repair helper.

---

### 3.9 `fragment_block`

Block boundary index for context window computation.

```
fragment_block
- id (UUID, PK)
- fragment_id (FK → fragments, CASCADE)
- block_idx (INTEGER, NOT NULL)        – 0-indexed within fragment
- start_offset (INTEGER, NOT NULL)     – codepoint offset in canonical_text
- end_offset (INTEGER, NOT NULL)       – codepoint offset (exclusive)
- block_type (TEXT, nullable)          – e.g. 'p', 'li', 'h1' (optional metadata)
- UNIQUE(fragment_id, block_idx)
```

**Purpose:**
- Enables deterministic block-based context windows without DOM traversal at query time.
- Created during canonicalization (ingestion pipeline).

**Invariants:**
- Blocks are contiguous and non-overlapping within a fragment.
- `block[i].end_offset == block[i+1].start_offset` (no gaps).
- Union of all blocks covers entire `canonical_text`.

---

## 4) LLM Execution Model

### 4.1 Provider Strategy
- Supported providers: OpenAI, Anthropic, Gemini
- Platform key available by default
- BYOK optional per provider

---

### 4.2 Key Mode and Resolution

Each message request includes an optional `key_mode` parameter:

| `key_mode` | Behavior |
|------------|----------|
| `auto` (default) | Try BYOK first, fall back to platform key |
| `byok_only` | Use only user's key; fail if missing/invalid |
| `platform_only` | Use only platform key; fail if unavailable |

**Key validity definition:**
A user key is "valid" for resolution if:
- `status` is `untested` or `valid` (not `invalid` or `revoked`)
- `revoked_at` is NULL

**Resolution algorithm:**
1. If `key_mode=byok_only`:
   - Require valid user key for provider
   - If missing/invalid → `E_LLM_NO_KEY`
2. If `key_mode=platform_only`:
   - Require platform key for provider
   - If unavailable → `E_LLM_NO_KEY`
3. If `key_mode=auto`:
   - If user has valid BYOK → use it
   - Else if platform key exists → use it
   - Else → `E_LLM_NO_KEY`

**Post-call status update:**
- If provider returns 401/403 on BYOK → set `status=invalid`
- On success → set `status=valid`

**Stored for audit:** `message_llm.key_mode` records which mode was used.

---

### 4.3 Model Availability Rules

A model is available to a user iff:

```
model.is_available = true
AND (
  user has valid key for model.provider
  OR platform key exists for model.provider
)
```

**API behavior:**
- `GET /models` returns only available models for the requesting user.
- Requesting unavailable model → `E_MODEL_NOT_AVAILABLE`.
- If user selects `key_mode=byok_only` and has no valid BYOK → model list filtered to empty for that provider.

---

### 4.4 System Prompt (v1)

Short, stable, versioned.

```
You are a careful assistant.
Answer only using the provided context when possible.
Quote directly when citing.
If information is missing or uncertain, say so.
```

Stored as `prompt_version = "s3_v1"`.

---

### 4.5 Context Rendering Contract

Contexts are rendered as structured markdown blocks:

```markdown
Source: <title>
<metadata>

> quoted text
> quoted text

Context:
<surrounding text>
```

#### Context Inclusion Algorithm

**For HTML/EPUB (using `fragment_block` index):**
1. Find block where `start_offset >= block.start_offset AND start_offset < block.end_offset`.
2. Include that block's text slice from `canonical_text`.
3. Include previous block (if exists and non-empty).
4. Include next block (if exists and non-empty).
5. Cap total context at 2,500 chars.

**For transcripts (segment-based):**
1. Identify segment idx containing the highlight.
2. Include segments `[idx-2, idx+2]` (5 segments max).
3. Each segment includes timestamp (`hh:mm:ss`) and `speaker_label` if present.

**Fallback (no `fragment_block` data):**
- ±600 chars from highlight boundaries.
- Total cap: 2,500 chars.

**Multi-highlight in same fragment:**
- Merge overlapping context windows.
- Deduplicate before rendering.

#### Rules

- Exact quote (`highlight.exact`) is always included.
- Max contexts per message: **10**
- Max total rendered context chars: **25,000**

---

### 4.6 Key Encryption Specification

**Algorithm:** XChaCha20-Poly1305 (libsodium `crypto_secretbox_easy`)

**Storage per row:**
- `encrypted_key`: ciphertext (key + 16-byte auth tag)
- `key_nonce`: 24-byte random nonce (unique per row)
- `master_key_version`: integer identifying which master key was used

**Master key management:**
- Master key loaded from `NEXUS_KEY_ENCRYPTION_KEY` env var (base64-encoded 32 bytes).
- Key rotation: new rows use new version; old rows decryptable until migration.
- Migration helper re-encrypts rows with old version on demand.

**Logging rules:**
- Never log decrypted key material.
- Log only `key_fingerprint` (last 4 chars) for debugging.
- Redact any key-like strings in error messages.

---

### 4.7 Limits

| Item | Limit |
|---|---|
| Message content | 20,000 chars |
| Context items | 10 |
| Rendered context | 25,000 chars |

Violations return deterministic errors:
- `E_MESSAGE_TOO_LONG`
- `E_CONTEXT_TOO_LARGE`

---

## 5) Send Message Endpoint

### 5.1 Endpoint

```
POST /conversations/{id?}/messages
```

### 5.2 Sequence Assignment (Concurrency-Safe)

Using denormalized `conversation.next_seq` counter:

```sql
-- In single transaction:
-- Step 1: Lock conversation row and fetch next_seq
SELECT id, next_seq FROM conversation WHERE id = $1 FOR UPDATE;

-- Step 2: Increment counter
UPDATE conversation SET next_seq = next_seq + 1 WHERE id = $1;

-- Step 3: Insert message with fetched seq value
INSERT INTO message (conversation_id, seq, ...) VALUES ($1, $fetched_next_seq, ...);
```

**Benefits over MAX(seq)+1:**
- No scan of message table.
- Single counter read + increment.
- Still protected by FOR UPDATE lock.

On unique constraint violation (should be rare), retry with re-read (max 3 retries).

---

### 5.3 Two-Phase Execution Model

**Rationale:** Holding a DB transaction open during external LLM calls causes lock contention, throughput collapse, and retry complexity. Instead, use atomic DB phases with idempotency.

**Execution mode:** Synchronous (request blocks on LLM call).

**Phase 1 — Prepare (single transaction):**
1. Validate input.
2. Create conversation if `id` is null.
3. Lock conversation row (`FOR UPDATE`).
4. Assign next `seq` via counter.
5. Insert user message (`status=complete`).
6. Insert `message_context` rows.
7. Update `conversation_media`.
8. Insert assistant placeholder (`status=pending`, `content=''`, must be last message).
9. Record idempotency key → `(user_message_id, assistant_message_id)`.
10. Commit.

**Phase 2 — Execute (no transaction held):**
1. Resolve API key (BYOK or platform).
2. Render context to prompt.
3. Call LLM provider with **45 second timeout**.
4. Handle response or error.
5. Update key status based on result.

**Phase 3 — Finalize (single transaction):**
1. Update assistant message: `content`, `status` (complete|error), `updated_at`.
2. Insert `message_llm` row with usage data.
3. Commit.

**Timeout behavior:**
- If LLM call exceeds 45s → abort, mark `status=error`, `error_class=timeout`.
- User may retry (new idempotency key).

**Failure handling:**
- If Phase 2 fails (network, timeout, provider error): Phase 3 sets `status=error`, `content` describes failure.
- If Phase 3 fails: retry up to 3 times; assistant message remains `pending` until resolved.
- Background job cleans up stale `pending` messages (>5 min old) by marking as `error`.

---

### 5.4 Idempotency

- Accepts `Idempotency-Key` header (UUID, client-generated).
- Idempotency scope: 24 hours.
- On duplicate key:
  - If payload hash matches: return existing result.
  - If payload hash differs: return `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH` (409).
- Idempotency key storage:
  ```
  idempotency_keys
  - key (TEXT, PK)
  - user_id (FK → users)
  - payload_hash (TEXT)
  - user_message_id (FK → message)
  - assistant_message_id (FK → message)
  - created_at
  - expires_at
  ```

---

### 5.5 Failure Semantics

- On LLM failure:
  - Assistant message set to `status=error`
  - `content` describes failure (user-friendly)
  - `message_llm.error_class` records category
  - Return non-2xx error envelope

- Error codes:
  - `E_LLM_RATE_LIMIT`
  - `E_LLM_INVALID_KEY`
  - `E_LLM_PROVIDER_DOWN`
  - `E_LLM_CONTEXT_TOO_LARGE`
  - `E_LLM_TIMEOUT`

---

### 5.6 Quote-to-Chat Gate

Before including a highlight/annotation as context:

1. Resolve the media via `highlight.fragment.media_id`.
2. Check `can_read_media(viewer, media_id)`.
3. Check media capabilities:
   - For PDF: require `has_plain_text = true`.
   - For all: require `processing_status >= ready_for_reading`.
4. If gate fails: return `E_MEDIA_NOT_READY` with details.

---

## 6) Visibility Rules (S3)

### Conversations / Messages

Visible iff:
- owner, OR
- `sharing=public`, OR
- `sharing=library` AND viewer ∈ library via `conversation_share` (UI deferred to S4)

### Context

- Context links are filtered by viewer visibility.
- Invisible targets are omitted silently from response payload.

---

## 7) Keyword Search

### 7.1 Backend

PostgreSQL full-text search (`tsvector` + GIN index)

### 7.2 tsvector Storage Strategy

**Approach:** Generated stored columns (no triggers).

| Table | Column | Definition |
|-------|--------|------------|
| `media` | `title_tsv` | `GENERATED ALWAYS AS (to_tsvector('english', title)) STORED` |
| `fragment` | `canonical_text_tsv` | `GENERATED ALWAYS AS (to_tsvector('english', canonical_text)) STORED` |
| `annotation` | `body_tsv` | `GENERATED ALWAYS AS (to_tsvector('english', body)) STORED` |
| `message` | `content_tsv` | `GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` |

**Configuration:**
- Language: `english` (stemming, stop words)
- Generated columns auto-update on source column changes
- Note: `message.content` is immutable after `status=complete`, so generated column is stable

**Index DDL:**
```sql
CREATE INDEX idx_media_title_tsv ON media USING GIN (title_tsv);
CREATE INDEX idx_fragment_text_tsv ON fragment USING GIN (canonical_text_tsv);
CREATE INDEX idx_annotation_body_tsv ON annotation USING GIN (body_tsv);
CREATE INDEX idx_message_content_tsv ON message USING GIN (content_tsv);
```

**Ranking:**
- Use `ts_rank_cd` for relevance scoring.
- Weight title matches higher than body matches where applicable.

### 7.3 Indexed Fields

- `media.title`
- `fragment.canonical_text`
- `annotation.body`
- `message.content`

### 7.4 Endpoint

```
GET /search?q=<query>&scope=<scope>&types=<types>&cursor=<cursor>&limit=<limit>
```

### 7.5 Scope Semantics

| Scope | Meaning |
|-------|---------|
| `all` | All content visible to viewer |
| `media:<id>` | Only within specific media (fragments, highlights, annotations) |
| `library:<id>` | Media via `library_media`, plus fragments/highlights/annotations on those media |
| `conversation:<id>` | Messages within specific conversation |

**Library scope specifics:**
- Filters `media` via `library_media` join.
- Includes `fragments`, `highlights`, `annotations` anchored to those media.
- Does NOT include conversations (conversation sharing is S4).

### 7.6 Response Format

Results returned as mixed typed list:
```json
{
  "results": [
    {
      "type": "fragment",
      "id": "...",
      "score": 0.85,
      "snippet": "...matched text...",
      "source_type": "media",
      "source_id": "..."
    }
  ],
  "next_cursor": "...",
  "total_estimate": 42
}
```

### 7.7 Rules

- Visibility filtering applied before snippet generation.
- Snippets generated with `ts_headline` (highlight matches).
- Max snippet length: 300 chars.

---

## 8) Deletion Semantics (Hard Invariants)

| Operation | Result |
|---|---|
| Delete highlight | Cascades to annotation; cascades to `message_context` rows |
| Delete annotation | Cascades to `message_context` rows referencing it |
| Delete message | Cascades to `message_context` rows |
| Delete last message in conversation | Deletes conversation |
| Remove media from library | `library_media` row deleted; media row persists (per Constitution) |
| Delete context target | `message_context` rows deleted (CASCADE); `conversation_media` recomputed |

**Note:** User-facing media deletion is not supported in v1. Media rows persist when removed from libraries. Admin-only cleanup endpoints may exist but are not part of public API.

All operations must preserve consistency.

---

## 9) Error Codes (Additions)

| Error Code | HTTP | Description |
|------------|------|-------------|
| `E_LLM_NO_KEY` | 400 | No API key available for provider |
| `E_LLM_RATE_LIMIT` | 429 | Provider rate limit exceeded |
| `E_LLM_INVALID_KEY` | 400 | API key is invalid or revoked (not session auth) |
| `E_LLM_PROVIDER_DOWN` | 503 | Provider service unavailable |
| `E_LLM_TIMEOUT` | 504 | Provider request timed out |
| `E_MESSAGE_TOO_LONG` | 400 | Message exceeds 20,000 char limit |
| `E_CONTEXT_TOO_LARGE` | 400 | Context exceeds 25,000 char limit |
| `E_MODEL_NOT_AVAILABLE` | 400 | Requested model not available to user |
| `E_MEDIA_NOT_READY` | 409 | Media not ready for quote-to-chat |
| `E_SHARE_REQUIRED` | 409 | State conflict: cannot have sharing=library with 0 shares |
| `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH` | 409 | Same idempotency key with different payload |
| `E_KEY_INVALID` | 400 | User API key failed validation |

---

## 10) API Endpoints Summary

### 10.1 Conversations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/conversations` | List user's conversations (paginated) |
| `POST` | `/conversations` | Create conversation (optional, can be implicit via send) |
| `GET` | `/conversations/:id` | Get conversation details |
| `DELETE` | `/conversations/:id` | Delete conversation (cascades to messages) |
| `GET` | `/conversations/:id/messages` | List messages in conversation (paginated, oldest first) |
| `POST` | `/conversations/:id/messages` | Send message (or `POST /conversations/messages` to create + send) |

### 10.2 Models

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/models` | List available models for current user |

### 10.3 User API Keys

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/keys` | List user's API keys (fingerprints only, not decrypted) |
| `POST` | `/keys` | Add or update key for provider (upsert by provider) |
| `DELETE` | `/keys/:id` | Revoke key (soft delete, sets `revoked_at`) |
| `POST` | `/keys/:id/test` | Test key validity against provider (optional in v1) |

### 10.4 Search

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/search` | Keyword search across visible content |

---

## 11) Acceptance Criteria

- [ ] Chat works without media
- [ ] Quote-to-chat works with highlights
- [ ] Quote-to-chat rejects PDF without plain text (`E_MEDIA_NOT_READY`)
- [ ] Context uses `fragment_block` for paragraph windows
- [ ] Model selection enforced
- [ ] BYOK encrypted with XChaCha20-Poly1305
- [ ] Key status updated on provider calls
- [ ] Two-phase send endpoint works correctly
- [ ] 45s timeout on LLM calls
- [ ] Idempotency key prevents duplicate sends
- [ ] Idempotency mismatch returns correct error
- [ ] Visibility never leaks
- [ ] Search never leaks
- [ ] Search scope filtering works correctly
- [ ] All destructive invariants tested (CASCADE deletes)
- [ ] Visibility test suite passes
- [ ] Processing-state test suite passes
- [ ] `message_llm` records all LLM calls
- [ ] Stale pending messages cleaned up
- [ ] Last-share deletion auto-transitions to private

---

## 12) Risks

| Risk | Mitigation |
|------|------------|
| Provider normalization bugs | Comprehensive provider adapter tests |
| Token/context bloat | Hard limits enforced; monitoring |
| Visibility joins complexity | Precomputed `conversation_media`; query tests |
| Encryption mistakes | Use libsodium; never roll custom crypto |
| Two-phase partial failures | Background cleanup job; idempotency |
| Seq race conditions | Denormalized counter + FOR UPDATE lock |
| Key validity stale state | Update status on every provider call |
| Missing block boundaries | Fallback to ±600 chars; log warning |

All risks must be mitigated in this slice or explicitly deferred.
