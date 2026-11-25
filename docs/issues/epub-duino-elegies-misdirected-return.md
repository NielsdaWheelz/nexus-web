# duino elegies has one misdirected note return

in the audited *duino elegies* epub (sha256
`84712a2b2b7ff9f840bbbb26dc414b3f6478a58583dcf15002f582d0d4f5905f`),
`OEBPS/Text/chapter2.xhtml#cha2-5` links to the declared note
`OEBPS/Text/note.xhtml#ch2-5`, which opens the correct body in the reader.
the note's return link points to `chapter2.xhtml#cha2-4`, the previous
marker, whose own note is `note.xhtml#ch2-4`. following the return in the
note lands at the previous passage.

reproduce by resolving the four named anchors in the original zip. the private
derivative changes the one confirmed href to `#cha2-5`. epubcheck 5.4.0 rejects
both package versions because the original opf declares version `1.0`; the href
edit preserves the package. the exact diff and both digests are in
`completion-spec/source-derivatives-20261124/source-diffs.json` under the epub
corpus state directory.

after software release, import the derivative as a separate edition and verify
both directions. keep the original and its saved state.
