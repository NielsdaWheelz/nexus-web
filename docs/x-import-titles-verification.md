# x title verification

2026-10-14; isolated branch `codex/x-import-titles`. initial source base
`b6768bee2469cbc3a43902302836a44d07a11ea7`, integrated with upstream
`fa62a6901`, then `f30a844a5`; migration `0277→0278`.
temporary checks follow the approved red/green/refactor/deletion sequence;
the permanent gate remains `./scripts/test`.

## observed

| boundary | result |
|---|---|
| source and admission | authored excerpts, full notes/alt text, one-hop graph, explicit enumeration, identity reuse without naming, atomic child obligations, lost claims, deletion and four authorization/rollback refusals passed on postgres |
| retained reading | pending/failed/unavailable/resource-limited/dead source work keeps its saved copy; exact dead-job repair and first-import failure passed |
| saved cursor | 12 real-db cases passed: all viewers, unicode/start/end, unique full/window matches, ambiguous/missing rejection, save/reset interleavings and no activity effects |
| title publication | 12 real-db cases passed: null restoration, unchanged stamp, source/title staleness, revoked access, lost claim, missing context, private evidence and byte limits; four real-worker preflight refusals opened zero generations |
| live content | eleven synthetic captured-source cases passed with stock codex 0.160.0, `gpt-6-luna`/`low`, one generation each and zero tools; 252 output tokens total. stance, abstention, sarcasm, spanish/cjk, truncated capture, late long-form qualification and nested-quote injection passed meaning review |
| actual x | post `20` imported over authenticated http, fetched from x, published by the normal background child under its 448-mib limit, then named by the native interactive worker; authenticated detail/reader passed. separate live image-post acquisition retained its absence of alt text |
| product | 15 copy/planner cases and eight actual callback cases passed; authenticated chrome 155 flow passed eight cases with zero page errors. canonical/quote selection, exact dom nodes and viewport survived title completion; completed lost-response refresh replay reused the receipt; naming failure still exposed refreshed content |
| migration | populated actual alembic upgrade passed six groups: historical bibliography outcomes, reviews/replay/usage, raw sql-null/json-null/object preservation, malformed outcomes, active work and open-generation refusals |
| cutover operator | frozen-target replay, stale/access refusal, legacy saved-copy initialization and inline child accounting passed; the qualified terminal manifest had zero unfinished/unaccounted obligations, retaining title failures explicitly |
| non-x | controlled ordinary task completion and no-findings/review/replay passed with real queue, scalar and contributor writes. live local document/resource reads succeeded; funded brave research remains blocked below |
| receipt recovery | escaping provider error, actual task cancellation, sigkill/dead-letter/next-attempt interruption, preserved terminal calls and late callback refusal passed |

source, metadata and reader owners reviewed each other's publication boundaries.
an independent session reviewed attribution, lock order, migration, capability
parity and operator accounting. a second peer review confirmed each resolution.
browser runtime checks passed again at `830c1eca` after the first rebase. the
subsequent `f30a844a5` integration preserves both lectern placement receipts and
pending source refresh receipts; its shared-action composition was peer-reviewed.

the independent review's five concrete findings received targeted red/green checks:
no repeated primary thread bodies; actual baseline photo/video canonical text and
terminal cursors conserved (including newly appended context); mixed-script/long
token excerpts; exact parent-completed census child accounting with two negative
provenance cases; mounted lost-202 confirmation after the notice expires while queued.
the last case passed real-db/menu/browser checks without relaxing fresh admission.

## limits and costs

the owner explicitly accepted [blocked bibliography live qualification](tickets/brave-search-payment-required.md):
both configured brave keys return http 402. no successful four-tool bibliography
claim is made. browser faults and accepted outputs were controlled external
boundaries; actual model quality was qualified separately.

source evidence duplicates captured text. one-hop/no-vision evidence and the byte
limit can leave source labels. null reruns restore them. exact cursor matching can
refuse edits; the saved copy remains. source changes add a sequential cursor read;
title admission adds one detail read. worker recovery may repeat inference.
reader text retains attachment source links; downloaded copies retain their
download-time labels because titles do not change content identity.

cross-navigation intent persistence, mutable embedded-child labels, non-x cursor
replacement and the preexisting queue/tool lock inversion remain separate tickets.
the reader fixes do not claim those broader contracts.
legitimate missing media-expansion behavior is an [unverified provider question](tickets/x-media-expansion-absence-unqualified.md),
not an observed capture defect; strict incomplete-response failure remains visible.

production release `134f4f4c3` aligned api/worker/web and upgraded `0277→0278`.
the controller retained a verified 1,270,557,222-byte r2 backup, sha256
`263bb620f1c3d205b46db5ba31e6ce20e18b24efda0ac605adf83a4f14fddf2a`.
verification read back the remote archive and traversed it with `pg_restore`;
it did not execute a database restore. 208 historical metadata jobs validated
after migration, including 72 raw sql-null dead results. no pre-migration
byte-for-byte hash baseline was obtained.

the first frozen census settled 54 targets: 52 refreshed, two saved-position
refusals, nine additional child titles; zero unfinished/unaccounted obligations.
this established accounting, not acceptance. production content review found an
implicit 30-day archive range, five mistranslated titles and one literal `null`
title. release `3a80349b8` corrected acquisition and language/null handling;
its fresh 1,270,981,168-byte backup starts at `0278`, sha256
`e83b604711845fe2550d75972273dc65682a6a066bf1bf001649549a2163294d`.
both releases used the canonical controller and aligned api/worker/web.
one position became exactly mappable after historical acquisition; the other
crosses an inline-quotation/embed boundary and is the owner's explicit
[preserved-copy exception](tickets/x-inline-quote-refresh-loses-saved-position.md).

the narrow archive correction passed two provider-boundary red/green checks and
detached real acquisition of the recoverable saved position. nine real-db language
input checks and nine ordinary native naming calls qualified the title correction:
seven faithful titles, one preserved invalid-output rejection, then one actual
json-null completion after explicit json instructions. no tools; 220 output tokens.
the original 54-request manifest remained byte-for-byte unchanged. a fresh
filtered manifest admitted 29 original threads plus one mistranslated standalone
post; all 30 source/title obligations and two new child titles settled successfully,
with zero unfinished/unaccounted work. the 29 threads retain 56 primary posts,
13 multi-post, largest 10; every primary predates the implicit 30-day window.
all enumerations exhausted; that does not prove missing-root ancestry is complete.
the exact cursor windows each match once: `00619` offset 67, `114a` offset 134.
the approved `8e08` cursor/publication/fragments/title stayed byte-identical.
three engagement rows, two completion facts and two overrides were conserved.

complete review read all 65 native x items: 64 current strict snapshots and one
approved retained-copy exception. all 64 current naming completions passed source/stamp/shape,
one-generation and zero-tool checks. all six original content defects, 30 recovery
parents and two children passed meaning review. the 32 new generations used
53,508 input and 765 output tokens. two untouched old titles still reversed
speaker/listener roles; this failed acceptance was retained until ordinary repair.
an isolated generic actor sentence failed one real call. explicit reported-speech
grammar then passed the two native cases and independent content review, preserving
non-title metadata, nonempty manual credits, source and reader rows. three calls
total, zero tools; the failed first result remains recorded. the final attribution
release `3839b96a0` completed through the canonical controller. api, both workers,
web and the release pointer agreed; all seven services were healthy at
schema `0278`. its verified backup is 1,271,225,421 bytes, sha256
`4c6f06829cfffb163e7e0edf162f09ad50a966faf3de31a41ee0bbaa27884971`,
receipt `/var/backups/nexus/r2/3839b96a0cf2f5c5c103e32917cea130b61c016f/receipt.json`.
independently observed disk space then was 2,633,871,360 bytes, above the 2-gib floor.
selective removal of unreferenced retired images restored that reserve; the
[controller's post-pull reserve gap](tickets/release-image-cache-consumes-disk-reserve.md)
remains separate work.

two normal replayable metadata requests repaired the residual labels without
source reacquisition. actual titles are `Job’s suffering and structural oppression`
and `Job hears a breakup cliché from the whirlwind`. independent review accepts
the first as a nominal topic label that omits the source's explicit contrast,
the second as an explicit listener construction; neither names the speaker
explicitly or repeats the prior misattribution. these
are recognition labels, not complete summaries. their two generations used
2,076 input and 42 output tokens, zero tools. media comparisons exclude only
`title`, `title_tsv`, `metadata_enriched_at` and `updated_at`; every other media field
matches. complete reader, fragment, credit and snapshot rows, including publication
timestamps, match the pinned baselines. complete old job and generation rows are
unchanged. the other 63 items retain their title, source identity, reader generation
and current successful naming job identity; no naming work remains unfinished.

the installed exact-`3839` android packet passed hash, retained cold entry,
canonical app link, same-account native google sign-in and offline return with
the default network absent. original network settings and empty shelf were restored;
the probe-owned copy was removed. the matching installed firefox extension passed
ordinary toolbar-popup authentication; production capture is explicitly deferred
by the owner. actual `03` title/body, metadata and expanded history passed,
including source attempts 1–3, search revisions 1–2 and both completed title
generations. nested operation details were not expanded. receipt:
`/tmp/nexus-session-entry-release-20261014/firefox-qualification/03-history-expanded-ui.json`.

actual bare-route `114a` reopening on `3839` FAILED on both arrival axes despite unchanged
canonical text and full cursor. isolated actual-module browser probes reproduce
late-image loss of a clamped saved endpoint and preceding-pane growth hiding the
active pane. separate source-reload probes also expose wrong-surface restoration,
input lifetime and queued old-coordinate saves. the combined correction is now
deployed as `0bd6619236`; consumer checks, cleanup and final session handoff are
accepted with the limits below.
native foreground browser qualification previously
exposed unrelated credential content in a tool transcript; that path was stopped
and the [incident](tickets/native-browser-credential-output.md) remains unresolved.

## reader correction

pr #614 merged qualified commit `8cbad9c81e3d94bc3d48c7caee55e991dc787e33`
as `0bd6619236ae911bb35741aa2017a4a44312cdf2`, preserving the exact tree
`2d32a0afe68d0ce35d34c150486056fc009a769a`. first backend run `38669629402`,
attempt 1, succeeded. api, workers, web and the release pointer agree on `0bd`;
the canonical custom alias points to `dpl_Fm5CBnH3BZjFTRMhHFWGhvUk3DkF`.
all seven services are healthy at schema `0278`; final independently observed
disk space is 2,631,368,704 bytes, above the 2-gib floor.

the fresh verified backup is 1,268,609,995 bytes, sha256
`f6f5b1d6c9de6af020f224736e2eb5e3ff2e4215538087bbe525e19eae62ccd9`, receipt
`/var/backups/nexus/r2/0bd6619236ae911bb35741aa2017a4a44312cdf2/receipt.json`.
the controller's direct exit code is unavailable. its retained final success line,
independent deployed-state observations and absence of a remaining controller
establish completion; the controller was not replayed. remote archive verification
and traversal passed; no database restore was executed. evidence:
`reader-release-independent-audit.json` in the proof directory.

`reader-release-conservation-audit.json` records unchanged source/title/reader/credit
hashes and current title-job identities for all 65 native x items and 64 snapshots.
all 149 scoped source attempts, 179 source/metadata jobs and 95 enrichment
generations retain complete row hashes; no scoped work is unfinished. the complete
`114a` and approved `8e08` cursor/publication/fragment collections are unchanged.
this audit makes no claim about unrelated media or engagement, or browser behavior.

the exact-`0bd` android packet passed physical qualification with explicit limits.
the pulled apk hash is
`cc50b1c6a90f0447696d811d4159b50866226e9dd7ce247c4656301ceb92076c`,
version `0.3.1`, code `21`, with the expected signer and retained app data.
the published latest release `android-v0.3.1` is pinned to `0bd6619236`;
all six downloaded release assets are byte-equal to the qualified artifacts.
authenticated cold launcher entry, unscoped canonical link delivery to the
already-running app, packaged `03` text reading with no default network, and online
return passed. network preferences and the empty 0-byte shelf were restored;
only the probe-owned download and execution files were removed. app-link state
changed only its installation verification uuid; signer, verified domain, allowed
handling and user selections were conserved, including disabled host selection.
general cold automatic link routing remains unestablished; natural token
expiry/renewal and password entry were unobserved. native google sign-in remains
the historical `3839` proof on unchanged owners, not a repeated `0bd` result.
no device `114a` or pdf replay was performed. receipts: `summary.json` and `cleanup.json` under
`/tmp/nexus-session-entry-release-20261014/physical-android/final-0bd6619/`;
independent artifact review: `final-android-receipt-review.md` in the proof directory.

the first bare-route `114a` opening on exact `0bd` passed both arrival axes without
query/hash targeting or operator input/scroll. its 664-px pane occupied x=616–1280
inside the canvas x=240–1280. the authored glyph at 133 witnesses endpoint 134;
it was visible at scrolltop 560.55/max 561. this valid bottom clamp leaves it
353.45 px below the reading line; it is not line-aligned. geometry stayed stable
for 7.185 seconds after image/font completion and on the passive return at 238 seconds.
the ordinary cursor response matched the full positioned handoff at revision 6,
fragment `826c3bed-826d-482c-a338-c1f5dc08b065`, offset 134. the public reader showed
generation 3, three units, index 2 and matching canonical/window hashes. publication
uuid and timestamps remain conserved owner-audit facts; public reader wire omits them.

the original-context observer stayed healthy from before boot at 02:35:37.708
through explicit unsubscribe at 03:02:48.751 utc on 2026-10-15, covering the late
02:54:13.854 return. all 179 request rows have start and terminal events.
document, reader, reader-state and map gets returned 200; reader-state puts and
reading-activity posts were zero, while one workspace autosave put occurred.
this absence claim ends before normal browser cleanup and excludes other contexts.
the ancillary [favicon failure](tickets/final-firefox-favicon-request-failed.md)
remains unassigned.
the earlier `3839` failure remains historical. browser receipts under
`/tmp/nexus-session-entry-release-20261014/firefox-qualification/`:
`final-0bd-114a-arrival.json`, `final-0bd-114a-late-arrival.json`,
`final-0bd-114a-cursor.json`, `final-0bd-114a-publication.json` and
`final-0bd-network-closing.json`.

actual `03` title, three-post body, metadata and expanded history passed on `0bd`.
current/prior title operation ids matched. nested operation details stayed collapsed;
their identifiers were checked in mounted dom, and the screenshot covers only its
viewport, not every below-fold entry. receipts in the same directory:
`final-0bd-03-reader.json`, `final-0bd-03-metadata-settled.json` and
`final-0bd-03-history-expanded.json`.

the exact unsigned extension archive hash is
`3e8bab77294eaf3daaa61bf5b48ebaa571e53d4ce7c59735479bbc7ef4bdc172`;
all ten installed payloads matched. the actual toolbar popup retained the expected
owner's authenticated session. fresh sign-in, renewal and capture were not tested;
production capture remains owner-deferred. `temporarilyInstalled=true`: activation
ended with normal owned firefox close; persistent installation is not claimed.
the package, profiles and shared dependencies were preserved. owned observer,
driver, browser and helper cleanup completed, with the owned ports closed.
receipts in the same directory: `final-0bd-extension-installed.json`,
`final-0bd-extension-popup-before.json`, `final-0bd-network-cleanup.json` and
`final-0bd-execution-cleanup.json`.

the accepted final handoff is
`/tmp/nexus-book-repair-20261014/session-release-handoff.json`, sha256
`4fba4debfc461a72b08dca8952860eeec0533f37720c3f253c1922c5e68cce13`.
all scoped consumer receipts and cleanup are complete. book production writes
remain with its coordinator after both handoffs and its own current pre-apply
census and backup; the `0bd` release backup is not the book pre-apply backup.
the separately flagged docs-only main advance leaves deployed runtime and packets
at `0bd`; it requires no controller replay or packet rebind. no new source/model
requests were made for this closeout.

the consolidated correction keeps existing module boundaries and adds no api,
schema, dependency or permanent test seam. local red/green qualification passed:

- four actual-react text cases: matching-surface restore, prior-input restore,
  during-load veto without incidental saves, and title-only node/selection preservation;
- ten actual-runtime/progress browser cases: queued/in-flight/failed old saves,
  explicit `readFrom`, title-only pending save, cursor failure/recovery, interrupted
  source binding and ordinary reset/prepare/reconcile interleavings;
- real pdf.js/react: same-identity title preserves exact viewer/page/canvas nodes,
  page 2 at 125% and scroll 2611 without extra file/cursor/position/save; changed
  publication/file still replaces and restores correctly;
- fifteen navigator/reader checks against the final combined source: five actual
  firefox text-layout cases and ten public runtime/navigation contracts;
- eleven actual-hook/firefox canvas cases: instant activation, delayed growth,
  shrink, horizontal pan/release, nested consumption, vertical reading, sibling
  rebind, handled controls, touch intent and a classic scrollbar gutter.

receipts: `reader-restoration-green-summary.json`,
`reader-progress-green-summary.json`, `reader-progress-green-public-prepare-settled.json`
and `pdf-title-green.json` in the proof directory. input ports in the progress
check are controlled public interfaces, not a physical gesture claim. the pdf
uses actual trusted wheel/button input and the installed renderer. fixture-only
setup failures and superseded invalid-port receipts remain labelled as such.
cursor recovery here covers source replacement; initial-load failure followed by
focus-driven recovery remains a separate
[qualification gap](tickets/reader-cursor-load-failure-has-no-recovery.md).
the final combined peer receipts are
`/tmp/nexus-session-entry-release-20261014/reader-qualification-receipts/final.json`
and `canvas-qualification/final-summary.json` in that campaign directory; their
source hashes independently match. public pdf-navigation probes use a controlled
positioner; the separate rendered-pdf proof establishes the viewer behavior.
trusted touch intent was observed, native swipe movement was not.

unaccepted old-coordinate movement and reports during publication rebinding are
discarded. an admitted save drains first. an aborted binding keeps known content
readable but read-only until source reload/remount; cursor-only retry cannot make
old coordinates valid. this is deliberate input loss instead of a guessed remap.
stable completed navigation targets survive passive layout; genuine input or a
new decision releases them. transient pdf commands retain measured-placement
reflow. canvas activation survives layout growth until actual canvas pan intent;
nested scrolling does not release it. native overlay-thumb movement remains
[unqualified](tickets/canvas-overlay-scrollbar-release-unqualified.md), not failed.
the owner selected instant pane activation after firefox continued an obsolete
smooth destination despite the attempted native cancellation. smooth-first
activation is explicitly retired; those red receipts are not relabelled passes.
the cost is losing that transition animation. no custom animation, pixel nudge
or lifecycle mechanism replaces it.

sanitized receipts are retained outside the repository at
`/private/tmp/nexus-x-titles-proof-20261014/`. the initial source/title checks,
proof credentials, isolated containers, volumes and setup were deleted after green;
shared account state and standard development dependencies were preserved.
the reader-correction execution setups, owned browser profiles and test dependencies
were deleted after combined green review. shared dependencies and production
profiles were preserved. cleanup receipts are `reader-progress-cleanup.json`,
`pdf-title-cleanup.json`, and the peer campaign's `reader-qualification-receipts/cleanup.json`
and `canvas-cleanup.json`. no runtime test seam was added. `./scripts/test` passed after the initial,
source/language and attribution check deletions (exit 0, canonical head `0278`);
the final code receipt is `static-attribution-post-deletion.log` in that directory.
the consolidated reader correction also passed `./scripts/test` after all accepted
test deletions (exit 0, head `0278`): `static-reader-post-deletion.log`.
the initial worktree run lacked standard locked ingestion dependencies; after
linking the already-installed byte-matching lock/manifest set, the same gate passed.
no product change or new dependency was needed; the failed setup log remains.
