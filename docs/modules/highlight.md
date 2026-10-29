# highlights

highlights are independently identified authored selections. the shared authored
kernel owns their state and merge; device sqlite owns durable local commands;
python `services/authored` owns replication and relational projection. existing
`highlights.py`, location resolution and schemas expose the
server read/tool contracts. reader surfaces own paint, hit-testing and selection
presentation. chat owns quotation context and run assembly.

## identity and capture

create mints one random client uuid and retries retain it. independently created
overlapping or identical extents remain distinct highlights, each with independent
notes and links. no extent singleton, duplicate alias or resize collision exists.
editing and deleting always address one exact id.

a highlight has immutable source ref, observed-delete liveness, a selection
register and a separate color register. the greatest `(lamport,replica_id)` wins
each scalar register. selection publication, typed locator, canonical quote
evidence and the frozen excerpt travel together; concurrent resizing selects
one coherent capture. canonical quote strings locate text; they do not own display.
resizing preserves the highlight id and every attached-note link.

a reusable passage binding is separate from a highlight. passage identity is
source plus normalized exact/prefix/suffix; literal captures are not rewritten by
matching normalization. same-key captures merge their hint register and retain
known ids. differing publication/locator evidence is not another identity.
a geometric pdf selection may have no textual passage ref and an empty quote.

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
saved`; pdf/plain evidence retains its existing text behavior. source links in
excerpts are inert. literal text projection excludes interface labels and omissions.

compact projections retain 600 selected codepoints and 48 per side; tables that
cannot fit disclose as a whole. annotation paint uses compact projections;
visible quotation bodies and the active copy command load full evidence.
full queries read the exact canonical capture and
its revision together. revisions hash source identity and the complete capture,
independently of scope and mutable metadata. reading scope may remove context,
never replace it with current source words. uncaptured discovery uses bounded
admitted preview text, reports clipping and exposes no capture revision; full
matching and capture authority remain separate. historical evidence owns its frozen
capture and never loads a live authored resource to replace it.

## local interaction

an unsubmitted selection composer is ephemeral. its existing explicit save commits
the highlight, optional independent note and links in one durable local command.
attached-note editing subsequently autosaves through the ordinary note owner.
multiple notes remain independent; unlinking or deleting an annotation does not
consume them. canceling a creation dialog commits nothing.

enter and save finish explicit capture after the local commit, without waiting
for upload. empty input creates a fresh highlight but adds nothing to an existing
one. successful capture closes its own unchanged opening and returns to reading;
later input, focus, navigation or child interaction keeps the newer work open.
attached-note autosave, ensuring a highlight and color changes do not close it.

local failure keeps the input and requires explicit retry of the original command.
the composer observes its completion even when another writing surface retries it;
only its own eligible retry may renew permission to close. settlement clears only
the matching operation and failure. submitted text is consumed only at its original
revision with no unfinished reference, hyperlink or attachment. hyperlink activity
includes hidden retained input; hiding its form is not cancellation.

hosted and downloaded readers share the annotation controller. local authored
queries own annotation reads online as well as offline. sources already on the
device remain annotatable without a network publication lookup. retained source
stubs/quotes/labels do not grant access to unavailable bytes. direct native source
mainframes and subframes receive no authored bridge authority.

the passive mobile row retains the shared highlighter and overflow controls with
notebook/pen and question openers. names describe the next action, and unavailable
controls remain focusable with their reason. copy uses the frozen nonblank quote
unchanged, independently of note saving or remote action reads. desktop copy/share
remain direct commands; mobile keeps copy/share, colors and existing-chat choices
in overflow. closing an unused menu returns focus to the reader; completed commands
retain their own focus transfers. the sheet keeps its native close handle and
fixed toolbar above the scrolling editor.

## locations and source generations

reflowable locations use canonical codepoint offsets. dom provenance maps source
spans to canonical codepoints for selection and paint; normalization can compose
or expand source characters. mixed-atom note locations use the shared canonical
text projection, never an independent editor-text approximation.

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

store the mounted publication identity with the original literal quote and typed
locator. a source change before upload does not reject the already committed
capture. exact valid relocation may update a derived location. absent or changed
publication provenance requires unique quote resolution; ambiguity remains beside
the saved quotation. unknown provenance never permits blind offset reuse.

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
producers before replay while retaining replica identities and accepted prefixes. device retirement reads metadata and pending count
before content: pending writing refuses, while drained stores retain replica
identity, counters and downloaded sources and reprovision authored state.
the paired cutover remains tracked in
[release highlight excerpts](../issues/release-highlight-excerpts.md).
