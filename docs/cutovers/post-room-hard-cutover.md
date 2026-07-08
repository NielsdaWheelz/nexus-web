# The Post Room — a private ingest email address — Hard Cutover

**Status:** Spec · Rev 1 · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims. (Additive
*mouth*: it introduces a new source of media, so nothing existing is deleted —
but it is held to cutover discipline: one owner per concern, one HMAC verify,
one sender-resolution path, no flags-for-old-behavior. The single flag it adds,
`EMAIL_INGEST_ENABLED`, gates a route that cannot function without external
Cloudflare setup; it is a *route-mount* switch, not a behavior toggle.)

## One-line

A private ingest address turns newsletters into first-class reading: mail arrives
at a Cloudflare Email Worker, is HMAC-signed and POSTed to one public endpoint,
becomes a `web_article` through the *existing* readability→fragment→chunk→embed
path, and its sender resolves through the contributor identity system — the one
subsystem built to exactly this depth (aliases, merges, external IDs), which
finally earns its keep.

---
## 0. Prerequisites (hard, no fallback)

- **P-1.** The durable source-attempt contract exists and is the sole ingest
  spine: `media_source_types.py` (source-type string constants +
  `WEB_ARTICLE_ARTIFACT_SOURCE_TYPES` / `NON_REACQUIRABLE_FILE_SOURCE_TYPES`
  frozensets — the latter is **renamed to `NON_REACQUIRABLE_ARTIFACT_SOURCE_TYPES`**
  by this cutover, D-10) and `media_source_ingest.run_source_attempt`
  (`python/nexus/services/media_source_ingest.py:913`), which dispatches on
  `attempt.source_type` to per-type runners. `BROWSER_ARTICLE_CAPTURE` (pre-captured,
  non-reacquirable HTML) is the exemplar this cutover clones:
  `accept_browser_article_capture` (`:328`) and `_run_browser_article_capture`
  (`:2407`).
- **P-2.** The shared web-article HTML pipeline is
  `web_article_structure.prepare_web_article_fragment`
  (`python/nexus/services/web_article_structure.py:68`) → `sanitize_html`
  (`python/nexus/services/sanitize_html.py`, `add_heading_anchors`,
  `generate_canonical_text`). This is the **sole sanitizer** for captured HTML;
  the Post Room reuses it byte-for-byte — no second HTML path.
- **P-3.** `Media` carries `provider` + `provider_id`
  (`python/nexus/db/models.py:1108-1109`) with a **partial unique index**
  precedent: `uix_media_x_provider_id` on `(provider, provider_id)`
  `WHERE provider = 'x' AND provider_id IS NOT NULL`
  (`python/nexus/db/models.py:1163-1169`). Media dedupe copies this exact shape.
- **P-4.** `MediaSourceAttempt.source_type` is a `Text` column guarded by CHECK
  `ck_media_source_attempts_source_type` (`python/nexus/db/models.py:1305-1324`)
  — the enumerated allowlist widened by this cutover.
- **P-5.** Contributor identity machinery: `Contributor` / `ContributorAlias` /
  `ContributorExternalId` / `ContributorCredit`
  (`python/nexus/db/models.py:1444-1691`); `ContributorExternalId.authority` CHECK
  `ck_contributor_external_ids_authority` (`:1582`) with
  `UNIQUE(authority, external_key)` `uq_contributor_external_ids_authority_key`
  (`:1587`); the resolver `resolve_or_create_contributor`
  (`python/nexus/services/contributors.py:1399`, existing-external-id-match →
  attach → create-unverified, race-safe under `db.begin_nested()`); the credit
  writer `replace_media_contributor_credits`
  (`python/nexus/services/contributor_credits.py:50`); and the strong-authority
  identity gate `STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES`
  (`python/nexus/services/contributor_taxonomy.py:36`). Merges stay an explicit
  human verb (authors cutover; `CONFIRMED_ALIAS_SOURCES` includes `'merge'`).
- **P-6.** Default-library landing is `ensure_media_in_default_library`
  (`python/nexus/services/library_entries.py:1035`) → `ensure_default_intrinsic`
  (intrinsic membership, no closure edges). This is the sole "file it where a
  normal add goes" helper.
- **P-7.** The auth middleware (`python/nexus/auth/middleware.py`) has a
  first-checked `PUBLIC_PATHS` set (`{"/health", "/docs", "/redoc",
  "/openapi.json", "/billing/stripe/webhook"}`) evaluated *before* the
  internal-header check and the bearer check. `/billing/stripe/webhook`
  (`python/nexus/api/routes/billing.py:51`) is the exact precedent: an external
  caller that authenticates via a body-signature, not a session — mounted
  public, bearer-exempt, internal-header-exempt. The Post Room endpoint copies
  this precedent verbatim. (The oracle-plate route at `middleware.py` "startswith
  `/oracle/plates/`" is a *BFF-only* exemption that still requires the internal
  header — the wrong precedent for an externally-reachable endpoint.)
- **P-8.** Router registration is `create_api_router`
  (`python/nexus/api/routes/__init__.py`), which conditionally mounts routers
  behind config flags (`if settings.podcasts_enabled: include_router(...)`) — the
  precedent for gating a router on a settings flag.
- **P-9.** `FailureStage` enum (`python/nexus/db/models.py:73-86`) has value
  `extract`. Ingest failures set `failure_stage='extract'` via `mark_failed`
  (`media_processing_state`) and surface in the standard failed-media list —
  junk mail is visible and deletable, never silent.
- **P-10.** The account settings surface is `SettingsAccountPaneBody`
  (`apps/web/src/app/(authenticated)/settings/account/SettingsAccountPaneBody.tsx`),
  a `PaneSurface` of `PaneSection`s backed by `settingsAccountResource`
  (`apps/web/src/lib/api/resource.ts:150`, `GET /me`), served by `me.get_me`
  (`python/nexus/api/routes/me.py:36`). The Post Room address renders as one new
  read-only `PaneSection` here.
- **P-11.** Deploy substrate: `deploy/hetzner/Caddyfile` `reverse_proxy api:8000`
  proxies **all** of `/` (no path allowlist — verified) so `/ingest/email` needs
  no Caddy change; `deploy/hetzner/sync-env.sh` `require_non_empty_keys` gates
  required env per-flag (`if is_true "$billing_enabled"` block is the precedent);
  `deploy/env/env-prod-backend` holds the backend env; `deploy/cloudflare/`
  already exists (R2 CORS/lifecycle scripts) — the new worker lives beside them.
- **P-12.** Sibling cutovers at the shared boundary (all **SPEC**): only
  `dawn-write-hard-cutover.md` widens a CHECK (`ck_llm_calls_owner_kind`) — the Post
  Room widens two *different* CHECKs, no collision; `machine-hand` owns the
  machine-voice register (Post Room adds none). The rest (`reader-sidecar-consolidation`,
  `machine-output-in-place`, `daily-surface-consolidation`, `browse-surface-deletion`,
  `running-journal`, `two-rooms`, `oracle-shell-dissolution`, `walknotes`) touch
  neither ingest, `media_source_types`, contributors, nor the account settings pane.
  Detail in §10.

---
## 1. Problem (grounded diagnosis)

### 1.1 The largest reading mouth is missing entirely.

Every ingest path in the product requires the user to *push* a URL, a file, or a
browser capture: `accept_browser_article_capture`, remote-file, X, YouTube,
podcast — all pull-initiated. There is no *inbound* channel. A serious reading
tool that cannot receive the dozens of newsletters a reader already subscribes
to is deaf to the single highest-volume stream of long-form writing in a modern
reading life. `rg -n "email" python/nexus/services/media_source_ingest.py`
returns **zero** ingest matches — no placeholder, no dead scaffolding
(§9 confirms). The mouth was never built.

### 1.2 The contributor identity system is over-built for what feeds it.

`Contributor` supports aliases, cross-authority external IDs
(`orcid/isni/viaf/wikidata/openalex/lcnaf/podcast_index/rss/youtube/gutenberg`),
merge/tombstone status, and a race-safe resolver
(`resolve_or_create_contributor`, `python/nexus/services/contributors.py:1399`).
Today it is fed almost entirely by machine-derived byline strings
(`_persist_browser_article_metadata`, `:2747`, splits a byline on commas/"and"
and writes `source='web_article_capture'` credits with **no** external-id
anchor) and by strong bibliographic authorities on a handful of ingest lanes. A
newsletter's `From:` header is a **stable, self-asserted identity key** — the
same address across a year of issues is provably the same sender. Nothing in the
product resolves senders by it. The identity depth exists; the highest-signal
recurring identity in a reader's inbox is thrown on the floor with every message.

---
## 2. Target behavior (user-facing)

**Reader.** You forward or auto-subscribe a newsletter to your private address
`<slug>@<ingest-domain>`. Within the normal ingest latency it appears in your
default library as a readable `web_article`: the issue's title is the mail
Subject, the byline is the resolved sender, the body reads through the same
typeset reader as any web capture. Its author links to an `/authors/<handle>`
page that accretes every issue from that sender.

**Sender identity.** The second issue from the same address credits the **same**
contributor as the first — no duplicate author. A sender you have separately
verified or merged (a human verb) keeps its curated identity; the Post Room
never re-splits it and never auto-merges two senders.

**Duplicate delivery.** The same message delivered twice (list + personal copy,
retry) is a no-op — the second POST returns `200` and creates nothing.

**Junk / broken mail.** Mail that authenticates but yields no readable text
lands as a **failed** media (`failure_stage='extract'`) in the normal failed-media
surface — visible, inspectable, deletable. It is never silently dropped.

**Settings.** The account settings pane shows your ingest address with a copy
affordance and a one-line note: rotation is an env change + redeploy. No inbox
UI, no per-sender rules, no filing automation.

**Attacker at the address.** A leaked address is a capability leak, not an account
compromise (no session/cookie/bearer). Rotating the slug instantly invalidates it;
size caps + Message-ID dedupe bound spam damage; junk is a visible, deletable
failed media (blast radius bounded and legible). Detail in R-1.

---
## 3. Goals / Non-goals

**G-1.** One private inbound address; mail becomes a `web_article` with full
provenance (sender credited, subject as title, Date as `published_date`).
**G-2.** One HTTP endpoint, one HMAC verify, one sender-resolution path — reusing
the existing sanitizer, fragment pipeline, contributor resolver, and default-library
landing unchanged.
**G-3.** Idempotent by `Message-ID`; duplicate delivery is a no-op.
**G-4.** Auth is a raw-body HMAC + a secret recipient slug, verified **before any
MIME parse**; constant-time compare; no session interaction.
**G-5.** The contributor identity system does the sender resolution — external-id
match → create unverified — with `authority='email'` and **no auto-merge**.
**G-6.** Junk is visible: authenticated-but-unreadable mail becomes failed media
at `extract` stage.
**G-7.** The API side is fully testable with curl + MIME fixtures, with **zero**
dependency on the Cloudflare worker being deployed.

**N-1.** No new `MediaKind`. Email is a `web_article` distinguished by
`source_type`, not a top-level kind (§8 D-2).
**N-2.** No per-sender routing/filing rules engine, no auto-classification, no
LLM triage. Filing is the user's or the Amanuensis's verb (explicit-UI doctrine).
**N-3.** No auto-merge of contributors. Merge stays a human verb.
**N-4.** No inbox surface, no threading, no reply, no send. This is a mouth, not
a mail client.
**N-5.** No new machine-voice register, no MachineText origin, no colophon.
**N-6.** No new vendor. Cloudflare (already the house CDN + R2) is the transport.
**N-7.** No IMAP/POP polling, no stored mailbox credentials, no inbound state
machine beyond the durable `MediaSourceAttempt` already used by every lane.
**N-8.** No per-user DB-stored slugs (premature multi-tenancy). The slug is env.

---
## 4. Architecture and final state

### 4.1 Ownership table

| Concern | Sole owner (final) | Replaces |
| --- | --- | --- |
| Inbound mail transport, size cap, HMAC signing, recipient extraction | `deploy/cloudflare/email-worker/worker.js` (+ `wrangler.toml`, `README.md`) | (new — the only place that speaks SMTP/Email-Routing) |
| HTTP ingest endpoint: HMAC verify, slug gate, size re-check, enqueue | `python/nexus/api/routes/email_ingest.py` | (new) |
| HMAC verify primitive (constant-time, raw body) | `email_ingest_service.verify_email_signature` | (new — the *only* email HMAC implementation) |
| MIME → HTML extraction (prefer `text/html`, fall back wrapped `text/plain`) | `email_ingest_service.extract_email_html` | (new) |
| Accept: create `Media` + `MediaSourceAttempt`, dedupe, land in default library | `email_ingest_service.accept_email_message` | (new — models `accept_browser_article_capture`) |
| Run the shared HTML-in-storage body path (fetch derived HTML from R2 → `begin_extraction` → `prepare_web_article_fragment` → fragment/blocks write → `mark_ready_for_reading` → `replace_media_apparatus`) | `media_source_ingest._run_prepared_html_article` (shared) | extracted from `_run_browser_article_capture`; **shared** by browser-capture and email |
| Browser-capture-only: `source_storage_path` fetch, `embed_source_html=source_html`, `extract_embeds=True`, `replace_document_embed_artifact` (child-media embeds), `_persist_browser_article_metadata` (byline/excerpt/site_name) | `media_source_ingest._run_browser_article_capture` (caller) | unchanged — **stays in the caller**, NOT in the shared helper |
| Email-only run wiring (no `source_storage_path`, `extract_embeds=False`, no embed children, no byline persist) | `media_source_ingest._run_email_message` (caller) → `_run_prepared_html_article` | new dispatch branch (D-9) |
| Sender → contributor resolution | `contributor_credits.replace_media_contributor_credits` → `contributors.resolve_or_create_contributor` (`authority='email'`) | reuses existing resolver unchanged |
| Address surface | `SettingsAccountPaneBody` "Post Room" section + `/me` field (`UserProfileOut`) | (new) |
| Config / route-mount flag / owner id | `config.Settings` (`EMAIL_INGEST_*`) | (new) |

**The seam (single owner per sub-behavior).** `_run_prepared_html_article(db,
media_id, attempt, *, source_storage_path: str | None, extract_embeds: bool,
request_id)` owns **only** the concerns common to both callers: stream derived HTML
from `storage_path`, `begin_extraction`, `prepare_web_article_fragment`, the
empty-text guard, `Fragment` + `insert_fragment_blocks`, `mark_ready_for_reading`,
`replace_media_apparatus`. Caller-specific concerns are passed in or done around
the call: (a) `source_storage_path` fetch + `embed_source_html=source_html` —
browser only (`None` for email; helper skips the second R2 read); (b)
`extract_embeds` + `replace_document_embed_artifact` child-media embeds — browser
`True`, **email `False`** so `prepared.document_embeds` is empty and no child media
are created (D-9); (c) `_persist_browser_article_metadata` (byline→credit, excerpt,
site_name) — **browser-only, NOT in the shared helper**; email supplies its credit
at accept time (S2), never via byline.

**Invariant restated:** the sanitizer (P-2), the fragment/chunk/embed pipeline,
the contributor resolver (P-5), and the default-library landing (P-6) are **not
re-implemented**. The Post Room is transport + parse + one dispatch branch (email
passes `source_storage_path=None`, `extract_embeds=False`, no byline persist) +
one authority value.

### 4.2 Request flow

```
Cloudflare Email Routing
  → email-worker (worker.js):
       raw MIME bytes; reject >2MB with a bounce; compute
       HMAC-SHA256(raw, EMAIL_INGEST_HMAC_SECRET);
       POST https://<api>/ingest/email
         headers: X-Nexus-Email-Signature: <hex>
                  X-Nexus-Email-Recipient: <to-address>
         body: raw MIME
  → Caddy reverse_proxy api:8000  (no path change; P-11)
  → AuthMiddleware: path in PUBLIC_PATHS → skip session/internal auth (P-7)
  → POST /ingest/email (email_ingest.py):
       1. EMAIL_INGEST_ENABLED else 404 (route not mounted)
       2. len(body) > EMAIL_INGEST_MAX_BYTES → 413  (re-check; never trust worker)
       3. verify_email_signature(body, header, secret) constant-time → 401
          (BEFORE any parse)
       4. hmac.compare_digest(recipient slug, EMAIL_INGEST_ADDRESS_SLUG)
          constant-time → 403 (the slug is a capability secret; no string ==)
       5. accept_email_message(...):
            parse (message_from_bytes, bounded walk)
            normalize Message-ID; if Media(provider='email', provider_id=mid)
              exists → return 200 {"outcome":"duplicate"}  (idempotent no-op,
              at the Media layer — before any attempt is created)
            extract HTML (text/html | wrapped text/plain)
            create Media(kind=web_article, provider='email', provider_id=mid,
                         title=Subject, published_date=Date,
                         created_by_user_id=EMAIL_INGEST_OWNER_USER_ID)
            store derived HTML to R2; create MediaSourceAttempt(
              source_type='email_message',
              intent_key=_intent_key('email_message', mid, None)); land intrinsic
              in default library (owner = created_by_user_id);
            resolve sender credit (authority='email', role='author')
            enqueue ingest_media_source (actor_user_id = str(media.created_by_user_id))
       6. 200 {"outcome":"accepted","media_id":...}
  → worker: pipeline runs on the standard job → fragment/chunk/embed
```

### 4.3 `email_message` source type

`email_message` joins `WEB_ARTICLE_ARTIFACT_SOURCE_TYPES` (its HTML flows the web
pipeline) **and** the non-reacquirable set. That set is **renamed** from
`NON_REACQUIRABLE_FILE_SOURCE_TYPES` to `NON_REACQUIRABLE_ARTIFACT_SOURCE_TYPES`
by this cutover (D-10): an email is not a *file*, but it is a non-reacquirable
*artifact* — a delivered message can never be re-fetched, the HTML in R2 is the
only copy. The run branch shares `_run_prepared_html_article` with
`browser_article_capture` (§4.1 seam): both are "pre-captured HTML already in
storage → sanitize → fragment → ready"; email differs only in the seam parameters
(`source_storage_path=None`, `extract_embeds=False`, no byline persist).

---
## 5. Data model / migration

One migration, `NNNN_post_room.py`. **Number assigned at build time — main ends
at `0168_web_article_inline_embeds` (the search-retrieval-roadmap migrations have
already merged and renumbered below 0168); the sibling `dawn-write` spec claims
0169. Take the next free number at build time and set `down_revision` to the then-head.**
All three changes are additive (widen two CHECKs, add one partial unique index):

**(1) Widen `ck_media_source_attempts_source_type`** — add `'email_message'` to
the allowlist. Drop + recreate the named CHECK with the value appended (mirror
the model literal in `python/nexus/db/models.py:1305`).

**(2) Widen `ck_contributor_external_ids_authority`** — add `'email'`:

```sql
ALTER TABLE contributor_external_ids DROP CONSTRAINT ck_contributor_external_ids_authority;
ALTER TABLE contributor_external_ids ADD CONSTRAINT ck_contributor_external_ids_authority
  CHECK (authority IN ('orcid','isni','viaf','wikidata','openalex','lcnaf',
                       'podcast_index','rss','youtube','gutenberg','email'));
```

**(3) Media email dedupe — partial unique index** (clone of `uix_media_x_provider_id`):

```sql
CREATE UNIQUE INDEX uix_media_email_provider_id
  ON media (provider, provider_id)
  WHERE provider = 'email' AND provider_id IS NOT NULL;
```

Model mirrors (`models.py`, so `make test-migrations` diff is clean): append
`'email_message'` to the `ck_media_source_attempts_source_type` literal (`:1305`);
append `'email'` to the `ck_contributor_external_ids_authority` literal (`:1582`);
add `uix_media_email_provider_id` `Index(...)` beside `uix_media_x_provider_id`
(`:1163`).

`downgrade`: reverse each (recreate the narrower CHECKs, drop the index). Note:
downgrade fails loudly if any `authority='email'` / `source_type='email_message'`
row exists — acceptable (greenfield-drop discipline; documented in the migration).

No new tables. Reading-session / attention state is **not** part of this cutover
(that is `attention-ledger-hard-cutover.md`).

---
## 6. API

| Method | Path | Auth | Owner | Notes |
| --- | --- | --- | --- | --- |
| `POST` | `/ingest/email` | **HMAC body-signature + slug** (in `PUBLIC_PATHS`; no bearer/session/internal-header) | `email_ingest.py` | raw MIME body; `X-Nexus-Email-Signature`, `X-Nexus-Email-Recipient`; mounted only when `EMAIL_INGEST_ENABLED`. `200` accepted/duplicate; `401` bad/absent signature; `403` slug mismatch; `413` oversize; `400` unparseable MIME / no sender; `404` when disabled. |
| `GET` | `/me` (extended) | bearer (existing) | `me.get_me` | response gains `email_ingest_address: string \| null` (config-derived: `"<slug>@<domain>"` when enabled, else `null`). No new route. |

Config (`python/nexus/config.py`, `Settings`):

| Field | Alias | Default | Purpose |
| --- | --- | --- | --- |
| `email_ingest_enabled` | `EMAIL_INGEST_ENABLED` | `False` | route-mount switch (D-1) |
| `email_ingest_hmac_secret` | `EMAIL_INGEST_HMAC_SECRET` | `None` | shared HMAC secret (worker ↔ endpoint) |
| `email_ingest_address_slug` | `EMAIL_INGEST_ADDRESS_SLUG` | `None` | the capability slug (local-part) |
| `email_ingest_domain` | `EMAIL_INGEST_DOMAIN` | `None` | display domain for the settings surface |
| `email_ingest_owner_user_id` | `EMAIL_INGEST_OWNER_USER_ID` | `None` | the single human owner the media is filed for (D-4) |
| `email_ingest_max_bytes` | `EMAIL_INGEST_MAX_BYTES` | `2_097_152` | 2 MB raw-MIME cap (endpoint re-check) |

`Settings.validate` (mirror the billing block): when `email_ingest_enabled`,
require `EMAIL_INGEST_HMAC_SECRET`, `EMAIL_INGEST_ADDRESS_SLUG`,
`EMAIL_INGEST_DOMAIN`, `EMAIL_INGEST_OWNER_USER_ID`.

Deploy:
- `deploy/env/env-prod-backend` + `.example`: add the six keys
  (`EMAIL_INGEST_ENABLED=false` until infra exists).
- `deploy/hetzner/sync-env.sh`: add an `is_true "$email_ingest_enabled"` block in
  `require_non_empty_keys` requiring the four non-defaulted keys (mirror the
  `BILLING_ENABLED`/`PODCASTS_ENABLED` blocks).
- `deploy/hetzner/Caddyfile`: **no change** (proxies all `/`; P-11).

---
## 7. Frontend

Minimal — one read-only section; no new pane, no new route.

**Modified — `apps/web/src/app/(authenticated)/settings/account/SettingsAccountPaneBody.tsx`:**
add a `<PaneSection title="Post Room">` after the existing "Display name" section.
It reads `accountResource.data.data.email_ingest_address` (extend the local
`AccountResponse` type). When non-null it renders the address as calm, borderless
type-forward content (no card): the address in a `<code>`-register line, a copy
button (`Button variant` reusing the existing account pane primitives), and a
dimmed one-liner: *"Forward newsletters here. Rotating the address is an env
change + redeploy."* When null: *"The Post Room is not configured."* Status is a
small-caps text label, never a pill (design doctrine). No new tokens.

**Adoption map:**

| Surface | Change |
| --- | --- |
| `SettingsAccountPaneBody.tsx` | + `Post Room` `PaneSection` (address + copy + rotate note) |
| `AccountResponse` local type | + `email_ingest_address?: string \| null` |
| `UserProfileOut` (`python/nexus/schemas/user.py`) | + `email_ingest_address: str \| None = None` |
| `me.get_me` (BE) | + `Depends(get_settings)`; sets `email_ingest_address` on the profile (config-derived) |

**Backend `/me` wiring.** `ok()` serializes a `BaseModel` via
`model_dump(mode="json")`, so the field must exist on `UserProfileOut`. Add
`email_ingest_address: str | None = None` to `UserProfileOut`
(`python/nexus/schemas/user.py`); inject `Depends(get_settings)` into `get_me`
(which today takes none) and set the field from the config-derived value
(`"<slug>@<domain>"` when `email_ingest_enabled`, else `None`) before `ok()`.

No change to `MediaPaneBody`, reader, presenters, `DESTINATIONS`, `PaneRouteId`,
launcher, or nav: an email arrives as an ordinary `web_article` and every existing
surface already renders `web_article`.

---
## 8. Key decisions

**D-1. One acceptable flag: `EMAIL_INGEST_ENABLED` (default false).** The route
requires external Cloudflare Email-Routing + a worker + DNS MX before it can
function; mounting it unconditionally would expose a public POST endpoint on
every environment (including local/CI) with no upstream. The flag gates
*route registration* (P-8 precedent), not a behavior branch — there is no
"old" email path to fall back to. *Rejected:* always-mount + 503 when
unconfigured (still a live public attack surface in CI/local); a per-request
"is configured" check inside the handler (leaks the endpoint's existence).

**D-2. Email is a `web_article`, distinguished by `source_type`, not a new
`MediaKind`.** Reader, search, presenters, deletion, apparatus, and library
surfaces switch on `Media.kind` in dozens of places; adding `kind='email'` would
fork every one of them. The message's HTML *is* a web article. The distinction
that matters (provenance, non-reacquirable, sender-as-author) is carried by
`source_type='email_message'`, `provider='email'`, and the credit — exactly where
X and browser-capture already carry their distinctions. *Rejected:* `MediaKind.email`
(forks the whole reader/search/presenter surface for zero reader-facing benefit).

**D-3. `authority='email'` is a *resolving* (strong) authority, added to
`STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES`.** The whole payoff is that the
second issue from an address resolves to the *same* contributor as the first.
`resolve_or_create_contributor` only resolves-by-external-id when the credit
carries strong-authority evidence (`_strong_external_id_evidence`,
`contributor_credits.py:546`, filters to the strong set), so `email` must join
that set or sender resolution silently degrades to name-only (duplicating a
contributor per issue). Crucially this does **not** violate the no-auto-merge
doctrine: external-id resolution matches only within `(authority, external_key)`
(`uq_contributor_external_ids_authority_key`), so an `email` id resolves *only*
to a prior `email` id for the same address — it never merges an email-sender with
an ORCID contributor; email→email is idempotency, not cross-authority merge.
**The doc-comment at `contributor_taxonomy.py:33-35` must be rewritten** as part of
this change: as written ("provider accounts … are provenance, never identity keys")
it excludes exactly this class, and `email` is closer to `rss`/`podcast_index` (a
stable provider-scoped id) than to a bibliographic authority file. Name a distinct
permitted class — *stable self-asserted single-authority network identity*
(`email`) — that resolves **only within** its own `(authority, external_key)`,
never cross-authority, and note why `rss` stays weak (its per-feed id is provenance
the product does not resolve senders by) while `email` is strong (sender
idempotency is the whole point). `email` is the one new member of the strong set.
*Rejected:* keep `email` weak + a bespoke `authority='email'` lookup inside
`accept_email_message` (duplicates the race-safe `_resolve_or_attach_external_id`
logic — two owners of contributor resolution, violating the one-owner rule);
route the credit with an explicit `contributor_id` resolved out-of-band (writes
`resolution_status='manual'`, a provenance lie).

**D-4. Owner is a new setting `EMAIL_INGEST_OWNER_USER_ID`.** The endpoint is
unauthenticated (the slug is the capability), so no `Viewer` exists to own the
media. Single-user prototype: media files into *the* human user's default
library. This is the **first** env-configured owner-user-id in `Settings` — there
is no `oracle_corpus_owner_user_id` field to clone (`oracle_corpus.py` takes
`owner_user_id` as a passed *parameter*, not a settings field). Its precedents are
structural, not a clone: the `BILLING_ENABLED`/`PODCASTS_ENABLED` conditional-settings
block (P-8) for the flag-gated required-keys shape, and the Stripe-webhook public
route (P-7) for an owner-less server operation. This env-configured-owner pattern is
itself a new first-class precedent. *Rejected:* resolve the lone non-system
user from the DB (fragile the moment a second account exists, and couples ingest
to a directory query); treat the recipient slug as a user-directory key (the slug
is a rotating capability secret, not stable identity — and single-tenant besides).
This is a deliberate deviation from the brief's three-value config list, recorded
here.

**D-5. HTML preference: `text/html` first, wrapped `text/plain` fallback.** The
richest readable part is the HTML body; when a message is plain-text-only, wrap it
in minimal `<pre>`-normalized HTML so the *same* sanitizer + fragment pipeline
consumes it. *Rejected:* a second plain-text extraction path (forks the pipeline;
violates one-sanitizer P-2).

**D-6. Idempotency by normalized `Message-ID` via the media partial-unique index,
not an idempotency-key table.** `Message-ID` is the message's own globally-unique
identity; a duplicate delivery is definitionally the same message. Reusing the
`provider/provider_id` unique-index pattern (P-3) means dedupe is a single index
lookup with zero new state. *Rejected:* the `MediaSourceAttempt.idempotency_key`
mechanism (that keys a *user retry intent*, not message identity; there is no
user here); hashing the raw body (retries with a re-serialized MIME would differ).

**D-7. Bounce oversize *at the worker*, re-check *at the endpoint*.** A >2 MB raw
MIME is rejected by the worker with an SMTP bounce (the sender learns it failed)
and the endpoint independently re-checks `len(body)` (never trust the transport)
returning `413`. Two enforcements, no shared trust. *Rejected:* endpoint-only cap
(a compromised/absent worker could flood the API before the check); worker-only
cap (the endpoint must be safe standalone — it is the testable owner, R-3).

**D-8. `List-Id` → publication-as-organization contributor is a NAMED LEAVE
(phase 2).** Newsletters carry both a human sender (`From:`) and a publication
(`List-Id:`). Phase 1 credits the sender as `role='author'`; modeling the
publication as a `kind='organization'` contributor with `role='publisher'` and an
`authority='email'`/`rss` external id is a clean follow-up but adds a second
resolution and a role-ordering decision — deferred, not designed here.

**D-9. Email does NOT participate in inline-embed extraction (`extract_embeds=False`).**
Browser capture stores *two* R2 artifacts (derived HTML + raw source markup) and
passes `embed_source_html=source_html, extract_embeds=True` so
`prepare_web_article_fragment` can promote embedded YouTube/Twitter/preview URLs
into child media via `replace_document_embed_artifact`. Email stores **one**
artifact (the extracted HTML), so its run branch passes `source_storage_path=None`
(`embed_source_html=None`) and `extract_embeds=False`: `prepared.document_embeds`
is empty and no child media are created (§4.1 seam). Inline-embed extraction for
newsletters is a phase-2 leave; phase 1 renders the body as one fragment.
*Rejected:* `extract_embeds=True` on untrusted newsletter markup (unbounded
child-Media fan-out, no phase-1 reader benefit, and no raw-source artifact to feed).

**D-10. Rename `NON_REACQUIRABLE_FILE_SOURCE_TYPES` →
`NON_REACQUIRABLE_ARTIFACT_SOURCE_TYPES`.** The frozenset name is a contract ("add
file types here"); an email is not a file, it is a non-reacquirable *artifact*.
Mechanical single-commit rename in `media_source_types.py` + call sites in
`media_source_ingest.py`, making the `email_message` membership self-documenting.
*Rejected:* add `email_message` under the old `_FILE_` name (semantic corruption).

---
## 9. What dies (exhaustive)

**Nothing deleted.** This is an additive mouth: no file, table, route, CSS block,
or config is deleted. The one *symbol* churn is a rename, not a deletion: the
frozenset `NON_REACQUIRABLE_FILE_SOURCE_TYPES` becomes
`NON_REACQUIRABLE_ARTIFACT_SOURCE_TYPES` (D-10) with all call sites updated in the
same commit. Verified there is no dead `email`-ingest placeholder to remove:
`rg -n "ingest/email|email_ingest|EMAIL_INGEST|email_message|PostRoom|post.room"
python/nexus apps/web/src` returns **zero** matches on main *before this build*
(§13 gate G-1 is a pre-build baseline check, not a post-merge invariant).

Explicitly **not** touched / not deleted: the auth-middleware `_parse_email_claim`
family (that validates the JWT *email claim* — unrelated to mail ingest); the
`billing/stripe/webhook` public route (an independent `PUBLIC_PATHS` member); the
browser-article capture accept/run pair (it gains a *shared* helper, it is not
removed); `_persist_browser_article_metadata`'s byline-credit path (unchanged —
email supplies its credit at accept time, not via byline).

---
## 10. Sibling cutovers and sequencing

- **`dawn-write-hard-cutover.md` (SPEC)** is the *only* sibling that widens a
  CHECK constraint (`ck_llm_calls_owner_kind`, adding `'dawn_write'`) and it
  claims migration **0169**. Main already ends at `0168_web_article_inline_embeds`
  (the search-retrieval-roadmap migrations have merged and renumbered below 0168,
  so 0168 is *taken*; the Post Room takes the next free number at build time). The
  Post Room widens two *different* CHECKs (`ck_media_source_attempts_source_type`,
  `ck_contributor_external_ids_authority`) and adds one index — **no shared
  constraint, no collision**. Whichever lands first takes the next free number; the
  other renumbers its `down_revision` at merge (standard). Coordinate only on
  migration *numbering*, not content.
- **`machine-hand-hard-cutover.md` (SPEC)** owns the machine-voice register
  (`MachineText`, origins Assistant/Synapse/Dossier/Dawn/Summary). The Post Room
  introduces **no** machine voice and **no** MachineText origin — an email is
  plain user-facing `web_article` content. No shared file.
- **`authors-directory-and-contributor-ownership-hard-cutover.md` (BUILT, on
  main)** owns the contributor identity write path and the no-auto-merge doctrine.
  The Post Room *consumes* that machinery (D-3) and honors the doctrine; the only
  shared-file edit is adding `'email'` to
  `STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES`
  (`contributor_taxonomy.py`) and the `authority` CHECK — both purely additive.
- **`walknotes` / `x-ingest-provider` / `durable-source-ingest` (SPEC/BUILT)** are
  the other ingest-adjacent cutovers; none adds an `email` source type or touches
  `media_source_types.WEB_ARTICLE_ARTIFACT_SOURCE_TYPES`. The Post Room's
  `_run_prepared_html_article` extraction (§7) is the one shared-file edit in
  `media_source_ingest.py`; if `durable-source-ingest` refactors that file first,
  rebase the new dispatch branch onto its structure (mechanical).
- No sibling touches `me.get_me`, `SettingsAccountPaneBody`, `config.Settings`
  ingest fields, `sync-env.sh`, or `deploy/cloudflare/` — the rest of the surface
  is uncontended.

---
## 11. Slices (each independently buildable)

**S0 — Config + public endpoint + HMAC/slug/size gate (no parse yet).**
Add the six `EMAIL_INGEST_*` settings + `validate` block; add `"/ingest/email"`
to `PUBLIC_PATHS`; create `email_ingest.py` with the route + `email_ingest_service.py`
with `verify_email_signature`; mount the router in `create_api_router` behind
`settings.email_ingest_enabled`. The handler verifies size → signature → slug and
returns `200 {"outcome":"accepted_stub"}` (no Media yet).
*Verify:* `cd python && uv run pytest tests -k email_ingest_auth` — fixture tests:
good HMAC + good slug → 200; tampered body (valid-looking sig) → 401; absent sig
→ 401; wrong slug → 403; 3 MB body → 413; `EMAIL_INGEST_ENABLED=false` → 404.
`uv run ruff check . && uv run pyright`.

**S1 — Parse + `email_message` source type + pipeline + dedupe (migration `NNNN`).**
Author `NNNN_post_room.py` (§5, all three schema changes). Rename
`NON_REACQUIRABLE_FILE_SOURCE_TYPES` → `NON_REACQUIRABLE_ARTIFACT_SOURCE_TYPES`
(D-10, all call sites) and add `EMAIL_MESSAGE` to `media_source_types.py`
(+ into `WEB_ARTICLE_ARTIFACT_SOURCE_TYPES` and the renamed set). Implement
`extract_email_html` + `accept_email_message`, which must:
- set `media.created_by_user_id = settings.email_ingest_owner_user_id` so the
  standard enqueue path (`str(media.created_by_user_id)`) yields a valid
  `actor_user_id` (the worker does `str(payload['actor_user_id'])`; a `None` owner
  fails), and land the intrinsic under that owner;
- build the attempt's NOT-NULL `intent_key` as
  `_intent_key('email_message', normalized_message_id, None)` (normalized
  `Message-ID` is the stable discriminator — no user-retry idempotency here);
- dedupe by Message-ID via `uix_media_email_provider_id` at the Media layer; store
  derived HTML to R2; enqueue `ingest_media_source`.
Extract `_run_prepared_html_article` from `_run_browser_article_capture` per the
§4.1 seam; add `_run_email_message` (`source_storage_path=None`,
`extract_embeds=False`, no `_persist_browser_article_metadata`) + its dispatch
branch in `run_source_attempt`. Wire the real handler into S0's route.
*Verify:* `make test-migrations`; bring the test stack up
(`./scripts/with_test_services.sh make _test-back-db-ready`), then filter pytest
directly (`make` `-k` is `--keep-going`, it never reaches pytest): `cd python &&
NEXUS_ENV=test uv run pytest -v --tb=short -k email_ingest -m 'integration and not
unit and not supabase and not network and not slow'` — a real Substack `.eml`
fixture → readable `web_article` media with a fragment and `Subject` title;
duplicate Message-ID POST → `200 {"outcome":"duplicate"}`, one Media, no second
attempt; a MIME with no text part → failed media `failure_stage='extract'`.

**S2 — Sender → contributor resolution + `authority='email'` (strong).**
`accept_email_message` builds the author credit from the `From:` phrase +
normalized address and calls `replace_media_contributor_credits` with
`external_ids=[{authority:'email', external_key:<addr>}], role='author',
source='email'`. Add `'email'` to `STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES`
**and rewrite the doc-comment above it** (`contributor_taxonomy.py:33-35`) to name
the new "stable self-asserted single-authority identity" class (D-3). (CHECK/authority
widening already in `NNNN` from S1.)
*Verify:* with the test stack up, `cd python && NEXUS_ENV=test uv run pytest -v
--tb=short -k email_sender -m 'integration and not unit and not supabase and not
network and not slow'` — issue #1 creates an `external_id`-resolved contributor;
issue #2 from the same address credits the **same** `contributor_id`; a
pre-verified/merged contributor is reused, not re-split; `/authors/<handle>` lists
both issues.

**S3 — Settings surface.** Add `email_ingest_address: str | None = None` to
`UserProfileOut` (`python/nexus/schemas/user.py`); inject `Depends(get_settings)`
into `me.get_me` and set the field (config-derived `"<slug>@<domain>"` or `None`)
on the profile before `ok()`. Add the `Post Room` `PaneSection` + copy affordance +
`AccountResponse` field.
*Verify:* `cd apps/web && bun run typecheck && bun run test:unit &&
bun run test:browser` — `SettingsAccountPaneBody.test.tsx` renders the address +
copy button when present, the "not configured" line when null.

**S4 — Cloudflare Email Worker + runbook (LAST; everything above already green
via curl fixtures).** Create `deploy/cloudflare/email-worker/{worker.js,
wrangler.toml,README.md}`: receive mail, enforce ≤2 MB (else bounce), HMAC-SHA256
the raw body, POST to `/ingest/email` with the two headers. README = runbook: DNS
MX + Email Routing setup, secret provisioning (`wrangler secret put`), rotation
procedure, and the env keys added to `env-prod-backend` + `sync-env.sh`.
*Verify:* `wrangler dev` local POST of a fixture `.eml` reaches a local API and
produces media; production smoke = forward one newsletter, confirm it lands.

---
## 12. Acceptance criteria (testable)

- **AC-1.** A real Substack `.eml` fixture POSTed with a valid HMAC + slug becomes
  a `web_article` Media (`provider='email'`), readable through the standard
  reader, with `title == Subject` (RFC2047-decoded) and `published_date` from the
  `Date` header, credited to the resolved sender as `role='author'`.
- **AC-2.** The same message POSTed twice is a no-op **at the Media layer**:
  exactly one `Media` exists; the second POST returns `200 {"outcome":"duplicate"}`
  and creates neither a new `Media` nor a new `MediaSourceAttempt` (dedupe fires on
  the `Media(provider='email', provider_id=mid)` lookup, before any attempt row).
- **AC-3.** A request whose body is altered after signing (or carries no
  signature) is rejected `401` **before** any `message_from_bytes` call
  (assert the parser is never entered on the failure path).
- **AC-4.** A 3 MB raw body is rejected — `413` at the endpoint, and bounced at
  the worker (worker unit test).
- **AC-5.** A request to the wrong recipient slug is rejected `403`.
- **AC-6.** With `EMAIL_INGEST_ENABLED=false`, `/ingest/email` is unmounted (`404`)
  and absent from the OpenAPI schema.
- **AC-7.** A second issue from the same `From:` address credits the **same**
  `contributor_id` (`resolution_status='external_id'`); no duplicate contributor;
  a previously-merged sender is not re-split.
- **AC-8.** Authenticated mail with no extractable text becomes a failed Media at
  `failure_stage='extract'`, visible in the failed-media list and deletable.
- **AC-9.** The account settings pane shows `<slug>@<domain>` with a working copy
  affordance when configured, and a "not configured" line when not.
- **AC-10.** `/ingest/email` never reads a cookie, session, bearer, or
  `X-Nexus-Internal` header (grep + a test asserting no `get_viewer` dependency).

---
## 13. Negative gates (grep-able)

- **G-1 (no pre-existing dead email code — pre-build baseline only):** run
  *before this build begins* to confirm there is no dead scaffolding to remove —
  `rg -n "ingest/email|email_ingest|EMAIL_INGEST|email_message|PostRoom|post.room" python/nexus apps/web/src`
  returns **zero** on main. (Not a post-merge invariant: a correct build adds
  these symbols.)
- **G-2 (two constant-time compares — HMAC + slug — no plain `==`):** the HMAC
  verify lives once in the service
  (`rg -n "compare_digest" python/nexus/services/email_ingest_service.py | wc -l` == 1),
  and the slug gate in the route is *also* constant-time
  (`rg -n "compare_digest" python/nexus/api/routes/email_ingest.py | wc -l` == 1) —
  the slug is a capability secret, no plain `==` (D-7). `rg -rn
  "X-Nexus-Email-Signature|verify_email_signature" python/nexus` shows the verify
  defined once (service) and called once (route).
- **G-3 (endpoint is not in an authenticated group):**
  `rg -n "get_viewer|Depends\(get_viewer\)" python/nexus/api/routes/email_ingest.py`
  returns **zero**; `rg -n '"/ingest/email"' python/nexus/auth/middleware.py`
  shows it in `PUBLIC_PATHS`.
- **G-4 (no new MediaKind):**
  `rg -n "email" python/nexus/db/models.py` shows `email_message` only inside the
  `ck_media_source_attempts_source_type` literal and `email` only inside the
  `authority` CHECK — **not** inside `ck_media_kind`.
- **G-5 (one sanitizer, one pipeline — scan ALL email-authored files):**
  `rg -n "sanitize_html|prepare_web_article_fragment" python/nexus/services/email_ingest_service.py python/nexus/api/routes/email_ingest.py`
  returns **zero** — no email-authored file calls the sanitizer/fragment builder
  directly. The sole `prepare_web_article_fragment` call that processes email HTML
  is inside `_run_prepared_html_article` in `media_source_ingest.py`; email never
  adds a second HTML path.
- **G-6 (strong authority registered):**
  `rg -n "'email'" python/nexus/services/contributor_taxonomy.py` shows it inside
  `STRONG_CONTRIBUTOR_EXTERNAL_ID_AUTHORITIES`.
- **G-7 (Caddy untouched):** `git diff --stat deploy/hetzner/Caddyfile` is empty.

---
## 14. Test plan

**Unit (`.test.ts` / pytest units):**
- `verify_email_signature`: constant-time positive/negative, empty-secret guard,
  hex-decoding of a malformed header → reject (no exception leak).
- `extract_email_html`: `text/html` preferred; plain-text-only wrapped; multipart
  nesting within caps; part-count/depth cap trips → reject; RFC2047 Subject decode;
  RFC2822 `Date` → ISO `published_date`; From-phrase + address normalization.
- Message-ID normalization (strip angle brackets, lowercase host, trim).

**Browser (`.test.tsx`):**
- `SettingsAccountPaneBody.test.tsx`: renders address + copy button when
  `email_ingest_address` present; renders "not configured" when null; role/label
  queries only; real providers + fetch-boundary mock (no internal `vi.mock`).

**Guards (source-grep vitest / pytest asserting invariants):**
- G-2/G-3/G-4/G-5/G-6 encoded as static tests (`rg`-equivalent assertions).
  (G-1 is a pre-build baseline, not a persistent test — a correct build adds the
  email symbols.)

**BE (`make test-back-integration`, `make test-migrations`):**
- Full flow with a real Substack fixture + a plain-text-only fixture + a
  no-text-part fixture (→ failed `extract`).
- Idempotency: duplicate Message-ID → one Media.
- Sender resolution: two-issue same-sender → same contributor; merged-sender reuse.
- Auth matrix: bad sig / no sig / wrong slug / oversize / disabled.
- `test-migrations`: `NNNN` up/down; model↔DB CHECK/index diff clean.

**E2E (written, not required to run this cutover):** forward-a-newsletter smoke
against a staging worker (documented in `deploy/cloudflare/email-worker/README.md`).

**Static:** `cd python && uv run ruff check . && uv run pyright`;
`cd apps/web && bun run typecheck`.

---
## 15. Files (created / modified / deleted)

**Created:**
- `python/nexus/api/routes/email_ingest.py` — public POST route (transport only).
- `python/nexus/services/email_ingest_service.py` — `verify_email_signature`,
  `extract_email_html`, `accept_email_message`, Message-ID normalization.
- `python/migrations/alembic/versions/NNNN_post_room.py` — two CHECK widenings +
  `uix_media_email_provider_id`.
- `deploy/cloudflare/email-worker/worker.js` — the Email Worker.
- `deploy/cloudflare/email-worker/wrangler.toml` — worker config + secret bindings.
- `deploy/cloudflare/email-worker/README.md` — DNS/Email-Routing/rotation runbook.
- `python/tests/fixtures/email/substack_issue.eml`, `plain_text.eml`,
  `no_text_part.eml` — MIME fixtures.
- `python/tests/.../test_email_ingest*.py`, `apps/web/.../SettingsAccountPaneBody.test.tsx`
  (extended).

**Modified:**
- `python/nexus/config.py` — six `EMAIL_INGEST_*` settings + `validate` block.
- `python/nexus/auth/middleware.py` — `"/ingest/email"` into `PUBLIC_PATHS`.
- `python/nexus/api/routes/__init__.py` — mount `email_ingest_router` behind flag.
- `python/nexus/services/media_source_types.py` — `EMAIL_MESSAGE` + frozenset
  memberships; **rename `NON_REACQUIRABLE_FILE_SOURCE_TYPES` →
  `NON_REACQUIRABLE_ARTIFACT_SOURCE_TYPES`** (D-10).
- `python/nexus/services/media_source_ingest.py` — extract the shared
  `_run_prepared_html_article` (§4.1 seam) from `_run_browser_article_capture`;
  add `_run_email_message` + its `email_message` dispatch branch; update the
  `NON_REACQUIRABLE_*` call sites for the D-10 rename.
- `python/nexus/services/contributor_taxonomy.py` — `'email'` into strong set +
  rewrite the doc-comment (D-3).
- `python/nexus/db/models.py` — mirror both CHECK literals + add
  `uix_media_email_provider_id`.
- `python/nexus/schemas/user.py` — `email_ingest_address: str | None = None` on
  `UserProfileOut` (so `/me` serializes it).
- `python/nexus/api/routes/me.py` — inject `Depends(get_settings)` into `get_me`;
  set config-derived `email_ingest_address` on the profile.
- `apps/web/src/app/(authenticated)/settings/account/SettingsAccountPaneBody.tsx`
  — `Post Room` section + `AccountResponse` field.
- `deploy/env/env-prod-backend` (+ `.example`), `deploy/hetzner/sync-env.sh`.

**Deleted:** none (§9).

---
## 16. Risks

- **R-1. Spam / flood at the address (MEDIUM).** A leaked slug lets anyone POST
  (via the sender's real mailbox → the CF routing address). *Mitigation:* the slug
  is a rotatable capability (env change + redeploy invalidates it instantly);
  ≤2 MB cap at worker *and* endpoint (D-7); Message-ID dedupe blocks replay-spam;
  every accepted-but-junk message is a *visible, deletable* failed media (AC-8),
  so the flood is legible and boundable, never silent. The HMAC secret means only
  the Cloudflare worker (not the raw internet) can reach the endpoint even if the
  path leaks.
- **R-2. HTML bombs / malicious markup (MEDIUM).** Newsletters embed arbitrary
  hostile HTML. *Mitigation:* email routes through the **existing sole sanitizer**
  `sanitize_html` (P-2, G-5) — the same hardening every web capture already gets;
  plus MIME part-count/depth caps in `extract_email_html` before sanitization;
  plus the raw-size cap. No new HTML trust surface is introduced.
- **R-3. Cloudflare worker drift (MEDIUM).** The worker is deployed out-of-band
  (Wrangler), so its HMAC/size behavior can silently diverge from the endpoint's
  expectations. *Mitigation:* the endpoint is the **testable owner** — every auth,
  size, dedupe, parse, and resolution behavior is exercised by curl + `.eml`
  fixtures with **zero** worker dependency (S0–S3 all green before S4 exists); the
  README pins the exact header names, HMAC algorithm (SHA-256 over raw body), and
  size cap the endpoint enforces, and the endpoint re-checks size independently
  (never trusts the worker).
- **R-4. Sender-resolution mis-attribution (LOW).** A shared "no-reply@substack.com"
  style address would collapse many publications into one contributor.
  *Mitigation:* phase-1 credits the human `From:` phrase's address; `List-Id`
  publication modeling is the named phase-2 leave (D-8) that disambiguates the
  common newsletter-platform case; and merge/split remain human verbs, so any
  mis-collapse is a *reversible* curated action, never a silent permanent one.
- **R-5. Message-ID absence or forgery (LOW).** A message lacking `Message-ID`, or
  one forged to collide, could bypass or over-trigger dedupe. *Mitigation:* when
  `Message-ID` is absent, synthesize a deterministic id from
  `sha256(From + Subject + Date + first-N-bytes)` (documented, still idempotent for
  true duplicates); forgery only lets an *authenticated* (HMAC-holding) caller
  suppress its own future delivery — no cross-user impact in a single-user system.
- **R-6. Migration downgrade with live rows (LOW).** Narrowing the CHECKs on
  downgrade fails if `email` / `email_message` rows exist. *Mitigation:* documented
  in the migration as intentional greenfield-drop discipline (consistent with the
  house doctrine); forward-only in practice.
