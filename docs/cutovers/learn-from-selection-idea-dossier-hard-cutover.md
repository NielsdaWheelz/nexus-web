# Learn from selection — idea Dossier hard cutover

**Status:** IMPLEMENTED · UNSHIPPED · Rev 2 · 2026-07-28
**Type:** Hard cutover — no legacy code, fallback, compatibility shape, or dual renderer.

## 0. Decisions

No blocking product question remains.

- One action: **Learn**.
- One output: one complete learning Dossier. No Quick Primer / Deep Lesson.
- One Learn surface: the standalone Artifact pane. No preview, chooser, tooltip,
  modal, or provisional pane.
- One identity: an internal Idea subject, not a Highlight occurrence.
- One body: one accepted semantic HTML fragment plus derived plain text.
- Nexus owns title, CSS, theme, CSP, citations, and frame runtime. The model owns
  no document chrome, CSS, JavaScript, URL, or active content.
- One edit model: full regeneration into a new immutable revision. No editor,
  document patches, blocks, or incremental regeneration.
- Exact canonical Idea-key reuse only. No fuzzy merge, aliases, ontology, rename,
  split, or merge UI.
- Existing Artifact head identity stays `(subject_scheme, subject_id, audience)`.
  There is no `subject_key` migration.
- Existing Dossier Markdown output is destructively removed; Artifact heads and
  Artifact-head user Links survive.

This is an expansion of Universal Dossiers, not a Learning Resource subsystem.

## 1. Outcome

Selecting text and pressing **Learn**:

1. creates/reuses the durable Highlight;
2. resolves/reuses one internal Idea subject;
3. finds/creates its user-audience Artifact;
4. registers the Highlight as research provenance;
5. opens the Artifact through `Adopt`;
6. researches Nexus plus fetched Web Articles through a replay-safe workflow;
7. publishes one cited learning document.

The Artifact remains linkable, CopyOnly-shareable, attachable, chat-readable,
regenerable, and versioned. Its revisions remain citable.

## 2. Goals and stop line

- Reuse Highlights, Dossiers, Artifact revisions/history, resource chat/read,
  workspace activation, app search, source ingestion, and Web Article reading.
- Research the idea across occurrences and source documents, within fixed budgets.
- Cite only fully read, audience-visible ResourceRefs offered to synthesis.
- Give Artifact and Artifact Revision refs one canonical standalone route.
- Accept generated output through one narrow WHATWG-conformant boundary.
- Keep one inert body string; defer every richer learning/editor abstraction.

Stop when a selected idea reliably becomes one researched, cited, readable,
chat-able, regenerable HTML Dossier in its own pane.

## 3. Non-goals

- Google/Wikipedia lookup or remote-page iframe.
- Quick/deep modes, learner profiles, prerequisite graphs, nested tooltips,
  quizzes, mastery analytics, or study scheduling.
- Model-authored CSS, JavaScript, React, SVG, MathML, images, links, forms,
  iframes, datasets, charts, or executable widgets.
- A public `idea` `ResourceScheme`, Library entry kind, media type, or search kind.
- Exhaustive crawling, source-management UI, worker swarms, verifier agents, or
  an LLM research planner.
- Automatic refresh when the open web changes.
- Public/commercial licensing infrastructure.

## 4. Target behavior

### 4.1 Learn UX

The current selection flow remains Highlight-first:

1. `SelectionPopover` invokes its existing create/reuse-Highlight owner.
2. Highlight success clears retained selection and unmounts the popover normally.
3. The Media/PDF pane owner above `SelectionPopover` starts
   `POST /artifacts/dossiers/learn` with the Highlight ref.
4. Existing global feedback shows `Creating lesson…`.
5. On success, call
   `activateTarget({target, disposition: {kind: "Adopt"}})` with the Artifact.
6. On failure, global feedback says:
   `Could not create a lesson from this Highlight. Open the saved Highlight and try Learn again.`

Do not keep the Learn button busy, lock popover dismissal, or add an inline-error
slot. Request, feedback, and activation state must outlive popover unmount. The
durable Highlight is the retry locus; the user does not reselect text.

### 4.2 Exact reuse

- One accepted Highlight resolution is immutable.
- Before resolution, offer every existing Idea subject whose `title_key` exactly
  matches the normalized selection.
- Resolver output is:

```text
Existing { idea_subject_id }
| New { display_title, idea_key }
| Unresolved
```

- This is the decoded domain union. The provider-runtime wire schema is one
  strict object with `kind` plus required-nullable fields
  `idea_subject_id`, `display_title`, and `idea_key`; `idea_key` likewise has
  required-nullable `disambiguator_key`. The decoder rejects every field
  combination except the three shapes above. This is required because the
  canonical provider schema permits required-nullable unions only, not
  `oneOf`, arbitrary `anyOf`, `const`, or UUID `format`.
- `Existing` must select from the offered list.
- Every `New.display_title` echoes the selected phrase after
  display normalization (remove default-ignorables, NFKC, trim, and collapse
  whitespace while preserving case). `New.idea_key.title_key` must equal the
  canonicalized selection. The resolver never substitutes a synonym or invents
  a broader canonical title.
- An unambiguous term omits the disambiguator. Context may supply one concise
  disambiguator only when multiple offered/credible meanings require it.
- The resolver receives the exact selection, source title, bounded surrounding
  passage, and matching existing candidates as delimited untrusted data. It has
  no research or mutation tools.
- Resolver uncertainty becomes `E_DOSSIER_IDEA_UNRESOLVED`; there is no generic key.
- Re-Learn of an existing current Artifact registers the new seed and opens it;
  it does not regenerate automatically.
- Re-Learn during an active build opens the same Artifact; it does not fail or
  start a second build.
- Seed growth never makes a correct revision `Stale` and never invalidates an
  active build. The pane may render soft action copy such as
  `Regenerate with 2 new contexts`.
- Actual cited-source deletion/content change retains the existing freshness
  semantics.

### 4.3 Learning document

Target a curious first-year student. The article normally contains:

1. why the idea matters;
2. a concise mental model;
3. necessary foundations;
4. a step-by-step explanation;
5. a concrete example, application, or case study when useful;
6. common mistakes, limits, or disagreement;
7. useful next directions;
8. inline citations and references.

When a principal source already explains the idea well, preserve its wording
mostly verbatim with clear attribution. Do not privilege the first Highlight.
Explicit quotations remain exact; synthesis is never presented as quotation.

Presentation stays one calm reading surface: pane-width frame, responsive
`60–72ch` article measure, visible heading hierarchy, horizontally scrollable
tables/code when needed, no card grid, no badge, and no content motion. The
trusted stylesheet owns light/dark contrast, focus, print, and narrow-pane
behavior.

### 4.4 Pane actions

- Chat: existing resource-context chat with `artifact:<id>`.
- Regenerate: full-document build by Artifact ref.
- History / Make current / Cancel / Retry: existing Dossier lifecycle.
- Citation activation: existing citation target plus workspace activation.
- No Edit action. Chat never mutates the Dossier.

## 5. Domain and schemas

### 5.1 Internal Idea subject

Keep `artifacts.subject_scheme` and `artifacts.subject_id`.

Add:

```text
artifact_idea_subjects
  id UUID PRIMARY KEY
  user_id UUID NOT NULL FK users.id (no cascade)
  idea_key JSONB NOT NULL
  display_title TEXT NOT NULL
  created_at TIMESTAMPTZ NOT NULL
  UNIQUE(user_id, idea_key)
    NAME uq_artifact_idea_subjects_owner_key
```

An Idea Artifact stores:

```text
subject_scheme = "idea"
subject_id = artifact_idea_subjects.id
audience_scheme = "user"
audience_id = artifact_idea_subjects.user_id
```

`idea` is an internal `DossierSubjectScheme`, not a public `ResourceScheme`.
Preserve `uq_artifacts_subject_audience` exactly.

### 5.2 Canonical Idea key

The only encoding is:

```json
{
  "version": "v1",
  "title_key": "required",
  "disambiguator_key": "present only when needed"
}
```

Rules:

- `disambiguator_key` absence is key omission. JSON `null` is rejected.
- One `encode_idea_key` / `decode_idea_key` pair owns every DB/API comparison.
- Canonical text pipeline:
  1. remove Unicode default-ignorable code points;
  2. NFKC;
  3. Unicode casefold;
  4. NFKC again;
  5. trim;
  6. collapse Unicode whitespace;
  7. reject empty text or more than 160 grapheme clusters.
- Add a Unicode grapheme implementation; never truncate through a grapheme.
- JSONB equality of the canonical encoder is the sole reuse rule.

### 5.3 Highlight resolution and seeds

```text
artifact_idea_resolutions
  highlight_id UUID PRIMARY KEY FK highlights.id (no cascade)
  user_id UUID NOT NULL FK users.id (no cascade)
  idea_subject_id UUID NOT NULL FK artifact_idea_subjects.id (no cascade)
  created_at TIMESTAMPTZ NOT NULL

artifact_idea_seeds
  id UUID PRIMARY KEY
  artifact_id UUID NOT NULL FK artifacts.id (no cascade)
  highlight_id UUID NOT NULL FK highlights.id (no cascade)
  added_at TIMESTAMPTZ NOT NULL
  UNIQUE(artifact_id, highlight_id)
    NAME uq_artifact_idea_seeds_pair
```

- Resolution maps one occurrence to one Idea.
- Seed rows, not neutral Resource Graph Links, own generation membership.
- The Idea binding reads visible seed rows and their nearby Highlight notes.
- `services/highlights.delete_highlight_rows` explicitly removes resolution/seed
  and affected Learn-replay rows before deleting a Highlight.
- Idea Artifact teardown deletes affected Learn replay → seeds → existing
  Artifact children/head → resolutions → Idea subject. User teardown applies
  the same owner order across all owned rows.
- No automatic Artifact→Highlight Link is created; no UI falsely claims a
  Connections recovery path.

### 5.4 Learn replay

```text
artifact_learn_requests
  id UUID PRIMARY KEY
  user_id UUID NOT NULL FK users.id (no cascade)
  idempotency_key TEXT NOT NULL
  request_hash TEXT NOT NULL
  highlight_id UUID NOT NULL FK highlights.id (no cascade)
  coordination JSONB NOT NULL
  resolver_lease_expires_at TIMESTAMPTZ NULL
  created_at TIMESTAMPTZ NOT NULL
  UNIQUE(user_id, idempotency_key)
    NAME uq_artifact_learn_requests_user_key

artifact_learn_successes
  request_id UUID PRIMARY KEY FK artifact_learn_requests.id (no cascade)
  outcome_kind TEXT NOT NULL       # Opened | BuildAccepted
  artifact_id UUID NOT NULL FK artifacts.id (no cascade)
  build_id UUID NULL FK artifact_builds.id (no cascade)
  created_at TIMESTAMPTZ NOT NULL

artifact_learn_failures
  request_id UUID PRIMARY KEY FK artifact_learn_requests.id (no cascade)
  error_code TEXT NOT NULL         # E_DOSSIER_IDEA_UNRESOLVED only
  created_at TIMESTAMPTZ NOT NULL
```

- `Idempotency-Key` is required, 1–128 characters.
- `request_hash` covers canonical `{highlight_ref}`.
- Same key + different hash returns existing
  `E_IDEMPOTENCY_KEY_REPLAY_MISMATCH`.
- Exactly one success/failure terminal child is application-enforced.
- `Opened` requires `build_id IS NULL`; `BuildAccepted` requires a non-null
  `build_id`. Validate this exact union on every read/write.
- Replay returns the recorded terminal response, including the original build
  handle after build completion.
- Highlight/Artifact/User teardown deletes affected replay rows first. The exact
  replay promise ends when its target is explicitly deleted. A resolver owner
  or waiter that observes this teardown returns the normal masked not-found
  outcome; it never asserts or recreates the request.
- The resolver is a `BilledOnce` coordinated step in `coordination`. Claiming
  `Uncertain` sets a 15-minute owner lease in the same transaction. Concurrent
  replays with the same request identity poll the durable result only while
  that lease is live and return the exact terminal outcome; they never dispatch
  a second call. Completion clears the lease. A known local/provider failure
  expires it immediately; process loss leaves it to expire. An expired
  `Uncertain` call is an operator-visible uncertain-delivery defect and is never
  auto-redispatched.
- Add LLM ledger owner `artifact_learn_request`.

### 5.5 Revision body

Hard-replace:

```text
artifact_revisions.content_md
```

with:

```text
content_html TEXT NOT NULL   # canonical accepted <article> fragment
content_text TEXT NOT NULL   # derived plain-text projection
```

`content_html` is the sole body presentation source. `content_text` is derived
from the accepted DOM in the publish transaction and is the only body supplied to
chat/read/search. Persist the final trusted-control-compiled article; never
persist the raw model envelope or precompiled citation-token fragment. No
runtime consumer parses Markdown or sends raw HTML to a model.

### 5.6 Idea manifest and coverage

Add `IdeaInputManifestV1`:

```text
{
  version: "v1",
  kind: "idea",
  idea_subject_id,
  included_seed_refs[],
  nexus_query_fingerprints[],
  web_query_fingerprints[],
  included_sources[{ref, content_fingerprint, role}],
  omitted_sources[{locator, reason}]
}
```

- Persist query fingerprints/counts, never raw queries.
- Coverage derives seed/Nexus/web counts and omissions from the manifest.
- Freshness checks only included seed/source existence and fingerprints.
- Seed rows added after collection are excluded from the build witness. They
  become `new_context_count` for a later Regenerate, not `InputsChanged`.
- Discovery of new open-web pages does not automatically make a revision stale.

## 6. Engine identity and build ownership

### 6.1 Honest identity cut

Replace:

```text
ResolvedSubject { scheme, subject_id, ref: ResourceRef, detail }
```

with:

```text
ResolvedSubject =
  ResolvedResourceSubject {
    scheme: ResourceScheme,
    subject_id: UUID,
    ref: ResourceRef,
    detail
  }
  | ResolvedIdeaSubject {
    scheme: "idea",
    subject_id: UUID,
    idea_key: IdeaKey,
    display_title: str,
    user_id: UUID
  }
```

Required consequences:

- `run_build` never unconditionally casts an Idea to `ResourceScheme`.
- `visible_persisted_subject`, stored-subject authorization, title resolution,
  cleanup, and activation gain explicit Idea branches.
- `resource_graph.resolve` joins `artifact_idea_subjects` for Idea Artifact and
  Revision titles.
- Resource Dossiers retain current policy/readability rules.
- Idea read/generate authorization requires its owner User audience.
- The existing head columns and head-keyed SQL remain. Library-only consumers
  such as Dawn continue filtering `subject_scheme='library'`; regression-test
  them rather than rewriting them.

This is a typed engine identity refactor, not zero-cost reuse.

### 6.2 One build creator

Refactor the current internally committing `create_build` into one private locked
mutation and three public commands:

```text
bootstrap_resource_dossier(locator, requester, instruction, idempotency_key)
regenerate_artifact(artifact_ref, requester, instruction, idempotency_key)
learn_idea(highlight_ref, requester, idempotency_key)
```

All call the same private operation:

```text
ensure_build_locked(tx, artifact_id, requester, instruction, idempotency_key)
```

It owns:

- Artifact-head lock;
- existing terminal replay lookup;
- no-active-build check;
- build insert;
- background-job enqueue row.

It never commits. Each public command owns one serializable retry transaction,
calls the private mutation, records its command-specific terminal result, and
commits once.

Rules:

- No transport or Learn service directly inserts an Artifact head/build.
- Learn first reserves/replays its request and completes the memoized resolver.
  Its final transaction creates/finds the Idea subject + head, inserts the seed,
  calls the same locked build owner, and records the Learn terminal child.
- Learn derives the internal build replay key from `artifact_learn_request.id`;
  the user-supplied key remains scoped only to the Learn command.
- A same-Idea race reloads the unique winner.
- If a current revision or another active build exists, Learn returns `Opened`,
  never 409.
- Subject-scoped POST is bootstrap-only. An existing head returns
  `E_DOSSIER_ALREADY_EXISTS`; every regeneration uses the by-ref route.

## 7. Durable research workflow

### 7.1 Coordination machinery

The current engine exposes only one `synthesis` step. Extract its state
machine/codec from the job adapter, then generalize the job-payload coordination
map:

```text
DossierBuildRuntime {
  job
  execution_context
  llm_runtime
  read_step(path, replay_policy)
  checkpoint_step(path, result)
  yield_until(deadline)
}

ReplayPolicy = BilledOnce | ReDispatchable

DossierStepResult =
  NexusSearchResult | ResourceReadReceipt | WebSearchResult | PageAcceptResult |
  PageReadyResult | PageReadReceipt | SynthesisResult | DocumentRepairResult
```

Re-sign binding collection:

```text
collect(db, resolved, audience, runtime: DossierBuildRuntime)
```

Policies:

- `BilledOnce`: Idea resolution in the Learn store, plus synthesis and document
  repair in the build store. Commit `Uncertain` before dispatch; never
  auto-repeat an uncertain billed call.
- `ReDispatchable`: Nexus search, web search, URL acceptance, ready-state poll,
  local Resource read, and page read. Completed results are reused; an
  interrupted non-mutating call may redispatch.
- Keep the shared coordination state's string terminal envelope. Each Dossier
  step kind owns one strict JSON encoder/decoder for its `DossierStepResult`;
  unknown kinds/fields and malformed completed results fail closed. This does
  not alter Media Intelligence replay payloads.
- The build adapter checkpoints this state in the background-job payload. The
  Learn resolver adapter checkpoints the same owner-neutral state machine in
  `artifact_learn_requests.coordination`.

Stable Idea paths:

```text
research/nexus-search/0..2
research/nexus-read/0..5
research/web-search/0..2
research/page-accept/0..5
research/page-ready/0..5
research/page-read/0..5
synthesis
document-repair
```

Store bounded search metadata, canonical URL, read receipts, ResourceRefs, and
fingerprints in the job payload, never snippets or page bodies. On replay,
hydrate a completed receipt through the existing audience-checked Resource read
owner and require the recorded fingerprint before offering its text to
synthesis. Page ingestion pending causes yield/requeue; it never occupies a
worker polling.

### 7.2 Deterministic queries

There is no LLM research planner in v1. One pure owner derives the following
queries from `base = display_title + optional disambiguator`:

1. `base`;
2. `base explained`;
3. `base examples`.

Run the same bounded set against Nexus and web search. The owner can always
reconstruct it; only privacy-safe fingerprints persist.

- Nexus search calls the existing provider-neutral `services.search.search`
  core with the Idea owner as viewer and no conversation scope.
- Web search calls existing `search_web_readonly`.
- Research Resource reading composes the existing
  `resource_graph.resolve`/media-read cores behind one audience-checked adapter.
- Do not invoke chat-specific `execute_app_search`/`execute_read_resource`,
  fabricate conversation/message rows, or emit chat tool/retrieval events.

Search/result policy:

- At most six Nexus results per query.
- At most six web results per query, deduped by canonical URL/domain/rank.
- Application dedupes Nexus results by ResourceRef/provider rank and selects at
  most six total after filtering to readable citation-output sources.
- Application selects at most six web results by provider rank after dedupe.
- Fully read selected Nexus refs through the existing audience-checked
  Resource read owner.
- Web search returns opaque build-scoped `result_id`; no model chooses a URL.
- `web_page_read` accepts only a result ID produced by that build.

### 7.3 Page ingestion/read

Add one provider-neutral owner used by the Idea binding and a future agent adapter:

```text
web_page_read {result_id}
  -> {media_ref, title, content_fingerprint}
```

Contract:

- The runtime scopes the call to the current build; `build_id` is never a
  model-supplied argument.
- Resolve the exact stored URL for that build's `result_id`.
- Validate every redirect through existing SSRF/source-ingest policy.
- Call `accept_url_source(viewer_id, library_ids=[])`.
- Use deterministic build/result idempotency.
- Reuse canonical-URL dedupe and current Web Article ready/read owners.
- Hydrate `content_text` from that accepted ResourceRef after the read receipt;
  never persist the body in coordination.
- Persist `ingest_purpose: "artifact_research"` through accept payload, source
  attempt, job, worker, and Web Article preparation.
- `artifact_research` derives `extract_embeds=false`; the six-page bound is exact.
- Absolute await-ready deadline: ten minutes from acceptance.
- `justify-polling`: Web Article ingestion currently exposes durable ready state
  but no completion subscription. Requeue on the existing five-second job
  cadence; each observation is one `ReDispatchable` step and the ten-minute
  deadline terminates it.
- Gone, unsupported, unreadable, or SSRF-blocked pages are modeled omissions.
- Persistent transport/provider failure after retry exhaustion is a defect, not
  an omission (`justify-defect`: a required research dependency failed to
  establish its contracted result after exhausting its owned retry policy).
- Search snippets are discovery only and are never citation candidates.

### 7.4 Frozen evidence

1. Collect seed context and nearby notes.
2. Run bounded Nexus/web searches.
3. Fully read selected Nexus Resources and fetched Web Articles.
4. Freeze the typed evidence ledger.
5. Run tool-free synthesis over source text clearly delimited as untrusted data.
6. Recheck the frozen witness before promotion.

The research model receives no write/delete/user-credential/publication tools.
Publishing remains an engine-owned validated transition.

Input budget: 120,000 source-text characters. Idea synthesis:

```text
operation: dossier_idea
profile: balanced
reasoning: high
max_output_tokens: 12,000
```

Idea resolution:

```text
operation: dossier_idea_resolve
profile: fast
reasoning: low
max_output_tokens: 600
```

Add every operation to `BackgroundLlmOperation`, `OPERATION_PROFILES`, fixtures,
ledger checks, and profile validation in one cut.

## 8. Generated document acceptance

### 8.1 Model output

All eight bindings emit the same strict JSON shape:

```text
{
  content_html: "<article>...</article>",
  citations: [{
    ordinal: positive_int,
    candidate_index: non_negative_int,
    role: "context" | "supports" | "contradicts"
  }]
}
```

No binding emits Markdown. No alternate body field survives.

The provider-compatible envelope schema and decoder require exact top-level
keys, a string `content_html`, a list `citations`, exact-key citation objects,
and the JSON scalar types of every citation field. Provider/envelope shape or
type failures use the one document-repair attempt and ultimately classify as
`DocumentValidationFailed`. The strict citation materializer owns semantic
validity—positive/contiguous ordinals, non-negative in-range candidate indices,
the closed role union, visibility, and exact DOM-token parity. Those failures
classify as `CitationValidationFailed`.

### 8.2 WHATWG parsing and mXSS boundary

`services/artifacts/document_html.py`:

1. parses with `html5lib.parseFragment`; never lxml;
2. requires exactly one top-level `article`;
3. validates a positive element/attribute/class grammar;
4. canonical-serializes with html5lib;
5. parses the serialized fragment again;
6. rejects unless the two accepted trees are structurally equivalent;
7. returns the accepted canonical fragment plus citation-token ordinals.

After document acceptance, the strict citation materializer validates the JSON
citations, candidate visibility, and exact token/ordinal parity. Only then does
the trusted compiler replace tokens with app-owned controls and derive
`content_text`. Compiled controls are trusted runtime markup, not model content,
and are not fed back through the model allowlist. Serialize/reparse the compiled
tree once more against a separate exact trusted-control grammar; that canonical
result is `content_html`.

Model output cannot contain raw-text/document-head elements; reject:

```text
html head title style script meta link base
```

Also reject:

```text
a img iframe form input button object embed svg math template
event attributes style hidden inert role aria-* data-* (except citation token)
comments doctypes processing instructions namespaces URLs
```

Allowed elements:

```text
article section header h2 h3 h4
p ol ul li dl dt dd blockquote pre code em strong
table thead tbody tr th td figure figcaption div span cite
```

`h1` is rejected: the pane/frame title comes only from the trusted Idea/Resource
identity. Model sections begin at `h2`.

Allowed attributes:

- `article`: no model attributes.
- `section`: required unique `id`.
- table semantics: `scope`, `colspan`, `rowspan`.
- exact empty citation token:
  `<cite data-nexus-citation="N"></cite>`.
- closed Nexus classes only:
  `dossier-lede`, `dossier-definition`, `dossier-example`,
  `dossier-warning`, `dossier-steps`, `dossier-diagram`, `dossier-muted`.

ID/class token grammar: `[a-z][a-z0-9-]{0,63}`.

`cite` is reserved for that exact empty token. Bare `<cite>`, child content, or
any other `cite` attribute is rejected.

`scope` is exactly `row | col`. `colspan`/`rowspan` are canonical decimal
integers in `1..16`.

Hard quotas:

- serialized UTF-8: 160,000 bytes;
- DOM nodes: 4,000;
- DOM depth: 24;
- attributes per element: 8;
- citation tokens: 256.

Security tests include raw-text breakout strings, foster parenting, malformed
tables, duplicate attributes, namespace transitions, comments, entity confusion,
double-parse divergence, and every rejected element/attribute.

No `tinycss2` dependency is required because model CSS is forbidden.

### 8.3 Citations

Replace tolerant `materialize_standard` behavior with one shared strict
materializer for all eight bindings:

- unknown candidate index: fail;
- duplicate/non-contiguous ordinal: fail;
- unknown role: fail;
- zero materialized citations: fail;
- audience-invisible target: `InputsChanged`;
- never drop, renumber, or coerce.

The acceptor replaces each valid empty citation token with the app-owned
focusable citation control only after strict materialization succeeds. It has an
accessible label, visible focus, keyboard activation, reserved styling, and a
non-navigating failure state. Token ordinals and materialized citation ordinals
must be an exact one-to-one set.

The compiled form is exact:

```html
<button type="button" class="dossier-citation"
  data-nexus-citation="N" aria-label="Open citation N"><sup>N</sup></button>
```

Only the trusted compiler may emit `button`, `sup`, that class, and those
attributes; `N` is the validated canonical decimal ordinal.

### 8.4 One repair, then fail

After the first complete synthesis:

1. decode the exact provider-compatible envelope, including citation JSON
   scalar types;
2. validate the document;
3. if envelope/document validation fails, run exactly one memoized tool-free
   `document-repair` step with validator diagnostics and the frozen evidence;
4. validate again;
5. recheck the frozen witness; terminalize `InputsChanged` if it changed;
6. with an unchanged witness, terminalize `DocumentValidationFailed` if the
   document is still invalid;
7. validate/materialize citations; terminalize `CitationValidationFailed` on
   any semantic range, membership, visibility, or DOM-token mismatch, without
   repair.
8. compile trusted citation controls, derive text, and publish atomically.

This retries the same final contract; it is not a fallback renderer/format.

Failure precedence after provider success:

1. witness changed → `InputsChanged`;
2. unchanged witness + document invalid after repair →
   `DocumentValidationFailed`;
3. accepted document + invalid citation contract →
   `CitationValidationFailed`.

The final closed `DossierBuildFailureCode` union is:

```text
NoSourceMaterial | InputsChanged | DependencyProjectionFailed |
EntitlementDenied | BudgetExceeded | ContextTooLarge | ProviderRefused |
ProviderIncomplete | DocumentValidationFailed | CitationValidationFailed
```

`DocumentValidationFailed` replaces `SchemaRepairExhausted`.
`MigratedFailure`/`MigratedIncomplete` disappear because the migration deletes
every old build. Update DB/event/API/frontend unions, precedence tests, and the
prior Dossier spec in the same cut.

### 8.5 Runtime frame

`DossierDocumentFrame` constructs the full runtime document from trusted parts:

1. trusted `<html lang>` plus current Nexus theme class;
2. CSP meta as the first `head` child;
3. escaped server-owned title;
4. Nexus-owned theme-aware stylesheet with fresh nonce;
5. fixed citation bridge with the same fresh nonce;
6. accepted stored `article` fragment.

`DossierSurface` retains the existing `MachineText` origin/signature outside the
frame. Extend the Machine Hand owner with one sealed
`machineDocumentStyles(theme: "light" | "dark")` contract for the iframe; it
returns only pre-authored CSS and accepts no model/document values.
`DossierDocumentFrame` consumes that contract and never references or duplicates
Machine Hand tokens itself. Update the Machine Hand ownership guard accordingly.

Exact CSP template:

```text
default-src 'none';
script-src 'nonce-{NONCE}';
style-src 'nonce-{NONCE}';
img-src 'none';
connect-src 'none';
font-src 'none';
media-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none'
```

Frame/runtime rules:

- `sandbox` is exactly `allow-scripts`.
- Never add `allow-same-origin`, forms, popups, downloads, storage, modals, or
  navigation capabilities.
- Nonce/channel are at least 128 random bits and never persisted.
- Opaque-origin bridge posts with `targetOrigin: "*"`.
- Parent accepts only exact `contentWindow` + channel token + discriminated
  `{kind: "Citation", ordinal}`.
- Parent resolves the ordinal through the server-supplied revision citations.
- `event.origin` is not trusted.
- Coverage/provenance/pane controls remain outside the iframe.
- The iframe owns its scrollport and has a descriptive title.
- The escaped title and fixed stylesheet/bridge are the only raw-text bodies.
  Unit-test their emitters case-insensitively against `</title`, `</style`,
  `</script`, `<!--`, and `]]>` as applicable; no request/model value enters the
  stylesheet or script strings.

Delete `Delta` from `ArtifactBuildEventType`, DB CHECK, SSE emission, frontend
event decoder, controller, and tests. The UI shows progress only and never inserts
partial/rejected HTML into `srcdoc`. A provider may stream internally, but no
chunk is persisted, emitted as an Artifact event, or rendered.

Do not reuse or widen Web Article `HtmlRenderer`/sanitization.

## 9. API contract

All bodies/responses are strict and use discriminated unions / `Presence`.

### 9.1 Learn

```http
POST /artifacts/dossiers/learn
Idempotency-Key: <required, 1..128>

{"highlight_ref":"highlight:<uuid>"}
```

```text
LearnDossierOut =
  { kind: "Opened", artifact_ref }
  | { kind: "BuildAccepted", artifact_ref, build_handle }
```

- Return HTTP 200 for either terminal command outcome; the build remains
  asynchronous. Replay returns the same status/body.
- No redundant `href`.
- `E_DOSSIER_IDEA_UNRESOLVED` is a named 422 error.
- `E_DOSSIER_ALREADY_EXISTS` is the named 409 for Resource bootstrap against an
  existing head.
- Missing/forbidden Highlight remains masked not-found.
- Same-key payload mismatch is existing 409.
- Active/current build races return `Opened`.

Hard-cut every Dossier build `Idempotency-Key` route from 256 to 128 characters.

### 9.2 Artifact reads/builds

```http
GET  /artifacts/{artifact_ref}
POST /artifacts/{artifact_ref}/builds
GET  /artifacts/{artifact_ref}/revisions
GET  /artifact-revisions/{artifact_revision_ref}
POST /artifact-revisions/{artifact_revision_ref}/make-current
POST /artifact-builds/{build_handle}/cancel
GET  /stream/artifact-builds/{build_handle}/events
```

- `GET /artifacts/{ref}` is the canonical authorized head/current read.
- Resource Artifact: require audience authorization plus current underlying
  subject readability, matching `assert_build_viewer`.
- Idea Artifact: require owner User audience.
- `POST /artifacts/{ref}/builds` is the sole regeneration route.
- Existing subject-scoped POST is bootstrap-only and conflicts once a head exists.
- Subject-scoped GET remains Resource Companion lookup.
- BFF routes are transport-only.

### 9.3 Public head identity

`DossierHeadOut.identity`:

```text
Presence<
  { kind: "Resource", title, activation: ResourceActivationOut }
  | { kind: "Idea", title }
>
```

Never expose `idea_key`, Idea subject UUID, private contributor UUID, or stored
subject columns.

## 10. Capability, routing, and recovery

Capability truth:

- `artifact`: Linkable; CopyOnly-shareable; attachable; generated-output chat;
  readable; revision-expandable; not a citation-output source.
- `artifact_revision`: Linkable; not shareable; attachable; generated-output
  chat; readable; citation-output source.

Routing:

- Generic Artifact activation → `/artifacts/{artifact_ref}`.
- Generic Revision activation →
  `/artifacts/{artifact_ref}?revision={artifact_revision_ref}`.
- Artifact route declares `queryNavigation: "in-place"`.
- Pane resource identity/dedupe is Artifact ref, independent of revision query.
- `paneResourceLocator` gains Artifact.
- `?revision=` resolves through existing
  `GET /artifact-revisions/{artifact_revision_ref}`.
- The resolved revision must belong to the path Artifact; mismatch is masked
  not-found.
- Resource Companion-local history/revision viewing remains inside
  `useResourceInspector`; only generic ref activation redirects standalone.

Recovery:

- Re-Learn from the saved Highlight is the primary v1 recovery path.
- Existing workspace/history may also retain the pane.
- Do not claim Highlight Connections recovery; Highlight has no Inspector.
- No Dossiers index, Library entry, or app-search result in this cut.

## 11. Migration and hard deletion

Migration order:

1. Stop workers at the cutover boundary.
2. Revoke/delete queued/running `dossier_build` background-job rows.
3. Delete `resource_view_states` referencing Artifact Revision surfaces or
   citation edges that will be deleted.
4. Delete edges sourced from/targeting `artifact_revision`.
5. Null every Artifact head `current_revision_id`.
6. Delete Artifact-build LLM calls, build events, failure/cancellation children,
   revisions, and builds in owner order.
7. Preserve Artifact heads, Artifact-head user Links, IDs, audience, and
   `uq_artifacts_subject_audience`.
8. Add nullable `content_html`/`content_text`, assert the revision table is
   empty, set both `NOT NULL`, then drop `content_md`. No compatibility backfill
   exists.
9. Create Idea/resolution/seed/Learn-replay tables—including the nullable
   resolver-owner lease—and final constraints.
10. Widen closed DB/typed unions and event checks; remove `Delta`.
11. Deploy backend and frontend as one contract.

For every surviving table alteration: add nullable → backfill → assert complete →
set `NOT NULL` → remove temporary/default machinery. Never introduce a dual-read
period.

Add these expected first-sight race constraints to
`RETRYABLE_UNIQUE_CONSTRAINTS`:

```text
uq_artifact_idea_subjects_owner_key
artifact_idea_resolutions_pkey
uq_artifact_idea_seeds_pair
uq_artifact_learn_requests_user_key
```

Keep `uq_artifacts_subject_audience` in the allowlist unchanged.

Delete:

- all Dossier `content_md` prompts, schemas, serializers, fixtures, tests, and
  MachineText body rendering;
- `Delta` event/decoder/controller branches;
- tolerant citation materialization;
- `SchemaRepairExhausted`, `MigratedFailure`, and `MigratedIncomplete` failure
  branches/support;
- Artifact ref activation through subject Companion;
- exact-seven binding guards/enumerations;
- 256-character Dossier idempotency bounds;
- compatibility readers/writers and superseded documentation.

Keep unchanged:

- Artifact head/build/revision/history lifecycle;
- Web Article `HtmlRenderer` and sanitizer;
- generic resource chat/read;
- Resource Graph citation ownership;
- workspace activation semantics;
- Dawn's Library-Dossier query shape (regression-test only).

## 12. Ownership and files

Expected owners; do not create parallel abstractions.

### Backend

- `migrations/alembic/versions/0198_*.py`
- `python/nexus/db/{models,retries}.py`
- `python/nexus/errors.py`
- `python/nexus/schemas/artifact.py`
- `python/nexus/api/routes/dossiers.py`
- `python/nexus/services/highlights.py`
- `python/nexus/services/llm_{profiles,ledger}.py`
- `python/nexus/services/artifacts/{definition,dossier_types,coordination,engine,manifests,revisions,subject_policy}.py`
- `python/nexus/services/artifacts/bindings/{base,__init__,_shared,_notes_shared,conversation,contributor,library,media,note_block,page,podcast,idea}.py`
- new `python/nexus/services/artifacts/{learn,idea_identity,idea_seeds,research,document_html}.py`
- new `python/nexus/services/agent_tools/web_page_read.py`; existing
  `agent_tools/web_search.py` only if the provider-neutral search result contract
  must be extracted without changing chat behavior
- `python/nexus/services/{media_source_ingest,web_article_ingest}.py`
- `python/nexus/services/resource_items/{routing,capabilities,chat_subjects}.py`
- `python/nexus/services/resource_graph/{resolve,cleanup}.py`
- `python/nexus/services/search/retrievers/{conversations,resource_metadata}.py`
- `python/nexus/tasks/artifacts.py`
- `python/nexus/jobs/{registry,queue}.py` only where multi-step yield/replay changes
- tests under `python/tests/` for API, lifecycle, bindings, failure precedence,
  durable execution, retry races, read/resolve/routing, ingest, HTML security,
  cleanup, User deletion, and Dawn regression

`python/nexus/services/dawn_write.py` should need no implementation change because
the head columns survive; its Library-only query is a required regression gate.

### Frontend

- `apps/web/src/components/SelectionPopover.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/highlights/highlightActions.tsx` and tests
- `apps/web/src/components/dossier/{DossierSurface,DossierDocumentFrame}.*`
- `apps/web/src/components/ui/MachineText.*`
- `apps/web/src/lib/ui/machineHandCutover.guards.test.ts`
- `apps/web/src/lib/dossiers/{dossierControllerTypes,dossierControllerStore,dossierWire,eventDecoder,generationAdapter,dossierViewModel,dossierErrorMessage,useResourceInspector}.ts`
- `apps/web/src/lib/resources/{activation,resourceCapabilities}.ts`
- `apps/web/src/lib/panes/{paneRouteModel,paneRouteTable,paneRenderRegistry,paneResourceLocator}.ts*`
- `apps/web/src/components/ui/{ReaderCitation,ResourceActivation}.tsx`
- `apps/web/src/components/chat/MessageSourcesDisclosure.tsx`
- `apps/web/src/app/(authenticated)/artifacts/[artifactRef]/page.tsx`
- BFF routes under `apps/web/src/app/api/artifacts/`
- focused component/route/capability/activation/security tests

Delete the superseded `Delta` event decoder and `content_md` wire-decoder branches;
do not retain two body/event shapes.

### Docs

- `docs/architecture.md`
- `docs/modules/{highlight,workspace,chat,library,jobs,llms,reader-implementation}.md`
- `docs/cutovers/resource-inspector-and-universal-dossiers-hard-cutover.md`
- `docs/cutovers/machine-hand-hard-cutover.md`

Update every literal seven-binding enumeration, output/body clause, activation
clause, failure union/precedence, route contract, and owner table.

## 13. Implementation order

1. Domain/migration RED tests: Idea, Learn replay, cleanup, failure/event unions.
2. Engine identity/build refactor and by-ref authorization/API.
3. Universal strict citation + HTML fragment output cut for all eight bindings.
4. Document acceptor, fixed stylesheet, frame, and security/browser tests.
5. Multi-step coordination and bounded research ingestion/read.
6. Idea resolver/binding/manifest/coverage.
7. Learn selection action, feedback, Adopt, Artifact pane/route.
8. Hard-delete old paths; update canonical docs.
9. Run the exact focused static, migration, integration, component, browser,
   and cutover-residue gates named by this change. Broad suites and real-stack
   E2E are outside this one-user prototype cut.

Do not ship a mixed checkpoint. The final HTML/API/event/route contract becomes
the only runtime contract in one deployment.

## 14. Acceptance criteria

### Product

- Learn creates/reuses a Highlight, closes the selection popover normally, uses
  global feedback, and adopts one standalone Artifact pane.
- Same exact Idea key from different Highlights opens the same Artifact.
- Ambiguous ideas receive distinct exact keys; unresolved resolution fails 422.
- Re-Learn adds context without auto-regeneration, false Stale copy, or killing
  an active build.
- Regenerate publishes one immutable replacement revision.
- Chat uses existing Artifact chat/read and receives `content_text`.

### Identity/concurrency

- No `subject_key` column exists; current Artifact head columns/unique constraint
  remain.
- Resource and Idea `ResolvedSubject` branches authorize correctly.
- Learn replay detects payload mismatch and returns its exact recorded outcome.
- Same-Idea races return the unique winner; active/current build races return
  `Opened`.
- One locked engine mutation owns every build creation path.
- Seed growth is excluded from the current build witness.

### Research

- Completed search/page steps survive every five-second requeue and worker crash.
- No billed-once uncertain step auto-redispatches.
- Queries are deterministic; raw queries are not persisted.
- Page-read accepts only build-scoped search result IDs.
- Fetch uses `accept_url_source(..., library_ids=[])`.
- Research ingest persists its purpose and creates no embedded child attempts.
- Pending ingestion yields and ends at the ten-minute deadline.
- Search snippets are never evidence/citations.
- Transport/provider exhaustion is a defect; modeled content omissions are exact.

### HTML/security

- All eight bindings persist only `content_html`/`content_text`.
- `html5lib` owns parse/serialize/reparse; lxml is not used.
- Model head/title/style/CSS/URL/active-content input is rejected.
- mXSS corpus, namespace, malformed-table, double-parse, quota, and citation
  negative tests pass.
- Strict citations never drop, renumber, or coerce.
- One repair is replay-safe; second failure becomes `DocumentValidationFailed`.
- Frame CSP is first, nonce-bound, exact; sandbox is exactly `allow-scripts`.
- Frame typography comes only from the extended Machine Hand owner and follows
  the active Nexus light/dark theme.
- Partial/rejected HTML and raw deltas never enter `srcdoc`.
- Bridge validates exact window + 128-bit channel + payload.

### API/routing/capabilities

- Subject POST is bootstrap-only; by-ref POST is sole Regenerate.
- By-ref Resource read checks audience plus underlying readability; Idea checks
  owner audience.
- `LearnDossierOut` has no `href`; key bounds are 128.
- Artifact and Revision capabilities retain their distinct contracts.
- Artifact route/revision query dedupe to one in-place pane.
- Generic ref activation opens standalone; Companion-local revision viewing
  remains local.

### Migration/regression

- Background builds/view states/revision edges are removed in safe FK order.
- Artifact heads/head Links survive; old revisions/builds/Markdown do not.
- Retry allowlist contains every named first-sight race constraint.
- Highlight/User/Artifact deletion cleans new rows explicitly.
- Seven existing Resource Dossiers retain activation, generation, freshness,
  search text, chat/read, cleanup, authorization, and history behavior.
- Dawn Library Dossier query remains correct.
- No Dossier `content_md`, Dossier-build `Delta`, tolerant Dossier citation
  materializer, exact-seven Dossier-binding guard, compatibility decoder, or
  legacy Artifact activation remains in live code/tests/docs.
