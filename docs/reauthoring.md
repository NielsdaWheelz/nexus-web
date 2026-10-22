# reauthoring campaign

status: active · 2026-10-20, main `b3f81e349` · production `d6f04890c` by the 10-19 record (schema 0297, wire 12), unconfirmed: no release backup exists after `8a67e218a` ([issue](issues/release-backup-missing-after-8a67.md)) · the campaign's one list of areas: the PR that changes an area updates its row.

## goal

direction, keep features (owner, 2026-10-13). every area is rewritten once, fresh, from a spec of its observable behaviour, and stops at its honest floor: no behaviour cut for a budget, no lines moved out of a slice to fit a cap. the 1/5 target is dropped; the reading kernel alone projects ~81k. earlier rewrites (player #534, reader #535, offline #502, dossiers #514, oracle #531, synapse #525, find #509, launcher #410) change only where a sweep crosses them. code that a feature or release session adds to an area after its rewrite is regrowth: it joins the queue as a re-slice, cut against the newest merged behaviour.

## counting

persistent-player redesign against `177d11022`: +159 authored runtime lines
(620 added, 461 deleted): player +60, shared overlays +62, android playback +36,
reader web ui +1; android shell +0. application-volume paths and permanent
secondary player rows are deleted. only these deltas are attributed here;
earlier counts retain their stated bases.

authored runtime is every `python/nexus/**/*.py`, `apps/{api,worker,codex_agent}/**/*.py`, `node/ingest/**/*.mjs`, `apps/android/app/src/main/**/*.{kt,xml}` and `apps/web/src/**/*.{ts,tsx,css,html,svg}` file except five generated ones (web `lib/api/wire.gen.ts`, `lib/resources/resourceCapabilities.ts`, `lib/chat/toolContractProjection.ts`, `lib/brand.ts`, `app/brand.css`), in raw physical lines (`str.splitlines()`), unformatted. migrations, tests, scripts, deploy, docs and generated files are outside it. ordered path rules put each file in exactly one area (first match wins; every file matches).

the scripts live in `nexus-web-campaign-artifacts/2026-10-18/`: `classify.py` (the rules; counts any rev), `areas.py` (the 62 areas over its rows, their PRs and status), `attribute.py` (each merged PR's lines per row, from `prs.json`) and `table.py` (this table, its totals and next column). `python3 attribute.py && python3 table.py` prints the table below. attribution is rename-aware: a renamed file's diff counts in its new path's row. a PR that adds a path the rules miss adds a rule; a path replaced without a detected rename keeps a rule for its successor's row (synapse → connections). deleted paths no rule matches drop out: about 6.9k gross lines, all in non-campaign PRs merged 09-28 to 10-10.

| date | tree | authored runtime |
|---|---|---:|
| 2026-09-26 | campaign start, `6f73ad3b4` | 381,520 |
| 2026-10-13 | owner interview, wave 5, `03db506d5` | 192,603 |
| 2026-10-16 | after the imports slice #641, `92c8d44c7` | 170,388 |
| 2026-10-18 | after #665, `823fafe8a` | 180,128 |
| 2026-10-20 | after #711, `b3f81e349` | 191,346 |

since 2026-10-11 feature and release sessions merged 96 PRs onto main (99 counting #626, #629 and #632, stacked into #633): +36,905 authored lines net and +41.9k docs, against the campaign's -47,149 in 48. after #641 theirs are 52 (+28,661) and the campaign's 18 (-7,703): the rise since, +20,958.

## areas

podcast collection adds 252 authored runtime lines (604 added, 352 deleted)
beyond shared controls `7aa97169f` and the browser-player baseline in main
`61d2d1540`. its nine touched rows below are recounted from the integrated tree.
canonical collections replace the episode card/list wrapper; the old bulk
endpoint is deleted. account-memory commands, conditional bulk state and
acknowledged progress preparation own the remaining change. generated wire and
docs are excluded; untouched rows and aggregate totals retain their stated bases.

media item controls recounts its twenty touched rows against `177d11022`: +585
authored runtime lines (1,576 added, 991 deleted), including new runtime files.
shared media identity/actions replace per-surface controls; list notes, add-only
lectern controls and duplicate episode-body commands are deleted. the pure search
recovery policy stays in content index. generated wire and docs are excluded;
untouched rows and aggregate totals retain their stated bases.

collection loading recounts its touched rows against `5ead65981`: -269 authored
runtime lines (833 added, 1,102 deleted). it removes manual collection pagination,
the browse traversal owner, preview pagination and the member-library loop;
shared ownership replaces those paths. generated wire and docs are excluded.
only touched rows are recounted; earlier aggregate totals retain their bases.

pane header controls recounts its four touched rows against `1b7cf138d`: +5
authored runtime lines (124 added, 119 deleted). workspace gains 3, libraries 2;
chat and podcasts have no net change. other rows and totals retain their bases.

podcast details updates its touched areas against `380400362`: +268 authored
runtime lines (815 added, 547 deleted), including new runtime files. generated
wire, migration, scripts and docs are excluded. jobs runtime changes without
a line-count delta; earlier aggregate totals retain their stated bases.

playback settings recounts player, podcasts and android playback against `11453c870`: 190,425 authored runtime lines become 190,981 (+556 net). generated wire, migrations, scripts and docs are excluded; the shared settings command owner belongs to podcasts. only these three rows are recounted; earlier totals and untouched rows retain their stated bases.

chat citations recounts its 6 touched areas against `f2025d935`: net -187 authored runtime lines. it removes the source tour, workspace tour provider and raw marker parser; publication and rendering share one source-aware markdown grammar. generated parser output and generation scripts are outside this count.

selection continuation recounts six touched rows against `021214b57`: +494
authored runtime lines net (+882, -388). it removes the reader-only send transport
and old annotation chat actions. contracts live in [chat](modules/chat.md) and
[highlight](modules/highlight.md). other rows and aggregate totals retain their
stated bases.

inline continuation updates the touched area counts against `94a367b57`; its net authored runtime is +468 lines. `ReferenceRowEditor` belongs to the notes outline area; the external campaign classifier includes that path.

`lines now` is recomputed across all 62 areas for connection actions (188,184 authored lines), against integrated main `2f9cb0a1a`. `connection actions` marks this change’s net; earlier attribution retains its stated base. the libraries + suggestions + ordering re-slice adds its net change in the rows it touches (+32 authored lines against main `0c6da7f32`). the chat web re-slice then recounts the rows it changes (chat, reader web ui, resource items, model tools, db substrate, generation core, wire schemas): net -974 against `66a55ba2b`. the resource references re-slice (`cleanup/resource-references-reslice`) counts its seven rows at its tip on main `d9e7d86aa` (-749 authored lines). the python auth re-slice (`cleanup/python-auth-reslice`) recounts the six rows it touches at its tip on main `1c73d0ca9`: -847 authored lines, auth 5,193 → 4,366. the db substrate re-slice (`cleanup/db-substrate-reslice`) recounts the nine rows it touches at its tip on main `d1ed4907f` (-1,432 authored lines; its own row 2,707 → 1,285). the reader python ingest re-slice (`cleanup/reader-python-ingest-reslice`) recounts the four rows it owns and the four it crosses at its tip on main `157b84471` (-729 authored lines; its four rows 10,237 → 9,482; the read path in them is kept, byte for byte, for 13b). the ingest follow-ups (`cleanup/ingest-followups`) recount the nine rows they touch at their tip on main `631dba5dc` (+109 authored lines). the pane chrome re-slice (`cleanup/pane-chrome-reslice`) recounts its row and the four it crosses at its tip on main `c69ba7cba` (-443 authored lines; its row 13,700 → 13,394, after two `classify.py` relabels, not cuts: `SurfaceHeader` and `PaneHeaderIdentity` move in from visual primitives (750 lines at the tip) and `lib/collections/order.tsx` with `collection_order.py` move out to libraries core (453)).

shared outline recounts its eight touched rows against `b4fc338d9`: 187,013 authored runtime lines become 192,979, with 9,689 added, 3,723 deleted and +5,966 net. new runtime files are included; generated files, migrations, scripts and docs are excluded. the classifier assigns `useOutlineSession` and `OutlineSurface` to notes outline, `CanonicalNoteEditor` to note bodies/editor, and `ResourceComposer` alongside `ResourceDisclosure` in resource items/actions. untouched rows and earlier totals retain their prior attribution.

podcast row artwork recounts its four touched rows against `b4721d528`: +142
authored runtime lines net. generated wire and docs are excluded; other row
counts and aggregate totals retain their stated bases.

unsaved work updates its touched rows against `b9a51eabc`: 193,284 authored runtime lines become 193,625 (+341 net; 2,076 added, 1,735 deleted). browser draft storage, persisted media recovery, bespoke loss dialogs and redundant selection-store writes are deleted. the shared guard and retained-owner adapters account for the net increase. earlier attribution retains its stated base.

resource insertion composes the notes outline/body owners, resource graph,
collection row adapters and reader selection composer. mixed adjacency and
versioned commands belong to the graph; one empty-input controller owns reference
intent; the existing tab queue owns sending/retry. contracts live in
[notes](modules/notes.md), [resource graph](modules/resource-graph.md) and
[resource references](modules/resource-references.md).

the owner PRs no row named, #670 to #702, are attributed at their merges with the same scripts; #682, #691, #692 and #696 fall under the floor below. `lines now` is recounted across all 62 areas at main `b3f81e349`. named entries are PRs: x threads #671, resource-first search #680, shift-open #681, resource insertion #683, resource metadata #684, empty-resource lifecycle #685, reader connections #687 #688, reference interaction #686, inline continuation #689, connection actions #690, shared outline #703, chat citations #707, selection continuation #708, unsaved work #709, python auth #710, db substrate #711.

- **status**: reauthored by the campaign PRs named (head `cleanup/*` or `size/*`); partial = only the part named; not yet.
- **regrown since**: non-campaign PRs merged after the row's last named PR (not-yet rows: since 2026-10-11), with their net authored lines in that row. a PR under 50 net and 200 gross lines is summed into "n more" or left out.
- **next**: re-slice = cut the regrowth against the area's contract; slice = first rewrite; gated = waits on a queue gate; keep = done; "#n with x" = that PR's edits here go with slice x.

| area | lines now | campaign status | regrown since by | next |
|---|---:|---|---|---|
| workspace, panes, nav, app shell | 13,251 | reauthored #542 #545 #557 #562, re-sliced with #617 #627 and #655's palette (cleanup/pane-chrome-reslice) | podcast row artwork +14 · podcast details +3 · pane headers +3 · collection loading +28 · media controls -202 · podcast collection +4 | keep |
| chat | 9,849 | reauthored #529 #551, re-sliced by chat web (#643 #644 #647, with shift-open's pane views) | #700 -50 · #702 +88 · chat citations -91 · selection continuation +144 · unsaved work +64 · pane headers +0 · collection loading +2 | re-slice |
| reader web ui | 10,923 | reauthored #526 #535 | #631 +641 · #645 +383 · #646 -177 · #578 +160 · #565 +158 · #614 +86 · 14 more +199 · x threads +383 · #672 +37 · #670 +143 · #679 +1 · shift-open +490 · resource insertion +36 · reader connections +76 · connection actions +3 · #700 +11 · #697 +67 · shared outline +15 · selection continuation +331 · unsaved work +5 · reader python ingest +0 · ingest follow-ups +8 · media controls +11 · player redesign +1 · podcast collection +8 | re-slice: selection composer + popup; rest keep |
| visual primitives, themes, global css | 6,670 | reauthored #563; #617 #627 re-sliced by pane chrome | #643 +353 · #644 +87 · #578 -44 · #650 +40 · shift-open +113 · resource insertion +48 · inline continuation +16 · #699 +31 · #700 +10 · #697 +1 · chat citations -33 · selection continuation +7 · unsaved work +167 · pane chrome -589 (the pane header relabelled out) · podcast row artwork +23 · collection loading -35 · media controls +126 | re-slice with chat web (#643 #644) |
| resource items and actions | 7,814 | reauthored #587 #593, re-sliced (cleanup/resource-references-reslice) | #700 -82 · #702 +15 · shared outline +1,483 · chat citations -28 · unsaved work +12 · pane chrome -2 · podcast details +11 · collection loading -3 · media controls +450 · podcast collection +18 | re-slice |
| libraries core | 6,105 | reauthored #590, re-sliced (cleanup/libraries-ordering-reslice) | #699 +65 · #702 -3 · unsaved work +78 · db substrate -1 · ingest follow-ups +5 · pane chrome +453 (collection order relabelled in) · podcast row artwork +8 · podcast details +24 · pane headers +2 · collection loading -19 · media controls +69 | re-slice |
| auth | 4,366 | reauthored: web #558, re-sliced with python (cleanup/python-auth-reslice) | — | keep |
| podcasts | 5,760 | reauthored #546 #550 | #578 -174 · resource insertion +6 · unsaved work -2 · podcast row artwork +97 · playback settings +212 · podcast details +221 · pane headers +0 · collection loading +10 · media controls -59 · podcast collection +172 | keep |
| reader python: epub | 3,658 | re-sliced: write path (cleanup/reader-python-ingest-reslice); read path kept for 13b | ingest follow-ups +7 | read-path functions with 13b |
| resource graph, links, citations | 4,451 | reauthored #544, re-sliced (cleanup/resource-references-reslice) | shared outline +149 · chat citations -40 · unsaved work +51 · collection loading +7 | re-slice |
| media core | 4,023 | reauthored #621 | #650 +665 · x threads +111 · #670 +29 · shift-open +16 · resource metadata +16 · resource insertion +1 · #700 -2 · #702 -2 · unsaved work -366 · db substrate +4 · ingest follow-ups +8 · podcast details +3 · media controls +270 · podcast collection +2 | keep |
| imports pane and history | 3,827 | reauthored #553 #641 | #650 -38 · x threads +2 · #670 +64 · shift-open +1 · resource insertion +11 · #700 +1 · #702 +2 · collection loading -39 · media controls +2 | keep |
| model tools, assistant writes, memory tool | 3,826 | reauthored #561 | #572 +149 · x threads +223 · resource-first search -3 · connection actions -3 · db substrate -2 · collection loading +8 | keep (#647 re-sliced by chat web) |
| authors | 3,637 | reauthored #549 | #670 +8 · resource insertion +11 · #700 -7 · unsaved work -43 · collection loading -14 · media controls +20 | keep |
| ingest source lifecycle, post room | 4,248 | reauthored #599 | #619 +62 · x threads +63 · #670 +514 · reader python ingest +25 · ingest follow-ups +13 · podcast details +4 | keep |
| reader python: apparatus | 3,387 | re-sliced: write path (cleanup/reader-python-ingest-reslice); read path kept for 13b | ingest follow-ups +9 | read-path functions with 13b |
| nexus launcher | 3,864 | reauthored #410; #655's palette re-sliced by pane chrome | #651 +10 · 7 more -62 · #672 -4 · resource-first search +160 · shift-open +134 · resource metadata +1 · empty-resource lifecycle -38 · #700 -1 · #702 +52 · unsaved work +83 · pane chrome +1 · persistent player +3 · media controls +1 | keep (no second pass) |
| add content | 3,383 | reauthored #521 #553 | #575 +361 · #577 +107 · #632 -79 · #610 -13 · x threads +12 · #670 +117 · shift-open +14 · #702 +10 · unsaved work -106 · collection loading +4 | re-slice: single-screen editor |
| reader python: read model | 3,412 | not yet | #646 +79 · #660 +73 · #663 +62 · 6 more +53 · x threads +538 · #670 +34 · reader connections +24 · ingest follow-ups -3 | reader python read (13b, deferred) |
| consumption history and stats | 3,183 | reauthored #417 #595 | x threads +1 · shift-open -11 · collection loading -4 · podcast collection +7 | keep |
| browse | 2,838 | reauthored #543 #546 | #578 -100 · shift-open +63 · resource insertion +5 · #702 +1 · unsaved work +27 · collection loading -244 · media controls -75 | keep |
| dossiers | 3,123 | reauthored #514 | 4 more -61 · shift-open -8 · resource insertion +5 · empty-resource lifecycle +33 · unsaved work +50 · podcast details -2 | keep |
| sharing: members, invitations, grants | 3,032 | reauthored #409 #591 | x threads +13 · shift-open +1 · #700 -12 · python auth -12 · db substrate -1 · collection loading -3 | keep |
| one-time repair and cutover tooling | 0 | deleted by the purge (cleanup/repair-purge) | — | done |
| firefox extension | 2,957 | reauthored #600 | #632 +97 · #670 +107 · python auth -3 | keep |
| oracle | 2,835 | reauthored #531 | #646 -54 · shift-open +20 · resource insertion +5 · unsaved work +12 | keep |
| db substrate (models, session) | 1,285 | re-sliced (cleanup/db-substrate-reslice) | — | keep |
| player | 3,227 | reauthored #534 | #538 +102 · shift-open -8 · #700 -4 · playback settings +349 · persistent player +130 · media controls +72 · player redesign +60 · podcast collection +10 | keep |
| url acquisition (web, x, youtube, gutenberg, remote file) | 4,096 | reauthored #548 | #606 +539 · 4 more +52 · x threads +1,016 · #670 +521 · reader python ingest +3 · ingest follow-ups -12 | re-slice: x titles |
| overlays | 2,925 | reauthored #560 | #650 +68 · #631 +52 · #651 +48 · 10 more +128 · shift-open +56 · #700 +345 · #702 +15 · chat citations +9 · player redesign +62 | keep; #631 with selection composer, #650 with feedback admission recovery |
| notes outline | 7,294 | reauthored #589 | #646 -319 · #631 +85 · #678 +111 · #679 +31 · shift-open +11 · resource metadata +1 · resource insertion +942 · empty-resource lifecycle +143 · reference interaction +248 · inline continuation +437 · connection actions -2 · #700 +1 · shared outline +2,943 · unsaved work +10 · collection loading +2 | keep; #631 with selection composer |
| offline shelf | 2,389 | reauthored #502 | x threads +45 · reader python ingest -2 | android slice (late) |
| note bodies and editor | 4,282 | reauthored #589 | #631 +121 · #646 +29 · #679 +22 · resource insertion +448 · empty-resource lifecycle +71 · reader connections +111 · reference interaction +19 · inline continuation +8 · shared outline +1,170 · selection continuation +3 · unsaved work +84 · collection loading +1 | keep; #631 with selection composer |
| generation core | 2,275 | reauthored #547 | x threads +5 · resource-first search -1 · db substrate -1 | keep (#643 #644 re-sliced by chat web) |
| metadata research, media intelligence | 2,395 | reauthored #620 | x threads +62 · #670 +49 | keep |
| api transport, bff, sse | 2,355 | reauthored #586 #594 | #626 +97 · x threads -1 · resource-first search +7 · resource insertion +9 · reference interaction +14 · connection actions +13 · unsaved work +0 · collection loading +26 · podcast collection +8 | keep |
| android shell | 2,178 | partial: web handoff routes #558 | #607 -126 · unsaved work +24 | android slice (late) |
| api substrate, config, storage, wire schemas | 2,127 | reauthored #585 #586 #622 | x threads +3 · #670 +3 · resource-first search +4 · empty-resource lifecycle +19 · python auth -5 · podcast details +4 | keep |
| reader: document map, evidence | 1,923 | partial: web #535 | #646 -494 · #661 +141 · #536 +37 · x threads +16 · #670 +5 · #679 +5 · shift-open +65 · resource metadata +1 · resource insertion +4 · reader connections -469 · shared outline +203 | reader python read (13b, deferred) |
| search retriever | 2,672 | reauthored #543 | #646 +211 · x threads +30 · resource-first search +616 · media controls +2 | keep |
| suggestions | 1,952 | reauthored #596, re-sliced (cleanup/libraries-ordering-reslice) | media controls -48 | keep |
| consumption core (read state) | 1,869 | reauthored #417 #596 | #650 +170 · x threads +163 · media controls +1 · podcast collection +23 | keep; #650 with feedback admission recovery |
| reader python: highlights | 1,690 | not yet | #645 +78 · #631 +75 · x threads +44 · #670 +28 · python auth -2 · db substrate -1 | reader python read (13b, deferred) |
| jobs runtime | 1,589 | reauthored #564 | empty-resource lifecycle +6 · selection continuation +1 · podcast details +0 | keep |
| notes pages and index | 1,959 | reauthored #588 #589 | #631 +87 · shift-open +19 · resource insertion -117 · empty-resource lifecycle +564 · reference interaction +3 · connection actions -3 · #702 -1 · shared outline +4 · unsaved work +43 · db substrate -4 · collection loading -1 | keep |
| reader python: html substrate, web article structure | 1,623 | re-sliced: write path (cleanup/reader-python-ingest-reslice); read path kept for 13b | ingest follow-ups +74 | read-path functions with 13b |
| lectern | 1,442 | reauthored #534 #596, re-sliced (cleanup/libraries-ordering-reslice) | unsaved work -1 · media controls -42 | keep |
| android playback | 1,259 | reauthored #534 | #538 +102 · #630 +84 · playback settings -5 · player redesign +36 | android slice (late) |
| settings | 1,209 | reauthored #592 | resource insertion +1 | keep |
| reader python: pdf | 904 | re-sliced: write path (cleanup/reader-python-ingest-reslice); read path kept for 13b | — | read-path functions with 13b |
| public share links (/s) | 1,364 | reauthored #409 #598 | x threads +209 · #670 +81 | keep |
| atlas | 1,056 | reauthored #531 #597 | shift-open +2 · python auth +2 | keep |
| reader python: document embeds | 1,435 | not yet | x threads +141 · #670 +233 · shift-open +22 | reader python read (13b, deferred) |
| uploads | 1,282 | reauthored #600 | #650 -69 · #670 +224 · media controls +27 | keep |
| content index | 1,003 | reauthored #559 | x threads +46 · empty-resource lifecycle +4 · media controls +8 | keep |
| search pane | 893 | reauthored #592 | #646 -284 · #651 +50 · resource-first search +11 · #679 +1 · shift-open +1 · reference interaction -26 · unsaved work -1 · collection loading +5 · media controls -8 | keep |
| find in pane | 856 | reauthored #509 | #652 +76 · #578 +9 · resource insertion +1 | keep |
| release and backup tooling | 707 | not yet | — | last slice, after the end release |
| reader: transcripts | 652 | partial: web #535 | shift-open +27 · media controls -40 | reader python read (13b, deferred) |
| android share page | 611 | partial: web #600 | #670 -1 · unsaved work +1 | android slice (late) |
| connections | 503 | reauthored #525 | #536 +8 · connection actions -47 | keep (earlier rewrite) |
| codex agent host | 413 | reauthored #556 | db substrate -4 | keep |

totals: reauthored 168,458 (66,407 of it due a re-slice) · partial 5,404 · not yet 17,484 · all 191,346 (the purge: -3,728; the chat web re-slice: -974; the resource references re-slice: -749; the python auth re-slice: -847; the db substrate re-slice: -1,432).

## queue

an area is cut only when no other session has an open PR, branch or worktree in it: check `gh pr list`, the remote branches and `git worktree list` first. the newest merged behaviour is the conservation contract. a re-slice takes its PRs' edits in every area they touched. an area the owner is still changing is audited in place (its regrowth cut against its contract) rather than re-sliced whole, the coordinator's recommended mode since 2026-10-19. one implementer per slice plus self-review; a migration is rehearsed on a restored production backup, on the mac only.

1. docs purge: plans and receipts out, `docs/tickets` and `docs/outstanding-issues.md` folded into `docs/issues`.
2. resource references + principal actions (#646 #651): resource items and the graph, with #646's edits to the search retriever, notes outline and document map and #651's to overlays. done on `cleanup/resource-references-reslice`.
3. pane chrome (#578 #605 #607 #617 #625 #627 #628 #651 #655): workspace, the primitives they added (#617 #627), the mobile palette and its launcher edits (#655). done on `cleanup/pane-chrome-reslice`.
4. chat web (#643 #644 #647): chat, its pickers and choice primitives (#643 #644 in visual primitives), the model-tools details: done in cleanup/chat-web-reslice-a and -b.
5. libraries + suggestions + ordering (#626 #629 #632 #633 #648): libraries core, suggestions, lectern and collection order, the extension's chooser (#632): done in cleanup/libraries-ordering-reslice.
6. selection composer + popup (#631 #645): reader web ui, note bodies, #631's edits to the notes outline and overlays.
7. feedback admission recovery (#650): media core, consumption core, #650's edits to overlays.
8. add content (#575 #577): the single-screen editor.
9. x titles (#606 #611 #612): url acquisition; `ops/refresh_x_sources.py` left with the purge.
10. python auth, with #607's session entry: supabase calls behind one module (`docs/modules/auth.md`). done in #710.
11. repair purge, after the owner opened the gate 2026-10-18 (R3 live, R4 closed for the purge, R5 out of the gate, R7 closed): done in #674: the repair/cutover code and its repair-only branches are gone, and 0236–0292 are one `0292` baseline. `0304` drops `model_cutover_archives` (the owner waived the r2 retention read 2026-10-19; [release step](issues/release-drop-model-cutover-archives.md)).
12. db substrate, after 11: `models.py` becomes query mapping; the baseline sql is the only ddl. done in #711.
13. reader python, after 11's purge, in two halves:
    - 13a, ingest: epub, apparatus, html substrate + web article structure, pdf. re-sliced in #716 (the write path); the read-path functions left in its rows go with 13b.
    - 13b, read: read model, map/evidence, highlights, embeds, transcripts. deferred while the owner works there (x articles, reader connections, shared outline, selection chat, 10-19/20).
14. android, late: shell, offline shelf, playback, share page, emulator-proven in the linux-runner container; the owner smokes playback and offline on the phone.
15. releases: no end release. each slice ships in the next release the owner runs; its `docs/issues/release-<area>.md` lists only owed steps and goes once they ship. every migration is rehearsed on the newest production backup before merge.
16. last: the release/backup tooling rewrite (after the last slice, rehearsed end to end on the devbox) and the architecture docs (a ~500-line first-principles explainer once the code settles).

out of campaign: leaving supabase ([issue](issues/leave-supabase-auth.md)).

## decision log

- 2026-10-18 · owner: the repair gate opens: R5 (credentials) leaves it, R4 counts as closed for the purge (its operator returns from git if ever needed), R7's rollback window closes (production is past 0292; a backup restore is the only rollback). the cloudflare r2 retention check before the archive drop stays.
- 2026-10-18 · owner: the end-release rule is retired; slices ship in whatever release comes next; migrations are still rehearsed on the newest production backup before merge.
- 2026-10-18 · owner: one global wire revision, bumped at most once between releases (AGENTS.md).
- 2026-10-18 · owner: an unsent draft is a per-viewer convenience browser storage may hold (AGENTS.md); feature PR bodies state their net authored lines and what they deleted; the slices over their caps (consume, notes) stand; leaving supabase waits for the python auth slice; issues left uncommitted in the main checkout are kept (#668).
- 2026-10-18 · owner: the campaign list is a committed doc; areas other sessions' PRs touched join it.
- 2026-10-19 · owner: the chat system prompt keeps the owner's persona for every account. the r2 retention read before the archive drop is waived. docker desktop stops once the campaign's rehearsal queries are done.
- 2026-10-20 · owner: docker desktop needs no stop; the 10-19 instruction is withdrawn.
- 2026-10-20 · owner: the stale 10-03–10-16 worktrees and branches (book, reader storage, release hotfixes) are abandoned and deleted; unmerged heads and uncommitted state are bundled outside the repo.
- 2026-10-15 · owner: add the non-campaign areas to the list and cut them too; conventions live in AGENTS.md (#634); plans and receipts are purged after the release.
- 2026-10-15 · owner: 0284's gate is preserved currency, not every unit current (#624).
- 2026-10-14 · owner: #578 lands first and the stack absorbs it; share byte reads get their own firewall limit (#601); #387 closes for #599; imports pane + history is one slice (#641).
- 2026-10-13 · owner: direction, keep features; every area once at its honest floor; 1/5 dropped.
- 2026-10-13 · owner: wire = plain nullable, snake_case, one `X-Nexus-Wire` revision answered by 426, streams through the BFF (#585 #586).
- 2026-10-13 · owner: no replay ledger; creates take client-minted ids, updates carry expected versions, deletes are idempotent (#623).
- 2026-10-13 · owner: note bodies and outline online-only, one interleaved undo stack, quick note appends then opens (#589); action menus fetch on open (#587); the extension drops crash-resume (#600).
- 2026-10-13 · owner: assistant writes stay in settings and outlive their chat, one undo route; llm-calling and llm-agent-kernel change whenever a slice needs it.
- 2026-10-13 · owner: one release at the end, no hotfixes; each wave's migrations rehearse on a restored production backup, mac only. (overtaken in practice: the owner has released continuously since 10-15; queue 15.)
- 2026-10-13 · owner: after the release repairs, purge repair/cutover code, squash migrations, drop `model_cutover_archives`; the reader python slice follows the purge.
- 2026-10-13 · owner: android is rewritten once, late, emulator-proven; leaving supabase is out of the campaign.
- 2026-10-13 · owner: the tooling rewrite is the last slice and the architecture docs come last; `docs/tickets` becomes `docs/issues`; no in-repo tests; `docs/rules` untouched.
- 2026-10-13 · coordinator defaults, not vetoed: no hover prefetch; one html sanitizer for new ingests; no storage reservation ledger; accept and enqueue in one transaction, no stale-ingest reconciler; sealed handles become plain ids; the launcher gets no second pass.
- 2026-10-10 · owner: collection revisions become keyset continuations (#562); the workspace host inverts (#557); chat stays multi-provider; codex egress is declared in compose (#556).
- 2026-10-10 · owner: keep the Solar (elvish) and oracle themes; simpler toasts that keep pause and persistent notices; auth keeps one public origin, github oauth and the network-free session middleware, with supabase behind one module (#558).
- 2026-10-09 · owner: generation drops durable crash replay; llm-agent-kernel gains a transient native mode (#547).
- 2026-10-05 · owner: player: a finished replay starts at 0, hidden-tab listening counts, mark as played is state only, volume boost and mono go, pause shortening and saved time stay (#534).
- 2026-10-04 · owner: reader transcripts render as one continuous text; return keeps the first held spot; css custom highlights only under the probe's conditions (#535).
- 2026-10-04 · owner: oracle lands once, from cleanup/oracle-reauthor; the per-viewer idempotency key stays; the migration never cancels readings or deletes keys (#531).
- 2026-10-04 · owner: up to five slice PRs in parallel; overlap with codex sessions is resolved at merge.
- 2026-10-04 · owner: chat forks become the inline strip plus one Forks outline; the svg fork graph and its tree navigation go.
- 2026-10-04 · owner: delete walknotes and vault; keep and reduce oracle, atlas, dossiers, connections, consumption, x/arxiv ingest and the lectern.
- 2026-09-27 · owner: dossiers keep only the latest revision.
- 2026-09-27 · owner: delete billing, stripe, entitlements and the transcription quota; keep multi-user libraries and sharing, email ingest and the imports history.
- 2026-09-27 · owner: delete the postgres rate limiter and the stream-token jti table; stream tokens stay short-lived signed jwts; the SSE LISTEN cap stays.
- 2026-09-21 · owner: reauthor everything; kill dawn write; oracle/atlas, x/email/arxiv ingest, slate, walknotes, vault and the extension deferred (targets superseded 2026-10-13).
- 2026-09-18 · owner: System appearance dropped; fork graph kept (superseded 2026-10-04).
