# PR-01 Implementation Report: Slice 3 Schema Migration + Core Helpers

## Summary of Changes

This PR implements the foundational schema and utilities for Slice 3 (Chat, Quote-to-Chat, Keyword Search) of the Nexus platform. The changes lay the groundwork for the conversation and LLM infrastructure without adding any new API routes or frontend code.

### Key Deliverables

1. **Alembic Migration (0004_slice3_schema.py)** - All S3 database tables:
   - `conversations` - User-owned chat threads with sharing modes
   - `conversation_shares` - Library sharing for conversations
   - `models` - LLM model registry (provider, pricing, availability)
   - `messages` - Messages within conversations with seq ordering
   - `message_llm` - Per-assistant-message LLM execution metadata
   - `user_api_keys` - Encrypted BYOK API keys per provider
   - `idempotency_keys` - Request deduplication for message sends
   - `message_contexts` - Links messages to context objects
   - `conversation_media` - Derived table for media↔conversation relationships
   - `fragment_blocks` - Block boundary index for context windows
   - Generated tsvector columns + GIN indexes for full-text search

2. **Core Service Helpers**:
   - `services/seq.py` - Message sequence assignment with FOR UPDATE locking
   - `services/crypto.py` - XChaCha20-Poly1305 encryption for BYOK API keys (PyNaCl)
   - `services/fragment_blocks.py` - Parse canonical_text into blocks
   - `services/context_window.py` - Context window computation for LLM prompts

3. **Ingestion Hook** - Web article ingestion now creates `fragment_block` rows

4. **Configuration** - Added `NEXUS_KEY_ENCRYPTION_KEY` to config.py

5. **Tests** - Comprehensive test coverage for all new functionality

---

## Problems Encountered

### 1. CryptoError Import Collision
**Problem**: Initially imported `CryptoError` from `nacl.exceptions` while also defining a local `CryptoError` class, causing a name collision.

**Solution**: Removed the unused NaCl import since we catch all exceptions generically and raise our own `CryptoError` for consistent error handling.

### 2. Generated Column Syntax
**Problem**: SQLAlchemy's `Computed` column requires careful handling for PostgreSQL `GENERATED ALWAYS AS ... STORED` syntax.

**Solution**: Used `sa.Computed()` with `persisted=True` for generated stored columns. These columns auto-update when the source column changes.

### 3. Block Delimiter Ownership
**Problem**: The spec requires that `\n\n` delimiters be included at the END of the preceding block's range to ensure contiguous coverage.

**Solution**: Implemented careful offset calculation in `parse_fragment_blocks()`:
- `block[n].end` includes the trailing `\n\n`
- `block[n+1].start == block[n].end` (no gaps)
- Final block ends at `len(canonical_text)` with no trailing delimiter

### 4. Context Window Cap Logic
**Problem**: The context window cap (2,500 chars) must be enforced by shrinking edges while NEVER cutting into the selection.

**Solution**: Implemented `_apply_char_cap()` that:
1. Calculates available trim space on each side (up to selection boundaries)
2. Trims proportionally from both sides
3. Falls back to selection bounds if selection itself exceeds cap

---

## Solutions Implemented

### Sequence Assignment (FOR UPDATE Locking)
```python
# Atomic seq assignment pattern
SELECT next_seq FROM conversations WHERE id = :id FOR UPDATE;
UPDATE conversations SET next_seq = next_seq + 1 WHERE id = :id;
# Return original next_seq for message creation
```
This pattern prevents race conditions in concurrent message creation.

### Key Encryption (XChaCha20-Poly1305)
- Master key loaded from `NEXUS_KEY_ENCRYPTION_KEY` env var (base64-encoded 32 bytes)
- 24-byte random nonce generated per encryption (stored with ciphertext)
- PyNaCl SecretBox provides authenticated encryption
- Fingerprints (last 4 chars) for safe logging

### Fragment Block Parsing
- Blocks are contiguous: `block[0].start=0`, `block[-1].end=len(text)`
- Delimiter `\n\n` included in preceding block's range
- Empty blocks flagged with `is_empty=True` for context window skipping
- Coverage invariant validated with assertions

### Context Window Algorithm
1. **Block-based** (when blocks exist):
   - Find containing block(s) for selection
   - Include previous and next non-empty blocks
   - Apply 2,500 char cap by shrinking edges
   
2. **Fallback** (when blocks missing):
   - ±600 chars from selection boundaries
   - Same cap enforcement logic

---

## Decisions Made

### 1. v1 Message Context Types
Limited `message_context.target_type` to `media`, `highlight`, `annotation` only:
- Message and conversation context types deferred (CASCADE complexity)
- Prevents cascade issues where deleting a referenced message would break the one-target constraint

### 2. Composite Primary Key for Idempotency
Used `(user_id, key)` as PK for `idempotency_keys`:
- Prevents cross-user collisions
- Avoids accidental key leakage
- Key length bounded to 128 chars

### 3. Key Mode Tracking
Added both `key_mode_requested` and `key_mode_used` to `message_llm`:
- Requested: what the client asked for (`auto`|`byok_only`|`platform_only`)
- Used: what was actually used after resolution (`platform`|`byok`)
- Enables audit trail for fallback behavior

### 4. No Backfill for Fragment Blocks
Only new ingests create `fragment_block` rows:
- Existing fragments use fallback context window (±600 chars)
- Backfill explicitly deferred to avoid migration complexity

### 5. Generated Stored Columns for tsvector
Used `GENERATED ALWAYS AS ... STORED` instead of triggers:
- Auto-updates on source column changes
- No trigger maintenance
- PostgreSQL handles concurrency correctly

---

## Deviations from Spec

### 1. Table Naming Convention
Used plural table names (`conversations`, `messages`, `models`, etc.) to match existing schema convention from S0-S2, even though spec showed singular names.

### 2. Error Code Column
Added `error_code` column to `messages` table (nullable TEXT):
- Allows storing specific error codes for failed messages
- Spec mentioned error handling but didn't explicitly call out this column

### 3. Fragment Block `is_empty` Field
Added `is_empty` BOOLEAN column to `fragment_blocks`:
- Not explicitly in spec but implied for context window logic
- Allows skipping empty blocks efficiently in queries

---

## How to Run New/Changed Commands

### Run Migrations
```bash
# Apply migration to development database
make migrate

# Apply migration to test database
make migrate-test
```

### Set Up Key Encryption (Required for Tests)
The crypto module requires `NEXUS_KEY_ENCRYPTION_KEY` environment variable. For tests, a deterministic test key is set up in the test fixtures.

For local development, generate a key:
```bash
# Generate a 32-byte random key, base64 encoded
python -c "import os, base64; print(base64.b64encode(os.urandom(32)).decode())"
```

Add to your `.env`:
```
NEXUS_KEY_ENCRYPTION_KEY=<generated-key>
```

### Run Tests

```bash
# Run all tests (includes new S3 tests)
make test

# Run only migration tests (includes S3 constraint tests)
make test-migrations

# Run specific test files
cd python && uv run pytest tests/test_seq_locking.py -v
cd python && uv run pytest tests/test_crypto.py -v
cd python && uv run pytest tests/test_fragment_blocks.py -v
```

### Verify Fragment Blocks in Ingestion
```bash
# Start worker
make worker

# In another terminal, ingest an article via API
# After ingestion, verify fragment_blocks exist in database
```

---

## How to Verify New Functionality

### 1. Verify Migration Applied
```sql
-- Check new tables exist
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('conversations', 'messages', 'models', 'message_llm', 
                   'user_api_keys', 'idempotency_keys', 'message_contexts',
                   'conversation_media', 'conversation_shares', 'fragment_blocks');

-- Check tsvector columns exist
SELECT column_name, is_generated 
FROM information_schema.columns 
WHERE table_name IN ('media', 'fragments', 'annotations', 'messages') 
AND column_name LIKE '%_tsv';

-- Check GIN indexes exist
SELECT indexname FROM pg_indexes 
WHERE indexdef LIKE '%gin%' 
AND tablename IN ('media', 'fragments', 'annotations', 'messages');
```

### 2. Verify Constraints
```sql
-- Test pending-only-assistant constraint (should fail)
INSERT INTO conversations (owner_user_id, sharing) 
SELECT id, 'private' FROM users LIMIT 1;

INSERT INTO messages (conversation_id, seq, role, content, status)
SELECT id, 1, 'user', 'test', 'pending' FROM conversations LIMIT 1;
-- ERROR: violates check constraint "ck_messages_pending_only_assistant"

-- Test nonce length constraint (should fail)
INSERT INTO user_api_keys (user_id, provider, encrypted_key, key_nonce, key_fingerprint)
SELECT id, 'openai', '\x00', '\x00', 'test' FROM users LIMIT 1;
-- ERROR: violates check constraint "ck_user_api_keys_nonce_len"
```

### 3. Verify Fragment Blocks After Ingestion
```sql
-- After ingesting a web article
SELECT f.id, f.canonical_text, 
       (SELECT COUNT(*) FROM fragment_blocks WHERE fragment_id = f.id) as block_count
FROM fragments f
WHERE f.media_id = '<media_id>';

-- Verify block coverage
SELECT block_idx, start_offset, end_offset, is_empty
FROM fragment_blocks 
WHERE fragment_id = '<fragment_id>'
ORDER BY block_idx;
```

---

## Commit Message

```
feat(s3): add slice 3 schema migration and core helpers

This PR implements PR-01 of the Slice 3 roadmap, establishing the
database schema and utility functions for the chat system.

Schema changes (migration 0004):
- Add conversations table with sharing modes (private/library/public)
- Add messages table with strict seq ordering per conversation
- Add models table (LLM registry with provider, pricing, availability)
- Add message_llm table (per-message LLM execution metadata)
- Add user_api_keys table (encrypted BYOK keys, XChaCha20-Poly1305)
- Add idempotency_keys table (request deduplication, 24h TTL)
- Add message_contexts table (typed context links to media/highlight/annotation)
- Add conversation_media table (derived media↔conversation mapping)
- Add conversation_shares table (library-based conversation sharing)
- Add fragment_blocks table (block boundaries for context windows)
- Add generated tsvector columns + GIN indexes for full-text search

Core helpers:
- services/seq.py: Atomic message seq assignment with FOR UPDATE locking
- services/crypto.py: XChaCha20-Poly1305 encryption/decryption (PyNaCl)
- services/fragment_blocks.py: Parse canonical_text into contiguous blocks
- services/context_window.py: Block-based and fallback context extraction

Ingestion hook:
- Web article ingestion now creates fragment_block rows for context windows

Configuration:
- Add NEXUS_KEY_ENCRYPTION_KEY to config.py for BYOK key encryption

Key constraints enforced:
- ck_messages_pending_only_assistant: pending status only for assistant role
- uix_messages_conversation_seq: unique (conversation_id, seq)
- ck_user_api_keys_nonce_len: nonce must be exactly 24 bytes
- ck_message_contexts_one_target: exactly one FK must be non-null
- uix_fragment_blocks_fragment_idx: unique (fragment_id, block_idx)

Tests added:
- Migration constraint tests for all new tables
- Seq locking concurrency tests with multi-session blocking verification
- Crypto round-trip tests with nonce uniqueness and tampering detection
- Fragment block parsing tests with contiguity invariant checks
- Context window tests for block-based and fallback modes
- Ingestion hook test verifying fragment_block creation

No new API routes or frontend changes - this is schema + helpers only.

Refs: s3_pr01.md, s3_spec.md, s3_roadmap.md
```
