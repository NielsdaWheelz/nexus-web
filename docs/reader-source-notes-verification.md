# reader source notes and navigation: verification

status: implemented in `feature/reader-source-notes`; final main integration in progress
original base: `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`
rebased candidate: `42117aca9ea4bb914429daf8e90c2a4f022107ae` on
`8cc5eef8e48fc5394240df4a57f0cab9410eaef2`; `./scripts/test` passed
date: 2026-09-26–27

the table and artifact receipts below belong to the pre-rebase feature commit
`16099bdd84f4a20c443b6f066f23bc2a2334056e`. they establish the original
implementation but do not establish live behavior on the rebased candidate.
the rebase integrated the new `0243` migration, epub section semantics, source
issues, offline package version 4, and pending-progress upgrade handling.
focused live requalification passed on the task tree at `0244`. main then merged
an independent reader-navigation implementation (`9e021e88d`); the final
integrated tree requires its own static and focused live qualification.

## focused task-tree requalification

| boundary | observed result |
|---|---|
| migration and source fidelity | fresh isolated database migrated through `0243` to canonical `0244`; authenticated pillow import matched all 547 earlier note identities and bodies and restored 24 additional genuine numbered translator notes (571 total), each with reciprocal backlink and authored notes heading |
| hosted contents and evidence | exact auxiliary toc target `10 Mountains` opened at offset 5102 and returned scroll 55→2688→55; an in-text marriage-customs marker opened its full 394-character authored body in evidence, source jump scrolled 4413→17802, return restored 4413; cursor revision remained 4 across the detour; receipts in `/tmp/nexus-reader-source-notes-rebase` |
| android offline | installed task apk sha256 `0eb6a162f1c499472447cba79b475909aa97129d95738eb0547c96be153480d9`; normal download stored reader contract v4 package sha256 `31c5b10f66d163c4be5ad8977f7cad1aef68d8c70802176bd98c143ab9b2ba91`; with no active network, marker opened the full authored note and return restored scroll 10847.23828125 exactly |
| transcript find | normal authenticated published ted captions: desktop and narrow real-browser journeys passed find, stepping, close/return, paused-player invariance and no detour cursor write; the final geometry guard passed adoption → immediate reload with the exact target fragment at both widths; receipts in `/tmp/nexus-reader-transcript-b-final` |

these receipts cover task heads `42117aca`, `9ee7bb572` and the transcript
geometry commit `b2896c0f9`, as labelled in each artifact. they do not certify
the subsequent integration merge.

the temporary red/green probes used normal ingestion, authenticated http,
postgres, browsers, firefox capture and an installed android build against an
isolated stack. no probe or fixture is retained in the repository; `./scripts/test`
is the required static gate. nonsecret detailed receipts are under
`/tmp/nexus-reader-source-notes-a`, `/tmp/nexus-source-notes-b-20260926`,
`/tmp/nexus-reader-navigation-pdf-20260926`,
`/tmp/nexus-reader-source-notes-root` and `/tmp/nexus-reader-offline-a`.

| contract | observed result |
|---|---|
| a1 source fidelity | normal imports exactly matched 547/547 pillow, 408/408 augustine, 44/44 montaigne target identities and full text; augustine has 395 rich and 13 honestly unavailable bodies. public wikisource url and actual firefox capture retained 14/14 and 18/18 references; distinct `<base>` url/capture 8/8 |
| a2–a4 reading | rich browser 6/6, alignment/layout 9/9, repeat/multi-target 7/7, backlinks 5/5, editors 8/8, overview 5/5, typography and reflow 2/2 each; keyboard/compact focus and pre-rebase android compact touch 3/3 passed. the old margin rail is absent |
| a5 safety | in-place migration retained ids, keys, bytes, offsets and links while advancing generation; earlier marker insertion preserved identities; ambiguous durable correspondence refused publication atomically |
| a6 coverage | native pdf text/citation identity and zoom/rotation passed; unsupported or absent bodies retain explicit unavailable/source access; source, personal and generated provenance remains distinct |
| n1–n2 navigation | article, epub and pdf target/return journeys passed; copied-note inspection made no cursor, completion or activity write; an 11.8-second copied-note session left the source scroll and revision unchanged |
| n3 races | delayed target supersession, retry, disconnect, pdf geometry, reflow and failed `a → b → c` rollback passed. failure restored `b` while retaining `a`; unchanged-layout returns were within 1px |
| n4 adoption/entry | busy adoption retained protection; three Contents returns were exact; explicit adoption at 96.6115% marked finished; reload resumed the saved locator; reset remained empty |
| n5 concurrency/activity | two real sessions held remote progress outside inspection; keep/use-newer and pending-save retry passed. reading recorded a duration and word endpoints; canonical inspection recorded duration with absent progress/word endpoints |
| n6 android offline | installed pre-rebase apk: pdf 5/5, epub 6/6, article 4/4, same-process reconnect 3/3; all native pending rows settled. a stale hosted/article baseline produced a real conflict, resolved through the normal review/keep-origin choice before the current-baseline reconnect replay |
| restored workspace | a cold restored seven-pane session mounted the target chapter without the earlier render loop on three successive runs. a 404 belonged to a deleted task fixture in another restored pane |

source files used for the corpus: pillow
`8f625aa3c9f1fd0084e1c014fc27a390f3d278bc1f50519a0272ebef7a60e88f`,
augustine `0d4b869602edd2b33cbe500cd6229f3557e3f11f69df6bf7f42d7b89fc15c201`,
montaigne `01c64cceac36df2ee70ea4a1be0696a1bed2fd27e2f70f736ab7c33cc5e9c597`.
the migration backup is `/tmp/nexus-reader-source-notes-stack/app-before-0242.dump`
(sha256 `0c6d45fbcf51f646ee8b20a7f28db7f0fdb59da4a799c4548cf89f39f9b97c43`).
the pre-rebase installed apk sha256 is
`9480b95d96cd2f419df4c95e1d4c193f91e76fd91f274510368dc9e8cabf5f4c`
(`1.0-debug(1)`, emulator-5558, android 15, webview 124.0.6367.219).
the isolated background worker image was
`sha256:201cca063db6a6be2efaadeff6665a61ea218df7ed7506838d0fa8234f292dad`.
the three device media fixtures and root epub were removed by normal delete;
each final authenticated read returned 404.

## remaining evidence boundaries and costs

- **blocked by available data:** live generic chat and dossier find smoke have
  no messages or revisions and the isolated model catalog returns 503; the
  owner approved recording those two checks as blocked.
  [ticket](tickets/generic-pane-find-live-acceptance-blocked.md).
- **open:** spoken screen-reader announcements and linear accessibility focus
  were not established by the bounded talkback attempt. actual android touch
  and double-tap opened the source pane; native hierarchy capture could not
  reach idle. [operator acceptance](tickets/reader-map-inert-position-and-mobile-controls.md)
  remains open.
- offline source apparatus packaging remains a separate
  [gap](tickets/offline-reader-lacks-source-apparatus-inspection.md).
- normalized source bodies enlarge initial authenticated document-map responses:
  measured decoded utf8 was 2,456,436 bytes for pillow, 1,415,813 for
  augustine and 509,126 for montaigne. compressed transfer was not measured.
  a single response avoids target request/cache machinery.
- the one-origin model omits intermediate history. adoption takes an explicit
  action and can mark finished by position without proving skipped-text coverage.
  restart does not preserve an excursion. removing temporary probes relinquishes
  automated regression detection; live repair and the static gate remain.
