# aligned reader apparatus

status: implemented; bounded acceptance and open checks in [verification](reader-source-notes-verification.md)
origin: 2026-09-26 council and owner clarification
baseline: `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`; recheck owners before editing
authority: supersedes presentation proposals in [the research review](reader-source-notes-council.md).

## goal, scope, final shape

an arden-like reader for mixed books and essays.

- **narrow document bar:** whole-document positions, sections, counted clusters,
  quick previews and deliberate navigation.
- **existing evidence pane, `resource-evidence`:** aligned highlights, personal
  notes, source citations, footnotes/endnotes, links, synapses and full detail.
  delete the separate `MarginRail`; existing inspector layout reserves width.

scope: hosted web/epub rich notes, current native-pdf citation coverage, desktop
alignment, existing compact sheet, evidenced extraction repairs and safe enrichment.

non-goals: general pdf/ocr/ai extraction, external citation enrichment, publisher
css, source-note annotation, new tabs/preferences, offline apparatus packaging,
broad navigation redesign, permanent test infrastructure. preserve existing
highlight/link editors and save owners.

## target behavior and designer-owned content

each package has a paired designer. designers define examples before code and
inspect rendered results; schema validity alone does not establish good content.

| feature / designer | contract |
|---|---|
| source content / editorial | preserve wording, paragraphs, verse breaks, emphasis, lists, links, supported tables/images and super/subscripts. show source label/kind; unknown attribution is “source note.” no generated substitutions or guessed author/editor |
| note disclosure / reading | show complete content when its height fits six computed text-line heights, including images/tables. otherwise show a source-derived opening and `read full note`. collapsed previews expose only visible, noninteractive text/thumbnail to accessibility; image-only notes retain a thumbnail or source alt/label. full detail uses the pane's single scrollbar |
| references / editorial | display all ordered targets and their count. repeated references share a body but retain distinct openers. source text is selectable; links have independent controls |
| annotations / interaction | existing authoring/actions remain; source notes are read-only. personal and generated material retain distinct provenance |
| bar / information | hover/focus/tap previews; `go to passage` explicitly navigates/selects. escape/dismiss preserves position. global markers do not depend on the mounted chapter; previews contain no editor |
| absence/compact / accessibility | `note text unavailable`; `view in source` if a location exists. body/location availability are independent. keyboard/touch disclosure and dismissal return focus to the actual opener |

unsupported structure, including arbitrary math markup, must not silently become
flattened “equivalent” content. preserve supported representations; otherwise
expose unavailable content and source access.

### alignment and interaction

- respect existing inspector visibility/remembered tabs. desktop evidence follows
  reading by default. activating a source marker opens its full content in the
  pane without moving the document; `view in source` is a separate excursion.
- one `follow | browse` state; same rows/actions and existing scopes/filters.
  `all items` exposes the complete inventory, including unplaced facts.
  `follow text` resumes alignment. compact sheets use browse.
- follow projects visible passage groups in source order, retaining every fact at
  a referent. reset ONLY the pane-list scroll offset to zero on entering follow.
  desired y = referent screen y − pane-list screen y; stack using
  `max(0, desiredY, previousBottom + gap)` and measured heights. remeasure after
  typography/assets, resize, chapter changes and pdf transforms.
- retain overflow in the pane's scrollable extent with a visible remaining count.
  remove the 24-item cap and height-based dropping. preserve correspondence with
  labels and reciprocal emphasis; exact alignment yields under collision.
- pane scrolling, selection, expansion/editing, marker activation and
  `read full note` enter browse BEFORE follow can move content. browse renders
  the complete filtered inventory, preserving the inspected row's keyed dom node,
  pixel offset, selection and editor state by adjusting only pane scroll.
  source scrolling must not unmount active content. only `follow text` resumes.
- explicit activation reveals a filtered-out occurrence temporarily without
  changing filter choices; retire that reveal on next selection/resumption.
- opening/closing/reading pane content never changes cursor, completion or
  activity. excursion return/adoption belongs to the existing navigation owner.

## schema, api and composition

reuse apparatus items/edges. add nullable `body_html_sanitized text` to
`reader_apparatus_items`; existing `body_text` becomes derived search/citation
text with block boundaries. markers have no target body. existing sanitizers,
epub link/asset rewriting and `HtmlRenderer` remain the content boundary.

hard-change existing `GET /media/{id}/document-map`:

```text
SourceContent =
  Html { html_sanitized: string, text: string }
  | Text { text: string }
  | Unavailable

evidence.source_targets: SourceTarget[]   // unique by resource ref
SourceTarget:
  ref, stable_key, apparatus_kind, label, activation, resolution // existing types
  content: SourceContent

SourceReference:
  ...existing occurrence fields
  marker_anchor_id: Presence<string>  // authored marker id; absent if none
  target_refs: resource_ref[]             // ordered; replaces embedded targets
```

`Html` means supported sanitized web/epub content; `Text` means native pdf text.
failed extraction never falls back between variants. historical unrecoverable
rich bodies become `Unavailable`. source excerpts and bar previews derive ONLY
from this union plus labels; archived `body_text` cannot bypass it.

every target ref resolves once within the response. a standalone note can point
to its own body in this projection without creating a graph edge/referent; align
only to its own real location. retain existing confidence and availability types.
malformed internal payloads are defects.

one response owns each body, avoiding repeated rich content and per-target request
state. no new endpoint/cache/service. python projection and strict typescript
decoder cut over together; delete old string-body/embedded-target decoding.

internal activation carries `{occurrenceItemId, targetRef}`, with an explicit
absent opener for independently opened targets. never infer an occurrence from a
shared target key.
an authored source backlink returns only when its fragment and anchor id match
the held occurrence's source locator and `marker_anchor_id`; a copied canonical
text backlink compares its exact fragment and offset range. other links inspect.

composition: acquisition → apparatus extraction/storage → document-map composition
→ evidence presentation; the existing projector supplies live text/pdf geometry.
integration passes current media/publication identity, content ref and measurement
key. retain repeatable-read API snapshots and publication fences; reject stale
responses. pane copies stay outside the canonical text root. resolve destinations
before removing/scoping copied dom ids; do not create duplicate ids or anchors.

## extraction, identity, cutover

1. preserve note evidence before readability removes it. retain the current
   capture packet shape and immutable stored bytes; extend existing `source_html`
   with note subtrees alongside embed evidence. the existing 64 kib evidence bound
   rejects overflow with `E_RESOURCE_LIMIT`; never silently truncate.
2. repair wikisource reference removal and same-document fragment urls at the
   shared acquisition owners. extend `html_apparatus.py` for the evidenced
   evidenced pillow/augustine/montaigne note shapes:
   require reciprocal links AND bounded note-group/body evidence. ordinary
   numbered entries/navigation must not become notes.
3. keep item uuids and opaque stable keys. stop using ordinal as identity.
   typed `source_ref` identity records source document plus unique authored id;
   anonymous occurrences use artifact digest and structural address. changed
   anonymous sources require unique exact quote/context and target correspondence.
   unmatched new occurrences get new opaque keys.
4. reject publication if unresolved correspondence would delete/retarget a
   durably referenced item. keep the previous publication atomically; require
   deliberate repair. no alias/tombstone framework or destructive reconciliation.
5. inventory/back up affected data. enrich rows IN PLACE from stamped current
   fragments or retained originals with exact correspondence. preserve ids,
   graph edges, fragment bytes and offsets; atomically advance existing publication
   generation through `reader_publication.py`. no refetch/blanket reimport.
   missing captured content requires recapture. retain old text as data, not a
   runtime fallback.
6. coordinate schema/server/client cutover; incompatible clients reload. no flags,
   dual decoders or alternative parser paths. rollback needs the data backup or
   forward repair; code revert alone is insufficient.
7. delete `MarginRail.*`, its route mount, margin-only tokens, caps/excerpt
   builders, first-target-only previews and duplicate source-body disclosures.
   move only genuinely shared projection/stacking helpers into evidence ownership.
   retain the overview bar and existing inspector controls.
8. **navigation prerequisite:** consume
   [the shared navigation cutover](reader-reversible-navigation-plan.md) before a4.
   its integrator exclusively owns `MediaPaneBody.tsx` while active; this plan's
   package d follows it and consumes its inspect/return actions. do not implement
   a second lifetime correction. copied evidence-pane content records no activity;
   canonical-document excursions may count duration only under that contract.

## non-overlapping packages

`P` = `python/nexus/services`; `S` = `python/nexus/schemas`;
frontend paths are under `apps/web/src`. agree contracts first. one editor per
file; each package gets its named designer and an independent adversarial reviewer.

| package / designer | exclusive files and ownership |
|---|---|
| a: source/data / editorial | `S/{reader_apparatus,reader_document_map,extension_capture}.py`; `P/{reader_apparatus,reader_evidence,reader_evidence_markers,reader_document_map,reader_publication,html_apparatus,web_article_structure,web_article_ingest,media_source_adapters,epub_ingest,pdf_ingest}.py`; existing sanitizers, migration; `node/ingest/article_extraction.mjs`; `extension/{content,captureContract}.ts`. source content, identity, publication |
| b: content / reading | `lib/reader/documentMap.ts`; `components/reader/document-map/EvidenceItemRow.tsx`; shared source-content renderer using `HtmlRenderer`. typed bodies, all targets, full/preview content |
| c: placement / interaction | `components/reader/document-map/EvidencePaneSurface.tsx` and its stylesheet; `components/reader/useAnchoredReaderProjection.ts`; evidence placement helper; remove `MarginRail.*` and move shared `lib/reader/marginItems.ts` helpers. follow/browse, geometry, stable selection/editing |
| d: integration / navigation-accessibility | `app/(authenticated)/media/[id]/MediaPaneBody.tsx` and css; `components/reader/{ReaderDocumentMapOverviewRail,ReaderDocumentMapDestination,ReaderDocumentMapPopup}.tsx`; margin-only `app/globals.css` tokens. sole route integrator; inspector, occurrence actions, shared navigation dependency |
| e: acceptance / content-accessibility | temporary real-stack proof, independent review, rendered-content review, completion receipt and ticket closure |

c owns the shared evidence stylesheet; b requests changes through c and updates
its own anchor-helper imports. d consumes the completed navigation-owner contract;
nobody creates a parallel implementation. update module docs and resolve only
proven tickets from [the research index](reader-source-notes-council.md#observed-defects-and-repair-constraints).

## acceptance and temporary red / green / refactor

the owner's request authorizes temporary executable live tests. `./scripts/test`
and ci remain static-only. use isolated real services/auth and task-owned data;
no mocks, auth bypasses, production fixtures or new permanent harness.

| case | required observable result |
|---|---|
| a1: acquisition/fidelity | real epub import and article url/capture preserve paragraphs, verse, emphasis, links, images and all targets. cover image-only notes, preview-boundary links, wikisource, absolute fragment urls and recorded untyped editions; unavailable exact editions are blocked evidence |
| a2: ownership/alignment | one overview bar/one evidence pane; unconstrained alignment, including after browsing then resuming. dense/long notes remain accessible without overlap; all earlier/later/unplaced facts remain browsable |
| a3: stable interaction | expand/select/copy/edit existing highlight/link notes; scroll text, resize and enlarge type. follow pauses; selection/caret/save identity survive. keyboard/touch preview dismisses without navigation; `go to passage` navigates; sheet returns focus |
| a4: occurrences/return | cross-chapter repeat references and multi-target markers open every correct target, including filtered-out occurrences. after a canonical-document excursion, return reaches its actual opener. copied pane inspection changes no cursor/completion/activity; canonical inspection may count duration only, never progress or skipped-word traversal |
| a5: data safety | in-place enrichment advances generation while ids/bytes/highlights/links survive; obsolete responses are rejected. insertion of an earlier marker preserves old identities. ambiguous referenced correspondence rejects atomically |
| a6: coverage/provenance | supported native pdf displays faithful text at current zoom/rotation; unsupported pdf/missing bodies remain honest. source/personal/generated content stays distinct; existing saving and global section/marker overview still work |

**red:** reviewers challenge specification, content examples and source-based
assertions first. prove setup works, then record baseline target failures;
existing correct behavior may pass. setup failure is not red.

**green:** implement by owner; replay identical cases and `./scripts/test`.
designers inspect rendered examples, keyboard/screen-reader behavior and android
webview touch. viewport simulation is not device acceptance.

**refactor:** independently review ownership, duplication, dead paths, fidelity
and invariants; fix objections and rerun affected journeys/static checks.
after acceptance passes, delete owned probes, fixtures/imports, credentials and
test-only dependencies. retain baseline/final sha, commands, source hashes,
red/green outcomes, device identity and limits; run final `./scripts/test`.

done requires all mandatory cases passing, review objections resolved, obsolete
paths/tests removed, docs updated and unresolved outside-scope findings ticketed.
blocked cases are not acceptance. preserve unrelated workspace changes.

spec review: architecture, source/data and content/accessibility reviewers cleared
their concrete findings after revision. this establishes plan readiness, not runtime acceptance.

## explicit trade-offs

collision displaces notes; long notes need expansion; compact sheets cover context.
canonical source notes remain in place, permitting duplicate visual access.
normalized bodies enlarge the initial response but avoid request/cache machinery;
measure actual dense-book payloads before adding complexity. ambiguous refresh
needs repair; lost captured content needs recapture; evidence-budget overflow
fails capture explicitly. unsupported content/general pdfs require source access;
offline remains separate. deleting tests relinquishes ongoing regression detection.
