# PR-03 Report: Models Registry + User API Keys

**Status**: Completed  
**Date**: 2026-01-25  

---

## Summary of Changes

### New Error Codes (`python/nexus/errors.py`)
Added three new error codes for key management:
- `E_KEY_PROVIDER_INVALID` (400) - Invalid provider value
- `E_KEY_INVALID_FORMAT` (400) - Key validation failures (too short, whitespace)
- `E_KEY_NOT_FOUND` (404) - Key not found or not owned by viewer

### New Pydantic Schemas (`python/nexus/schemas/keys.py`)
Created schemas for the keys and models endpoints:
- `UserApiKeyIn` - Input for key creation/update with validation
- `UserApiKeyOut` - Safe output (no encrypted_key, just fingerprint)
- `UserApiKeyListResponse` - Envelope for list response
- `ModelOut` - Model registry output
- `ModelListResponse` - Envelope for models list

Type aliases:
- `PROVIDER_TYPES = Literal["openai", "anthropic", "gemini"]`
- `API_KEY_STATUSES = Literal["untested", "valid", "invalid", "revoked"]`

### Crypto Extensions (`python/nexus/services/crypto.py`)
Added high-level API key encryption functions:
- `encrypt_api_key(plaintext) -> (ciphertext, nonce, version, fingerprint)`
- `decrypt_api_key(ciphertext, nonce, version) -> plaintext`

Key properties:
- Nonce is always generated internally (never supplied by caller)
- Master key version is tracked for future key rotation
- Fingerprint is last 4 characters of the plaintext key

### Config Extensions (`python/nexus/config.py`)
Added optional platform API key settings:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`

### Database Model Updates (`python/nexus/db/models.py`)
Modified `UserApiKey` model to support secure revocation:
- `encrypted_key` - now nullable (wiped on revocation)
- `key_nonce` - now nullable (wiped on revocation)
- `master_key_version` - now nullable (wiped on revocation)

Updated check constraints to allow NULL values while still enforcing rules when values are present.

### Migration Updates (`migrations/alembic/versions/0004_slice3_schema.py`)
- Updated `user_api_keys` table to make crypto fields nullable
- Added seed data for the `models` table with 6 initial LLM models:
  - `gpt-4o-mini` (OpenAI, 128k context)
  - `gpt-4o` (OpenAI, 128k context)
  - `claude-sonnet-4-20250514` (Anthropic, 200k context)
  - `claude-haiku-4-20250514` (Anthropic, 200k context)
  - `gemini-2.0-flash` (Gemini, 1M context)
  - `gemini-2.5-pro-preview-05-06` (Gemini, 1M context)

### New Service: User Keys (`python/nexus/services/user_keys.py`)
Implements BYOK key management:
- `list_user_api_keys(db, viewer_id)` - List all keys for user (safe fields only)
- `upsert_user_api_key(db, viewer_id, provider, api_key)` - Create or update key
- `revoke_user_api_key(db, viewer_id, key_id)` - Soft delete with secure wipe
- `test_user_api_key(db, viewer_id, key_id)` - Placeholder for PR-04

Validation rules:
- API key must be ≥20 characters
- API key must not contain leading/trailing whitespace
- Provider must be one of: openai, anthropic, gemini

### New Service: Models (`python/nexus/services/models.py`)
Implements model availability filtering:
- `list_available_models(db, viewer_id)` - Returns models user can access
- `_get_platform_providers()` - Helper to check platform key availability

Availability rules:
- Model is available if platform has a key configured, OR
- Model is available if user has a valid (non-revoked) BYOK key for that provider

### New Routes (`python/nexus/api/routes/keys.py`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/keys` | List user's API keys (safe fields only) |
| POST | `/keys` | Add or update key (upsert by provider) |
| DELETE | `/keys/{id}` | Revoke key (secure wipe) |
| POST | `/keys/{id}/test` | Test key against provider (returns 501 until PR-04) |

### New Routes (`python/nexus/api/routes/models.py`)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/models` | List available models for current user |

### Test Coverage (`python/tests/test_keys.py`, `python/tests/test_models.py`)
Comprehensive tests covering:
- Crypto round-trip (encrypt → store → decrypt)
- API safety (encrypted_key never in response)
- Validation (length, whitespace)
- Upsert semantics (same ID on overwrite, 200 vs 201)
- Ciphertext rotation on update (new nonce each time)
- Secure revocation (ciphertext wiped to NULL)
- Fingerprint retention after revoke
- Revoked key inaccessible
- Authentication required
- Model filtering by platform keys
- Model filtering by user BYOK keys

---

## Problems Encountered

### 1. Database Transaction Management
**Problem**: Initial implementation used `db.flush()` without `db.commit()` in service functions. This caused data to not persist between separate API calls in tests, leading to assertions failing when trying to read back created keys.

**Symptoms**: 
- `test_list_keys_excludes_sensitive_fields` saw 0 keys after creating one
- `test_ciphertext_changes_on_overwrite` got TypeError on None access
- Various tests couldn't find keys that were just created

**Root Cause**: Other services in the codebase (like conversations) explicitly call `db.commit()` after mutations. Following only the `flush()` pattern was insufficient.

### 2. Nullable Fields for Secure Revocation
**Problem**: The spec requires that on revocation, the ciphertext and nonce are wiped to NULL. But the initial database model had `nullable=False` on these fields, making NULL impossible.

**Symptoms**: Would have caused database constraint violations on revoke.

### 3. Check Constraints Blocking NULL
**Problem**: The check constraints like `master_key_version > 0` and `octet_length(key_nonce) = 24` would fail for NULL values even after making columns nullable.

**Symptoms**: Would cause constraint violations when setting fields to NULL on revoke.

### 4. Validation Error Messages
**Problem**: Tests were checking for specific error messages like "too short" but FastAPI's Pydantic validation produces different error formats. The API error envelope uses error codes, not message content.

**Symptoms**: Tests asserting on message content failed.

---

## Solutions Implemented

### 1. Transaction Management Fix
Added `db.commit()` after `db.flush()` in all service functions that perform write operations:
- `upsert_user_api_key()` 
- `revoke_user_api_key()`

This ensures data is persisted and visible to subsequent requests.

### 2. Nullable Crypto Fields
Modified `UserApiKey` model to make these fields nullable:
```python
encrypted_key: Mapped[bytes | None] = mapped_column(nullable=True)
key_nonce: Mapped[bytes | None] = mapped_column(nullable=True)
master_key_version: Mapped[int | None] = mapped_column(Integer, nullable=True, server_default="1")
```

### 3. Updated Check Constraints
Changed constraints to allow NULL while still enforcing rules when values are present:
```sql
-- Before
master_key_version > 0
octet_length(key_nonce) = 24

-- After
master_key_version IS NULL OR master_key_version > 0
key_nonce IS NULL OR octet_length(key_nonce) = 24
```

### 4. Error Code-Based Testing
Changed tests to check for error codes instead of message content:
```python
# Before (fragile)
assert "too short" in response.json()["error"]["message"].lower()

# After (robust)
assert response.json()["error"]["code"] == "E_KEY_INVALID_FORMAT"
```

---

## Key Decisions

### 1. Master Key Versioning
Implemented `MASTER_KEY_VERSION = 1` constant in crypto.py. While only version 1 exists now, this establishes the foundation for key rotation in the future. The version is stored per-key, allowing gradual migration.

### 2. Fingerprint Implementation
Used last 4 characters of the API key as the fingerprint (matching spec). This provides user-recognizable identification without exposing meaningful key material.

### 3. Upsert Semantics
Implemented true upsert: if a key already exists for (user, provider), the same row is updated rather than creating a new one. Returns 201 on create, 200 on update.

### 4. Secure Wipe on Revoke
On revocation, all crypto fields are set to NULL:
- `encrypted_key = None`
- `key_nonce = None`
- `master_key_version = None`
- `revoked_at = datetime.now()`
- `status = "revoked"`

The fingerprint is retained for audit purposes.

### 5. Test Endpoint Returns 501
The `POST /keys/{id}/test` endpoint currently returns 501 Not Implemented. This is intentional - actual provider testing will be implemented in PR-04 when we add LLM execution.

### 6. Model Availability Logic
A model is available to a user if:
1. The platform has a key for that provider (env var set), OR
2. The user has a non-revoked BYOK key for that provider

This means even if a user's key status is "untested" or "invalid", the model shows as available (they might want to fix their key).

---

## Deviations from Spec

### Minor Deviations

1. **POST `/keys/:id/test` returns 501**: The spec expects this endpoint to actually test the key. Since we don't have LLM provider clients yet (PR-04 scope), it returns 501 Not Implemented with a clear message.

2. **Model seed data**: The spec doesn't specify exact model names. I used current model names that match the provider patterns (gpt-4o, claude-sonnet-4, gemini-2.0-flash, etc.).

3. **Validation error format**: Instead of custom messages in the error body, validation failures use the standardized `E_KEY_INVALID_FORMAT` error code. The actual validation rules (≥20 chars, no whitespace) are enforced.

### No Deviations
- All specified endpoints implemented
- All error codes added
- All security invariants enforced (no encrypted_key in responses)
- Upsert semantics work as specified
- Secure revocation wipes ciphertext
- Model filtering works per availability rules

---

## How to Run

### Run All Backend Tests
```bash
make test-back
```

### Run Only Keys/Models Tests
```bash
cd python
DATABASE_URL=... uv run pytest tests/test_keys.py tests/test_models.py -v
```

### Verify New Endpoints Manually

1. Start the API server:
```bash
make run-api
```

2. Get an auth token from Supabase

3. List available models:
```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/models
```

4. Add an API key:
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider": "openai", "api_key": "sk-your-key-here-at-least-20-chars"}' \
  http://localhost:8000/keys
```

5. List your keys:
```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/keys
```

6. Revoke a key:
```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:8000/keys/{key_id}
```

---

## Commit Message

```
feat(s3): implement models registry and user API keys (PR-03)

Add BYOK (Bring Your Own Key) functionality for LLM providers and
model availability filtering.

New endpoints:
- GET /models - list available LLM models for current user
- GET /keys - list user's API keys (safe fields only)
- POST /keys - upsert API key for provider (openai/anthropic/gemini)
- DELETE /keys/{id} - revoke key with secure ciphertext wipe
- POST /keys/{id}/test - placeholder for provider testing (501)

Implementation:
- Add UserApiKeyIn/Out, ModelOut Pydantic schemas
- Add E_KEY_PROVIDER_INVALID, E_KEY_INVALID_FORMAT, E_KEY_NOT_FOUND errors
- Extend crypto.py with encrypt_api_key/decrypt_api_key high-level API
- Add user_keys service with list, upsert, revoke, test operations
- Add models service with availability filtering logic
- Seed models table with 6 initial LLM models
- Add OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY config options

Security:
- encrypted_key never leaves backend (fingerprint only in responses)
- XChaCha20-Poly1305 encryption with per-key random nonce
- Master key versioning for future rotation support
- Secure revocation wipes ciphertext to NULL

Validation:
- API key minimum 20 characters
- No leading/trailing whitespace
- Provider must be openai, anthropic, or gemini

Model availability rules:
- Available if platform key exists (env var), OR
- Available if user has non-revoked BYOK key for provider

Tests: comprehensive coverage for crypto round-trip, API safety,
validation rules, upsert semantics, secure revocation, and model
filtering.

Refs: s3_pr03.md
```
