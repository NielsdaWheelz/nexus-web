# the 57 deferred book repairs

status: implementation in progress; final rehearsal, deployment and live repairs
are pending. source proofs use the verified `f4026846f857fd137e9c9e170faba05f07c5e282`
/ `0287` snapshot. deploy only as a forward release on the separately accepted
wire-10 / `0292` runtime; that release is still pending.

scope authority: the [exact inventory](tickets/reader-source-notes-production-repair-pending.md)
and its three immutable source-review ledgers; the [completed campaign](book-repair-plan.md)
remains closed. planning source: `6f23e90d4d41e923d6c900b2c20dc1f902833722`.
public web/api identity checked during planning: `f4026846f857fd137e9c9e170faba05f07c5e282`,
database `0287`. these are observations, not authority for a later live mutation.

## outcome and boundary

resolve exactly 57 ids: 40 navigation, 14 note-content/link, three navigation-source
selection. each needs a corrected, source-verified repair or a source-proved
no-change outcome. no-change needs source proof that the installed result is correct
and each recorded counterexample is resolved, not merely an empty diff. refusal,
deleted/unavailable source and failed consumer proof do not count as completion.
verified books may proceed independently; remaining cases stay open with evidence.

the 168 accepted repairs are not repeated. the 265 unchanged, five source-unproved,
four deleted and 235 unmatched contributor dispositions are not another apply set.
frankenstein's accepted credit repair is preserved; its navigation case is in the
57. portrait recovery and its separately deferred metadata are outside this work.

non-goals: new reader ui, universal metadata research, source-text rewriting,
reacquisition, identity migration, an epub conformance engine, offline evidence
parity, provider work, global canonicalizer optimization, deployment-tool rewrite,
migration squash, host resize/reboot or unrelated feature releases.

## owner decisions

| decision | recommendation and consequence | state |
| --- | --- | --- |
| a proved destination has unproved parentage or extent | retain the destination; use null for the unproved section parent/extent. outlines may be flatter. do not discard proved structure merely to obtain a passing diff | accepted by owner |
| frankenstein's older-account consumer access | carry the explicit exception into this navigation repair: source/database/rehearsal proof required; live web/phone check remains unresolved until legitimate login is available. this never becomes a consumer pass | accepted by owner |
| nine essays notes have historically reordered retained paragraphs | correct the note body to verified original order; locate the complete corresponding retained paragraph by authored identity. view in source retains the old order. preserve reader text and saved coordinates | accepted by owner |

all other choices below are engineering decisions. implementation must not
silently choose a stricter or weaker definition of completion.

## content contract

three concepts remain independent: publisher contents describe destinations and
their authored hierarchy; routine sections describe reading divisions; note
relations identify a reference and its complete ancillary content. a link does
not establish an extent. a file boundary or heading rank does not establish a
book-wide parent. reciprocity does not establish which endpoint is the note.

[epub navigation](https://www.w3.org/TR/epub-33/#sec-nav-toc) separates contents,
landmarks and page lists; [opf guide roles](https://idpf.org/epub/20/spec/OPF_2.0_latest.htm#Section2.6)
identify additional destinations. [note and backlink semantics](https://www.w3.org/TR/epub-ssv-11/#noteref)
distinguish their directions. the inference rules below are nexus product policy,
not claims that those standards prove arbitrary literary boundaries.

before coding, each lane has a content designer and an adversarial reviewer.
the designer prepares source-derived expected examples; the implementer does not
use its own parser output as the oracle. no generated replacement prose or labels.

| feature / designer | good content and minimum contrast examples |
| --- | --- |
| package navigation / digital-publishing designer | preserve authored labels, order, nesting and safe destinations; contents, landmarks and page lists stay separate. all three ncx-only cases; landmarks at `211dd5d1` and `a632754f`; valid nav+ncx and an ambiguous declaration |
| reading divisions / reader information designer | preserve actual parts/chapters and their bodies. no title-page/book conflation, license swallowed by a novel, contents owning a linked preface, false empty range, or lost bounded chapter. contrasts: `a48ee710`, `c1260306`, `c5caf377`, `cf26ed31`, `f0c3a6f6`, `749e5383`, `2ce4bf54`; include genuine cross-file parts and adjacent number/title headings |
| notes / scholarly-edition designer | each opener reaches exactly its authored note, with complete paragraphs, emphasis, lists, quotations and supported assets. distinct inline glosses stay distinct; return links remain returns. eight continuation cases, both kjv cases, both `e999` copies, `ccba64e7` and `b13e55e0`; contrast ordinary single-paragraph notes and unrelated links |

short ids above identify entries in the exact inventory, not runtime predicates.
the private expectation record for each case contains source hash, package member
and authored anchors/boundaries, expected fields, and links to the existing negative
proof. verify the entire new proposal: the old review often stopped at its first
counterexample and did not approve the remaining fields.

## architecture and contracts

one shared extraction path serves normal imports and retained-publication repair:

```text
verified original + immutable retained fragments
  -> epub_ingest: declared navigation and source correspondence
  -> html_apparatus: complete note bodies and directed relations
  -> epub_structure: reading boundaries using those note regions
  -> reader_navigation_repair: full proposal, preservation checks, fenced apply
  -> existing publication/apparatus owners -> ordinary reader and reading copy
```

### a. package navigation

replace `_materialize_toc`'s unconditional version switch with one explicit source
selection table. identify declared nav and the spine-named ncx; only when the spine
names none may a unique manifest ncx identify that input. never search filenames.

| declared contents inputs | selected authority |
| --- | --- |
| ncx only | ncx, including the three version-3 packages with no declared nav |
| nav only | nav |
| both, package major version 3 | nav contents; ncx is not merged into that outline |
| both, package major version 1 or 2 | ncx contents; supplemental nav does not replace it |
| neither | no publisher contents; only independently proved source headings |

multiple declarations of one role, a broken named declaration or unknown version
with conflicting authorities refuse repair. validate the selected resource; its
failure must not trigger another parser or become an empty successful repair.
`211dd5d1` is the adversarial dual-source case: actual version `1.0`, 28 ncx entries
versus 27 nav links. a universal nav preference would discard an authored entry.

this does not require ordinary imports to reject otherwise readable books for
optional-navigation defects. preserve that existing ingestion policy; maintenance
must refuse an incomplete replacement. neither path may silently switch authority.

these are supported source formats in one current path. replace the superseded
rules for both normal imports and maintenance; no feature flag or per-book patch.
record the epub3-without-nav discrepancy in the existing per-item proof; using its
declared ncx does not make that package conformant. no new public diagnostic type
is needed for this campaign. genuinely absent navigation may still use proved
source headings; absence and a broken declared resource must remain distinct.

collect authored guide/landmark/page-list roles independently of contents choice.
preserve distinct entries and roles; coalesce only identical role/target/label
entries. resolve with existing package-path/anchor validation. never make an
escaping, external or ambiguous target navigable. no filename searches, old
database-row fallback or per-book override.

### b. reading divisions

keep `toc_nodes` and routine `sections` separate throughout derivation. build the
routine graph from source facts, then calculate extents; do not copy presentation
ancestry into semantic ownership without corroboration.

- capture navigation ancestry and relevant authored structural roles alongside
  existing canonical element coordinates. extend structural capture only; canonical
  text normalization and persisted fragment html/text remain byte-identical.
  stripped semantics come from the verified original through exact correspondence,
  never from guessed filenames or class-name substrings.
- navigation labels, image-only covers and note bodies remain reachable in their
  proper navigation lists; their headings alone do not create routine chapters.
- actual enclosing divisions and explicit part/chapter relationships can establish
  parentage. heading rank can organize a proved local reading scope; it cannot
  carry a parent across spine documents by itself. conflicting evidence refuses
  that inferred relationship; a flat publisher outline alone proves neither case.
- match a publisher entry and a heading only when they name the same division,
  not merely the same offset. combine an adjacent number/title pair only when
  source structure proves one heading. do not retire a bounded chapter unless
  its surviving section preserves that chapter's identity of meaning and range.
- distinguish a complete division container from a title-only wrapper. the latter
  cannot end a chapter whose prose continues in later documents. end at a proved
  division boundary, not an arbitrary wrapper, next file or book eof. inferred
  ranges must not swallow independently authored front/back matter or licenses.
- every finite range is nonempty, contains its target and matches its named
  division; child ranges stay inside proved parents. unresolved extent is null,
  never `[start,start)` or an invented eof. retain proved targets and source text.

use `DocumentPoint`, `CanonicalStructure`, `NavigationNoteIndex` and
`resolve_section_ends`; change their owning rules rather than adding a second
structure engine or repair-only section filtering. any added internal field must
carry a fact consumed by these rules; no confidence scores or extensible registry.

### c. note bodies and link direction

one boundary decision owns both rich html and plain text. correct the common
`html_apparatus` path, including direct local targets and cross-document targets.

- select the complete source interval: an explicit note container, a proved sibling
  interval, or a proved inline entry. inline entries end at the next independently
  identified entry within their group; a paragraph is not automatically one note.
- preserve every node within the proved interval, including continuations and rich
  structure. clip source dom ranges, never generated text or guessed punctuation.
  pagebreaks alone neither prove a note ends nor justify taking its first paragraph.
- use that same interval for existing `_body_html`, locator matching and subsequent
  `prepare_apparatus_bodies`. sanitize once through the current owner and derive
  `body_text` from that sanitized html. materialization adopts the resolved body;
  it must not reconstruct it from the target anchor/leading paragraph.
- failed complete-boundary inference remains unresolved. delete the path that
  relabels a partial paragraph as a strong complete note. no truncated-body fallback.
- within an independently corroborated note run, repeated publisher entry
  structure and exact source-marker identities may establish boundary-only entries.
  this is source-local inference, not an explicit semantic tag or a forward relation.
  preserve and record contradictory source links; never repair them by inventing edges.
- classify marker and body roles before emitting an edge. preserve actual forward
  references and returns; never emit a second reversed pair just because two links
  are reciprocal. ambiguous role evidence creates no invented edge.
- reuse authored identity/alias matching and exact retained-span validation. new
  intervals must be uniquely anchored; repeated labels are not identities. do not
  remove, merge, retype or redirect installed apparatus items/edges to force apply.

rebuild note groups from the proved intervals before deriving routine sections.
fix all proposed bodies in each of the 14 books, including the kjv short-body
cases whose semantics the earlier review left unadjudicated. suppressing a new
bad body alone is not a source-proved no-change outcome for a missing real note.

### d. publication and interfaces

no new public api, database table, migration, queue, replay ledger or wire revision
is planned. preserve the existing shapes:

| contract | fields / obligations |
| --- | --- |
| `EpubNavigationRepairPlan` | complete `toc_nodes`, `nav_locations`, `apparatus_items`, `apparatus_edges`, `note_groups`, `source_issues`; no selected-field patch |
| `EpubStructureSection` / `ReaderNavigationSectionOut` | existing identity, label, target, nullable parent and end/extent; null means unproved, not eof |
| apparatus items / edges / `NotesGroup` | existing source identity, rich/plain body, locator/status, directed relation and group range; html canonical text must equal body text |
| `ReaderNavigationRepairInspection` | existing source/generation fence, complete row changes, installed/proposed hashes and inspection digest; counts are not content proof |
| ordinary consumers | `GET /media/{id}/reader`, document map, reader targets and reading copy. reader output projects sections to id/label/depth/point; it does not expose internal extents or landmarks, which require persisted-state proof |

reuse the existing operator interface unchanged:

```text
python -m nexus.ops.reader_navigation_repair inspect --media-id <uuid>
python -m nexus.ops.reader_navigation_repair apply --media-id <uuid> --generation <n> --inspection-digest <sha256>
```

inspect writes nothing. apply recomputes the full plan, rechecks source, generation
and installed metadata under the existing locks, then atomically installs it.
changed means one generation increment and one suggestions input notification,
with the counter lock last. unchanged/refused means zero writes. post-install full
projection must equal the inspected proposal. stale digest refuses. lost reply
means unknown: reconcile complete projection and protected state before another
mutation; a generation increment alone is insufficient.

allowed writes are navigation/apparatus/note-group rows, reconciled navigation
issues, publication generation/time and the existing notification. preserve source
objects, fragments/text/ids, assets, ownership/membership, credits, saved cursors,
highlights/notes/citations/connections, indexing and unrelated jobs. retain the
existing apparatus identity/body-enrichment fences. if a target cannot pass them,
report the exact conflict; do not widen preservation policy inside this task.

## delivery boundaries

three implementation branches, then one integrated repair campaign. paths below
are under `python/nexus/services/` unless stated otherwise. review each boundary
once when its evidence changes; no parallel edits to a shared file.

| lane | exclusive files | deliverable / adversarial challenge |
| --- | --- | --- |
| a: package authority | `epub_ingest.py`; its part of `docs/modules/epub.md`; explicit boundary-map argument at the shared `web_article_structure.py` call | three source cases plus landmark loss; reject selection that drops another authored navigation role; preserve ordinary article preparation |
| b: reading divisions | `epub_structure.py`, `reader_structure.py`, structural capture in `canonicalize.py` | the 38 structure cases plus section effects in a's landmark books; reject both false nesting and flattened genuine parts |
| c: note extraction | `html_apparatus.py` | all 14 note cases; reject incomplete bodies, prose-as-note reversal and equal paragraph bodies for distinct glosses |
| integrator | `reader_navigation_repair.py`, `ops/reader_navigation_repair.py` only if a demonstrated integration defect requires change; existing runbook/tickets and final receipts | full preservation/consumer proofs, deployment and sole live apply owner; reject weakened fences or unreviewed extra fields |

a owns any wiring needed by b/c in `epub_ingest.py`; agree the input contract before
parallel implementation. freeze c's note-region behavior before b's final section
qualification. reuse existing semantic-token parsing if structural capture needs
the same facts; a small shared extraction belongs with existing html helpers only
when two real callers need it. do not expand token vocabulary for unrelated tickets.

## red, green, refactor and live acceptance

1. **red:** on an isolated restored-production database and isolated output bucket,
   verify all 57 original identities/hashes and reproduce each historical failure
   through current inspect. use retained receipts for source facts that still match.
   designers supply exact expected content before assertions are written. preserve
   already-correct outcomes; do not manufacture a red result.
2. **green:** implement the three owners; temporary end-to-end probes exercise the
   real inspect/apply/read path and normal import for one source per distinct cause.
   new imports run through the real worker in the isolated stack. every 57-item
   proposal receives full source review, then selected applies and unchanged
   reinspection. verify normal article behavior because extraction/range code is shared.
3. **refactor:** remove superseded version dispatch, duplicate body reconstruction
   and unproved hierarchy rules. run `./scripts/test`; rerun only affected behavior.
   an adversarial reviewer checks source semantics, identity and full allowed diffs
   at red, green, final candidate and live reconciliation. record concrete findings
   in existing tickets; no nested admission packets or redundant review rounds.
4. **qualify once:** combine demonstrated fixes on a release branch based on the
   actual production commit. merge that branch into main preserving its ancestry;
   publish through the existing `release/**` image workflow and qualify its exact
   source/image/consumer vector. current main's unrelated changes are not included.
   `release.py:preflight` already accepts an ancestor of main. later merges do not
   invalidate unchanged evidence; no blanket merge hold or deployment-tool change.
   retain unchanged native/extension binaries only after proving their contract and
   payload inputs unchanged; record actual installed identities, not a rebuild claim.
   the separately owned wire-10 release precedes this campaign; its frozen source
   excludes these book fixes. rebase and requalify on its accepted database `0292`
   / wire `10` runtime. never deploy the old wire-2 candidate after that cutover.
   production sequencing transfers only through an explicit handoff; unrelated
   main merges remain unrestricted.
5. **live:** use the existing [repair runbook](runbooks/retained-book-repair.md).
   reconcile active/unknown operations, finish a fresh verified backup, restore it
   off the mac and prove the selected repairs there before live apply. retain the
   120-second parser / 180-second whole-invocation bounds and containment. normal
   import limits stay unchanged. deploy the one qualified correction if needed;
   never redeploy per book. sync/quiesce only affected batches, refresh source/fences,
   apply sequentially and verify each outcome. rollback is an explicit stopped-writer
   backup restore with its post-backup data-loss consequence, not reverse repair.
6. **close:** all 57 have accepted repair/no-change evidence. frankenstein alone may
   retain the authorized live-consumer exception; report it explicitly in completion
   totals. retain exact outstanding causes until resolved.
   delete temporary executable tests, fixtures, dependencies and owned resources
   after refactor/live acceptance; retain concise receipts and sources. run the sole
   static gate after deletion. update existing tickets/module docs; do not create
   another tracking system or carry operational chronology into module contracts.

minimum proofs, batched by failure rather than repeated per book:

- every changed item: full persisted projection equals approval; protected state
  preserved; generation/notification each +1; fresh inspection and fresh-fence apply
  unchanged. every no-change outcome needs positive source proof, not only refusal.
  prove global row equality and the singleton delta on the isolated clone. live
  checks preserve each target and reconcile legitimate concurrent writes; a global
  counter difference alone cannot prove this repair's notification count.
- one representative for each changed shared mutation path: stale source/generation/
  proposal and ambiguous source refuse with zero writes; interruption near commit
  reconciles without duplicate apply. do not repeat unchanged infrastructure faults.
- use a small, source-proved control set from previously accepted/unchanged books:
  genuine parts, flat chapters, adjacent number/title headings, image cover, complete
  notes and an article. read only these controls and the 57 by default; expand
  only for a demonstrated shared regression;
  apply none outside the 57. restore exact fixtures before reusing the clone.
- every accessible repaired book: ordinary api content equals the approved output;
  rendered web contents/section or note interaction covers the repaired feature.
  physical phone covers each distinct navigation/note mechanism and affected
  downloaded copies; source/persisted proof remains per item, not sample-based.
- contents/note inspection, view-in-source and return preserve departure and saved
  cursor. include an absent cursor and an existing cursor; only explicit continue
  may write progress. redownload only changed offline copies after pending progress
  sync; prove new generation and stale-generation refusal. no offline reset/data loss.

## records and tradeoffs

extend the existing private per-item proof convention under the campaign artifact
root; keep the exact inventory in its current ticket. each result binds media id,
source identity, cause, expected content, candidate sha/image, before/after generation,
inspection/projection hashes, preservation proof and actual consumer results.
states remain distinct: implemented, locally verified, rehearsed, deployed,
live-accepted, no-change, unresolved. never relabel unknown/not-run as acceptance.

tradeoffs: conservative structure can be shallower; declared-source selection can
recover a nonconformant package without validating it. strict identity preservation
can leave a case open rather than lose evidence. three branches cost integration
work but separate real owners; one final release prevents repeated qualification.
phone and regression coverage follow distinct mechanisms instead of a fresh full
corpus campaign; all 57 book-specific results still receive exact proof. deleting temporary
tests sacrifices ongoing regression coverage; receipts cover only the qualified
candidate. normal service continues between small repair batches; no campaign-wide
write pause or unrelated release dependency is introduced.
