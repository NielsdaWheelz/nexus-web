# highlights

a highlight owns one captured source quotation and one optional rich annotation.
`node/authored` owns meaning and merge; device sqlite owns durable local commands;
python `services/authored` owns replication and relational projection. ordinary
related notes remain independent resources. graph adjacency never defines an
annotation.

## identity and writing

create freezes one body initializer and a random client uuid before asynchronous
preparation. retries retain both. identical or overlapping selections remain
independent highlights. each highlight retains its immutable source ref,
observed-delete liveness, permanent yjs body, selection register and color register.
selection publication, typed locator, literal quote and context move together;
resizing or changing color never replaces the body.

an x selection's locator names its retained capture and fragment. its nullable
publication records original observation provenance: historical unknowns stay
null, even when the retained location is proved. a known publication must match
the locator. new creation and explicit reselection require that known publication;
body/color edits, restore and replication preserve existing unknown provenance.
source navigation and chat use the retained locator. frozen literal excerpts
remain readable without reconstructing an unknown original full-source extent.

the body uses the shared note grammar and editor. empty prose projects as absent;
whitespace, breaks, images, embeds and empty code are content. canonical yjs bytes
remain present even when the nullable annotation projection is absent. clearing
is one undoable edit of observed inline content and presentation, preserving the
body root, mounted editor and history. unseen concurrent inserts survive clear.
an unseen annotation edit can revive an observed-deleted highlight; a later
observing delete hides both quotation and annotation.

the greatest `(lamport,replica_id)` wins each scalar register. publication,
locator, canonical quote evidence and frozen excerpt move together. canonical
quote strings locate text; they do not own display.

new selections save explicitly. blank input saves a highlight; authored input
saves its annotation in the same local command. first annotation or reannotation
of an existing highlight stages a clone of its actual permanent body. saving
admits only its incremental delta; cancel commits nothing. bound annotation
editing autosaves through the ordinary writing runtime keyed by `highlight:<id>`.
annotation editing has no note split/join behavior. creation enter saves,
shift-enter inserts a break; bound enter inserts a break and tab stays native.

explicit save closes only after local durability and only for the unchanged
submitted draft. a stale completion cannot consume newer writing. failed commits
retain writing and the existing retry/copy controls. already committed pending
upload acquires no loss warning. body, reference, hyperlink and attachment input
participate in the shared work guard. involuntary source changes or remote
deletion retain unsubmitted input without submitting or retargeting it.

## frozen excerpts

`node/authored/src/excerpt.ts` owns the closed text tree, unicode codepoint
endpoints, literal text projection, bounded views and capture revision. native
reader ranges enter through `text/excerpt.ts` before canonical normalization;
server captures use `services/source_excerpt.py` and the same semantic helper.
paragraphs, explicit breaks, preformatted whitespace, inline emphasis, lists,
tables and direction remain source facts. current reader typography owns reflow.
the host supplies a required read-only profile: the workspace projects its live
reader settings; the downloaded shelf supplies the same profile as its source.
quotation rendering neither edits settings nor fetches a substitute profile.

server capture scans source provenance before materializing an excerpt. the
existing canonicalizer locates original text contributors; the shared literal
policy chooses context boundaries from source events. only the bounded candidate
becomes an excerpt tree. source length does not become a new capture-admission
limit. optional context has a combined 64 kib raw-text allowance as well as its
display budget. exceeding it ends context earlier with a marked omission; it
never shortens selected text or substitutes whitespace. the complete command's
existing limit remains authoritative. the source owner groups selections by
admitted reading, fragment and bounds, keeping one source tree live at a time.
its canonical inverse uses compact runs and resolves only requested endpoints.
the helper's private `--source-window` operation reads framed source events from
stdin and returns context cuts; frame boundaries never define text boundaries.
private utf-16 census coordinates keep mixed unicode text affine. only sparse
endpoints convert back to public codepoint coordinates. the ordinary bounded
helper protocol validates and captures the resulting excerpt trees.

capture includes the selected blocks with at most 600 optional display codepoints
per side. containing tables are atomic, including their outer tables. media stops
optional context; intervening media has a nontext marker. unsupported selected
words or a complete command exceeding 2 mib refuse before commit. a clipped piece
marks incomplete tables at its source slicer; those tables cannot be captured.
the same slicer publishes incomplete-table bounds through the existing local
scope snapshot. text offsets alone cannot prove admission of empty cells. local
and server reads withhold those tables; fully admitted tables remain available.

the frozen tree owns display and existing copy commands. unknown historical
structure preserves saved strings exactly and says `original formatting wasn’t
saved` wherever context shows; pdf/plain evidence retains its existing text behavior.
an empty unknown or plain selection says `selected region`. source links in
excerpts are inert. literal text projection excludes interface labels and omissions.

compact projections retain 600 selected codepoints and 48 per side; tables that
cannot fit disclose as a whole. annotation paint uses compact projections;
visible quotation bodies and the active copy command load full evidence. a reader
row placed in its open source narrows that body to the selected words, keeping
whole tables, and links them to the passage; the page already shows their context.
captures keep their context for re-anchoring. full queries read the exact
canonical capture and its revision together. revisions hash source identity and
the complete capture, independently of scope and mutable metadata. reading scope may remove context,
never replace it with current source words. uncaptured discovery uses bounded
admitted preview text, reports clipping and exposes no capture revision; full
matching and capture authority remain separate. historical evidence owns its frozen
capture and never loads a live authored resource to replace it.


## presentation and access

reader, compact/downloaded reader, outline and detail surfaces share one annotation
editor. blank highlights offer `annotate`; existing bodies offer `edit annotation`
and `clear annotation`. a blank row placed in its open source shows neither `annotate`
nor a linked-items field: its menu opens the annotation in place, and its branch opens
at its first link. related resources remain separate. copy-passage and
frozen message quotations contain only source words. a question draft has separate
ownership; submission neither copies nor clears the saved annotation. authorized
context assembly can read annotation explicitly.

`/highlights/:id` reads the local authored capture, annotation and relationships,
independently of source availability. `#annotation` reveals the annotation;
`#passage-<id>` reveals exact annotation evidence. focus delivery waits for the
real editor handle and respects newer user intent. ordinary quotation arrivals
do not start an annotation draft. `view in source` retains the existing source
destination. there is no annotation resource identity or route.

annotation content, embeds and retrieval are owner-private. a source or highlight
grant authorizes the captured quotation, never the annotation. peers receive no
annotation controls, empty-state claims or private metadata. annotation-only edits
leave the public quotation timestamp and other viewers’ notification revisions
unchanged. current source metadata requires current source access. source stubs and
captured quotations grant no access to unavailable source bytes.

## evidence and publication

field targets are explicit: `field:null` addresses ordinary resource meaning;
`field:"annotation"` addresses content inside a highlight. precise annotation
embeds and hrefs target that field; graph edges connect resources without fields.
annotation-owned passages use `source_ref=highlight:<id>` and
`highlight_annotation_offsets`, half-open unicode codepoint offsets in canonical
annotation text. a matching body hash certifies offsets; otherwise relocation
requires a unique quote/context match. unresolved evidence retains frozen words.
source quotation offsets are never annotation offsets.

private annotation search has its own `highlight_annotation` family and admission
before matching or scoring. the highlights filter includes quotation and
annotation evidence and returns the strongest eligible witness per highlight,
with its field and activation. locatable quotation evidence opens its selected
source or piece; unlocated owned quotations open the retained highlight pane
without claiming a source position. annotation evidence opens the highlight
field. saved annotation passages retain their passage id at the highlight
destination. lexical evidence retains
the existing precedence over semantic-only matches; scores from those two systems
are not compared directly. `authored_text_indexing` owns note and highlight
text publication under the existing revision, claim and body fences. clearing or
deletion withdraws annotation evidence independently of quotation evidence.

tools create highlights through the same authored command. annotation-only undo
clears the observed body under the account head lock, never deleting the highlight
or its relationships. an absent, hidden or already empty target is already undone
and emits no revival touch. whole-highlight undo subsumes annotation clear from
the same creation receipt, while provenance retains distinct field identities.

dom and frozen-tree adapters share one canonical normalization policy. excerpt
proof exposes text, length and the selected canonical interval; source adapters
receive only proved endpoints and unsupported intervals. internal source runs and
streamed contributors avoid retaining a whole per-character endpoint graph.
complete graphemes preserve nfc composition across inline leaves. this projection
proves location; the separate literal projection owns display and copy.

pdf locations use canonical page-space quads. viewport transforms are derived
presentation; geometry normalization belongs to the shared semantic owner and
retains the existing precision rules. every overlap remains selectable even when
its paint coincides with another annotation.

## cutover

reader projection and relocation caches are rebuildable. source teardown retains
authored highlights, geometry, quotes, passage identities and independent notes.
source foreign keys cannot cascade or reject an accepted offline capture merely
because original bytes/generation no longer exist. current reading permission
still belongs to the source owner.

## server and migration

server tools create captures through the same semantic owner and feed, inside
their existing permission/fencing boundary. no direct highlight projection writer
or whole-body annotation-note endpoint remains. server reads honor semantic
liveness and keep captured writing available independently of source access.

revision 0320 freezes old grammar conversion and preserves current highlight,
note, link and passage ids. old annotations without proved publication provenance
seed `publication:null`; their literal quotes and locators survive. unsupported
records and conflicting live semantic bindings refuse the transaction. paired
release, backup and device qualification belong to the
[release issue](../issues/release-local-first-writing.md).

format 3 adds frozen excerpts and bounded relational previews. revision 0326
converts only named current/historical capture paths, preserving saved words,
causal state and immutable accepted changes. an account feed floor keeps prior-format
receipts out of current decoding. required format-3 upload envelopes reject old
producers before replay while retaining server replica identities and accepted prefixes.
annotation format 4 supersedes the excerpt-only device transition: incompatible
local stores refuse until explicitly retired after empty-outbox proof, then
bootstrap with a fresh replica. downloaded sources remain outside this retirement.
the paired cutover remains tracked in
[release highlight excerpts](../issues/release-highlight-excerpts.md).

revision 0327 consumes unambiguous attached notes and transfers their actual yjs
bodies, references, placements and unchanged index publications to highlights.
ambiguous ownership, liveness or binding collisions abort atomically with exact
record ids. old accepted bytes remain inert behind authored format 4 and the
snapshot floor. old clients and external note urls have no compatibility path.
paired release, drained queues, backup, repair and device qualification belong to
[the release issue](../issues/release-highlight-annotations.md).
