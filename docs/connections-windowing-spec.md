# bounded connections rendering

investigation and proposed design, 2026-10-28; pr 4 of the release repair scope.
source reviewed at `96a3b7bdf`. published for review at the owner's request. specification only;
no application code, runtime, device or production state changed. preserve the
existing [mobile companion contract](https://github.com/NielsdaWheelz/nexus-web/pull/857). the mechanism
below needs the named isolated experiment before implementation is expanded.
repair the required large-book journey; a universal dom/byte bound for arbitrary
rich documents is not a requirement of this one-user release.

## outcome and known evidence

large valid books must allow responsive first-open, filtering, disclosure,
source reveal/return and dismissal in the connections inspector. current
`EvidencePane.tsx` maps every placed, whole-document and unavailable group.
`EvidenceRow.tsx` hides filtered rows rather than avoiding their mount;
`ResourceOutlineRow.tsx` can mount expanded descendants.

the recorded 100-chapter book has 10,000 references, 20,000 apparatus items and
1,640,401 canonical characters. connections missed its ordinary 15-second
readiness deadline; subsequent browser readback stalled. a smaller case mounted
234,643 nodes; an older production observation counted 401,951. these are distinct
recorded runs, not a fresh benchmark of current main. fresh media defaults to
connections, so the defect blocks the mobile companion release.

## established source facts

| boundary | current owner and consequence |
| --- | --- |
| collection | `EvidencePane.tsx:121-178,429-440,504-511` combines local highlights/links and remote roots, computes complete facets/source order, then mounts every group. filtering and desktop alignment set `hidden`; they do not retire row work. |
| preparation | `placed` does `markers.find` for each entry; unavailable classification uses `whole.includes` for each entry; each rendered row finds its placement. these are repeated linear lookups, not measured explanations of the recorded stall. |
| row cost | `ResourceOutlineRow.tsx:289-298` registers every mounted resource for child-availability probes; `useOutlineChildren.ts` batches those descriptors in hundreds. full passage bodies can also start their own excerpt reads. admission must precede these owners, not merely hide their dom. |
| geometry | desktop follow measures source passages, finds a focused/active pivot and resolves collisions with actual row heights. normal flow uses two existing scrollports and saves occurrence-relative offsets. replacing it with a constant-height index would violate both layouts. |
| restoration | `EvidencePane.tsx:220-262` waits for every remembered source disclosure to register a terminal layout. an offscreen unmounted disclosure never registers, so a naive window leaves restoration pending indefinitely. |
| nested content | `SourceNote.tsx:103-124` mounts all source targets; `RemoteConnections.tsx` maps its loaded facts while the list owner drains remaining pages. this is a source-supported risk for root-only windowing; the recorded timings do not isolate nested content as the cause. |
| authored editing | `LocalOutline` owns one native editor/controller, 48-row branch reads and its own 64-ref/16-mib admission contract. this is an editing/data window, not a variable-height viewport primitive. do not split its prosemirror dom or substitute a second editing controller. |
| retention | source-text disclosure and browse anchors already live in `Reader.Connections`; folds use `Resources.OutlineFolds`. workspace drafts survive row unmount through visit ownership, but `ReaderNoteEditorHost` has component-local draft cells. unmount safety cannot be inferred from the workspace path. |
| focus/actions | explicit arrivals resolve only after the target row mounts; unlink and cycle-return currently find neighbors/ancestors in the dom. contextual menus already pin ordinary index rows through `IndexRowWindow`; the connections owner currently supplies no such demand contract. |

the reusable index hook, `lib/collections/measuredIndexWindow.ts`, explicitly
requires uniform row geometry and measures one representative border box.
`collectionWindow.ts` supplies sparse rank/pin selection; its range arithmetic
also assumes uniform heights. reuse those ideas and existing menu integration,
not a false `UniformIndex` declaration or a generalized replacement of every list.

## contract and proposed ownership

the connections presentation owner admits rendering against one logical
collection and the existing scroll geometry. resource identity, data access,
commands, drafts, folds and reading position retain their current owners.

- preserve complete facets/counts/source ordering, including independent local
  and remote failure. windowing does not change result membership or permissions.
- preserve occurrence keys and source publication identity. estimates/measurements
  belong to that identity plus width/disclosure state; never reuse heights across
  source generations. a measured height may change without changing row meaning.
- profile preparation separately from react mount and browser layout. build keyed
  marker/placement/membership lookups if the repeated scans materially contribute;
  do not turn this repair into an unmeasured preparation rewrite.
- begin the experiment with a pane-local variable-height root window: estimated
  gaps and measured mounted heights, before expensive row owners mount. preserve
  the current nested semantics. extend admission into a disclosed source-target
  or fact list only if that list still breaks the required journey after roots
  are windowed. do not introduce a general virtual tree or nested scrollboxes.
- preserve native authored editors and their existing admission contracts. keep
  an occurrence mounted while its input, selection, menu/dialog or unsettled
  row-owned operation needs it. prove this through the existing lifecycle owners;
  do not introduce a second draft store or a general retention subsystem. already
  committed pending sync alone must not pin a row or acquire a loss warning.
- do not mount offscreen roots merely to start detail reads or child probes.
  preserve disclosure keys and reread through existing owners on remount. if a
  nested list needs windowing, apply the same rule at that specific boundary.
  do not copy the evidence corpus or eagerly restore every remembered detail.

the strongest objection is that root windowing may leave one disclosed list too
expensive. the experiment must test that case, not declare success from collapsed
roots. the opposing risk is inventing a virtual tree before finding which list
needs it. use the narrowest presentation seam that passes the actual journey;
if that requires duplicate graph traversal or editing ownership, stop and revise.

## restoration and interaction design

1. resolve the saved key from the complete logical order, not mounted dom.
   admit that occurrence and required ancestry, estimate its position, then
   correct its offset as admitted content reaches terminal layout. failed reads
   are terminal. other remembered offscreen disclosures must not block completion.
2. preserve explicit arrival precedence and `isCurrent()` fencing. reveal a
   requested offscreen occurrence before acknowledging it. publication mismatch
   retires browse geometry; a genuinely removed anchor returns to the natural
   start as the existing companion contract requires.
3. preserve the first visible identity/offset when heights, filters or widths
   change. user interaction ends restoration; late detail replies cannot pull
   the user back. retain the outer scroll offset and desktop alignment authority.
4. unlink recovery selects its successor from the complete logical
   order; cycle-return requests its existing ancestor by key. dom-only neighbor
   search cannot define behavior once rows are absent. retain interaction fencing
   so late command settlement does not steal newer focus.
5. before recycling, prove both host variants retain unfinished input and exact
   retry state. workspace visit drafts alone do not prove downloaded-reader
   safety. retain the existing active editor rather than inventing a bounded
   protected-work quota. measure its cost in the required interaction case.

## design-changing unknowns

- does a disclosed list in the required corpus still miss the interaction deadline
  after root windowing? if yes, identify that list and test a narrow local window.
  compare mount/query/observer counts so hidden data-owning components do not
  merely move the cost. nested windowing is a conditional design spike, not a
  prerequisite framework.
- a single rich excerpt or existing editor can be large; root/child row counts
  do not imply a universal dom/byte bound. inspect that cost if it explains a
  failure in the required corpus. arbitrary giant bodies are outside this repair;
  do not truncate evidence, split native editing dom or add body virtualization
  to satisfy a hypothetical bound. a failing real body remains a release blocker
  with a separately scoped content-owner fix.
- native browser find and selection across unmounted inspector content cannot
  remain exhaustive automatically. source-reader find is a separate owner.
  explicitly record and accept any change to this behavior before implementation;
  do not invent a replacement search product, add a duplicate hidden searchable
  corpus or silently claim unchanged native find. keyboard and
  assistive navigation must expose logical successors beyond the mounted window.
- choose overscan and height-estimate invalidation from the decisive experiment.
  no numeric window size is established by this source audit.

## smallest decisive experiment and stop criterion

after the contract is reviewed, use one temporary case in the canonical disposable
lab with the recorded representative large epub and a large disclosed branch from
that corpus. this turn starts no lab and changes no application code. the first
narrow prototype must exercise actual row owners and root windowing. only add a
local nested window if measurements show it is needed.

record baseline preparation time, first usable paint, mounted elements/components,
child/detail requests and resize observations. then prove the proposed admission
seam with ordinary first-open, far-target reveal and source-return: open a source
detail, move it offscreen, close/remount the companion, and return with the saved
offset while another remembered detail remains offscreen. repeat with a focused
annotation, unfinished input and an open menu; retire/supersede the target during
the operation. include all-items and desktop follow layouts.

the prototype passes when the required large-book journey meets ordinary deadlines,
root mount work tracks the visible/retained window, offscreen details do not block
restoration, and identity/focus/input/retry behavior survives. report the disclosed
branch's mounted work separately; passing root counts alone is insufficient.
stop expanding the mechanism once these cases pass. if a real body or branch still
fails, locate its cost and scope the smallest further fix; if resource ownership
must be duplicated, revise the design. do not relax deadlines to call it complete.

## acceptance, costs and dependencies

record the actual mounted-work counts and interaction times before green. repeat the
full representative first-open/filter/disclose/reveal/return/dismiss journey under
ordinary action deadlines. include true removals, partial/failed remote reads,
publication replacement, native keyboard traversal beyond the window, text
enlargement and resize. qualify final paired android back/header geometry and
downloaded-reader input retention; the earlier native proof predates later header
integration. separate source, disposable browser and installed-native evidence.

costs: variable-height estimates and correction, offscreen remount/read work,
explicit focus demand and retaining active editors. nested admission adds cost only
if the experiment requires it. any native-find change is a separate explicit
trade-off; no replacement search product is included. no content truncation,
silently collapsed disclosure or lost writing. the accepted limit is a proven
required corpus and interaction path, not a universal bound on arbitrary rich html.
this pr can proceed independently of database work; mounted query demand still
belongs in the combined release workload. use the canonical headless lab and
native ownership rules in [verification](local-rules/testing-standards.md).

the rendering and installed-native release observations are complete at their
recorded scopes. the representative book proves root scale with a small disclosed
branch, not arbitrary nested/rich-body bounds; inspector browser-native find and
cross-row selection remain mounted-only. article publication replacement used
unchanged source bytes; epub replacement remains owner-refused and partial
publication states are not promoted to runtime proof. exact evidence remains in
the implementation pr/private receipts. [release closeout](issues/release-search.md)
owns the separate remaining derived-preparation gate.
code: [connections owner](../apps/web/src/app/(authenticated)/media/[id]/evidence/EvidencePane.tsx).
