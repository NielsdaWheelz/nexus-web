# note quote offsets assume normalized source

status: open · origin: 2026-09-17 cleanup audit, bf12a9720 · area: note passage anchors · oi-163

`python/nexus/services/note_bodies.py:52-79` preserves decomposed unicode from
valid prosemirror text. `services/text_quote.py:69` normalizes the source to
nfc and returns positions in that normalized copy as raw positions.

reproduction: a note containing `Cafe\u0301 target` stores `target` at `[6:12]`;
`resolve_owner_quote` instead returns `[5:11]`, selecting ` targe`. the claimed
nfc-source invariant in `NormalizedText` does not hold for notes.

establish the note editor's source/offset contract before changing it. preserve
matching by normalized text while projecting offsets into the actual stored
text; do not silently rewrite existing notes or their anchors.

acceptance: create a decomposed-unicode note through its current write path;
resolve its quote and verify that returned offsets select the exact original
passage, including combining marks and astral characters. verify existing nfc
notes and reader navigation remain correct.
