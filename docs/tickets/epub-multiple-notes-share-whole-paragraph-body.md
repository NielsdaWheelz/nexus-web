# distinct source notes can share a proposed whole-paragraph body

status: open; both books have proved unsafe proposals and remain unapplied
origin: 2026-10-15 retained-book rehearsal, candidate `150328b65`
area: epub apparatus / source note boundaries

retained-source review found that kjv `228d14cf` proposes 45 notes from
30 source paragraphs; one paragraph contains 16 distinct reciprocal targets.
kjv `20405d0e` proposes 65 notes from 11 paragraphs, with up to 15 targets
sharing a paragraph. its 65 bodies and the 16-target group in `228d14cf`
equal their whole source paragraphs. the other 29 bodies in `228d14cf` are
two characters; their separate source semantics remain unreviewed.

independent source review proves the fixed 15/16-target examples contain
separate authored gloss entries: distinct bold numbers, following emphasized
headwords, intervening gloss prose and reciprocal opener endpoints. nevertheless
each example pair receives identical whole-paragraph text, html and locator.
`_note_body_element` selects one element and provides no separate boundary for
these inline notes. both current proposals are unsafe, not parser-time failures.
campaign disposition: unresolved; preserve existing publication and navigation.

private diagnostics under `book-repair/b-reader/`:
`228d14cf-source-structure-diagnostic.json`, sha256
`ab918bd474c7771d041a6baed275161ced1e46c5e161ffd0c0032766d0c325d5`;
`20405d0e-source-structure-diagnostic.json`, sha256
`34622eae6da1e3de7127ed164063bf514bb929187f2bbb2ef52bba4359b03109`.
the maintenance-budget proof passed separately; no repair was applied.

complete negative proof: `b-reader/kjv-shared-body-proof-v2/receipt.json`, sha256
`5d868c0763b18c20773210e0133e98747a9b8a4a9b8f2590760aab218e03debe`;
independent source interpretation: `a-maintenance/kjv-shared-body-independent-review.json`,
sha256 `1595046919f4231138a156f625d70e9b491f3ab49179023e249d1e3d3f175569`.
the earlier diagnostic's incorrect all-note equality assumption remains as
failed evidence; it does not conceal the 29 short-body cases.

next: fix the shared extraction owner to represent source-proved inline note
boundaries, preserving rich structure and reciprocal correspondence. investigate
the short-body cases separately. do not slice generated prose or add book-specific
exceptions; qualify affected normal ingestion and repair proposals before apply.

acceptance: each proposed body and reciprocal relation matches its authored
note, including grouped paragraphs, and retained identities remain intact.
the campaign's unresolved dispositions do not close this extraction defect.
