# email import

status: implemented; production activation remains a separate release step.

## outcome and boundaries

email is an import channel. remove the account-settings post room section. expose
one usable private address inside the existing import interface; received bodies
enter all, the ordinary reader, and ordinary import progress/recovery.

binding owner decisions:

- removing an email from nexus suppresses later delivery of the same message,
  even after physical content teardown. retain only minimal receipt identity.
- finish the application feature first. live address provisioning and transport
  qualification are a separate release gate; this change leaves production inactive.

scope: discovery/copy, truthful configuration availability, bounded authenticated
admission, durable duplicate suppression, sender/date provenance, and their removal
and verification paths. account settings retains its other controls.

non-goals: mailbox/folders/replies, attachment imports, per-library addresses,
address management ui, semantic email deduplication, raw mime archives, new queues,
provider replacement, general integrations/capability infrastructure, librarian or
imports-history redesign, public indexing, and a permanent test suite.

## capability and interface

`GET /me` retains required `email_ingest_address: string | null`. one resolver in
`services/email_ingest_service.py` returns `{secret, owner_user_id, address}` or
absent. require nonblank secret, valid owner uuid, and, after trim/lowercase:

- slug: 1–64 ascii letters/digits/hyphens, starting with letter/digit;
- domain: at least two dns labels, each 1–63 ascii letters/digits/interior hyphens;
  domain ≤253 characters; complete address ≤254.

other receiving-address syntax is invalid; sender parsing stays separate.
invalid/incomplete configuration disables email only and makes ingress answer
503. project the canonical address only to its owner. availability is not health.

on each import-page mount, read `/api/me` through `usePaneFreeServerValue`, with
its normal retry/account fencing. retain the profile object: nullable scalar data
would collide with the primitive's absence sentinel. no extra cache or polling.

| observation | presentation |
| --- | --- |
| loading | local `Ruling`; other imports remain usable |
| ready, null | no email row |
| ready, address | `email import` row immediately after `Choose` |
| initial failure | `Failed`, noun `email import details`, existing retry |
| failed refresh | existing retained-data/error semantics |

use a real `Button`, stable `aria-controls`, `aria-expanded`, and existing
selected-row tab/enter behavior. expand into a nonselectable grid row with
`PickerSurface inline` and `Collection.contentViewport`: address selection cannot
activate the row; short-view overflow scrolls without hiding controls.

show a bare read-only `Textarea`, `autoGrow`, labelled `email import address`.
keep the complete address wrapping/selectable. explicitly focus the region;
existing overlay ownership closes it first on escape/android back. return focus
to the desktop combobox with email selected, or the mobile trigger. expansion is
account/address-local; preserve the draft, destination and intake lines.

reuse `useCopyFeedback(address)`, `Announcement` and existing failure handling.
copy creates no import/count change; announce success only after actual success.
unexpected failures use the existing error owner. use existing type/spacing tokens.

one discovery designer owns these exact strings and their layout:

| purpose | copy |
| --- | --- |
| trigger/region | `email import` |
| destination | `forward a newsletter here. email always arrives in all.` |
| scope | `imports the message body. attachments aren’t imported as files.` |
| copy / success | `copy address` / `copied` |
| clipboard refusal | `couldn’t copy the address.` / `select it to copy it.` |

good copy names the action, actual destination and supported material; promises
no routing from the nearby picker, delivery time or health. no new glyphs.

## source identity and storage

add one `email_ingest_receipts` table:

| column | contract |
| --- | --- |
| `id` | generated uuid primary key |
| `owner_user_id` | required fk to users |
| `message_key` | required sha256 hex text |
| `media_id` | nullable fk to media; unique when non-null |
| `created_at` | required timestamptz, database default `now()` |

unique `(owner_user_id, message_key)`; non-cascading fks, explicit cleanup.
non-null media means accepted; null means permanently suppressed. retain identity
for the account's lifetime, without expiry/reset ui or payload/response storage.
`id`/creation time follow `docs/rules/database.md`.

hash `b"message-id\0" + normalized_message_id.encode("utf-8")` when the existing
normalizer yields an id, otherwise `b"raw-mime\0" + raw_body`. same message-id
means same identity despite changed body. without it, only exact bytes deduplicate.

receipts are the sole identity authority. remove `_media_for` and
`uix_media_email_provider_id`; use `provider="email"`, `provider_id=null`,
`provider_target_ref=null`. never project the private digest through media.

1. authenticate/bound input, derive identity and read receipt. existing receipts
   return duplicate/suppressed without storage, filing, credits or processing.
2. end the read transaction; mint stable candidate ids and store the body once.
   no database transaction spans storage.
3. inside `retry_serializable`, take `users.lock_viewer` before media/library locks
   and reread. a committed winner supplies the answer; the existing storage sweep
   owns the unused candidate object.
4. otherwise atomically commit receipt, media, attempt, all membership and job.
   add receipt uniqueness to the existing first-sight retry allowlist. reuse ids
   and bytes on retries; no postcommit contributor operation.

`remove_media_for_viewer` nulls the owner's pointer after guards, in its removal
transaction. named-library unfiling does not. `_hard_delete` nulls remaining
pointers under its media lock before deletion. email-owned transaction
participants never commit. redelivery never restores membership or clears
suppression; explicit user re-filing remains independent.

## provenance and public contracts

add closed models in `schemas/media_sources.py`; serialize payload as json:

```text
EmailProvenance {sender_name: string | null, sender_address: string, sent_at: datetime | null}
EmailSourcePayload {storage_path: string, provenance: EmailProvenance}
```

outer `From` supplies the decoded name or null and mailbox; preserve local-part
spelling, lowercase domain. never fabricate a name. outer `Date` becomes utc when
its offset is known, retaining existing `-0000` handling; absent/malformed is null.
subject remains title. admission supplies no author credit or publication date.

select the inline mime body, html before plain, respecting alternative/related
semantics. exclude attachment subtrees and `message/rfc822`. retain part/depth
bounds; reuse standard-library body selection after bounded structure validation.
reject absence of a non-whitespace supported part before storage. readability and
sanitization remain the background processor's responsibility.

attempts own provenance and existing retries copy it; keep top-level
`storage_path`. provenance dies with content. delete `_sender_observation`,
`_credit`, their imports and mail-date-to-publication logic.

`GET /imports/{ref}` adds required `email_source: EmailProvenance | null`.
apply existing visibility first; only the original email attempt's owner receives
its strictly decoded provenance. other viewers/media get null; malformed stored
payloads are defects. expose no receipt key, storage path or receiving address.
public shares, citations and generic media metadata gain no private sender fields.

one provenance designer owns the existing inspector's escaped source copy:
`received by email`; `from {name} <{address}>` or `from {address}`; optional
`sent {formatted_date}` using existing time formatting. good copy distinguishes
transmission from authorship/publication and makes no verification claim.

## ingress and worker protocol

`POST /ingest/email` stays public to session auth and authenticated by hmac.
require `X-Nexus-Wire` through the existing edge check even for this public path.
the worker imports `WIRE_REVISION` from the existing generated web wire module;
do not create an independently editable worker revision.

canonicalize the envelope recipient with the same receiving-address grammar;
compare its full mailbox with configured address. sign exactly:

```text
UTF8("nexus-email\n" + revision + "\n" + canonical_recipient + "\n") || raw_mime
```

use hmac-sha256, constant-time verification, and the existing signature/recipient
headers. only this signature format survives cutover. both sides enforce a fixed
2 mib cap; remove the independently adjustable backend cap. stream the request
and stop on crossing the bound before mime parsing/storage; never buffer an
unbounded body. verify authentication before parsing or consulting receipts.

the typed success is `Data[EmailAcceptance]`, a closed discriminated union:

```text
{ outcome: "accepted" | "duplicate", media_id: uuid }
| { outcome: "suppressed", media_id: null }
```

all outcomes return 200; every key is present. suppressed delivery is acknowledged
without resurrecting content. use the existing error envelope for failures and
delete the email route's separate `data.error` format.

| condition | response / worker disposition |
| --- | --- |
| valid declared success | acknowledge |
| invalid mime/sender or no nonempty supported inline body | `E_INVALID_REQUEST`, 400; permanent rejection |
| body exceeds cap | existing `E_SOURCE_TOO_LARGE`, 413; permanent rejection |
| missing/invalid optional configuration | new `E_EMAIL_INGEST_UNAVAILABLE`, 503; throw |
| invalid signature / recipient | `E_UNAUTHENTICATED`, 401 / `E_FORBIDDEN`, 403; throw |
| missing/wrong wire | existing `E_WIRE_MISMATCH`, 426; throw |
| `DatabaseBusyError`, including exhausted retries | existing `E_DATABASE_BUSY`, 503; throw |
| network, storage/server failure, unknown or malformed reply | throw; never acknowledge or permanently reject |

the delivery content designer owns fixed rejection copy: `couldn’t read this
email.` for declared 400, `email exceeds the 2 mib limit.` for declared 413.
do not branch on server prose. diagnostics retain status/code and request id,
never raw mail or credentials. reject only declared code/status pairs; validate
the entire success shape before acknowledging.
remove claims that every 5xx means nothing committed or that throwing proves retry.

## hard cutover and release boundary

one migration after actual head must assert zero legacy email media and email
source attempts before mutation, then create receipts and remove the obsolete
index. unexpected legacy data aborts with a conversion requirement. no guessed
backfill, reset, dual reader, old signature acceptance or prefix-hash fallback.
already-purged historical identities cannot be reconstructed; suppression applies
to receipts admitted under this contract.

regenerate wire types; bump revision only for the first breaking change since the
last release. verify the worker's wrangler dry-run bundle imports that revision.
an active worker is a paired release client: every subsequent wire bump requires
worker/backend deployment from matching source and verification of both versions.
mismatches preserve failure eligibility; they never bounce valid mail.

move `docs/issues/production-post-room-unconfigured.md` to
`docs/issues/release-email-import.md` and update inbound links. that record owns
provisioning, paired releases and qualification: one real arrival, duplicate
delivery, and temporary-failure deferral/recovery. if the provider cannot preserve
delivery, activation stays blocked for a separate transport decision; no bounce
fallback. follow `deployment.md`; this implementation leaves mail inactive.
provider reference: [email handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/).

## exclusive work packages and review

python paths below start at `python/nexus/`; web paths at `apps/web/src/`.
other paths are repository-relative.
one accountable writer per row; shared-file changes go through that owner.

| owner | files and responsibility | dependency |
| --- | --- | --- |
| a: admission/data | python `services/email_ingest_service.py`, `services/media_deletion.py`, `db/models.py`, `db/retries.py`, `schemas/media_sources.py`; one migration: config resolver, receipts, parsing/provenance, atomic admission/removal | contract/schema review |
| b: protocol/delivery | python `api/routes/{me,email_ingest}.py`, `api/edge.py`, `errors.py`, `config.py`; worker source/runbook; generated web `lib/api/wire.gen.ts`: projections, wire, hmac, limits and dispositions | a's fixed interfaces; delivery designer |
| c: import discovery | web `components/nexus/ImportPage.{tsx,module.css}`, account `SettingsAccountPaneBody.tsx`: disclosure, read/copy, remove section and dead imports/state | b; discovery designer |
| d: provenance display | python `schemas/imports.py`, `services/imports.py`; web `components/imports/ImportInspector.tsx`, local `Imports.module.css` if needed: owner-only detail and source copy | a; provenance designer; b regenerates wire |
| e: qualification | `python/scripts/disposable_runtime.py` ordinary config allowlist; ignored temporary lab drivers/fixtures; report proof to integration owner | red before implementation; green after |
| integration owner | `docs/modules/{ingest,imports,app-navigation}.md`, `docs/reauthoring.md`, issue records and final pr: reconcile contracts, delete resolved records, net authored lines/deletions | a–e |

designers review their copy/schema before wiring, the first working interaction,
and final qualification. an independent adversarial reviewer challenges each
package at contract, implementation and refactor boundaries. reject claims of
delivery, ownership, provenance or durability without observable evidence.

## red green refactor and acceptance

use `./scripts/lab -- ...`, real browser/bff/api/database/storage and existing
helpers. extend only `LIVE_KEYS` with the four ordinary email configuration keys;
use private `--live-config`, a generated secret and a predetermined owner uuid.
create that owner through the local auth admin api; the normal seed is the
non-owner. do not combine with fake providers. missing external indexing/model
capabilities are not email-source failures.

temporary drivers may invoke the actual worker export with provider-shaped input
against the real lab api. this proves the application protocol, not smtp delivery.
induce genuine lock contention and owned lab storage failure; add no application
error switches, alternate writers or test endpoints. no real personal mail is needed.

| proof | observable acceptance |
| --- | --- |
| discovery | account section gone; pending/null/error/available states correct; wrong owner sees no address; late reads cannot cross accounts |
| interaction | desktop/phone disclosure, escape/back, long-address wrapping, short viewport/enlarged text, actual copy/manual recovery; typed link and non-default destination survive and govern later link submission; copying sends no import |
| admission | valid html/plain bodies become readable in all with normal history; a plain body beats an html attachment; attachment-only mail is refused; receipt/item/attempt/holding/job commit together; failed storage commits none |
| identity | concurrent deliveries yield one item/job; exact missing-id replay deduplicates; different suffixes after identical first 4096 bytes remain distinct |
| removal | redelivery before/after teardown stays suppressed; race with removal never restores membership; named-library unfiling does not suppress |
| provenance | forwarded sender/date stay source facts; no invented author/publication date; missing name/date stay null; retry preserves facts; non-owner/public projections omit private source metadata |
| boundary | altered recipient/body/wire cannot pass authentication; over-limit chunked input stops early; exact limit is accepted if otherwise valid; no state is published on rejection |
| failure | database contention, storage failure, config/wire/auth mismatch and malformed response never take permanent-rejection branch; restoring the dependency permits replay without duplication |
| cutover | unexpected legacy rows fail migration without mutation; no old format/index/credit path remains; generated wire and worker bundle agree |

for each package: write the smallest journeys, observe the target failure (setup
failure is not red), implement, get green, adversarially review/refactor, rerun
affected journeys and `./scripts/test`. then delete temporary tests, fixtures and
test-only scaffolding; retain no replacement gate. keep ordinary lab configuration
support. final pr records actual proof, limitations, net authored lines and deletions.

## accepted costs

- permanent minimal receipt storage buys suppression after content deletion.
- the private address uses a deliberately narrow ascii grammar; ordinary sender
  addresses retain normal mime parsing.
- one additional account-scoped read buys private discovery without global state.
- exact-byte fallback misses rewritten equivalents; semantic matching risks
  discarding distinct messages.
- empty-legacy cutover may stop deployment; html cannot reconstruct lost identities.
- owner-only provenance costs one detail projection and avoids false bibliography.
- paired worker releases and deferred activation cost operational coordination;
  no new queue/provider conceals unproven delivery semantics.
