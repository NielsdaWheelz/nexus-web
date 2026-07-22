# Lightweight Author Deduplication Hard Cutover

**Status:** Proposed implementation specification · 2026-07-15
**Posture:** Irreversible coordinated cutover. No dual reads, dual writes,
fallbacks, compatibility DTOs, legacy routes, or mixed-version deployment.

This document supersedes
`authors-directory-and-contributor-ownership-hard-cutover.md`. Its scope is the
author/contributor system and the adjacent code that reads or writes author
identity. It is not a redesign of unrelated Nexus systems.

The canonical resource-header and author-entry composition is defined by
[`pane-header-identity-hard-cutover.md`](pane-header-identity-hard-cutover.md).
This document owns author identity, persistence, authorization, and editor
behavior. It does not own a persistent media byline or inline editor: media
projects compact structured credits, a complete Credits overlay, and
authorization-gated Add/Edit Authors administration in Options.

## 0. Executive decision

The one-user product needs an aggressive default and a cheap escape hatch, not
an authority-control product.

Automatic identity resolution is exactly:

1. reuse the owner of one exact, namespaced, durable identity key when present;
2. otherwise reuse the stable winner for the exact normalized canonical name or
   a trusted resolving alias;
3. otherwise create one contributor;
4. replace the work's machine-owned author slice;
5. never touch a media author slice while its manual pin remains set.

The user can fix an exception from the affected media item by selecting an
existing author or explicitly creating a different same-name author. They can
also rename a canonical author. That is the whole product.

~~~text
provider metadata or existing metadata/text LLM
                       |
                       v
            typed contributor observations
                       |
                       v
       exact stable key -> exact name -> create
                       |
                       v
             one effective ordered list

media editor -> select existing / create distinct -> pin author slice
             -> reset to automatic when wanted
~~~

There is no second AI call, semantic matcher, vector index, fuzzy matcher,
confidence score, candidate queue, reconciliation worker, merge console, split
tool, or authority-ID editor.

The meta decision is deliberate: Nexus is identifying a local corpus credit,
not proving real-world personhood. Routine duplicate listings are more damaging
than a rare false merge, and a work-local correction is cheaper than a review
workflow.

## 1. Goals, scope, and explicit tradeoffs

### Goals

- Automatically deduplicate on ingestion, refresh, metadata fetch,
  re-ingestion, and re-enrichment.
- Use only local indexed database work after extraction.
- Preserve the first canonical display name until an explicit rename.
- Preserve each work's literal credited spelling and existing role semantics.
- Represent a manually empty author list without a sentinel row.
- Give the user one obvious media-level correction flow.
- Delete the current reconciliation and authority-administration product.
- Keep public DTOs small, strict, and free of provider identity data.

### Explicit 80/20 tradeoffs

- Two real people with the same normalized name will usually auto-merge.
- Punctuation, word order, transliteration, initials, and diacritic differences
  do not auto-merge.
- A false merge is repaired on the affected work by creating/selecting the right
  identity and pinning that work.
- A missed non-exact duplicate is repaired by selecting the existing identity on
  affected works. There is no global combine operation in this cutover.
- Exact canonical mononyms still auto-merge. Short account display names such as
  `niels` are therefore an intentional false-merge risk.
- Provider account keys (`x_user`, `youtube_channel`, `email_address`) identify
  accounts, channels, or mailboxes, not proven people. Shared mailboxes,
  plus-addressing, address reuse, and account transfers can over-merge.
- Authority keys, including OpenAlex, are exact source identifiers but not
  immutable proof of personhood; upstream re-clustering can change their
  meaning. A media-level manual pin remains the repair boundary.
- Existing exact-name duplicates are collapsed once in migration 0179.

### Non-goals

- Pairwise or multi-profile LLM identity adjudication.
- Embeddings, trigram, phonetic, edit-distance, or semantic identity search.
- Global biographies, avatars, authority records, or identity provenance UI.
- Alias, external-ID, merge, split, tombstone, or reconciliation CRUD.
- A general metadata editor or multi-work bulk reassignment tool.
- Multi-user moderation and approval workflows.
- Changing editor, translator, host, guest, narrator, or other role meaning.
- Preserving old routes, old handles, removed DTO fields, or old page state.

## 2. Target behavior

### 2.1 Observation contract

Each source produces one of two typed values. `managedRoles` is the set of role
slices that this adapter completely owns for this observation; every included
slice contains one through twenty ordered rows:

~~~text
not_observed

observed:
  managedRoles: nonempty set of ContributorRole
  credits: 1..20 ordered ContributorObservation values per managed role

ContributorObservation:
  creditedName: cleaned nonempty name, max 200 code points
  identityKey: absent OR one exact {authority, canonicalKey}
  role: ContributorRole
  rawRole: absent OR cleaned source label, max 80 code points
~~~

`not_observed` is not an empty list. It means “this attempt learned nothing” and
never erases prior credits. Every credit role must be in `managedRoles`, and
every declared role must contain at least one credit. Automatic sources cannot
assert an empty slice; only the user can assert an empty media author slice.

All current media extraction/enrichment lanes declare `{author}`. The podcast
ensure/subscribe boundary may declare the complete role set carried by its typed
`ContributorCreditIn` payload; a future structured adapter may likewise declare
a non-author role only when it has the complete ordered slice. A lane that does
not completely observe a role omits it and preserves that role. Existing
editor/translator/host/guest rows therefore remain live, and role-capable
adapters can still create them.

All external parsing and LLM work finishes before the database operation.
Provider dictionaries never cross the author service boundary.

### 2.2 Exact batch resolver

The resolver handles the whole observation batch inside one serializable author
database operation:

1. clean display values and canonicalize the optional key;
2. group observations with the same key before any lookup;
3. bulk-load key owners;
4. for unresolved groups, normalize names and bulk-load aliases where
   `resolves_identity = true` (every canonical display owns one);
5. choose one matching contributor by earliest `created_at`, then UUID;
6. if an unseen key contradicts a different key under the same authority on the
   name winner, force-create a distinct contributor; otherwise create at most
   one contributor per unresolved equivalence group;
7. attach a new exact key to the selected contributor;
8. ensure the canonical display alias as resolving and the observed spelling as
   searchable; provider-observed spellings do not resolve future identity;
9. deduplicate final rows by `(contributor, role)`, preserving first order and
   the first credited spelling.

An existing exact key always wins over a name candidate. An unseen key normally
attaches to the exact-name winner or the newly created contributor. If that
winner already owns a different key under the same authority, the conflict is
positive evidence of two identities: create a forced-distinct contributor and
attach the new key there. Different authorities are never inferred equivalent.

When several intentional same-name contributors exist, the earliest
`contributors.created_at`, then lowest UUID, wins forever. Work counts never
participate, so normal corpus growth cannot redirect later observations to an
explicit same-name exception.

### 2.3 Names and handles

Display cleanup is NFC, outer trim, and Unicode-whitespace collapse. It does not
title-case, reorder, transliterate, remove punctuation/diacritics, expand
initials, or append roles.

The one match key has Unicode `toNFKC_Casefold` semantics:

~~~text
NFKC
-> remove Default_Ignorable_Code_Point characters
-> full Unicode casefold
-> NFKC again
-> trim and collapse Unicode White_Space
~~~

This removes ZWSP, ZWJ, soft hyphen, BOM, and the rest of Unicode's
default-ignorable set from matching only; display cleanup still preserves the
credited text. Punctuation, token order, and diacritics remain significant.

The first cleaned observation becomes `display_name`. Later spellings become
searchable non-resolving aliases; automatic work never changes the display name.
The canonical display alias and the old/new aliases from an explicit rename are
resolving aliases.

Contributor handles remain stable outward short aliases, but every Python and
TypeScript boundary uses the entity-specific validated `ContributorHandle`
brand. They are never plain unvalidated strings or private UUIDs. Generation is
deterministic from the normalized name. A forced-distinct suffix is a short,
domain-separated cryptographic digest over the stable inputs: authority/key for
an automatic conflict, or user/media/mutation/row for a manual creation. Only
the digest enters the handle; private UUIDs, keys, media IDs, user IDs, and
mutation IDs are never exposed. Handle candidates use successively longer
digest prefixes under the one branded grammar; a true collision advances
deterministically, never to `uuid4()`. Handles are immutable after creation.

The grammar is 3..80 lowercase ASCII characters matching
`[a-z0-9]+(?:-[a-z0-9]+)*`, excluding reserved collection segments. New base
handles use a maximum 32-character slug plus the first 12 hex characters of a
domain-separated SHA-256 name digest. Forced-distinct candidates add 12, 16, 24,
then 32 hex characters of the second digest; exhausting those candidates is a
defect, not a random fallback.

### 2.4 Automatic role-slice replacement

The automatic operation accepts one target, `managedRoles`, and the validated
observations. It:

- returns immediately for `not_observed`;
- for media with `authors_manually_managed = true`, removes only `author` from
  the effective managed set and may still update a declared non-author slice;
- resolves the remaining observations as one batch;
- replaces only the declared managed-role slices;
- preserves all undeclared roles and their relative order;
- preserves observed order within each replaced role, anchors a replacement at
  that role's prior first position, appends a genuinely new role by vocabulary
  order, then renumbers the combined list densely;
- keeps the prior list until the transaction commits;
- compares canonical persisted facts and performs no DML when unchanged.

`MAX_CREDITS_PER_MANAGED_ROLE = 20` is one shared adapter/domain/UI constant.
The cap is per role slice, not per target across all roles. Adapters clean,
deduplicate, and keep the first twenty source-ordered observations for each
managed role; they report aggregate truncation counts without names, keys, or
addresses.

There are never parallel effective lists by source. `source` remains a private
credit fact, not precedence.

The existing durable source job owns retries. Its normal parser/LLM produces the
observation in memory, ends any source transaction, and awaits one
**unreplayable** author database mutation in a fresh session before handler
success and before a new item crosses ready/publication. It never writes
`resource_mutations`: a stable job key may legitimately observe different
authors on a later refresh, and background lanes have no user. If a crash loses
the in-memory observation, the existing job attempt reruns its normal source
work; this cutover adds no author checkpoint/table, new job, or identity-specific
AI/network call. The resolver's deterministic convergence and no-DML-when-
unchanged comparison make that ordinary job retry safe. Refresh keeps the prior
list until replacement commits.

### 2.5 Manual media-author correction

The media editor loads and saves only the complete ordered `author` slice: zero
through twenty rows. Editor, translator, host, guest, and every other role stay
visible in compact resource credits and the complete Credits overlay, but are
absent from this editor and remain machine-owned.

Each row binds explicitly to either:

- `existing`: a selected visible `ContributorHandle`; or
- `new`: an explicit “different author” display name.

Manual editing never silently invokes exact-name resolution. `new` deliberately
bypasses name reuse. Every request row is role `author`; role/raw-role are not
client inputs. `creditedName` is the literal shown for this media item.

One transaction:

1. rechecks media visibility and creator/admin authorization;
2. resolves existing handles or replay-stably creates `new` identities;
3. rejects duplicate canonical contributors;
4. replaces only the media `author` slice, including empty;
5. sets `authors_manually_managed = true`;
6. records the replay response.

The same PUT also accepts `mode: "automatic"`. That branch sets the flag false
and leaves the current author rows in place; the next successful observed author
slice replaces them. UI copy says **Automatic author updates will resume on the
next refresh.** This is a reset, not a third mutation system.

Automatic author writers subsequently do nothing while pinned; non-author role
writers continue normally. Two distinct manual saves use last-committed-writer-
wins semantics; no author-list revision subsystem is added. Podcast-target
credits remain machine-owned in this cutover: podcast detail stays role-aware,
but there is deliberately no podcast author-correction endpoint or manual flag.

### 2.6 Rename

`ensure_contributor_display_name` is one replayable mutation. It validates and
authorizes the visible contributor, treats an already-equal cleaned name as
success, changes only `display_name`, ensures old/new aliases, and leaves handles
and credited spellings unchanged.

### 2.7 Transaction, retry, and race contract

Automatic replacement, manual PUT/reset, and rename all terminate in
`retry_serializable(db, label, op, retries=3)` using a fresh session with no open
session or bind transaction. Passing an open transaction is a correctness defect
because `use_serializable_if_available` would silently retain weaker isolation.
Each `op` reloads all working rows and commits on every attempt.

The database retry owner is extended once to retry the **whole operation** within
the same three-attempt budget for SQLSTATE `40001` and the final named uniqueness
constraints `uq_contributors_handle`,
`uq_contributor_aliases_owner_normalized`,
`uq_contributor_external_ids_authority_key`, all six
`uq_contributor_credits_{target}_{ordinal|contributor_role}` indexes, and existing
`uix_resource_mutations_client_id`. It rolls back before every retry; there are
no nested loops, savepoints, upserts, explicit locks, or read-committed write
paths. Any other integrity error and retry exhaustion are defects. SERIALIZABLE
SSI plus this bounded recovery is the convergence backstop; there is
intentionally no global unique constraint on `normalized_alias`, since explicit
same-name people are valid.

Race tests use two independent sessions and a barrier for same-name first sight,
same-key first sight, and automatic-versus-manual replacement. If manual commits
first, automatic retry sees the pin and does nothing; if automatic commits first,
manual commits last. Either ordering ends with the manual author slice.

### 2.8 Zero-work lifecycle

Picker/search queries require at least one visible credited target, so retained
key owners with zero works never become eternal **0 works** choices. Credit
replacement and media/podcast/Gutenberg deletion pass affected contributor IDs
to the public cleanup operation. A contributor is eligible only when it has zero
credits, no exact key, and no graph/pin/resource/chat or foreign replay
reference. The same operation explicitly deletes its own display-name memos and
aliases before the contributor. Media deletion already removes its author-edit
memos. Keyed or referenced zero-work identities remain privately reusable but
undiscoverable. Recreating an ordinary pruned same-name identity derives the
same deterministic handle and therefore reuses its URL; a replay-protected
forced-distinct identity is not pruned until its owning media memo is removed.

## 3. Architecture and ownership

| Concern | Owner | Rule |
|---|---|---|
| Provider parsing / existing metadata LLM | Source adapter / metadata enrichment | Emit typed observations only |
| Public author operations and identity reads | `services/contributors.py` | Sole transaction/operation facade |
| Pure vocabulary and normalization | `services/contributor_taxonomy.py` | No database or sibling-service imports |
| Identity mutation helpers | visibly private `_contributor_identity.py` | Contributors, aliases, exact keys only |
| Credit mutation helpers | visibly private `_contributor_credit_writes.py` | Credits and media manual flag only |
| Canonical credit read relation | public `services/contributor_credits.py` | Sole query primitive for all consumers |
| User mutation replay | visibly private `_contributor_replay.py` | Manual media-author and rename memos only |
| Target cleanup | public transaction-scoped helper on `services/contributors.py` | Compose credit/memo cleanup into media/podcast/Gutenberg deletion |
| Capability policy | existing permission/capability owner | Same function shapes DTO and enforces write |
| Transport | FastAPI and Next BFF | Parse/serialize only; one operation runner |

Allowed direction:

~~~text
source -> typed observation -> contributors public operation
contributors -> private identity / private credit writes
user mutation -> contributors -> private replay
read consumers -> public canonical credit query
routes -> exactly one contributors facade query/mutation -> private DB runner
~~~

The facade's final semantic surface is exactly: contributor search, contributor
detail, distinct works, observed role-slice replacement, media-author PUT/reset,
display-name rename, and transaction-scoped target cleanup. Names may follow
repository conventions, but no second public identity/write path remains.

Forbidden:

- direct contributor, alias, key, or credit DML from adapters/routes;
- raw provider dictionaries in author services;
- imports of private author helpers outside the author aggregate;
- raw `contributor_credits` reads outside the canonical query owner and immutable
  migration;
- a second normalizer or identity matcher;
- network, LLM, filesystem, or queue work inside resolution;
- nested operation runners, explicit/advisory locks, savepoints, or transaction
  sharing for identity resolution/replacement across source/author boundaries.

No generic operation framework is invented. Each public function on
`services/contributors.py` is the named database operation boundary: GET routes
invoke one query function; automatic lanes invoke one unreplayable mutation;
the media PUT and contributor PATCH invoke one replayable mutation. Authorization
happens inside user mutations before replay lookup. Database business invariants
use application validation, not new CHECK constraints. Foreign keys do not
cascade or set null; media, podcast, and Gutenberg deletion call the public
contributor cleanup operation inside their owning deletion transaction, which
removes credits and applicable author-edit memos before the target row.
That transaction-scoped deletion helper is the deliberate composition exception;
it performs no resolution and starts no runner or retry loop.

## 4. Complete final author schema

This is the complete persisted author schema. No other live author identity,
review, override, or audit table remains.

### `contributors`

~~~text
id            UUID         PRIMARY KEY
handle        TEXT         NOT NULL UNIQUE  -- uq_contributors_handle
display_name  TEXT         NOT NULL
created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
~~~

Application rules: valid branded handle; cleaned nonempty display name, maximum
200 code points. There is no `kind`, `status`, `sort_name`, `disambiguation`,
`merged_at`, or `merged_into_contributor_id`. Every final contributor is active.

### `contributor_aliases`

~~~text
id                UUID         PRIMARY KEY
contributor_id    UUID         NOT NULL REFERENCES contributors(id)
alias             TEXT         NOT NULL
normalized_alias  TEXT         NOT NULL
resolves_identity BOOLEAN      NOT NULL
created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()

UNIQUE (contributor_id, normalized_alias)  -- uq_contributor_aliases_owner_normalized
INDEX  (normalized_alias, resolves_identity, contributor_id)
~~~

Aliases are human-readable observed/former canonical spellings. They are not
globally unique and contain no email address, provider key, URL, source,
confidence, kind, locale/script, or primary flag. Search reads every alias;
identity resolution reads only `resolves_identity = true`. Canonical display and
explicit rename aliases resolve; incidental provider-observed spellings do not.
For a same-contributor normalized collision, keep the resolving literal over a
non-resolving one, otherwise the earliest row; the flag is monotonic OR, so an
observation can never demote a trusted alias.

### `contributor_external_ids`

~~~text
id              UUID         PRIMARY KEY
contributor_id  UUID         NOT NULL REFERENCES contributors(id)
authority       TEXT         NOT NULL
external_key    TEXT         NOT NULL
created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()

UNIQUE (authority, external_key)  -- uq_contributor_external_ids_authority_key
INDEX  (contributor_id)
~~~

Closed application vocabulary at this revision:

~~~text
orcid, isni, viaf, wikidata, openalex, lcnaf,
email_address, x_user, youtube_channel
~~~

These values are private exact identity keys. Feed, podcast, Gutenberg-work,
username, title, and generic URL IDs are not person identity. Exact keys never
enter public DTOs, aliases, snippets, or the contributor full-text search blob.

### `contributor_credits`

~~~text
id                                  UUID         PRIMARY KEY
contributor_id                      UUID         NOT NULL REFERENCES contributors(id)
media_id                            UUID         NULL REFERENCES media(id)
podcast_id                          UUID         NULL REFERENCES podcasts(id)
project_gutenberg_catalog_ebook_id  BIGINT       NULL REFERENCES project_gutenberg_catalog(ebook_id)
credited_name                       TEXT         NOT NULL
normalized_credited_name            TEXT         NOT NULL
role                                TEXT         NOT NULL
raw_role                            TEXT         NULL
ordinal                             INTEGER      NOT NULL
source                              TEXT         NOT NULL
created_at                          TIMESTAMPTZ  NOT NULL DEFAULT now()
updated_at                          TIMESTAMPTZ  NOT NULL DEFAULT now()

INDEX  ix_contributor_credits_contributor_id (contributor_id)
UNIQUE uq_contributor_credits_{media|podcast|gutenberg}_ordinal
       ({target_id}, ordinal) WHERE that target is nonnull
UNIQUE uq_contributor_credits_{media|podcast|gutenberg}_contributor_role
       ({target_id}, contributor_id, role) WHERE that target is nonnull
~~~

The application validates exactly one target, dense nonnegative order, role
vocabulary, and cleaned bounded values. Each target has partial unique indexes on
`ordinal` and on `(contributor_id, role)`. The same person may legitimately have
two different roles on one work. `INDEX (contributor_id)` is retained for author
detail, distinct work counts/examples, picker search, and orphan checks.

Removed credit fields: `source_ref`, `resolution_status`, and `confidence`.

### `media.authors_manually_managed`

~~~text
authors_manually_managed  BOOLEAN  NOT NULL DEFAULT false
~~~

`false` permits automatic replacement of the media author slice. `true` pins
only that slice, including an intentionally empty one; it does not freeze any
non-author role. Public media DTOs expose `authorMode: "automatic" | "manual"`,
not the raw storage column.

### Existing `resource_mutations`

No new replay table is added, and automatic lanes never write this table. The
existing table stores only the two user mutations under these exact scopes:

~~~text
media:{media_id}:authors
contributor:{contributor_id}:display-name
~~~

`clientMutationId` is 1..120 characters. The memo key is the existing
`(user_id, mutation_scope, client_mutation_id)` uniqueness; the request hash is
SHA-256 over one canonical, alias-free request encoding; `changed_lanes = {}`;
and `response_json` is the exact validated public response. Authorization occurs
before memo lookup. Exact replay validates/decodes and returns the stored
response without re-running any write, even if newer mutations have since
committed. The same key with a different payload returns the repository's
established `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH` 409 convention. This deliberately
keeps the internal convention rather than adopting the IETF draft's 422 advice.

Memos have no time expiry. Media deletion removes the media author scope; orphan
contributor cleanup removes its display-name scope. Concurrent insert of the
same memo retries the whole transaction: an exact replay reads the winner, while
a mismatched payload returns 409.

### Deleted storage

- `contributor_identity_events`
- `contributor_reconciliation_runs`
- `contributor_reconciliation_candidates`
- every reconciliation job row/configuration

### Boundary schemas

Final request models accept only the documented camelCase wire shape, reject
unknown fields, enforce real collection bounds, and parse into owned validated
types. Domain/service types use explicit tagged presence/absence; nullable values
exist only at SQL and public JSON adapters.

Manual author-slice request:

~~~json
{
  "clientMutationId": "author-edit-01J...",
  "mode": "manual",
  "authors": [
    {
      "creditedName": "Ursula K. Le Guin",
      "binding": {
        "kind": "existing",
        "contributorHandle": "ursula-k-le-guin"
      }
    }
  ]
}
~~~

`binding` is exactly `{kind:"existing", contributorHandle}` or
`{kind:"new", displayName}`. Reset uses the other tagged branch and rejects an
`authors` field:

~~~json
{
  "clientMutationId": "author-reset-01J...",
  "mode": "automatic"
}
~~~

Rename is `{clientMutationId, displayName}`. The media PUT returns a strict
`MediaAuthorsOut` containing `authorMode`, ordered author credits, and
`canEditAuthors`; PATCH returns the strict `ContributorDetailOut` it records for
replay. Collection results are `ContributorSearchItemOut`; detail and work pages
use `ContributorDetailOut` and distinct-target `ContributorWorkPageOut`. Every
cursor is opaque and every response is decoded before storage and again on
replay.

Public author DTOs expose only branded handle/href, display name, credited name,
role/raw role, order, human aliases, visible distinct work count/examples, and
server capabilities. They expose no UUID, credit ID, source, identity key,
confidence, resolution method, status, kind, or admin metadata.

Contributor work/examples aggregate by distinct visible target. A nested credit
fact list carries each `{creditedName, role, rawRole}` for that person/work, so a
person who is author and translator on one book produces `workCount=1`, one work
row/example, and two role facts.

The canonical credit reader exposes a composable SQL selectable/CTE, not an
already-materialized Python list, so detail, picker counts, and app search share
one visibility and target-dedup relation. Contributor FTS composes display name,
all human aliases, and visible credited names; the existing `external_id_text`
CTE and every `external_key` contribution to search are deleted.

## 5. Source adapter contract

| Lane | Managed roles now | Credited name | Exact key when truly available |
|---|---|---|---|
| EPUB | `author` | OPF creator | None; the current extractor retains names only |
| PDF | `author` | PDF author metadata | None |
| Web article | `author` | Structured/captured byline | Typed durable actor key only |
| X | `author` | Snapshot display name | `x_user` numeric user ID |
| YouTube | `author` | Channel title | `youtube_channel` from `snippet.channelId` |
| Email | `author` | Sender display name; sanitized local part otherwise | `email_address` normalized address |
| RSS episode/media | `author` | Parsed author text | None; feed/podcast ID is not a person |
| Podcast ensure/subscribe | roles present in typed payload | Provider credit text | Only a typed person key already present |
| Gutenberg | `author` | Catalog author name | None; no person authority key exists |
| Metadata enrichment | `author` | Existing metadata + text-sample structured output | Only a typed key already present in input metadata |

Rules:

- one observation contains zero or one key, chosen by shared deterministic
  authority precedence, never dictionary order;
- invalid keys are omitted, not stored raw;
- the PDF parser intentionally reverses today's comma-splitting behavior:
  `Last, First` is one name, and only semicolons or a source-declared true list
  delimiter split people;
- full email addresses never become display names, aliases, logs, or DTO text;
- absent/untrusted data is `not_observed`;
- a provider declares only complete role slices and the shared adapter truncation
  rule applies before the database operation;
- X promotes the numeric ID already captured in `source_ref.x_user_id` into the
  exact key before `source_ref` disappears;
- YouTube retains `snippet.channelId`, which the existing response already
  fetches but currently discards; this adds no HTTP call;
- metadata enrichment stops calling its current replace-all-machine-author path
  and instead emits the declared author slice, respects the media author pin,
  treats absent output as `not_observed`, and does not add another model run;
- the existing metadata-enrichment LLM is the sole AI step; there is no identity
  prompt.

## 6. API and capability contract

Final FastAPI surface:

~~~http
GET   /contributors?q={nonblank query}&cursor={cursor}&limit={1..50}
GET   /contributors/{contributorHandle}
GET   /contributors/{contributorHandle}/works?cursor={cursor}&limit={1..100}
PATCH /contributors/{contributorHandle}
PUT   /media/{mediaId}/authors
~~~

`q` is required, bounded, and nonblank after trim. `GET /contributors` is
lexical canonical-name/alias search for the picker and other existing search
consumers. There is no absent-query directory mode, facet mode, score, or
identity-key search. Results include distinct visible work counts and up to two
distinct visible work examples; singular copy is **1 work**.

Contributor detail is a small canonical name/other names/works view. Works are
distinct targets ordered by partial ISO date descending, title, then unique href;
the cursor contains the full tuple.

Delete all directory, reconciliation, alias, external-ID, merge, split, and
tombstone endpoints. Removed paths return 404. The two former static collection
segments `directory` and `reconciliation-candidates` are reserved handle values;
migration rejects them, generation never emits them, and both FastAPI and BFF
dynamic routes map them to 404 rather than capturing them as authors.

Capabilities:

~~~text
canEditAuthors = canReadMedia AND (isMediaCreator OR isAdministrator)
canRename      = isAdministrator OR canCurateContributors
~~~

The same permission functions shape returned capabilities and re-authorize each
mutation inside its transaction. Invisible resources are 404; visible but
unauthorized resources are 403. Historical null/system-creator media remains
editable by an administrator.

Structural/bounds errors, an unknown or invisible selected contributor handle,
and a duplicate author are 422; handle validation never reveals an invisible
record. Duplicate validation uses the closed
`E_AUTHOR_ALREADY_LISTED` code. Because the existing API error envelope has no
field path, the editor renders its shared `toFeedback` title as form-level
`FeedbackNotice`: **That author is already listed for this role.** Replay payload
mismatch is 409. Server errors retain the repository request ID.

The Next BFF stays transport-only. Add the media-author PUT and the wholly
net-new contributor PATCH routes—no PATCH exists to adapt—delete old BFF routes,
then recount the actual route tree and update the explicit route-count guard
from evidence rather than this spec.

## 7. Product, UX, and content

### Media credits and administration entry

Media publishes the effective ordered roles through the typed resource-header
credit model. Persistent chrome contains one compact, non-focusable text
summary: an unprefixed Authors group followed by truthful role-labelled groups,
with every effective role/name/order represented once. Title and credits
ellipsize independently.

Every ready resource includes **Credits…**, including zero-credit resources.
Its read-only Dialog or MobileSheet shows the complete wrapping title, role
groups (possibly empty), linked contributor names, and no truncation. The typed
contributor vocabulary/grouping owner is shared with podcast credit
presentation; there is no second vocabulary or formatter.

Authorized media owners/admins get **Add author…** or **Edit authors…** in
Options. The persistent bordered Authors row, **No authors** copy, inline
Add/Edit control, and manual-status marker do not exist. Authorization and
manual mode are not disclosed through a disabled command. No confidence,
provider, canonicalization, or identity-resolution language appears.

### Edit authors

The Options command passes its exact trigger into the editor. Desktop uses the
shared Dialog owner; mobile uses the established `MobileSheet`. Both use the
shared explicit `returnFocusTo` contract, enter focus on open, and return to the
same Options trigger on close. If it disconnects, shared overlay fallback owns
recovery; the feature contains no local `.focus()` repair.

Backdrop, drag, history Back, and `onEscape` all pass through the same dirty
guard. When dirty Back is blocked, the history-dismiss owner immediately
restores its synthetic marker before showing the in-sheet confirmation, so a
second Back cannot navigate away. The panel stops backdrop click propagation.

- Title: **Edit authors**
- Helper: **Your changes apply to this work and will be kept when it is refreshed
  or enriched again.**
- Ordered author rows: `Credited as`, canonical author context, Remove, Move
  up/down, Change.
- Search results: canonical name, correctly pluralized `N works`, up to two
  visible work titles, and a
  matching human alias when useful.
- Explicit final actions: **Create “{query}” as a new author** or, when same-name
  records exist, **Create a different author with this name**.
- A loaded row preserves its literal `creditedName`. Adding an existing author
  defaults it to that contributor's canonical display; creating defaults it to
  the cleaned query/display. Changing a row's binding resets `creditedName` to
  the newly selected canonical/new display, after which the field remains
  editable—an old person's credit can never silently follow a new binding.
- Empty save is valid; unchanged Save is disabled and sends no PUT.
- Limit copy: **A work can have up to 20 authors.**
- Dirty dismissal: **Discard changes?** / **Keep editing** / **Discard**.
- Inside the editor, manual mode offers **Reset to automatic authors**. Reset
  uses the same PUT in automatic mode and then says **Automatic author updates
  will resume on the next refresh.** Manual status is not persistent chrome.

`AuthorSearchField` follows the proven `LibraryDestinationPicker` interaction
contract: explicit `idle | loading | ready | empty | error` state, aborted/stale
request suppression, labelled ARIA combobox/listbox/options,
`aria-activedescendant`, a polite live region, inline Create row, and a visible
retryable error. Duplicate results are disabled rather than selectable. Arrow,
Home/End, Enter, and composition-safe input work from the keyboard. The first
Escape closes and stops the listbox; exactly one Dialog/MobileSheet Escape owner
receives the next Escape. Reorder is never drag-only, changes are announced,
Remove moves focus to the next row or Add author, and controls have 44px mobile
targets.

### Rename

- Action: **Edit name**
- Helper: **Used across Nexus. Each work keeps the name it was credited under.**
- Empty validation: **Enter a name.**
- Success: **Author name updated.**

### Author detail

The lightweight pane contains the canonical heading and capability-gated **Edit
name**, an **Other names** section omitted when empty, and the first distinct-work
page. Each work row shows title, available date, and every credited-name/role fact
for that target. An opaque-cursor **Load more** appends the next page; a failed
page retains existing rows and offers **Try again**. A visible referenced identity
with no credited targets says **No works yet.** There are no directory facets,
duplicate suggestions, authority records, or admin panels.

### Shared mutation-intent rule

For edit and rename, generate a mutation ID on first submission of an exact
payload. Reuse it for every retry of that unchanged payload. Rotate it only after
the user changes the draft, after a proven key/payload mismatch, or for a new
intent. Discard it on success/cancel. Disable duplicate submission while pending,
retain inputs on failure, and never expose the key.

API failures are detected with `isApiError` and rendered through existing
`toFeedback` titles plus `FeedbackNotice`/`FieldFeedback` inside the still-open
editor. Add the 409 title **That author change changed. Reload and try again.**
to the shared feedback owner. A timeout/transport failure instead says
**Couldn't confirm the change. Try again.** because the server may have
committed; retrying the same key resolves that ambiguity. Preserve
`handleUnauthenticatedApiError`, draft state, and request IDs. Success may close
and toast. There is no generic “Nothing changed” success-like error.

There is no root Authors directory page or fixed Authors nav item. Keep the
single `DESTINATIONS` entry for standing heads, Launcher, and existing Go to
Authors keybindings, but make it slot-less with label **Authors**, explicit
`UserRound` icon, and `href: "/search?kinds=people"`; it has no `/authors` route
match. Launcher/Go to Authors therefore opens Search with People selected and
the input focused. A blank kind-only search performs no directory request until
the user types. `/authors` is 404; `/authors/{handle}` remains and its standing
head remains **Authors**.

## 8. Hard-cutover migration

Planned revision is `0179` over current head `0178`; revalidate and renumber if
head moves. `downgrade()` is unsupported.

Release sequence: stop API/workers and prove absence, verify backup, run migration
and postconditions, deploy API/worker/BFF/web together, start the new worker
contract, then smoke positive and removed routes. No old binary may run against
the new schema.

### Preflight

Before implementation freezes the cap, run a production-shaped read-only report
of maximum and over-limit counts per target type/source/role. Report no names,
keys, addresses, or credited text. If the data shows a systematic meaningful
need above twenty, revise the one constant before cutover; anthologies do not
make migration unsatisfiable by themselves.

Migration preflight fails before destructive DDL for malformed
handles/names/keys, invalid credit targets/order, unclassifiable role/alias/source
salvage, unknown JSON ref shapes, or any contributor/edge reference owner that
cannot be deterministically repointed or deleted. It reports over-limit slices
for deterministic truncation rather than failing them. Reference owners are
enumerated from the live catalog and code, not from this document alone; an
unknown owner is a blocker, never a best-effort skip.

### Identity collapse

1. Clean every retained literal and recompute match keys with the frozen
   migration-local display and `toNFKC_Casefold` implementations; do not trust
   stored normalized values.
2. Classify the current canonical display alias and legacy
   `manual`/`user`/`curated`/`merge`/rename aliases as resolving. Known
   provider-observed credited aliases remain searchable but non-resolving;
   unknown alias sources fail preflight.
3. Before dropping `contributor_credits.source_ref`, mine recoverable X numeric
   IDs from `source_ref.x_user_id`, canonicalize them, and attach them to the
   eventual survivor.
4. Build connected components from exact normalized canonical displays,
   resolving aliases, exact canonical durable keys, and recovered X IDs. Reject
   any union that would put two different keys from the same authority in one
   component; process canonical-name then resolving-alias edges in earliest-row
   order so keyless duplicates attach deterministically to the stable winner.
5. Do not connect components using non-resolving aliases, feed, podcast,
   Gutenberg-work, URL, username, or generic provider IDs.
6. Among retainable active rows, choose the survivor by earliest `created_at`,
   then UUID. Counts never participate; a tombstone never wins by becoming
   active.
7. Survivor display and handle win. Alias collision winner is the
   survivor-owned literal, then earliest `(created_at, id)`.
8. Repoint all owned references to the survivor and delete losing contributors;
   there are no runtime redirect rows or `merged_into` column.

Every legacy tombstone has a total disposition: map it to a retained survivor, or
explicitly remove/repoint its child aliases/keys/refs and delete it. No tombstone
can silently become active in the final schema.

Privacy cleanup removes full email addresses, URLs, and provider keys from
aliases. If such a value is also the only display, migration derives the same
sanitized non-address display that the runtime email adapter uses; an unusable
result blocks cutover. Postconditions scan both display and alias text.

### Authority vocabulary migration

- Keep and canonicalize `orcid`, `isni`, `viaf`, `wikidata`, `openalex`, and
  `lcnaf`.
- Rename `email` to `email_address` and canonicalize the address key.
- Rename legacy `youtube` to `youtube_channel` only when its value and stored
  provenance prove a channel ID; drop ambiguous video/generic values.
- Create `x_user` rows from the recovered numeric X IDs before deleting
  `source_ref`.
- Drop `podcast_index`, `rss`, and `gutenberg` keys; they identify feeds/works,
  not people. New runtime rows use `x_user` and `youtube_channel` only from the
  adapter facts in §5.
- Drop the old authority CHECK and let the closed application vocabulary own
  validation; do not replace it with a new business CHECK.

### Credit salvage

For each target, salvage per role rather than selecting one source for the whole
target:

- for `author`, preserved `manual`/`user`/`curated` rows win; otherwise take the
  source slice with greatest `MAX(updated_at)`, then source name ascending;
- preserve each non-author role independently using the same deterministic
  user-first/source-slice rule;
- canonicalize contributors, dedupe `(contributor, role)` by original order/time/
  ID, combine role slices in their earliest legacy positions, then renumber;
- after cleanup/dedup, keep the first twenty rows of each role slice by that
  deterministic order and report aggregate truncated target counts;
- set the media manual flag when any preserved user-owned author-list fact exists;
- legacy zero-credit media migrates automatic because historical manually-empty
  intent was not persisted and cannot be recovered.

### Reference and graph rewrite

Migration 0179 contains frozen, self-contained rewrite rules; it does not import
runtime services. Before deleting losers it applies this explicit floor
manifest; catalog discovery may add owners but may not omit these:

- **Relational children:** repoint aliases, external IDs, and credits. Identity
  events and reconciliation candidates are deleted with their tables.
- **Polymorphic UUID refs:** rewrite
  `user_pinned_objects.(object_type,object_id)`,
  `resource_versions.(resource_scheme,resource_id)`,
  `resource_view_states.(surface_scheme,surface_id)` and
  `(target_scheme,target_id)`, `chat_run_turn_contexts` requested/actual subject
  pairs, and both endpoints of `resource_edges`. Pin collisions keep the earliest
  `(order_key, created_at, id)` active row over a soft-deleted row.
  Resource-version collisions keep the greatest `(version, updated_at, id)` per
  user/lane. View-state collisions keep the latest `(updated_at, id)` state.
- **Explicit suppression exemption:** do not repoint `synapse_suppressions` rows
  with a losing contributor endpoint. Delete them and report the count; silently
  broadening a negative pair to the survivor is not equivalent intent.
- **Nested handle refs:** recursively rewrite typed contributor objects in
  `message_retrievals.context_ref/result_ref`,
  `message_retrieval_candidate_ledgers.result_ref`,
  `message_tool_calls.result_refs/selected_context_refs`,
  `chat_prompt_assemblies.included_context_refs/prompt_block_manifest/dropped_items`,
  `resource_edges.snapshot`, typed chat-run event payloads, and
  `resource_mutations.response_json`. `message_retrievals` and candidate-ledger
  `source_id`, plus contributor-result `message_retrievals.deep_link`, are also
  rewritten. This is a recursive JSON object/array transform of
  `{type:"contributor", id:"<handle>"}` and its nested
  `contributor_handle`/canonical deep-link fields, plus an exact rewrite of a
  typed contributor result's `/authors/<handle>` deep-link column—not a UUID
  UPDATE or arbitrary string replacement. Unknown contributor-ref shapes fail
  preflight.
- **Direct resource refs:** rewrite `resource_versions`,
  `resource_view_states`, and `chat_run_turn_contexts` even though existing
  cleanup helpers are notes/resource-specific. Delete any old mutation memo
  whose scope is keyed by a losing contributor UUID after rewriting typed
  response refs.

After endpoint rewrites, remove graph self-edges. Collapse logical edge
collisions by earliest `(created_at, id)` for citation identity
`(user, source ref, ordinal)`, source-order identity
`(user, source ref, source_order_key)`, bare identity
`(user, origin, source ref, target ref)`, and the graph owner's undirected
`origin=user` pair rule. Rebind these edge-ID consumers to that winner:

- `resource_view_states.edge_id`;
- `chat_run_turn_contexts.subject_context_edge_id` (null only when a removed
  self-edge has no valid winner);
- `oracle_reading_folios.edge_id` (required; no valid winner blocks cutover);
- `message_retrievals.cited_edge_id` (nullable telemetry);
- typed edge IDs in chat-run event payloads.

An unhandled restrictive dependent, telemetry owner, collision, or JSON shape
fails before loser deletion.

### Destructive cleanup and postconditions

Delete every `contributor_reconciliation` background-job row in every state, its
registry/user-facing/default-worker entries, its production example and safe
allowlist entries, all reconciliation/event tables and ORM symbols, dead
columns, dead indexes, dead routes, and dead worker configuration.

Migration fails unless:

- every final contributor is active and every legacy duplicate/tombstone is gone;
- every display has a resolving human alias, every stored literal/key is
  canonical, and display/alias text contains no address, URL, or provider key;
- every alias/key/credit owner exists;
- every credit has one target, dense order, at most twenty rows per role slice,
  and no duplicate `(contributor, role)` per target;
- every authority is in the final vocabulary and every legacy authority has its
  declared keep/rename/drop disposition;
- every stored contributor UUID, handle, and typed `/authors/<handle>` deep link
  points to a survivor;
- every graph logical identity and dependent edge reference is valid;
- reconciliation jobs/tables, identity events, removed columns, and old
  constraints are absent.

## 9. File plan

The implementation must re-run repository-wide ownership and removed-field
sweeps; this manifest is a floor.

### Create

- `migrations/alembic/versions/0179_lightweight_author_deduplication_hard_cutover.py`
- `python/nexus/services/_contributor_identity.py`
- `python/nexus/services/_contributor_credit_writes.py`
- `python/nexus/services/_contributor_replay.py`
- `python/tests/test_author_deduplication_cutover.py`
- two-session author race integration tests and 0178→0179 reference fixtures
- `apps/web/src/components/contributors/ContributorRoleGroups.tsx` + CSS/test
- `apps/web/src/components/contributors/MediaAuthorsEditor.tsx` + CSS/test
- `apps/web/src/components/contributors/AuthorSearchField.tsx` + CSS/test
- `apps/web/src/app/api/media/[id]/authors/route.ts`

### Rewrite or simplify

- `python/nexus/db/models.py`
- `python/nexus/db/retries.py` + tests for named whole-operation integrity retry
- `python/nexus/errors.py`
- `python/nexus/schemas/contributors.py`
- media/library/podcast/search schemas that embed credits
- `python/nexus/services/contributor_taxonomy.py`
- `python/nexus/services/contributors.py`
- `python/nexus/services/contributor_credits.py`
- remove/adapt `upstream_contributor_credit_previews_for_names`,
  `resolve_canonical_contributor_ids`, and every merged-chain reader to the final
  direct active-identity contract
- `python/nexus/services/chat_context_refs.py` and the resource graph/version/
  view-state cleanup owners for the complete reference manifest
- media capability/authorization, media/podcast/Gutenberg deletion, orphan
  cleanup, and projection owners
- contributor/media FastAPI routes
- `python/nexus/tasks/ingest_pdf.py`, `ingest_epub.py`, and
  `enrich_metadata.py`, plus their lifecycle/ready transitions, so they end any
  source transaction, await the fresh-session author step, and only then return
  success/cross ready
- `python/nexus/services/pdf_metadata.py`, `pdf_lifecycle.py`,
  `metadata_enrichment.py`, `web_article_ingest.py`, `media_source_ingest.py`,
  `x_ingest.py`, `youtube_video_ingest.py`, `gutenberg.py`, email and
  podcast/RSS adapters; this owns PDF delimiter reversal, X-key promotion,
  YouTube channel-ID retention, managed-role declarations, and the enrichment
  replacement change
- search, browse, library, related-media, object-ref, app-search, podcast, and
  resource resolver consumers of contributor credits
- `python/nexus/services/search/retrievers/contributors.py` and search service:
  compose the canonical SQL relation and remove external-key FTS/merge-chain
  lookup
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` + CSS/tests
- `apps/web/src/components/workspace/PanePrimaryChrome.tsx` and typed resource
  header publication tests
- `apps/web/src/components/ui/ActionMenu.tsx`: Options-only Credits and author
  administration entry with explicit trigger handoff
- `apps/web/src/app/(authenticated)/authors/[handle]/AuthorPaneBody.tsx` + tests
- `apps/web/src/components/ui/Dialog.tsx`, `MobileSheet.tsx`,
  `useDialogOverlay.ts`, `useHistoryDismiss.ts`, and focused tests/consumers for
  the single dismissal/focus contract and blocked-Back history re-arm
- `ContributorCreditList.tsx`, `ContributorChip.tsx`, contributor formatting,
  `PodcastSummaryCard.tsx`, and media `mediaFormatting.ts`: share one role
  grouping/formatting owner across compact media credits, the complete Credits
  overlay, and podcast presentation; remove reads of deleted credit
  `id`/`resolution_status` fields
- `ContributorPicker.tsx`, `useContributorSearch.ts`, and
  `ContributorFilter.tsx`: remove the old picker with merge UI and either upgrade
  the shared search result-state contract for both callers or keep the filter on
  a separately cleaned controller; do not turn errors into empty results
- contributor/search/media TypeScript types, APIs, presenters, feedback titles,
  and resource loaders
- `apps/web/src/lib/navigation/destinations.ts`, `paneRouteModel.ts`, Launcher,
  keybinding, nav-model, and tests for the slot-less Authors destination
- `paneRouteModel.ts`, `paneRouteTable.ts`, and `paneRenderRegistry.tsx`: remove
  only the root `authors` pane route while retaining author detail
- contributor detail/PATCH and media-author BFF routes
- `e2e/tests/authors.spec.ts` and `apps/web/src/app/api/proxy-routes.test.ts`
- route-count, worker-contract, ownership, migration, and negative-gate tests

### Delete

- `python/nexus/services/contributor_reconciliation.py`
- `python/nexus/tasks/contributor_reconciliation.py`
- reconciliation route/schema/model/job/config/pyright symbols
- `ContributorIdentityEvent` model and every identity-event write/test
- merge/split/tombstone/alias/external-ID mutation methods and request DTOs
- runtime `resource_graph.edges.repoint_edges` when its last merge/split caller is
  gone; migration keeps only a frozen local rewrite
- reconciliation components and all related BFF routes
- contributor directory, merge, split, tombstone, alias, and external-ID BFF
  routes
- `apps/web/src/app/(authenticated)/authors/page.tsx`, `AuthorsPaneBody.tsx`, and
  `AuthorsPaneBody.test.tsx` (there is no root directory CSS file)
- directory-only contributor descriptors, DTOs, API/presenter code, and root
  pane renderer/meta wiring after callers are removed
- dead status/kind/facet/reconciliation TypeScript vocabulary

### Docs and deployment

Remove `contributor_reconciliation` from the job registry,
`USER_FACING_JOB_KINDS`, `DEFAULT_WORKER_ALLOWED_JOB_KINDS`,
`env-prod-worker.example`, and `sync-env.sh`'s safe allowlist; there is no
separate reconciliation env token. Update `docs/architecture.md`,
`docs/modules/jobs.md`, the old author cutover with a superseded banner, and any
active document that still claims merge/split/reconciliation ownership. Delete
all `__pycache__`/`.pyc` artifacts—including stale
`0179_contributor_identity_resolution.pyc`—before trusting static grep gates.

## 10. Acceptance criteria and verification

### Resolver and ingestion

1. Two adapters observing the same normalized name create one contributor.
2. Case, compatibility-Unicode, whitespace, ZWSP/ZWJ, soft-hyphen, BOM, and other
   default-ignorable variants reuse it; punctuation, order, and diacritic
   variants do not.
3. Canonical and explicit-rename aliases resolve identity; a provider-observed
   non-resolving alias is searchable but does not bind a future observation.
4. An exact stable key reuses its owner across display-name changes and stores
   the new spelling only as a non-resolving alias.
5. An unseen key that contradicts a same-authority key on the name winner creates
   a distinct identity; different authorities alone do not imply conflict.
6. Multiple same-name candidates always choose earliest creation then UUID, even
   after another candidate's credited-target count grows past it.
7. Same-batch equal names/keys create one identity, while contradictory
   same-authority keys stay distinct, with source order preserved.
8. Barrier-controlled two-session same-name and same-key first sightings
   exercise `40001`/named-conflict retry and converge with no orphan rows.
9. Ordinary re-ingestion/re-enrichment adds no identity AI/network/job, writes no
   `resource_mutations`, and is no-DML when unchanged. A crash may make the
   existing job retry its normal source work; repeated author assignment
   converges, and ready/publication remains gated on its success.
10. `not_observed` preserves every prior managed slice.

### Lists and roles

11. A lane replaces only its declared complete role slices. Current media lanes
    replace only authors; a typed role-capable podcast payload can create a host,
    guest, translator, or other supported role; undeclared roles survive.
12. One person in two legitimate roles remains two role facts but one distinct
    work/example/count and one cursor position.
13. A manual nonempty or empty media author slice survives every automatic author
    lane while automatic non-author role updates continue.
14. An automatic/manual two-session race always finishes with the manual author
    slice; different manual saves are last-committed-writer-wins.
15. Reset changes `authorMode` to automatic without erasing current authors, and
    the next observed author slice replaces them.
16. Opening, canceling, or unchanged Save performs no PUT and does not set the
    manual flag.
17. Replaying forced-new edit K returns K's exact memo and performs no writes even
    after later edit K2 changed the list; mismatched K is 409.
18. Podcast credits remain role-aware and machine-owned, with no podcast manual
    correction control or endpoint in this cutover.
19. Target deletion removes credits/memos, hides retained zero-work key owners,
    prunes eligible orphans, and ordinary same-name recreation reuses its handle.
20. Direct credit DML/read and open-transaction author-write ownership gates pass.

### API and UX

21. Tagged manual/automatic PUT preserves author order, accepts empty manual
    authors, rejects duplicate/unknown/invisible handles as 422 (including
    `E_AUTHOR_ALREADY_LISTED` form feedback), and enforces creator/admin
    capability exactly as `MediaOut` advertises.
22. Rename keeps handle and credited spellings; old/new names resolve and search.
    If A→B response is lost, B→C later succeeds, and A→B is retried, replay
    returns the recorded A→B response without reverting C.
23. Required nonblank contributor `q`, strict request/response decoding, opaque
    cursors, singular/plural work copy, 403/404/409/422 mapping, and exact replay
    scopes pass API tests. Author detail omits empty Other names, exposes every
    role fact, and makes all works reachable through Load more/retry/zero states.
24. Public DTOs and app-search text contain none of the prohibited storage,
    provider, admin, or external-key fields.
25. A same-name picker shows only visible credited work context, supports explicit
    distinct creation, disables duplicate selection, and never leaks private or
    zero-work context.
26. Persistent media chrome shows compact structured credits only; complete
    linked credits remain inspectable through **Credits…**. No bordered Authors
    row, **No authors**, inline Add/Edit control, or manual marker survives.
    Authorized Add/Edit Authors administration exists only in Options; manual
    reset remains inside the editor.
27. Full ARIA combobox state, nested Escape, MobileSheet Back/backdrop/drag,
    blocked-Back history re-arm, desktop dirty guard, exact Options-trigger
    return with shared disconnected-trigger fallback, reorder announcements,
    focus-after-Remove, pending/error feedback, and same-key retry component
    tests pass.
28. API errors flow through `toFeedback`; replay mismatch says **That author
    change changed. Reload and try again.**; transport uncertainty says
    **Couldn't confirm the change. Try again.** and preserves the same key/draft.
29. Authors is absent from fixed nav but retained slot-less in Launcher/keybindings
    at `/search?kinds=people`; People is selected/input focused with no blank
    directory request; `/authors` is 404; detail standing head remains Authors.
30. Deleted FastAPI/BFF paths, including reserved former collection segments,
    return 404; the route-count guard equals the actual tree.

### Migration and hard absence

31. A representative 0178 fixture covers exact components, resolving/non-
    resolving aliases, same-name same-authority key conflicts, every authority
    mapping, source-ref X recovery, tombstones, privacy-sensitive literals,
    manual/machine authors,
    translator/host/guest roles, over-limit slices, and reconciliation rows in
    every state.
32. The fixture covers every §8 polymorphic/JSON/graph reference, nested handle
    shape, direct and snapshot contributor deep link, logical edge collision and
    dependent; synapse suppression uses its explicit delete exemption. No
    losing UUID/handle/deep link or dangling edge remains.
33. Migration preserves role slices, deterministically truncates only over-limit
    role slices with an aggregate report, and fails an unknown owner/shape before
    destructive DDL with no partial state.
34. Every final schema, privacy condition, authority disposition, resolving-alias
    gate, index, and postcondition holds on upgraded and fresh databases;
    downgrade is intentionally unsupported.
35. Static gates find no reconciliation, identity event, merge/split/tombstone,
    merged-chain reader, removed field, weak provider-key identity, external-key
    FTS, raw credit read/write, random handle fallback, or old count-winner rule
    outside immutable history.
36. No old process, job/allowlist entry, route, root Authors pane, component, ORM
    model, compatibility shape, or pycache ghost remains on the deployed revision.

### Performance budget

- At most twenty observations per declared managed-role slice.
- One batched indexed key lookup and one batched indexed alias lookup, not N+1.
- Automatic retries use no replay-memo read/write; unchanged refresh uses no DML.
- No pg_trgm, vector extension, embeddings, reranker, cache, or new queue.
- Capture before/after query counts and query plans for one-author ingest,
  contributor search, and author detail; do not invent an unmeasured latency SLO.

## 11. Implementation order and definition of done

1. Run the read-only cap/reference preflight; land migration fixtures, final
   schemas, and negative ownership gates.
2. Land the pure normalizer, validated types, deterministic resolver, and
   centralized whole-operation retry support.
3. Land private identity/credit helpers and user-only replay behind the public
   contributor facade.
4. Adapt every automatic producer to the durable fresh-session step and every
   consumer to the canonical composable credit relation.
5. Add media capability/mode, PUT/reset, compact resource credits, Credits
   overlay, Options-only author editor, rename, slot-less search destination,
   and lightweight detail.
6. Delete directory/reconciliation/merge/split/tombstone/authority runtime and UI.
7. Implement 0179 rewrite, destructive cleanup, and postconditions.
8. Update docs/config/route and worker contracts.
9. Run focused backend/frontend/migration/E2E suites, repository-standard checks,
   coordinated deployment, positive smoke, and removed-route probes.

Done means the deployed system has one exact deterministic resolver, one
effective role-aware credit relation, one visible/resettable media-author pin,
one simple correction flow, and none of the old authority/reconciliation
product. “The new path works while the old path remains” is not done.
