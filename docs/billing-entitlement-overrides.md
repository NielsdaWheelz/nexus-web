# Billing Entitlement Overrides

Status: Spec.
Scope owner: `python/nexus` billing, AI quota enforcement, and `apps/web` billing UI.
Date: 2026-05-25.

## 1. Summary

Add backend-owned internal entitlement grants for users who should receive paid
product capabilities without paying through Stripe. This is not a superuser
system. It is a billing entitlement override system: the backend computes a
user's effective capabilities from Stripe subscription state plus an explicit
internal grant stored by `user_id`.

The owner use case is:

```text
niels.erik.nandal@gmail.com gets effective AI Pro access, platform AI access,
sharing, transcription, and unlimited monthly AI/transcription quotas without a
Stripe subscription.
```

Hard cutover. No feature flag. No legacy API aliases. No frontend fallback. No
fake Stripe subscriptions. No email hardcoding.

## 2. Problem

The current billing model has one persistent paid-access source:
`billing_accounts`, a Stripe subscription snapshot keyed by `user_id`. Effective
entitlements are computed in `python/nexus/services/billing.py` from that row.

That means an owner, test account, support account, or sponsored user must either
pay through Stripe or receive a hand-edited fake `billing_accounts` row. That is
the wrong abstraction:

- Stripe state should describe payment and subscription management only.
- Product capability access should be computed by backend entitlement policy.
- An unpaid grant should not require a Stripe customer, Stripe subscription id,
  Stripe price id, or billing portal.
- A paid-plan grant should not imply broad admin power.
- A grant should be revocable and auditable.
- Unlimited quota should be represented explicitly, not as `0`, `-1`, an
  oversized integer, or a missing billing account.

## 3. Goals

- **G1.** Grant selected users paid capabilities without requiring payment.
- **G2.** Store grants by `user_id`, never by runtime email matching.
- **G3.** Keep Stripe subscription state and internal grant state separate.
- **G4.** Make effective entitlements a single backend-owned contract consumed
  by platform AI, model listing, transcription, sharing, and billing UI.
- **G5.** Support explicit unlimited monthly token and transcription quotas.
- **G6.** Continue recording usage for unlimited grants.
- **G7.** Make revocation immediate on the next entitlement check.
- **G8.** Avoid granting unrelated admin capabilities.
- **G9.** Provide an operator path to grant, inspect, and revoke internal
  access by email or user id.
- **G10.** Replace test and seed fake paid `billing_accounts` writes with
  internal grants when the account is not exercising Stripe behavior.

## 4. Non-Goals

- **N1.** No app-wide `superuser`, `admin`, or role-based permission system.
- **N2.** No hardcoded email allowlist in source code, config, or frontend.
- **N3.** No environment-variable allowlist.
- **N4.** No fake Stripe customer, subscription, price, or webhook state.
- **N5.** No Stripe coupon, trial, comped subscription, or manual dashboard
  workaround as the product mechanism.
- **N6.** No client-side entitlement decisions. The frontend only renders the
  backend's effective state.
- **N7.** No public or user-facing grant management API.
- **N8.** No migration/coexistence period with old response fields. This is a
  hard API cutover.
- **N9.** No changes to BYOK. BYOK usage remains controlled by the user's own
  provider account and existing request limits.
- **N10.** No attempt to meter background metadata enrichment or embeddings
  under this grant system unless those paths are separately made user-billable.

## 5. Key Decisions

### 5.1 Use Internal Grant, Not Superuser

The object is an internal billing entitlement grant. It unlocks product
capabilities. It does not grant admin screens, data access, moderation powers,
database access, or role claims.

### 5.2 Use `user_id` as the Durable Subject

Operator tooling may accept an email for lookup, but the persisted grant is
keyed to `users.id`. Email can change. JWT claims can drift. The local user id
is the backend subject.

### 5.3 Keep Plan Semantics

The grant stores an effective plan tier. Capabilities are derived from plan
semantics, not duplicated as many independent booleans. Quota behavior is the
only override-specific capability modifier.

Supported grant plan tiers:

- `plus`
- `ai_plus`
- `ai_pro`

There is no `free` grant. Revoking or deleting a grant returns the user to their
subscription-derived entitlement.

### 5.4 Represent Unlimited Explicitly

Database quota mode is explicit:

- `plan` means use the configured monthly limit for the grant's plan tier.
- `custom` means use the grant's custom non-negative integer limit.
- `unlimited` means no monthly cap.

API quota limit is explicit:

- `limit: number` means finite monthly cap.
- `limit: null` means unlimited.
- `remaining: number` means finite remaining quota.
- `remaining: null` means unlimited.

`0` means a finite quota of zero. It blocks usage. It never means unlimited.

### 5.5 Compose, Do Not Replace Stripe

Stripe remains the payment source of truth. Internal grants are a second
entitlement source. Effective entitlement calculation composes both:

1. Normalize active Stripe subscription into a subscription entitlement.
2. Normalize active internal grant into a grant entitlement.
3. Choose the highest plan rank for plan-derived capabilities.
4. Apply grant quota modes when an active grant exists.
5. Return one effective entitlement object.

An active grant cannot reduce a paid user's entitlements. If a user pays for
`ai_pro` and also has a stale `plus` grant, the effective plan remains `ai_pro`.

### 5.6 Expose Source, Not Implementation Details

The billing account API exposes enough state for the UI to render honestly:

- billing subscription state
- effective entitlement state
- whether the user can open Stripe portal
- usage snapshots

It does not expose grant `reason`, actor ids, event snapshots, or other internal
audit data to the client.

## 6. Target Behaviour

### 6.1 Owner Grant

Given a signed-in user whose local row has
`users.email = 'niels.erik.nandal@gmail.com'`, an operator grants:

- `plan_tier = 'ai_pro'`
- `platform_token_quota_mode = 'unlimited'`
- `transcription_quota_mode = 'unlimited'`
- `expires_at = NULL`
- `revoked_at = NULL`

Then the user can:

- use sharing features gated by Plus
- list and use platform-key LLM models when platform provider keys are
  configured
- force `platform_only` key mode
- use `auto` key mode with platform fallback when no BYOK key exists
- run chat and Oracle calls against platform keys
- request podcast/media transcription
- see unlimited token and transcription quotas in billing settings

The user does not get:

- admin access
- access to other users' data
- Stripe billing portal access unless they also have a Stripe customer
- a fake paid subscription status

### 6.2 Free User Without Grant

A user with no active subscription and no active grant remains free:

- no sharing
- no platform LLM access
- no transcription quota
- no Stripe portal unless a customer exists for other reasons

### 6.3 Paid User Without Grant

A user with an active Stripe subscription receives their current paid plan
capabilities. Stripe webhooks update `billing_accounts`. Internal grant tables
are untouched.

### 6.4 Paid User With Grant

A user with both active Stripe subscription state and an active grant receives
the maximum effective plan rank. If the grant's quota mode is `unlimited`, quota
is unlimited even when the Stripe plan would be finite.

Billing UI must show that payment and entitlement source are different. A user
can be:

- billed through Stripe and entitled through subscription
- billed through Stripe and boosted by internal grant
- not billed and entitled through internal grant
- not billed and free

### 6.5 Expired Or Revoked Grant

A grant is active while:

```text
revoked_at IS NULL AND (expires_at IS NULL OR now() < expires_at)
```

`expires_at` is right-open. The grant is invalid at `now() >= expires_at`.
Expired and revoked grants do not participate in effective entitlement
calculation. No cleanup job is required for correctness.

### 6.6 Unlimited Quota Runtime

For unlimited platform-token quota:

- platform access is still required
- provider and key-mode checks still run
- RPM and concurrency limits still run
- monthly token cap checks do not block
- usage charges are still recorded when possible
- usage UI shows used tokens and `Unlimited` limit/remaining

For unlimited transcription quota:

- transcription access is still required
- monthly transcription cap checks do not block
- minutes used are still recorded
- usage UI shows used minutes and `Unlimited` limit/remaining

If entitlement lookup fails, access fails closed. Unlimited quota is not an
availability bypass.

## 7. Capability Contract

### 7.1 Domain Types

Backend services use a single domain object for entitlement decisions:

```python
BillingPlanTier = Literal["free", "plus", "ai_plus", "ai_pro"]
EntitlementSource = Literal["free", "subscription", "internal_grant"]
QuotaLimit = int | None  # None means unlimited.

class EffectiveBillingEntitlements(BaseModel):
    billing_plan_tier: BillingPlanTier
    billing_status: str
    entitlement_plan_tier: BillingPlanTier
    entitlement_source: EntitlementSource
    can_share: bool
    can_use_platform_llm: bool
    can_transcribe: bool
    platform_token_limit_monthly: QuotaLimit
    transcription_minutes_limit_monthly: QuotaLimit
    usage_period_start: datetime
    usage_period_end: datetime
    subscription_current_period_start: datetime | None
    subscription_current_period_end: datetime | None
    grant_id: UUID | None
    grant_expires_at: datetime | None
    can_manage_billing: bool
```

Rules:

- `billing_*` fields describe Stripe/account state.
- `entitlement_*` fields describe effective product access.
- `can_manage_billing` is true only when a Stripe customer exists and portal
  creation can succeed.
- `grant_id` and `grant_expires_at` are internal-service fields. Public API may
  expose `grant_expires_at`; it must not expose `grant_id`.

### 7.2 Plan Capability Matrix

| Plan | Share | Platform LLM | Transcription |
|---|---:|---:|---:|
| `free` | no | no | no |
| `plus` | yes | no | no |
| `ai_plus` | yes | yes | yes |
| `ai_pro` | yes | yes | yes |

Quota limits for `ai_plus` and `ai_pro` come from settings unless the active
grant supplies `custom` or `unlimited` quota mode.

### 7.3 Quota Contract

Finite quota:

```text
limit = configured_or_custom_integer
remaining = max(0, limit - used - reserved)
```

Unlimited quota:

```text
limit = null
remaining = null
```

The API never sends a sentinel integer for unlimited. The UI never infers
unlimited from a large number.

## 8. Data Model

### 8.1 `billing_entitlement_overrides`

Current grant state. One row per user.

```text
id uuid primary key default gen_random_uuid()
user_id uuid not null references users(id)
plan_tier text not null
platform_token_quota_mode text not null default 'plan'
platform_token_limit_monthly integer null
transcription_quota_mode text not null default 'plan'
transcription_minutes_limit_monthly integer null
expires_at timestamptz null
revoked_at timestamptz null
reason text not null
created_by_user_id uuid null references users(id)
updated_by_user_id uuid null references users(id)
created_by_label text null
updated_by_label text null
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

Constraints:

- `user_id` unique.
- `plan_tier IN ('plus', 'ai_plus', 'ai_pro')`.
- each quota mode is in `('plan', 'custom', 'unlimited')`.
- custom token limit requires `platform_token_limit_monthly IS NOT NULL`.
- non-custom token limit requires `platform_token_limit_monthly IS NULL`.
- custom transcription limit requires
  `transcription_minutes_limit_monthly IS NOT NULL`.
- non-custom transcription limit requires
  `transcription_minutes_limit_monthly IS NULL`.
- custom limits must be `>= 0`.
- `reason <> ''`.

No database cascade. Deleting a user with an override requires explicit
application cleanup.

### 8.2 `billing_entitlement_override_events`

Append-only audit trail for operator mutations.

```text
id uuid primary key default gen_random_uuid()
override_id uuid null references billing_entitlement_overrides(id)
user_id uuid not null references users(id)
event_type text not null
actor_user_id uuid null references users(id)
actor_label text null
reason text not null
before_state jsonb null
after_state jsonb null
created_at timestamptz not null default now()
```

Supported `event_type` values:

- `created`
- `updated`
- `revoked`

Rules:

- Events are written in the same DB transaction as the override mutation.
- Events are internal. They are not returned by `/billing/account`.
- JSON snapshots are audit data only. Runtime policy never reads JSON snapshots.

## 9. Service Architecture

### 9.1 Ownership

`python/nexus/services/billing.py` remains the public service boundary for
billing account reads and Stripe actions.

Add a focused internal module:

```text
python/nexus/services/billing_entitlements.py
```

Responsibilities:

- load subscription entitlement input from `BillingAccount`
- load active internal grant from `BillingEntitlementOverride`
- normalize plan capabilities
- normalize quota modes
- compose the effective entitlement object
- expose helper predicates for platform AI and transcription enforcement

The module has no HTTP types and no frontend assumptions.

### 9.2 Public Backend Service Functions

```python
def get_effective_entitlements(db: Session, user_id: UUID) -> EffectiveBillingEntitlements:
    ...

def get_billing_account(db: Session, user_id: UUID) -> BillingAccountOut:
    ...

def grant_entitlement_override(
    db: Session,
    *,
    user_id: UUID,
    plan_tier: PaidBillingPlanTier,
    platform_token_quota_mode: QuotaMode,
    platform_token_limit_monthly: int | None,
    transcription_quota_mode: QuotaMode,
    transcription_minutes_limit_monthly: int | None,
    expires_at: datetime | None,
    reason: str,
    actor_user_id: UUID | None,
    actor_label: str | None,
) -> BillingEntitlementOverride:
    ...

def revoke_entitlement_override(
    db: Session,
    *,
    user_id: UUID,
    reason: str,
    actor_user_id: UUID | None,
    actor_label: str | None,
) -> BillingEntitlementOverride:
    ...
```

`get_entitlements` is replaced by `get_effective_entitlements`. Call sites do
not keep both names.

### 9.3 Composition Algorithm

1. Query `BillingAccount` by `user_id`.
2. Normalize subscription:
   - inactive, missing, expired, or unknown plan becomes free subscription
     entitlement
   - active `plus`, `ai_plus`, `ai_pro` becomes subscription entitlement
3. Query `BillingEntitlementOverride` by `user_id`.
4. Normalize grant:
   - missing row is no grant
   - `revoked_at IS NOT NULL` is no grant
   - `expires_at IS NOT NULL AND now() >= expires_at` is no grant
   - otherwise derive grant entitlement
5. Select effective plan by rank:
   - `free = 0`
   - `plus = 1`
   - `ai_plus = 2`
   - `ai_pro = 3`
6. Select source:
   - `internal_grant` if an active grant increases plan rank or changes quota
     behavior
   - `subscription` if an active subscription supplies the effective access
   - `free` otherwise
7. Select quotas:
   - if grant is active and quota mode is `unlimited`, return `None`
   - if grant is active and quota mode is `custom`, return custom limit
   - otherwise return plan-configured finite limit
8. Select usage period:
   - active subscription with period start/end uses that period
   - otherwise calendar month `[first day 00:00 UTC, next month 00:00 UTC)`

Use the database clock for expiry checks.

## 10. API Design

### 10.1 `GET /billing/account`

Hard cutover response shape:

```json
{
  "billing_enabled": true,
  "billing_plan_tier": "free",
  "billing_status": "free",
  "subscription_current_period_start": null,
  "subscription_current_period_end": null,
  "cancel_at_period_end": false,
  "can_manage_billing": false,
  "entitlement_plan_tier": "ai_pro",
  "entitlement_source": "internal_grant",
  "entitlement_expires_at": null,
  "can_share": true,
  "can_use_platform_llm": true,
  "can_transcribe": true,
  "ai_token_usage": {
    "used": 12345,
    "reserved": 0,
    "limit": null,
    "remaining": null,
    "period_start": "2026-05-01T00:00:00Z",
    "period_end": "2026-06-01T00:00:00Z"
  },
  "transcription_usage": {
    "used": 37,
    "reserved": 0,
    "limit": null,
    "remaining": null,
    "period_start": "2026-05-01T00:00:00Z",
    "period_end": "2026-06-01T00:00:00Z"
  }
}
```

Removed fields:

- `plan_tier`
- `subscription_status`
- `current_period_start`
- `current_period_end`

Replacement fields:

- `billing_plan_tier`
- `billing_status`
- `subscription_current_period_start`
- `subscription_current_period_end`
- `entitlement_plan_tier`
- `entitlement_source`
- `entitlement_expires_at`
- `can_manage_billing`

### 10.2 `POST /billing/checkout`

No grant behavior. This endpoint only creates Stripe checkout sessions.

Internal grants do not block checkout. A granted user can still choose to pay if
the UI exposes that path later, but the default billing UI does not prompt an
unpaid internal-grant user to upgrade.

### 10.3 `POST /billing/portal`

No grant behavior. This endpoint only opens the Stripe portal for an existing
Stripe customer.

If `can_manage_billing` is false, the UI must not call this endpoint. If called
anyway without a Stripe customer, the endpoint fails with `E_BILLING_REQUIRED`.

### 10.4 No Public Grant API

There is no `/billing/grants` user-facing route in this scope. Grant operations
are backend operator commands only.

## 11. Operator Interface

Add a thin backend-owned CLI:

```text
python -m nexus.ops.entitlement_overrides show --email niels.erik.nandal@gmail.com
python -m nexus.ops.entitlement_overrides grant \
  --email niels.erik.nandal@gmail.com \
  --plan ai_pro \
  --platform-tokens unlimited \
  --transcription-minutes unlimited \
  --reason "Owner internal access"
python -m nexus.ops.entitlement_overrides revoke \
  --email niels.erik.nandal@gmail.com \
  --reason "Owner access revoked"
```

Rules:

- The command resolves email to `users.id` before mutating.
- Email lookup is case-insensitive.
- If no user exists, the command fails. It does not create users.
- Mutations use explicit SELECT then INSERT/UPDATE. No `INSERT ... ON CONFLICT`.
- Mutations use a single DB transaction.
- The database clock sets `created_at`, `updated_at`, and `revoked_at`.
- The command prints the effective entitlement after mutation.
- The command never writes Stripe fields.

The CLI may live under `python/nexus/ops/` or `python/scripts/`, but mutation
logic must live in a service module so tests can exercise behavior without
shelling out.

## 12. Composition With Existing Systems

### 12.1 Auth

FastAPI auth continues to identify the user via `viewer.user_id`. Grant
evaluation never trusts email claims at request time. Email is only an operator
lookup input.

JWT roles and app metadata are not used for entitlement overrides.

### 12.2 Stripe

Stripe checkout and webhook flows continue to write `billing_accounts`.
Stripe never writes internal grants. Internal grant code never writes Stripe
customer, subscription, or price fields.

Portal access is based on Stripe customer existence, not effective entitlement.

### 12.3 Platform AI Key Resolution

`api_key_resolver.resolve_api_key` uses effective entitlements:

- `byok_only` remains independent of billing grant state.
- `platform_only` requires `can_use_platform_llm`.
- `auto` uses BYOK first, then platform key if `can_use_platform_llm`.

Provider feature flags and configured platform keys still apply. A grant cannot
make a disabled provider available.

### 12.4 Model Listing

Model listing uses effective entitlements to decide whether platform-backed
models are visible. BYOK visibility remains unchanged.

### 12.5 Chat And Oracle Token Quotas

All platform-key AI execution uses the effective entitlement object. Finite
quotas reserve and charge against monthly token budget. Unlimited quotas skip
the monthly cap but still charge usage for observability and cost review.

Retry paths and worker paths must use the same policy object. There is no
separate retry-only entitlement path.

### 12.6 Transcription

Podcast/media transcription uses effective `can_transcribe` and
`transcription_minutes_limit_monthly`.

Finite quotas preserve current reservation and commit semantics. Unlimited
quotas bypass monthly cap failures but continue to record minutes used.

### 12.7 Sharing

Sharing checks `can_share` from effective entitlements. An internal `plus`,
`ai_plus`, or `ai_pro` grant can unlock sharing without Stripe.

### 12.8 Frontend And BFF

Next.js API routes remain transport-only proxies. They do not compute
entitlements.

Frontend billing types are updated to the hard-cutover API shape. The UI renders:

- effective plan label from `entitlement_plan_tier`
- billing/payment status from `billing_status`
- internal access state from `entitlement_source`
- `Unlimited` for `limit: null`
- no portal button unless `can_manage_billing`

Frontend feature gates use backend booleans and usage limits from
`/api/billing/account`. They do not infer access from local plan strings.

### 12.9 Test And Seed Data

Test helpers that need unpaid AI access use entitlement overrides. Tests that
exercise Stripe billing still use `billing_accounts`.

E2E seed code must stop creating fake active `billing_accounts` solely to unlock
AI/transcription. It should create an internal grant instead.

## 13. Files In Scope

Expected new files:

- `docs/billing-entitlement-overrides.md`
- `migrations/alembic/versions/005X_billing_entitlement_overrides.py`
- `python/nexus/services/billing_entitlements.py`
- `python/nexus/ops/entitlement_overrides.py`
- `python/tests/test_billing_entitlement_overrides.py`

Expected changed backend files:

- `python/nexus/db/models.py`
- `python/nexus/schemas/billing.py`
- `python/nexus/services/billing.py`
- `python/nexus/services/api_key_resolver.py`
- `python/nexus/services/models.py`
- `python/nexus/services/rate_limit.py`
- `python/nexus/services/chat_run_validation.py`
- `python/nexus/services/chat_runs.py`
- `python/nexus/services/oracle.py`
- `python/nexus/services/podcasts/transcripts.py`
- `python/nexus/services/shares.py`
- `python/nexus/api/routes/billing.py`
- `python/scripts/seed_e2e_data.py`
- `python/tests/real_media/conftest.py`

Expected changed frontend files:

- `apps/web/src/lib/billing/useBillingAccount.ts`
- `apps/web/src/lib/billing/planLabel.ts`
- `apps/web/src/app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptStatePanel.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/settings/billing/page.test.tsx`
- Android-shell billing-state tests that fixture billing account responses

Expected unchanged files:

- Next.js BFF route files under `apps/web/src/app/api/billing/*/route.ts`,
  except type-only fallout if local conventions require it.
- `.env.example`, unless implementation adds new environment variables. This
  spec does not require any.

## 14. Implementation Plan

### Phase 1: Schema

1. Add Alembic migration for `billing_entitlement_overrides`.
2. Add Alembic migration for `billing_entitlement_override_events`.
3. Add SQLAlchemy models.
4. Add migration tests for constraints and unique `user_id`.

### Phase 2: Entitlement Domain

1. Add `billing_entitlements.py`.
2. Move plan capability derivation out of `billing.py`.
3. Replace `get_entitlements` with `get_effective_entitlements`.
4. Update `BillingAccountOut` and usage bucket schemas for nullable limits.
5. Update billing account assembly to expose billing state and entitlement
   state separately.

### Phase 3: Enforcement

1. Update platform AI key resolution to use effective entitlements.
2. Update model listing to use effective entitlements.
3. Update token budget check/reserve/commit paths for nullable unlimited
   limits.
4. Update chat pre-validation, chat worker, retry, and Oracle paths so they all
   call the same entitlement/quota policy.
5. Update transcription access and quota enforcement for nullable unlimited
   limits.
6. Update sharing to use effective entitlements.

### Phase 4: Operator Tooling

1. Add grant/show/revoke service functions.
2. Add CLI wrapper.
3. Ensure CLI prints before/after effective entitlements.
4. Ensure CLI writes audit events in the same transaction as mutations.

### Phase 5: Frontend Cutover

1. Update TypeScript billing types.
2. Update settings billing pane for new response fields.
3. Render internal grant state distinctly from Stripe subscription status.
4. Hide portal action unless `can_manage_billing`.
5. Render nullable usage limits as `Unlimited`.
6. Update transcript and podcast gating to use `can_transcribe` and nullable
   limits.

### Phase 6: Test/Seed Cutover

1. Replace unpaid fake paid-plan setup with internal grants.
2. Keep Stripe tests on `billing_accounts`.
3. Update all fixtures to the new hard-cutover API shape.
4. Remove compatibility helpers for the old shape.

## 15. Acceptance Criteria

### 15.1 Backend Entitlements

- A user with no billing account and no grant receives `entitlement_source =
  "free"` and `entitlement_plan_tier = "free"`.
- A user with active `ai_pro` Stripe state and no grant receives
  `entitlement_source = "subscription"` and finite AI Pro limits.
- A user with no Stripe state and an active `ai_pro` unlimited grant receives
  `entitlement_source = "internal_grant"`, `entitlement_plan_tier = "ai_pro"`,
  and `None` monthly token/transcription limits.
- A revoked grant is ignored.
- An expired grant is ignored at `now() >= expires_at`.
- An active lower-rank grant does not reduce a higher-rank paid subscription.
- `0` custom quota blocks usage and is not displayed as unlimited.
- Unknown or invalid plan data fails closed to free or raises a defect according
  to the boundary where it is detected.

### 15.2 API

- `GET /billing/account` returns the hard-cutover response shape.
- Old fields are absent.
- Unlimited usage buckets have `limit: null` and `remaining: null`.
- Internal audit fields are absent.
- `can_manage_billing` is false for a grant-only user with no Stripe customer.
- `POST /billing/portal` still fails for a grant-only user with no Stripe
  customer.
- `POST /billing/checkout` writes no grant state.

### 15.3 Enforcement

- Grant-only `ai_pro` user can use platform LLMs in `auto` and
  `platform_only` modes when provider keys are configured.
- Grant-only `ai_pro` user sees platform models.
- Grant-only `ai_pro` user can request transcription.
- Grant-only `ai_pro` user can use sharing.
- Free user without grant receives the existing billing-required errors.
- Unlimited grant user is not blocked by monthly token or transcription caps.
- Unlimited grant user still records token and transcription usage.
- RPM and concurrency limits still apply to unlimited grant users.
- Provider-disabled errors still apply to grant users.

### 15.4 Operator Tooling

- `show --email` resolves a user case-insensitively and prints current billing
  and entitlement state.
- `grant --email ... --plan ai_pro --platform-tokens unlimited
  --transcription-minutes unlimited` creates or updates one override row.
- Grant mutation writes exactly one audit event.
- `revoke --email` sets `revoked_at` and writes exactly one audit event.
- Missing user causes a non-zero exit and no writes.
- The tooling does not use `INSERT ... ON CONFLICT`.

### 15.5 Frontend

- Settings billing displays effective AI Pro access for a grant-only user.
- Settings billing distinguishes internal access from Stripe subscription
  status.
- Settings billing renders token and transcription limits as `Unlimited`.
- Settings billing hides "Manage billing" for a grant-only user with no Stripe
  customer.
- Transcript and podcast UI unlock paid transcription behavior from backend
  entitlement state, not local plan-string inference.
- Existing paid Stripe users still see billing portal behavior.

### 15.6 Tests

- Backend service tests cover subscription-only, grant-only, both, expired, and
  revoked cases.
- Migration tests cover all grant table constraints.
- API tests assert the hard-cutover billing response shape.
- Token budget tests cover finite, zero, and unlimited limits.
- Transcription quota tests cover finite, zero, and unlimited limits.
- Frontend tests cover internal-grant billing UI and nullable usage limits.
- E2E/real-media setup uses internal grants for unpaid AI access.

## 16. Rules

- Do not add a global superuser flag.
- Do not hardcode `niels.erik.nandal@gmail.com` in application code.
- Do not store email on the grant row as the authority.
- Do not use Stripe fields to represent unpaid access.
- Do not use `0`, `-1`, or a huge integer as unlimited.
- Do not expose audit reasons or event snapshots through user-facing APIs.
- Do not put grant logic in Next.js BFF routes.
- Do not put entitlement calculations in React.
- Do not add speculative indexes beyond primary keys and the unique `user_id`
  key unless a measured query pattern requires them.
- Do not use `INSERT ... ON CONFLICT` for operator grant mutation logic.
- Use database `now()` for timestamps and expiry semantics.
- Use right-open time intervals for grant expiry and usage periods.
- Keep external side effects out of grant DB transactions.
- Every new paid capability must define how `plus`, `ai_plus`, `ai_pro`, and
  active internal grants affect it before shipping.

## 17. Operational Runbook

After deployment:

1. Confirm the owner user exists:

   ```text
   SELECT id, email FROM users WHERE lower(email) = lower('niels.erik.nandal@gmail.com');
   ```

2. Grant owner access:

   ```text
   python -m nexus.ops.entitlement_overrides grant \
     --email niels.erik.nandal@gmail.com \
     --plan ai_pro \
     --platform-tokens unlimited \
     --transcription-minutes unlimited \
     --reason "Owner internal access"
   ```

3. Verify through the API:

   ```text
   GET /api/billing/account
   ```

   Expected:

   ```text
   billing_plan_tier = free unless the user also pays through Stripe
   entitlement_plan_tier = ai_pro
   entitlement_source = internal_grant
   ai_token_usage.limit = null
   transcription_usage.limit = null
   can_manage_billing = false unless a Stripe customer exists
   ```

4. Run a platform AI request and a transcription request.
5. Confirm usage increments while limits remain unlimited.

## 18. Verification Commands

Targeted local gates:

```text
make type-back
python -m pytest python/tests/test_billing.py python/tests/test_billing_entitlement_overrides.py
python -m pytest python/tests/test_chat_runs.py python/tests/test_oracle.py
python -m pytest python/tests/test_podcasts.py -k "transcription and quota"
pnpm --dir apps/web test -- settings/billing
```

Broader gates before merge:

```text
make check
make test-back-unit
make test
make test-e2e
```

## 19. Final State

The final system has one backend entitlement contract and two explicit state
inputs:

```text
Stripe subscription snapshot -> payment/account state
Internal entitlement override -> unpaid capability grant
```

Runtime systems consume only the composed effective entitlement:

```text
effective entitlement -> sharing, model listing, platform key resolution,
token quotas, transcription quotas, billing UI
```

There is no superuser concept, no fake subscription, no frontend entitlement
logic, no old API shape, and no compatibility path. A specific user can be given
full paid capabilities without paying, and that grant is explicit, revocable,
audited, and isolated to product access.
