# pane find implementation plan

status: implemented and verified within the owner-approved exceptions and
recorded limits; disposable resources deleted. see [the receipt](find-bar-verification.md).
origin: 2026-10-16; surveyed source `69c00182c`.

remove idle find narration and its layout/focus footprint. make return to the
reading position cancel movement without stranding a pending search. preserve
focus when retry/return controls disappear. resolved issue evidence lives in
[the verification record](find-bar-verification.md).

owner decisions: new query edits resume automatic navigation after return;
live checks use an isolated local/devbox stack. implementation authorized
2026-10-16. owner later waived accessibility-specific testing and authorized
recording the unavailable partial-transcript fixture as an open verification
issue; ordinary keyboard, touch and layout checks remain.

## target behavior and content

the presentation designer owns this mapping and rendered review. good content
identifies state/recovery, qualifies incomplete evidence and never repeats the
placeholder. reuse existing labels and controls.

| state | visible content | placement |
| --- | --- | --- |
| idle | nothing; no title, instruction, zero count or replacement hint | absent |
| source not ready | `Not ready`; disabled field | inline |
| searching | `Searching…` | inline |
| complete, zero matches | `No matches` | inline |
| complete, matches | `3/17`; actual active ordinal and count | inline beside match controls |
| partial results | `3 of 17 matches in the available transcript; results are incomplete.`; zero uses `No matches` with the same qualification | details |
| too many | `More than 2000 matches. Refine your search.`; derive the limit from `FIND_LIMIT` | details |
| failed | existing domain failure message verbatim; retain retry and applicable options | details |

derive ordinal/count and the partial descriptor from `FindResult`; use `match`
for one, `matches` otherwise. zero partial is `No matches in the {partial};
results are incomplete.` do not hardcode the transcript descriptor.
derive visible and spoken content together in `FindBar`; no content registry.
speech expands numeric shorthand to `3 of 17 matches`, announces wrapping to the
first/last match, and includes partial/failure meaning. not-ready speech is
`Find is not ready.` idle speech is empty. one persistent `sr-only` region with
`role="status"`, polite updates and atomic text lives outside changing toolbar
placement; visible copies are not additional live regions. keep full visible
diagnostics accessible. the numeric visual shorthand may be aria-hidden because
the full description remains accessible. follow [the status technique](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA22).

`FindResults` keeps its list, incomplete-results qualification and recovery;
empty/error states use full prose, never numeric shorthand or another live
region. idle emits no message or padding; retain the unpadded root through a
transient idle state while the companion remains mounted. ordinary clear closes transient
results. the return feature's interaction designer owns its content contract:
retain `Return to reading position`; it means move back while preserving find,
not clear, undo, or pause. add no confirmation or success message.

preserve match case, whole word, captured scope, removable chips, results and
return controls. preserve placeholder/name, enter/shift-enter, ime handling,
desktop escape-clear, mobile escape-close, options escape and shortcut ownership.
unsupported/resolving panes retain native browser find.
opening/focusing find captures no reading origin. find navigation does not adopt
saved reading progress.

## composition and presentation api

sources supply matches and movement; `useFind` owns search intent and
cancellation; `FindBar` owns content; `PaneQueryToolbar` owns field, layout,
options and focus; `PaneShell` owns placement/disclosure; companion owns results
disclosure and its return focus. no backend, wire, database or persisted schema
changes. retain `FindController`, `FindResult` and `FindSource` public signatures.

replace the toolbar's required status object with this optional property:

```ts
readonly status?: {
  readonly placement: "Inline" | "Details";
  readonly id: string;
  readonly content: ReactNode;
};
```

supplied status asserts meaningful visible content; omit it for idle find.
`placement` is required, with no default/compatibility branch. `id` names an
existing caller-owned description; find points to its persistent full-text
region. build `aria-describedby` only from supplied status and actual input
errors. toolbar owns no announcement timing or domain-state interpretation.

inline status sits immediately before existing match actions. details are
present only for an applied/draft mismatch, nonempty chips, input error,
`Details` status, expanded options or reset action. derive that condition from
these explicit inputs, never from `ReactNode` truthiness or DOM introspection.

retain the mounted refinements/options subtree and set `hidden={!hasDetails}`;
add `.refinements[hidden] { display: none; }`. remove its tab stop while hidden.
this removes layout/accessibility footprint without discarding author-filter
drafts on collapse. preserve bounded scrolling and the existing
`data-pane-query-refinements` marker; shell measurement already handles zero
height. no new geometry observer or `PaneShell` implementation change.

preserve focus-before-hide for clear, reset, chips and options. capture focus
ownership before hiding details; a post-hide active-element check can miss blur.
if the group/descendant owns focus, focus the enabled input with `preventScroll`;
if disabled, reuse `findPaneChromeFocusTarget` then `findPaneLandmarkFocusTarget`
from `lib/workspace/paneDom.ts`, using the existing pane runtime. never steal
focus already transferred to a surviving control. retain options ids/trigger
return; add no focus manager. synchronously before bar retry/return, focus its enabled input;
before companion retry, focus its existing results container, kept stable across
idle/searching/results, named `Search results` and given `tabIndex=-1`. neither
action adds a tab stop. focus repair must not scroll or refocus after completion;
requested find/return movement remains intentional.

## search and movement contract

inside the existing find lifetime, replace the shared operation with independent
computation and movement abort controllers. keep one private boolean for whether
the current search may automatically reveal its initial match. this is permission
for pending movement, not a new user mode.

| event | computation | movement and automatic reveal |
| --- | --- | --- |
| changed query/options; retry | invalidate old work and publish searching synchronously for nonempty query; schedule current search; empty stays idle | abort old movement; allow new automatic reveal synchronously |
| return | keep current work and eventual results | revoke permission synchronously, abort movement, restore origin, clear returnable |
| step/result activation | keep settled results | abort previous movement; explicitly reveal chosen match regardless of automatic permission |
| clear | abort, empty query/results/paint | revoke permission and abort; retain preferences and held return origin |
| publication key/lifetime replacement | abort retired work; retain query/preferences and recapture against ready source | abort retired movement; start replacement search with automatic permission |
| owner retirement/unmount | abort | abort; owner retirement resets session |

effect setup captures its computation signal; it must not snapshot or re-enable
movement permission. return between an input event and its passive effect still
wins. query-effect cleanup aborts its captured computation/automatic movement,
never a newer command's work. lifetime retirement/unmount aborts its current
computation AND movement, including later explicit steps. same-key source-wrapper
changes do not recapture scope or rearm permission. unchanged query/options are
no-ops; empty query follows clear.

pass the computation signal to `source.search` and movement signal to
`source.reveal`. publish rows only from current uncancelled computation; reveal
automatically only after rechecking the current permission and computation
signal immediately before movement. never create fresh movement authority
after return merely because computation completed. late cancelled reveal cannot
move, publish failure, report activation success or set returnable. explicit next
or a new edit remains usable afterward. preserve classified failures, defect
handling, frozen scope and publication fencing; reveal catches use the movement
signal. delete the old shared `begin`
path; add no cancellation framework, generations or public mode/schema.

## work boundaries and files

all source paths below are relative to `apps/web/src`. one writer per boundary;
the presentation and interaction designers review their respective features
before coding and again against the rendered result.

| owner | exclusive files and responsibility |
| --- | --- |
| toolbar engineer | `components/workspace/PaneQueryToolbar.tsx`, its css; new status contract, conditional footprint and focus; mechanical consumer migration below |
| find presentation engineer + content designer | `components/find/FindBar.tsx`, `Find.module.css`; state/copy projection, persistent announcement and companion idle handling |
| find behavior engineer + interaction designer | `lib/find/useFind.ts`; split cancellation and return contract; update `lib/find/find.ts` contract comment only if needed |
| verification engineer | disposable driver/fixtures outside checkout; live acceptance and concise `docs/find-bar-verification.md` receipts |
| integration reviewer | adversarial review at each gate; current contract docs, issue closure and final deletion review |

hard-cut all 13 toolbar callers together. find supplies the new mapping; add
explicit `Details` placement only in the other 12, preserving their content and
timing: `components/imports/ImportsToolbar.tsx`,
`components/notes/OutlineEditor.tsx`, and these files under
`app/(authenticated)/`: `authors/[handle]/AuthorPaneBody.tsx`,
`browse/BrowsePaneBody.tsx`, `conversations/ConversationsPaneBody.tsx`,
`lectern/LecternPaneBody.tsx`, `libraries/LibrariesPaneBody.tsx`,
`libraries/[id]/LibraryPaneBody.tsx`, `notes/NotesPaneBody.tsx`,
`podcasts/PodcastsPaneBody.tsx`, `podcasts/[podcastId]/PodcastDetailPaneBody.tsx`,
`search/SearchControls.tsx`. confirm the census before editing.

reuse `PaneFilterRowsStatus`, `AppliedFilters`, `ContributorFilter`, `Input`,
`Button`, `ChoiceField`, existing `sr-only` and control-size tokens. no new
toolbar, general feedback schema, debounce policy or filter redesign. remove
obsolete idle copy, empty wrapper paths, redundant styles and old cancellation
helpers only when this cutover makes them unused. unrelated findings get tickets.

## live acceptance and execution

the requested disposable red/green/refactor workflow is a task-specific exception
to [testing standards](local-rules/testing-standards.md). `./scripts/test` remains
the sole permanent automated gate and is unchanged.

use a task-owned temporary directory with pinned browser-driver dependencies,
an authenticated browser and the actual isolated web/bff/api/data stack. obtain
a stable conversation, long text, a real pdf and a partial transcript through
normal product paths or existing isolated data. no fabricated responses, auth
bypasses or production test hooks. absent prerequisites block their cases.

| case | acceptance |
| --- | --- |
| idle/clear | no instruction, vacant row, hidden-group tab stop or stale description; useful controls remain |
| normal find | search/zero/count, next/previous/wrap, results preview, clear and return work; query/options and saved progress stay coherent; bar retry/return and companion retry retain focus |
| meaningful exceptions | real partial transcript remains qualified, overflow derives actual limit, available failure/retry remains readable and functional |
| return race | after a first match, edit query then return before debounce completes; new results settle, origin remains, no late jump; next and a further edit navigate normally |
| supersession | rapid edits, clear and source replacement reject stale results/movement; real pdf navigation remains cancellable |
| shared presentation | collection counts/reset still work; search author draft survives options close/reopen; last-chip removal and hiding focused details preserve focus, including transition to not-ready |
| layout/ordinary input | empty and active states at 320px pane, enlarged text and phone keyboard; controls reachable; accessibility-specific checks waived by owner |

for the race, [install browser clock control](https://playwright.dev/docs/clock)
before page load; let the real first search settle, pause timers, edit and return
through the ui, then advance with `clock.runFor` and resume the clock. use two
queries with different results and record the original reading anchor;
verify it remains after the new results settle. this controls scheduling, not
data or app logic. also run ordinary navigation with the real clock. do not invent
an async conversation provider to test unreachable interleavings. assertions observe
text, focus, viewport/reading state and results, not hook internals or copied
implementation constants.

1. freeze contracts and fixture feasibility; independent reviewer challenges
   state/copy coverage, cancellation ordering and scope.
2. write temporary cases; capture baseline reds for idle presentation, return
   race and transient-action focus, plus preservation cases. setup failure is not red.
3. implement the three owned boundaries; migrate all callers in one cut.
   review APIs, absent/hidden semantics, synchronous return authority and stale
   continuations before integration.
4. reach green in the primary browser; repeat layout/focus in a second supported
   engine and inspect the real phone keyboard. screen-reader checks were waived
   by the owner. designers reject cramped controls and misleading copy.
5. refactor dead/duplicate paths; rerun affected live cases and `./scripts/test`.
   reviewer checks the final diff against every contract, not just green tests.
6. record baseline/final source and served-build identity, environment, fixture
   identifiers, case outcomes and material limits. delete only task-owned tests,
   drivers, dependencies and fixtures; rerun `./scripts/test` after cleanup.

update `docs/modules/workspace.md` and the api, ordering and geometry contracts in
`docs/pane-controls-plan.md`; update the find paragraph in
`docs/modules/reader-implementation.md` for split cancellation. remove the three
resolved tickets/register entries only after acceptance passes. retain the short
verification record, not a permanent suite. no deployment in this scope.

## costs and exclusions

inline feedback spends width; controls may wrap rather than shrink. real warnings
and expanded options still spend height. keeping hidden options mounted retains
their existing memory/state cost. explicit placement touches 12 otherwise
unchanged callers. separate cancellation requires two work handles and one
permission flag; return leaves computation running, so counts/highlights may
update while the viewport stays at the origin. isolated live checks require
setup; deleting them removes future automated regression coverage, so retain
precise outcomes and reproduction steps.

no matcher/ranking/backend/schema changes, new persistence, global feedback
unification, broader toolbar copy cleanup, reader navigation redesign, permanent
test infrastructure or one-line-at-all-widths requirement.
