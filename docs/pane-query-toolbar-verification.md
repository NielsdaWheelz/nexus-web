# pane query toolbar verification

status: complete; original live qualification, current-base review and static checks passed.
dates: 2026-10-14–15 utc. branch: `codex/pane-query-toolbar-20261014`.
contract: [specification](pane-query-toolbar-plan.md).

## method and source

ordinary browser sign-in → next/bff (`localhost:3199`) → real api (`:8199`)
→ isolated postgres, supabase auth and minio. task identity:
`nexus-pane-query-20261014`; data ports 27901/27902, auth ports 27911/27912/27914.
invitation/password acceptance and fresh-context ordinary login passed.
product interfaces created 106 libraries, three pages, two resource notes and
an uploaded epub, processed by the current-source linux worker for reader find.
no table seeding, auth bypass, fabricated success body or production writes.
held/aborted real requests exposed pending/failure behavior.

the disposable external harness lived at
`/private/tmp/nexus-pane-query-proof-20261014`. commands were its
`harness/{baseline,green,interactions,engines,supplementary}.cjs` node entrypoints and
`native-zoom/check{,-unsupported}.py` through its disposable python environment.
the sole permanent check remains `./scripts/test`.

baseline head: `367da80e0c1beb1c426f6d2d72201b0733809b50`, clean web source.
all four final node runs record identical start/end source:

- served-source tree sha256: `9155f72b1886ccfa42e609903b431f8acd7e1ab9deb77a5db83306f28b27f642`;
- web diff sha256: `12cbaffcf51986fbaa3a18b606758822447b9518e3a25fe5516b2ba522ee0272`.

these identify the uncommitted implementation, rather than claiming baseline
head contains it. tree identity hashes the json array of sorted path/file-sha256
pairs for 1,168 tracked/nonignored source files under `apps/web`, `apps/api`,
`apps/worker`, `python`, `node/ingest` and `migrations`; generated/ignored
runtime files and docs are excluded. web identity hashes `git diff -- apps/web/src`.

## red, correction, green

[baseline receipt](assets/pane-query-toolbar/baseline.json), firefox 148.0.2:
nine failing observations across five defects; 200-ascii control passed.

| defect | baseline red | final green |
|---|---|---|
| alignment | input/select top difference 10.783px at 611px on lectern/libraries | both top edges 108px; both boxes 32px high |
| repeated count | duplicate 20.8px details row, tab stop | one default complete count; details zero height, no tab stop; status subtree retained |
| clear movement | first character shrank input 36px | unchanged bounds through typing/clear and draft/applied divergence |
| browse length | native entry retained only 100 supplementary characters / 100 normalized decomposed letters | complete 200-code-point normalized requests reach real local nexus/pdf endpoints with 200 responses |
| browse noun | `8 of 8 sources settled` | `8 of 8 searches finished`; unavailable searches remain separately named |

[before](assets/pane-query-toolbar/baseline-libraries-611.png),
[after 611px](assets/pane-query-toolbar/libraries-611.png),
[after 320px](assets/pane-query-toolbar/libraries-320.png).

an integrated red exposed a cyclic intrinsic-size constraint: the proposed
12rem sort minimum filled its group and stranded the label (25.55px offset).
removing that floor lets native option content own width. short vocabularies
consequently use narrower fields. no route offsets or new sizing api were added.
resource status visibility was also reduced to direct `true`, eliminating an
unnecessary helper call. independent geometry/interaction reviews found no
remaining ownership, focus, content or primitive-sizing blocker.

13 named live groups passed: [core 3/3](assets/pane-query-toolbar/green.json),
[interactions 5/5](assets/pane-query-toolbar/interactions.json),
[engine/coarse/control 5/5](assets/pane-query-toolbar/engines.json).
one [supplementary client case](assets/pane-query-toolbar/supplementary.json)
proves unsupported order/reset; its imports capture adds evidence, not a new case.

| acceptance | observed |
|---|---|
| geometry and entry | lectern/libraries at 611/320px; stable input node, selection, clear bounds and expanded disclosure across resize; non-pane creation input remains 36px; no horizontal toolbar overflow |
| counts and lifecycle | real 106-library pagination: `100 libraries in 100 loaded`, filtered `99 matches in 100 loaded`, retained updating/failure copy; default/zero/whitespace/reset; description/live ids and mounted status retained; collapsing details returns owned focus |
| refinements | keyboard radio/checkbox changes, chip removal, clear/reset/escape destinations; imports with seven chips/options uses one 171px scrollport for 3174px content, no nested overflow; keyboard scrolling and body access pass ([chips](assets/pane-query-toolbar/imports-expanded-320.png), [options after scrolling](assets/pane-query-toolbar/imports-options-320.png)) |
| domain semantics | browse draft/applied scope and clear; imports draft emits no request, explicit submit and refresh use applied text; reactive people-kind search returns 200; resource unique idle count/subset retained; reader 100 matches, next/reverse/wrap, return restored position (follow-up below), results and mobile close pass |
| unicode | native insertion retains 200 ascii, 200 emoji and 200 decomposed letters; normalized 201 remains editable but enter/click emit no search. firefox strips c0 from its input, so c1 u+0085 proves its control rejection; chromium retains exact `a\u0001b` and rejects it through enter/click |
| native controls | firefox 148.0.2, chromium 147.0.7727.15 and webkit 26.4 native selects/clear pass; chromium true coarse-pointer emulation at 390px gives 44px fields/buttons, no toolbar overflow |

all adapters migrated together; status visibility is required, not defaulted.
collection publishers reuse actual header metadata and their existing reset
predicate. resource, browse, imports, search and find keep distinct status owners.

## reader return outcome

final review rejected the original `returnToReading: true` flag as proof of
restoration: it recorded a click only. a focused follow-up rebuilt ordinary
auth/upload/worker publication plus ordinary Lectern `EnsureItem` admission
with one long epub under
`nexus-pane-return-20261015`, web/api 3209/8209, external root
`/private/tmp/nexus-pane-return-proof-20261015`. no application source changed.
command: `node harness/reader-return.cjs`; firefox 148.0.2.

[direct outcome receipt](assets/pane-query-toolbar/reader-return.json): genuine
wheel input establishes paragraph 011 at 146.400009px relative to the reading
area, scroll 1460. find visibly reveals the unique distant match at scroll
10175. return restores the same paragraph/unit at 146.400009px (0px error),
and retires both held-position actions and status. independent assertion and
receipt review passed before disposal. [origin](assets/pane-query-toolbar/reader-origin.png),
[find destination](assets/pane-query-toolbar/reader-find-destination.png),
[returned](assets/pane-query-toolbar/reader-returned.png).
the follow-up records the same source tree/diff digests as the original runs.

## actual enlargement and content

stock firefox 158.0, private profile, marionette native browser zoom controls:
page `fullZoom=2,textZoom=1`; text-only `fullZoom=1,textZoom=2`. no css font
substitution. both library and actual unsupported-order podcast selects pass
at measured 320px panes. [native receipt](assets/pane-query-toolbar/native-zoom.json),
[unsupported-order receipt](assets/pane-query-toolbar/native-unsupported-order.json).

text-only enlargement changes field font 13→26px, label ink height 17→33px,
and input height 32→64px. the label stacks; the native select fills its row.
all 27 authored sort strings, measured on a detached canvas with the actual
select's computed font, fit the enlarged full-row text budget: widest
233.83px, available 246px. this supplements the native field observations;
it does not claim every populated domain was exercised. actual current
options fit their native controls.
the unsupported raw value remains intact behind bounded `Unsupported order`;
its existing failure and reset remain available.
[200% text](assets/pane-query-toolbar/native-text.png),
[200% page zoom, 320px css viewport](assets/pane-query-toolbar/native-full.png),
[unsupported at 200% text](assets/pane-query-toolbar/native-unsupported-text.png).

## limits and interruption

spoken assistive-technology behavior is unobserved; the
[existing debt](tickets/pane-controls-live-proof-blocked.md) remains open.
coarse-pointer evidence is emulation, not physical android. external browse
provider success and populated podcast ingestion were not qualified. podcast
configuration remains disabled; unsupported and default requests return the
existing 404, so this proves toolbar value/error/reset handling, not backend
invalid-sort validation. all-family media search returns missing-credential
`E_INTERNAL`; reactive timing uses the ordinary provider-free people route.
these configuration boundaries were preserved, not bypassed. see the
[credential defect](tickets/indexing-without-credential-is-a-child-defect.md).
the native text check also exposed an unrelated
[feedback layout defect](tickets/feedback-notice-compresses-enlarged-text.md).

at 06:55 utc a parallel corpus restore exhausted shared storage; task postgres
reported read-only storage and docker hung. the restore owner removed only its
duplicate dump and restarted the backend before toolbar coordination began.
toolbar issued no shared restart/prune/reset. recovered task services retained
all 106 libraries; fresh login and bff create201/delete204 passed. interrupted
runs/setup failures are excluded from application red/green; final runs passed
after recovery. coordination window closed; small local writers released.
remaining host capacity risk is [tracked](tickets/macbook-docker-storage-headroom.md).

## static checks and disposal

`./scripts/test` passed with exit 0 after the final source change. all static
checks passed, including eslint/typescript, generated contracts and the single
migration head `0278`. the existing css minifier emitted `::highlight` warnings;
the gate succeeded. these live/static results describe the original source
snapshot above; merge integration is recorded separately below.
both disposable stacks are removed: process groups, seven containers, three
volumes, two networks and the owned worker image per stack; private harnesses,
credentials, profiles, fixtures, logs, task build caches and temporary dependency
symlinks are deleted. task ports are closed. shared dependencies/caches and other
projects were preserved. source digests match before/after disposal.
[initial cleanup](assets/pane-query-toolbar/cleanup-initial.json),
[follow-up cleanup](assets/pane-query-toolbar/cleanup-final.json).
both external roots were removed after retaining these sanitized receipts.

five scoped tickets are resolved and deleted. the stale partial-copy ticket
was also deleted: baseline `8208f1fb6` already repaired its formatter, and the
live partial/retained cases confirm the present copy. unrelated tickets stay
open. retained json/png files are inert evidence; no executable test enters
the checkout.

## merge integration

rebased onto upstream `7bc7c8a13` after its wire/domain reauthoring. current
publishers are migrated at their new owners: `SearchControls` and
`OutlineEditor`; deleted `useResourceSurfaceFilterRows` stays deleted.
current domain state/data owners survive; no old wire, fetch or resource APIs
are restored. shared toolbar, primitive density, refinement measurement and
text-reader return mechanisms are unchanged by upstream. the original live
receipts remain evidence for their recorded source, not the new combined tree.

independent adapter/source review found no integration blocker. all 13 current
publishers migrate; the six shared layout/status modules are byte-for-byte the
live-qualified versions. domain controllers, wire shapes and text-reader
positioning keep current upstream ownership. new library-sort raw-value content
is a separate [source-audit follow-up](tickets/library-unknown-sort-label-is-unbounded.md).

fresh `./scripts/test` passed, exit 0; migration head `0286`. the first
integration also passed remote ci and the preview build. concurrent navbar/menu
prs then advanced main to `69c00182c`; that integration changed no
file in the toolbar's app delta, and its only manual conflict was the issue
register. the full local gate passed again on that combined tree.

final source identity (1081 files, same method as above):
`e0e027ea768cf27265fcf0d88ad470e9611b50fcee760e61fe885d1968b93e09`.
web delta sha256 against `69c00182c8328f46cec893517971f87f03cdbf16`:
`f8220de5a0f3ed6d1cefdae144960bde794c3647302b99de7acb960e8c79f7bd`.
no additional provider/data journey is claimed from these integrations;
unchanged shared mechanisms, adapter review and fresh gates establish their
bounded evidence.
