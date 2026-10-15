# inspector control verification

status: corrected local qualification, cleanup and final static gate passed.
production smoke has not occurred. date: 2026-10-15.
contract: [plan](inspector-control-plan.md).
[sanitized receipts](verification/inspector-control/receipts.json) retain
measurements, source identities and evidence limits.

## identity and method

baseline: `367da80e0c1beb1c426f6d2d72201b0733809b50`, unchanged during red.
initial implementation: `a9683fa25b86428f91616bd3be6dc38eb96762f4`; web-source
sha256 `90e4151b55d5e0b07a3dbc5ab0d0503e4878a1f80f3a99831eb72f360601c9cd`.
corrected implementation: `e22699ad09f24ce62ef3d50fb5aae95366fe8715`; web-source
sha256 `c4477f96d3539709ff7b0d52d64141fecbc9370300bd7c33f5e2ec50371c3b22`.
both source hashes cover 673 paths. the corrected production-mode build passed;
its local `/version` returned the corrected commit. initial and final post-cleanup
`./scripts/test` runs passed; the final gate exited 0 with migration head `0278`.

merge integration: main `7bc7c8a13d7f0c866bef49ad1fc218b603393594` was
integrated for pr #617. independent review confirmed its resource-ref
and snake_case wire changes survived; the inspector diff is unchanged. only the
issue register conflicted, and all entries were retained. the integrated
`./scripts/test` passed with migration head `0286`. its web-source digest is
`1de6a868134358f764bb2cc79552a5b1e5162c9aff754468ae98c717d1e6f32a`
over 728 paths. this is static integration proof; earlier live runs retain their
original source identities. production smoke remains pending.

subsequent integration: main `42113bf1ad488679e4e0d169ae20181e5db0c1d0`
added pr #627's overflow button. independent review preserved that primitive,
native refs/handlers and header spacing beside the inspector. the repeated
register conflict retained all entries; inspector entries now sit beside the
existing inspector issue. `./scripts/test` passed again at head `0286`. original
screenshots remain historical, including the earlier more-button appearance.

disposable playwright 1.59.1 drove browser → next/bff `:3198` → api `:8198`
→ isolated auth, database and storage. one article used ordinary extension
capture/upload/confirmation and normal linux ingestion; one ordinary library
supplied the long-title geometry case. browser authentication used the normal
password form. no mocked responses, auth bypass, fabricated workflow rows,
injected css or `matchMedia` replacements. coarse media was read back before
sizing assertions; forced colors used browser media emulation.

## observed outcomes

| check | evidence |
| --- | --- |
| genuine baseline red | visible caption, 16px glyph, 109.625×32px fine/coarse desktop target, native title, no custom help after 650ms; existing keyboard activation/focus return passed |
| initial chromium core | 13/13 passed: decorative 20px glyph; 32/44/48px targets; name/state/region; activation, focus, hover corridor, escape ordering, browser back, find-results restoration and mobile dismissal |
| initial lifecycle supplements | 7/7 passed: pending outside/unmount/menu cancellation, constant name/action copy, selectable caption, narrow geometry and adjacent-pane shortcut with visible help |
| reading continuity | real find-results restored contents with query preserved at 778px; mobile close/escape/back/scrim preserved nonzero position; corrected built replay also passed |
| mobile keyboard | fresh keyboard traversal revealed help within 200ms in chromium and supported webkit mobile layouts; touch itself showed no help |
| cross-browser | firefox 148.0.2 and webkit 26.4 passed focused pointer, escape, focus-return and narrow geometry; webkit also passed supported touch/mobile cases |
| geometry | long article: 320px reader plus 52px map rail; long-title library: actual 320px header with reachable, nonoverlapping controls in all three engines |
| visual review | independent designer accepted all 12 theme states, forced colors, the 320px library and native 200% capture |
| corrected engagement | detached-caption regression and sustained-trigger preservation passed in chromium, firefox and webkit, then against the corrected built chromium app |
| corrected affected replay | 6/6 passed: activation/focus, delay, hover corridor/escape, pending escape, command ordering and mobile behavior |
| corrected built artifact | ordinary authentication plus 7/7 affected checks passed, including real find-results; both engagement cases also passed on `:3197` |

before cleanup, adversarial review found a real defect on the initial candidate:
hover caption, escape, move away, focus the original trigger again, then tab
away. help remained despite neither hover nor trigger focus. [red](verification/inspector-control/caption-regression-red.png)
and [green](verification/inspector-control/caption-regression-green.png) accompany
exact focus/hover readback. the correction replaces a stale hover boolean with
the entered element's identity; blur retains help only if that element remains
connected. the positive control proves genuine trigger hover still retains help
across keyboard blur and closes when the pointer leaves.

the original matrix and visual evidence belong to `a9683fa25`. the correction
changes only five lifecycle expressions in the tooltip; markup and styles are
unchanged. independent source/design review accepted carrying the geometry and
appearance evidence across this bounded delta. affected replay belongs to
`e22699ad09`; earlier runs have not been relabeled.

initial and corrected native qualification each passed 3/3 using raw browser
protocol without focus emulation: actual 200% zoom and pending/visible dismissal
on trusted window blur.
outer width stayed 1440px, inner width changed 1440→720px, dpr 2→4 and visual
viewport scale stayed 1. help remained within the viewport and the control
reflowed to 48px mobile sizing. an early screenshot clipped the raster; a
corrected full viewport capture resolved that evidence gap on `a9683fa25`.
that designer-approved image retains its original provenance; unchanged markup
and styles support carry-forward. an optional new capture stalled in the browser
protocol, so the final corrected run omitted captures and retained successful
geometry and trusted blur readback.

initial failures also exposed harness errors: nested scrollport ambiguity,
inactive duplicate-pane selectors and an expectation that ignored retained
keyboard focus. the late firefox regression setup used reverse keyboard
traversal to reach the exact original trigger instead of traversing the entire
canvas; native tab-away remained the assertion. corrected affected checks
passed. shared docker recovery required starting only three existing owned
containers; volumes and shared services were preserved.

selected evidence: [baseline](verification/inspector-control/baseline-desktop.png),
[study](verification/inspector-control/study-hover.png),
[press](verification/inspector-control/press-hover.png),
[solar](verification/inspector-control/solar-hover.png),
[keyboard focus](verification/inspector-control/keyboard-focus.png),
[forced colors](verification/inspector-control/forced-colors.png),
[320px library](verification/inspector-control/library-320-header.png),
[native 200%](verification/inspector-control/zoom-200-native.png).

## limits and cleanup

firefox's touch context did not expose coarse-pointer media, so no firefox
mobile/coarse pass is claimed. webkit used native alt+tab under the existing mac
keyboard preference; no global setting changed. spoken screen-reader output and
physical android/ime remain unverified. browser semantics and a synthetic
composing event do not establish those observations.

port `3199` belonged to another task and was preserved. the corrected build uses
`3197` for both runtime and compiled origin. all production-mode qualification
was local; no production operation or production smoke occurred.

cleanup stopped the three verified app process groups and removed seven owned
containers, three fixture volumes and two networks. targeted inspection proves
them absent; all eight used ports are released. disposable test scripts, package
dependencies, browser profiles, private auth state and the owned dev `.next` cache
are deleted. the implementation worktree, normal locked dependencies, shared
browser cache and other tasks remain. the coordinator removed the detached build
worktree through git. the remaining campaign root was deleted and explicitly
verified absent. the
final post-cleanup static gate passed. it regenerated only normal ignored build
assets and route types; no fixture cache or test infrastructure was restored.

no repository suite, dependency, production seam or ci change was added. deleting
disposable tests relinquishes automatic regression replay; the contract and
sanitized receipt remain.
