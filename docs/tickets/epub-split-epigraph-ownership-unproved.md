# split epigraph ownership remains unproved

status: open; source-unproved, whole proposal unapplied
origin: 2026-10-15 book-repair historical source review, operator `150328b65`
area: epub chapter scope

media `34f21e4d-fd2a-4616-9b06-f793452fb455` places three attributed
epigraphs in separate documents between consecutive named chapter starts.
the proposed first three chapter extents stop at the preceding document's
physical end. the 555-, 381- and 415-character quotations then fall outside
every finite proposed section range.

the seven admitted original documents declare `bodymatter chapter`; each
tail contains only a page-break marker and an `epigraph` division. however,
the generic `chapter01` id is reused across all four named chapters. neither
that id, the split filenames nor navigation order establishes whether each
quotation belongs to the preceding or following chapter. these are separate
attributed voices, not ordinary narrative continuation. old coverage does
not resolve the ambiguity either. this is withheld source authority, not a
proved regression or text loss.

exact original members, retained rows, complete historical proposal and
the three changed ranges are bound by
`a-maintenance/navigation34f-epigraph-scope-review-v2.json`, sha256
`e9899ca4f91a050da52aaadf31feca03d0f5a953804874cf0ec140492aca285a`.
source sha256 `7616dc54daf15aed57c507ac0aa38ebd3927d11e03b05f4fcb2837d207ebdb06`.
the independent ordinary-content reading is
`c-sources/34f-epigraph-interpretation-v1.json`, sha256
`10f1115b15769e8e597b5c8547d9d5084a25d381c8e4071b22c51b2a5f3e608d`.
independent complete source/projection review:
`c-sources/a-34f-epigraph-independent-review.json`, sha256
`24bd94aadd686bebfa4c3bfcefbc299efa0666181ff288c334a6901b3885a416`.

prerequisite: evidence that associates these exact epigraphs with named
chapter divisions. no further source acquisition is proposed without an
identified source that can answer that question.

acceptance: establish the ownership and verify the complete resulting proposal
through fresh apply and consumer proof. keeping this book excluded permits
campaign completion but leaves this ticket open. source-150/schema-0278 evidence
does not qualify the current stack.
