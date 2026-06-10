# BYOK & Entitlements

## Scope

This module owns the LLM key spine: how every generation surface resolves which
provider key to use (a user's own bring-your-own-key or the platform key), the
entitlement gate that decides whether the platform key is allowed, the monthly
platform-token budget envelope, and the BYOK key probe. The key encryption,
status lifecycle, billing tiers, and the entitlement/budget *definitions* are
described in
[architecture.md §7.5](../architecture.md#75-byok-keys-billing--entitlements);
this doc owns the resolution spine and its uniform application across surfaces. It
does not restate crypto or billing internals.

Backend owners: `python/nexus/services/api_key_resolver.py`,
`python/nexus/services/billing_entitlements.py`,
`python/nexus/services/rate_limit.py`, and `python/nexus/services/user_keys.py`.
The generation surfaces that consume this spine are catalogued in
[llms.md](llms.md).

## The one key spine: `resolve_api_key`

`api_key_resolver.resolve_api_key(db, user_id, provider, key_mode)` is the single
entry point for obtaining a provider key, and the only place a generation surface
reads a platform key from. No surface reads `settings.<provider>_api_key`
directly — those reads live only in `llm_catalog.py` (which exposes platform keys
through `platform_key_for_provider`) and the resolver itself (AC-5). The
generation embedding path (`semantic_chunks._embed_with_openai`) is a separate
substrate with its own provider key and is not part of this spine.

`key_mode` is one of:

- **`auto`** — try the user's BYOK key first, fall back to the platform key.
- **`byok_only`** — use only the user's key; raise if absent.
- **`platform_only`** — use only the platform key; raise if the entitlement is
  missing.

The resolver returns a `ResolvedKey` carrying the key, the mode actually used
(`platform` or `byok`), and the BYOK key id when one was used (so a terminal
write can flow `update_user_key_status` feedback back). A disabled provider raises
`E_MODEL_NOT_AVAILABLE`; a missing platform entitlement raises
`E_BILLING_REQUIRED`; no key at all raises an `LLMError(INVALID_KEY)`.

## Uniform application across surfaces (including background)

The key spine and its entitlement gate apply to **all** generation surfaces, not
just chat. Interactive chat passes the user's requested `key_mode`; the four
background surfaces (oracle, LI reduce, media unit, metadata enrichment) resolve
with `auto` attributed to the owning user (the oracle reading's user, the LI
artifact's owner, the media owner). The consequences are uniform by construction:

- A user's BYOK key now serves background work, not just chat.
- `can_use_platform_llm` entitlement gating applies to every surface; background
  jobs cannot quietly use the platform key without the entitlement.
- `update_user_key_status` feedback flows from every surface's terminal write, so
  a key that fails in a background job is marked the same as one that fails in
  chat.

This is single-user today but correct-by-construction if key sharing ever returns
(decision 7 of the generation-run harness cutover).

## Platform entitlement & budget envelope

`billing_entitlements.get_effective_entitlements(db, user_id).can_use_platform_llm`
is the gate the resolver checks before handing back a platform key. The monthly
**platform-token budget** is enforced by the Postgres-backed
`RateLimiter` (`rate_limit.py`) through a reserve → commit/release pattern, and is
applied to every platform-mode generation, including background ones: a surface
calls `acquire_inflight_slot`, `reserve_token_budget(owner, run, estimate)`
before the call, then `commit_token_budget(owner, run, actual)` (or
`release_token_budget` on failure) after. Token estimates flow from the one
estimator, `prompt_budget.estimate_tokens`. BYOK-mode calls do not consume the
platform budget.

## The BYOK key probe (`user_keys.test_user_key`)

`test_user_key(db, user_id, key_id, router)` validates a saved BYOK key by making
a minimal outbound provider call (the cheapest model per provider, from
`KEY_TEST_MODELS` in [llms.md](llms.md)) and updates the key's status
(`valid`/`invalid`). The plaintext key is decrypted only for the outbound call
and is never logged or returned. The probe emits the shared `llm.request.*`
telemetry but, unlike a generation surface, does **not** write an `llm_calls`
ledger row — it is a key health check, not billable generation.
