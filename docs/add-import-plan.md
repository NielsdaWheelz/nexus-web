# add import specification and implementation plan

status: implemented and qualified; temporary tests removed.
owner decisions: 2026-10-13 · source: `16763c3cd4`.

one ordered editable list holds links, pdfs and epubs, their destinations and
their outcomes. preparation, filing, submission and receipts remain in the add
task. implementation lives on `feat/add-import-single-screen`.

## scope and decisions

- replace staged source entry with direct row editing; hard-delete review/add-more
  state, separate source sections and add's back-to-launcher behavior.
- accept raw url lists. preserve prose, markdown and malformed entries for
  correction. no prose extraction in add.
- header library commands add/remove one library across populated editable rows
  and the new-item seed; preserve unrelated selections. row edits affect one row.
- use existing acquisition, library search/creation, placement, feedback and
  overlay owners. no backend, database or wire-schema changes.
- fix shared picker cross-query continuation, deactivation loading and keyboard
  visibility; fix unconfirmed-placement dismissal and busy file-drop navigation.
  their live acceptance is observed; resolved tickets are removed.
- verify against an isolated real stack only. no production writes.

non-goals: shared prose extraction/share-capture redesign, content previews,
automatic importing, persistent drafts, concurrent editing during submission,
new source types, batch atomicity, unlimited queues, backend admission repairs,
placement-controller consolidation, global navigation redesign, new runtime
dependencies or a permanent test platform. the
[shared extractor ticket](tickets/add-link-paste-mutates-url-input.md) remains
open for its other callers after add stops using it.

accepted costs: ambiguous comma input requires an explicit split; multivalue
paste into a partly selected existing url requires selecting the whole field;
inline mobile choices consume height; changing picker target resets its search;
editing pauses during mutations; submission/check closes saved-item pickers;
twenty populated rows includes saved receipts;
reload loses browser drafts/files; results may partially succeed. the native file
chooser and existing leave/stop confirmation remain separate surfaces. exceptional
durable upload recovery stays in imports. deleting temporary tests removes their
future regression protection; retain acceptance cases and observed receipts.

## target interaction

desktop columns: source, libraries, row actions. the libraries header contains
the bulk selector directly above row selectors. urls are text inputs; files
show a read-only filename, type and size in the same row geometry. reuse theme
tokens and field/button primitives; no card per row. keep the existing modal
width initially, stationary header/footer and one scrolling list.
url fields use raw text inputs with a url keyboard and capitalization,
autocorrection and spellcheck disabled; local validation owns their errors.

one trailing insertion row and a stable choose-files button remain visible.
drop files anywhere in the list; append them in supplied order before insertion.
cancel changes nothing. reset the native file input after every selection,
including rejected intake, so the same files can be selected again. retain
choose-files focus and announce the count once. no metadata requests on intake.
recognized file drags/drops always prevent native file-opening/navigation, even
while busy/full; refusal changes no sources and announces its reason.

mobile stacks destinations below each source and expands the active chooser
under its owning row/header; header chooser content joins the scrolling body
below the fixed header. desktop uses the anchored chooser. one editor is
open at a time. errors remain beside their source; progress never moves rows.

desktop initial focus is the first editable source; mobile initial focus stays
on the heading. enter in a source advances to insertion, never submits; an empty
insertion enter does nothing. at capacity retain focus and announce the limit.
preserve native typing, selection and composition. after removal focus the next
row's enabled source, otherwise its first usable control,
otherwise the preceding row or insertion. identify each library control by its
source in its accessible name. associate errors with `aria-describedby`.

footer: ready/attention counts and `add n items`; invalid rows remain while ready
rows submit. zero ready means disabled `add items`; settled accepted-only work
offers `done`. count and button must describe the same admitted subset. ordinary
completion neither closes the modal nor opens a resource automatically.

## session schema and capability contract

`useAddContentSession` remains the sole state/mutation owner. its new local arms:

```ts
type DraftSource =
  | { readonly kind: "Url"; readonly text: string }
  | { readonly kind: "File"; readonly file: File };

type EditableItem =
  | { readonly kind: "Insertion"; readonly id: string }
  | {
      readonly kind: "Draft";
      readonly id: string;
      readonly source: DraftSource;
      readonly destinations: readonly LibraryDestinationSelection[];
      readonly showFeedback: boolean;
    };
```

`AddItem` comprises these arms plus the existing `Queued`, `Submitting`,
`Rejected`, `AcceptanceUnresolved` and `Accepted` arms. delete the old file-only
`Invalid` arm; invalid sources are editable drafts. retain existing frozen
`AcceptanceIntent`, validated `AddSource`, accepted file summary, processing
result, placement-by-media-id and mutation variants.

replace `urlInput` and `defaultDestinations` with `newItemDestinations`; retain
`sessionId`, ordered `items`, `intakeFeedback`, placements and mutation state.
derive validation/readiness/counts/bulk coverage; do not store duplicate totals
or a parallel valid-url queue. validation belongs to `addInput.ts`; reuse
`getFileUploadKind`/`getFileUploadError` for files. reveal url errors after paste,
blur or submit, rather than on each incomplete keystroke; file errors are immediate.
typed promotion starts `showFeedback=false`; seed/paste/file drafts start true.
blur/submit set it true; subsequent edits retain it. native paste marks the
resulting input change, after promotion; never prewrite a value before native
insertion. input origin is view-owned, not a second source buffer.

invariants:

1. exactly one `Insertion` is last. it owns no text or destinations. typing a
   nonempty raw value promotes its existing id to a url draft and appends a new
   insertion. never remount the promoted input or change its focus.
2. a cleared/whitespace-only url draft keeps its id and libraries but contributes
   no ready item, attention count, capacity use or unfinished-work warning.
   libraries alone do not make an empty source dirty.
3. at most twenty populated content rows, including invalid and accepted rows.
   every edit/insert checks the resulting count synchronously. reject overcapacity
   paste/drop as a whole; preserve existing rows, selections and caret. clipboard
   and disk retain the rejected input. at capacity, empty inputs/file intake are
   disabled; existing populated rows remain editable when otherwise idle.
4. initial url seeds use the same parser and appear as rows. current callers
   supply zero or one url. `start` requires at most twenty populated parsed rows;
   build/validate replacement state before resetting the current session. an
   impossible internal overcapacity seed is a defect, never truncated input.
5. independent row identities survive every transition. accepted aliases share
   actual placement state by media id. no client content canonicalization or
   silent duplicate-row merging.

replace draft commands with these explicit local operations; use object parameters:

| capability | contract |
|---|---|
| `setItemUrl({ itemId, text, origin })` | `origin` is `Typing` or `Paste`; edit/promote, update feedback visibility and enforce capacity; never edit a sent source |
| `revealItemFeedback({ itemId })` | reveal derived feedback on blur; empty drafts still show no error |
| `pasteUrls({ itemId, text, selectionStart, selectionEnd })` | atomically expand supported list input; return native-paste, applied/focus-target, or rejected feedback |
| `splitItemUrl({ itemId })` | explicitly apply the offered ambiguous split; same insertion/capacity contract |
| `stageFiles({ files })` | append all files with copied new-item destinations, including invalid files, or reject all |
| `setItemDestinations({ itemId, destinations })` | replace one draft's set |
| `setNewItemDestinations({ destinations })` | edit only the visible insertion-row seed |
| `setDraftLibrary({ destination, included })` | add/remove one library on populated drafts and seed; preserve other selections |
| existing remove/restage/submit/check/placement/create/stop commands | retain lifecycle authority; adapt draft construction to the new arms |

keep command inputs narrow and typed; view code never mutates arrays, generates
replay keys or calls acquisition directly. use one synchronous snapshot/ref as
today. all changes respect the existing single mutation slot.

## paste grammar

new internal `components/nexus/addInput.ts` owns list splitting and url draft
validation. trim outer clipboard whitespace first, then split on crlf/cr/lf,
tabs, and comma followed by whitespace between cells. consume separator commas
before newline/tab splitting; ignore empty cells and trim their outer whitespace.
a terminal comma on a single trimmed url remains literal; paste such a url
individually if a list boundary would make it a separator. never strip other url punctuation,
quotes or markdown wrappers. prose/wrappers remain invalid. validate a complete
explicit `http://` or `https://` authority with a host and no internal raw
whitespace. reject repaired forms such as `https:a.test`, `https:/a.test` and
`https:///a.test`; `new URL` alone is insufficient. preserve the trimmed
spelling for submission instead of serializing it through `URL`.

| input | result |
|---|---|
| `https://a.test/x, https://b.test/y` | two ready rows |
| `https://a.test/x,` then newline/tab then `https://b.test/y` | two ready rows; consume the separating comma |
| `https://a.test/x, broken` | ready row plus editable invalid `broken` |
| `https://a.test/x,y` or `https://a.test/?q=1,2` | one unchanged url |
| `https://a.test/x,https://b.test/y` | one unchanged ready url; offer `split into 2 links` |
| `https://a.test/(x)?q=why?` | preserve parentheses and final question mark |
| `read https://a.test/x` or `[paper](https://a.test/x)` | one invalid raw row; extract nothing |

offer ambiguous splitting at commas immediately followed by `http://` or
`https://`, removing those separator commas, only when every resulting url is
valid and there are at least two. the original url
remains valid and submittable until the user chooses the split.

paste without a list delimiter in its trimmed text keeps native caret/selection
behavior. intercept delimiter-bearing paste even when only zero/one nonempty
cell survives; zero cells is a no-op. apply only in insertion, an empty draft,
or a fully selected existing field. otherwise prevent it and say `select the
whole link to paste a list`; preserve the field and selection. count all cells,
not only valid urls. replacement retains the
first row id and destinations; extra rows receive new ids and copy those
destinations. insertion uses the seed. focus the last inserted source at its end.
no clipboard history, general undo framework, fallback parser or shared-extractor
rewrite. confirm whitespace handling before rendering a single-line input so
the browser cannot silently concatenate a list.

## libraries and shared components

bulk coverage uses populated drafts only: all/some/none per library. all removes;
some/none adds. zero populated drafts displays/edits seed coverage. the insertion
selector is explicitly labelled `for new items`; row overrides never alter it.
the header says `varies by item` when sets differ. every import implicitly enters
the built-in `All` library; display that fact once, without an optional checkbox.
use existing `Button` for the bulk header and accepted `libraries…` controls.
draft/new-item controls reuse `LibraryDestinationTrigger`, with separate visible
and source-specific accessible label props. migrate its field/extension callers;
do not pass invented selections to represent unknown saved inventory.

replace `LibraryDestinationPicker`'s `selected`/`onChange` props with `selection`:

```ts
type DestinationSelection =
  | {
      kind: "Item";
      selected: readonly LibraryDestinationSelection[];
      onChange: (next: readonly LibraryDestinationSelection[]) => void;
    }
  | {
      kind: "Bulk";
      entries: readonly {
        destination: LibraryDestinationSelection;
        state: "All" | "Some";
      }[];
      onSet: (change: {
        destination: LibraryDestinationSelection;
        included: boolean;
      }) => void;
    };
```

searched destinations absent from bulk entries are none. reuse one search/create
lifecycle in the picker. item mode retains `LibraryChooser`; bulk mode renders
a small native-checkbox group with shared input/button/feedback primitives.
use checked/indeterminate and ordinary tab/space semantics, never
`aria-selected="mixed"`. creation adds to the exact active scope and retains
the existing creation replay identity. block picker retarget/dismiss during
creation; closing add still offers its stop guard. disabled picker content cannot
search, toggle or create; its close affordance remains available except during creation.

give `LibraryChooserSurface` a required `presentation: "Responsive" | "Inline"`.
forward it through `LibraryDestinationPicker`; field/browse and other non-add
callers select responsive; add selects inline on mobile. match each trigger's
dialog/region disclosure to its presentation.
inline renders a labelled region at its owner's slot, registers the existing
transient-overlay escape/back/return-focus contract, and creates no mobile sheet.
inline omits outside-pointerdown dismissal: collapse would move the intended tap
target before click. close through its trigger/close action, escape/back or a
completed retarget click. responsive retains existing light-dismiss. keep
only one active add target: new items, draft row, draft bulk, accepted row or
accepted bulk add/remove. retargeting resets search; it never resets selections.
key the panel's transient state by `sessionId`; close a draft-row picker before
removing its row or submitting it. restaging never resurrects an old editor.
removal/submit owns subsequent focus; no stale anchor receives it.

fix search authority in `useLibraryDestinationSearch`: a query change immediately
retires old continuation authority, before debounce. bind each page to its query,
cursor and generation; reject stale settlements. load-more requires active,
matching installed/requested queries and no competing request. deactivation
aborts and clears both loading flags while retaining draft/results; reactivation
reads the current query. transport cancellation alone is insufficient, especially
for the extension. preserve current paging, ranking and create eligibility.

`LibraryChooser` owns keeping keyboard-active options visible in its own
scrollport without scrolling the import list or moving dom focus.

admission/check closes saved-item editors so reopening reads current inventory.
accepted-row editing uses current inventory and `LibraryEntryEditor`, never
submitted destinations as a substitute for inventory. retain lazy reads,
media-id deduplication, eligibility checks and exact uncertain placement retries.
keep existing saved-item bulk add/remove in an explicitly labelled secondary
header control; the draft header never becomes a durable write. retain the
current placement controller; consolidation remains separate (since done by the
libraries reauthor: [saved placement](modules/add-content.md#saved-placement)).

## submission and leaving

submit synchronously validates, captures ready drafts, allocates one replay key
per admitted row and freezes source/destinations/key before queuing. submit two
at a time. invalid/empty rows send nothing and remain editable afterward. a
known refusal stays local to its row, including revoked destination access;
auth and defects retain current handoff.

unknown acceptance replays the exact frozen request. a deliberate new attempt
gets a new key. unsent stopped rows return to drafts; started rows retain current
uncertainty/upload-recovery semantics. reset/unmount fences older completions.
accepted uploads release browser file handles and retain their summaries.
acceptance proves saving/publication, never completed extraction.

replace the boolean `dirty` contract with derived
`leaveReason: "Stop" | "Unconfirmed" | "Discard" | null`, in that priority.
active mutation means stop; unresolved acceptance or retained uncertain placement
means unconfirmed; nonempty drafts/rejected work means discard; settled receipts,
empty drafts and seed-only changes mean null. use this same contract in normal
and defect-boundary dismissal. explicit leave discards browser work, never claims
to undo a committed server operation.

remove add's visible back button. chooser escape/back closes it first; the next
escape/back or close requests closing add through the existing guard. keep other
launcher pages' navigation unchanged. native file choice and guarded leave are
the deliberate exceptions to the one-task presentation.

## content design contracts

each row below has a designated feature designer. the designer defines copy and
visual acceptance before red tests; the independent reviewer checks truthfulness,
scope and action eligibility. reuse `lib/imports/copy.ts` for domain failure copy;
keep new local editor copy at the editor/parser boundary.

| designer / feature | content fields and quality bar | example |
|---|---|---|
| intake designer | placeholder, delimiter hint, action; teach only supported syntax | `paste a link`; `use line breaks or a comma and space`; `choose files` |
| validation designer | reason + correction, exact capacity/file-size facts; preserve source text | `use an http:// or https:// link`; `12 places left. these 13 items weren't added.` |
| filing designer | selected names, mixed summary, scope; distinguish future defaults and durable membership | `for new items`; `varies by item`; `applies to unsubmitted items and new items` |
| outcome designer | saved fact, processing fact, permitted action; no generic retry or implied rollback | `saved · processing failed`; `check status`; `start a new attempt` |
| task designer | loss scope, non-loss truth, paired actions; no warning for empty work | `leave with unconfirmed work?`; `some changes may already be saved`; `keep working` / `leave` |

these are view contracts, not new persisted content schemas. use correct pdf
100 mib / epub 50 mib bounds, existing failure/request-id presentation, visible
focus and touch targets. do not display a routine ready status under every row.

## non-overlapping work and files

paths below are relative to `apps/web/src` unless stated otherwise. one implementer
owns each row; one reviewer challenges its contract, patch and live evidence.
designers can share staffing but own the distinct content contracts above.

| workstream | exclusive file/behavior ownership | dependency |
|---|---|---|
| a: draft and intake | `components/nexus/{addInput,useAddContentSession}.ts` (`addInput` is new): draft arms, commands, freeze/leave contract | approved grammar and schema |
| b: shared library controls | `components/libraries/{LibraryDestinationPicker,LibraryDestinationField,LibraryDestinationTrigger,LibraryChooserSurface,LibraryChooser,LibraryPlacementOverlay}.tsx`, their affected css, `components/libraries/useLibraryDestinationSearch.ts`; migrate calls in `components/browse/AcquisitionControl.tsx` and `extension/popup.tsx` | approved picker api; keep unrelated callers' behavior |
| c: task presentation | `components/nexus/{AddPanel,NexusPages,AddPanelBoundary}.tsx`, `components/nexus/AddPanel.module.css`, add-specific `components/nexus/useNexusController.ts` changes | a and b APIs settled; no direct domain writes |
| d: live proof and cutover record | temporary external harness/fixtures; this plan and `docs/modules/add-content.md`; ticket/register updates | red before a–c; green and review after integration |

inspect all call sites before removing exports/styles. retain `AddSeed` and
ingest/placement public wire contracts. `LibraryDestinationPicker` currently has
both field and browse callers. shared chooser/search changes also require focused
extension/share/ordinary-placement checks, not a rewrite of those workflows.

## red green refactor delete

the owner's 2026-10-13 instruction explicitly authorizes temporary e2e/live
verification for this change, overriding the normal no-suite policy. keep
`./scripts/test` unchanged as the sole permanent static gate.

1. create one task-owned harness outside the checkout. use normal auth, browser,
   bff, api, postgres and object storage; normal workers where the assertion
   requires processing. fixture sources must pass normal admission rules; never
   disable ssrf, auth or validation. use only disposable task-owned accounts,
   libraries, media and buckets/objects. no production endpoints or credentials.
2. red: record commit, or base sha plus dirty-diff digest, and prove new assertions fail for their
   intended reason; establish existing replay/placement invariants separately.
   no red claim from setup failure or one missing selector hiding every later case.
3. green: run the same cases through the real owners. induce refusals via actual
   public state changes; delay/drop responses externally after real requests
   commit. no stubbed success, production test flags or fake domain outcomes.
4. refactor: adversarially inspect ownership, contracts, copy, focus, dead paths
   and scope; rerun affected live cases and `./scripts/test`. failures are repaired
   at their responsible owner. no blanket expected-failure annotations.
5. after green and review, delete temporary tests, adapters, fixtures and added
   test dependencies/resources. retain a sanitized source/outcome/limitation receipt
   and selected screenshots outside the app, linked from this plan. rerun the
   permanent static gate after final cleanup. never delete evidence of failure
   to manufacture green.

the prior external imports harness under
`../nexus-web-campaign-artifacts/2026-10-09/imports/harness` is a reference for real
stack setup and commit-then-drop response faults only. do not revive its broad
workspace deletion, unrelated model/migration fixtures or blanket replay exclusions.

| acceptance case | required observation |
|---|---|
| mixed intake | newline/tab/comma-space paste plus pdf/epub selection/drop yields ordered editable rows and one insertion; no review/add-more/section split or navigation |
| parser and editing | grammar examples plus delimiter-bearing zero/one-cell paste, literal terminal comma, repaired scheme rejection; exact resulting text asserted; typing `b` defers feedback, pasting `broken` shows it; partial-selection list paste rejected without change; explicit split works |
| bounds and emptiness | empty/oversized/unsupported files remain visible; 20 populated rows allowed, overflow paste/drop rejected and empty-input entry blocked at capacity; busy/full drops cannot navigate; clearing text keeps identity and removes empty-work warning |
| filing | seed x; rows x,x; row1 becomes y; header-add z yields y+z and x+z, seed x+z; mixed x adds everywhere, checked x removes everywhere, seed z; next item receives z; zero-draft seed works; frozen/accepted rows never change |
| partial admission | real url/document plus invalid draft and server-refused destination: only ready rows dispatch; successes and refusal remain independent; stored bytes and library memberships match intended sources |
| exact replay | committed url response and upload-confirm response lost separately; change header/seed before check: identical original source/destinations/key replay; no duplicate admission/publication; frozen rows remain uneditable |
| saved placement | settled aliases share inventory; bulk deduplicates media; lost acknowledgement retains exact command for retry; close warns and keep-working retains it; settled-only, empty and seed-only work close without warning |
| cancellation | stop with sent and queued items; unsent items remain unsent, late callbacks cannot change a replacement session, committed work is never reported undone |
| shared search | change query before debounce and attempt old continuation; hold the new-items picker's search while submitting via keyboard, then reactivate; stale pages cannot append, no orphan loading, same-query paging/retry still works |
| access and presentation | keyboard entry/toggle/create/remove; active option visible; all/some/none announced; mobile inline choices and completed outside clicks retain target; long sources/names fit; chooser-first back then guarded close; removed/submitted/replaced targets never reopen |
| shared consumers | focused existing selection/create/paging/read-only/pending behavior in browse, share, placement and extension where touched; prose extraction unchanged |

parser fixtures need no network. real admission fixtures must be reachable through
the normal source policy. separate browser-sized mobile evidence from physical
soft-keyboard/android-webview observation; record unavailable device proof as a
ticket, not a passing claim. no new production seam to force rare states.

known backend replay-copy, joined-admission, revoked-destination and teardown
defects remain separately owned. use uncomplicated fresh urls and stable authority
for exact-replay proof, settled aliases for placement. assert request identity and
durable effects independently of the known duplicate-copy defect; do not waive
the whole replay case. an in-scope acceptance failure blocks completion.

## final state and cutover acceptance

one draft model, one list, one active picker, existing acquisition/placement owners.
delete `urlInput`, `reviewUrls`, `setUrlText`, old default-replacement command,
`sourceExpanded`, source/queue collapse helpers, add-more/review controls, old
file-only invalid arm, obsolete focus fallbacks and their unused styles. remove
add's extractor import; retain the extractor for its independently used prose
capability. no flags, aliases, compatibility adapters or parallel old/new add path.

update `docs/modules/add-content.md` to the implemented contract. delete resolved
picker/dismissal tickets only after their acceptance is observed; narrow the
extractor ticket to remaining callers. preserve unrelated worktree changes.
completion requires static success, required live cases green, adversarial signoff,
sanitized evidence, temporary-test cleanup and an explicit list of residual
out-of-scope tickets. this document authorizes no deployment or production repair.

## execution receipt

39 live checks pass on the reviewed production build: 20 import checks, 8 physical
android checks, 7 actual firefox-extension checks and 4 shared-consumer checks.
the last includes genuine non-admin read-only placement with zero refused-row
commands and one durable editable-neighbor command. independent owner and final
contract reviews found no material gap. [qualification and limits](../../nexus-web-campaign-artifacts/2026-10-13/add-import/evidence/qualification.md)
link original failures, source hashes, observed outcomes and selected screenshots.

temporary tests, added test dependencies, browser/device machinery, fixture users,
libraries/media, database/storage/auth and the task-configured build are removed.
the unchanged `./scripts/test` passed after final cleanup. no deployment or
production writes occurred.

residual work: [shared prose extraction](tickets/add-link-paste-mutates-url-input.md),
placement consolidation (since done: [saved placement](modules/add-content.md#saved-placement)),
[backend replay outcome](tickets/source-replay-is-reported-as-content-duplicate.md),
[joined replay](tickets/joined-url-admission-does-not-record-its-replay-key.md),
[replay after access loss](tickets/url-replay-requires-current-destination-write-access.md),
[canonical replay lifetime](tickets/canonical-source-teardown-deletes-admission-replay.md)
and the newly observed [workspace teardown body](tickets/workspace-session-unload-can-send-empty-body.md).
these remain with their responsible owners; no in-scope acceptance was waived.
